import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * HMAC Token Authentication
 *
 * Provides HMAC-SHA256 token generation and validation with expiration.
 * Tokens are in the format: base64url(payload).base64url(signature)
 *
 * BACKWARD COMPATIBLE:
 * - This is an additive feature that works alongside existing auth methods
 * - Only used if OPENCLAW_HMAC_SECRET environment variable is set
 * - Existing token/password authentication continues to work unchanged
 */

export interface HmacTokenPayload {
  exp: number; // Expiration timestamp in milliseconds
  iat?: number; // Issued at timestamp (optional)
  [key: string]: unknown; // Allow additional claims
}

/**
 * Create an HMAC-SHA256 token with expiration
 *
 * @param secret - Secret key for HMAC
 * @param expiryHours - Token validity duration in hours (default: 24)
 * @param additionalClaims - Additional claims to include in the payload
 * @returns HMAC token string
 */
export function createHmacToken(
  secret: string,
  expiryHours: number = 24,
  additionalClaims: Record<string, unknown> = {}
): string {
  const now = Date.now();
  const payload: HmacTokenPayload = {
    exp: now + expiryHours * 3600_000,
    iat: now,
    ...additionalClaims
  };

  // Encode payload as base64url
  const payloadB64 = Buffer.from(JSON.stringify(payload)).toString('base64url');

  // Create HMAC signature
  const signature = createHmac('sha256', secret)
    .update(payloadB64)
    .digest('base64url');

  // Return token in format: payload.signature
  return `${payloadB64}.${signature}`;
}

/**
 * Verify an HMAC token and return the payload if valid
 *
 * @param token - HMAC token string to verify
 * @param secret - Secret key for HMAC verification
 * @returns Payload if token is valid, null if invalid or expired
 */
export function verifyHmacToken(token: string, secret: string): HmacTokenPayload | null {
  try {
    // Split token into payload and signature
    const parts = token.split('.');
    if (parts.length !== 2) {
      return null;
    }

    const [payloadB64, providedSig] = parts;

    if (!payloadB64 || !providedSig) {
      return null;
    }

    // Verify signature using timing-safe comparison
    const expectedSig = createHmac('sha256', secret)
      .update(payloadB64)
      .digest('base64url');

    const expectedBuf = Buffer.from(expectedSig);
    const providedBuf = Buffer.from(providedSig);

    // Length check (but still continue to prevent timing attacks)
    if (expectedBuf.length !== providedBuf.length) {
      return null;
    }

    // Timing-safe comparison
    if (!timingSafeEqual(expectedBuf, providedBuf)) {
      return null;
    }

    // Decode and parse payload
    const payloadJson = Buffer.from(payloadB64, 'base64url').toString('utf8');
    const payload = JSON.parse(payloadJson) as HmacTokenPayload;

    // Check expiration
    if (payload.exp && payload.exp < Date.now()) {
      return null; // Token expired
    }

    return payload;
  } catch {
    // Any error in parsing or verification = invalid token
    return null;
  }
}

/**
 * Check if a token is expired without full verification
 *
 * @param token - HMAC token string
 * @returns true if token is expired, false otherwise
 */
export function isTokenExpired(token: string): boolean {
  try {
    const [payloadB64] = token.split('.');
    if (!payloadB64) {
      return true;
    }

    const payloadJson = Buffer.from(payloadB64, 'base64url').toString('utf8');
    const payload = JSON.parse(payloadJson) as HmacTokenPayload;

    return payload.exp < Date.now();
  } catch {
    return true;
  }
}

/**
 * Get time until token expires (in milliseconds)
 *
 * @param token - HMAC token string
 * @returns Milliseconds until expiration, or null if token is invalid
 */
export function getTimeToExpiry(token: string): number | null {
  try {
    const [payloadB64] = token.split('.');
    if (!payloadB64) {
      return null;
    }

    const payloadJson = Buffer.from(payloadB64, 'base64url').toString('utf8');
    const payload = JSON.parse(payloadJson) as HmacTokenPayload;

    return Math.max(0, payload.exp - Date.now());
  } catch {
    return null;
  }
}

/**
 * Create an HMAC token from environment variable secret
 *
 * @param envVarName - Name of environment variable containing HMAC secret
 * @param expiryHours - Token validity duration in hours
 * @param additionalClaims - Additional claims to include
 * @returns HMAC token string or null if environment variable not set
 */
export function createTokenFromEnv(
  envVarName = 'OPENCLAW_HMAC_SECRET',
  expiryHours: number = 24,
  additionalClaims: Record<string, unknown> = {}
): string | null {
  const secret = process.env[envVarName];
  if (!secret) {
    return null;
  }

  return createHmacToken(secret, expiryHours, additionalClaims);
}

/**
 * Verify an HMAC token using environment variable secret
 *
 * @param token - HMAC token string to verify
 * @param envVarName - Name of environment variable containing HMAC secret
 * @returns Payload if token is valid, null otherwise
 */
export function verifyTokenFromEnv(
  token: string,
  envVarName = 'OPENCLAW_HMAC_SECRET'
): HmacTokenPayload | null {
  const secret = process.env[envVarName];
  if (!secret) {
    return null;
  }

  return verifyHmacToken(token, secret);
}
