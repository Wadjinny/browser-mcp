import { mkdir, readFile, rename, rm, stat, writeFile, cp } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, normalize, sep } from "node:path";
import { inflateRawSync } from "node:zlib";
import {
  PROTOCOL_VERSION,
  UPDATE_REPO,
  versionFromTag,
  type ExtensionBuildInfo,
} from "@browser-mcp/shared";

/** Refuse release zips bigger than this (the real one is well under 1 MB). */
const MAX_ZIP_BYTES = 50 * 1024 * 1024;
/** A lock older than this belongs to a crashed install. */
const STALE_LOCK_MS = 5 * 60_000;

/**
 * Folder the extension is loaded from (Load unpacked). Updates are written
 * here, so Chrome only picks them up if it loads browser-mcp from this folder.
 */
export function extensionInstallDir(): string {
  return (
    process.env.BROWSER_MCP_EXTENSION_DIR ??
    join(homedir(), ".config", "browser-mcp", "extension")
  );
}

function updateRepo(): string {
  return process.env.BROWSER_MCP_UPDATE_REPO ?? UPDATE_REPO;
}

type ZipEntry = { name: string; data: Buffer };

/** Minimal reader for the release zip (stored or deflated entries, no zip64). */
export function readZip(buf: Buffer): ZipEntry[] {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65_557); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error("Not a zip file.");
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const entries: ZipEntry[] = [];
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error("Corrupt zip directory.");
    const method = buf.readUInt16LE(p + 10);
    const compSize = buf.readUInt32LE(p + 20);
    const size = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.toString("utf8", p + 46, p + 46 + nameLen);
    p += 46 + nameLen + extraLen + commentLen;
    if (name.endsWith("/")) continue;

    if (buf.readUInt32LE(local) !== 0x04034b50) throw new Error("Corrupt zip entry.");
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const raw = buf.subarray(start, start + compSize);
    let data: Buffer;
    if (method === 0) data = Buffer.from(raw);
    else if (method === 8) data = inflateRawSync(raw);
    else throw new Error(`Unsupported zip compression (${method}) in ${name}.`);
    if (data.length !== size) throw new Error(`Size mismatch in ${name}.`);
    entries.push({ name, data });
  }
  return entries;
}

/** Reject absolute paths and `..` so a zip can't write outside the folder. */
function safeRelative(name: string): string {
  const rel = normalize(name.replace(/\\/g, "/"));
  if (rel.startsWith("/") || rel.startsWith("..") || /^[a-zA-Z]:/.test(rel) || rel.split(sep).includes("..")) {
    throw new Error(`Unsafe path in zip: ${name}`);
  }
  return rel;
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/** Version of the extension currently in the install folder, if any. */
export async function installedVersion(dir = extensionInstallDir()): Promise<string | null> {
  try {
    const manifest = JSON.parse(await readFile(join(dir, "manifest.json"), "utf8"));
    return typeof manifest.version === "string" ? manifest.version : null;
  } catch {
    return null;
  }
}

/** One install at a time across every running browser-mcp instance. */
async function withLock<T>(dir: string, fn: () => Promise<T>): Promise<T> {
  const lock = `${dir}.lock`;
  await mkdir(dirname(lock), { recursive: true });
  try {
    await mkdir(lock);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    const age = Date.now() - (await stat(lock)).mtimeMs;
    if (age < STALE_LOCK_MS) {
      throw new Error("Another browser-mcp instance is installing an update; try again in a moment.");
    }
    await rm(lock, { recursive: true, force: true });
    await mkdir(lock);
  }
  try {
    return await fn();
  } finally {
    await rm(lock, { recursive: true, force: true });
  }
}

type Release = {
  tag_name: string;
  assets: Array<{ name: string; browser_download_url: string; size: number }>;
};

async function fetchRelease(tag: string | null): Promise<Release> {
  const path = tag ? `tags/${encodeURIComponent(tag)}` : "latest";
  const res = await fetch(`https://api.github.com/repos/${updateRepo()}/releases/${path}`, {
    headers: { Accept: "application/vnd.github+json", "User-Agent": "browser-mcp" },
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`GitHub returned ${res.status} for release ${tag ?? "latest"}.`);
  return (await res.json()) as Release;
}

/**
 * Download the extension zip of release `tag` (latest when null), check that
 * it speaks this server's protocol, and swap it into the install folder.
 */
export async function installExtensionRelease(
  tag: string | null,
): Promise<{ version: string; dir: string }> {
  if (tag !== null && !versionFromTag(tag)) throw new Error(`Invalid release tag: ${tag}`);
  const dir = extensionInstallDir();
  const release = await fetchRelease(tag);
  const version = versionFromTag(release.tag_name);
  if (!version) throw new Error(`Release tag ${release.tag_name} is not a version.`);

  const asset = release.assets.find((a) => /extension.*\.zip$/i.test(a.name));
  if (!asset) throw new Error(`Release ${release.tag_name} has no extension zip.`);
  if (asset.size > MAX_ZIP_BYTES) throw new Error("Release zip is unexpectedly large.");

  const res = await fetch(asset.browser_download_url, {
    headers: { "User-Agent": "browser-mcp" },
    signal: AbortSignal.timeout(60_000),
  });
  if (!res.ok) throw new Error(`Download failed (${res.status}).`);
  const zip = Buffer.from(await res.arrayBuffer());
  if (zip.length > MAX_ZIP_BYTES) throw new Error("Release zip is unexpectedly large.");

  const entries = readZip(zip);
  const byName = new Map(entries.map((e) => [e.name, e.data]));
  const manifest = byName.get("manifest.json");
  const info = byName.get("build-info.json");
  if (!manifest || !info) {
    throw new Error(`Release ${release.tag_name} predates in-place updates; install it manually.`);
  }
  const build = JSON.parse(info.toString("utf8")) as ExtensionBuildInfo;
  if (build.protocolVersion !== PROTOCOL_VERSION) {
    throw new Error(
      `Release ${release.tag_name} needs protocol v${build.protocolVersion}, but this MCP server speaks v${PROTOCOL_VERSION}. ` +
        "Update the server first (restart your agent if it runs `npx -y tabmcp@latest`, or `npm i -g tabmcp`), then retry.",
    );
  }
  if (JSON.parse(manifest.toString("utf8")).version !== version) {
    throw new Error(`Release ${release.tag_name} zip has a mismatched manifest version.`);
  }

  await withLock(dir, async () => {
    const staging = `${dir}.new-${process.pid}`;
    const old = `${dir}.old-${process.pid}`;
    await rm(staging, { recursive: true, force: true });
    for (const entry of entries) {
      const target = join(staging, safeRelative(entry.name));
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, entry.data);
    }

    if (!(await exists(dir))) {
      await rename(staging, dir);
      return;
    }
    try {
      await rename(dir, old);
    } catch {
      // Windows can refuse to rename a folder Chrome has open: overwrite in place.
      await cp(staging, dir, { recursive: true, force: true });
      await rm(staging, { recursive: true, force: true });
      return;
    }
    try {
      await rename(staging, dir);
    } catch (err) {
      await rename(old, dir);
      throw err;
    }
    await rm(old, { recursive: true, force: true });
  });

  return { version, dir };
}
