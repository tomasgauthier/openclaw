import fs from "node:fs";
import path from "node:path";
import { isEncrypted, encrypt, decrypt, deriveKeyFromEnv } from "../security/encryption.js";

// ── S1: Lazy encryption key resolution ────────────────────────────────
let _encKeyResolved = false;
let _encKey: Buffer | null = null;

function getEncryptionKey(): Buffer | null {
  if (_encKeyResolved) {
    return _encKey;
  }
  _encKeyResolved = true;
  const envVal = process.env.OPENCLAW_ENCRYPTION_KEY?.trim();
  if (!envVal) {
    return null;
  }
  try {
    _encKey = deriveKeyFromEnv(envVal);
  } catch {
    _encKey = null;
  }
  return _encKey;
}

export function loadJsonFile(pathname: string): unknown {
  try {
    if (!fs.existsSync(pathname)) {
      return undefined;
    }
    const raw = fs.readFileSync(pathname, "utf8");
    const parsed = JSON.parse(raw) as unknown;

    // S1: Auto-decrypt if the file is encrypted
    const key = getEncryptionKey();
    if (key && isEncrypted(parsed)) {
      const decrypted = decrypt(parsed, key);
      return JSON.parse(decrypted) as unknown;
    }

    return parsed;
  } catch {
    return undefined;
  }
}

export function saveJsonFile(pathname: string, data: unknown) {
  const dir = path.dirname(pathname);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  const json = `${JSON.stringify(data, null, 2)}\n`;

  // S1: Encrypt sensitive JSON files if encryption key is set
  const key = getEncryptionKey();
  if (key) {
    const encrypted = encrypt(json, key);
    fs.writeFileSync(pathname, JSON.stringify(encrypted, null, 2), "utf8");
  } else {
    fs.writeFileSync(pathname, json, "utf8");
  }
  try {
    fs.chmodSync(pathname, 0o600);
  } catch {
    // chmodSync may fail on Windows
  }
}
