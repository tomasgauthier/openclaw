import type { loadConfig } from "../config/config.js";
import { resolveAgentMaxConcurrent, resolveSubagentMaxConcurrent } from "../config/agent-limits.js";
import { setCommandLaneConcurrency } from "../process/command-queue.js";
import { CommandLane } from "../process/lanes.js";

/** Default tool concurrency: 3 allows independent tool calls to overlap. */
const DEFAULT_TOOL_CONCURRENCY = 3;

export function applyGatewayLaneConcurrency(cfg: ReturnType<typeof loadConfig>) {
  setCommandLaneConcurrency(CommandLane.Cron, cfg.cron?.maxConcurrentRuns ?? 1);
  setCommandLaneConcurrency(CommandLane.Main, resolveAgentMaxConcurrent(cfg));
  setCommandLaneConcurrency(CommandLane.Subagent, resolveSubagentMaxConcurrent(cfg));
  // P2: Configurable tool execution concurrency
  const toolConcurrency = cfg.agents?.defaults?.toolConcurrency;
  setCommandLaneConcurrency(
    CommandLane.Tool,
    typeof toolConcurrency === "number" && Number.isFinite(toolConcurrency)
      ? Math.max(1, Math.floor(toolConcurrency))
      : DEFAULT_TOOL_CONCURRENCY,
  );
}
