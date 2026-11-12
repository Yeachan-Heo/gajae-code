import type { AgentMessage } from "@gajae-code/agent-core";
import { HookEditorComponent, HookInputComponent, HookSelectorComponent } from "./modes/components";
import type { EntryPatchRecord as StoredEntryPatchRecord } from "./sdk/session-readonly/format";

// Core session management

// Re-export TUI components for custom tool rendering
export { Container, Markdown, Spacer, Text } from "@gajae-code/tui";
// Logging
export { getAgentDir, logger, VERSION } from "@gajae-code/utils";
export * from "./config/keybindings";
export * from "./config/model-registry";
// Prompt templates
export type * from "./config/prompt-templates";
export * from "./config/prompt-templates";
export type { RetrySettings, SkillsSettings } from "./config/settings";
export { Settings, settings } from "./config/settings";
// Custom commands
export type * from "./extensibility/custom-commands/types";
export type * from "./extensibility/custom-tools";
// Custom tools
export * from "./extensibility/custom-tools";
export type * from "./extensibility/extensions";
// Extension types and utilities
export * from "./extensibility/extensions";
// Hook system types (legacy re-export)
// Skills
export * from "./extensibility/skills";
// Slash commands
export { type FileSlashCommand, loadSlashCommands as discoverSlashCommands } from "./extensibility/slash-commands";
export * from "./hashline";
export type * from "./lsp";
// Main entry point
export * from "./main";
// Run modes for programmatic SDK usage
export * from "./modes";
export * from "./modes/components";
// Theme utilities for custom tools
export * from "./modes/theme/theme";
// SDK for programmatic usage
export * from "./sdk";
export type { HeaderPatchRecord } from "./sdk/session-readonly/format";
export { CURRENT_SESSION_VERSION } from "./sdk/session-readonly/format";
export type EntryPatchRecord = StoredEntryPatchRecord<AgentMessage>;
export type { ResumeSessionIdentity } from "./sdk/session-readonly/storage";
export * from "./session/agent-session";
// Auth and model registry
export * from "./session/auth-storage";
export * from "./session/messages";
export * from "./session/session-dump-format";
export * from "./session/session-manager";
export * from "./task/executor";
export type * from "./task/types";
export * from "./telemetry";
// Tools (detail types and utilities)
export * from "./tools";
export * from "./utils/git";
// UI components for extensions
export {
	HookEditorComponent as ExtensionEditorComponent,
	HookInputComponent as ExtensionInputComponent,
	HookSelectorComponent as ExtensionSelectorComponent,
};
