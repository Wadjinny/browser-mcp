# Using browser-mcp

How to work with browser-mcp once it's installed. For setup, see the [README](../README.md).

## How it connects

Each agent's MCP server (`tabmcp`) connects to a small local **hub** on `127.0.0.1:17373`, and the extension connects to the same hub. The first agent that uses the browser starts the hub in the background. The hub stops on its own a minute after the last agent leaves. Its log is `~/.config/browser-mcp/hub.log`.

Agents are told apart by name: `BROWSER_MCP_NAME` if set, otherwise the agent's own name (`claude-code`, `cursor`, ...). A second agent with the same name becomes `claude-code 2`. There is no limit on how many agents run at once.

## Connect a tab

An agent only works in its own tab:

- **New tab:** the agent opens a URL (`browser_open` / `browser_navigate`). No prompt.
- **A tab you already have open:** the agent takes it with `browser_connect_tab` (tab id from `browser_tabs` with `includeOthers`).
  - The first time an agent takes a tab on a site, Chrome asks. **Allow for this site** lets agents use that site's tabs without asking again.
  - Taking a tab another agent is using always asks.
- DevTools (network, console, debugger) on its own tab needs no prompt. Chrome shows its own "started debugging this browser" bar.

Restricted URLs (`chrome://`, extension pages, the Web Store) can't be opened or taken.

The **Stop** button on the tab's pill, or `browser_disconnect`, releases the tab and detaches the debugger.

## Several agents in parallel

- Each agent has at most one tab. `browser_open` / `browser_connect_tab` replace that agent's previous tab.
- Network and console buffers, pins and the element picker are per tab, and DevTools events go only to the agent that owns the tab.
- If an agent goes away, its tab is released after 60 s. If the hub restarts, agents reconnect and keep their tabs.
- `browser_request_control` / `browser_release_control` remain as legacy aliases (status / disconnect).

## The popup

The toolbar popup lists the agents controlling a tab right now, each with its colour and name. When the current tab is controlled, it also has **Pick element**. With no agent controlling a tab, it shows only the extension version. Update offers and other notices come as Chrome notifications.

## Controlled-tab indicator

Every connected tab is visibly marked, in a colour per session:

- It moves into a **🤖 `name`** tab group in that session's colour (tabs already in one of your own groups stay where they are) and leaves the group on disconnect.
- The page gets a matching border and a bottom pill, "`name` is controlling this tab", with **Stop** and collapse buttons. The border pulses while an agent command runs.
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

**Session**: `browser_connect_tab`, `browser_disconnect`, `browser_control_status`, `browser_update_extension` (legacy: `browser_request_control`, `browser_release_control`)

**Automation** (no debugger needed): `browser_tabs`, `browser_open`, `browser_navigate`, `browser_go_back` / `browser_go_forward`, `browser_wait`, `browser_snapshot`, `browser_click`, `browser_hover`, `browser_drag`, `browser_type`, `browser_type_secure`, `browser_press_key`, `browser_screenshot`, `browser_console_messages`, `browser_pick_element`, `browser_pick_cancel`, `browser_pins`, `browser_pin_inspect`, `browser_pin_clear`

**DevTools** (attaches the debugger on first use): `devtools_attach` / `devtools_detach`, `devtools_targets`, `devtools_network_requests` (rich filters, WebSocket frames, `waitForMs` up to 300 s), `devtools_network_summary`, `devtools_network_request`, `devtools_network_body`, `devtools_network_for_pin`, `devtools_console_messages`, `devtools_evaluate` (pin-bound `el`, falls back to the main world on CSP-locked pages), `devtools_get_box_model`, `devtools_get_computed_style`, `devtools_cookies`, `devtools_storage`, `devtools_cdp` (allowlisted domains, including read-mostly `Target.*`)

Attaching also covers the page's existing workers, so traffic from service and shared workers reaches the network buffer. New workers are attached automatically.

See [SPEC.md](../SPEC.md) for each tool's parameters.

## Configuration

All settings are environment variables on the MCP server, and all are optional.

