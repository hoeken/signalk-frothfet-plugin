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

  // Per-channel metadata for the PWM output channels. `scale` (optional) converts
  // the board's value into a SignalK base unit before it is published.
  //   aH (amp-hours)  -> C (Coulombs)  x3600
  //   wH (watt-hours) -> J (Joules)    x3600
  plugin.pwmMetas = {
    id: { description: "ID of each channel" },
    name: { description: "User defined name of channel" },
    source: { description: "Source of last state change" },
    enabled: { description: "Whether or not this channel is in use or should be ignored" },
    hasPWM: { description: "Whether this channel hardware is capable of PWM (duty cycle, dimming, etc)" },
    hasCurrent: { description: "Whether this channel has current monitoring" },
    softFuse: { units: "A", description: "Software defined fuse, in amps" },
    isDimmable: { description: "Whether the channel has dimming enabled or not" },
    state: { description: "Whether the channel is on or not" },
    duty: { units: "ratio", description: "Duty cycle as a ratio from 0 to 1" },
    voltage: { units: "V", description: "Voltage of channel" },
    current: { units: "A", description: "Current of channel" },
    aH: { units: "C", description: "Consumed charge since board restart", scale: 3600 },
    wH: { units: "J", description: "Consumed energy since board restart", scale: 3600 },
  };

  plugin.start = function (options, _restartPlugin) {
    app.debug(`YarrboardClient.version: ${YarrboardClient.version}`);

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
        name: () => (frothfet.config && frothfet.config.name) || frothfet.boardname,
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

    // Shared by config and update messages: walk each channel type and publish a
    // delta (and, once, a meta) for every reported field of every enabled channel.
    yb.queueDeltasAndUpdates = function (data) {
      let mainPath = this.getMainBoardPath();

      // PWM output channels.
      if (data.pwm) {
        for (const ch of data.pwm) {
          if (!(this.config.pwm && this.config.pwm[ch.id] && this.config.pwm[ch.id].enabled))
            continue;

          let chPath = `${mainPath}.pwm.${ch.id}`;
          for (const [key, value] of Object.entries(ch)) {
            const meta = plugin.pwmMetas[key];
            const scaled = meta && meta.scale ? value * meta.scale : value;
            this.bus.queueDelta(`${chPath}.${key}`, scaled);

            if (meta)
              this.bus.queueMeta(`${chPath}.${key}`, meta.units ? { units: meta.units, description: meta.description } : { description: meta.description });
          }
        }
      }

      // Additional channel types (switches, adc, rgb) follow the same shape and
      // can be enabled here once the board reports them.
    };

    yb.handleConfig = function (data) {
      this.config = data;

      let mainPath = this.getMainBoardPath();

      // Passing raw JSON to the board's websocket lets the FrothFET web protocol
      // be driven straight from SignalK PUTs. Register once per connection.
      if (!this.putHandlerRegistered) {
        app.registerPutHandler("vessels.self", `${mainPath}.control`, this.doSendJSON.bind(this));
        this.putHandlerRegistered = true;
      }

      this.bus.queueConsolidated(`${mainPath}.board.firmware_version`, data.firmware_version, { description: "Firmware version of the board" });
      this.bus.queueConsolidated(`${mainPath}.board.hardware_version`, data.hardware_version, { description: "Hardware version of the board" });
      this.bus.queueConsolidated(`${mainPath}.board.name`, data.name, { description: "User defined name of the board" });
      this.bus.queueConsolidated(`${mainPath}.board.uuid`, data.uuid, { description: "Unique ID of the board" });
      this.bus.queueConsolidated(`${mainPath}.board.hostname`, this.hostname, { description: "Hostname of the board" });
      this.bus.queueConsolidated(`${mainPath}.board.use_ssl`, data.use_ssl, { description: "Whether the app uses SSL or not" });
      this.bus.queueMeta(`${mainPath}.board.uptime`, { units: "s", description: "Seconds since the last reboot" });

      //some boards don't have this.
      if (data.bus_voltage)
        this.bus.queueMeta(`${mainPath}.board.bus_voltage`, { units: "V", description: "Supply voltage to the board" });

      //common handler for config and update
      this.queueDeltasAndUpdates(data);

      //actually send them off now.
      this.bus.sendUpdates();
    };

    yb.handleUpdate = function (data) {
      if (!this.config)
        return;

      let mainPath = this.getMainBoardPath();

      //some boards don't have this.
      if (data.bus_voltage)
        this.bus.queueConsolidated(`${mainPath}.board.bus_voltage`, data.bus_voltage, { units: "V", description: "Bus supply voltage" });

      //store our uptime
      if (data.uptime)
        this.bus.queueConsolidated(`${mainPath}.board.uptime`, Math.round(data.uptime / 1000000), { units: "s", description: "Uptime since the last reboot" });

      //common handler for config and update
      this.queueDeltasAndUpdates(data);

      //actually send them off now.
      this.bus.sendUpdates();
    };

    yb.getMainBoardPath = function () {
      return `electrical.frothfet.${this.boardname}`;
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
