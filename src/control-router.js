/*
 * Copyright 2026 Zach Hoeken <hoeken@gmail.com>
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

// control-router.js — SignalK PUT handling for FrothFET control commands.
// Owns two control surfaces and the routing state that ties them together:
//   * a per-board control path (electrical.frothfet.{boardname|uuid}.control)
//     whose raw-JSON PUT is forwarded straight to that board's websocket, and
//   * a shared router at the flat electrical.frothfet.control path that looks up
//     the board owning a channel `key` in the payload and forwards to it.
// The channel-key -> board map backing the shared router is rebuilt from the
// live connection list on every board config load.
//
// The board segment/config accessors it relies on (getBoardNamespace,
// getChannelConfig, channelSegment, send, config, boardname) live on the
// yarrboard connection objects passed in; the router itself is FrothFET-agnostic
// beyond the two electrical.frothfet.* paths it registers.

class ControlRouter {
  // getPathScheme is a getter (not a captured value) because the plugin's
  // path_scheme is set/changed after the router is constructed; collision
  // enforcement in rebuild() must see the current value.
  constructor(app, getPathScheme) {
    this.app = app;
    this.getPathScheme = getPathScheme;

    // channel key (slug) -> owning board connection, backing the shared router.
    this.channelKeyToBoard = {};

    // Idempotency guards: the shared router is registered once; each board's
    // per-board handler is registered once (tracked by connection identity).
    this.sharedRegistered = false;
    this.boardsRegistered = new WeakSet();
  }

  // Per-board control: a raw-JSON PUT to this board's own control path is
  // forwarded straight to its websocket (FrothFET web protocol). It lives at the
  // per-board namespace root (electrical.frothfet.{boardname|uuid}.control) so
  // boards never collide, even under the flat "none" scheme. Idempotent per
  // board.
  registerBoard(yb) {
    if (this.boardsRegistered.has(yb))
      return;

    this.app.registerPutHandler("vessels.self", `${yb.getBoardNamespace()}.control`, (context, path, value) => {
      yb.send(value, true);
      return { state: "COMPLETED", statusCode: 200 };
    });
    this.boardsRegistered.add(yb);
  }

  // Shared control router at the flat electrical.frothfet.control path,
  // registered once (regardless of path scheme). It routes a PUT to whichever
  // board owns the channel `key` in the payload. Idempotent.
  registerShared() {
    if (this.sharedRegistered)
      return;

    this.app.registerPutHandler("vessels.self", "electrical.frothfet.control", this.handleControlPut.bind(this));
    this.sharedRegistered = true;
  }

  // (Re)build the channel-key -> board map used by the shared control router.
  // Rebuilt on every config load so it tracks boards being (re)configured. The
  // board firmware routes on `key`, so all we need is the owning connection; the
  // raw payload is forwarded unchanged.
  //
  // Under the flat "none" scheme a duplicate key across boards is unroutable, so
  // we surface it as a plugin error. Namespaced schemes keep the router as an
  // opt-in convenience for users with unique keys, so collisions aren't enforced
  // (the first board to claim a key wins).
  rebuild(connections) {
    const map = {};
    const collisions = {};

    for (const yb of connections) {
      const channels = (yb.config && yb.config.pwm && yb.config.pwm.channels) || [];
      for (const ch of channels) {
        const cfg = yb.getChannelConfig(ch.id);
        if (!(cfg && cfg.enabled))
          continue;

        const key = String(yb.channelSegment(cfg, ch));
        if (map[key] && map[key] !== yb) {
          const boards = collisions[key] || (collisions[key] = [map[key].boardname]);
          if (!boards.includes(yb.boardname))
            boards.push(yb.boardname);
        } else if (!map[key]) {
          map[key] = yb;
        }
      }
    }

    this.channelKeyToBoard = map;

    if (this.getPathScheme() === "none" && Object.keys(collisions).length) {
      const detail = Object.entries(collisions)
        .map(([key, boards]) => `"${key}" (${boards.join(", ")})`)
        .join("; ");
      this.app.setPluginError(
        `Duplicate channel keys across boards under the "none" path scheme make control routing ambiguous: ${detail}. Give the channels unique keys or switch to the boardname/uuid path scheme.`,
      );
    }
  }

  // Shared control router handler at the flat electrical.frothfet.control path.
  // The payload must carry a channel `key` (the only thing that identifies a
  // board here); we look up the owning board and forward the raw command to it.
  // A missing key or an unknown key is rejected — we have no way to route it.
  handleControlPut(context, path, value, _callback) {
    if (!value || typeof value !== "object" || Array.isArray(value) || value.key === undefined || value.key === null)
      return {
        state: "COMPLETED",
        statusCode: 400,
        message: "Control commands to electrical.frothfet.control must include a channel `key` to route to a board.",
      };

    const yb = this.channelKeyToBoard[String(value.key)];
    if (!yb)
      return {
        state: "COMPLETED",
        statusCode: 400,
        message: `No board found for channel key "${value.key}". The board may be offline or its config not yet loaded.`,
      };

    yb.send(value, true);
    return { state: "COMPLETED", statusCode: 200 };
  }
}

module.exports = { ControlRouter };
