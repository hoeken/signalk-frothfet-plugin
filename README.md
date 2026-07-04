# signalk-frothfet-plugin

SignalK plugin for interfacing with [FrothFET](https://github.com/hoeken/frothfet) multi-channel digital load controllers.  Data, control, and — now — remote access to each board's web UI via Tailscale or another VPN.

## Setup

Add your board hosts and configure login info in the plugin preferences. Per-board options:

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

The plugin registers a SignalK PUT handler per board:

- `electrical.frothfet.{boardname}.control` — the value is passed as raw JSON straight to the board's websocket. See the [protocol documentation](https://github.com/hoeken/yarrboard#protocol) for the message format. Login and auth are handled for you by SignalK.

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

`{boardname}` is your board hostname without the `.local` suffix, defaults to `frothfet`.

### Board info

| Path                                              | Units | Description                               |
| ------------------------------------------------- | ----- | ----------------------------------------- |
| `electrical.frothfet.{boardname}.board.firmware_version` |       | Firmware version                          |
| `electrical.frothfet.{boardname}.board.hardware_version` |       | Hardware version                          |
| `electrical.frothfet.{boardname}.board.hostname`         |       | Local board hostname                      |
| `electrical.frothfet.{boardname}.board.name`             |       | User friendly name                        |
| `electrical.frothfet.{boardname}.board.uptime`           | s     | Controller uptime                         |
| `electrical.frothfet.{boardname}.board.use_ssl`          |       | Does the board use SSL?                   |
| `electrical.frothfet.{boardname}.board.uuid`             |       | Unique ID of the board                    |
| `electrical.frothfet.{boardname}.board.bus_voltage`      | V     | Supply voltage to the board (if reported) |

### PWM channels

Published per enabled channel under `electrical.frothfet.{boardname}.pwm.{id}.*`:

| Path         | Units | Description                                             |
| ------------ | ----- | ------------------------------------------------------- |
| `id`         |       | ID of each channel                                      |
| `name`       |       | User defined name of channel                            |
| `source`     |       | Source of last state change                             |
| `enabled`    |       | Whether the channel is in use or should be ignored      |
| `hasPWM`     |       | Whether this channel can do PWM (duty cycle, dimming)   |
| `hasCurrent` |       | Whether this channel has current monitoring             |
| `softFuse`   | A     | Software defined fuse, in amps                          |
| `isDimmable` |       | Whether the channel has dimming enabled                 |
| `state`      |       | Whether the channel is on or not                        |
| `duty`       | ratio | Duty cycle as a ratio from 0 to 1                       |
| `voltage`    | V     | Voltage of channel                                      |
| `current`    | A     | Current of channel                                      |
| `aH`         | C     | Consumed charge since board restart (amp-hours × 3600)  |
| `wH`         | J     | Consumed energy since board restart (watt-hours × 3600) |

> Amp-hours and watt-hours reported by the board are converted to SignalK base
> units (Coulombs and Joules) before publishing.

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
  message routing, the PWM channel publishing (only enabled channels, aH→C /
  wH→J conversion), and the control PUT handler. No board connection is opened.
- **`signalk-board-proxy.js`** — descriptor filtering (enable/port/duplicate),
  target URL building, and the `/boards` metadata. `ReverseProxy` is stubbed so
  no ports are opened.
- **`reverse-proxy.js`** — real HTTP and WebSocket proxying over loopback
  sockets, header stripping, `502` on an unreachable upstream, and `EADDRINUSE`
  handling.

## Releasing

See [RELEASE.md](RELEASE.md).
