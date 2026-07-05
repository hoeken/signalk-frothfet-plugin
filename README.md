# signalk-frothfet-plugin

SignalK plugin for interfacing with [FrothFET](https://github.com/hoeken/frothfet) multi-channel digital load controllers.  Data, control, and — now — remote access to each board's web UI via Tailscale or another VPN.

## Setup

Add your board hosts and configure login info in the plugin preferences.

**Path scheme** (top-level option) controls how each board's **channel
telemetry** is namespaced under `electrical.frothfet`:

| Scheme      | Default | Channel telemetry                               |
| ----------- | ------- | ----------------------------------------------- |
| `none`      | ✓       | `electrical.frothfet.channel.{key}`             |
| `boardname` |         | `electrical.frothfet.{boardname}.channel.{key}` |
| `uuid`      |         | `electrical.frothfet.{uuid}.channel.{key}`      |

`none` collapses every board's channels into one flat namespace — convenient for
automation and scripting, since a channel is addressed by its slug regardless of
which board it's on (channel keys must therefore be unique across boards).
`boardname` and `uuid` give each board its own channel subtree (`uuid` survives a
hostname change).

Everything **else** a board publishes — its [config object](#signalk-path-info),
[board telemetry](#board-telemetry) and [per-board control](#control) — always
lives under a **per-board root**, `electrical.frothfet.{name|uuid}`, where
`{name|uuid}` is the boardname (`none`/`boardname` schemes) or the uuid (`uuid`
scheme). That root always carries a board segment, even under `none`, so boards
never collide.

Per-board options:

| Option            | Default          | Description                                              |
| ----------------- | ---------------- | -------------------------------------------------------- |
| `host`            | `frothfet.local` | Hostname or IP of the FrothFET board                     |
| `use_ssl`         | `false`          | Connect via HTTPS / WSS                                  |
| `update_interval` | `1000`           | Update poll interval in milliseconds                     |
| `require_login`   | `false`          | Whether the board requires authentication               |
| `username`        | `admin`          | Username (if login required)                             |
| `password`        | `admin`          | Password (if login required)                             |
| `enable_proxy`    | `false`          | Serve this board's web UI on a local port for remote access (see below) |
| `proxy_port`      | `3200`           | Local port for this board's proxy (unique per board)     |

## Control

The value PUT to a control path is passed as raw JSON straight to the board's
websocket. See the [protocol documentation](https://github.com/hoeken/yarrboard#protocol)
for the message format; commands address a channel by either its numeric `id` or
its `key` slug. Login and auth are handled for you by SignalK.

There are two ways to send a command:

- **Per-board** — `electrical.frothfet.{name|uuid}.control`, on the board's own
  [per-board root](#setup). The payload is forwarded verbatim to that board.
  Available under every path scheme.
- **Shared router** — `electrical.frothfet.control` (always available, any path
  scheme). The payload **must** include a channel `key`; the plugin looks up the
  board that owns that key and forwards the command to it. A payload with no
  `key`, or a key no board owns, is rejected. Under the `none` scheme channel
  keys must be unique across all boards for routing to be unambiguous — a
  duplicate raises a plugin error. Under the namespaced schemes the router is an
  opt-in convenience for setups whose keys happen to be unique.

## Remote access (reverse proxy)

The FrothFET board is an ESP32 on the boat LAN and can't run Tailscale itself,
so its web UI isn't reachable when you're away from the boat. This plugin can
stand up a transparent HTTP + WebSocket reverse proxy to each board so you can
reach the board's own UI remotely — e.g. over [Tailscale](https://tailscale.com/)
to the SignalK host.

**Setup**

1. In the plugin config, tick **Enable remote-access proxy?** for each board you
   want to reach, and give each one a unique **Proxy port** (e.g. `3200`, `3201`,
   …). Keep the port stable — it's part of the URL you'll bookmark.
2. Open the **Frothfet** entry in the SignalK webapp list. With one board
   enabled it redirects straight to that board's UI; with several it shows a
   picker with each board's name and connection status.
3. Remotely, browse to the SignalK host over your VPN/Tailscale hostname; the
   proxy reuses whatever host you reached the page on and only swaps the port, so
   the same link works over Tailscale, LAN, or mDNS. Each board's UI is at
   `http://<sk-host>:<proxy_port>/`.

**Security notes**

- The proxy is **opt-in** — no port opens until you enable it for a board.
- The proxy port binds to all interfaces, so it's reachable over your VPN **and**
  the boat LAN, and it **bypasses SignalK's own authentication**. The board's own
  `require_login` (if enabled) still applies through the proxy. Treat your tailnet
  / LAN as the trust boundary and only enable the proxy on networks you trust.

## SignalK Path Info

Every path a board publishes hangs off its **per-board root**,
`electrical.frothfet.{name|uuid}`, where `{name|uuid}` is the boardname
(`none`/`boardname` schemes) or the uuid (`uuid` scheme). The boardname is the
hostname without the `.local` suffix (defaults to `frothfet`); the uuid survives
a hostname change.

| Subtree              | Path                                              |
| -------------------- | ------------------------------------------------- |
| Static config object | `electrical.frothfet.{name/uuid}.config`          |
| Board telemetry      | `electrical.frothfet.{name/uuid}.board.*`         |
| Channel telemetry    | `electrical.frothfet.{name/uuid}.channel.{key}.*` |
| Per-board control    | `electrical.frothfet.{name/uuid}.control`         |

(`{name/uuid}` is the `{name|uuid}` per-board segment — written with a slash only
to keep the table readable.)

The one exception is **channel telemetry under the `none` scheme**: it drops the
board segment and collapses into the flat shared namespace
`electrical.frothfet.channel.{key}.*` (see [path scheme](#setup)). Config, board
telemetry and control keep their board segment under every scheme.

**Static config** is the canonical reference for values that rarely change
(firmware, names, settings). The whole thing is published as a *single JSON
object* — one delta, not a path per field. Only whitelisted fields are included:
secrets (WiFi/MQTT/auth passwords, TLS certs, keys) and trivia (boot log, channel
melodies) are never sent to SignalK.

### Board + channel config object (`electrical.frothfet.{name|uuid}.config`)

The value is one object. Board fields sit at the top level; enabled channels are
nested under `channels`, keyed by the channel slug (e.g. `fresh-water-pump`,
falling back to the numeric id if no key is set):

```jsonc
{
  "name": "Miscellaneous",          // user friendly name
  "uuid": "D056E904A7AC",           // unique ID of the board
  "hostname": "frothfet-misc.local",
  "firmware_version": "2.6.1",
  "hardware_version": "FROTHFET_REV_F",
  "build_time": "2026-06-13T21:47:01Z",
  "schema_version": 2,              // config schema version
  "brightness": 1,                  // LED brightness
  "use_ssl": false,
  "api_enabled": true,              // HTTP API enabled?
  "serial_enabled": false,          // serial protocol enabled?
  "ota_enabled": true,              // Arduino OTA updates enabled?
  "mqtt_enabled": true,
  "ha_integration_enabled": true,   // Home Assistant integration enabled?
  "navico_enabled": true,
  "channels": {
    "anchor-light": {
      "id": 6,                      // channel id (either id or key works for control commands)
      "key": "anchor-light",
      "name": "Anchor Light",
      "type": "light",              // e.g. bilge_pump, water_pump, light
      "enabled": true,
      "hasPWM": false,              // hardware supports PWM?
      "hasCurrent": true,           // current monitoring?
      "isDimmable": false,
      "softFuse": 3,                // software fuse, in amps
      "softFuseType": "SLOW",       // trip behavior, e.g. SLOW, FAST
      "defaultState": "OFF"         // state the channel powers up in
    }
  }
}
```

### Board telemetry

Board-level live values hang off the per-board root under every scheme, at
`electrical.frothfet.{name|uuid}.board.*`:

| Leaf          | Units | Description                               |
| ------------- | ----- | ----------------------------------------- |
| `uptime`      | s     | Controller uptime                         |
| `bus_voltage` | V     | Supply voltage to the board (if reported) |

### PWM channel telemetry

Live per-channel telemetry (only enabled channels), where `{key}` is the same
slug used in the config object above. Under `none` these are flat at
`electrical.frothfet.channel.{key}.*`; under `boardname`/`uuid` they carry the
board segment, `electrical.frothfet.{name|uuid}.channel.{key}.*`:

| Path          | Units | Description                                             |
| ------------- | ----- | ------------------------------------------------------- |
| `state`       |       | Whether the channel is on or not                        |
| `source`      |       | Source of last state change                             |
| `duty`        | ratio | Duty cycle as a ratio from 0 to 1                       |
| `voltage`     | V     | Voltage of channel                                      |
| `current`     | A     | Current of channel                                      |
| `wattage`     | W     | Power draw of channel                                   |
| `temperature` | K     | Temperature of channel (°C + 273.15)                    |
| `aH`          | C     | Consumed charge since board restart (amp-hours × 3600)  |
| `wH`          | J     | Consumed energy since board restart (watt-hours × 3600) |

> Amp-hours and watt-hours are converted to SignalK base units (Coulombs and
> Joules), and channel temperature from Celsius to Kelvin, before publishing.

## Development

Install dependencies and run the checks:

```sh
npm install
npm test          # run the test suite
npm run test:coverage   # run tests with a coverage report
npm run lint      # eslint
npm run format:check   # eslint + prettier check
```

The tests use Node's built-in test runner (`node:test`, Node 18+) — no extra
test dependencies are needed (besides `ws` for the WebSocket proxy test). They
cover:

- **`signalk-bus.js`** — delta/meta queuing, batching, de-duplication.
- **`index.js`** — the plugin schema, the `/boards` route, the yarrboard-client
  message routing, the PWM channel publishing (only enabled channels, key-based
  paths, id-based config matching, aH→C / wH→J / °C→K conversion), and the
  control PUT handler. No board connection is opened.
- **`signalk-board-proxy.js`** — descriptor filtering (enable/port/duplicate),
  target URL building, and the `/boards` metadata. `ReverseProxy` is stubbed so
  no ports are opened.
- **`reverse-proxy.js`** — real HTTP and WebSocket proxying over loopback
  sockets, header stripping, `502` on an unreachable upstream, and `EADDRINUSE`
  handling.

## Releasing

See [RELEASE.md](RELEASE.md).
