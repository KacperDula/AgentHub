import fs from "node:fs";

/** The part of Electron's safeStorage used here, so this module stays testable outside Electron. */
export interface Crypter {
  isAsyncEncryptionAvailable(): Promise<boolean>;
  encryptStringAsync(s: string): Promise<Buffer>;
  decryptStringAsync(b: Buffer): Promise<{ result: string; shouldReEncrypt: boolean }>;
}

/**
 * API keys and the remote-access token, encrypted with the OS keychain (Electron safeStorage) in their own
 * file. Never in SQLite, never in logs or error messages. Decrypted once at start into memory.
 */
export async function createSecrets(file: string, crypter: Crypter) {
  const cache: Record<string, string> = {};
  let raw: Record<string, string> = {};
  try {
    raw = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    /* no secrets yet */
  }
  let reEncrypt = false;
  for (const [k, v] of Object.entries(raw)) {
    try {
      const r = await crypter.decryptStringAsync(Buffer.from(v, "base64"));
      cache[k] = r.result;
      reEncrypt ||= r.shouldReEncrypt;
    } catch {
      /* unreadable (other machine / keychain reset): drop it */
    }
  }
  const write = async () => {
    if (!(await crypter.isAsyncEncryptionAvailable()))
      throw new Error("The OS keychain is not available, so the secret was not saved.");
    const enc: Record<string, string> = {};
    for (const [k, v] of Object.entries(cache)) enc[k] = (await crypter.encryptStringAsync(v)).toString("base64");
    fs.writeFileSync(file, JSON.stringify(enc), { mode: 0o600 });
  };
  if (reEncrypt) await write().catch(() => {});
  return {
    get: (key: string): string | null => cache[key] ?? null,
    async set(key: string, value: string | null) {
      if (value) cache[key] = value;
      else delete cache[key];
      await write();
    },
    available: () => crypter.isAsyncEncryptionAvailable(),
  };
}

export type Secrets = Awaited<ReturnType<typeof createSecrets>>;
