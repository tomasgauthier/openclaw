export const enum CommandLane {
  Main = "main",
  Cron = "cron",
  Subagent = "subagent",
  Nested = "nested",
  /** P2: Dedicated lane for tool execution with configurable concurrency. */
  Tool = "tool",
}
