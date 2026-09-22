/**
 * Internal URL routing system for internal protocols like agent://, memory://,
 * rule://, and local://.
 *
 * One process-global `InternalUrlRouter` is shared across sessions. Handlers
 * are stateless; they pull whatever they need (active skills/rules, active
 * MCP/async managers, AgentRegistry-listed sessions) from the owning module
 * on each resolve call.
 */

export * from "./agent-protocol";
export * from "./artifact-protocol";
export * from "./embedded-protocol";
export * from "./gjc-protocol";
export * from "./issue-pr-protocol";
export * from "./json-query";
export * from "./local-protocol";
export * from "./memory-protocol";
export * from "./parse";
export * from "./router";
export * from "./rule-protocol";
export * from "./skill-protocol";
export type * from "./types";
