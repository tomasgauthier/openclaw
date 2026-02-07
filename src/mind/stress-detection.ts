/**
 * Stress detection — identifies user frustration/corrections in messages.
 *
 * M2: Regex-based fast first-pass filter
 * M3: Semantic (embedding) comparison for nuanced detection
 */

// ── M2: Regex patterns ──────────────────────────────────────────────

const STRESS_PATTERNS = [
  /no[,\s]+(that'?s?\s+)?(wrong|incorrect|not what i meant)/i,
  /actually[,\s]+/i,
  /i (already )?told you/i,
  /you'?re not listening/i,
  /that'?s not what i (asked|said|meant)/i,
  /why (did you|would you)/i,
  /try again/i,
  /you keep (making|doing)/i,
  /this is (wrong|broken|not right)/i,
  /can you just/i,
  // Spanish patterns
  /no[,\s]+(eso\s+)?(no es|est[áa] mal)/i,
  /ya te (dije|lo dije)/i,
  /no me est[áa]s (escuchando|entendiendo)/i,
  /eso no es lo que (ped[ií]|dije|quise)/i,
  /int[ée]ntalo de nuevo/i,
  /por qu[ée] (hiciste|har[ií]as)/i,
];

export function detectStressRegex(text: string): boolean {
  return STRESS_PATTERNS.some((pattern) => pattern.test(text));
}

// ── M3: Semantic stress detection ────────────────────────────────────

const STRESS_REFERENCE_PHRASES = [
  "That's not what I asked for",
  "You're not understanding me",
  "I already told you this",
  "This is wrong, try again",
  "You keep making the same mistake",
];

function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  return dot / (Math.sqrt(normA) * Math.sqrt(normB) || 1);
}

/** Cached reference embeddings — built once per embedding provider */
let stressEmbeddingsCache: number[][] | null = null;
let stressEmbeddingsCacheKey: string | null = null;

export type EmbeddingFn = (text: string) => Promise<number[]>;

export async function detectStressSemantic(
  text: string,
  embed: EmbeddingFn,
  providerKey: string = "default",
  threshold: number = 0.75,
): Promise<boolean> {
  try {
    if (!stressEmbeddingsCache || stressEmbeddingsCacheKey !== providerKey) {
      stressEmbeddingsCache = await Promise.all(
        STRESS_REFERENCE_PHRASES.map((p) => embed(p)),
      );
      stressEmbeddingsCacheKey = providerKey;
    }

    const textEmb = await embed(text);
    const maxSimilarity = Math.max(
      ...stressEmbeddingsCache.map((ref) => cosineSimilarity(textEmb, ref)),
    );

    return maxSimilarity > threshold;
  } catch {
    // Graceful fallback to regex
    return detectStressRegex(text);
  }
}

/**
 * Combined stress detection: regex first (fast), then semantic if available.
 * Returns intensity 0-5 (0 = no stress detected).
 */
export async function detectStress(
  text: string,
  embed?: EmbeddingFn,
  providerKey?: string,
): Promise<{ detected: boolean; intensity: number; method: "regex" | "semantic" | "none" }> {
  // Fast regex check first
  if (detectStressRegex(text)) {
    return { detected: true, intensity: 3, method: "regex" };
  }

  // Semantic check if embedding function is available
  if (embed) {
    const semantic = await detectStressSemantic(text, embed, providerKey);
    if (semantic) {
      return { detected: true, intensity: 2, method: "semantic" };
    }
  }

  return { detected: false, intensity: 0, method: "none" };
}
