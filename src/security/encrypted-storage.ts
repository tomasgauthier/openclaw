import * as fs from 'node:fs';
import * as path from 'node:path';
import { encrypt, decrypt, isEncrypted, deriveKeyFromEnv, type EncryptedData } from './encryption.js';

/**
 * Configuration for encrypted storage
 */
export interface EncryptedStorageConfig {
  /**
   * Encryption key (32 bytes). If not provided, storage operates in plaintext mode.
   */
  encryptionKey?: Buffer;

  /**
   * Whether to warn when reading plaintext files in encrypted mode
   */
  warnOnPlaintext?: boolean;

  /**
   * Logger function for warnings and info messages
   */
  logger?: (message: string) => void;
}

/**
 * Encrypted file storage wrapper that supports both encrypted and plaintext files
 *
 * BACKWARD COMPATIBLE:
 * - Reads both encrypted and plaintext files automatically
 * - Writes encrypted files only if encryption key is configured
 * - Falls back to plaintext if no encryption key provided
 */
export class EncryptedStorage {
  private readonly config: Required<EncryptedStorageConfig>;

  constructor(config: EncryptedStorageConfig = {}) {
    this.config = {
      encryptionKey: config.encryptionKey,
      warnOnPlaintext: config.warnOnPlaintext ?? true,
      logger: config.logger ?? ((msg) => console.warn(msg))
    };
  }

  /**
   * Read file content, automatically detecting if it's encrypted or plaintext
   *
   * @param filePath - Path to the file to read
   * @returns File content as string
   * @throws Error if file doesn't exist or decryption fails
   */
  readFile(filePath: string): string {
    if (!fs.existsSync(filePath)) {
      throw new Error(`File not found: ${filePath}`);
    }

    const fileContent = fs.readFileSync(filePath, 'utf8');

    try {
      // Try to parse as JSON to check if it's encrypted
      const parsed = JSON.parse(fileContent);

      if (isEncrypted(parsed)) {
        // File is encrypted - decrypt it
        if (!this.config.encryptionKey) {
          throw new Error(
            `File is encrypted but no encryption key provided. ` +
            `Set OPENCLAW_ENCRYPTION_KEY environment variable.`
          );
        }

        return decrypt(parsed, this.config.encryptionKey);
      } else {
        // File is plaintext JSON
        if (this.config.encryptionKey && this.config.warnOnPlaintext) {
          this.config.logger(
            `WARNING: Reading plaintext file "${path.basename(filePath)}" ` +
            `while encryption is enabled. Consider migrating with migrateFile().`
          );
        }
        return fileContent;
      }
    } catch (error) {
      // If JSON parsing fails, treat as plaintext
      if (this.config.encryptionKey && this.config.warnOnPlaintext) {
        this.config.logger(
          `WARNING: Reading plaintext file "${path.basename(filePath)}" ` +
          `while encryption is enabled.`
        );
      }
      return fileContent;
    }
  }

  /**
   * Write file content, encrypting if encryption key is configured
   *
   * @param filePath - Path to the file to write
   * @param content - Content to write
   */
  writeFile(filePath: string, content: string): void {
    // Ensure directory exists
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    if (this.config.encryptionKey) {
      // Encrypt and write as JSON
      const encrypted = encrypt(content, this.config.encryptionKey);
      fs.writeFileSync(filePath, JSON.stringify(encrypted, null, 2), 'utf8');
    } else {
      // Write as plaintext
      fs.writeFileSync(filePath, content, 'utf8');
    }
  }

  /**
   * Migrate an existing plaintext file to encrypted format
   *
   * @param filePath - Path to the plaintext file
   * @param backupSuffix - Suffix for backup file (default: '.backup')
   * @returns true if migration was needed and completed, false if already encrypted
   * @throws Error if encryption key not configured or migration fails
   */
  migrateFile(filePath: string, backupSuffix = '.backup'): boolean {
    if (!this.config.encryptionKey) {
      throw new Error('Cannot migrate without encryption key');
    }

    if (!fs.existsSync(filePath)) {
      throw new Error(`File not found: ${filePath}`);
    }

    const fileContent = fs.readFileSync(filePath, 'utf8');

    try {
      const parsed = JSON.parse(fileContent);
      if (isEncrypted(parsed)) {
        this.config.logger(`File "${path.basename(filePath)}" is already encrypted. Skipping migration.`);
        return false;
      }
    } catch {
      // Not JSON or not encrypted, proceed with migration
    }

    // Create backup
    const backupPath = filePath + backupSuffix;
    fs.copyFileSync(filePath, backupPath);
    this.config.logger(`Created backup: ${backupPath}`);

    // Encrypt and write
    const encrypted = encrypt(fileContent, this.config.encryptionKey);
    fs.writeFileSync(filePath, JSON.stringify(encrypted, null, 2), 'utf8');

    this.config.logger(`Migrated "${path.basename(filePath)}" to encrypted format`);
    return true;
  }

  /**
   * Check if a file exists and is encrypted
   *
   * @param filePath - Path to check
   * @returns true if file exists and is encrypted, false otherwise
   */
  isFileEncrypted(filePath: string): boolean {
    if (!fs.existsSync(filePath)) {
      return false;
    }

    try {
      const fileContent = fs.readFileSync(filePath, 'utf8');
      const parsed = JSON.parse(fileContent);
      return isEncrypted(parsed);
    } catch {
      return false;
    }
  }

  /**
   * Get information about encryption status
   *
   * @returns Encryption status information
   */
  getStatus(): { encryptionEnabled: boolean; keyConfigured: boolean } {
    return {
      encryptionEnabled: !!this.config.encryptionKey,
      keyConfigured: !!this.config.encryptionKey
    };
  }
}

/**
 * Create an EncryptedStorage instance from environment variable
 *
 * @param envVarName - Name of environment variable containing base64-encoded key
 * @param config - Additional configuration options
 * @returns EncryptedStorage instance
 */
export function createFromEnv(
  envVarName = 'OPENCLAW_ENCRYPTION_KEY',
  config: Omit<EncryptedStorageConfig, 'encryptionKey'> = {}
): EncryptedStorage {
  const envKey = process.env[envVarName];

  if (!envKey) {
    // No encryption key configured - operate in plaintext mode
    return new EncryptedStorage(config);
  }

  try {
    const encryptionKey = deriveKeyFromEnv(envKey);
    return new EncryptedStorage({ ...config, encryptionKey });
  } catch (error) {
    throw new Error(
      `Failed to initialize encrypted storage: ${error instanceof Error ? error.message : 'Unknown error'}. ` +
      `Check ${envVarName} environment variable.`
    );
  }
}
