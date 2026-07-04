const test = require("node:test");
const assert = require("node:assert/strict");
const createPlugin = require("../src/index");
const { createFakeApp, collectDeltas, collectMetas } = require("./helpers");

// Assert two numbers are equal within a small tolerance (unit conversions go
// through float multiplication, so exact equality is fragile).
function close(actual, expected, msg) {
  assert.ok(
    Math.abs(actual - expected) < 1e-6,
    `${msg || ""} expected ~${expected}, got ${actual}`,
  );
}

// Assemble a board `config` message in the nested envelope shape the firmware
// sends: the real config lives under `config`, with channels at
// `config.pwm.channels`, alongside `capabilities`.
function configMessage(channels = [], opts = {}) {
  return {
    msg: "config",
    config: {
      app: { firmware_version: opts.firmware_version, hardware_version: opts.hardware_version },
      config: { name: opts.name },
      network: { uuid: opts.uuid },
      http: { ssl_enabled: opts.ssl_enabled },
      pwm: { channels },
    },
    capabilities: opts.capabilities,
  };
}

test("plugin metadata and schema", () => {
  const plugin = createPlugin(createFakeApp());

  assert.equal(plugin.id, "signalk-frothfet-plugin");
  assert.equal(plugin.name, "Frothfet");
  assert.equal(typeof plugin.start, "function");
  assert.equal(typeof plugin.stop, "function");

  const config = plugin.schema.properties.config;
  assert.equal(config.type, "array");
  const props = config.items.properties;
  assert.equal(props.host.default, "frothfet.local");
  assert.equal(props.use_ssl.default, false);
  assert.equal(props.update_interval.default, 1000);
  assert.equal(props.require_login.default, false);
  assert.equal(props.enable_proxy.default, false);
  assert.equal(props.proxy_port.default, 3200);
});

test("registerWithRouter serves /boards", async (t) => {
  await t.test("returns [] before the proxies are started", () => {
    const plugin = createPlugin(createFakeApp());
    const routes = {};
    plugin.registerWithRouter({ get: (p, h) => (routes[p] = h) });

    let sent;
    routes["/boards"]({}, { json: (v) => (sent = v) });
    assert.deepEqual(sent, []);
  });

  await t.test("delegates to boardProxies.boards() once started", () => {
    const plugin = createPlugin(createFakeApp());
    plugin.boardProxies = { boards: () => [{ host: "ff.local", proxy_port: 3200 }] };
    const routes = {};
    plugin.registerWithRouter({ get: (p, h) => (routes[p] = h) });

    let sent;
    routes["/boards"]({}, { json: (v) => (sent = v) });
    assert.deepEqual(sent, [{ host: "ff.local", proxy_port: 3200 }]);
  });
});

