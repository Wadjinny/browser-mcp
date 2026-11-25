/**
 * The MCP server's connection to the hub. Connects lazily on the first
 * browser tool call, starts the hub daemon if none is running, and keeps
 * (and after a hub restart, resumes) this agent's session.
 */
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, openSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { WebSocket } from "ws";
import {
  DEFAULT_REQUEST_TIMEOUT_MS,
  ErrorCodes,
  HUB_AGENT_PATH,
  PROTOCOL_VERSION,
  parseAutoAllow,
  type AgentHello,
  type AgentWelcome,
  type BridgeState,
  type EventMessage,
  type ExtensionMismatch,
  type HubRefusal,
  type HubStatus,
  type RequestMessage,
  type ResponseMessage,
  type SessionInfo,
} from "@browser-mcp/shared";
import { applyExtensionState, getBridgeState, markExtensionConnected } from "./state.js";
import { chromeLaunchDisabled, configuredBrowserBin, isBrowserRunning, launchBrowser } from "./chrome.js";
import { hubPort } from "./hub.js";
import { installExtensionRelease } from "./extension-install.js";
import { loadOrCreateToken } from "./token.js";
import { SERVER_VERSION } from "./version.js";

type Pending = {
  resolve: (value: unknown) => void;
  reject: (err: Error & { code?: string }) => void;
  timer: NodeJS.Timeout;
};

/** How long to wait for a freshly spawned hub to accept connections. */
const HUB_START_WAIT_MS = 5_000;
/** A just-woken extension service worker gets this long to dial the hub. */
const EXTENSION_WAIT_MS = 5_000;
/**
 * A sleeping extension service worker only wakes on its 30 s keepalive alarm,
 * so after a hub starts, give the extension this long to find it.
 */
const FRESH_HUB_WAIT_MS = 40_000;
const CHROME_START_WAIT_MS = (() => {
  const raw = Number(process.env.BROWSER_MCP_CHROME_CONNECT_TIMEOUT_MS);
  return Number.isFinite(raw) && raw >= 0 ? raw : 25_000;
})();
/** Do not block every tool call while Chrome is closed or the extension is off. */
const CONNECT_ATTEMPT_COOLDOWN_MS = 10_000;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function disconnectedError(message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code: ErrorCodes.EXTENSION_DISCONNECTED });
}

/** Start `tabmcp hub` as a detached daemon that outlives this process. */
function spawnHub(): void {
  const dir = join(homedir(), ".config", "browser-mcp");
  mkdirSync(dir, { recursive: true });
  const logFd = openSync(join(dir, "hub.log"), "a");
  // Re-run this same entry point (dist/index.js, or src/index.ts under tsx).
  const child = spawn(process.execPath, [...process.execArgv, process.argv[1]!, "hub"], {
    detached: true,
    stdio: ["ignore", logFd, logFd],
    windowsHide: true,
  });
  child.unref();
}

export class HubClient {
  private ws: WebSocket | null = null;
  private session: SessionInfo | null = null;
  private hubStartedAt = 0;
  private extensionMismatch: ExtensionMismatch | null = null;
  private extensionConnected = false;
  private connecting: Promise<void> | null = null;
  private refusal: string | null = null;
  private refusalCode: string | null = null;
  private pending = new Map<string, Pending>();
  private consoleBuffer: unknown[] = [];
  private networkBuffer: unknown[] = [];
  private latestVersion: string | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private lastChromeAttempt = 0;
  private chromeAttempt: Promise<void> | null = null;
  private closed = false;

  constructor(private readonly nameProvider: () => string) {}

  /** Newer server version on npm; forwarded so the extension can tell the user. */
  setLatestVersion(version: string | null): void {
    this.latestVersion = version;
    if (this.ws?.readyState === WebSocket.OPEN && this.session) {
      this.ws.send(JSON.stringify({ type: "meta", latestVersion: version }));
    }
  }

  close(): void {
    this.closed = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.ws?.close();
  }

  getState(): BridgeState {
    return getBridgeState();
  }

  getConsoleBuffer(): unknown[] {
    return [...this.consoleBuffer];
  }

  clearConsoleBuffer(): void {
    this.consoleBuffer = [];
  }

