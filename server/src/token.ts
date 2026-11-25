import { randomBytes } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

function tokenPath(): string {
  return (
    process.env.BROWSER_MCP_TOKEN_FILE ??
    join(homedir(), ".config", "browser-mcp", "token")
  );
}

export async function loadOrCreateToken(): Promise<string> {
  if (process.env.BROWSER_MCP_TOKEN) {
    return process.env.BROWSER_MCP_TOKEN;
  }

  const path = tokenPath();
  try {
    const existing = (await readFile(path, "utf8")).trim();
    if (existing.length >= 16) {
      return existing;
    }
  } catch {
    // create below
  }

  const token = randomBytes(24).toString("base64url");
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, `${token}\n`, { mode: 0o600 });
  return token;
}

export function getTokenFilePath(): string {
  return tokenPath();
}
