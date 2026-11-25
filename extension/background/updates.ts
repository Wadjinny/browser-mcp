import {
  UPDATE_REPO,
  compareVersions,
  versionFromTag,
  type UpdateResponse,
} from "@browser-mcp/shared";
import { connectedPorts, getTokenForPort } from "./hub.js";

/** Injected by scripts/build.ts: "release" for CI tag builds, else "dev". */
declare const __BROWSER_MCP_CHANNEL__: string | undefined;

const STORAGE_KEY = "update";
const NOTIFICATION_ID = "browser-mcp-update";
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
  /** Installed by the server and reloaded into; verified on next start. */
  applied?: { version: string; dir: string } | null;
  /** Shown until dismissed: the update landed in a folder Chrome isn't using. */
  warning?: string | null;
  error?: string | null;
};

export type UpdateStatus = {
  channel: "release" | "dev";
  current: string;
  /** Newer release the user has not skipped. */
  available: Release | null;
  checkedAt: number | null;
  installing: boolean;
  warning: string | null;
  error: string | null;
};

let installing = false;

function channel(): "release" | "dev" {
  return typeof __BROWSER_MCP_CHANNEL__ !== "undefined" &&
    __BROWSER_MCP_CHANNEL__ === "release"
    ? "release"
    : "dev";
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
  return release && compareVersions(release.version, currentVersion()) > 0
    ? release
    : null;
}

export async function updateStatus(): Promise<UpdateStatus> {
  const s = await load();
  const latest = newer(s.latest);
  return {
    channel: channel(),
    current: currentVersion(),
    available: latest && latest.version !== s.skipped ? latest : null,
    checkedAt: s.checkedAt ?? null,
    installing,
    warning: s.warning ?? null,
    error: s.error ?? null,
  };
}

/**
 * Ask GitHub for the latest release. Release builds only: a dev build's
 * version says nothing about which release it matches.
 */
export async function checkForUpdates(force = false): Promise<UpdateStatus> {
  if (channel() !== "release") return updateStatus();
  const s = await load();
  if (!force && s.checkedAt && Date.now() - s.checkedAt < CHECK_EVERY_MS) {
    return updateStatus();
  }
  try {
    const res = await fetch(
      `https://api.github.com/repos/${UPDATE_REPO}/releases/latest`,
      { headers: { Accept: "application/vnd.github+json" } },
    );
    if (!res.ok) throw new Error(`GitHub returned ${res.status}`);
    const body = (await res.json()) as { tag_name?: string; html_url?: string };
    const version = body.tag_name ? versionFromTag(body.tag_name) : null;
    const latest: Release | null = version
      ? { version, tag: body.tag_name!, url: body.html_url ?? "" }
      : null;
    // A manual check means "show me again", even for a skipped version.
    const next = await save({
      latest,
      checkedAt: Date.now(),
      ...(force ? { skipped: null } : {}),
    });
    const offer = newer(latest);
    if (offer && offer.version !== next.skipped && offer.version !== next.notified) {
      await save({ notified: offer.version });
      notify(offer);
    }
  } catch {
    // Offline or rate-limited: try again on the next alarm.
    await save({ checkedAt: Date.now() });
  }
  return updateStatus();
}

function notify(release: Release): void {
  chrome.notifications.create(NOTIFICATION_ID, {
    type: "basic",
    iconUrl: chrome.runtime.getURL("icons/icon128.png"),
    title: `browser-mcp ${release.version} is available`,
    message: `You have ${currentVersion()}. Update now, or later from the extension popup.`,
    buttons: [{ title: "Update now" }, { title: "Skip this version" }],
    priority: 0,
  });
}

export async function skipUpdate(): Promise<UpdateStatus> {
  const latest = newer((await load()).latest);
  if (latest) await save({ skipped: latest.version });
  chrome.notifications.clear(NOTIFICATION_ID);
  return updateStatus();
}

export async function dismissUpdateMessages(): Promise<UpdateStatus> {
  await save({ warning: null, error: null });
  return updateStatus();
}

/**
 * The user chose to update. The extension can't write its own files, so a
 * connected MCP server downloads the release into the extension folder; then
 * we reload so Chrome picks the new files up.
 */
export async function installUpdate(): Promise<UpdateStatus> {
  const latest = newer((await load()).latest);
  if (!latest || installing) return updateStatus();
  chrome.notifications.clear(NOTIFICATION_ID);

  const ports = connectedPorts();
  if (ports.length === 0) {
    await save({
      error:
        "Updating needs a running browser-mcp server. Start an agent session that uses browser-mcp, then click Update again.",
    });
    return updateStatus();
  }

  installing = true;
  await save({ error: null });
  let lastError = "";
  try {
    for (const port of ports) {
      const token = await getTokenForPort(port);
      if (!token) continue;
      let reply: UpdateResponse;
      try {
        const res = await fetch(`http://127.0.0.1:${port}/update`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ token, tag: latest.tag }),
        });
        if (res.status === 404) {
          lastError =
            "The running browser-mcp server is too old to install updates. Update it (npm i -g tabmcp, or use npx -y tabmcp@latest) and restart your agent.";
          continue;
        }
        reply = (await res.json()) as UpdateResponse;
      } catch (err) {
        lastError = err instanceof Error ? err.message : String(err);
        continue;
      }
      if (!reply.ok) {
        // The server reached GitHub and refused (protocol mismatch, bad zip…):
        // another server would say the same.
        lastError = reply.error;
        break;
      }
      await save({ applied: { version: reply.version, dir: reply.dir }, error: null, warning: null });
      setTimeout(() => chrome.runtime.reload(), 300);
      return updateStatus();
    }
    await save({ error: `Update failed: ${lastError || "no server accepted the request."}` });
  } finally {
    installing = false;
  }
  return updateStatus();
}

/**
 * After the reload, check that Chrome is running the version the server
 * installed. If not, the extension is loaded from another folder.
 */
export async function verifyAppliedUpdate(): Promise<void> {
  const s = await load();
  if (!s.applied) return;
  if (compareVersions(currentVersion(), s.applied.version) >= 0) {
    await save({ applied: null, warning: null });
    return;
  }
  await save({
    applied: null,
    warning:
      `Version ${s.applied.version} was installed into ${s.applied.dir}, but Chrome loads browser-mcp from a different folder. ` +
      "In chrome://extensions remove this copy, then Load unpacked that folder. Later updates then apply in place.",
  });
}

export function initUpdateListeners(): void {
  chrome.notifications.onButtonClicked.addListener((id, buttonIndex) => {
    if (id !== NOTIFICATION_ID) return;
    void (buttonIndex === 0 ? installUpdate() : skipUpdate());
  });
}
