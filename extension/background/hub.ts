/**
 * The extension's single connection to the local hub (tabmcp), which relays
 * requests from every MCP session. Sessions are identified by the hub's
 * session number; names and colours come from the hub's session list.
 */
import {
  CONSENT_TIMEOUT_MS,
  DEFAULT_HUB_PORT,
  ErrorCodes,
  HUB_EXTENSION_PATH,
  PROTOCOL_VERSION,
  bridgeError,
  type BridgeError,
  type HubRefusal,
  type RequestMessage,
  type ResponseMessage,
  type SessionInfo,
  type SessionsMessage,
} from "@browser-mcp/shared";

type HubHooks = {
  onRequest: (msg: RequestMessage, session: number) => Promise<void>;
  /** The hub's session list changed (sessions joined, left or renamed). */
  onSessions: (sessions: SessionInfo[], previous: SessionInfo[]) => void;
  /** Connected (or reconnected) to the hub. */
  onConnected: () => void;
};

/** Injected by scripts/build.ts from BROWSER_MCP_HUB_PORT (test builds); null = default. */
declare const __BROWSER_MCP_HUB_PORT__: number | null | undefined;
const HUB_PORT =
  (typeof __BROWSER_MCP_HUB_PORT__ !== "undefined" && __BROWSER_MCP_HUB_PORT__) || DEFAULT_HUB_PORT;
export const HUB_URL = `http://127.0.0.1:${HUB_PORT}`;
const HUB_WS_URL = `ws://127.0.0.1:${HUB_PORT}${HUB_EXTENSION_PATH}`;
const PING_MS = 20_000;

let socket: WebSocket | null = null;
let welcomed = false;
let sessions: SessionInfo[] = [];
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let reconnectAttempt = 0;
/** Another browser's extension holds the hub, or the hub refused our version. */
let busyUntil = 0;
const BUSY_RETRY_MS = 15_000;
/** Retry a version refusal often enough to catch a reload request quickly. */
const MISMATCH_RETRY_MS = 5_000;
/** Why the hub refused us (version mismatch), for the popup. */
let mismatch: string | null = null;
/** Remembered across the reload so the new version can tell the user. */
export const HUB_RELOAD_KEY = "reloadedByHub";

export function hubMismatch(): string | null {
  return mismatch;
}

/** The hub says matching files are on disk: reload into them. */
function reloadForHub(): void {
  void chrome.storage.local
    .set({ [HUB_RELOAD_KEY]: chrome.runtime.getManifest().version })
    .finally(() => chrome.runtime.reload());
}
let pingTimer: ReturnType<typeof setInterval> | null = null;
let hooks: HubHooks | null = null;

export function setHubHooks(next: HubHooks): void {
  hooks = next;
}

// --- sessions ---

export function listSessions(): SessionInfo[] {
  return sessions;
}

export function sessionInfo(id: number | null | undefined): SessionInfo | null {
  if (id == null) return null;
  return sessions.find((s) => s.id === id) ?? null;
}

/** Session numbers the hub reports as connected right now. */
export function liveSessions(): number[] {
  return sessions.map((s) => s.id);
}

export function labelForSession(id: number): string {
  return sessionInfo(id)?.name ?? `agent ${id}`;
}

/**
 * Whether a session set `BROWSER_MCP_AUTO_ALLOW`: its tab takeovers are
 * granted without a prompt (for unattended agents nobody can answer for).
 */
export function isSessionAutoAllowed(id: number): boolean {
  return sessionInfo(id)?.autoAllow === true;
}

export function hubConnected(): boolean {
  return welcomed && socket?.readyState === WebSocket.OPEN;
}

// --- consent notifications ---

type ConsentWaiter = {
  resolve: (answer: ConsentAnswer) => void;
  timer: ReturnType<typeof setTimeout>;
};
const CONSENT_PREFIX = "browser-mcp-consent-";
const consentWaiters = new Map<string, ConsentWaiter>();
let consentSeq = 0;

/** "timeout" = no answer in time, so the agent knows asking again may help. */
export type ConsentAnswer = "allowed" | "denied" | "timeout";

function settleConsent(id: string, answer: ConsentAnswer): void {
  const w = consentWaiters.get(id);
  if (!w) return;
  consentWaiters.delete(id);
  clearTimeout(w.timer);
  void chrome.notifications.clear(id);
  w.resolve(answer);
}

/**
 * Ask the user to Allow / Deny something via a Chrome notification.
 * Resolves "denied" on Deny or dismiss, "timeout" if nobody answers in time.
 */
