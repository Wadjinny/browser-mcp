/**
 * Update notices, all as Chrome notifications (the popup stays clean):
 *  - a newer extension release on GitHub: Update now / Skip this version;
 *  - a connected MCP server older than the latest on npm;
 *  - the result of an update (failed, or landed in a folder Chrome isn't using).
 * Nothing installs without the user clicking Update.
 */
import {
  UPDATE_REPO,
  compareVersions,
  versionFromTag,
  type SessionInfo,
  type UpdateResponse,
} from "@browser-mcp/shared";
import { HUB_RELOAD_KEY, HUB_URL, hubConnected } from "./hub.js";

/** Injected by scripts/build.ts: "release" for CI tag builds, else "dev". */
declare const __BROWSER_MCP_CHANNEL__: string | undefined;

const STORAGE_KEY = "update";
const UPDATE_NOTIFICATION = "browser-mcp-update";
const INFO_NOTIFICATION = "browser-mcp-update-info";
const SERVER_NOTIFICATION = "browser-mcp-server-outdated";
export const UPDATE_ALARM = "update-check";
const CHECK_EVERY_MS = 6 * 60 * 60_000;

type Release = { version: string; tag: string; url: string };

type StoredUpdate = {
  latest?: Release | null;
  checkedAt?: number;
  /** Version the user chose to skip. */
  skipped?: string | null;
  /** Version we already sent a notification for. */
  notified?: string | null;
  /** Installed by the hub and reloaded into; verified on next start. */
  applied?: { version: string; dir: string } | null;
  /** Server version we already told the user about. */
  serverNotified?: string | null;
};

let installing = false;

function isReleaseBuild(): boolean {
  return typeof __BROWSER_MCP_CHANNEL__ !== "undefined" && __BROWSER_MCP_CHANNEL__ === "release";
}

function currentVersion(): string {
  return chrome.runtime.getManifest().version;
}

async function load(): Promise<StoredUpdate> {
  const got = await chrome.storage.local.get(STORAGE_KEY);
  return (got[STORAGE_KEY] as StoredUpdate | undefined) ?? {};
}

async function save(patch: Partial<StoredUpdate>): Promise<StoredUpdate> {
  const next = { ...(await load()), ...patch };
  await chrome.storage.local.set({ [STORAGE_KEY]: next });
  return next;
}

function newer(release: Release | null | undefined): Release | null {
  return release && compareVersions(release.version, currentVersion()) > 0 ? release : null;
}

function info(title: string, message: string): void {
  chrome.notifications.create(INFO_NOTIFICATION, {
    type: "basic",
    iconUrl: chrome.runtime.getURL("icons/icon128.png"),
    title,
    message,
    priority: 0,
  });
}

/**
 * Ask GitHub for the latest release. Release builds only: a dev build's
 * version says nothing about which release it matches.
 */
export async function checkForUpdates(force = false): Promise<void> {
  if (!isReleaseBuild()) return;
  const s = await load();
  if (!force && s.checkedAt && Date.now() - s.checkedAt < CHECK_EVERY_MS) return;
  try {
    const res = await fetch(`https://api.github.com/repos/${UPDATE_REPO}/releases/latest`, {
      headers: { Accept: "application/vnd.github+json" },
    });
    if (!res.ok) throw new Error(`GitHub returned ${res.status}`);
    const body = (await res.json()) as { tag_name?: string; html_url?: string };
    const version = body.tag_name ? versionFromTag(body.tag_name) : null;
    const latest: Release | null = version
      ? { version, tag: body.tag_name!, url: body.html_url ?? "" }
      : null;
    const next = await save({ latest, checkedAt: Date.now() });
    const offer = newer(latest);
    if (offer && offer.version !== next.skipped && offer.version !== next.notified) {
      await save({ notified: offer.version });
      chrome.notifications.create(UPDATE_NOTIFICATION, {
        type: "basic",
        iconUrl: chrome.runtime.getURL("icons/icon128.png"),
        title: `browser-mcp ${offer.version} is available`,
        message: `You have ${currentVersion()}.`,
        buttons: [{ title: "Update now" }, { title: "Skip this version" }],
        requireInteraction: true,
        priority: 0,
      });
    }
  } catch {
    // Offline or rate-limited: try again on the next alarm.
    await save({ checkedAt: Date.now() });
  }
}

