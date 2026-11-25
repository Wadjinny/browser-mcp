# Contributing

## Running from source

```bash
pnpm install
pnpm build
```

Point your MCP client at the built server:

```json
{
  "mcpServers": {
    "browser-mcp": {
      "command": "node",
      "args": ["/absolute/path/to/browser-mcp/server/dist/index.js"],
      "env": {
        "BROWSER_MCP_NAME": "my-project"
      }
    }
  }
}
```

Load `extension/dist` with **Load unpacked** in `chrome://extensions`. Builds you make yourself are dev builds and never check for updates.

## Development

```bash
pnpm --filter tabmcp dev                    # MCP server + WebSocket bridge
pnpm --filter @browser-mcp/extension watch  # rebuild extension/dist
pnpm typecheck
```

Reload the unpacked extension in Chrome after rebuilds.

See [SPEC.md](./SPEC.md) for the architecture and protocol.

## Releasing

Push a `v*` tag (e.g. `v0.3.0`). CI then:

- builds the extension with the tag's version and attaches the zip to a GitHub release;
- publishes the server to npm as `tabmcp` with the same version, using [npm Trusted Publishing](https://docs.npmjs.com/trusted-publishers). No npm token is stored anywhere. npm checks that the publish comes from this repo's `release.yml` workflow.

One-time setup on npmjs.com: in the `tabmcp` package settings, add a trusted publisher of type GitHub Actions with owner `Wadjinny`, repository `browser-mcp` and workflow file `release.yml`.

## Manual test checklist

- [ ] MCP server starts; `/health` and `/handshake` respond on 127.0.0.1
- [ ] With Chrome closed, `browser_open` launches Chrome, the extension connects, and the page opens
- [ ] Extension popup shows bridge Connected
- [ ] Connect on a normal https tab; badge shows ON
- [ ] `browser_open` with an https URL creates a tab, Connects it, and badge shows ON (no popup Connect needed)
- [ ] `browser_navigate` with no Connected tab also opens and Connects
- [ ] `browser_open` / `browser_navigate` to `chrome://` fails with RESTRICTED_URL
- [ ] Connect fails on `chrome://` with a clear error
- [ ] `browser_snapshot` then `browser_click` / `browser_type` work
- [ ] `browser_type_secure` opens a separate extension window, types the value, and returns only `{ filled, chars, submitted }`
- [ ] Cancel / Esc / closing the secure window returns `SECURE_INPUT_CANCELLED` and types nothing; timeout returns `SECURE_INPUT_TIMEOUT`; a second prompt on the same tab returns `SECURE_INPUT_BUSY`
- [ ] A text field filled through `browser_type_secure` shows `value=<redacted>` in later snapshots and find results
- [ ] Popup **Pick element** or `browser_pick_element` pins a node; `browser_pins` lists it; `browser_pin_inspect` returns attrs/relatedUrls
- [ ] Esc during pick returns `PICK_CANCELLED`; idle pick times out (~90s)
- [ ] `browser_click({ pin })` works without a fresh snapshot
- [ ] Navigate / Disconnect clears pins
- [ ] Closing Connected tab auto-disconnects
- [ ] Connected tab joins the orange agent tab group, shows the border + pill, and only that tab has the ON badge
- [ ] Border pulses during agent commands, then settles; overlay survives reload/navigation
- [ ] Pill **Stop** disconnects; group, border and badge are removed
- [ ] Screenshots do not include the overlay; screenshot of a background Connected tab never captures a different tab
- [ ] Switching the Connected tab clears network/console buffers from the previous tab
- [ ] Snapshot shows `value=`, `[checked]`, `[disabled]`, `[expanded]` states
- [ ] `devtools_attach` works; fails with guidance if DevTools UI is open on that tab
- [ ] `devtools_attach` returns `workersAttached` when the page has workers; `devtools_targets` lists them with `attached: true`
- [ ] `devtools_network_requests` / `devtools_console_messages` populate after attach (including worker `targetType` when applicable)
- [ ] `devtools_network_summary` returns hosts / topPaths without dumping full entries
- [ ] `devtools_network_for_pin` matches an `<img>` pin; `waitForMs` catches a later request
- [ ] `waitForMs` above 120s (e.g. 130000) with no match returns `{ timedOut: true }` (not bridge TIMEOUT)
- [ ] Isolated `devtools_evaluate` on a CSP-locked page falls back to main/CDP with a note
- [ ] Disconnect / `devtools_detach` detaches debugger (tab + workers) and clears agent target
- [ ] Two MCP instances both show as connected in the popup Bridges list, each with its own tab
- [ ] Two sessions `browser_open` different URLs and work in parallel with no notification; each tab has its own coloured group and label
- [ ] One session's network/console results never include the other session's tab
- [ ] `browser_connect_tab` on a tab owned by another session shows Allow/Deny; Deny keeps the original owner
- [ ] `browser_connect_tab` with no answer for 60 s returns `CONTROL_REQUEST_TIMEOUT` (Deny returns `CONTROL_DENIED`); a late Allow does nothing; clicking the notification body does not count as Allow
- [ ] Popup **Connect** assigns the active tab to the **Connect target** session
- [ ] Stopping an MCP server releases its tab after ~60 s
- [ ] `browser_click` on a link/submit returns `navigated: true` with the new URL
- [ ] `browser_open` with `recordNetwork: true` lists the document request and its subresources
- [ ] `devtools_network_summary` groups `/item/123` and `/item/456` as `/item/:id`
- [ ] `BROWSER_MCP_NAME` appears as `name :port` in the popup and notification
- [ ] A release build shows the Update banner when a newer GitHub release exists; Update installs into `~/.config/browser-mcp/extension` and reloads