export async function askUserConsent(
  title: string,
  message: string,
  allowLabel = "Allow",
): Promise<ConsentAnswer> {
  const id = `${CONSENT_PREFIX}${++consentSeq}-${Date.now()}`;
  try {
    await chrome.notifications.create(id, {
      type: "basic",
      iconUrl: chrome.runtime.getURL("icons/icon128.png"),
      title,
      message,
      buttons: [{ title: allowLabel }, { title: "Deny" }],
      requireInteraction: true,
      priority: 2,
    });
  } catch (err) {
    throw bridgeError(
      ErrorCodes.UNKNOWN,
      `Failed to show consent notification: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  return new Promise<ConsentAnswer>((resolve) => {
    consentWaiters.set(id, {
      resolve,
      timer: setTimeout(() => settleConsent(id, "timeout"), CONSENT_TIMEOUT_MS),
    });
  });
}

export function initHubListeners(): void {
  // Only the Allow button is consent; clicking the notification body is not.
  chrome.notifications.onButtonClicked.addListener((id, buttonIndex) => {
    if (id.startsWith(CONSENT_PREFIX)) {
      settleConsent(id, buttonIndex === 0 ? "allowed" : "denied");
    }
  });
  chrome.notifications.onClosed.addListener((id, byUser) => {
    if (id.startsWith(CONSENT_PREFIX) && byUser) settleConsent(id, "denied");
  });
}

// --- connection ---

/** Make sure we're connected or connecting. Safe to call often (keepalive alarm). */
export function startHub(): void {
  if (Date.now() < busyUntil) {
    scheduleReconnect();
    return;
  }
  if (
    socket &&
    (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)
  ) {
    return;
  }
  if (probing) return;
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  connect();
}

let probing = false;

/**
 * Probe /health over plain HTTP before opening the WebSocket: Chrome throttles
 * repeated failed WebSocket connections to the same address, which would delay
 * noticing a newly started hub by up to ~30 s.
 */
function connect(): void {
  if (probing) return;
  probing = true;
  fetch(`${HUB_URL}/health`, { signal: AbortSignal.timeout(1_500) })
    .then((res) => {
      probing = false;
      if (res.ok) openSocket();
      else scheduleReconnect();
    })
    .catch(() => {
      probing = false;
      mismatch = null; // no hub at all now
      scheduleReconnect();
    });
}

function openSocket(): void {
  const ws = new WebSocket(HUB_WS_URL);
  socket = ws;
  welcomed = false;

  ws.addEventListener("open", () => {
    ws.send(
      JSON.stringify({
        type: "hello",
        role: "extension",
        protocolVersion: PROTOCOL_VERSION,
        extensionVersion: chrome.runtime.getManifest().version,
      }),
    );
  });

  ws.addEventListener("message", (ev) => {
    let msg: { type?: string };
    try {
      msg = JSON.parse(String(ev.data));
    } catch {
      return;
    }
    if (msg.type === "welcome") {
      welcomed = true;
      mismatch = null;
      reconnectAttempt = 0;
      startPing();
      hooks?.onConnected();
      return;
    }
    // `refused` and `reload` are stable across protocol versions (see HubRefusal).
    if (msg.type === "reload") {
      reloadForHub();
      return;
    }
    if (msg.type === "refused") {
      const refusal = msg as HubRefusal;
      if (refusal.reload) {
        reloadForHub();
        return;
      }
      console.warn(`[browser-mcp] Hub refused the extension: ${refusal.message}`);
      if (refusal.code === "EXTENSION_BUSY") busyUntil = Date.now() + BUSY_RETRY_MS;
      if (refusal.code === "PROTOCOL_MISMATCH") {
        mismatch = refusal.message;
        busyUntil = Date.now() + MISMATCH_RETRY_MS;
      }
      return;
    }
    if (msg.type === "sessions") {
      const previous = sessions;
      sessions = (msg as SessionsMessage).sessions;
      hooks?.onSessions(sessions, previous);
      return;
    }
    if (msg.type === "request") {
      const req = msg as RequestMessage;
      if (req.session == null) return;
      void hooks?.onRequest(req, req.session);
    }
  });

  ws.addEventListener("close", () => {
    if (socket !== ws) return;
    socket = null;
    welcomed = false;
    // The hub is gone, and so is its session list.
    const previous = sessions;
    sessions = [];
    if (previous.length) hooks?.onSessions(sessions, previous);
    scheduleReconnect();
  });

  ws.addEventListener("error", () => {
    try {
      ws.close();
    } catch {
      // ignore
    }
  });
}

function scheduleReconnect(): void {
  if (reconnectTimer) return;
  reconnectAttempt++;
  // A failed attempt is a cheap local ECONNREFUSED, and a new hub should be
  // found quickly. (If Chrome suspends the worker, the keepalive alarm resumes.)
  const delay = Math.max(
    busyUntil - Date.now(),
    Math.min(2_000, 250 * 2 ** Math.max(0, reconnectAttempt - 1)),
  );
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    startHub();
  }, delay);
}

/** Keep the service worker (and the socket) alive while connected. */
function startPing(): void {
  if (pingTimer) return;
  pingTimer = setInterval(() => {
    if (!hubConnected()) {
      if (pingTimer) clearInterval(pingTimer);
      pingTimer = null;
      return;
    }
    socket!.send(JSON.stringify({ type: "event", event: "ping", payload: { t: Date.now() } }));
  }, PING_MS);
}

// --- sending ---

function send(msg: unknown): void {
  if (hubConnected()) socket!.send(JSON.stringify(msg));
}

/** Event for every session. */
export function emitEvent(event: string, payload: unknown): void {
  send({ type: "event", event, payload });
}

/** Event for one session only (tab-scoped data must not leak across sessions). */
export function emitEventToSession(session: number, event: string, payload: unknown): void {
  send({ type: "event", session, event, payload });
}

export function respond(id: string, ok: boolean, result?: unknown, error?: BridgeError): void {
  const msg: ResponseMessage = ok
    ? { type: "response", id, ok: true, result }
    : { type: "response", id, ok: false, error };
  send(msg);
}
