# Using browser-mcp

How to work with browser-mcp once it's installed. For setup, see the [README](../README.md).

## Connect a tab

An agent only works in a tab that is connected to its session. There are three ways to connect one:

- Open the site in Chrome, click the **browser-mcp** icon, then **Connect this tab**.
- Ask the agent to open a URL (`browser_open` / `browser_navigate`). It creates a tab and connects it.
- Ask the agent to take over a tab you already have open (`browser_connect_tab`, with the id from `browser_tabs` with `includeOthers`). You click **Allow** in a Chrome notification.

Restricted URLs (`chrome://`, extension pages, the Web Store) can't be opened or connected.

Disconnecting (popup, the pill's **Stop** button, or `browser_disconnect`) releases the tab and detaches the debugger.

## Several sessions in parallel

Every MCP session (Claude Code, Cursor, …) owns **its own** connected tab, so several agents can work side by side without prompts or a shared lease:

- Each session has at most one tab. `browser_open` / `browser_connect_tab` replace that session's previous tab.
- Network and console buffers, pins and the element picker are per tab, and DevTools events go only to the session that owns the tab.
- Taking over an existing tab (`browser_connect_tab`) always asks you to **Allow**. If another session owns it, the notification says so.
- The popup's **Connect this tab** card gives the active tab to the session marked **Connect target** (click another session card to change it). If only one session is connected, it is picked automatically. Popup commands (Stop, Pick element, Hand this tab, Detach debugger) also work from the keyboard.
- If a session's MCP server goes away, its tab is released after 60 s. A restart within that window keeps the tab. A new process that reuses the port does not inherit the old process's tab.
- `browser_request_control` / `browser_release_control` remain as legacy aliases (status / disconnect).

Up to 20 servers can run at once, on ports `17373`–`17392`. The extension connects to all of them.

## Controlled-tab indicator

Every connected tab is visibly marked, in a colour per session:

- It moves into a **🤖 `name :port`** tab group in that session's colour (tabs already in one of your own groups stay where they are) and leaves the group on disconnect.
- The page gets a matching border and a bottom pill, "`name :port` is controlling this tab", with **Stop** and collapse buttons. The border pulses while an agent command runs.
- The toolbar badge shows **ON** only on connected tabs.

The overlay sits in a closed shadow root outside `<body>`, so snapshots and find don't see it. It is hidden while screenshots are taken.

## Secure input (passwords, OTPs, API keys)

Never paste a secret into chat or pass it as `browser_type.text`. The agent calls `browser_type_secure` on the field instead:

```jsonc
{ "ref": "e12", "label": "LinkedIn password", "kind": "password", "submit": true }
```

A small extension window opens **outside the page**, so the page's own scripts can't read what you type. The value goes from that window through the extension into the connected tab, then the window closes. The tool returns only `{ filled, chars, submitted }` (plus `navigated`/`url`/`title` when `submit` navigates). The secret is never a tool argument, a tool result, or part of the conversation.

- `kind`: `password` (default), `text`, or `otp`.
- `label`, `targetHint`: shown in the window so you can check what is being asked and where it goes.
- `timeoutMs`: how long to wait for you (default `120000`, max `300000`).
- Cancel, Esc or closing the window returns `SECURE_INPUT_CANCELLED`; a timeout returns `SECURE_INPUT_TIMEOUT`. No value is typed in either case. One secure window per tab at a time (`SECURE_INPUT_BUSY`).

Fields filled this way are redacted (`value=<redacted>`) in later snapshots and find results.

**Caveat:** this keeps the value out of the agent's context, not away from the page. The site receives it normally, and its scripts can copy it into other fields. Check the destination host shown in the window before typing.

## Pin elements

After connecting, use **Pick element** in the popup (or have the agent call `browser_pick_element`) to enter pick mode. Hovering highlights an element; clicking pins it as `pin_N`. Esc cancels. Pins stay until cleared, the page navigates, or the tab disconnects. Interaction tools accept `pin` instead of a snapshot `ref`. The in-page pin panel has a copy button for `browser-mcp://tab/{tabId}/pin/{id}`.

## Navigation and network recording

- `browser_click`, `browser_press_key`, `browser_type` and `browser_type_secure` with `submit` wait for any navigation they trigger and return `navigated`, `url` and `title`. Pass `waitForNavigation: false` to skip this (when nothing navigates it costs about 0.4 s).
- `browser_open` / `browser_navigate` with `recordNetwork: true` attach the debugger **before** loading, so `devtools_network_*` includes the page's own first requests. It is off by default because Chrome then shows its "started debugging this browser" bar.
- `devtools_network_summary` collapses id-like path segments (numbers, UUIDs, long tokens) to `:id`, and returns 15 hosts and 15 paths by default.
- `browser_screenshot` fails immediately with `TAB_NOT_VISIBLE` when the tab is in the background (Chrome can only capture the front tab).

## Tools

**Session**: `browser_connect_tab`, `browser_disconnect`, `browser_control_status` (legacy: `browser_request_control`, `browser_release_control`)

**Automation** (no debugger needed): `browser_tabs`, `browser_open`, `browser_navigate`, `browser_go_back` / `browser_go_forward`, `browser_wait`, `browser_snapshot`, `browser_click`, `browser_hover`, `browser_drag`, `browser_type`, `browser_type_secure`, `browser_press_key`, `browser_screenshot`, `browser_console_messages`, `browser_pick_element`, `browser_pick_cancel`, `browser_pins`, `browser_pin_inspect`, `browser_pin_clear`

**DevTools** (attaches the debugger on first use): `devtools_attach` / `devtools_detach`, `devtools_targets`, `devtools_network_requests` (rich filters, WebSocket frames, `waitForMs` up to 300 s), `devtools_network_summary`, `devtools_network_request`, `devtools_network_body`, `devtools_network_for_pin`, `devtools_console_messages`, `devtools_evaluate` (pin-bound `el`, falls back to the main world on CSP-locked pages), `devtools_get_box_model`, `devtools_get_computed_style`, `devtools_cookies`, `devtools_storage`, `devtools_cdp` (allowlisted domains, including read-mostly `Target.*`)

Attaching also covers the page's existing workers, so traffic from service and shared workers reaches the network buffer. New workers are attached automatically.

See [SPEC.md](../SPEC.md) for each tool's parameters.

## Configuration

All settings are environment variables on the MCP server, and all are optional.

| Variable | Default | What it does |
| --- | --- | --- |
| `BROWSER_MCP_NAME` | project folder | Label for this session in the popup, tab group and notifications. Always shown with `:port`. |
| `BROWSER_MCP_AUTO_ALLOW` | off | `1`/`true`/`yes`/`on` lets the extension grant **this** session's tab takeovers without an Allow/Deny prompt. See [Auto-allow](#auto-allow). |
| `BROWSER_MCP_WS_PORT` | `17373` | Preferred port. If it's busy, the server takes the next free one in `17373`–`17392`. |
| `BROWSER_MCP_LAUNCH_CHROME` | on | `0`/`false`/`off` stops the server from starting Chrome itself. |
| `BROWSER_MCP_CHROME_BIN` | auto-detected | Browser executable, e.g. `/usr/bin/google-chrome`. |
| `BROWSER_MCP_CHROME_PROFILE` | Chrome's default | `--profile-directory` value, e.g. `Default` or `Profile 1`. |
| `BROWSER_MCP_CHROME_USER_DATA_DIR` | Chrome's default | `--user-data-dir`, for a separate Chrome profile folder. |
| `BROWSER_MCP_CHROME_ARGS` | none | Extra Chrome flags, e.g. `--start-maximized`. |
| `BROWSER_MCP_CHROME_EXTENSION` | none | Unpacked extension folder to force-load with `--load-extension` (Chromium / Chrome for Testing). |
| `BROWSER_MCP_CHROME_CONNECT_TIMEOUT_MS` | `25000` | How long to wait for the extension after launching Chrome. |
| `BROWSER_MCP_EXTENSION_DIR` | `~/.config/browser-mcp/extension` | Where `install-extension` and the popup's **Update** button put the extension. |
| `BROWSER_MCP_UPDATE_CHECK` | on | `0`/`false`/`off` stops the server checking npm for a newer version. |
| `BROWSER_MCP_TOKEN` / `BROWSER_MCP_TOKEN_FILE` | `~/.config/browser-mcp/token` | The server's handshake token, or the file it's kept in. |

### Starting Chrome

If Chrome is closed when a browser tool is called, the server starts it with your normal profile, so the extension keeps its permissions. It waits up to 25 s for the extension to connect, then runs the tool. If Chrome is already running but the extension hasn't connected yet, it waits for the extension instead of opening another window.

### Auto-allow

Normally you have to click Allow when a session wants to take over a tab. In an unattended session (no display, or you're driving the agent remotely) nobody can click, so the request times out.

Set `BROWSER_MCP_AUTO_ALLOW=1` on a session you trust to drive the browser unattended. The extension then grants that session's requests without a prompt. It is opt-in and per session: every other session still asks.

> **Security:** the session declares this flag itself, so it's a convenience for *your own* trusted sessions, not a protection against hostile programs on your machine (which could set it too). The real protections don't change: the server only listens on `127.0.0.1`, and every server needs its own handshake token. Leave it off unless nobody can answer the prompt.

## Updates

**Extension:** release builds check GitHub for a newer release every few hours. When there is one, Chrome shows a notification and the popup shows a banner with **Update** and **Skip**. Nothing installs until you click **Update**. A running browser-mcp server then downloads the release into the extension folder and the extension reloads itself. Settings in the popup shows the current version and has a **Check for updates** button.

- Updates only take effect if Chrome loads the extension from `~/.config/browser-mcp/extension` (or `BROWSER_MCP_EXTENSION_DIR`). If you loaded it from somewhere else, the popup tells you where the update went.
- A release that needs a newer server is refused, with a message to update the server first.
- The zip is also attached to each [GitHub release](https://github.com/Wadjinny/browser-mcp/releases/latest), but a copy you unzip yourself can't be updated from the popup.

**Server:** with `npx -y tabmcp@latest`, every new agent session starts the newest version. With a global install (`npm i -g tabmcp`, then `"command": "tabmcp"`), update with the same command. The server checks npm every few hours, and the popup lists any outdated sessions.