test("createYarrboard", async (t) => {
  await t.test("derives board name/path and wires the bus", () => {
    const plugin = createPlugin(createFakeApp());
    const yb = plugin.createYarrboard("ff.local", "admin", "admin", false, false, 2000);

    assert.equal(yb.hostname, "ff.local");
    assert.equal(yb.boardname, "ff");
    assert.equal(yb.getMainBoardPath(), "electrical.frothfet.ff");
    assert.equal(yb.update_interval, 2000);
    assert.equal(yb.bus, plugin.bus);
  });

  await t.test("onmessage routes status errors and successes to the app", () => {
    const app = createFakeApp();
    const plugin = createPlugin(app);
    const yb = plugin.createYarrboard("ff.local");

    yb.onmessage({ msg: "status", status: "error", message: "over current" });
    yb.onmessage({ msg: "status", status: "success", message: "all good" });

    assert.deepEqual(app.pluginErrors, ["[ff.local] over current"]);
    assert.deepEqual(app.statuses, ["[ff.local] all good"]);
  });

  await t.test("onmessage routes config messages into handleConfig", () => {
    const plugin = createPlugin(createFakeApp());
    const yb = plugin.createYarrboard("ff.local");

    yb.onmessage({ msg: "config", config: { app: { firmware_version: "9.9.9" } } });
    assert.equal(yb.config.app.firmware_version, "9.9.9");
  });

  await t.test("handleUpdate is ignored until a config has arrived", () => {
    const app = createFakeApp();
    const plugin = createPlugin(app);
    const yb = plugin.createYarrboard("ff.local");

    yb.handleUpdate({ pwm: [{ id: 0, state: true }] });
    assert.equal(app.messages.length, 0, "no deltas before config");
  });

  await t.test("getBoardName falls back to the hostname-derived name until config arrives", () => {
    const plugin = createPlugin(createFakeApp());
    const yb = plugin.createYarrboard("ff.local");

    assert.equal(yb.getBoardName(), "ff", "no config yet -> boardname");

    yb.handleConfig(configMessage([], { name: "Pumps" }));
    assert.equal(yb.getBoardName(), "Pumps", "config.config.name once connected");
  });

  await t.test("handleConfig publishes board metadata and registers the control PUT handler", () => {
    const app = createFakeApp();
    const plugin = createPlugin(app);
    const yb = plugin.createYarrboard("ff.local");

    yb.handleConfig(configMessage(
      [{ id: 1, enabled: true, name: "Nav Lights", key: "nav-lights" }],
      {
        firmware_version: "1.2.3",
        hardware_version: "rev-a",
        name: "My Frothfet",
        uuid: "abcd-1234",
        ssl_enabled: false,
        capabilities: { bus_voltage: {} },
      },
    ));

    const deltas = collectDeltas(app);
    const metas = collectMetas(app);

    assert.equal(deltas["electrical.frothfet.ff.board.firmware_version"], "1.2.3");
    assert.equal(deltas["electrical.frothfet.ff.board.hardware_version"], "rev-a");
    assert.equal(deltas["electrical.frothfet.ff.board.name"], "My Frothfet");
    assert.equal(deltas["electrical.frothfet.ff.board.uuid"], "abcd-1234");
    assert.equal(deltas["electrical.frothfet.ff.board.hostname"], "ff.local");
    assert.equal(deltas["electrical.frothfet.ff.board.use_ssl"], false);
    assert.equal(deltas["electrical.frothfet.ff.pwm.nav-lights.name"], "Nav Lights");
    // bus_voltage meta is registered because the board declared the capability.
    assert.equal(metas["electrical.frothfet.ff.board.bus_voltage"].units, "V");

    // A single control PUT handler is registered on the board path.
    assert.equal(app.putHandlers.length, 1);
    assert.equal(app.putHandlers[0].context, "vessels.self");
    assert.equal(app.putHandlers[0].path, "electrical.frothfet.ff.control");

    // A second config (reconnect) must not re-register the handler.
    yb.handleConfig(configMessage([]));
    assert.equal(app.putHandlers.length, 1, "PUT handler registered once per connection");
  });

  await t.test("handleConfig publishes per-channel metadata keyed by channel key", () => {
    const app = createFakeApp();
    const plugin = createPlugin(app);
    const yb = plugin.createYarrboard("ff.local");

    yb.handleConfig(configMessage([
      {
        id: 5,
        name: "Fresh Water Pump",
        key: "fresh-water-pump",
        enabled: true,
        type: "water_pump",
        hasCurrent: true,
        softFuse: 20,
        isDimmable: false,
        defaultState: "ON",
        softFuseType: "SLOW",
        bypassMelody: "MORSE_O",
      },
    ]));

    const d = collectDeltas(app);
    const m = collectMetas(app);

    assert.equal(d["electrical.frothfet.ff.pwm.fresh-water-pump.name"], "Fresh Water Pump");
    assert.equal(d["electrical.frothfet.ff.pwm.fresh-water-pump.type"], "water_pump");
    assert.equal(d["electrical.frothfet.ff.pwm.fresh-water-pump.enabled"], true);
    close(d["electrical.frothfet.ff.pwm.fresh-water-pump.softFuse"], 20, "softFuse");
    assert.equal(d["electrical.frothfet.ff.pwm.fresh-water-pump.defaultState"], "ON");
    assert.equal(d["electrical.frothfet.ff.pwm.fresh-water-pump.softFuseType"], "SLOW");
    // Fields without a meta entry are still published as raw deltas.
    assert.equal(d["electrical.frothfet.ff.pwm.fresh-water-pump.bypassMelody"], "MORSE_O");

    assert.equal(m["electrical.frothfet.ff.pwm.fresh-water-pump.softFuse"].units, "A");
    assert.equal(m["electrical.frothfet.ff.pwm.fresh-water-pump.type"].description, "Channel type (e.g. bilge_pump, water_pump)");
  });

  await t.test("only enabled channels are published", () => {
    const app = createFakeApp();
    const plugin = createPlugin(app);
    const yb = plugin.createYarrboard("ff.local");

    yb.handleConfig(configMessage([
      { id: 1, key: "bilge", enabled: true },
      { id: 2, key: "nav", enabled: false },
    ]));
    app.messages = [];

    yb.handleUpdate({ pwm: [{ id: 1, key: "bilge", state: "ON" }, { id: 2, key: "nav", state: "ON" }] });

    const d = collectDeltas(app);
    assert.equal(d["electrical.frothfet.ff.pwm.bilge.state"], "ON", "enabled channel published");
    assert.equal(d["electrical.frothfet.ff.pwm.nav.state"], undefined, "disabled channel skipped");
  });

  await t.test("handleUpdate publishes and converts channel telemetry into SignalK base units", () => {
    const app = createFakeApp();
    const plugin = createPlugin(app);
    const yb = plugin.createYarrboard("ff.local");

    yb.handleConfig(configMessage([{ id: 5, key: "fresh-water-pump", enabled: true }]));
    app.messages = []; // ignore the config batch; focus on the update

    // Mirrors the board's live update shape: flat pwm array, 1-based id, string
    // key/state/source, plus wattage and temperature. Paths use the key slug.
    yb.handleUpdate({
      pwm: [
        {
          id: 5,
          key: "fresh-water-pump",
          state: "ON",
          source: "frothfet",
          voltage: 26.88, // passthrough (V)
          current: 0.03, // passthrough (A)
          wattage: 0.82, // passthrough (W)
          temperature: 36.5, // Celsius -> Kelvin (+273.15)
          aH: 2, // amp-hours -> Coulombs (*3600)
          wH: 24, // watt-hours -> Joules (*3600)
        },
      ],
    });

    const d = collectDeltas(app);
    const m = collectMetas(app);
    const base = "electrical.frothfet.ff.pwm.fresh-water-pump";

    assert.equal(d[`${base}.state`], "ON");
    assert.equal(d[`${base}.source`], "frothfet");
    close(d[`${base}.voltage`], 26.88, "voltage");
    close(d[`${base}.current`], 0.03, "current");
    close(d[`${base}.wattage`], 0.82, "wattage");
    close(d[`${base}.temperature`], 309.65, "temperature C -> K");
    close(d[`${base}.aH`], 7200, "aH -> C");
    close(d[`${base}.wH`], 86400, "wH -> J");

    assert.equal(m[`${base}.aH`].units, "C");
    assert.equal(m[`${base}.wH`].units, "J");
    assert.equal(m[`${base}.voltage`].units, "V");
    assert.equal(m[`${base}.current`].units, "A");
    assert.equal(m[`${base}.wattage`].units, "W");
    assert.equal(m[`${base}.temperature`].units, "K");
  });

  await t.test("channels are matched to config by id, not array position", () => {
    const app = createFakeApp();
    const plugin = createPlugin(app);
    const yb = plugin.createYarrboard("ff.local");

    // Config lists the channels in a different order than the update, and only
    // id 6 is enabled. An array-index lookup would gate the wrong channel.
    yb.handleConfig(configMessage([
      { id: 6, key: "salt-water-pump", enabled: true },
      { id: 5, key: "fresh-water-pump", enabled: false },
    ]));
    app.messages = [];

    yb.handleUpdate({
      pwm: [
        { id: 5, key: "fresh-water-pump", state: "ON" },
        { id: 6, key: "salt-water-pump", state: "ON" },
      ],
    });

    const d = collectDeltas(app);
    assert.equal(d["electrical.frothfet.ff.pwm.salt-water-pump.state"], "ON", "enabled channel published");
    assert.equal(d["electrical.frothfet.ff.pwm.fresh-water-pump.state"], undefined, "disabled channel skipped");
  });

  await t.test("handleUpdate records optional bus_voltage and uptime", () => {
    const app = createFakeApp();
    const plugin = createPlugin(app);
    const yb = plugin.createYarrboard("ff.local");

    yb.handleConfig(configMessage([]));
    app.messages = [];

    yb.handleUpdate({ bus_voltage: 13.2, uptime: 5_000_000 });

    const d = collectDeltas(app);
    assert.equal(d["electrical.frothfet.ff.board.bus_voltage"], 13.2);
    assert.equal(d["electrical.frothfet.ff.board.uptime"], 5); // us -> s (round)
  });

  await t.test("doSendJSON forwards the raw value to the board websocket", () => {
    const plugin = createPlugin(createFakeApp());
    const yb = plugin.createYarrboard("ff.local");

    let sent;
    yb.send = (value, requireConfirmation) => (sent = { value, requireConfirmation });

    const result = yb.doSendJSON("vessels.self", "electrical.frothfet.ff.control", { cmd: "set_pwm", id: 0, state: true });

    assert.deepEqual(sent, { value: { cmd: "set_pwm", id: 0, state: true }, requireConfirmation: true });
    assert.deepEqual(result, { state: "COMPLETED", statusCode: 200 });
  });
});

