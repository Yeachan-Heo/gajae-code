import * as fs from "node:fs/promises";
import * as path from "node:path";
import { ThinkingLevel } from "@gajae-code/agent-core";
import { type Model, modelsAreEqual } from "@gajae-code/ai";
import { getOAuthProviders } from "@gajae-code/ai/utils/oauth";
import { Spacer, Text } from "@gajae-code/tui";
import { setProjectDir } from "@gajae-code/utils";
import { jobElapsedMs } from "../async";
import { materializeActiveModelProfileAssignments } from "../config/model-profile-activation";
import {
	GJC_MODEL_ASSIGNMENT_TARGET_IDS,
	GJC_MODEL_ASSIGNMENT_TARGETS,
	type GjcModelAssignmentTargetId,
} from "../config/model-registry";

import {
	extractExplicitThinkingSelector,
	formatModelSelectorValue,
	parseModelPattern,
	parseModelString,
} from "../config/model-resolver";
import { clearPluginRootsAndCaches, resolveActiveProjectRegistryPath } from "../discovery/helpers.js";
import { resolveMemoryBackend } from "../memory-backend";
import { DynamicBorder } from "../modes/components/dynamic-border";
import { theme } from "../modes/theme/theme";
import type { InteractiveModeContext } from "../modes/types";
import { computeCacheMissCostSummary, formatCacheMissSummaryLines } from "../session/cache-economics";
import { formatModelOnboardingGuidance } from "../setup/model-onboarding-guidance";
import {
	addApiCompatibleProvider,
	formatProviderPresetList,
	formatProviderSetupResult,
	parseProviderCompatibility,
} from "../setup/provider-onboarding";
import { parseThinkingLevel } from "../thinking";
import { getDisplayChangelogEntries } from "../utils/changelog";
import { buildContextReportText } from "./helpers/context-report";
import { buildFastStatusReport } from "./helpers/fast-status-report";
import { formatDuration } from "./helpers/format";
import { commandConsumed, errorMessage, parseSlashCommand, usage } from "./helpers/parse";
import { handleSshAcp } from "./helpers/ssh";
import { buildUsageReportText } from "./helpers/usage-report";
import type {
	BuiltinSlashCommand,
	ParsedSlashCommand,
	SlashCommandResult,
	SlashCommandRuntime,
	SlashCommandSpec,
	TuiSlashCommandRuntime,
} from "./types";

export type { BuiltinSlashCommand, SubcommandDef } from "./types";

/** TUI-specific runtime accepted by `executeBuiltinSlashCommand`. */
export type BuiltinSlashCommandRuntime = TuiSlashCommandRuntime;

type GjcModelBatchAssignmentTargetId = "all-role-agents" | "all-targets";
type ParsedModelCommandArgs =
	| { kind: "summary" }
	| { kind: "assign"; targetId: GjcModelAssignmentTargetId | GjcModelBatchAssignmentTargetId; selector: string };

const GJC_MODEL_ROLE_AGENT_TARGET_IDS: GjcModelAssignmentTargetId[] = ["executor", "architect", "planner", "critic"];

function fastStatusRoleTargets(): Array<{ id: GjcModelAssignmentTargetId; label: string; isSubagentRole: boolean }> {
	return GJC_MODEL_ASSIGNMENT_TARGET_IDS.map(id => ({
		id,
		label: GJC_MODEL_ASSIGNMENT_TARGETS[id].tag ?? id.toUpperCase(),
		isSubagentRole: GJC_MODEL_ASSIGNMENT_TARGETS[id].settingsPath === "task.agentModelOverrides",
	}));
}

function toSlashCommandRuntime(runtime: TuiSlashCommandRuntime): SlashCommandRuntime {
	const ctx = runtime.ctx;
	return {
		session: ctx.session,
		sessionManager: ctx.sessionManager,
		settings: ctx.settings,
		cwd: ctx.sessionManager.getCwd(),
		output: (text: string) => {
			ctx.showStatus(text);
		},
		refreshCommands: () => ctx.refreshSlashCommandState(),
		reloadPlugins: async () => {
			const projectPath = await resolveActiveProjectRegistryPath(ctx.sessionManager.getCwd());
			clearPluginRootsAndCaches(projectPath ? [projectPath] : undefined);
			await ctx.refreshSlashCommandState();
			await ctx.session.refreshSshTool({ activateIfAvailable: true });
		},
		notifyTitleChanged: () => {
			ctx.statusLine.invalidate();
			ctx.updateEditorBorderColor();
			ctx.ui.requestRender();
		},
		notifyConfigChanged: () => ctx.notifyConfigChanged?.(),
	};
}

function parseProviderSetupSlashArgs(args: string): {
	preset?: string;
	compat?: string;
	provider?: string;
	baseUrl?: string;
	apiKeyEnv?: string;
	rejectedRawApiKey: boolean;
	force: boolean;
	models: string[];
} {
	const tokens = args.split(/\s+/).filter(Boolean);
	const result: {
		preset?: string;
		compat?: string;
		provider?: string;
		baseUrl?: string;
		apiKeyEnv?: string;
		rejectedRawApiKey: boolean;
		force: boolean;
		models: string[];
	} = {
		force: false,
		models: [],
		rejectedRawApiKey: false,
	};
	for (let i = 0; i < tokens.length; i++) {
		const token = tokens[i];
		if (token === "--force" || token === "-f") {
			result.force = true;
			continue;
		}
		if (!token.startsWith("-") && !result.preset) {
			result.preset = token;
			continue;
		}
		const value = tokens[i + 1];
		if (!value) continue;
		if (token === "--preset") {
			result.preset = value;
			i += 1;
		} else if (token === "--compat") {
			result.compat = value;
			i += 1;
		} else if (token === "--provider") {
			result.provider = value;
			i += 1;
		} else if (token === "--base-url") {
			result.baseUrl = value;
			i += 1;
		} else if (token === "--api-key") {
			result.rejectedRawApiKey = true;
			i += 1;
		} else if (token === "--api-key-env") {
			result.apiKeyEnv = value;
			i += 1;
		} else if (token === "--model" || token === "--models") {
			result.models.push(value);
			i += 1;
		}
	}
	return result;
}

function providerSetupUsage(): string {
	return [
		"Provider onboarding",
		"Presets: /provider add --preset <minimax|minimax-cn|glm> [--force]",
		"Aliases: /provider add minimax, /provider add minimax-cn, /provider add glm, /provider add zai (writes glm-proxy)",
		"API providers: /provider add --compat <openai|anthropic> --provider <id> --base-url <url> --api-key-env <ENV> --model <model> [--force]",
		`Available presets:\n${formatProviderPresetList()}`,
		"OAuth/subscription providers: /provider login [provider-id] or /login [provider-id]",
		"Headless OAuth callbacks can be pasted with /login <redirect URL or code>.",
	].join("\n");
}

function formatModelAssignmentSummary(runtime: SlashCommandRuntime): string {
	const agentModelOverrides = runtime.settings.get("task.agentModelOverrides");
	const lines = ["Model assignments:"];
	for (const targetId of GJC_MODEL_ASSIGNMENT_TARGET_IDS) {
		const target = GJC_MODEL_ASSIGNMENT_TARGETS[targetId];
		const modelSelector =
			target.settingsPath === "modelRoles" ? runtime.settings.getModelRole(targetId) : agentModelOverrides[targetId];
		lines.push(`  ${target.tag ?? target.id.toUpperCase()} (${target.name}): ${modelSelector ?? "(unset)"}`);
	}
	return lines.join("\n");
}

