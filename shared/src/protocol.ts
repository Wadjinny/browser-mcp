import type { BridgeError } from "./errors.js";

/**
 * The hub: one local daemon on this port. The extension and every MCP server
 * connect to it; sessions are told apart by name, not by port.
 */
export const DEFAULT_HUB_PORT = 17373;
/** WebSocket paths on the hub. */
export const HUB_EXTENSION_PATH = "/extension";
export const HUB_AGENT_PATH = "/agent";

/** Max length of `BROWSER_MCP_NAME` after trim. */
export const INSTANCE_NAME_MAX_LEN = 40;

/**
 * Chrome tab-group colours, one per session number. The popup, the tab group,
 * the page border and the badge all use this list.
 */
export const SESSION_COLOR_PALETTE = [
  { name: "orange", hex: "#e8710a" },
  { name: "cyan", hex: "#12b5cb" },
  { name: "purple", hex: "#a142f4" },
  { name: "pink", hex: "#e52592" },
  { name: "green", hex: "#1e8e3e" },
  { name: "blue", hex: "#1a73e8" },
  { name: "yellow", hex: "#f9ab00" },
  { name: "red", hex: "#d93025" },
] as const;

export type SessionColorName = (typeof SESSION_COLOR_PALETTE)[number]["name"];

export function sessionColor(session: number): {
  name: SessionColorName;
  hex: string;
} {
  const n = SESSION_COLOR_PALETTE.length;
  return SESSION_COLOR_PALETTE[(((session - 1) % n) + n) % n]!;
}

/**
 * One connected MCP server, as the hub describes it. `id` is a small number
 * (lowest free) that picks the session colour; `name` is unique among live
 * sessions ("claude-code", "claude-code 2", ...).
 */
export type SessionInfo = {
  id: number;
  name: string;
  /** When the hub first created this session; resumed sessions keep it. */
  startedAt: number;
  pid: number;
  cwd: string;
  /**
   * From `BROWSER_MCP_AUTO_ALLOW`: the extension grants this session's tab
   * takeovers without asking. Opt-in, for unattended agents.
   */
  autoAllow: boolean;
  /** Server package version ("dev" from source). */
  version: string;
  /** Newer server version on npm, if this one is outdated. */
  latestVersion: string | null;
};

/** Parse a boolean-ish env value (`1/true/yes/on`). Default false. */
export function parseAutoAllow(raw?: string | null): boolean {
  if (raw == null) return false;
  return /^(1|true|yes|on)$/i.test(raw.trim());
}

export function parseInstanceName(raw?: string | null): string | null {
  const trimmed = raw?.trim() ?? "";
  if (!trimmed) return null;
  return trimmed.slice(0, INSTANCE_NAME_MAX_LEN);
}

/** Shape returned by GET /health on the hub. */
export type HubHealth = {
  ok: boolean;
  version: string;
  protocolVersion: number;
  extensionConnected: boolean;
  sessions: number;
};

export const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
export const PICK_ELEMENT_TIMEOUT_MS = 90_000;
/** How long a secure input window waits for the user to submit. */
export const SECURE_INPUT_TIMEOUT_MS = 120_000;
/** Max `waitForMs` for network.list; bridge timeout is waitForMs + slack. */
export const MAX_NETWORK_WAIT_FOR_MS = 300_000;
export const PROTOCOL_VERSION = 2;

/** GitHub repo whose releases carry the prebuilt extension zip. */
export const UPDATE_REPO = "Wadjinny/browser-mcp";

/**
 * Written to `build-info.json` in every extension build. `channel` is
 * "release" only for CI builds of a `v*` tag; local builds are "dev" and never
 * offer updates.
 */
export type ExtensionBuildInfo = {
  version: string;
  channel: "release" | "dev";
  protocolVersion: number;
};

/** `v1.2.3` / `1.2.3` -> `1.2.3`; null for anything Chrome can't use as a version. */
export function versionFromTag(tag: string): string | null {
  const v = tag.trim().replace(/^v/, "");
  return /^\d+(\.\d+){0,3}$/.test(v) ? v : null;
}

