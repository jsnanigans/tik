import { runCommand } from "./util";

export type Credentials = { email: string; token: string };

function getCacheFilePath(): string {
  return `/tmp/tik-creds-${process.getuid?.() ?? 0}`;
}

async function loadCredentialsFromCache(): Promise<Credentials | null> {
  try {
    const content = await Bun.file(getCacheFilePath()).text();
    const [email, token] = content.trim().split("\n");
    if (email && token) return { email, token };
  } catch {}
  return null;
}

async function saveCredentialsToCache(creds: Credentials): Promise<void> {
  try {
    await Bun.write(getCacheFilePath(), `${creds.email}\n${creds.token}`, {
      mode: 0o600,
    });
  } catch {}
}

async function clearCredentialsCache(): Promise<void> {
  try {
    const { unlink } = await import("fs/promises");
    await unlink(getCacheFilePath());
  } catch {}
}

async function loadCredentialsFromOp(): Promise<Credentials> {
  const email = await runCommand(["op", "item", "get", "atlassian api token", "--fields", "username"]);
  const token = await runCommand(["op", "item", "get", "atlassian api token", "--fields", "token"]);
  if (!email || !token) throw new Error("Credentials not found");
  return { email, token };
}

export async function loadCredentials(refresh: boolean): Promise<Credentials> {
  if (!refresh) {
    const cached = await loadCredentialsFromCache();
    if (cached) return cached;
  } else {
    await clearCredentialsCache();
  }

  const creds = await loadCredentialsFromOp();
  await saveCredentialsToCache(creds);
  return creds;
}

export function makeAuthHeader(creds: Credentials): string {
  const encoded = Buffer.from(`${creds.email}:${creds.token}`).toString("base64");
  return `Basic ${encoded}`;
}