  getNetworkBuffer(): unknown[] {
    return [...this.networkBuffer];
  }

  async request(
    method: string,
    params: Record<string, unknown> = {},
    timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
  ): Promise<unknown> {
    await this.ensureHub();
    if (!this.extensionConnected && this.extensionMismatch) throw this.mismatchError();
    if (!this.extensionConnected) await this.ensureExtension();
    if (!this.extensionConnected && this.extensionMismatch) throw this.mismatchError();
    if (!this.extensionConnected) {
      throw disconnectedError(
        "Extension is not connected. Chrome was either not running (and could not be launched) or browser-mcp is not loaded/enabled in Chrome.",
      );
    }
    const ws = this.ws!;
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(Object.assign(new Error("Request timed out."), { code: ErrorCodes.TIMEOUT }));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      const msg: RequestMessage = { type: "request", id, method, params };
      ws.send(JSON.stringify(msg), (err) => {
        if (!err) return;
        const p = this.pending.get(id);
        if (!p) return;
        clearTimeout(p.timer);
        this.pending.delete(id);
        p.reject(disconnectedError(`Failed to send request: ${err.message}`));
      });
    });
  }

  private mismatchError(): Error & { code: string } {
    const m = this.extensionMismatch!;
    return Object.assign(
      new Error(
        `The browser-mcp extension ${m.extensionVersion} (protocol v${m.protocolVersion}) doesn't match this server, tabmcp ${SERVER_VERSION} (protocol v${PROTOCOL_VERSION}), so the hub refused it. ` +
          "Call browser_update_extension to install the matching extension, then retry.",
      ),
      { code: ErrorCodes.EXTENSION_VERSION_MISMATCH },
    );
  }

  /**
   * browser_update_extension: install the extension release that matches this
   * server (same tag), then have the hub make the extension reload into it.
   */
  async updateExtension(): Promise<{
    version: string;
    dir: string;
    connected: boolean;
    note: string;
  }> {
    if (SERVER_VERSION === "dev") {
      throw Object.assign(
        new Error("This server runs from source (no release version), so there is no matching extension release. Rebuild extension/dist and reload it in chrome://extensions."),
        { code: ErrorCodes.UNKNOWN },
      );
    }
    const { version, dir } = await installExtensionRelease(`v${SERVER_VERSION}`);
    await this.ensureHub();
    const wasConnected = this.extensionConnected;
    this.ws!.send(JSON.stringify({ type: "reloadExtension" }));
    if (wasConnected) {
      // Let the reload drop the old connection before waiting for the new one.
      const t = Date.now();
      while (this.extensionConnected && Date.now() - t < 3_000) await sleep(100);
    }
    // The refused extension retries every few seconds and reloads on the next try.
    const connected = await this.waitForExtension(30_000, true);
    return {
      version,
      dir,
      connected,
      note: connected
        ? `Installed extension ${version} and the extension reconnected.`
        : `Installed extension ${version} into ${dir}, but the extension hasn't reconnected yet. ` +
          (this.extensionMismatch
            ? "It is still the old version: Chrome probably loads browser-mcp from a different folder, or the extension is too old to reload itself. Ask the user to open chrome://extensions, remove browser-mcp and use Load unpacked on that folder (or click the reload button if it already points there)."
            : "Ask the user to check that browser-mcp is enabled in chrome://extensions and loaded from that folder."),
    };
  }

  // --- hub connection ---

  private isOpen(): boolean {
    return this.ws?.readyState === WebSocket.OPEN && this.session != null;
  }

  /** Connect (starting the hub if needed). Throws when the hub can't be reached. */
  private async ensureHub(): Promise<void> {
    if (this.isOpen()) return;
    this.connecting ??= this.connectWithSpawn().finally(() => {
      this.connecting = null;
    });
    await this.connecting;
    if (!this.isOpen()) {
      throw disconnectedError(
        this.refusal ??
          `Could not reach the browser-mcp hub on 127.0.0.1:${hubPort()}. If an agent still runs an older browser-mcp/tabmcp server, it holds that port: restart it. Details in ~/.config/browser-mcp/hub.log.`,
      );
    }
  }

  private async connectWithSpawn(): Promise<void> {
    if (await this.tryConnect()) return;
    // An older, idle hub steps aside for a newer protocol; give it a moment.
    if (this.refusalCode === "PROTOCOL_MISMATCH") await sleep(500);
    else if (this.refusal) return;
    spawnHub();
    const deadline = Date.now() + HUB_START_WAIT_MS;
    while (Date.now() < deadline && !this.closed) {
      await sleep(200);
      if (await this.tryConnect()) return;
      if (this.refusal) return;
    }
  }

  /** One attempt: open, say hello, wait for welcome. */
  private async tryConnect(): Promise<boolean> {
    this.refusal = null;
    this.refusalCode = null;
    const token = await loadOrCreateToken();
    return new Promise<boolean>((resolve) => {
      const ws = new WebSocket(`ws://127.0.0.1:${hubPort()}${HUB_AGENT_PATH}`);
      let settled = false;
      const done = (ok: boolean): void => {
        if (settled) return;
        settled = true;
        resolve(ok);
      };

      ws.on("open", () => {
        const hello: AgentHello = {
          type: "hello",
          role: "agent",
          protocolVersion: PROTOCOL_VERSION,
          token,
          name: this.nameProvider(),
          resume: this.session
            ? { id: this.session.id, startedAt: this.session.startedAt, name: this.session.name }
            : null,
          pid: process.pid,
          cwd: process.cwd(),
          autoAllow: parseAutoAllow(process.env.BROWSER_MCP_AUTO_ALLOW),
          version: SERVER_VERSION,
          latestVersion: this.latestVersion,
        };
        ws.send(JSON.stringify(hello));
      });

      ws.on("message", (data) => {
        let msg: { type?: string };
        try {
          msg = JSON.parse(data.toString());
        } catch {
          return;
        }
        if (msg.type === "welcome") {
          const w = msg as AgentWelcome;
          const resumed = this.session?.id === w.session.id;
          this.ws = ws;
          this.session = w.session;
          this.hubStartedAt = w.hubStartedAt;
          this.extensionMismatch = w.extensionMismatch ?? null;
          this.setExtensionConnected(w.extensionConnected);
          console.error(
            `[browser-mcp] Connected to the hub as "${w.session.name}" (session ${w.session.id}${resumed ? ", resumed" : ""}).`,
          );
          done(true);
          return;
        }
        if (msg.type === "refused") {
          this.refusal = (msg as HubRefusal).message;
          this.refusalCode = (msg as HubRefusal).code;
          console.error(`[browser-mcp] The hub refused this session: ${this.refusal}`);
          done(false);
          return;
        }
        this.onMessage(msg);
      });

      ws.on("close", () => {
        done(false);
        if (this.ws !== ws) return;
        this.ws = null;
        this.setExtensionConnected(false);
        for (const [id, p] of this.pending) {
          clearTimeout(p.timer);
          p.reject(disconnectedError("Lost the connection to the browser-mcp hub."));
          this.pending.delete(id);
        }
        // Keep this session alive: reconnect (and restart the hub) in the background.
        this.scheduleReconnect();
      });
      ws.on("error", () => done(false));
    });
  }

  private scheduleReconnect(attempt = 1): void {
    if (this.closed || this.reconnectTimer) return;
    const delay = Math.min(5_000, 250 * 2 ** (attempt - 1));
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this.isOpen() || this.connecting) return;
      this.connecting = this.connectWithSpawn().finally(() => {
        this.connecting = null;
        if (!this.isOpen()) this.scheduleReconnect(attempt + 1);
      });
    }, delay);
  }

  private setExtensionConnected(connected: boolean): void {
    this.extensionConnected = connected;
    markExtensionConnected(connected);
  }

  private onMessage(msg: { type?: string }): void {
    if (msg.type === "status") {
      const st = msg as HubStatus;
      this.extensionMismatch = st.extensionMismatch ?? null;
      this.setExtensionConnected(st.extensionConnected);
      return;
    }
    if (msg.type === "response") {
      const res = msg as ResponseMessage;
      const p = this.pending.get(res.id);
      if (!p) return;
      clearTimeout(p.timer);
      this.pending.delete(res.id);
      if (res.ok) p.resolve(res.result);
      else {
        p.reject(
          Object.assign(new Error(res.error?.message ?? "Request failed"), {
            code: res.error?.code ?? ErrorCodes.UNKNOWN,
          }),
        );
      }
      return;
    }
    if (msg.type === "event") this.onEvent(msg as EventMessage);
  }

  private onEvent(msg: EventMessage): void {
    if (msg.event === "state.changed" && msg.payload) {
      applyExtensionState(msg.payload as Partial<BridgeState>);
    } else if (msg.event === "console.message" && msg.payload) {
      this.consoleBuffer.push(msg.payload);
      if (this.consoleBuffer.length > 1000) this.consoleBuffer.splice(0, this.consoleBuffer.length - 1000);
    } else if ((msg.event === "network.request" || msg.event === "network.response") && msg.payload) {
      this.networkBuffer.push(msg.payload);
      if (this.networkBuffer.length > 1000) this.networkBuffer.splice(0, this.networkBuffer.length - 1000);
    } else if (msg.event === "debugger.detached") {
      applyExtensionState({ ...getBridgeState(), debuggerAttached: false });
    }
  }

  // --- Chrome / extension ---

  private async waitForExtension(ms: number, untilConnected = false): Promise<boolean> {
    const deadline = Date.now() + ms;
    while (!this.closed && Date.now() < deadline) {
      if (this.extensionConnected) return true;
      // A refused extension won't connect by waiting.
      if (this.extensionMismatch && !untilConnected) return false;
      await sleep(150);
    }
    return this.extensionConnected;
  }

  /**
   * Best effort to get the extension connected before failing a tool call:
   * wait for a reconnecting service worker, and if Chrome isn't running, launch
   * it (normal profile, so the installed extension keeps its permissions).
   */
  private ensureExtension(): Promise<void> {
    if (this.extensionConnected || this.closed) return Promise.resolve();
    if (this.chromeAttempt) return this.chromeAttempt;
    if (Date.now() - this.lastChromeAttempt < CONNECT_ATTEMPT_COOLDOWN_MS) return Promise.resolve();
    this.chromeAttempt = this.tryEnsureExtension().finally(() => {
      this.lastChromeAttempt = Date.now();
      this.chromeAttempt = null;
    });
    return this.chromeAttempt;
  }

  /** How long Chrome's extension may still need to notice the hub. */
  private extensionGraceMs(): number {
    const sinceHubStart = Date.now() - this.hubStartedAt;
    return Math.max(EXTENSION_WAIT_MS, FRESH_HUB_WAIT_MS - sinceHubStart);
  }

  private async tryEnsureExtension(): Promise<void> {
    if (await this.waitForExtension(1_500)) return;
    if (chromeLaunchDisabled()) {
      await this.waitForExtension(this.extensionGraceMs());
      return;
    }
    // Check only the browser we would launch: a running Edge/Brave must not
    // stop us opening the Chrome that actually holds the extension.
    if (await isBrowserRunning(configuredBrowserBin())) {
      if (Date.now() - this.hubStartedAt < FRESH_HUB_WAIT_MS) {
        console.error("[browser-mcp] Waiting for the Chrome extension to find the new hub…");
      }
      await this.waitForExtension(this.extensionGraceMs());
      return;
    }
    if (this.closed) return;
    console.error("[browser-mcp] Chrome is not running; launching it so the extension can connect…");
    const result = await launchBrowser();
    if (!result.launched) {
      console.error(
        `[browser-mcp] Could not launch Chrome: ${result.error ?? "unknown error"}. ` +
          "Set BROWSER_MCP_CHROME_BIN to the browser executable, or start Chrome manually.",
      );
      return;
    }
    console.error(`[browser-mcp] Launched Chrome (${result.command}); waiting for the extension…`);
    if (!(await this.waitForExtension(CHROME_START_WAIT_MS)) && !this.closed) {
      console.error(
        "[browser-mcp] Chrome started but the extension did not connect. Make sure browser-mcp is loaded in that profile (chrome://extensions).",
      );
    }
  }
}

let client: HubClient | null = null;

export function setBridge(next: HubClient): void {
  client = next;
}

/** The hub client the MCP tools talk through. */
export function getBridge(): HubClient {
  if (!client) throw new Error("Hub client not initialized");
  return client;
}
