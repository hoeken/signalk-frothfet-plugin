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

    yb.onmessage({ msg: "config", firmware_version: "9.9.9" });
    assert.equal(yb.config.firmware_version, "9.9.9");
  });

  await t.test("handleUpdate is ignored until a config has arrived", () => {
    const app = createFakeApp();
    const plugin = createPlugin(app);
    const yb = plugin.createYarrboard("ff.local");

    yb.handleUpdate({ pwm: [{ id: 0, state: true }] });
    assert.equal(app.messages.length, 0, "no deltas before config");
  });

  await t.test("handleConfig publishes board metadata and registers the control PUT handler", () => {
    const app = createFakeApp();
    const plugin = createPlugin(app);
    const yb = plugin.createYarrboard("ff.local");

    yb.handleConfig({
      firmware_version: "1.2.3",
      hardware_version: "rev-a",
      name: "My Frothfet",
      uuid: "abcd-1234",
      use_ssl: false,
      pwm: [{ id: 0, enabled: true, name: "Nav Lights" }],
    });

    const deltas = collectDeltas(app);

    assert.equal(deltas["electrical.frothfet.ff.board.firmware_version"], "1.2.3");
    assert.equal(deltas["electrical.frothfet.ff.board.hardware_version"], "rev-a");
    assert.equal(deltas["electrical.frothfet.ff.board.name"], "My Frothfet");
    assert.equal(deltas["electrical.frothfet.ff.board.uuid"], "abcd-1234");
    assert.equal(deltas["electrical.frothfet.ff.board.hostname"], "ff.local");
    assert.equal(deltas["electrical.frothfet.ff.pwm.0.name"], "Nav Lights");

    // A single control PUT handler is registered on the board path.
    assert.equal(app.putHandlers.length, 1);
    assert.equal(app.putHandlers[0].context, "vessels.self");
    assert.equal(app.putHandlers[0].path, "electrical.frothfet.ff.control");

    // A second config (reconnect) must not re-register the handler.
    yb.handleConfig({ pwm: [] });
    assert.equal(app.putHandlers.length, 1, "PUT handler registered once per connection");
  });

  await t.test("only enabled channels are published", () => {
    const app = createFakeApp();
    const plugin = createPlugin(app);
    const yb = plugin.createYarrboard("ff.local");

    yb.handleConfig({
      pwm: [
        { id: 0, enabled: true },
        { id: 1, enabled: false },
      ],
    });
    app.messages = [];

    yb.handleUpdate({ pwm: [{ id: 0, state: true }, { id: 1, state: true }] });

    const d = collectDeltas(app);
    assert.equal(d["electrical.frothfet.ff.pwm.0.state"], true, "enabled channel published");
    assert.equal(d["electrical.frothfet.ff.pwm.1.state"], undefined, "disabled channel skipped");
  });

  await t.test("handleUpdate converts channel energy fields into SignalK base units", () => {
    const app = createFakeApp();
    const plugin = createPlugin(app);
    const yb = plugin.createYarrboard("ff.local");

    yb.handleConfig({ pwm: [{ id: 0, enabled: true }] });
    app.messages = []; // ignore the config batch; focus on the update

    yb.handleUpdate({
      pwm: [
        {
          id: 0,
          state: true,
          duty: 0.5, // passthrough (ratio)
          voltage: 12.3, // passthrough (V)
          current: 1.2, // passthrough (A)
          aH: 2, // amp-hours -> Coulombs (*3600)
          wH: 24, // watt-hours -> Joules (*3600)
        },
      ],
    });

    const d = collectDeltas(app);
    const m = collectMetas(app);

    assert.equal(d["electrical.frothfet.ff.pwm.0.state"], true);
    close(d["electrical.frothfet.ff.pwm.0.duty"], 0.5, "duty");
    close(d["electrical.frothfet.ff.pwm.0.voltage"], 12.3, "voltage");
    close(d["electrical.frothfet.ff.pwm.0.current"], 1.2, "current");
    close(d["electrical.frothfet.ff.pwm.0.aH"], 7200, "aH -> C");
    close(d["electrical.frothfet.ff.pwm.0.wH"], 86400, "wH -> J");

    assert.equal(m["electrical.frothfet.ff.pwm.0.aH"].units, "C");
    assert.equal(m["electrical.frothfet.ff.pwm.0.wH"].units, "J");
    assert.equal(m["electrical.frothfet.ff.pwm.0.voltage"].units, "V");
    assert.equal(m["electrical.frothfet.ff.pwm.0.current"].units, "A");
    assert.equal(m["electrical.frothfet.ff.pwm.0.duty"].units, "ratio");
  });

  await t.test("handleUpdate records optional bus_voltage and uptime", () => {
    const app = createFakeApp();
    const plugin = createPlugin(app);
    const yb = plugin.createYarrboard("ff.local");

    yb.handleConfig({ pwm: [] });
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