function parseModelCommandArgs(args: string): ParsedModelCommandArgs {
	const tokens = args.trim().split(/\s+/).filter(Boolean);
	const first = tokens[0]?.toLowerCase();
	if (first === "roles" || first === "assignments") return { kind: "summary" };

	const parseTarget = (
		token: string | undefined,
	): GjcModelAssignmentTargetId | GjcModelBatchAssignmentTargetId | undefined => {
		const normalized = token?.toLowerCase();
		if (GJC_MODEL_ASSIGNMENT_TARGET_IDS.includes(normalized as GjcModelAssignmentTargetId)) {
			return normalized as GjcModelAssignmentTargetId;
		}
		if (normalized === "all-role-agents" || normalized === "all-targets") return normalized;
		return undefined;
	};

	if (first === "assign") {
		const targetId = parseTarget(tokens[1]);
		if (targetId) return { kind: "assign", targetId, selector: tokens.slice(2).join(" ") };
		return { kind: "assign", targetId: "default", selector: tokens.slice(1).join(" ") };
	}

	const explicitTarget = parseTarget(first);
	if (explicitTarget) {
		return { kind: "assign", targetId: explicitTarget, selector: tokens.slice(1).join(" ") };
	}
	if (first === "set") {
		const targetId = parseTarget(tokens[1]);
		if (targetId) return { kind: "assign", targetId, selector: tokens.slice(2).join(" ") };
	}
	return { kind: "assign", targetId: "default", selector: args.trim() };
}

function splitExplicitThinkingSelector(selector: string): { baseSelector: string; thinkingLevel?: ThinkingLevel } {
	const trimmed = selector.trim();
	const colonIndex = trimmed.lastIndexOf(":");
	if (colonIndex === -1) {
		return { baseSelector: trimmed };
	}
	const thinkingLevel = parseThinkingLevel(trimmed.slice(colonIndex + 1));
	return thinkingLevel ? { baseSelector: trimmed.slice(0, colonIndex), thinkingLevel } : { baseSelector: trimmed };
}

interface ModelCommandSelection {
	model: Model;
	selector: string;
	thinkingLevel?: ThinkingLevel;
}

interface ModelCommandResolutionFailure {
	message: string;
}

type ModelCommandResolution =
	| { ok: true; selection: ModelCommandSelection }
	| { ok: false; failure: ModelCommandResolutionFailure };

function parseProviderQualifiedSelector(selector: string): { provider: string; modelId: string } | undefined {
	const splitSelector = splitExplicitThinkingSelector(selector);
	const parsed = parseModelString(splitSelector.baseSelector);
	if (!parsed) return undefined;
	return { provider: parsed.provider, modelId: parsed.id };
}

function resolveModelCommandSelectionFromAvailable(
	runtime: SlashCommandRuntime,
	selector: string,
	availableModels: Model[],
): ModelCommandSelection | undefined {
	const matchPreferences = { usageOrder: runtime.settings.getStorage()?.getModelUsageOrder() };
	const resolved = parseModelPattern(selector, availableModels, matchPreferences, {
		modelRegistry: runtime.session.modelRegistry,
	});
	if (!resolved.model) {
		return undefined;
	}

	const splitSelector = splitExplicitThinkingSelector(selector);
	const canonicalModel = runtime.session.modelRegistry.resolveCanonicalModel?.(splitSelector.baseSelector, {
		availableOnly: false,
		candidates: availableModels,
	});
	const persistedSelector =
		canonicalModel && modelsAreEqual(canonicalModel, resolved.model)
			? splitSelector.baseSelector
			: `${resolved.model.provider}/${resolved.model.id}`;
	return {
		model: resolved.model,
		selector: persistedSelector,
		thinkingLevel: resolved.explicitThinkingLevel ? resolved.thinkingLevel : undefined,
	};
}

function formatDiscoverableProviderFailure(
	selector: string,
	provider: string,
	modelId: string,
	runtime: SlashCommandRuntime,
): string {
	const state = runtime.session.modelRegistry.getProviderDiscoveryState?.(provider);
	const discovered = state?.models ?? [];
	const base = `Unknown model: ${selector}.`;
	if (!modelId.trim()) {
		return `${base} Local provider model selectors must use provider/model-id syntax with a non-empty model id.`;
	}
	if (!state) {
		return `${base} Provider ${provider} is configured for discovery but has not reported models yet.`;
	}
	if (state.status === "unavailable") {
		const details = state.error ? ` (${state.error})` : "";
		return `${base} Provider ${provider} discovery is unavailable${details}. Check the local endpoint and run /model again.`;
	}
	if (state.status === "unauthenticated") {
		return `${base} Provider ${provider} requires authentication before model discovery.`;
	}
	if (state.status === "empty") {
		return `${base} Provider ${provider} discovery succeeded but returned no models.`;
	}
	if (discovered.length > 0) {
		const preview = discovered.slice(0, 8).join(", ");
		const suffix = discovered.length > 8 ? ", …" : "";
		return `${base} Provider ${provider} did not report model ${modelId}. Available local models: ${preview}${suffix}.`;
	}
	return `${base} Provider ${provider} did not report model ${modelId}.`;
}

async function resolveModelCommandSelection(
	runtime: SlashCommandRuntime,
	selector: string,
): Promise<ModelCommandResolution> {
	let availableModels = runtime.session.getAvailableModels?.() ?? [];
	const initialSelection = resolveModelCommandSelectionFromAvailable(runtime, selector, availableModels as Model[]);
	if (initialSelection) {
		return { ok: true, selection: initialSelection };
	}

	const providerRef = parseProviderQualifiedSelector(selector);
	const discoverableProviders = runtime.session.modelRegistry?.getDiscoverableProviders?.() ?? [];
	if (providerRef && discoverableProviders.includes(providerRef.provider)) {
		await runtime.session.modelRegistry.refreshProvider?.(providerRef.provider, "online");
		availableModels = runtime.session.getAvailableModels?.() ?? [];
		const refreshedSelection = resolveModelCommandSelectionFromAvailable(
			runtime,
			selector,
			availableModels as Model[],
		);
		if (refreshedSelection) {
			return { ok: true, selection: refreshedSelection };
		}
		return {
			ok: false,
			failure: {
				message: formatDiscoverableProviderFailure(selector, providerRef.provider, providerRef.modelId, runtime),
			},
		};
	}

	return {
		ok: false,
		failure: {
			message: `Unknown model: ${selector}. Configure or login to a provider first, then list/select models with /model.`,
		},
	};
}

function getModelAssignmentTargetIds(
	targetId: GjcModelAssignmentTargetId | GjcModelBatchAssignmentTargetId,
): GjcModelAssignmentTargetId[] {
	if (targetId === "all-role-agents") return [...GJC_MODEL_ROLE_AGENT_TARGET_IDS];
	if (targetId === "all-targets") return [...GJC_MODEL_ASSIGNMENT_TARGET_IDS];
	return [targetId];
}

function formatModelAssignmentSuccess(
	targetId: GjcModelAssignmentTargetId | GjcModelBatchAssignmentTargetId,
	selector: string,
): string {
	if (targetId === "all-role-agents") {
		return `Role-agent models set to ${selector} for EXECUTOR, ARCHITECT, PLANNER, CRITIC.`;
	}
	if (targetId === "all-targets") {
		return `All model targets set to ${selector} for DEFAULT, EXECUTOR, ARCHITECT, PLANNER, CRITIC.`;
	}
	if (targetId === "default") return `Default model set to ${selector}.`;
	return `${targetId} agent model set to ${selector}.`;
}

