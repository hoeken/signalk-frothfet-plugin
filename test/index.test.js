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

  const pathScheme = plugin.schema.properties.path_scheme;
  assert.equal(pathScheme.type, "string");
  assert.deepEqual(pathScheme.enum, ["none", "boardname", "uuid"]);
  assert.equal(pathScheme.enum.length, pathScheme.enumNames.length);
  assert.equal(pathScheme.default, "none");

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
    // Default path scheme is "none": channels hang straight off electrical.frothfet.
    assert.equal(yb.getMainBoardPath(), "electrical.frothfet");
    assert.equal(yb.update_interval, 2000);
    assert.equal(yb.bus, plugin.bus);
  });

  await t.test("getMainBoardPath honours the configured path scheme", () => {
    const plugin = createPlugin(createFakeApp());
    const yb = plugin.createYarrboard("ff.local");

    plugin.pathScheme = "none";
    assert.equal(yb.getMainBoardPath(), "electrical.frothfet");

    plugin.pathScheme = "boardname";
    assert.equal(yb.getMainBoardPath(), "electrical.frothfet.ff");

    plugin.pathScheme = "uuid";
    // uuid comes from the board config; before it arrives, fall back to boardname.
    assert.equal(yb.getMainBoardPath(), "electrical.frothfet.ff", "no config yet -> boardname fallback");
    yb.handleConfig(configMessage([], { uuid: "abcd-1234" }));
    assert.equal(yb.getMainBoardPath(), "electrical.frothfet.abcd-1234", "uuid once config arrives");
  });

  await t.test("start() applies the path_scheme option to published paths", () => {
    const app = createFakeApp();
    const plugin = createPlugin(app);

    // start() reads options.path_scheme; default is "none" when omitted.
    plugin.createYarrboard = () => ({
      hostname: "ff.local",
      boardname: "ff",
      start() {},
      close() {},
      status() {},
      getBoardName() {},
    });
    plugin.start({ path_scheme: "uuid", config: [] });
    assert.equal(plugin.pathScheme, "uuid");

    plugin.start({ config: [] });
    assert.equal(plugin.pathScheme, "none", "omitted option defaults to none");
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
    plugin.pathScheme = "boardname"; // assert the board-namespaced paths
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

    // All static config is one JSON object at the per-board config path.
    const cfg = deltas["electrical.frothfet.ff.config"];
    assert.equal(cfg.firmware_version, "1.2.3");
    assert.equal(cfg.hardware_version, "rev-a");
    assert.equal(cfg.name, "My Frothfet");
    assert.equal(cfg.uuid, "abcd-1234");
    assert.equal(cfg.hostname, "ff.local");
    assert.equal(cfg.use_ssl, false);
    // Channels are nested inside the same object, keyed by slug.
    assert.equal(cfg.channels["nav-lights"].name, "Nav Lights");
    // No per-field config paths, and no duplication on the live data path.
    assert.equal(deltas["electrical.frothfet.ff.config.firmware_version"], undefined);
    assert.equal(deltas["electrical.frothfet.ff.board.name"], undefined);
    // The config object carries a meta description; bus_voltage meta is on the live path.
    assert.equal(metas["electrical.frothfet.ff.config"].description, "Board and channel configuration");
    assert.equal(metas["electrical.frothfet.ff.board.bus_voltage"].units, "V");

    // Two PUT handlers: the per-board control path (board-namespaced) and the
    // shared router at the flat electrical.frothfet.control path.
    assert.equal(app.putHandlers.length, 2);
    const paths = app.putHandlers.map((h) => h.path);
    assert.ok(app.putHandlers.every((h) => h.context === "vessels.self"));
    assert.ok(paths.includes("electrical.frothfet.ff.control"), "per-board control path");
    assert.ok(paths.includes("electrical.frothfet.control"), "shared control router path");

    // A second config (reconnect) must not re-register either handler.
    yb.handleConfig(configMessage([]));
    assert.equal(app.putHandlers.length, 2, "PUT handlers registered once");
  });

  await t.test("channels are nested in the config object, keyed by slug, trivia dropped", () => {
    const app = createFakeApp();
    const plugin = createPlugin(app);
    plugin.pathScheme = "boardname"; // assert the board-namespaced paths
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

    const ch = collectDeltas(app)["electrical.frothfet.ff.config"].channels["fresh-water-pump"];

    assert.equal(ch.id, 5);
    assert.equal(ch.name, "Fresh Water Pump");
    assert.equal(ch.type, "water_pump");
    assert.equal(ch.enabled, true);
    close(ch.softFuse, 20, "softFuse");
    assert.equal(ch.defaultState, "ON");
    assert.equal(ch.softFuseType, "SLOW");
    // Fields not on the whitelist (the *Melody trivia) are dropped entirely.
    assert.equal(ch.bypassMelody, undefined);
  });

  await t.test("getConfigBoardPath is always per-board and honours the uuid scheme", () => {
    const plugin = createPlugin(createFakeApp());
    const yb = plugin.createYarrboard("ff.local");

    plugin.pathScheme = "none";
    assert.equal(yb.getConfigBoardPath(), "electrical.frothfet.ff.config", "none -> boardname");

    plugin.pathScheme = "boardname";
    assert.equal(yb.getConfigBoardPath(), "electrical.frothfet.ff.config");

    plugin.pathScheme = "uuid";
    assert.equal(yb.getConfigBoardPath(), "electrical.frothfet.ff.config", "no config yet -> boardname fallback");
    yb.handleConfig(configMessage([], { uuid: "abcd-1234" }));
    assert.equal(yb.getConfigBoardPath(), "electrical.frothfet.abcd-1234.config", "uuid once config arrives");
  });

  await t.test("board config whitelist publishes settings and never leaks secrets", () => {
    const app = createFakeApp();
    const plugin = createPlugin(app);
    plugin.pathScheme = "boardname";
    const yb = plugin.createYarrboard("ff.local");

    // A fuller config envelope: real firmware carries secrets alongside settings.
    yb.handleConfig({
      msg: "config",
      config: {
        schema_version: 2,
        app: { firmware_version: "2.6.1", build_time: "2026-06-13T21:47:01Z" },
        config: { name: "Misc", brightness: 1 },
        network: { uuid: "abc", local_hostname: "frothfet-misc", wifi_ssid: "Phoenix", wifi_pass: "hunter2" },
        http: { api_enabled: true, ssl_enabled: false, server_key: "-----KEY-----" },
        auth: { admin_user: "admin", admin_pass: "sekret", guest_pass: "guestpw" },
        mqtt: { enabled: true, ha_integration_enabled: true, mqtt_user: "yb", mqtt_pass: "mqttpw" },
        navico: { enabled: true },
        ota: { arduino_ota_enabled: true },
        protocol: { serial_enabled: false },
        pwm: { channels: [] },
      },
    });

    const cfg = collectDeltas(app)["electrical.frothfet.ff.config"];

    // Whitelisted settings and integration flags are included.
    assert.equal(cfg.schema_version, 2);
    assert.equal(cfg.build_time, "2026-06-13T21:47:01Z");
    assert.equal(cfg.brightness, 1);
    assert.equal(cfg.api_enabled, true);
    assert.equal(cfg.serial_enabled, false);
    assert.equal(cfg.ota_enabled, true);
    assert.equal(cfg.mqtt_enabled, true);
    assert.equal(cfg.ha_integration_enabled, true);
    assert.equal(cfg.navico_enabled, true);

    // No secret or credential appears anywhere in the config object.
    const blob = JSON.stringify(cfg);
    for (const secret of ["hunter2", "-----KEY-----", "sekret", "guestpw", "mqttpw"])
      assert.ok(!blob.includes(secret), `secret leaked: ${secret}`);

    // SSID, usernames and MQTT endpoint aren't whitelisted either.
    assert.equal(cfg.wifi_ssid, undefined);
    assert.equal(cfg.admin_user, undefined);
    assert.equal(cfg.mqtt_user, undefined);
  });

  await t.test("the default \"none\" scheme publishes live paths without a board segment", () => {
    const app = createFakeApp();
    const plugin = createPlugin(app); // pathScheme defaults to "none"
    const yb = plugin.createYarrboard("ff.local");

    yb.handleConfig(configMessage(
      [{ id: 1, enabled: true, key: "nav-lights", name: "Nav Lights" }],
      { name: "My Frothfet" },
    ));
    yb.handleUpdate({ pwm: [{ id: 1, key: "nav-lights", state: "ON" }] });

    const d = collectDeltas(app);
    // Channel telemetry has no board segment under "none" — it's the only path
    // that collapses to the flat shared namespace.
    assert.equal(d["electrical.frothfet.channel.nav-lights.state"], "ON");
    assert.equal(d["electrical.frothfet.ff.channel.nav-lights.state"], undefined);

    // The config object is always per-board (boardname under "none").
    const cfg = d["electrical.frothfet.ff.config"];
    assert.equal(cfg.name, "My Frothfet");
    assert.equal(cfg.channels["nav-lights"].name, "Nav Lights");

    // Under "none" the per-board control path still carries a board segment, and
    // the shared router lives on the flat, un-namespaced path.
    const paths = app.putHandlers.map((h) => h.path);
    assert.ok(paths.includes("electrical.frothfet.ff.control"), "per-board control path");
    assert.ok(paths.includes("electrical.frothfet.control"), "shared control router path");
  });

  await t.test("only enabled channels are published", () => {
    const app = createFakeApp();
    const plugin = createPlugin(app);
    plugin.pathScheme = "boardname"; // assert the board-namespaced paths
    const yb = plugin.createYarrboard("ff.local");

    yb.handleConfig(configMessage([
      { id: 1, key: "bilge", enabled: true },
      { id: 2, key: "nav", enabled: false },
    ]));
    app.messages = [];

    yb.handleUpdate({ pwm: [{ id: 1, key: "bilge", state: "ON" }, { id: 2, key: "nav", state: "ON" }] });

    const d = collectDeltas(app);
    assert.equal(d["electrical.frothfet.ff.channel.bilge.state"], "ON", "enabled channel published");
    assert.equal(d["electrical.frothfet.ff.channel.nav.state"], undefined, "disabled channel skipped");
  });

  await t.test("handleUpdate publishes and converts channel telemetry into SignalK base units", () => {
    const app = createFakeApp();
    const plugin = createPlugin(app);
    plugin.pathScheme = "boardname"; // assert the board-namespaced paths
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
    const base = "electrical.frothfet.ff.channel.fresh-water-pump";

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
    plugin.pathScheme = "boardname"; // assert the board-namespaced paths
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
    assert.equal(d["electrical.frothfet.ff.channel.salt-water-pump.state"], "ON", "enabled channel published");
    assert.equal(d["electrical.frothfet.ff.channel.fresh-water-pump.state"], undefined, "disabled channel skipped");
  });

  await t.test("handleUpdate records optional bus_voltage and uptime", () => {
    const app = createFakeApp();
    const plugin = createPlugin(app);
    plugin.pathScheme = "boardname"; // assert the board-namespaced paths
    const yb = plugin.createYarrboard("ff.local");

    yb.handleConfig(configMessage([]));
    app.messages = [];

    yb.handleUpdate({ bus_voltage: 13.2, uptime: 5_000_000 });

    const d = collectDeltas(app);
    assert.equal(d["electrical.frothfet.ff.board.bus_voltage"], 13.2);
    assert.equal(d["electrical.frothfet.ff.board.uptime"], 5); // us -> s (round)
  });

  await t.test("board telemetry carries a board segment under the \"none\" scheme", () => {
    const app = createFakeApp();
    const plugin = createPlugin(app); // pathScheme defaults to "none"
    const yb = plugin.createYarrboard("ff.local");

    yb.handleConfig(configMessage([], { capabilities: { bus_voltage: {} } }));
    yb.handleUpdate({ bus_voltage: 13.2, uptime: 5_000_000 });

    const d = collectDeltas(app);
    const m = collectMetas(app);

    // Board telemetry hangs off the same per-board root under every scheme:
    // electrical.frothfet.{boardname}.board.* under "none".
    assert.equal(d["electrical.frothfet.ff.board.bus_voltage"], 13.2);
    assert.equal(d["electrical.frothfet.ff.board.uptime"], 5); // us -> s (round)
    assert.equal(m["electrical.frothfet.ff.board.bus_voltage"].units, "V");
    // The old flat/un-namespaced telemetry paths are no longer used.
    assert.equal(d["electrical.frothfet.board.ff.bus_voltage"], undefined);
    assert.equal(d["electrical.frothfet.board.bus_voltage"], undefined);
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

test("shared control router (electrical.frothfet.control)", async (t) => {
  // Wire up boards the way start() would: create each connection, register it,
  // and feed it a config so the key->board map is (re)built. Stubs `send` so we
  // can see which board a routed command lands on.
  function setupBoards(plugin, boards) {
    for (const b of boards) {
      const yb = plugin.createYarrboard(b.host);
      yb.sent = [];
      yb.send = (value, requireConfirmation) => yb.sent.push({ value, requireConfirmation });
      plugin.connections.push(yb);
      yb.handleConfig(configMessage(b.channels));
      b.yb = yb;
    }
  }

  await t.test("routes a keyed command to the board that owns the key", () => {
    const plugin = createPlugin(createFakeApp());
    const boards = [
      { host: "ff1.local", channels: [{ id: 1, key: "pump-a", enabled: true }] },
      { host: "ff2.local", channels: [{ id: 1, key: "light-b", enabled: true }] },
    ];
    setupBoards(plugin, boards);

    const cmd = { cmd: "set_pwm", key: "light-b", state: true };
    const result = plugin.handleControlPut("vessels.self", "electrical.frothfet.control", cmd);

    assert.deepEqual(result, { state: "COMPLETED", statusCode: 200 });
    assert.equal(boards[0].yb.sent.length, 0, "board without the key is untouched");
    assert.deepEqual(boards[1].yb.sent, [{ value: cmd, requireConfirmation: true }]);
  });

  await t.test("rejects a payload with no key (unroutable)", () => {
    const plugin = createPlugin(createFakeApp());
    const boards = [{ host: "ff1.local", channels: [{ id: 1, key: "pump-a", enabled: true }] }];
    setupBoards(plugin, boards);

    const result = plugin.handleControlPut("vessels.self", "electrical.frothfet.control", { cmd: "set_pwm", state: true });

    assert.equal(result.state, "COMPLETED");
    assert.equal(result.statusCode, 400);
    assert.equal(boards[0].yb.sent.length, 0, "nothing is forwarded");
  });

  await t.test("rejects an unknown key", () => {
    const plugin = createPlugin(createFakeApp());
    const boards = [{ host: "ff1.local", channels: [{ id: 1, key: "pump-a", enabled: true }] }];
    setupBoards(plugin, boards);

    const result = plugin.handleControlPut("vessels.self", "electrical.frothfet.control", { cmd: "set_pwm", key: "nope", state: true });

    assert.equal(result.statusCode, 400);
    assert.equal(boards[0].yb.sent.length, 0);
  });

  await t.test("duplicate keys across boards raise a plugin error under \"none\"", () => {
    const app = createFakeApp();
    const plugin = createPlugin(app); // pathScheme defaults to "none"
    const boards = [
      { host: "ff1.local", channels: [{ id: 1, key: "pump", enabled: true }] },
      { host: "ff2.local", channels: [{ id: 1, key: "pump", enabled: true }] },
    ];
    setupBoards(plugin, boards);

    assert.ok(
      app.pluginErrors.some((e) => e.includes("pump") && e.includes("ff1") && e.includes("ff2")),
      "collision is reported with the conflicting key and boards",
    );
    // The first board to claim the key wins the map, so routing stays deterministic.
    assert.equal(plugin.channelKeyToBoard["pump"], boards[0].yb);
  });

  await t.test("duplicate keys are tolerated under a namespaced scheme", () => {
    const app = createFakeApp();
    const plugin = createPlugin(app);
    plugin.pathScheme = "boardname";
    const boards = [
      { host: "ff1.local", channels: [{ id: 1, key: "pump", enabled: true }] },
      { host: "ff2.local", channels: [{ id: 1, key: "pump", enabled: true }] },
    ];
    setupBoards(plugin, boards);

    assert.equal(app.pluginErrors.length, 0, "no collision error under namespaced schemes");
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
