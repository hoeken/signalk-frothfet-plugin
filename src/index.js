const YarrboardClient = require("yarrboard-client");
const { SignalKBus } = require("./signalk-bus.js");
const { BoardProxyManager } = require("./signalk-board-proxy.js");

module.exports = function (app) {
  var plugin = {};

  plugin.id = "signalk-frothfet-plugin";
  plugin.name = "Frothfet";
  plugin.description = "SignalK plugin for the Frothfet multi-channel digital load controller";

  plugin.bus = new SignalKBus(app, plugin.id);
  plugin.connections = [];

  // How board paths are namespaced under `electrical.frothfet`. Set from the
  // top-level `path_scheme` option in start(); see getMainBoardPath below.
  //   "none"      -> electrical.frothfet.{channels}          (flat shared namespace)
  //   "boardname" -> electrical.frothfet.{boardname}.{channels}
  //   "uuid"      -> electrical.frothfet.{uuid}.{channels}
  plugin.pathScheme = "none";

  // What the board reports splits into two buckets. Static setup values (board +
  // channels) are gathered into a single JSON object published at the per-board
  // config path (electrical.frothfet.config.{board}); live telemetry is a delta
  // per field under the main data path (see getMainBoardPath / getConfigBoardPath).
  //
  // Both are whitelisted: only the fields listed below are included, which keeps
  // secrets (wifi/mqtt/auth passwords, certs) and trivia (boot log, channel
  // melodies) out of SignalK.

  // Board-level config fields for the config object. Each entry's `get(yb)` pulls
  // the value out of the board's parsed config; fields that resolve to undefined
  // are omitted from the object.
  plugin.boardConfigFields = {
    name: (yb) => yb.getBoardName(),
    uuid: (yb) => yb.config.network && yb.config.network.uuid,
    hostname: (yb) => yb.hostname,
    firmware_version: (yb) => yb.config.app && yb.config.app.firmware_version,
    hardware_version: (yb) => yb.config.app && yb.config.app.hardware_version,
    build_time: (yb) => yb.config.app && yb.config.app.build_time,
    schema_version: (yb) => yb.config.schema_version,
    brightness: (yb) => yb.config.config && yb.config.config.brightness,
    use_ssl: (yb) => yb.config.http && yb.config.http.ssl_enabled,
    api_enabled: (yb) => yb.config.http && yb.config.http.api_enabled,
    serial_enabled: (yb) => yb.config.protocol && yb.config.protocol.serial_enabled,
    ota_enabled: (yb) => yb.config.ota && yb.config.ota.arduino_ota_enabled,
    mqtt_enabled: (yb) => yb.config.mqtt && yb.config.mqtt.enabled,
    ha_integration_enabled: (yb) => yb.config.mqtt && yb.config.mqtt.ha_integration_enabled,
    navico_enabled: (yb) => yb.config.navico && yb.config.navico.enabled,
  };

  // Per-channel config fields copied into each channel entry of the config
  // object. The board also carries *Melody fields — trivia, deliberately omitted.
  plugin.channelConfigFields = [
    "id",
    "key",
    "name",
    "type",
    "enabled",
    "hasPWM",
    "hasCurrent",
    "isDimmable",
    "softFuse",
    "softFuseType",
    "defaultState",
  ];

  // Per-channel live telemetry, published from `update` messages. `scale`
  // (multiply) and `offset` (add, applied after scale) convert the board's value
  // into a SignalK base unit before it is published.
  //   aH (amp-hours)   -> C (Coulombs)  x3600
  //   wH (watt-hours)  -> J (Joules)    x3600
  //   temperature (°C) -> K (Kelvin)    +273.15
  plugin.channelLiveMetas = {
    state: { description: "Whether the channel is on or not" },
    source: { description: "Source of last state change" },
    duty: { units: "ratio", description: "Duty cycle as a ratio from 0 to 1" },
    voltage: { units: "V", description: "Voltage of channel" },
    current: { units: "A", description: "Current of channel" },
    wattage: { units: "W", description: "Power draw of channel" },
    temperature: { units: "K", description: "Temperature of channel", offset: 273.15 },
    aH: { units: "C", description: "Consumed charge since board restart", scale: 3600 },
    wH: { units: "J", description: "Consumed energy since board restart", scale: 3600 },
  };

  // Build a SignalK meta object from a whitelist entry (units optional).
  plugin.buildMeta = function (meta) {
    const out = { description: meta.description };
    if (meta.units)
      out.units = meta.units;
    return out;
  };

  plugin.start = function (options, _restartPlugin) {
    app.debug(`YarrboardClient.version: ${YarrboardClient.version}`);

    plugin.pathScheme = options.path_scheme || "none";

    const descriptors = [];

    // options.config is undefined when SignalK starts the plugin with only
    // schema defaults applied (the config array has no default), so guard the
    // loop rather than let it throw before start() completes.
    for (const board of options.config || []) {
      let frothfet = plugin.createYarrboard(
        board.host.trim(),
        board.username,
        board.password,
        board.require_login,
        board.use_ssl,
        board.update_interval,
      );
      frothfet.start();

      plugin.connections.push(frothfet);

      // Build a Frothfet-agnostic descriptor for the reusable proxy helper.
      // name/status are getters so the landing page reflects live board state.
      descriptors.push({
        host: frothfet.hostname,
        use_ssl: board.use_ssl,
        proxy_port: board.proxy_port,
        enable_proxy: board.enable_proxy,
        name: () => frothfet.getBoardName(),
        status: () => frothfet.status(),
      });
    }

    plugin.boardProxies = new BoardProxyManager(app);
    plugin.boardProxies.start(descriptors);
  };

  plugin.stop = function () {
    app.debug("Plugin stopped");

    for (const yb of plugin.connections)
      yb.close();
    plugin.connections = [];

    if (plugin.boardProxies) {
      plugin.boardProxies.stop();
      plugin.boardProxies = null;
    }
  };

  // Metadata endpoint for the landing webapp; served at
  // /plugins/signalk-frothfet-plugin/boards (same origin — no CORS).
  plugin.registerWithRouter = function (router) {
    router.get("/boards", (req, res) =>
      res.json(plugin.boardProxies ? plugin.boardProxies.boards() : []),
    );
  };

  plugin.schema = {
    title: "Frothfet",
    type: "object",
    properties: {
      path_scheme: {
        type: "string",
        title: "SignalK path scheme",
        description:
          "How board paths are namespaced under electrical.frothfet. \"None\" publishes every board into one flat namespace (electrical.frothfet.…) — convenient for automation and scripting, since channels are addressed by slug without tracking which board owns them. \"Board name\" and \"Board UUID\" give each board its own namespace.",
        enum: ["none", "boardname", "uuid"],
        enumNames: [
          "None — electrical.frothfet.{channels}",
          "Board hostname — electrical.frothfet.{boardname}.{channels}",
          "Board UUID — electrical.frothfet.{uuid}.{channels}",
        ],
        default: "none",
      },
      config: {
        type: "array",
        title: "Add board config",
        items: {
          type: "object",
          properties: {
            host: {
              type: "string",
              title: "Frothfet hostname or IP",
              default: "frothfet.local",
            },
            use_ssl: {
              type: "boolean",
              title: "Use SSL / HTTPS?",
              default: false,
            },
            update_interval: {
              type: "number",
              title: "Update interval (ms)",
              default: 1000,
            },
            require_login: {
              type: "boolean",
              title: "Login required?",
              default: false,
            },
            username: {
              type: "string",
              title: "Username",
              default: "admin",
            },
            password: {
              type: "string",
              title: "Password",
              default: "admin",
            },
            enable_proxy: {
              type: "boolean",
              title: "Enable remote-access proxy?",
              description:
                "Serve this board's web UI on a local port so it can be reached remotely (e.g. over Tailscale). Opt-in — nothing is exposed until you tick this. Note: the port bypasses SignalK authentication and is reachable on the boat LAN too.",
              default: false,
            },
            proxy_port: {
              type: "number",
              title: "Proxy port",
              description:
                "Local port this board's web UI is served on when the proxy is enabled. Pick a unique, stable port per board (e.g. 3200, 3201, …); the URL you bookmark depends on it.",
              default: 3200,
            },
          },
        },
      },
    },
  };

  plugin.createYarrboard = function (hostname, username = "admin", password = "admin", require_login = false, use_ssl = false, update_interval = 1000) {
    var yb = new YarrboardClient(hostname, username, password, require_login, use_ssl);
    yb.bus = plugin.bus;
    yb.update_interval = update_interval;
    yb.putHandlerRegistered = false;

    yb.onmessage = function (data) {
      if (data.msg == "update")
        this.handleUpdate(data);
      else if (data.msg == "config")
        this.handleConfig(data);
      else if (data.msg == "status") {
        if (data.status == "error")
          app.setPluginError(`[${this.hostname}] ${data.message}`);
        else if (data.status == "success")
          app.setPluginStatus(`[${this.hostname}] ${data.message}`);
      }
    };

    yb.onopen = function (_event) {
      this.getConfig();
      this.startUpdatePoller(this.update_interval);
    };

    // Find a channel's config entry by id. The board's config lists channels
    // under config.pwm.channels; matching by id (not array position) is robust
    // to the board's 1-based ids.
    yb.getChannelConfig = function (id) {
      const channels = (this.config && this.config.pwm && this.config.pwm.channels) || [];
      return channels.find((c) => c.id === id);
    };

    // Resolve a channel's SignalK path segment: its human-readable `key` slug
    // (e.g. "fresh-water-pump"), falling back to the numeric id if unset. The
    // numeric id is still published for control commands, which use it.
    yb.channelSegment = function (cfg, ch) {
      return cfg.key || ch.key || ch.id;
    };

    // Assemble the whitelisted board + channel config into one plain object.
    // Board fields sit at the top level; enabled channels go under `channels`,
    // keyed by the same slug used for their live-data paths.
    yb.buildConfig = function () {
      const out = {};
      for (const [key, get] of Object.entries(plugin.boardConfigFields)) {
        const value = get(this);
        if (value !== undefined)
          out[key] = value;
      }

      const channels = {};
      for (const ch of (this.config.pwm && this.config.pwm.channels) || []) {
        const cfg = this.getChannelConfig(ch.id);
        if (!(cfg && cfg.enabled))
          continue;

        const entry = {};
        for (const key of plugin.channelConfigFields) {
          if (ch[key] !== undefined)
            entry[key] = ch[key];
        }
        channels[this.channelSegment(cfg, ch)] = entry;
      }
      out.channels = channels;

      return out;
    };

    // Publish live channel telemetry under the main data path. Called from
    // `update` messages and whitelisted by channelLiveMetas, with unit
    // conversion applied via each meta's scale/offset.
    yb.queueChannelLive = function (channels) {
      let mainPath = this.getMainBoardPath();

      for (const ch of channels || []) {
        const cfg = this.getChannelConfig(ch.id);
        if (!(cfg && cfg.enabled))
          continue;

        let chPath = `${mainPath}.channel.${this.channelSegment(cfg, ch)}`;
        for (const [key, meta] of Object.entries(plugin.channelLiveMetas)) {
          if (ch[key] === undefined)
            continue;
          let scaled = ch[key];
          if (meta.scale)
            scaled = scaled * meta.scale;
          if (meta.offset)
            scaled = scaled + meta.offset;
          this.bus.queueConsolidated(`${chPath}.${key}`, scaled, plugin.buildMeta(meta));
        }
      }

      // Additional channel types (switches, adc, rgb) follow the same shape and
      // can be enabled here once the board reports them.
    };

    // The board's user-facing name, read from the config once it has arrived.
    yb.getBoardName = function () {
      return (this.config && this.config.config && this.config.config.name) || this.boardname;
    };

    yb.handleConfig = function (data) {
      // The board wraps the real config in a `config` envelope (alongside
      // `capabilities`, `status`, `msgid`); everything below lives under it.
      this.config = data.config || {};

      let mainPath = this.getMainBoardPath();
      let boardPath = this.getBoardPath();
      let configPath = this.getConfigBoardPath();

      // Passing raw JSON to the board's websocket lets the FrothFET web protocol
      // be driven straight from SignalK PUTs. Register once per connection.
      if (!this.putHandlerRegistered) {
        app.registerPutHandler("vessels.self", `${mainPath}.control`, this.doSendJSON.bind(this));
        this.putHandlerRegistered = true;
      }

      // Static board + channel config is the canonical reference, published as a
      // single JSON object at the per-board config path (one delta, not a path
      // per field).
      this.bus.queueConsolidated(configPath, this.buildConfig(), { description: "Board and channel configuration" });

      // Live board telemetry hangs off the board path; register its metas up
      // front so they exist before the first update arrives.
      this.bus.queueMeta(`${boardPath}.uptime`, { units: "s", description: "Seconds since the last reboot" });

      //only publish the bus voltage meta if the board reports the capability.
      if (data.capabilities && data.capabilities.bus_voltage)
        this.bus.queueMeta(`${boardPath}.bus_voltage`, { units: "V", description: "Supply voltage to the board" });

      //actually send them off now.
      this.bus.sendUpdates();
    };

    yb.handleUpdate = function (data) {
      if (!this.config)
        return;

      let boardPath = this.getBoardPath();

      //some boards don't have this.
      if (data.bus_voltage)
        this.bus.queueConsolidated(`${boardPath}.bus_voltage`, data.bus_voltage, { units: "V", description: "Bus supply voltage" });

      //store our uptime
      if (data.uptime)
        this.bus.queueConsolidated(`${boardPath}.uptime`, Math.round(data.uptime / 1000000), { units: "s", description: "Uptime since the last reboot" });

      //live per-channel telemetry (updates carry a flat pwm array)
      this.queueChannelLive(data.pwm);

      //actually send them off now.
      this.bus.sendUpdates();
    };

    // Root path all of this board's deltas hang off of. The namespacing is
    // controlled by the top-level `path_scheme` option (plugin.pathScheme):
    //   "boardname" -> electrical.frothfet.{boardname} (hostname sans .local)
    //   "uuid"      -> electrical.frothfet.{uuid}       (from the board config)
    //   "none"      -> electrical.frothfet              (flat shared namespace; default)
    // The uuid only exists once the board's config has arrived, so fall back to
    // the hostname-derived boardname until then to keep the path stable/valid.
    yb.getMainBoardPath = function () {
      const base = "electrical.frothfet";
      switch (plugin.pathScheme) {
        case "boardname":
          return `${base}.${this.boardname}`;
        case "uuid": {
          const uuid = this.config && this.config.network && this.config.network.uuid;
          return `${base}.${uuid || this.boardname}`;
        }
        default:
          return base;
      }
    };

    // Prefix for this board's live board-level telemetry (uptime, bus_voltage).
    // These are per-board scalars, so under the flat "none" scheme we insert the
    // boardname to keep multiple boards from colliding; the namespaced schemes
    // already carry a board segment via getMainBoardPath().
    yb.getBoardPath = function () {
      if (plugin.pathScheme === "none")
        return `${this.getMainBoardPath()}.board.${this.boardname}`;
      return `${this.getMainBoardPath()}.board`;
    };

    // Root path for this board's static config. Config is always per-board (so
    // it stays unambiguous even under the flat "none" scheme), keyed by uuid
    // when that scheme is selected and the uuid is known, else by boardname.
    yb.getConfigBoardPath = function () {
      const base = "electrical.frothfet.config";
      if (plugin.pathScheme === "uuid") {
        const uuid = this.config && this.config.network && this.config.network.uuid;
        return `${base}.${uuid || this.boardname}`;
      }
      return `${base}.${this.boardname}`;
    };

    // PUT handler: forward the raw JSON value straight to the board's websocket.
    yb.doSendJSON = function (context, path, value, _callback) {
      this.send(value, true);
      return { state: "COMPLETED", statusCode: 200 };
    };

    return yb;
  };

  return plugin;
};