function modelSelectionUsage(runtime: SlashCommandRuntime, currentModelLine?: string): string {
	return [
		currentModelLine,
		formatModelAssignmentSummary(runtime),
		"Use /model <model> for DEFAULT, or /model <target> <model[:effort]> for EXECUTOR, ARCHITECT, PLANNER, or CRITIC.",
		formatModelOnboardingGuidance(),
	]
		.filter((line): line is string => Boolean(line))
		.join("\n\n");
}

const EFFORT_COMMAND_INPUT_HINT = "[inherit|off|minimal|low|medium|high|xhigh|max]";
const EFFORT_COMMAND_ACCEPTED_VALUES = ["inherit", "off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

function effortCommandUsage(prefix?: string): string {
	return [prefix, `Usage: /effort ${EFFORT_COMMAND_INPUT_HINT}`]
		.filter((line): line is string => Boolean(line))
		.join("\n");
}

function formatEffortStatus(runtime: SlashCommandRuntime): string {
	const current = runtime.session.thinkingLevel ?? ThinkingLevel.Off;
	const configuredDefault = runtime.settings.get("defaultThinkingLevel");
	const supported = runtime.session.getAvailableThinkingLevels();
	return [
		`Current effective effort: ${current}`,
		`Configured default effort: ${configuredDefault}`,
		`Accepted values: ${EFFORT_COMMAND_ACCEPTED_VALUES.join(", ")}`,
		`Current-model supported levels: ${supported.length > 0 ? supported.join(", ") : "(none reported)"}`,
	].join("\n");
}

async function handleEffortCommand(
	command: ParsedSlashCommand,
	runtime: SlashCommandRuntime,
): Promise<SlashCommandResult> {
	const tokens = command.args.trim().split(/\s+/).filter(Boolean);
	if (tokens.length === 0) {
		await runtime.output(formatEffortStatus(runtime));
		return commandConsumed();
	}
	if (tokens.length !== 1) {
		return usage(effortCommandUsage("Invalid effort input."), runtime);
	}

	const requestedToken = tokens[0];
	const requestedLevel = parseThinkingLevel(requestedToken);
	if (!requestedToken || !requestedLevel) {
		return usage(effortCommandUsage(`Invalid effort: ${tokens[0] ?? ""}.`), runtime);
	}

	const levelToApply =
		requestedLevel === ThinkingLevel.Inherit ? runtime.settings.get("defaultThinkingLevel") : requestedLevel;
	runtime.session.setThinkingLevel(levelToApply, false);
	const effectiveLevel = runtime.session.thinkingLevel ?? ThinkingLevel.Off;
	const requestedLabel =
		requestedLevel === ThinkingLevel.Inherit ? `${requestedLevel} (${levelToApply})` : requestedLevel;
	const clampedSuffix =
		effectiveLevel === levelToApply ? "" : ` Requested ${levelToApply}; effective ${effectiveLevel}.`;
	await runtime.output(
		`Reasoning effort set to ${requestedLabel}. Effective effort: ${effectiveLevel}.${clampedSuffix}`,
	);
	return commandConsumed();
}

function refreshStatusLine(ctx: InteractiveModeContext): void {
	ctx.statusLine.invalidate();
	ctx.updateEditorTopBorder();
	ctx.ui.requestRender();
}

type ChangelogCommandArgs = { showFull: boolean } | { error: string };

function parseChangelogCommandArgs(args: string): ChangelogCommandArgs {
	const normalized = args.trim().toLowerCase();
	if (!normalized) return { showFull: false };
	if (normalized === "full" || normalized === "--full") return { showFull: true };
	return { error: "Usage: /changelog [full|--full]" };
}

function buildChangelogCommandOutput(showFull: boolean): string {
	const allEntries = getDisplayChangelogEntries();
	const entriesToShow = showFull ? allEntries : allEntries.slice(0, 3);
	const changelogMarkdown =
		entriesToShow.length > 0
			? [...entriesToShow]
					.reverse()
					.map(entry => entry.content)
					.join("\n\n")
			: "No changelog entries found.";
	const title = showFull ? "Full Changelog" : "Recent Changes";
	const hint = showFull ? "" : "\n\nUse `/changelog --full` to view the complete changelog.";
	return `${title}\n\n${changelogMarkdown}${hint}`;
}

const shutdownHandlerTui = (_command: ParsedSlashCommand, runtime: TuiSlashCommandRuntime): SlashCommandResult => {
	runtime.ctx.editor.setText("");
	void runtime.ctx.shutdown();
	return commandConsumed();
};

const BUILTIN_SLASH_COMMAND_REGISTRY: ReadonlyArray<SlashCommandSpec> = [
	{
		name: "settings",
		priority: 40,
		description: "Open settings and preferences",
		handleTui: (_command, runtime) => {
			runtime.ctx.showSettingsSelector();
			runtime.ctx.editor.setText("");
		},
	},
	{
		name: "theme",
		description: "Open theme selector",
		handleTui: (_command, runtime) => {
			runtime.ctx.showThemeSelector();
			runtime.ctx.editor.setText("");
		},
	},
	{
		name: "goal",
		priority: 84,
		description: "Plan and track an autonomous goal",
		subcommands: [
			{ name: "set", description: "Set or replace the goal", usage: "<objective>" },
			{ name: "show", description: "Show current goal details" },
			{ name: "pause", description: "Pause the current goal" },
			{ name: "resume", description: "Resume a paused goal" },
			{ name: "drop", description: "Drop the current goal" },
		],
		inlineHint: "[objective]",
		allowArgs: true,
		handleTui: async (command, runtime) => {
			// The goal command always consumes the typed input: it either submits
			// the bare objective (never the literal `/goal …` text the user typed)
			// or shows a warning, so the normal submission path never records it in
			// input history. Preserve the typed command whenever args were supplied
			// — including the first-time `/goal set <objective>` case where goal
			// mode was not yet active. A previous `wasGoalModeEnabled` guard dropped
			// that first-time case from history (up/down-arrow recall).
			await runtime.ctx.handleGoalModeCommand(command.args || undefined);
			if (command.args) {
				runtime.ctx.editor.addToHistory(command.text);
			}
			runtime.ctx.editor.setText("");
		},
	},
	{
		name: "model",
		aliases: ["models"],
		description: "Select model (opens selector UI)",
		acpDescription: "Show current model selection",
		inlineHint: "[target] <model>",
		acpInputHint: "[target] <model>",
		allowArgs: true,
		handle: async (command, runtime) => {
			if (command.args) {
				const parsedArgs = parseModelCommandArgs(command.args);
				if (parsedArgs.kind === "summary") {
					await runtime.output(formatModelAssignmentSummary(runtime));
					return commandConsumed();
				}

				const targetIds = getModelAssignmentTargetIds(parsedArgs.targetId);
				const modelId = parsedArgs.selector;
				if (!modelId) {
					return usage(
						modelSelectionUsage(runtime, `Missing model for ${parsedArgs.targetId.toUpperCase()}.`),
						runtime,
					);
				}
				const resolution = await resolveModelCommandSelection(runtime, modelId);
				if (!resolution.ok) {
					return usage(modelSelectionUsage(runtime, resolution.failure.message), runtime);
				}
				const { selection } = resolution;
				try {
					const includesDefault = targetIds.includes("default");
					const includesRoleAgent = targetIds.some(role => role !== "default");
					if (includesRoleAgent) {
						const apiKey = await runtime.session.modelRegistry.getApiKey(
							selection.model,
							runtime.session.sessionId,
						);
						if (!apiKey) {
							throw new Error(`No API key for ${selection.model.provider}/${selection.model.id}`);
						}
					}

					const overrides = runtime.settings.get("task.agentModelOverrides");
					const assignments = new Map<GjcModelAssignmentTargetId, string>();
					const existingDefaultThinkingLevel =
						selection.thinkingLevel !== undefined
							? selection.thinkingLevel
							: runtime.session.getActiveModelProfile?.()
								? undefined
								: extractExplicitThinkingSelector(runtime.settings.getModelRole("default"), runtime.settings);
					const persistedSelector = formatModelSelectorValue(selection.selector, existingDefaultThinkingLevel);
					for (const targetId of targetIds) {
						if (targetId === "default") {
							assignments.set(targetId, persistedSelector);
							continue;
						}
						const thinkingLevel =
							selection.thinkingLevel ?? extractExplicitThinkingSelector(overrides[targetId], runtime.settings);
						assignments.set(targetId, formatModelSelectorValue(selection.selector, thinkingLevel));
					}

					if (includesDefault) {
						await runtime.session.setModel(selection.model, "default", {
							selector: selection.selector,
							thinkingLevel: existingDefaultThinkingLevel,
						});
						if (existingDefaultThinkingLevel) {
							runtime.session.setThinkingLevel(existingDefaultThinkingLevel);
						}
					}

					const materializedProfile = materializeActiveModelProfileAssignments({
						session: runtime.session,
						settings: runtime.settings,
						assignments,
					});
					if (!materializedProfile) {
						for (const [targetId, selector] of assignments) {
							const target = GJC_MODEL_ASSIGNMENT_TARGETS[targetId];
							if (target.settingsPath === "modelRoles") {
								runtime.settings.setModelRole(targetId, selector);
							} else {
								runtime.settings.setAgentModelOverride(targetId, selector);
							}
						}
					}
					runtime.settings.getStorage()?.recordModelUsage(`${selection.model.provider}/${selection.model.id}`);
					await runtime.output(
						formatModelAssignmentSuccess(
							parsedArgs.targetId,
							assignments.get(targetIds[0] ?? "default") ?? persistedSelector,
						),
					);
					if (includesDefault) await runtime.notifyTitleChanged?.();
					await runtime.notifyConfigChanged?.();
					return commandConsumed();
				} catch (err) {
					return usage(`Failed to set model: ${errorMessage(err)}`, runtime);
				}
			}

			const model = runtime.session.model;
			await runtime.output(
				modelSelectionUsage(
					runtime,
					model ? `Current model: ${model.provider}/${model.id}` : "No model is currently selected.",
				),
			);
			return commandConsumed();
		},
		handleTui: async (command, runtime) => {
			if (command.args.trim()) {
				const result = await BUILTIN_SLASH_COMMAND_LOOKUP.get(command.name)?.handle?.(
					command,
					toSlashCommandRuntime(runtime),
				);
				runtime.ctx.statusLine.invalidate();
				runtime.ctx.updateEditorBorderColor();
				runtime.ctx.editor.setText("");
				runtime.ctx.ui.requestRender();
				return result;
			}
			runtime.ctx.showModelSelector();
			runtime.ctx.editor.setText("");
		},
	},
	{
		name: "effort",
		description: "Show or set model reasoning effort",
		acpDescription: "Show or set model reasoning effort",
		inlineHint: EFFORT_COMMAND_INPUT_HINT,
		acpInputHint: EFFORT_COMMAND_INPUT_HINT,
		allowArgs: true,
		handle: handleEffortCommand,
		handleTui: async (command, runtime) => {
			if (command.args.trim()) {
				const result = await handleEffortCommand(command, toSlashCommandRuntime(runtime));
				runtime.ctx.statusLine.invalidate();
				runtime.ctx.updateEditorBorderColor();
				runtime.ctx.updateEditorTopBorder();
				runtime.ctx.editor.setText("");
				runtime.ctx.ui.requestRender();
				return result;
			}

			runtime.ctx.showEffortSelector();
			runtime.ctx.editor.setText("");
		},
	},
	{
		name: "fast",
		description: "Toggle priority service tier (OpenAI service_tier=priority, Anthropic speed=fast)",
		acpDescription: "Toggle fast mode",
		acpInputHint: "[on|off|status]",
		subcommands: [
			{ name: "on", description: "Enable fast mode" },
			{ name: "off", description: "Disable fast mode" },
			{ name: "status", description: "Show fast mode status" },
		],
		allowArgs: true,
		handle: async (command, runtime) => {
			const arg = command.args.toLowerCase();
			if (!arg || arg === "toggle") {
				const enabled = runtime.session.toggleFastMode();
				await runtime.output(`Fast mode ${enabled ? "enabled" : "disabled"}.`);
				return commandConsumed();
			}
			if (arg === "on") {
				runtime.session.setFastMode(true);
				await runtime.output("Fast mode enabled.");
				return commandConsumed();
			}
			if (arg === "off") {
				runtime.session.setFastMode(false);
				await runtime.output("Fast mode disabled.");
				return commandConsumed();
			}
			if (arg === "status") {
				await runtime.output(
					buildFastStatusReport({
						session: runtime.session,
						roleTargets: fastStatusRoleTargets(),
						iconFast: theme.icon.fast,
					}),
				);
				return commandConsumed();
			}
			return usage("Usage: /fast [on|off|status]", runtime);
		},
		handleTui: (command, runtime) => {
			const arg = command.args.trim().toLowerCase();
			if (!arg || arg === "toggle") {
				const enabled = runtime.ctx.session.toggleFastMode();
				refreshStatusLine(runtime.ctx);
				runtime.ctx.showStatus(`Fast mode ${enabled ? "enabled" : "disabled"}.`);
				runtime.ctx.editor.setText("");
				return;
			}
			if (arg === "on") {
				runtime.ctx.session.setFastMode(true);
				refreshStatusLine(runtime.ctx);
				runtime.ctx.showStatus("Fast mode enabled.");
				runtime.ctx.editor.setText("");
				return;
			}
			if (arg === "off") {
				runtime.ctx.session.setFastMode(false);
				refreshStatusLine(runtime.ctx);
				runtime.ctx.showStatus("Fast mode disabled.");
				runtime.ctx.editor.setText("");
				return;
			}
			if (arg === "status") {
				const report = buildFastStatusReport({
					session: runtime.ctx.session,
					roleTargets: fastStatusRoleTargets(),
					iconFast: theme.icon.fast,
					formatInactive: text => theme.fg("dim", text),
				});
				runtime.ctx.chatContainer.addChild(new Spacer(1));
				runtime.ctx.chatContainer.addChild(new DynamicBorder());
				runtime.ctx.chatContainer.addChild(new Text(report, 1, 0));
				runtime.ctx.chatContainer.addChild(new DynamicBorder());
				runtime.ctx.ui.requestRender();
				runtime.ctx.editor.setText("");
				return;
			}
			runtime.ctx.showStatus("Usage: /fast [on|off|status]");
			runtime.ctx.editor.setText("");
		},
	},
	{
		name: "export",
		priority: 50,
		description: "Export this session to an HTML file",
		inlineHint: "[path]",
		allowArgs: true,
		handle: async (command, runtime) => {
			const arg = command.args.trim();
			// Match the interactive `/export` behavior: clipboard aliases are not a
			// valid export target. Without this, the literal value (`copy`,
			// `--copy`, `clipboard`) is passed to `exportToHtml` and becomes the
			// output filename.
			if (arg === "--copy" || arg === "clipboard" || arg === "copy") {
				return usage("Use /dump to copy the session to clipboard.", runtime);
			}
			try {
				const filePath = await runtime.session.exportToHtml(arg || undefined);
				await runtime.output(`Session exported to: ${filePath}`);
				return commandConsumed();
			} catch (err) {
				return usage(`Failed to export session: ${errorMessage(err)}`, runtime);
			}
		},
		handleTui: async (command, runtime) => {
			await runtime.ctx.handleExportCommand(command.text);
			runtime.ctx.editor.setText("");
		},
	},
	{
		name: "copy",
		priority: 55,
		description: "Copy the last response for review or sharing",
		// Public `/copy` is strict zero-argument, but `allowArgs` lets the
		// TUI dispatcher route `/copy <arg>` here so it can be rejected locally
		// instead of falling through as a model prompt.
		allowArgs: true,
		handleTui: (command, runtime) => {
			if (command.args.trim().length > 0) {
				runtime.ctx.showError("Usage: /copy");
				runtime.ctx.editor.setText("");
				return;
			}
			runtime.ctx.handleCopyCommand(undefined);
			runtime.ctx.editor.setText("");
		},
	},
	{
		name: "dump",
		priority: 54,
		description: "Dump the full transcript for review or sharing",
		acpDescription: "Return full transcript as plain text",
		handle: async (_command, runtime) => {
			const text = runtime.session.formatSessionAsText();
			await runtime.output(text || "No messages to dump yet.");
			return commandConsumed();
		},
		handleTui: async (_command, runtime) => {
			await runtime.ctx.handleDumpCommand();
			runtime.ctx.editor.setText("");
		},
	},
	{
		name: "session",
		priority: 88,
		description: "Show session info or delete the current session transcript/artifacts",
		acpDescription: "Show session information",
		acpInputHint: "info|delete",
		subcommands: [
			{ name: "info", description: "Show current session id, title, and workspace" },
			{ name: "delete", description: "Delete current session transcript and artifacts" },
		],
		allowArgs: true,
		handle: async (command, runtime) => {
			if (!command.args || command.args === "info") {
				const stats = runtime.session.getSessionStats();
				const lines = [
					`Session: ${runtime.session.sessionId}`,
					`Title: ${runtime.session.sessionName}`,
					`CWD: ${runtime.cwd}`,
					"",
					"Tokens",
					`Input: ${stats.tokens.input.toLocaleString()}`,
					`Output: ${stats.tokens.output.toLocaleString()}`,
				];
				if (stats.tokens.cacheRead > 0) {
					lines.push(`Cache Read: ${stats.tokens.cacheRead.toLocaleString()}`);
				}
				if (stats.tokens.cacheWrite > 0) {
					lines.push(`Cache Write: ${stats.tokens.cacheWrite.toLocaleString()}`);
				}
				lines.push(`Total: ${stats.tokens.total.toLocaleString()}`);
				if (stats.cost > 0 || stats.premiumRequests > 0) {
					lines.push("", "Cost");
					if (stats.cost > 0) {
						lines.push(`Total: ${stats.cost.toFixed(4)}`);
					}
					if (stats.premiumRequests > 0) {
						lines.push(`Premium Requests: ${stats.premiumRequests.toLocaleString()}`);
					}
				}
				const cacheMissSummary = stats.costBreakdown
					? computeCacheMissCostSummary(stats.tokens, {
							kind: "persisted-aggregate",
							costBreakdown: stats.costBreakdown,
						})
					: undefined;
				if (cacheMissSummary) {
					lines.push("", "Cache Miss Cost", ...formatCacheMissSummaryLines(cacheMissSummary));
				}
				await runtime.output(lines.join("\n"));
				return commandConsumed();
			}
			if (command.args === "delete") {
				if (runtime.session.isStreaming) return usage("Cannot delete the session while streaming.", runtime);
				const sessionFile = runtime.sessionManager.getSessionFile();
				if (!sessionFile) return usage("No session file to delete (in-memory session).", runtime);
				// Route through the active SessionManager so the persist writer is
				// closed before the file is deleted. Constructing a fresh
				// FileSessionStorage and calling deleteSessionWithArtifacts leaves
				// the active writer attached to the now-deleted path, so the next
				// prompt would silently resurrect or corrupt the "deleted" file.
				try {
					await runtime.sessionManager.dropSession(sessionFile);
				} catch (err) {
					return usage(`Failed to delete session: ${errorMessage(err)}`, runtime);
				}
				await runtime.output(
					[
						`Deleted current session transcript and artifacts: ${sessionFile}`,
						"Other sessions and topic/history metadata were not deleted.",
					].join("\n"),
				);
				return commandConsumed();
			}
			return usage("Usage: /session [info|delete]", runtime);
		},
		handleTui: async (command, runtime) => {
			const sub = command.args.trim().toLowerCase() || "info";
			if (sub === "delete") {
				runtime.ctx.editor.setText("");
				await runtime.ctx.handleSessionDeleteCommand();
				return;
			}
			// Default: show session info
			await runtime.ctx.handleSessionCommand();
			runtime.ctx.editor.setText("");
		},
	},
	{
		name: "jobs",
		description: "Show async background jobs status",
		acpDescription: "Show background jobs",
		handle: async (_command, runtime) => {
			const snapshot = runtime.session.getAsyncJobSnapshot({ recentLimit: 5 });
			if (!snapshot || (snapshot.running.length === 0 && snapshot.recent.length === 0)) {
				await runtime.output(
					"No background jobs running. (Background jobs run async tools — e.g. long-running bash, debug, or task subagents that would otherwise tie up a turn. They appear here while alive and for ~5 minutes after.)",
				);
				return commandConsumed();
			}
			const now = Date.now();
			const lines: string[] = ["Background Jobs", `Running: ${snapshot.running.length}`];
			if (snapshot.running.length > 0) {
				lines.push("", "Running Jobs");
				for (const job of snapshot.running) {
					lines.push(`  [${job.id}] ${job.type} (${job.status}) — ${formatDuration(jobElapsedMs(job, now))}`);
					lines.push(`    ${job.label}`);
				}
			}
			if (snapshot.recent.length > 0) {
				lines.push("", "Recent Jobs");
				for (const job of snapshot.recent) {
					lines.push(`  [${job.id}] ${job.type} (${job.status}) — ${formatDuration(jobElapsedMs(job, now))}`);
					lines.push(`    ${job.label}`);
				}
			}
			await runtime.output(lines.join("\n"));
			return commandConsumed();
		},
		handleTui: async (_command, runtime) => {
			await runtime.ctx.handleJobsCommand();
			runtime.ctx.editor.setText("");
		},
	},
	{
		name: "context",
		description: "Show active context token usage breakdown",
		acpDescription: "Show active context token usage breakdown",
		handle: async (_command, runtime) => {
			await runtime.output(buildContextReportText(runtime));
			return commandConsumed();
		},
		handleTui: (_command, runtime) => {
			runtime.ctx.handleContextCommand();
			runtime.ctx.editor.setText("");
		},
	},
	{
		name: "usage",
		description: "Show provider usage and limits",
		acpDescription: "Show token usage",
		handle: async (_command, runtime) => {
			await runtime.output(await buildUsageReportText(runtime));
			return commandConsumed();
		},
		handleTui: async (_command, runtime) => {
			await runtime.ctx.handleUsageCommand();
			runtime.ctx.editor.setText("");
		},
	},
	{
		name: "changelog",
		description: "Show release notes and changelog entries",
		inlineHint: "[full|--full]",
		subcommands: [{ name: "full", description: "Show complete changelog" }],
		allowArgs: true,
		handle: async (command, runtime) => {
			const parsed = parseChangelogCommandArgs(command.args);
			if ("error" in parsed) return usage(parsed.error, runtime);
			await runtime.output(buildChangelogCommandOutput(parsed.showFull));
			return commandConsumed();
		},
		handleTui: async (command, runtime) => {
			const parsed = parseChangelogCommandArgs(command.args);
			if ("error" in parsed) {
				runtime.ctx.showError(parsed.error);
				runtime.ctx.editor.setText("");
				return;
			}
			await runtime.ctx.handleChangelogCommand(parsed.showFull);
			runtime.ctx.editor.setText("");
		},
	},
	{
		name: "help",
		priority: 100,
		description: "Learn commands and beginner workflows",
		handleTui: (_command, runtime) => {
			runtime.ctx.handleHelpCommand();
			runtime.ctx.editor.setText("");
		},
	},
	{
		name: "hotkeys",
		description: "Show all keyboard shortcuts",
		handleTui: (_command, runtime) => {
			runtime.ctx.handleHotkeysCommand();
			runtime.ctx.editor.setText("");
		},
	},
	{
		name: "tools",
		description: "Show tools currently visible to the agent",
		acpDescription: "Show available tools",
		handle: async (_command, runtime) => {
			const active = runtime.session.getActiveToolNames();
			const all = runtime.session.getAllToolNames();
			if (all.length === 0) {
				await runtime.output("No tools are available.");
				return commandConsumed();
			}
			await runtime.output(all.map(name => `${active.includes(name) ? "*" : "-"} ${name}`).join("\n"));
			return commandConsumed();
		},
		handleTui: (_command, runtime) => {
			runtime.ctx.handleToolsCommand();
			runtime.ctx.editor.setText("");
		},
	},
	{
		name: "agents",
		description: "Open Agent Control Center dashboard",
		handleTui: (_command, runtime) => {
			runtime.ctx.showAgentsDashboard();
			runtime.ctx.editor.setText("");
		},
	},
	{
		name: "monitors",
		description: "Open the monitor/cron jobs overlay",
		handleTui: (_command, runtime) => {
			runtime.ctx.showJobsOverlay();
			runtime.ctx.editor.setText("");
		},
	},
	{
		name: "tree",
		description: "Navigate session tree (switch branches)",
		handleTui: (_command, runtime) => {
			runtime.ctx.showTreeSelector();
			runtime.ctx.editor.setText("");
		},
	},

	{
		name: "provider",
		description: "Set up API-compatible providers or login providers",
		inlineHint: "add|login",
		allowArgs: true,
		handle: async (command, runtime) => {
			const args = command.args.trim();
			if (!args || args === "help") {
				await runtime.output(providerSetupUsage());
				return commandConsumed();
			}
			if (args === "login" || args.startsWith("login ")) {
				const providerId = args.slice("login".length).trim();
				const loginCommand = providerId ? `/login ${providerId}` : "/login [provider-id]";
				await runtime.output(
					`Open the terminal UI and run ${loginCommand} for OAuth/subscription account login. Paste callbacks with /login <redirect URL or code>.`,
				);
				return commandConsumed();
			}
			if (!args.startsWith("add ")) return usage(providerSetupUsage(), runtime);
			const parsed = parseProviderSetupSlashArgs(args.slice(4));
			const missing: string[] = [];
			if (!parsed.preset) {
				if (!parsed.compat) missing.push("--compat");
				if (!parsed.provider) missing.push("--provider");
				if (!parsed.baseUrl) missing.push("--base-url");
			}
			if (parsed.rejectedRawApiKey) {
				return usage("Provider setup rejects raw --api-key values; use --api-key-env <ENV> instead.", runtime);
			}
			if (!parsed.preset) {
				if (!parsed.apiKeyEnv) missing.push("--api-key-env");
				if (parsed.models.length === 0) missing.push("--model");
			}
			if (missing.length > 0) {
				return usage(
					`Missing required option(s): ${missing.join(", ")}. Or use /provider add --preset <preset>.`,
					runtime,
				);
			}
			try {
				const result = await addApiCompatibleProvider({
					compatibility: parsed.compat ? parseProviderCompatibility(parsed.compat) : undefined,
					preset: parsed.preset,
					providerId: parsed.provider,
					baseUrl: parsed.baseUrl,
					apiKeyEnv: parsed.apiKeyEnv,
					models: parsed.models,
					force: parsed.force,
				});
				await runtime.session.modelRegistry.refresh("offline");
				await runtime.output(formatProviderSetupResult(result));
				await runtime.notifyConfigChanged?.();
				return commandConsumed();
			} catch (err) {
				return usage(`Provider setup failed: ${errorMessage(err)}`, runtime);
			}
		},
		handleTui: async (command, runtime) => {
			const args = command.args.trim();
			if (!args) {
				runtime.ctx.showProviderOnboarding();
				runtime.ctx.editor.setText("");
				return;
			}
			if (args === "help") {
				runtime.ctx.showStatus(providerSetupUsage());
				runtime.ctx.editor.setText("");
				return;
			}
			if (args === "login" || args.startsWith("login ")) {
				const providerId = args.slice("login".length).trim() || undefined;
				await runtime.ctx.showOAuthSelector("login", providerId);
				runtime.ctx.editor.setText("");
				return;
			}
			if (args.startsWith("add ")) {
				const parsed = parseProviderSetupSlashArgs(args.slice(4));
				try {
					if (parsed.rejectedRawApiKey) {
						throw new Error("Provider setup rejects raw --api-key values; use --api-key-env <ENV> instead.");
					}
					const result = await addApiCompatibleProvider({
						compatibility: parsed.compat ? parseProviderCompatibility(parsed.compat) : undefined,
						preset: parsed.preset,
						providerId: parsed.provider,
						baseUrl: parsed.baseUrl,
						apiKeyEnv: parsed.apiKeyEnv,
						models: parsed.models,
						force: parsed.force,
					});
					await runtime.ctx.session.modelRegistry.refresh("offline");
					runtime.ctx.showStatus(formatProviderSetupResult(result));
				} catch (err) {
					runtime.ctx.showError(`Provider setup failed: ${errorMessage(err)}`);
				}
				runtime.ctx.editor.setText("");
				return;
			}
			runtime.ctx.showStatus(providerSetupUsage());
			runtime.ctx.editor.setText("");
		},
	},
	{
		name: "login",
		description: "Login with OAuth provider",
		inlineHint: "[provider|redirect URL]",
		allowArgs: true,
		handleTui: (command, runtime) => {
			const manualInput = runtime.ctx.oauthManualInput;
			const args = command.args.trim();
			if (args.length > 0) {
				const matchedProvider = getOAuthProviders().find(provider => provider.id === args);
				if (matchedProvider) {
					if (manualInput.hasPending()) {
						const pendingProvider = manualInput.pendingProviderId;
						const message = pendingProvider
							? `OAuth login already in progress for ${pendingProvider}. Paste the redirect URL with /login <url>.`
							: "OAuth login already in progress. Paste the redirect URL with /login <url>.";
						runtime.ctx.showWarning(message);
						runtime.ctx.editor.setText("");
						return;
					}
					void runtime.ctx.showOAuthSelector("login", matchedProvider.id);
					runtime.ctx.editor.setText("");
					return;
				}
				const submitted = manualInput.submit(args);
				if (submitted) {
					runtime.ctx.showStatus("OAuth callback received; completing login…");
				} else {
					runtime.ctx.showWarning("No OAuth login is waiting for a manual callback.");
				}
				runtime.ctx.editor.setText("");
				return;
			}

			if (manualInput.hasPending()) {
				const provider = manualInput.pendingProviderId;
				const message = provider
					? `OAuth login already in progress for ${provider}. Paste the redirect URL with /login <url>.`
					: "OAuth login already in progress. Paste the redirect URL with /login <url>.";
				runtime.ctx.showWarning(message);
				runtime.ctx.editor.setText("");
				return;
			}

			runtime.ctx.showOAuthSelector("login", undefined, {
				allowExternalCredentialDiscovery: true,
				trigger: "bare-login",
			});
			runtime.ctx.editor.setText("");
		},
	},
	{
		name: "logout",
		description: "Logout from OAuth provider",
		inlineHint: "[provider]",
		allowArgs: true,
		handleTui: (command, runtime) => {
			const providerId = command.args.trim() || undefined;
			void runtime.ctx.showOAuthSelector("logout", providerId);
			runtime.ctx.editor.setText("");
		},
	},
	{
		name: "ssh",
		description: "Manage SSH hosts (add, list, remove)",
		acpDescription: "Manage SSH connections",
		inlineHint: "<subcommand>",
		subcommands: [
			{
				name: "add",
				description: "Add an SSH host",
				usage: "<name> --host <host> [--user <user>] [--port <port>] [--key <keyPath>]",
			},
			{ name: "list", description: "List all configured SSH hosts" },
			{ name: "remove", description: "Remove an SSH host", usage: "<name> [--scope project|user]" },
			{ name: "help", description: "Show help message" },
		],
		allowArgs: true,
		handle: handleSshAcp,
		handleTui: async (command, runtime) => {
			runtime.ctx.editor.addToHistory(command.text);
			runtime.ctx.editor.setText("");
			await runtime.ctx.handleSSHCommand(command.text);
		},
	},
	{
		name: "clear",
		priority: 97,
		description: "Clear context while preserving this session ID",
		acpDescription: "Clear context while preserving this session ID",
		handle: async (_command, runtime) => {
			const beforeSessionId = runtime.session.sessionId;
			await runtime.session.clearContext();
			await runtime.output(`Context cleared. Session preserved: ${beforeSessionId}`);
			return commandConsumed();
		},
		handleTui: async (_command, runtime) => {
			runtime.ctx.editor.setText("");
			await runtime.ctx.handleContextClearCommand();
		},
	},
	{
		name: "new",
		priority: 96,
		description: "Start a new session",
		handleTui: async (_command, runtime) => {
			runtime.ctx.editor.setText("");
			await runtime.ctx.handleClearCommand();
		},
	},
	{
		name: "drop",
		description: "Delete the current session and start a new one",
		handleTui: async (_command, runtime) => {
			runtime.ctx.editor.setText("");
			await runtime.ctx.handleDropCommand();
		},
	},
	{
		name: "compact",
		priority: 72,
		description: "Compact context and continue this session",
		acpDescription: "Compact the conversation",
		inlineHint: "[focus instructions]",
		allowArgs: true,
		handle: async (command, runtime) => {
			const before = runtime.session.getContextUsage?.();
			const beforeTokens = before?.tokens;
			try {
				await runtime.session.compact(command.args || undefined);
			} catch (err) {
				// Compaction precondition failures (no model, already compacted, too
				// small) and provider errors propagate as plain Errors; surface them
				// via runtime.output so they don't fail the ACP prompt turn.
				return usage(`Compaction failed: ${errorMessage(err)}`, runtime);
			}
			const after = runtime.session.getContextUsage?.();
			const afterTokens = after?.tokens;
			if (beforeTokens != null && afterTokens != null) {
				const saved = beforeTokens - afterTokens;
				await runtime.output(`Compaction complete. Tokens: ${beforeTokens} -> ${afterTokens} (saved ${saved}).`);
			} else {
				await runtime.output("Compaction complete.");
			}
			return commandConsumed();
		},
		handleTui: async (command, runtime) => {
			const customInstructions = command.args || undefined;
			runtime.ctx.editor.setText("");
			await runtime.ctx.handleCompactCommand(customInstructions);
		},
	},
	{
		name: "contribute-pr",
		aliases: ["contribution-prep"],
		description: "Dump redacted session context and spawn a fresh contribute-pr worker",
		inlineHint: "[focus instructions]",
		allowArgs: true,
		handle: async (command, runtime) => {
			const result = await runtime.session.prepareContributionPrep({
				customInstructions: command.args || undefined,
				spawnWorker: true,
			});
			await runtime.output(
				[
					"Contribution prep artifacts written.",
					`Manifest: ${result.manifestPath}`,
					`Worker prompt: ${result.workerPromptPath}`,
				].join("\n"),
			);
			return commandConsumed();
		},
		handleTui: async (command, runtime) => {
			await runtime.ctx.handleContributionPrepCommand(command.args || undefined);
		},
	},
	{
		name: "resume",
		priority: 92,
		description: "Resume a previous session",
		handleTui: (_command, runtime) => {
			runtime.ctx.showSessionSelector();
			runtime.ctx.editor.setText("");
		},
	},
	{
		name: "btw",
		description: "Ask an ephemeral side question using the current session context",
		inlineHint: "<question>",
		allowArgs: true,
		handleTui: async (command, runtime) => {
			const question = command.text.slice(`/${command.name}`.length).trim();
			runtime.ctx.editor.setText("");
			await runtime.ctx.handleBtwCommand(question);
		},
	},
	{
		name: "retry",
		priority: 70,
		description: "Retry or continue the last interrupted turn",
		handleTui: async (_command, runtime) => {
			const didRetry = await runtime.ctx.session.retry();
			if (!didRetry) {
				runtime.ctx.showStatus("Nothing to retry");
			}
			runtime.ctx.editor.setText("");
		},
	},
	{
		name: "background",
		aliases: ["bg"],
		description: "Detach UI and continue running in background",
		handleTui: (_command, runtime) => {
			runtime.ctx.editor.setText("");
			runtime.handleBackgroundCommand();
		},
	},
	{
		name: "debug",
		description: "Open debug tools selector",
		handleTui: (_command, runtime) => {
			runtime.ctx.showDebugSelector();
			runtime.ctx.editor.setText("");
		},
	},
	{
		name: "memory",
		description: "Inspect and operate memory maintenance",
		acpDescription: "Manage memory",
		acpInputHint: "<subcommand>",
		subcommands: [
			{ name: "view", description: "Show current memory injection payload" },
			{ name: "clear", description: "Clear persisted memory data and artifacts" },
			{ name: "reset", description: "Alias for clear" },
			{ name: "enqueue", description: "Enqueue memory consolidation maintenance" },
			{ name: "rebuild", description: "Alias for enqueue" },
			{ name: "mm list", description: "List mental models on the active bank" },
			{ name: "mm show", description: "Show one mental model (id required)" },
			{
				name: "mm refresh",
				description: "Refresh auto-refresh models bank-wide, or one model by id",
			},
			{ name: "mm history", description: "Diff the change history of a mental model" },
			{ name: "mm seed", description: "Create any built-in mental models that are missing" },
			{ name: "mm delete", description: "Delete a mental model from the bank (id required)" },
			{ name: "mm reload", description: "Re-pull the cached <mental_models> block" },
		],
		allowArgs: true,
		handle: async (command, runtime) => {
			const verb = (command.args.trim().split(/\s+/)[0] ?? "").toLowerCase() || "view";
			const backend = resolveMemoryBackend(runtime.settings);
			switch (verb) {
				case "view": {
					const payload = await backend.buildDeveloperInstructions(
						runtime.settings.getAgentDir(),
						runtime.settings,
						runtime.session,
					);
					await runtime.output(
						payload || "Memory payload is empty; durable memory is unavailable or unconfirmed.",
					);
					return commandConsumed();
				}
				case "clear":
				case "reset": {
					await backend.clear(runtime.settings.getAgentDir(), runtime.cwd, runtime.session);
					await runtime.session.refreshBaseSystemPrompt();
					await runtime.output("Memory cleared.");
					return commandConsumed();
				}
				case "enqueue":
				case "rebuild": {
					await backend.enqueue(runtime.settings.getAgentDir(), runtime.cwd, runtime.session);
					await runtime.output("Memory consolidation enqueued.");
					return commandConsumed();
				}
				case "mm":
					return usage(
						"Mental-model maintenance via /memory mm is unsupported in ACP mode; use the hindsight HTTP API directly.",
						runtime,
					);
				default:
					return usage("Usage: /memory <view|clear|reset|enqueue|rebuild>", runtime);
			}
		},
		handleTui: async (command, runtime) => {
			runtime.ctx.editor.setText("");
			await runtime.ctx.handleMemoryCommand(command.text);
		},
	},
	{
		name: "rename",
		description: "Rename the current session",
		inlineHint: "<title>",
		allowArgs: true,
		handle: async (command, runtime) => {
			if (!command.args) return usage("Usage: /rename <title>", runtime);
			const ok = await runtime.sessionManager.setSessionName(command.args, "user");
			if (!ok) {
				await runtime.output("Session name not changed (a user-set name takes precedence).");
				return commandConsumed();
			}
			await runtime.notifyTitleChanged?.();
			await runtime.output(`Session renamed to ${command.args}.`);
			return commandConsumed();
		},
		handleTui: async (command, runtime) => {
			const title = command.args.trim();
			if (!title) {
				runtime.ctx.showError("Usage: /rename <title>");
				runtime.ctx.editor.setText("");
				return;
			}
			runtime.ctx.editor.setText("");
			await runtime.ctx.handleRenameCommand(title);
		},
	},
	{
		name: "move",
		description: "Move session to a different working directory",
		acpDescription: "Move the current session file",
		inlineHint: "<path>",
		allowArgs: true,
		handle: async (command, runtime) => {
			if (runtime.session.isStreaming) return usage("Cannot move while streaming.", runtime);
			if (!command.args) return usage("Usage: /move <path>", runtime);
			const resolvedPath = path.resolve(runtime.cwd, command.args);
			let isDirectory: boolean;
			try {
				isDirectory = (await fs.stat(resolvedPath)).isDirectory();
			} catch {
				return usage(`Directory does not exist or is not a directory: ${resolvedPath}`, runtime);
			}
			if (!isDirectory) return usage(`Directory does not exist or is not a directory: ${resolvedPath}`, runtime);
			try {
				await runtime.sessionManager.flush();
				await runtime.sessionManager.moveTo(resolvedPath);
			} catch (err) {
				return usage(`Move failed: ${errorMessage(err)}`, runtime);
			}
			setProjectDir(resolvedPath);
			// Reload plugin/capability caches so the next prompt sees commands and
			// capabilities scoped to the new cwd.
			await runtime.reloadPlugins();
			await runtime.notifyTitleChanged?.();
			await runtime.output(`Session moved to ${runtime.sessionManager.getCwd()}.`);
			return commandConsumed();
		},
		handleTui: async (command, runtime) => {
			const targetPath = command.args;
			if (!targetPath) {
				runtime.ctx.showError("Usage: /move <path>");
				runtime.ctx.editor.setText("");
				return;
			}
			runtime.ctx.editor.setText("");
			await runtime.ctx.handleMoveCommand(targetPath);
		},
	},
	{
		name: "exit",
		aliases: ["quit"],
		description: "Exit the application",
		handleTui: shutdownHandlerTui,
	},
];

const QUARANTINED_UTILITY_SLASH_COMMANDS = new Set(["agents"]);

const ACTIVE_BUILTIN_SLASH_COMMAND_REGISTRY: ReadonlyArray<SlashCommandSpec> = BUILTIN_SLASH_COMMAND_REGISTRY.filter(
	command => !QUARANTINED_UTILITY_SLASH_COMMANDS.has(command.name),
);

const BUILTIN_SLASH_COMMAND_LOOKUP = new Map<string, SlashCommandSpec>();
for (const command of ACTIVE_BUILTIN_SLASH_COMMAND_REGISTRY) {
	BUILTIN_SLASH_COMMAND_LOOKUP.set(command.name, command);
	for (const alias of command.aliases ?? []) {
		BUILTIN_SLASH_COMMAND_LOOKUP.set(alias, command);
	}
}

export function formatUnknownBuiltinSlashCommandDiagnostic(commandName: string): string | undefined {
	if (commandName !== "provicer") return undefined;
	return [
		"Unknown slash command: /provicer.",
		"Did you mean /provider?",
		"Run: /provider add --compat <openai|anthropic> --provider <id> --base-url <url> --api-key-env <ENV> --model <model>",
	].join("\n");
}

/** Builtin command metadata used for slash-command autocomplete and help text. */
export const BUILTIN_SLASH_COMMAND_DEFS: ReadonlyArray<BuiltinSlashCommand> = ACTIVE_BUILTIN_SLASH_COMMAND_REGISTRY.map(
	command => ({
		name: command.name,
		description: command.description,
		subcommands: command.subcommands,
		inlineHint: command.inlineHint,
		priority: command.priority,
	}),
);

/**
 * Unified registry exposed for cross-mode tooling. Each spec carries at least
 * one of `handle` / `handleTui`. The TUI dispatcher prefers `handleTui`; the
 * ACP dispatcher requires `handle` and skips TUI-only entries.
 */
export const BUILTIN_SLASH_COMMANDS_INTERNAL: ReadonlyArray<SlashCommandSpec> = ACTIVE_BUILTIN_SLASH_COMMAND_REGISTRY;

/**
 * Execute a builtin slash command in the interactive TUI.
 *
 * Returns `false` when no builtin matched. Returns `true` when a command
 * consumed the input entirely. Returns a `string` when the command was handled
 * but remaining text should be sent as a prompt.
 */
export async function executeBuiltinSlashCommand(
	text: string,
	runtime: BuiltinSlashCommandRuntime,
): Promise<string | boolean> {
	const parsed = parseSlashCommand(text);
	if (!parsed) return false;

	const command = BUILTIN_SLASH_COMMAND_LOOKUP.get(parsed.name);
	if (!command) {
		const diagnostic = formatUnknownBuiltinSlashCommandDiagnostic(parsed.name);
		if (!diagnostic) return false;
		runtime.ctx.showError(diagnostic);
		runtime.ctx.editor.setText("");
		return true;
	}
	if (parsed.args.length > 0 && !command.allowArgs) {
		return false;
	}
	if (command.handleTui) {
		const result = await command.handleTui(parsed, runtime);
		if (result && typeof result === "object" && "prompt" in result) return result.prompt;
		return true;
	}
	if (command.handle) {
		const ctx = runtime.ctx;
		const adapted = toSlashCommandRuntime(runtime);
		const result = await command.handle(parsed, adapted);
		ctx.editor.setText("");
		if (result && typeof result === "object" && "prompt" in result) return result.prompt;
		return true;
	}
	return false;
}

/** Look up a unified spec by name or alias. Used by the ACP dispatcher. */
export function lookupBuiltinSlashCommand(name: string): SlashCommandSpec | undefined {
	return BUILTIN_SLASH_COMMAND_LOOKUP.get(name);
}

export type { ParsedSlashCommand, SlashCommandResult, SlashCommandRuntime, SlashCommandSpec, TuiSlashCommandRuntime };