async function skipUpdate(): Promise<void> {
  const latest = newer((await load()).latest);
  if (latest) await save({ skipped: latest.version });
}

/**
 * The user chose to update. The extension can't write its own files, so the
 * hub downloads the release into the extension folder; then we reload so
 * Chrome picks the new files up.
 */
async function installUpdate(): Promise<void> {
  const latest = newer((await load()).latest);
  if (!latest || installing) return;
  if (!hubConnected()) {
    info(
      "browser-mcp update needs an agent",
      "Updating goes through the local browser-mcp hub, which runs while an agent is connected. Start an agent that uses browser-mcp; you'll be asked again on the next check.",
    );
    await save({ notified: null });
    return;
  }
  installing = true;
  try {
    let reply: UpdateResponse;
    try {
      const res = await fetch(`${HUB_URL}/update`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tag: latest.tag }),
      });
      reply = (await res.json()) as UpdateResponse;
    } catch (err) {
      reply = { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
    if (!reply.ok) {
      info("browser-mcp update failed", reply.error);
      return;
    }
    await save({ applied: { version: reply.version, dir: reply.dir } });
    setTimeout(() => chrome.runtime.reload(), 300);
  } finally {
    installing = false;
  }
}

/**
 * After the reload, check that Chrome is running the version the hub
 * installed. If not, the extension is loaded from another folder.
 */
export async function verifyAppliedUpdate(): Promise<void> {
  // An agent installed the extension matching its server, and the hub had us reload.
  const fromHub = (await chrome.storage.local.get(HUB_RELOAD_KEY))[HUB_RELOAD_KEY] as string | undefined;
  if (fromHub) {
    await chrome.storage.local.remove(HUB_RELOAD_KEY);
    if (fromHub !== currentVersion()) {
      info(
        `browser-mcp updated to ${currentVersion()}`,
        `An agent updated the extension from ${fromHub} to match its tabmcp server.`,
      );
    }
  }
  const s = await load();
  if (!s.applied) return;
  await save({ applied: null });
  if (compareVersions(currentVersion(), s.applied.version) >= 0) return;
  info(
    "browser-mcp update went to another folder",
    `Version ${s.applied.version} was installed into ${s.applied.dir}, but Chrome loads browser-mcp from somewhere else. ` +
      "In chrome://extensions remove this copy and Load unpacked that folder; later updates then apply in place.",
  );
}

/** Tell the user (once per version) when connected MCP servers are outdated. */
export function notifyOutdatedServers(sessions: SessionInfo[]): void {
  void (async () => {
    const outdated = sessions.filter(
      (s) => s.version !== "dev" && s.latestVersion && compareVersions(s.latestVersion, s.version) > 0,
    );
    if (outdated.length === 0) return;
    const latest = outdated[0]!.latestVersion!;
    if ((await load()).serverNotified === latest) return;
    await save({ serverNotified: latest });
    chrome.notifications.create(SERVER_NOTIFICATION, {
      type: "basic",
      iconUrl: chrome.runtime.getURL("icons/icon128.png"),
      title: `tabmcp ${latest} is available`,
      message:
        `Outdated: ${outdated.map((s) => `${s.name} (${s.version})`).join(", ")}. ` +
        "Restart the agent if it runs npx -y tabmcp@latest, or run npm i -g tabmcp.",
      priority: 0,
    });
  })();
}

export function initUpdateListeners(): void {
  chrome.notifications.onButtonClicked.addListener((id, buttonIndex) => {
    if (id !== UPDATE_NOTIFICATION) return;
    chrome.notifications.clear(UPDATE_NOTIFICATION);
    void (buttonIndex === 0 ? installUpdate() : skipUpdate());
  });
}
