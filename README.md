# browser-mcp

browser-mcp lets your AI agent use **your real Chrome**, with the logins, cookies and extensions you already have, instead of a fresh headless browser. **You stay in control.** An agent only works in a tab you connect or allow, every controlled tab is visibly marked with a coloured border and a **Stop** button, and passwords go through a secure window that the agent never sees. **Several agents can work at once.** Each session gets its own tab, colour and tab group, so they don't get in each other's way.

It has two parts: an MCP server (`tabmcp` on npm) and a Chrome extension.

## Install

You need Node.js 20+ and Chrome.

**1. Add the server to your agent.**

Claude Code:

```bash
claude mcp add browser-mcp -- npx -y tabmcp@latest
```

Cursor and other clients:

```json
{
  "mcpServers": {
    "browser-mcp": {
      "command": "npx",
      "args": ["-y", "tabmcp@latest"]
    }
  }
}
```

**2. Install the extension.**

```bash
npx -y tabmcp@latest install-extension
```

Then open `chrome://extensions`, turn on **Developer mode**, click **Load unpacked** and pick `~/.config/browser-mcp/extension`. Chrome warns that the extension can use the debugger. It only does so on tabs you connect, and only for a local MCP server.

That's it. Chrome doesn't need to be open: the server starts it with your normal profile when the agent first needs it.

## Try it

Ask your agent things like:

- "Open my GitHub notifications and summarise what needs my attention."
- "Log in to the staging site and check why the checkout page is slow." (It asks you to type the password in a secure window.)
- "Find the cheapest flight from Paris to Lisbon next Friday on the airline site I have open." (You allow it to take over that tab.)

## Updates

- **Server:** `npx -y tabmcp@latest` runs the newest version every time your agent starts.
- **Extension:** when a new release is out, Chrome shows a notification with **Update now**. Nothing installs until you click it.

## Configuration

Set these as environment variables on the MCP server (`env` in the JSON above). All are optional.

| Variable | Default | What it does |
| --- | --- | --- |
| `BROWSER_MCP_NAME` | the agent's name | Name for this session in the popup, tab group and prompts, e.g. `claude-code`. |
| `BROWSER_MCP_AUTO_ALLOW` | off | `1` lets this session take tabs without any Allow/Deny prompt, for unattended agents. Only use it for sessions you trust. |
| `BROWSER_MCP_LAUNCH_CHROME` | on | `0` stops the server from starting Chrome itself. |
| `BROWSER_MCP_CHROME_PROFILE` | Chrome's default | Profile to launch, e.g. `Profile 1`. |

See [all settings](https://github.com/Wadjinny/browser-mcp/blob/main/docs/usage.md#configuration).

## Security

- Everything stays on your machine. Agents and the extension meet in a small local hub on `127.0.0.1`, agents need a token to join, and nothing goes through a cloud relay.
- An agent can open new tabs freely, but only acts on its own tab. Taking one of your open tabs asks once per site; taking another agent's tab always asks.
- Secrets typed through the secure window go straight to the page and never enter the agent's context. The website still receives them as normal.

## Limitations

- An open DevTools window on the connected tab can block the debugger tools.
- Screenshots only work on the tab in front.
- Picking elements works in the top frame only, not inside iframes.

## More

- [Usage guide](https://github.com/Wadjinny/browser-mcp/blob/main/docs/usage.md): connecting tabs, parallel sessions, secure input, pins, the full tool list and all settings.
- [Contributing](https://github.com/Wadjinny/browser-mcp/blob/main/CONTRIBUTING.md): running from source, development and releasing.
- [SPEC.md](https://github.com/Wadjinny/browser-mcp/blob/main/SPEC.md): architecture and protocol.

## License

[MIT](https://github.com/Wadjinny/browser-mcp/blob/main/LICENSE)
