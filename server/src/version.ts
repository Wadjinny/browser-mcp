import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { compareVersions, versionFromTag } from "@browser-mcp/shared";

/** Injected by scripts/build.mjs; absent when running from source with tsx. */
declare const __SERVER_VERSION__: string | undefined;
declare const __SERVER_PACKAGE__: string | undefined;

export const SERVER_VERSION: string =
  typeof __SERVER_VERSION__ !== "undefined" ? __SERVER_VERSION__ : "dev";
export const SERVER_PACKAGE: string =
  typeof __SERVER_PACKAGE__ !== "undefined" ? __SERVER_PACKAGE__ : "tabmcp";

const CHECK_EVERY_MS = 6 * 60 * 60_000;

/** Newer version on npm, once known; null if up to date or unknown. */
let latestVersion: string | null = null;

export function latestServerVersion(): string | null {
  return latestVersion;
}

function cachePath(): string {
  return join(homedir(), ".config", "browser-mcp", "server-update.json");
}

/**
 * Look up the newest published server on npm (cached for 6 h across every
 * instance). Never updates anything: the result is shown to the user in the
 * extension popup and in the server log.
 */
export async function checkServerUpdate(): Promise<void> {
  if (SERVER_VERSION === "dev" || /^(0|false|off|no)$/i.test(process.env.BROWSER_MCP_UPDATE_CHECK ?? "")) {
    return;
  }
  let latest: string | null = null;
  try {
    const cached = JSON.parse(await readFile(cachePath(), "utf8")) as {
      checkedAt?: number;
      latest?: string;
    };
    if (cached.checkedAt && Date.now() - cached.checkedAt < CHECK_EVERY_MS) {
      latest = cached.latest ?? null;
    }
  } catch {
    // no cache yet
  }
  if (!latest) {
    try {
      const res = await fetch(
        `https://registry.npmjs.org/${SERVER_PACKAGE.replace("/", "%2f")}/latest`,
        { signal: AbortSignal.timeout(5_000) },
      );
      if (!res.ok) return;
      const body = (await res.json()) as { version?: string };
      latest = body.version ? versionFromTag(body.version) : null;
      if (!latest) return;
      await mkdir(dirname(cachePath()), { recursive: true });
      await writeFile(cachePath(), JSON.stringify({ checkedAt: Date.now(), latest }));
    } catch {
      return; // offline
    }
  }
  if (compareVersions(latest, SERVER_VERSION) > 0) {
    latestVersion = latest;
    console.error(
      `[browser-mcp] Server ${latest} is available (this is ${SERVER_VERSION}). ` +
        `Restart your agent if it runs "npx -y ${SERVER_PACKAGE}@latest", or run "npm i -g ${SERVER_PACKAGE}".`,
    );
  }
}