| Variable | Default | What it does |
| --- | --- | --- |
| `BROWSER_MCP_NAME` | the agent's name | Name for this session in the popup, tab group and notifications, e.g. `claude-code`. Duplicates get a number. |
| `BROWSER_MCP_AUTO_ALLOW` | off | `1`/`true`/`yes`/`on` lets **this** session take tabs without any Allow/Deny prompt. See [Auto-allow](#auto-allow). |
| `BROWSER_MCP_PORT` | `17373` | Port of the hub. The extension always uses 17373, so only change it for testing. |
| `BROWSER_MCP_LAUNCH_CHROME` | on | `0`/`false`/`off` stops the server from starting Chrome itself. |
| `BROWSER_MCP_CHROME_BIN` | auto-detected | Browser executable, e.g. `/usr/bin/google-chrome`. |
| `BROWSER_MCP_CHROME_PROFILE` | Chrome's default | `--profile-directory` value, e.g. `Default` or `Profile 1`. |
| `BROWSER_MCP_CHROME_USER_DATA_DIR` | Chrome's default | `--user-data-dir`, for a separate Chrome profile folder. |
| `BROWSER_MCP_CHROME_ARGS` | none | Extra Chrome flags, e.g. `--start-maximized`. |
| `BROWSER_MCP_CHROME_EXTENSION` | none | Unpacked extension folder to force-load with `--load-extension` (Chromium / Chrome for Testing). |
| `BROWSER_MCP_CHROME_CONNECT_TIMEOUT_MS` | `25000` | How long to wait for the extension after launching Chrome. |
| `BROWSER_MCP_EXTENSION_DIR` | `~/.config/browser-mcp/extension` | Where `install-extension` and the **Update now** notification put the extension. |
| `BROWSER_MCP_UPDATE_CHECK` | on | `0`/`false`/`off` stops the server checking npm for a newer version. |
| `BROWSER_MCP_TOKEN` / `BROWSER_MCP_TOKEN_FILE` | `~/.config/browser-mcp/token` | The token agents use to join the hub, or the file it's kept in. |

### Starting Chrome

If Chrome is closed when a browser tool is called, the server starts it with your normal profile, so the extension keeps its permissions. It waits up to 25 s for the extension to connect, then runs the tool. If Chrome is already running but the extension hasn't connected yet, it waits for the extension instead of opening another window.

### Auto-allow

Normally Chrome asks you when an agent takes a tab on a new site, or a tab another agent is using. In an unattended session (no display, or you're driving the agent remotely) nobody can click, so the request times out.

Set `BROWSER_MCP_AUTO_ALLOW=1` on a session you trust to drive the browser unattended. The extension then grants that session's requests without a prompt. It is opt-in and per session: every other session still asks.

> **Security:** the session declares this flag itself, so it's a convenience for *your own* trusted sessions, not a protection against hostile programs on your machine (which could set it too). The real protections don't change: the hub only listens on `127.0.0.1`, agents need the token file, and only the extension can use the extension endpoint. Leave it off unless nobody can answer the prompt.

## Updates

**Extension:** release builds check GitHub for a newer release every few hours. When there is one, Chrome shows a notification with **Update now** and **Skip this version**. Nothing installs until you click **Update now**. The hub then downloads the release into the extension folder and the extension reloads itself. The hub only runs while an agent is connected, so updating needs one.

- Updates only take effect if Chrome loads the extension from `~/.config/browser-mcp/extension` (or `BROWSER_MCP_EXTENSION_DIR`). If you loaded it from somewhere else, a notification tells you where the update went.
- A release that needs a newer server is refused, with a message to update the server first.
- **Version mismatch:** if the extension and the server don't speak the same protocol, the hub refuses the extension and the popup's dot turns red. Browser tools then fail with `EXTENSION_VERSION_MISMATCH`, and the agent can call `browser_update_extension`: it installs the extension release with the server's own version and tells the extension to reload. A notification tells you when that happened.
- The zip is also attached to each [GitHub release](https://github.com/Wadjinny/browser-mcp/releases/latest), but a copy you unzip yourself can't be updated in place.

**Server:** with `npx -y tabmcp@latest`, every new agent session starts the newest version. With a global install (`npm i -g tabmcp`, then `"command": "tabmcp"`), update with the same command. The server checks npm every few hours, and a notification lists any outdated agents. A running hub keeps its version until it stops, a minute after the last agent leaves.
