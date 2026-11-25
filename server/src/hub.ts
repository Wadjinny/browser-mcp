/**
 * The hub: a small local daemon on one port (default 17373). The Chrome
 * extension and every MCP server (agent) connect to it, and it routes requests
 * from agents to the extension and events back. Sessions are told apart by a
 * hub-assigned number and a unique name, so there is no limit on how many
 * agents run at once.
 *
 * Started on demand by the first agent (`tabmcp hub`, detached) and exits on
 * its own once no agent has been connected for a minute.
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocketServer, WebSocket } from "ws";
import {
  DEFAULT_HUB_PORT,
  ErrorCodes,
  HUB_AGENT_PATH,
  HUB_EXTENSION_PATH,
  PROTOCOL_VERSION,
  bridgeError,
  type AgentHello,
  type AgentWelcome,
  type EventMessage,
  type ExtensionHello,
  type ExtensionMismatch,
  type HubHealth,
  type HubRefusal,
  type RequestMessage,
  type ResponseMessage,
  type SessionInfo,
  type UpdateRequest,
  type UpdateResponse,
} from "@browser-mcp/shared";
import { loadOrCreateToken } from "./token.js";
import { installExtensionRelease } from "./extension-install.js";
import { SERVER_VERSION } from "./version.js";

/** Exit after this long without any agent connected. */
const IDLE_EXIT_MS = 60_000;
/** An agent or extension must say hello this quickly after connecting. */
const HELLO_TIMEOUT_MS = 5_000;

export function hubPort(): number {
  return (
    Number(process.env.BROWSER_MCP_PORT) ||
    Number(process.env.BROWSER_MCP_WS_PORT) ||
    DEFAULT_HUB_PORT
  );
}

type Session = { info: SessionInfo; ws: WebSocket };

function log(message: string): void {
  console.error(`${new Date().toISOString()} [hub] ${message}`);
}

function send(ws: WebSocket | null, msg: unknown): void {
  if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}

/** Only the extension may use /extension and /update: web pages can't forge Origin. */
function isExtensionOrigin(req: IncomingMessage): boolean {
  return (req.headers.origin ?? "").startsWith("chrome-extension://");
}

function isLocalHost(req: IncomingMessage): boolean {
  const host = req.headers.host ?? "";
  return host.startsWith("127.0.0.1") || host.startsWith("localhost");
}

