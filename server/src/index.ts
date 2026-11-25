#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { parseInstanceName } from "@browser-mcp/shared";
import { createMcpServer } from "./mcp.js";
import { HubClient, setBridge } from "./hub-client.js";
import { runHub } from "./hub.js";
import { installExtensionRelease } from "./extension-install.js";
import { SERVER_VERSION, checkServerUpdate, latestServerVersion } from "./version.js";

/** Hard ceiling on graceful shutdown before we exit regardless. */
const SHUTDOWN_GRACE_MS = 3_000;
const UPDATE_CHECK_EVERY_MS = 6 * 60 * 60_000;

async function main(): Promise<void> {
  const mcp = createMcpServer();

  // Name shown in Chrome: BROWSER_MCP_NAME, else the agent's own client name
  // ("claude-code", "cursor", ...). The hub numbers duplicates.
  const client = new HubClient(
    () =>
      parseInstanceName(process.env.BROWSER_MCP_NAME) ??
      parseInstanceName(mcp.server.getClientVersion()?.name) ??
      "agent",
  );
  setBridge(client);

  const checkUpdate = (): void => {
    void checkServerUpdate().then(() => client.setLatestVersion(latestServerVersion()));
  };
  checkUpdate();
  setInterval(checkUpdate, UPDATE_CHECK_EVERY_MS).unref();

  await mcp.connect(new StdioServerTransport());

  let shuttingDown = false;
  /**
   * Exit when the client goes away, so the hub sees this session leave instead
   * of a process lingering (reparented to init) forever.
   */
  const shutdown = (reason: string): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.error(`[browser-mcp] Shutting down (${reason}).`);
    setTimeout(() => process.exit(0), SHUTDOWN_GRACE_MS).unref();
    client.close();
    setTimeout(() => process.exit(0), 100);
  };

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGHUP", () => shutdown("SIGHUP"));
  // The MCP client owns stdin. EOF means it is gone.
  process.stdin.on("end", () => shutdown("stdin closed"));
  process.stdin.on("close", () => shutdown("stdin closed"));
  process.on("disconnect", () => shutdown("parent disconnected"));
}

/** `tabmcp install-extension [tag]`: put a release where Chrome can load it. */
async function installExtensionCli(tag: string | null): Promise<void> {
  const { version, dir } = await installExtensionRelease(tag);
  console.log(`Installed browser-mcp extension ${version} into ${dir}`);
  console.log(
    "First time? In chrome://extensions enable Developer mode, click Load unpacked and pick that folder. " +
      "Later updates are offered by the extension and installed into the same folder.",
  );
}

const command = process.argv[2];
const fail = (err: unknown): void => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
};

if (command === "--version" || command === "-v") {
  console.log(SERVER_VERSION);
} else if (command === "install-extension") {
  installExtensionCli(process.argv[3] ?? null).catch(fail);
} else if (command === "hub") {
  runHub().catch(fail);
} else {
  main().catch((err) => {
    console.error("[browser-mcp] Fatal:", err);
    process.exit(1);
  });
}
