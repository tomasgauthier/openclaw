import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

/**
 * Encrypted data structure containing the encrypted content, IV, and authentication tag
 */
export interface EncryptedData {
  encrypted: string; // Base64-encoded encrypted data
  iv: string;        // Base64-encoded initialization vector
  tag: string;       // Base64-encoded authentication tag
  version: number;   // Format version for future compatibility
}

/**
 * Encrypts plaintext using AES-256-GCM
 *
 * @param plaintext - The data to encrypt
 * @param key - 32-byte encryption key (Buffer)
 * @returns Encrypted data with IV and authentication tag
 */
export function encrypt(plaintext: string, key: Buffer): EncryptedData {
  if (key.length !== 32) {
    throw new Error('Encryption key must be exactly 32 bytes for AES-256');
  }

  // Generate random 16-byte IV for this operation
  const iv = randomBytes(16);

  // Create cipher with AES-256-GCM
  const cipher = createCipheriv('aes-256-gcm', key, iv);

  // Encrypt the data
  const encrypted = Buffer.concat([
    cipher.update(plaintext, 'utf8'),
    cipher.final()
  ]);

  // Get authentication tag for integrity verification
  const tag = cipher.getAuthTag();

  return {
    encrypted: encrypted.toString('base64'),
    iv: iv.toString('base64'),
    tag: tag.toString('base64'),
    version: 1 // Format version for future compatibility
  };
}

/**
 * Decrypts data encrypted with AES-256-GCM
 *
 * @param encryptedData - The encrypted data object
 * @param key - 32-byte encryption key (Buffer)
 * @returns Decrypted plaintext
 * @throws Error if decryption fails or authentication fails
 */
export function decrypt(encryptedData: EncryptedData, key: Buffer): string {
  if (key.length !== 32) {
    throw new Error('Decryption key must be exactly 32 bytes for AES-256');
  }

  try {
    // Convert base64 strings back to buffers
    const encryptedBuffer = Buffer.from(encryptedData.encrypted, 'base64');
    const ivBuffer = Buffer.from(encryptedData.iv, 'base64');
    const tagBuffer = Buffer.from(encryptedData.tag, 'base64');

    // Create decipher with AES-256-GCM
    const decipher = createDecipheriv('aes-256-gcm', key, ivBuffer);

    // Set authentication tag for verification
    decipher.setAuthTag(tagBuffer);

    // Decrypt the data
    const decrypted = Buffer.concat([
      decipher.update(encryptedBuffer),
      decipher.final()
    ]);

    return decrypted.toString('utf8');
  } catch (error) {
    throw new Error(`Decryption failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
  }
}

/**
 * Derives a 32-byte encryption key from an environment variable
 *
 * @param envKey - Base64-encoded key from environment variable
 * @returns 32-byte Buffer suitable for AES-256
 * @throws Error if key is invalid or wrong length
 */
export function deriveKeyFromEnv(envKey: string): Buffer {
  try {
    const key = Buffer.from(envKey, 'base64');

    if (key.length !== 32) {
      throw new Error(`Key must be exactly 32 bytes, got ${key.length} bytes`);
    }

    return key;
  } catch (error) {
    throw new Error(`Invalid encryption key: ${error instanceof Error ? error.message : 'Unknown error'}`);
  }
}

/**
 * Generates a new random 32-byte encryption key
 *
 * @returns Base64-encoded 32-byte key suitable for environment variable
 */
export function generateEncryptionKey(): string {
  return randomBytes(32).toString('base64');
}

/**
 * Checks if data appears to be encrypted (has encrypted data structure)
 *
 * @param data - String or object to check
 * @returns true if data looks like EncryptedData structure
 */
export function isEncrypted(data: unknown): data is EncryptedData {
  if (typeof data !== 'object' || data === null) {
    return false;
  }

  const obj = data as Record<string, unknown>;
  return (
    typeof obj.encrypted === 'string' &&
    typeof obj.iv === 'string' &&
    typeof obj.tag === 'string' &&
    typeof obj.version === 'number'
  );
}