/** Compare dotted numeric versions: <0 if a<b, 0 if equal, >0 if a>b. */
export function compareVersions(a: string, b: string): number {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

/** Body of `POST /update` (extension -> hub). */
export type UpdateRequest = { tag: string };

/** Reply of `POST /update`. */
export type UpdateResponse =
  | { ok: true; version: string; dir: string }
  | { ok: false; error: string };

export type PinDescriptor = {
  id: string;
  tabId: number;
  url: string;
  tag: string;
  role: string;
  name: string;
  selector: string | null;
  box: { x: number; y: number; width: number; height: number };
  createdAt: number;
};

/** Copyable URI for a pin: `browser-mcp://tab/{tabId}/pin/{id}`. */
export function pinToUri(pin: Pick<PinDescriptor, "id" | "tabId">): string {
  return `browser-mcp://tab/${pin.tabId}/pin/${encodeURIComponent(pin.id)}`;
}

export type BridgeState = {
  extensionConnected: boolean;
  connectedTabId: number | null;
  connectedTabUrl: string | null;
  connectedTabTitle: string | null;
  debuggerAttached: boolean;
};

export type TabInfo = {
  id: number;
  url: string;
  title: string;
  active: boolean;
  windowId: number;
  /** Set when another MCP session owns this tab ("name :port"). */
  connectedBy?: string;
};

export type ConsoleMessage = {
  level: string;
  text: string;
  url?: string;
  lineNumber?: number;
  timestamp: number;
};

export type NetworkInitiator = {
  type: string;
  url?: string;
  lineNumber?: number;
  columnNumber?: number;
  requestId?: string;
};

export type WebSocketMessageEntry = {
  opcode: number;
  data: string;
  direction: "sent" | "received";
  timestamp: number;
};

export type NetworkEntry = {
  id: string;
  url: string;
  method: string;
  status?: number;
  mimeType?: string;
  /** CDP resource type (Document, XHR, Fetch, WebSocket, Script, …). */
  type?: string;
  timestamp: number;
  requestHeaders?: Record<string, string>;
  responseHeaders?: Record<string, string>;
  /** Request body when present (truncated in list views). */
  postData?: string;
  initiator?: NetworkInitiator;
  fromCache?: boolean;
  serviceWorkerResponseSource?: string;
  encodedDataLength?: number;
  protocol?: string;
  remoteIPAddress?: string;
  /** CDP target id when the request came from an attached worker/iframe target. */
  targetId?: string;
  /** page | worker | shared_worker | service_worker | iframe | other */
  targetType?: string;
  resourceKind?: "http" | "websocket";
  webSocketMessages?: WebSocketMessageEntry[];
  errorText?: string;
  finished?: boolean;
};

/** Filters for `network.list` / `network.wait` (all fields optional, AND-combined). */
export type NetworkListFilter = {
  /** Substring match on URL (case-insensitive). Legacy alias of `url`. */
  filter?: string;
  url?: string;
  urlRegex?: string;
  method?: string;
  host?: string;
  type?: string;
  status?: number;
  statusMin?: number;
  statusMax?: number;
  /** Only entries with timestamp >= since (ms epoch). */
  since?: number;
  resourceKind?: "http" | "websocket";
  targetType?: string;
  limit?: number;
  /** Include buffered WebSocket frame payloads (can be large). */
  includeWebSocketMessages?: boolean;
  /** Block until a matching request appears or timeout (ms). */
  waitForMs?: number;
};

export type PinInspectResult = {
  id: string;
  tag: string;
  role: string;
  name: string;
  selector: string | null;
  attrs: Record<string, string>;
  text: string;
  nearbyText: string;
  outerHTML: string;
  src: string | null;
  currentSrc: string | null;
  href: string | null;
  backgroundImage: string | null;
  ariaLabel: string | null;
  title: string | null;
  box: { x: number; y: number; width: number; height: number };
  /** How many nodes match the stored selector right now. */
  matchCount: number;
  /** URLs extracted from the element (src, href, css background, …). */
  relatedUrls: string[];
};

export type RpcMethod =
  | "ping"
  | "state.get"
  | "tabs.connect"
  | "tabs.disconnect"
  | "tabs.list"
  | "tabs.open"
  | "tabs.navigate"
  | "tabs.goBack"
  | "tabs.goForward"
  | "tabs.wait"
  | "page.snapshot"
  | "page.find"
  | "page.click"
  | "page.hover"
  | "page.drag"
  | "page.type"
  | "page.typeSecure"
  | "page.pressKey"
  | "page.screenshot"
  | "page.evaluate"
  | "page.pickElement"
  | "page.pickCancel"
  | "pins.list"
  | "pins.clear"
  | "pins.inspect"
  | "debugger.attach"
  | "debugger.detach"
  | "debugger.sendCommand"
  | "debugger.targets"
  | "console.list"
  | "console.clear"
  | "network.list"
  | "network.get"
  | "network.getResponseBody"
  | "network.forPin"
  | "network.summary"
  | "storage.getCookies"
  | "storage.setCookie"
  | "storage.clearCookies"
  | "storage.getLocal"
  | "storage.setLocal"
  | "storage.clearLocal"
  | "storage.getSession"
  | "storage.setSession"
  | "storage.clearSession"
  | "dom.getBoxModel"
  | "dom.getComputedStyle"
  | "control.request"
  | "control.release"
  | "control.status";

/** How long the extension waits for Allow/Deny on a tab takeover. */
export const CONSENT_TIMEOUT_MS = 60_000;

/**
 * hub -> extension: a request from one session. Agents send the same shape
 * without `session`; the hub fills it in.
 */
export type RequestMessage = {
  type: "request";
  id: string;
  session?: number;
  method: RpcMethod | string;
  params?: Record<string, unknown>;
};

export type ResponseMessage = {
  type: "response";
  id: string;
  ok: boolean;
  result?: unknown;
  error?: BridgeError;
};

export type EventName =
  | "state.changed"
  | "console.message"
  | "network.request"
  | "network.response"
  | "debugger.detached";

/**
 * extension -> hub: `session` targets one session (tab-scoped data must not
 * leak); without it the event goes to every session. hub -> agent: no session.
 */
export type EventMessage = {
  type: "event";
  session?: number;
  event: EventName | string;
  payload?: unknown;
};

/** extension -> hub, first message. */
export type ExtensionHello = {
  type: "hello";
  role: "extension";
  protocolVersion: number;
  extensionVersion: string;
};

/** agent -> hub, first message. */
export type AgentHello = {
  type: "hello";
  role: "agent";
  protocolVersion: number;
  token: string;
  /** Requested name; the hub adds " 2", " 3"... if it is taken. */
  name: string;
  /** Reclaim this session after a hub restart, if it is still free. */
  resume?: { id: number; startedAt: number; name: string } | null;
  pid: number;
  cwd: string;
  autoAllow: boolean;
  version: string;
  latestVersion: string | null;
};

/** hub -> agent: accepted. */
export type AgentWelcome = {
  type: "welcome";
  protocolVersion: number;
  hubVersion: string;
  /** When the hub started; a fresh hub may not have been found by the extension yet. */
  hubStartedAt: number;
  session: SessionInfo;
  extensionConnected: boolean;
  extensionMismatch: ExtensionMismatch | null;
};

/**
 * hub -> agent or extension: refused (bad token, incompatible protocol, another
 * extension already connected). STABLE ACROSS PROTOCOL VERSIONS: an extension
 * of any version must understand `reload`, so a hub can tell an extension of
 * the wrong version to load the matching files an agent just installed
 * (browser_update_extension).
 */
export type HubRefusal = {
  type: "refused";
  code: string;
  message: string;
  /** Extension only: newer files are on disk; reload to pick them up. */
  reload?: boolean;
};

/**
 * hub -> extension: reload now to pick up files installed on disk. Stable
 * across protocol versions, like `refused`.
 */
export type HubReload = { type: "reload" };

/** An extension the hub refused because its protocol doesn't match. */
export type ExtensionMismatch = {
  extensionVersion: string;
  protocolVersion: number;
};

/** hub -> agent: the extension connected, went away, or was refused. */
export type HubStatus = {
  type: "status";
  extensionConnected: boolean;
  extensionMismatch: ExtensionMismatch | null;
};

/** agent -> hub: identity fields that changed after hello. */
export type AgentMeta = { type: "meta"; latestVersion: string | null };

/**
 * agent -> hub: matching extension files were just installed on disk; make
 * the extension reload (now if connected, or on its next hello if refused).
 */
export type AgentReloadExtension = { type: "reloadExtension" };

/** hub -> extension: every live session, sent whenever the list changes. */
export type SessionsMessage = { type: "sessions"; sessions: SessionInfo[] };

export function emptyBridgeState(): BridgeState {
  return {
    extensionConnected: false,
    connectedTabId: null,
    connectedTabUrl: null,
    connectedTabTitle: null,
    debuggerAttached: false,
  };
}