export async function runHub(): Promise<void> {
  const token = await loadOrCreateToken();
  const port = hubPort();

  let extension: WebSocket | null = null;
  const sessions = new Map<number, Session>();
  /** hub request id -> who asked. */
  const pending = new Map<string, { session: number; id: string }>();
  let idleTimer: NodeJS.Timeout | null = null;
  let requestSeq = 0;
  const startedAt = Date.now();
  /** Last extension refused for its protocol; cleared when a matching one connects. */
  let mismatch: ExtensionMismatch | null = null;
  /** An agent installed matching extension files: tell the extension to reload. */
  let reloadRequested = false;

  const sessionList = (): SessionInfo[] =>
    [...sessions.values()].map((s) => s.info).sort((a, b) => a.id - b.id);

  const pushSessions = (): void =>
    send(extension, { type: "sessions", sessions: sessionList() });

  const broadcastStatus = (): void => {
    const extensionConnected = extension?.readyState === WebSocket.OPEN;
    for (const s of sessions.values()) {
      send(s.ws, { type: "status", extensionConnected, extensionMismatch: mismatch });
    }
  };

  const scheduleIdleExit = (): void => {
    if (idleTimer || sessions.size > 0) return;
    idleTimer = setTimeout(() => {
      log("No agents connected for a minute; exiting.");
      shutdown(0);
    }, IDLE_EXIT_MS);
  };

  const cancelIdleExit = (): void => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = null;
  };

  const lowestFreeId = (): number => {
    let id = 1;
    while (sessions.has(id)) id++;
    return id;
  };

  const uniqueName = (wanted: string): string => {
    const taken = new Set([...sessions.values()].map((s) => s.info.name));
    if (!taken.has(wanted)) return wanted;
    let n = 2;
    while (taken.has(`${wanted} ${n}`)) n++;
    return `${wanted} ${n}`;
  };

  const failPending = (filter: (p: { session: number }) => boolean, message: string): void => {
    for (const [hubId, p] of pending) {
      if (!filter(p)) continue;
      pending.delete(hubId);
      const owner = sessions.get(p.session);
      send(owner?.ws ?? null, {
        type: "response",
        id: p.id,
        ok: false,
        error: bridgeError(ErrorCodes.EXTENSION_DISCONNECTED, message),
      } satisfies ResponseMessage);
    }
  };

  // --- extension ---

  const onExtension = (ws: WebSocket): void => {
    let helloed = false;
    const helloTimer = setTimeout(() => {
      if (!helloed) ws.close();
    }, HELLO_TIMEOUT_MS);

    ws.on("message", (data) => {
      let msg: { type?: string };
      try {
        msg = JSON.parse(data.toString());
      } catch {
        return;
      }
      if (!helloed) {
        if (msg.type !== "hello") return;
        const hello = msg as ExtensionHello;
        clearTimeout(helloTimer);
        if (hello.protocolVersion !== PROTOCOL_VERSION) {
          const reload = reloadRequested;
          // One reload per request: if the extension comes back unchanged, it is
          // loaded from another folder and reloading again won't help.
          reloadRequested = false;
          send(ws, {
            type: "refused",
            code: "PROTOCOL_MISMATCH",
            message: `The browser-mcp extension ${hello.extensionVersion} (protocol v${hello.protocolVersion}) doesn't match tabmcp ${SERVER_VERSION} (protocol v${PROTOCOL_VERSION}).`,
            ...(reload ? { reload: true } : {}),
          } satisfies HubRefusal);
          ws.close();
          const changed =
            mismatch?.extensionVersion !== hello.extensionVersion ||
            mismatch?.protocolVersion !== hello.protocolVersion;
          mismatch = { extensionVersion: hello.extensionVersion, protocolVersion: hello.protocolVersion };
          if (changed) {
            log(`Refused extension ${hello.extensionVersion}: protocol v${hello.protocolVersion}, hub speaks v${PROTOCOL_VERSION}.`);
            broadcastStatus();
          }
          if (reload) log("Told the refused extension to reload the newly installed files.");
          return;
        }
        // One extension at a time, first come first served: with two Chrome
        // profiles (or browsers) running the extension, replacing would make them
        // knock each other off forever and drop replies in flight.
        if (extension && extension !== ws && extension.readyState === WebSocket.OPEN) {
          send(ws, {
            type: "refused",
            code: "EXTENSION_BUSY",
            message: "Another browser's browser-mcp extension is already connected to this hub.",
          } satisfies HubRefusal);
          ws.close();
          return;
        }
        helloed = true;
        extension = ws;
        mismatch = null;
        reloadRequested = false;
        log(`Extension ${hello.extensionVersion} connected.`);
        send(ws, { type: "welcome", protocolVersion: PROTOCOL_VERSION, hubVersion: SERVER_VERSION });
        pushSessions();
        broadcastStatus();
        return;
      }
      if (msg.type === "response") {
        const res = msg as ResponseMessage;
        const p = pending.get(res.id);
        if (!p) return;
        pending.delete(res.id);
        send(sessions.get(p.session)?.ws ?? null, { ...res, id: p.id });
        return;
      }
      if (msg.type === "event") {
        const ev = msg as EventMessage;
        if (ev.event === "ping") return; // keepalive only
        const out = { type: "event", event: ev.event, payload: ev.payload };
        if (ev.session != null) {
          send(sessions.get(ev.session)?.ws ?? null, out);
        } else {
          for (const s of sessions.values()) send(s.ws, out);
        }
      }
    });

    ws.on("close", () => {
      clearTimeout(helloTimer);
      if (extension !== ws) return;
      extension = null;
      log("Extension disconnected.");
      failPending(() => true, "The browser-mcp extension disconnected.");
      broadcastStatus();
    });
    ws.on("error", () => ws.close());
  };

  // --- agents ---

  const onAgent = (ws: WebSocket): void => {
    let session: Session | null = null;
    const helloTimer = setTimeout(() => {
      if (!session) ws.close();
    }, HELLO_TIMEOUT_MS);

    const refuse = (code: string, message: string): void => {
      send(ws, { type: "refused", code, message } satisfies HubRefusal);
      ws.close();
    };

    ws.on("message", (data) => {
      let msg: { type?: string };
      try {
        msg = JSON.parse(data.toString());
      } catch {
        return;
      }

      if (!session) {
        if (msg.type !== "hello") return;
        const hello = msg as AgentHello;
        clearTimeout(helloTimer);
        if (hello.token !== token) {
          refuse("UNAUTHORIZED", "Handshake token mismatch.");
          return;
        }
        if (hello.protocolVersion !== PROTOCOL_VERSION) {
          refuse(
            "PROTOCOL_MISMATCH",
            `A browser-mcp hub from tabmcp ${SERVER_VERSION} (protocol v${PROTOCOL_VERSION}) is running; this server speaks v${hello.protocolVersion}. ` +
              "It exits once its other agents disconnect.",
          );
          // Nobody else depends on this hub: step aside so the newer agent can start its own.
          if (sessions.size === 0) setTimeout(() => shutdown(0), 100);
          return;
        }
        const resume = hello.resume;
        const canResume = resume != null && !sessions.has(resume.id);
        const info: SessionInfo = {
          id: canResume ? resume!.id : lowestFreeId(),
          name: uniqueName(canResume ? resume!.name : hello.name || "agent"),
          startedAt: canResume ? resume!.startedAt : Date.now(),
          pid: hello.pid,
          cwd: hello.cwd,
          autoAllow: hello.autoAllow === true,
          version: hello.version,
          latestVersion: hello.latestVersion ?? null,
        };
        session = { info, ws };
        sessions.set(info.id, session);
        cancelIdleExit();
        log(`Agent "${info.name}" connected as session ${info.id}${canResume ? " (resumed)" : ""}.`);
        send(ws, {
          type: "welcome",
          protocolVersion: PROTOCOL_VERSION,
          hubVersion: SERVER_VERSION,
          hubStartedAt: startedAt,
          session: info,
          extensionConnected: extension?.readyState === WebSocket.OPEN,
          extensionMismatch: mismatch,
        } satisfies AgentWelcome);
        pushSessions();
        return;
      }

      if (msg.type === "request") {
        const req = msg as RequestMessage;
        if (extension?.readyState !== WebSocket.OPEN) {
          send(ws, {
            type: "response",
            id: req.id,
            ok: false,
            error: bridgeError(
              ErrorCodes.EXTENSION_DISCONNECTED,
              "The browser-mcp extension is not connected.",
            ),
          } satisfies ResponseMessage);
          return;
        }
        const hubId = `${session.info.id}:${++requestSeq}`;
        pending.set(hubId, { session: session.info.id, id: req.id });
        send(extension, {
          type: "request",
          id: hubId,
          session: session.info.id,
          method: req.method,
          params: req.params,
        } satisfies RequestMessage);
        return;
      }

      if (msg.type === "reloadExtension") {
        if (extension?.readyState === WebSocket.OPEN) {
          log(`Agent "${session.info.name}" asked the extension to reload.`);
          send(extension, { type: "reload" });
        } else {
          reloadRequested = true;
          log(`Agent "${session.info.name}" installed extension files; reloading the extension on its next hello.`);
        }
        return;
      }

      if (msg.type === "meta") {
        const meta = msg as { latestVersion?: string | null };
        session.info = { ...session.info, latestVersion: meta.latestVersion ?? null };
        pushSessions();
      }
    });

    ws.on("close", () => {
      clearTimeout(helloTimer);
      if (!session || sessions.get(session.info.id) !== session) return;
      sessions.delete(session.info.id);
      // The extension's answers for this session have nowhere to go now.
      for (const [hubId, p] of pending) {
        if (p.session === session.info.id) pending.delete(hubId);
      }
      log(`Agent "${session.info.name}" (session ${session.info.id}) disconnected.`);
      pushSessions();
      scheduleIdleExit();
    });
    ws.on("error", () => ws.close());
  };

  // --- HTTP ---

  const handleHttp = (req: IncomingMessage, res: ServerResponse): void => {
    if (!isLocalHost(req)) {
      res.writeHead(403).end("Forbidden");
      return;
    }
    if (req.url === "/health" && req.method === "GET") {
      const body: HubHealth = {
        ok: true,
        version: SERVER_VERSION,
        protocolVersion: PROTOCOL_VERSION,
        extensionConnected: extension?.readyState === WebSocket.OPEN,
        sessions: sessions.size,
      };
      res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(body));
      return;
    }
    // The user clicked Update in the extension: install that release.
    if (req.url === "/update" && req.method === "POST" && isExtensionOrigin(req)) {
      void handleUpdate(req, res);
      return;
    }
    res.writeHead(404).end("Not found");
  };

  const handleUpdate = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const reply = (status: number, body: UpdateResponse): void => {
      res.writeHead(status, { "Content-Type": "application/json" }).end(JSON.stringify(body));
    };
    let body: Partial<UpdateRequest>;
    try {
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of req) {
        size += (chunk as Buffer).length;
        if (size > 4096) return reply(413, { ok: false, error: "Body too large" });
        chunks.push(chunk as Buffer);
      }
      body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
    } catch {
      return reply(400, { ok: false, error: "Invalid JSON body." });
    }
    if (typeof body.tag !== "string") return reply(400, { ok: false, error: "tag is required." });
    try {
      const result = await installExtensionRelease(body.tag);
      log(`Installed extension ${result.version} into ${result.dir}.`);
      reply(200, { ok: true, ...result });
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      log(`Extension update failed: ${error}`);
      reply(500, { ok: false, error });
    }
  };

  const httpServer = createServer(handleHttp);
  const wss = new WebSocketServer({ noServer: true });

  httpServer.on("upgrade", (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    const path = (req.url ?? "").split("?")[0];
    const allowed =
      isLocalHost(req) &&
      ((path === HUB_EXTENSION_PATH && isExtensionOrigin(req)) ||
        // Agents are Node processes: a browser page always sends an Origin.
        (path === HUB_AGENT_PATH && req.headers.origin == null));
    if (!allowed) {
      socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      if (path === HUB_EXTENSION_PATH) onExtension(ws);
      else onAgent(ws);
    });
  });

  let stopping = false;
  function shutdown(code: number): void {
    if (stopping) return;
    stopping = true;
    for (const s of sessions.values()) s.ws.close();
    extension?.close();
    wss.close();
    httpServer.close();
    setTimeout(() => process.exit(code), 200).unref();
  }

  await new Promise<void>((resolve, reject) => {
    httpServer.once("error", reject);
    httpServer.listen(port, "127.0.0.1", () => {
      httpServer.removeListener("error", reject);
      resolve();
    });
  }).catch((err: NodeJS.ErrnoException) => {
    // Another agent started a hub at the same moment: that one serves everyone.
    if (err.code === "EADDRINUSE") {
      log(
        `Port ${port} is already in use: another hub, or an older browser-mcp server that still runs on that port. ` +
          "Exiting. Restart agents that use an older browser-mcp/tabmcp version.",
      );
      process.exit(0);
    }
    throw err;
  });

  httpServer.on("error", (err) => log(`HTTP server error: ${err.message}`));
  log(`tabmcp ${SERVER_VERSION} hub listening on 127.0.0.1:${port} (pid ${process.pid}).`);
  scheduleIdleExit();

  process.on("SIGINT", () => shutdown(0));
  process.on("SIGTERM", () => shutdown(0));
  process.on("SIGHUP", () => shutdown(0));
}
