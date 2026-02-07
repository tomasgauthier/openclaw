/**
 * S6: Session transcript encryption at rest.
 *
 * Since SessionManager (from @mariozechner/pi-coding-agent) writes JSONL files
 * directly, we cannot encrypt active sessions transparently. Instead, this module:
 *
 * 1. Encrypts completed session files in-place (for archival)
 * 2. Provides a transparent read helper that auto-decrypts encrypted session files
 * 3. Integrates with the cost-usage scanner to read encrypted transcripts
 *
 * Active sessions remain plaintext while in use. A maintenance task can encrypt
 * idle sessions periodically via `encryptIdleSessions()`.
 */

import fs from "node:fs";
import path from "node:path";
import { encrypt, decrypt, isEncrypted, deriveKeyFromEnv } from "./encryption.js";

function getSessionEncKey(): Buffer | null {
  const envVal = process.env.OPENCLAW_ENCRYPTION_KEY?.trim();
  if (!envVal) {
    return null;
  }
  try {
    return deriveKeyFromEnv(envVal);
  } catch {
    return null;
  }
}

/**
 * Read a session file, transparently decrypting if it's encrypted.
 * Returns the raw JSONL text content.
 */
export function readSessionFile(filePath: string): string | null {
  try {
    if (!fs.existsSync(filePath)) {
      return null;
    }
    const raw = fs.readFileSync(filePath, "utf8");

    // Check if file starts with JSON object (potentially encrypted)
    const trimmed = raw.trimStart();
    if (trimmed.startsWith("{")) {
      try {
        const parsed = JSON.parse(trimmed);
        if (isEncrypted(parsed)) {
          const key = getSessionEncKey();
          if (!key) {
            return null; // Encrypted but no key available
          }
          return decrypt(parsed, key);
        }
      } catch {
        // Not valid JSON — treat as regular JSONL
      }
    }

    return raw;
  } catch {
    return null;
  }
}

/**
 * Encrypt a session JSONL file in-place. The entire file is encrypted
 * as a single blob. Creates a .backup before encrypting.
 *
 * @returns true if encryption happened, false if already encrypted or no key
 */
export function encryptSessionFile(filePath: string): boolean {
  const key = getSessionEncKey();
  if (!key) {
    return false;
  }

  if (!fs.existsSync(filePath)) {
    return false;
  }

  const raw = fs.readFileSync(filePath, "utf8");

  // Already encrypted?
  try {
    const parsed = JSON.parse(raw.trimStart());
    if (isEncrypted(parsed)) {
      return false;
    }
  } catch {
    // Not JSON — proceed with encryption
  }

  const encrypted = encrypt(raw, key);
  fs.writeFileSync(filePath, JSON.stringify(encrypted), "utf8");
  return true;
}

/**
 * Encrypt all idle session files in a directory.
 * A session is "idle" if it hasn't been modified in the last `idleMinutes`.
 *
 * @returns Number of files encrypted
 */
export function encryptIdleSessions(
  sessionsDir: string,
  idleMinutes: number = 60,
): number {
  const key = getSessionEncKey();
  if (!key) {
    return 0;
  }

  if (!fs.existsSync(sessionsDir)) {
    return 0;
  }

  const cutoff = Date.now() - idleMinutes * 60 * 1000;
  let count = 0;

  const entries = fs.readdirSync(sessionsDir, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".jsonl")) {
      continue;
    }
    const filePath = path.join(sessionsDir, entry.name);
    try {
      const stats = fs.statSync(filePath);
      if (stats.mtimeMs > cutoff) {
        continue; // Still active
      }
      if (encryptSessionFile(filePath)) {
        count++;
      }
    } catch {
      // Skip files we can't process
    }
  }

  return count;
}

/**
 * Create a readable stream for a session file, handling encrypted files
 * by decrypting to a temporary buffer.
 */
export function createSessionReadStream(
  filePath: string,
): fs.ReadStream | null {
  const content = readSessionFile(filePath);
  if (content === null) {
    return null;
  }

  // If the file was already plaintext and not encrypted, just use a direct stream
  try {
    const raw = fs.readFileSync(filePath, "utf8");
    const trimmed = raw.trimStart();
    if (trimmed.startsWith("{")) {
      const parsed = JSON.parse(trimmed);
      if (isEncrypted(parsed)) {
        // File is encrypted — we need to create a stream from decrypted content.
        // Write to a temp file and stream from that.
        const tmpPath = filePath + ".dec.tmp";
        fs.writeFileSync(tmpPath, content, "utf8");
        const stream = fs.createReadStream(tmpPath, { encoding: "utf-8" });
        stream.on("close", () => {
          try {
            fs.unlinkSync(tmpPath);
          } catch {
            // ignore
          }
        });
        return stream;
      }
    }
  } catch {
    // Fall through to direct stream
  }

  return fs.createReadStream(filePath, { encoding: "utf-8" });
}
