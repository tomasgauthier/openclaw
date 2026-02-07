/**
 * Spiritual Biology module for OpenClaw.
 *
 * A closed-loop self-improvement system:
 *   frustration → log → dream → propose → approve → inject → decay
 */

export { MindStore, IMMUTABLE_PRINCIPLES, DECAY_FACTOR, MIN_RELEVANCE, REACTIVATION_BOOST } from "./store.js";
export type { MindLogCategory, MindLogEntry, MindAction, MindLearning, DreamResult } from "./store.js";

export { detectStress, detectStressRegex, detectStressSemantic } from "./stress-detection.js";
export type { EmbeddingFn } from "./stress-detection.js";

export { createMindTools } from "./tools.js";

export { buildMindPromptSection } from "./identity.js";

export {
  getMindStore,
  hasMindStore,
  getAllMindStores,
  closeAllMindStores,
  buildDreamCronPayload,
  getMindDashboardData,
} from "./manager.js";
export type { MindDashboardData } from "./manager.js";
