# Unreleased

### Changed

- **Configurable path scheme.** A new top-level `path_scheme` option controls how boards are namespaced under `electrical.frothfet`: `none` (default) publishes every board into one flat namespace (`electrical.frothfet.{channels}`), while `boardname` and `uuid` give each board its own namespace (`electrical.frothfet.{boardname|uuid}.{channels}`). The default changed from v1.0.0's implicit `{boardname}` namespacing to `none`.
- **Channel paths renamed and keyed by slug.** PWM channels are now published under `{board}.channel.{key}.*` (e.g. `…channel.fresh-water-pump.state`) — renamed from `{board}.pwm.{id}.*` — keyed by the channel's slug instead of the numeric id, falling back to the id when a channel has no key. The numeric `id` is still published for control commands.
- **New nested config format.** The board now wraps its config in a `config` envelope with channels under `config.pwm.channels`; board metadata is read from `config.app.*`, `config.config.name`, `config.network.uuid`, and `config.http.ssl_enabled`.

### Added

- **Path scheme selector** in the plugin config (`none` / `boardname` / `uuid`) — see above.
- **New per-channel telemetry** published by the board: `key` (channel slug), `wattage` (`W`), and `temperature` (converted from Celsius to Kelvin, `K`).
- **New per-channel config fields** documented with SignalK meta: `type`, `softFuseType`, and `defaultState`.

### Fixed

- **1-based channel ids.** The board reports channel ids starting at 1; channels are matched to their config entry by id rather than array position, so enabled channels are no longer mis-gated.

# v1.0.0

_2026-07-04_

Initial release of the SignalK FrothFET plugin, for the FrothFET multi-channel digital load controller — an ESP32 board running the YarrboardFramework. It shares its build, test, and remote-access machinery with the sister plugin [signalk-brineomatic-plugin](https://github.com/hoeken/signalk-brineomatic-plugin).

### Added

- **Multi-board support.** Connect to any number of FrothFET controllers, each configured independently: `host`, `use_ssl`, `update_interval`, and optional login (`require_login`, `username`, `password`).
- **WebSocket connection** to each controller via `yarrboard-client`, with automatic config and telemetry polling.
- **Live data** published under `electrical.frothfet.{boardname}.*`:
  - **Board info:** `firmware_version`, `hardware_version`, `hostname`, `name`, `uptime`, `use_ssl`, `uuid`, and `bus_voltage` (when reported).
  - **Per PWM channel** (`electrical.frothfet.{boardname}.pwm.{id}.*`): `state`, `duty`, `voltage`, `current`, `aH`, `wH`, `softFuse`, and channel metadata. Only enabled channels are published.
- **Control endpoint.** A SignalK PUT handler at `electrical.frothfet.{boardname}.control` forwards raw JSON straight to the board's websocket, so the FrothFET protocol can be driven from SignalK. Login and auth are handled by SignalK.
- **SI units.** Amp-hours and watt-hours are converted to SignalK base units before publishing: `aH` → Coulombs (`C`), `wH` → Joules (`J`). Units and descriptions (SignalK meta) are published for every path.
- **Remote access to each board's web UI.** The ESP32 boards can't run a VPN themselves, so the plugin can serve any board's own web interface through the SignalK host, making it reachable remotely (e.g. over Tailscale). Enable it per board with the `enable_proxy` and `proxy_port` settings — each enabled board gets its own dedicated port, and both HTTP and the board's live WebSocket are proxied transparently.
- **Landing page in the SignalK webapp list.** With one board proxied it opens straight to that board's UI; with several it shows a picker grid listing each board by name with live connection status.
- **Boards metadata endpoint** at `/plugins/signalk-frothfet-plugin/boards`, listing the enabled boards and their proxy ports for anything that wants to discover them programmatically.
- Plugin logo and display name in the SignalK app store and webapp list.
- Automated testing and releases: a unit-test suite (`npm test` / `npm run test:coverage`) covering the plugin's modules, CI that runs it on every push and pull request, and tag-driven publishing to npm.