test("plugin start/stop lifecycle", () => {
  const app = createFakeApp();
  const plugin = createPlugin(app);

  // Replace the real connection factory so start() opens no sockets.
  const started = [];
  const closed = [];
  plugin.createYarrboard = (host) => ({
    hostname: host,
    boardname: host.split(".")[0],
    config: { name: `cfg-${host}` },
    start() {
      started.push(host);
    },
    close() {
      closed.push(host);
    },
    status() {
      return "CONNECTED";
    },
  });

  plugin.start({
    config: [
      { host: "ff.local", use_ssl: false, proxy_port: 3200, enable_proxy: false, update_interval: 1000 },
    ],
  });

  assert.deepEqual(started, ["ff.local"]);
  assert.equal(plugin.connections.length, 1);
  assert.ok(plugin.boardProxies, "a BoardProxyManager is created");
  // enable_proxy was false, so no proxy is running.
  assert.deepEqual(plugin.boardProxies.boards(), []);

  plugin.stop();

  assert.deepEqual(closed, ["ff.local"]);
  assert.equal(plugin.connections.length, 0);
  assert.equal(plugin.boardProxies, null);
});

test("start() completes with schema defaults (no config array)", () => {
  const app = createFakeApp();
  const plugin = createPlugin(app);

  // SignalK scores the plugin by starting it with only schema defaults applied.
  // The config array has no default, so options.config is undefined — start()
  // must complete instead of throwing "config is not iterable".
  assert.doesNotThrow(() => plugin.start({}));

  assert.equal(plugin.connections.length, 0);
  assert.ok(plugin.boardProxies, "a BoardProxyManager is still created");
  assert.deepEqual(plugin.boardProxies.boards(), []);

  plugin.stop();
});
