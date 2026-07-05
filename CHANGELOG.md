# v1.0.0

Initial release of the SignalK FrothFET plugin, for the [FrothFET](https://frothfet.com)
multi-channel digital load controller — an ESP32 board running the YarrboardFramework.
It shares its build, test, and remote-access machinery with the sister plugin
[signalk-brineomatic-plugin](https://github.com/hoeken/signalk-brineomatic-plugin).

### Boards & connection

- **Multi-board support.** Connect to any number of FrothFET controllers, each
  configured independently: `host`, `use_ssl`, `update_interval`, and optional
  login (`require_login`, `username`, `password`).
- **WebSocket connection** to each controller via `yarrboard-client` (1.5.0),
  with automatic config and telemetry polling and connection retry.

### Paths & data

- **Configurable path scheme.** A top-level `path_scheme` option controls how
  each board's **channel telemetry** is namespaced under `electrical.frothfet`:
  - `none` (default) — collapses every board's channels into one flat namespace,
    `electrical.frothfet.channel.{key}.*`. A channel is addressed by its slug
    regardless of which board it's on, which is convenient for automation — but
    channel keys must be unique across boards.
  - `boardname` / `uuid` — give each board its own channel subtree,
    `electrical.frothfet.{boardname|uuid}.channel.{key}.*`. `uuid` survives a
    hostname change.
- **Per-board root for everything else.** A board's config object, board
  telemetry, and per-board control always live under `electrical.frothfet.{name|uuid}`,
  carrying a board segment even under `none` so boards never collide.
- **Channels keyed by slug.** PWM channels publish under `channel.{key}.*` (e.g.
  `…channel.fresh-water-pump.state`), keyed by the channel's slug and falling
  back to its numeric id when no key is set. Only enabled channels are published.
- **Channel telemetry:** `state`, `source`, `duty` (ratio), `voltage` (`V`),
  `current` (`A`), `wattage` (`W`), `temperature` (`K`), `aH` (`C`), and `wH`
  (`J`).
- **Board telemetry** at `electrical.frothfet.{name|uuid}.board.*`: `uptime`
  (`s`) and `bus_voltage` (`V`, when reported).
- **Config published as a single object** at `electrical.frothfet.{name|uuid}.config`
  — one delta, not a path per field — for values that rarely change (firmware,
  hardware, names, per-channel `type` / `softFuse` / `softFuseType` /
  `defaultState`, etc.). Enabled channels are nested under `channels`, keyed by
  slug. Only whitelisted fields are sent: secrets (WiFi/MQTT/auth passwords, TLS
  certs, keys) and trivia (boot log, channel melodies) are never published to
  SignalK.
- **SI units.** Amp-hours → Coulombs (`aH` × 3600), watt-hours → Joules
  (`wH` × 3600), and channel temperature Celsius → Kelvin (+ 273.15) before
  publishing. SignalK meta (units and descriptions) is published for every path.

### Control

- **Per-board control.** PUT to `electrical.frothfet.{name|uuid}.control` and the
  raw JSON payload is forwarded verbatim to that board's websocket. See the
  [protocol docs](https://frothfet.com/docs/software/api.html) for the message
  format; commands address a channel by numeric `id` or `key` slug. Login and
  auth are handled for you by SignalK.
- **Shared control router.** PUT to `electrical.frothfet.control` (always
  available, any path scheme) with a channel `key` in the payload; the plugin
  looks up the board that owns that key and forwards the command. A payload with
  no `key`, or a key no board owns, is rejected. Under `none`, duplicate keys
  across boards make routing ambiguous and raise a plugin error.

### Remote access

- **Reverse proxy to each board's web UI.** The ESP32 boards can't run a VPN
  themselves, so the plugin can serve any board's own web interface through the
  SignalK host — reachable remotely, e.g. over [Tailscale](https://tailscale.com/).
  Enable it per board with `enable_proxy` and a unique `proxy_port`; both HTTP and
  the board's live WebSocket are proxied transparently. The proxy reuses whatever
  host you reached the page on and only swaps the port, so one bookmark works over
  Tailscale, LAN, or mDNS.
  - **Opt-in and unauthenticated.** No port opens until you enable it for a board.
    The proxy port binds all interfaces and **bypasses SignalK's own auth** — the
    board's `require_login` (if set) still applies. Treat your tailnet/LAN as the
    trust boundary.
- **Landing page in the SignalK webapp list.** With one board proxied it opens
  straight to that board's UI; with several it shows a picker grid listing each
  board by name with live connection status, in a light/dark theme.
- **Boards metadata endpoint** at `/plugins/signalk-frothfet-plugin/boards`,
  listing enabled boards and their proxy ports for anything that wants to discover
  them programmatically.

### Project

- Plugin logo and display name in the SignalK app store and webapp list, plus
  screenshots.
- Automated testing and releases: a unit-test suite (`npm test` /
  `npm run test:coverage`) covering the plugin's modules, CI that runs it on every
  push and pull request, and tag-driven publishing to npm.
