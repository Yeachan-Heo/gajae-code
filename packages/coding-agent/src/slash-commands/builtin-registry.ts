import * as fs from "node:fs/promises";
import * as path from "node:path";
import { ThinkingLevel } from "@gajae-code/agent-core";
import { type Model, modelsAreEqual } from "@gajae-code/ai/core";
import { getOAuthProviders } from "@gajae-code/ai/utils/oauth";
import { PET_SKIN_IDS, PET_SKINS, type PetMode, Spacer, Text } from "@gajae-code/tui";
import { jobElapsedMs } from "../async";
import { activateModelProfile, materializeActiveModelProfileAssignments } from "../config/model-profile-activation";
import { formatModelProfileDisplayLabel } from "../config/model-profiles";
import {
	GJC_MODEL_ASSIGNMENT_TARGET_IDS,
	GJC_MODEL_ASSIGNMENT_TARGETS,
	type GjcModelAssignmentTargetId,
	requiresExplicitThinkingChoice,
} from "../config/model-registry";

import {
	extractExplicitThinkingSelector,
	formatModelSelectorValue,
	parseModelPattern,
	parseModelString,
	splitSelectorThinkingSuffix,
} from "../config/model-resolver";
import { clearPluginRootsAndCaches, resolveActiveProjectRegistryPath } from "../discovery/helpers.js";
import { DynamicBorder } from "../modes/components/dynamic-border";
import { getAvailableThemes, getDetectedThemeSettingsPath, setTheme, theme } from "../modes/theme/theme";
import {
	type ComposerSubmissionOptions,
	canApplyComposerSubmission,
	type InteractiveModeContext,
} from "../modes/types";
import { parseUiLanguage, resolveUiLanguage, UI_LANGUAGE_LABELS, UI_LANGUAGES, uiString } from "../modes/ui-language";
// W1b/W5b: notification-service and daemon controllers stay off the static
// import graph; the /notify handlers import them lazily at first use.
import type { NotificationProvider } from "../sdk/bus/config";
import { computeCacheMissCostSummary, formatCacheMissSummaryLines } from "../session/cache-economics";
import { formatProviderSessionImportSummary, runSessionImportCommand } from "../session-import";
import { formatModelOnboardingGuidance } from "../setup/model-onboarding-guidance";
import {
	addApiCompatibleProvider,
	formatProviderPresetList,
	formatProviderSetupResult,
	parseProviderCompatibility,
} from "../setup/provider-onboarding";
import { parseThinkingLevel } from "../thinking";
import { getDisplayChangelogEntries } from "../utils/changelog";
import { handleAsideAcp } from "./helpers/aside";
import { buildAutoroutingStatusReport } from "./helpers/autorouting-status";
import { buildContextReportText } from "./helpers/context-report";
import { switchSessionCredentialCommand } from "./helpers/credential-switch";
import { buildFastStatusReport } from "./helpers/fast-status-report";
import { formatDuration } from "./helpers/format";
import { commandConsumed, errorMessage, parseSlashCommand, parseSubcommand, usage } from "./helpers/parse";
import { handleSshAcp } from "./helpers/ssh";
import { buildUsageReportText, collectCachedUsageReports } from "./helpers/usage-report";
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
export type BuiltinSlashCommandRuntime = TuiSlashCommandRuntime & {
	composer?: ComposerSubmissionOptions;
};

function canClearComposer(runtime: BuiltinSlashCommandRuntime): boolean {
	return canApplyComposerSubmission(runtime.composer, runtime.ctx.editor);
}

const PET_COMMAND_OPTIONS: ReadonlyArray<{ name: string; mode: PetMode; description: string }> = [
	{ name: "off", mode: "off", description: "Hide the pet" },
	...PET_SKIN_IDS.map(id => ({
		name: PET_SKINS[id].label,
		mode: id,
		description: PET_SKINS[id].description,
	})),
];
const PET_COMMAND_HINT = `[${PET_COMMAND_OPTIONS.map(option => option.name).join("|")}]`;
/**
 * Deprecated inputs kept accepted for compatibility (`/pet on|red|blue`).
 * Display, completion, and inline hints stay canonical (`PET_COMMAND_OPTIONS`).
 */
const PET_COMMAND_DEPRECATED_INPUTS: Readonly<Record<string, PetMode>> = {
	on: "red",
	red: "red",
	blue: "blue",
};

type GjcModelBatchAssignmentTargetId = "all-role-agents" | "all-targets";
type ParsedModelCommandArgs =
	| { kind: "summary" }
	| {
			kind: "assign";
			targetId: GjcModelAssignmentTargetId | GjcModelBatchAssignmentTargetId;
			selector: string;
			hasExplicitTarget: boolean;
	  };

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

async function updateSessionStar(
	starred: boolean,
	command: ParsedSlashCommand,
	runtime: SlashCommandRuntime,
): Promise<SlashCommandResult> {
	if (command.args) return usage(`Usage: /${starred ? "star" : "unstar"}`, runtime);
	if (!runtime.sessionManager.isPersisted()) {
		await runtime.output("Session stars require a persisted session.");
		return commandConsumed();
	}
	const changed = await runtime.sessionManager.setSessionStarred(starred);
	await runtime.output(
		changed
			? starred
				? "Session starred."
				: "Session unstarred."
			: starred
				? "Session is already starred."
				: "Session is not starred.",
	);
	return commandConsumed();
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
		"Presets: /provider add --preset <id> [--force]",
		"Aliases include minimax, zai, alibaba, cline, command-code, and goat.",
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
		if (targetId) return { kind: "assign", targetId, selector: tokens.slice(2).join(" "), hasExplicitTarget: true };
		return { kind: "assign", targetId: "default", selector: tokens.slice(1).join(" "), hasExplicitTarget: false };
	}

	const explicitTarget = parseTarget(first);
	if (explicitTarget) {
		return { kind: "assign", targetId: explicitTarget, selector: tokens.slice(1).join(" "), hasExplicitTarget: true };
	}
	if (first === "set") {
		const targetId = parseTarget(tokens[1]);
		if (targetId) return { kind: "assign", targetId, selector: tokens.slice(2).join(" "), hasExplicitTarget: true };
	}
	return { kind: "assign", targetId: "default", selector: args.trim(), hasExplicitTarget: false };
}
/**
 * Optional namespace prefix accepted on `/model <preset>` selectors so users
 * can disambiguate preset names from model ids with `gajae-code/<preset>`.
 * The bare preset name remains the canonical form.
 */
const MODEL_PRESET_NAMESPACE_PREFIX = "gajae-code/";

/**
 * Resolve a `/model <selector>` argument against the merged model-profile
 * registry. Returns the canonical profile name when `selector` is either a
 * bare preset name (`codex-medium`) or a namespaced one
 * (`gajae-code/codex-medium`); returns `undefined` otherwise so the caller
 * falls through to ordinary model resolution.
 *
 * Only selectors that do NOT look like `provider/model` references are
 * considered, so `/model anthropic/claude-...` is never hijacked by a preset.
 */
export function resolvePresetSelector(
	selector: string,
	modelRegistry: { getModelProfile?: (name: string) => unknown; getError?: () => unknown },
): string | undefined {
	const trimmed = selector.trim();
	if (!trimmed) return undefined;

	// Reject `provider/model` references outright: even if a preset happened to
	// be named `anthropic/claude`, the slash form is a model selector, not a
	// preset shortcut. The only accepted slash form is the `gajae-code/`
	// namespace prefix.
	if (trimmed.includes("/")) {
		if (!trimmed.toLowerCase().startsWith(MODEL_PRESET_NAMESPACE_PREFIX)) return undefined;
		const stripped = trimmed.slice(MODEL_PRESET_NAMESPACE_PREFIX.length);
		if (!stripped || stripped.includes("/")) return undefined;
		return matchProfileName(stripped, modelRegistry);
	}

	return matchProfileName(trimmed, modelRegistry);
}

function matchProfileName(
	candidate: string,
	modelRegistry: { getModelProfile?: (name: string) => unknown; getError?: () => unknown },
): string | undefined {
	// A registry load error means we cannot trust the profile index; fall
	// through to model resolution rather than guessing. A registry without a
	// getModelProfile surface (e.g. a minimal test fixture) has no presets.
	if (modelRegistry.getError?.()) return undefined;
	return modelRegistry.getModelProfile?.(candidate) ? candidate : undefined;
}

function splitExplicitThinkingSelector(selector: string): { baseSelector: string; thinkingLevel?: ThinkingLevel } {
	const trimmed = selector.trim();
	const { selector: baseSelector, thinkingLevel } = splitSelectorThinkingSuffix(trimmed);
	// Preserve the whole selector when the trailing suffix is not a valid thinking level.
	return thinkingLevel ? { baseSelector, thinkingLevel } : { baseSelector: trimmed };
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
		sessionId: runtime.session.sessionId,
		credentialSessionId: runtime.session.credentialSessionId,
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
		return `All model targets set to ${selector} for DEFAULT, EXECUTOR, ARCHITECT, PLANNER, CRITIC, IMAGE.`;
	}
	if (targetId === "default") return `Default model set to ${selector}.`;
	return `${targetId} agent model set to ${selector}.`;
}

function modelSelectionUsage(runtime: SlashCommandRuntime, currentModelLine?: string): string {
	return [
		currentModelLine,
		formatModelAssignmentSummary(runtime),
		"Use /model <model> for DEFAULT, or /model <target> <model[:effort]> for EXECUTOR, ARCHITECT, PLANNER, or CRITIC.",
		"Use /model <preset> or /model gajae-code/<preset> to activate a known model profile.",
		formatModelOnboardingGuidance(),
	]
		.filter((line): line is string => Boolean(line))
		.join("\n\n");
}

type SlashModelControlSession = SlashCommandRuntime["session"] & {
	withSdkControlMutation?: <T>(body: () => Promise<T>) => Promise<T>;
	activateModelProfileForControl?: (profileName: string) => Promise<boolean>;
	captureSessionIdentityForMode?: () => unknown;
	isSessionIdentityCurrentForMode?: (admission: unknown) => boolean;
	isSessionTransitioning?: boolean;
};

function slashModelSession(runtime: SlashCommandRuntime): SlashModelControlSession {
	return runtime.session as SlashModelControlSession;
}

function captureSlashModelIdentity(runtime: SlashCommandRuntime): unknown {
	return slashModelSession(runtime).captureSessionIdentityForMode?.();
}

function assertSlashModelIdentity(runtime: SlashCommandRuntime, admission: unknown): void {
	const session = slashModelSession(runtime);
	if (
		admission !== undefined &&
		session.isSessionIdentityCurrentForMode &&
		!session.isSessionIdentityCurrentForMode(admission)
	) {
		throw new Error("Session changed while selecting model");
	}
	if (admission === undefined && session.isSessionTransitioning === true) {
		throw new Error("Session changed while selecting model");
	}
}

async function withSlashModelControlMutation<T>(runtime: SlashCommandRuntime, body: () => Promise<T>): Promise<T> {
	const session = slashModelSession(runtime);
	return session.withSdkControlMutation ? session.withSdkControlMutation(body) : body();
}

/** Opt into the paste-a-code OAuth login for browsers that cannot reach this machine. */
const MANUAL_LOGIN_FLAG = "--manual";

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

type NotifyServiceArgs = { provider?: NotificationProvider; probe: boolean; message?: string } | { error: string };

function isNotificationProvider(value: string): value is NotificationProvider {
	return value === "telegram" || value === "discord" || value === "slack";
}

function parseNotifyServiceArgs(input: string, allowMessage: boolean): NotifyServiceArgs {
	const tokens = input.trim().split(/\s+/).filter(Boolean);
	let provider: NotificationProvider | undefined;
	let probe = false;
	const message: string[] = [];
	for (let index = 0; index < tokens.length; index += 1) {
		const token = tokens[index]!;
		if (token === "--probe") {
			if (allowMessage) return { error: "--probe is valid only for /notify health." };
			probe = true;
			continue;
		}
		if (token === "--provider" || token.startsWith("--provider=")) {
			const value = token === "--provider" ? tokens[++index] : token.slice("--provider=".length);
			if (!value || !isNotificationProvider(value)) {
				return { error: "--provider must be telegram, discord, or slack." };
			}
			if (provider && provider !== value) return { error: "Conflicting notification providers were supplied." };
			provider = value;
			continue;
		}
		if (!provider && message.length === 0 && isNotificationProvider(token)) {
			provider = token;
			continue;
		}
		if (token.startsWith("--")) return { error: `Unknown notification option: ${token}` };
		message.push(token);
	}
	if (!allowMessage && message.length > 0) return { error: "Health accepts only a provider and --probe." };
	return {
		...(provider ? { provider } : {}),
		probe,
		...(message.length > 0 ? { message: message.join(" ") } : {}),
	};
}

const shutdownHandlerTui = (_command: ParsedSlashCommand, runtime: TuiSlashCommandRuntime): SlashCommandResult => {
	runtime.ctx.editor.setText("");
	void runtime.ctx.shutdown();
	return commandConsumed();
};

const IMPORT_SESSION_RETAINED_DESCRIPTOR_AUTHORITY_AVAILABLE = process.platform === "linux";

const BUILTIN_SLASH_COMMAND_REGISTRY: ReadonlyArray<SlashCommandSpec> = [
	{
		name: "aside",
		priority: 32,
		description: "Run the Aside CLI from the composer",
		acpDescription: "Run the Aside CLI",
		subcommands: [
			{ name: "exec", description: "Run Aside with a prompt", usage: "[args] <prompt>" },
			{ name: "repl", description: "Aside REPL is terminal-only; prints the outside command" },
			{ name: "mcp", description: "Print MCP registration using the resolved CLI path" },
			{ name: "account", description: "Inspect or select Aside CLI accounts", usage: "[list|status|use]" },
			{ name: "help", description: "Show /aside usage" },
		],
		inlineHint: "[exec|repl|mcp|account|help|<prompt>]",
		acpInputHint: "[exec|repl|mcp|account|help|<prompt>]",
		allowArgs: true,
		localHeadless: true,
		handle: handleAsideAcp,
	},
	{
		name: "import-session",
		priority: 29,
		description: "Import a Codex or Claude transcript into native GJC history",
		inlineHint: "<transcript-file> [--provider codex|claude]",
		allowArgs: true,
		acp: false,
		localHeadless: true,
		handle: async (command, runtime) => {
			if (runtime.session?.isStreaming) return usage("Cannot import a session while streaming.", runtime);
			const outcome = await runSessionImportCommand(command.args, runtime.cwd);
			if (outcome.kind === "error") {
				await runtime.output(outcome.message);
				return { consumed: true, exitCode: 1 };
			}
			await runtime.output(formatProviderSessionImportSummary(outcome.result));
			return { consumed: true };
		},
	},
	{
		name: "notify",
		priority: 30,
		description: "Notification status, health, test, recovery, and session on/off",
		acpDescription: "Notification status, health, test, recovery, and session on/off",
		subcommands: [
			{ name: "on", description: "Enable notifications for this session" },
			{ name: "off", description: "Disable notifications for this session" },
			{ name: "status", description: "Show notification configuration (no secrets)" },
			{
				name: "health",
				description: "Config, ownership, endpoint, and selected-provider health",
				usage: "[provider] [--probe]",
			},
			{ name: "test", description: "Send a test notification", usage: "[provider|--provider provider] [message]" },
			{ name: "recovery", description: "Clear dead-owner locks and stale endpoint files" },
			{ name: "setup", description: "How to pair a Telegram bot (run in a terminal)" },
		],
		inlineHint: "[on|off|status|health|test|recovery|setup]",
		acpInputHint: "[on|off|status|health|test|recovery|setup]",
		allowArgs: true,
		handle: async (command, runtime) => {
			const { verb, rest } = parseSubcommand(command.args);
			const action = verb || "status";
			// Session-local notification controls are extension-owned. Always pass them
			// through so this builtin cannot shadow the live per-session command.
			if (action === "on" || action === "off") return { prompt: command.text };
			const stateRoot = path.join(runtime.cwd, ".gjc", "state");
			switch (action) {
				case "status": {
					const { buildNotificationStatusReport, formatNotificationStatusReport } = await import(
						"../sdk/bus/notification-service"
					);
					await runtime.output(formatNotificationStatusReport(buildNotificationStatusReport(runtime.settings)));
					return commandConsumed();
				}
				case "health": {
					const parsed = parseNotifyServiceArgs(rest, false);
					if ("error" in parsed) {
						return usage(`Usage: /notify health [telegram|discord|slack] [--probe]\n${parsed.error}`, runtime);
					}
					const { checkNotificationHealth, formatNotificationHealthReport } = await import(
						"../sdk/bus/notification-service"
					);
					const report = await checkNotificationHealth({
						settings: runtime.settings,
						stateRoot,
						provider: parsed.provider,
						probe: parsed.probe,
					});
					await runtime.output(formatNotificationHealthReport(report));
					return commandConsumed();
				}
				case "test": {
					const parsed = parseNotifyServiceArgs(rest, true);
					if ("error" in parsed) {
						return usage(
							`Usage: /notify test [telegram|discord|slack|--provider provider] [message]\n${parsed.error}`,
							runtime,
						);
					}
					const { sendNotificationTest, formatNotificationTestResult } = await import(
						"../sdk/bus/notification-service"
					);
					const result = await sendNotificationTest({
						settings: runtime.settings,
						provider: parsed.provider,
						text: parsed.message,
						deps: {
							providerRuntimeStatus: async provider => {
								const status =
									provider === "telegram"
										? await new (await import("../sdk/bus/telegram-daemon-control")).TelegramDaemonController(
												runtime.settings,
											).status()
										: await new (await import("../sdk/bus/chat-daemon-control")).ChatDaemonController(
												runtime.settings,
												provider,
											).status();
								return status.health === "running" ? "ready" : "inactive";
							},
						},
					});
					await runtime.output(formatNotificationTestResult(result));
					return commandConsumed();
				}
				case "recovery": {
					const { recoverNotifications, formatNotificationRecoveryReport } = await import(
						"../sdk/bus/notification-service"
					);
					const report = await recoverNotifications({ settings: runtime.settings, stateRoot });
					await runtime.output(formatNotificationRecoveryReport(report));
					return commandConsumed();
				}
				case "setup":
					return usage(
						"Run `gjc notify setup` in a terminal to pair a Telegram bot token with a private chat (interactive; requires a TTY).",
						runtime,
					);
				default:
					return usage(`Usage: /notify [on|off|status|health|test|recovery|setup] (got "${action}")`, runtime);
			}
		},
	},
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
		name: "language",
		priority: 41,
		description: "Change the interactive UI language, or show the current one",
		subcommands: UI_LANGUAGES.map(code => ({ name: code, description: UI_LANGUAGE_LABELS[code] })),
		inlineHint: `[${UI_LANGUAGES.join("|")}]`,
		allowArgs: true,
		handleTui: (command, runtime) => {
			const ctx = runtime.ctx;
			const requested = command.args?.trim() ?? "";
			const current = resolveUiLanguage(ctx.settings.get("ui.language"));
			if (!requested) {
				ctx.showStatus(
					`${uiString(current, "language.current")} ${UI_LANGUAGE_LABELS[current]} · /language [${UI_LANGUAGES.join("|")}]`,
				);
				ctx.editor.setText("");
				return;
			}
			const selected = parseUiLanguage(requested);
			if (!selected) {
				const available = UI_LANGUAGES.map(code => `${code} (${UI_LANGUAGE_LABELS[code]})`).join(", ");
				ctx.showError(`${uiString(current, "language.unknown")}: "${requested}". ${available}`);
				ctx.editor.setText("");
				return;
			}
			if (!ctx.settings.canWriteDurableConfig()) {
				ctx.showError(
					"Cannot change settings while config.yml has invalid YAML syntax. Repair config.yml and reload settings.",
				);
				ctx.editor.setText("");
				return;
			}
			try {
				ctx.settings.set("ui.language", selected);
			} catch (error) {
				ctx.showError(error instanceof Error ? error.message : String(error));
				ctx.editor.setText("");
				return;
			}
			ctx.statusLine.invalidate();
			ctx.ui.invalidate();
			ctx.showStatus(`${uiString(selected, "language.changed")} ${UI_LANGUAGE_LABELS[selected]}`);
			ctx.editor.setText("");
		},
	},
	{
		name: "theme",
		description: "Change theme immediately, or open the theme selector without args",
		inlineHint: "[theme]",
		allowArgs: true,
		handleTui: async (command, runtime) => {
			const ctx = runtime.ctx;
			const name = command.args?.trim();
			if (!name) {
				ctx.showThemeSelector();
				ctx.editor.setText("");
				return;
			}
			const available = await getAvailableThemes();
			if (!available.includes(name)) {
				ctx.showError(`Unknown theme "${name}". Available themes: ${available.join(", ")}`);
				ctx.editor.setText("");
				return;
			}
			if (!ctx.settings.canWriteDurableConfig()) {
				ctx.showError(
					"Cannot change settings while config.yml has invalid YAML syntax. Repair config.yml and reload settings.",
				);
				ctx.editor.setText("");
				return;
			}
			try {
				ctx.settings.set(getDetectedThemeSettingsPath(), name);
			} catch (error) {
				ctx.showError(error instanceof Error ? error.message : String(error));
				ctx.editor.setText("");
				return;
			}
			const result = await setTheme(name, true, { shouldApply: () => !ctx.isStopped?.() });
			if (ctx.isStopped?.()) return;
			ctx.statusLine.invalidate();
			ctx.updateEditorTopBorder();
			ctx.ui.invalidate();
			if (result.success) {
				ctx.showStatus(`Theme changed to ${name}`);
			} else {
				ctx.showError(`Failed to load theme "${name}": ${result.error}\nFell back to dark theme.`);
			}
			ctx.editor.setText("");
		},
	},
	{
		name: "pet",
		description: "Gajae pet living beside the composer",
		subcommands: PET_COMMAND_OPTIONS.map(option => ({ name: option.name, description: option.description })),
		inlineHint: PET_COMMAND_HINT,
		allowArgs: true,
		handleTui: (command, runtime) => {
			const ctx = runtime.ctx;
			const raw = command.args?.trim().toLowerCase() ?? "";
			const arg =
				PET_COMMAND_OPTIONS.find(option => option.name.toLowerCase() === raw)?.mode ??
				PET_COMMAND_DEPRECATED_INPUTS[raw];
			if (!raw) {
				ctx.showPetSelector();
				ctx.editor.setText("");
				return;
			}
			if (arg) {
				// The shared commit policy rechecks capability, persists only on
				// acceptance, and surfaces the actionable warning on rejection.
				if (ctx.setPetMode(arg)) {
					const name = arg === "off" ? "Gajae pet hidden" : `${PET_SKINS[arg].label} is here`;
					ctx.showStatus(name);
				}
			} else {
				ctx.showStatus(`Usage: /pet ${PET_COMMAND_HINT}`, { dim: true });
			}
			ctx.editor.setText("");
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
			await runtime.ctx.goalModeController.handleCommand(command.args || undefined);
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
				const identityAdmission = captureSlashModelIdentity(runtime);
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
				// Preset shortcut: when the selector names a known model profile
				// (optionally `gajae-code/`-prefixed) and the target is implicit,
				// activate the profile immediately instead of treating the preset name
				// as a model id and failing with "Unknown model". Explicit targets,
				// including `/model default <preset>`, remain ordinary assignments.
				if (parsedArgs.targetId === "default" && !parsedArgs.hasExplicitTarget) {
					const presetName = resolvePresetSelector(modelId, runtime.session.modelRegistry);
					if (presetName) {
						try {
							assertSlashModelIdentity(runtime, identityAdmission);
							const profileLabel = formatModelProfileDisplayLabel(
								runtime.session.modelRegistry.getModelProfile(presetName) ?? { name: presetName },
							);
							const session = slashModelSession(runtime);
							if (session.activateModelProfileForControl) {
								await session.activateModelProfileForControl(presetName);
							} else {
								// Lightweight command runtimes used by embedders may not expose
								// the control helper; preserve the established activation path.
								await activateModelProfile(
									{
										session: runtime.session,
										modelRegistry: runtime.session.modelRegistry,
										settings: runtime.settings,
										profileName: presetName,
									},
									{ persistDefault: false },
								);
							}
							assertSlashModelIdentity(runtime, identityAdmission);
							await runtime.output(`Model profile: ${profileLabel}`);
							await runtime.notifyTitleChanged?.();
							await runtime.notifyConfigChanged?.();
							return commandConsumed();
						} catch (err) {
							return usage(`Failed to activate model profile: ${errorMessage(err)}`, runtime);
						}
					}
				}
				const resolution = await resolveModelCommandSelection(runtime, modelId);
				assertSlashModelIdentity(runtime, identityAdmission);
				if (!resolution.ok) {
					return usage(modelSelectionUsage(runtime, resolution.failure.message), runtime);
				}
				const { selection } = resolution;
				if (
					selection.thinkingLevel === undefined &&
					targetIds.some(targetId => requiresExplicitThinkingChoice(selection.model, targetId))
				) {
					return usage(
						modelSelectionUsage(
							runtime,
							`Model ${selection.model.provider}/${selection.model.id} requires an explicit effort suffix.`,
						),
						runtime,
					);
				}
				try {
					return await withSlashModelControlMutation(runtime, async () => {
						assertSlashModelIdentity(runtime, identityAdmission);
						const includesDefault = targetIds.includes("default");
						const includesRoleAgent = targetIds.some(role => role !== "default");
						if (includesRoleAgent) {
							const apiKey = await runtime.session.modelRegistry.getApiKey(
								selection.model,
								runtime.session.credentialSessionId,
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
									: extractExplicitThinkingSelector(
											runtime.settings.getModelRole("default"),
											runtime.settings,
										);
						const persistedSelector = formatModelSelectorValue(selection.selector, existingDefaultThinkingLevel);
						for (const targetId of targetIds) {
							if (targetId === "default") {
								assignments.set(targetId, persistedSelector);
								continue;
							}
							const thinkingLevel =
								selection.thinkingLevel ??
								extractExplicitThinkingSelector(overrides[targetId], runtime.settings);
							assignments.set(targetId, formatModelSelectorValue(selection.selector, thinkingLevel));
						}

						if (includesDefault) {
							await runtime.session.setModel(selection.model, "default", {
								selector: selection.selector,
								thinkingLevel: existingDefaultThinkingLevel,
								cause: "user-selection",
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
					});
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
		name: "routing",
		description: "Show or set up sub-agent model autorouting",
		acpDescription: "Show or set up sub-agent model autorouting",
		inlineHint: "[on|off|status]",
		acpInputHint: "[on|off|status]",
		subcommands: [
			{ name: "on", description: "Enable autorouting" },
			{ name: "off", description: "Disable autorouting" },
			{ name: "status", description: "Show effective autorouting tiers" },
		],
		allowArgs: true,
		handle: async (command, runtime) => {
			const arg = command.args.trim().toLowerCase();
			if (arg === "on" || arg === "off") {
				try {
					// Mirror SelectorController#assertSmartRoutingWritable: the non-TUI (ACP/SDK)
					// dispatch path must honor the same scoped-session guard as the TUI controller,
					// otherwise a --models-scoped session can toggle routing through /routing on|off.
					if ((runtime.session.scopedModels?.length ?? 0) > 0) {
						throw new Error("Smart-routing settings are read-only in a --models-scoped session.");
					}
					runtime.settings.set("task.autorouting.enabled", arg === "on");
				} catch (err) {
					return usage(`Failed to change autorouting: ${errorMessage(err)}`, runtime);
				}
				await runtime.output(
					buildAutoroutingStatusReport({
						effective: runtime.settings.getEffectiveAutorouting(),
						tiers: runtime.settings.get("task.autorouting.tiers"),
						provenance: runtime.settings.get("task.autorouting.provenance"),
					}),
				);

				return commandConsumed();
			}
			if (arg === "" || arg === "status") {
				await runtime.output(
					buildAutoroutingStatusReport({
						effective: runtime.settings.getEffectiveAutorouting(),
						tiers: runtime.settings.get("task.autorouting.tiers"),
						provenance: runtime.settings.get("task.autorouting.provenance"),
					}),
				);

				return commandConsumed();
			}
			return usage("Usage: /routing [on|off|status]", runtime);
		},
		handleTui: async (command, runtime) => {
			const arg = command.args.trim().toLowerCase();
			runtime.ctx.editor.setText("");
			if (arg === "") {
				runtime.ctx.showModelSelector({ smartRoutingOnly: true });
				return;
			}
			if (arg === "on" || arg === "off") {
				// Route through the controller so the toggle honors the same
				// scoped-session and durable-config guards as the panel.
				await runtime.ctx.setAutoroutingEnabled(arg === "on");
			} else if (arg !== "status") {
				runtime.ctx.showStatus("Usage: /routing [on|off|status]");
				return;
			}
			const report = buildAutoroutingStatusReport({
				effective: runtime.ctx.settings.getEffectiveAutorouting(),
				tiers: runtime.ctx.settings.get("task.autorouting.tiers"),
				provenance: runtime.ctx.settings.get("task.autorouting.provenance"),
			});
			runtime.ctx.chatContainer.addChild(new Spacer(1));
			runtime.ctx.chatContainer.addChild(new DynamicBorder());
			runtime.ctx.chatContainer.addChild(new Text(report, 1, 0));
			runtime.ctx.chatContainer.addChild(new DynamicBorder());
			runtime.ctx.ui.requestRender();
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
		name: "transcript",
		description: "Browse the current session transcript",
		acpDescription: "Browse the current session transcript",
		handle: async (_command, runtime) => {
			await runtime.output("Transcript browsing is available in the interactive TUI.");
			return commandConsumed();
		},
		handleTui: (_command, runtime) => {
			if (runtime.ctx.isTranscriptViewerOpen()) return;
			runtime.ctx.showTranscriptViewer();
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
		subcommands: [{ name: "check", description: "Explicitly check account health and usage" }],
		inlineHint: "[check]",
		acpInputHint: "[check]",
		allowArgs: true,
		handle: async (command, runtime) => {
			const args = command.args.trim().toLowerCase();
			if (args !== "" && args !== "check") return usage("Usage: /usage [check]", runtime);
			await runtime.output(await buildUsageReportText(runtime, { check: args === "check" }));
			return commandConsumed();
		},
		handleTui: async (command, runtime) => {
			const args = command.args.trim().toLowerCase();
			if (args !== "" && args !== "check") {
				runtime.ctx.showError("Usage: /usage [check]");
			} else {
				const adapted = toSlashCommandRuntime(runtime);
				// Plain `/usage` renders the graphical panel from the cache-only
				// inventory snapshot — same data the text view reads, no fetch or
				// probe. `/usage check` stays on the text path because its value is
				// the per-credential health verdict, not the bars.
				const cached = args === "" ? collectCachedUsageReports(adapted) : [];
				if (cached.length > 0) {
					await runtime.ctx.handleUsageCommand(cached);
				} else {
					await adapted.output(await buildUsageReportText(adapted, { check: args === "check" }));
				}
			}
			runtime.ctx.editor.setText("");
		},
	},
	{
		name: "credential",
		aliases: ["account"],
		description: "Switch this session's active stored account, or list accounts",
		acpDescription: "Switch or list stored credentials for this session",
		inlineHint: "[email:<addr>|id:<n>|account:<id>|project:<id>|provider/<selector>]",
		acpInputHint: "[selector]",
		allowArgs: true,
		handle: async (command, runtime) => {
			await runtime.output(await switchSessionCredentialCommand(runtime, command.args));
			return commandConsumed();
		},
		handleTui: async (command, runtime) => {
			const result = await switchSessionCredentialCommand(toSlashCommandRuntime(runtime), command.args);
			refreshStatusLine(runtime.ctx);
			runtime.ctx.showStatus(result);
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
		name: "tutorial",
		priority: 99,
		description: "Open frictionless onboarding",
		handleTui: (_command, runtime) => {
			void runtime.ctx.showFrictionlessOnboarding();
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
		name: "extensions",
		description: "Configure skills, hooks, and MCPs.",
		handleTui: (_command, runtime) => {
			runtime.ctx.showCustomizationDashboard();
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
		inlineHint: "[provider|redirect URL] [--manual]",
		allowArgs: true,
		handleTui: (command, runtime) => {
			const manualInput = runtime.ctx.oauthManualInput;
			const args = command.args.trim();
			const pendingLoginMessage = (): string => {
				const pendingProvider = manualInput.pendingProviderId;
				return pendingProvider
					? `OAuth login already in progress for ${pendingProvider}. Paste the redirect URL with /login <url>.`
					: "OAuth login already in progress. Paste the redirect URL with /login <url>.";
			};
			if (args.length > 0) {
				const tokens = args.split(/\s+/);
				// `--manual` is resolved before the paste fallback below, otherwise
				// `/login anthropic --manual` would be submitted as an authorization code.
				if (tokens.includes(MANUAL_LOGIN_FLAG)) {
					const rest = tokens.filter(token => token !== MANUAL_LOGIN_FLAG);
					const requestedProvider = rest.length === 1 ? rest[0] : undefined;
					const manualProvider = requestedProvider
						? getOAuthProviders().find(provider => provider.id === requestedProvider)
						: undefined;
					if (!manualProvider) {
						runtime.ctx.showWarning(`Usage: /login <provider> ${MANUAL_LOGIN_FLAG}`);
						runtime.ctx.editor.setText("");
						return;
					}
					if (manualInput.hasPending()) {
						runtime.ctx.showWarning(pendingLoginMessage());
						runtime.ctx.editor.setText("");
						return;
					}
					void runtime.ctx.showOAuthSelector("login", manualProvider.id, { manualCode: true });
					runtime.ctx.editor.setText("");
					return;
				}
				const matchedProvider = getOAuthProviders().find(provider => provider.id === args);
				if (matchedProvider) {
					if (manualInput.hasPending()) {
						runtime.ctx.showWarning(pendingLoginMessage());
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
				runtime.ctx.showWarning(pendingLoginMessage());
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
		name: "handoff",
		priority: 71,
		description: "Generate a handoff and continue in a new session",
		acpDescription: "Generate a handoff document and start a new session",
		inlineHint: "[focus instructions]",
		acpInputHint: "[focus instructions]",
		allowArgs: true,
		handle: async (command, runtime) => {
			let result: Awaited<ReturnType<typeof runtime.session.handoff>>;
			try {
				result = await runtime.session.handoff(command.args || undefined);
			} catch (err) {
				// Handoff precondition failures (nothing to hand off, streaming),
				// cancellation, and provider errors propagate as plain Errors; the
				// switch is non-destructive so the current session is unchanged.
				return usage(`Handoff failed: ${errorMessage(err)}; current session is unchanged.`, runtime);
			}
			if (!result) {
				return usage(
					"Handoff not created (cancelled or nothing to hand off); current session is unchanged.",
					runtime,
				);
			}
			await runtime.output(
				result.savedPath
					? `Handoff created; new session started. Handoff document saved to: ${result.savedPath}`
					: "Handoff created; new session started with handoff context.",
			);
			return commandConsumed();
		},
		handleTui: async (command, runtime) => {
			runtime.ctx.editor.setText("");
			await runtime.ctx.handleHandoffCommand(command.args || undefined);
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
		name: "star",
		priority: 91,
		description: "Star the current session for easier discovery",
		// Accept args at dispatch so the handler can consume them as a usage error
		// instead of silently forwarding `/star ...` to the model.
		allowArgs: true,
		handle: (command, runtime) => updateSessionStar(true, command, runtime),
	},
	{
		name: "unstar",
		priority: 91,
		description: "Remove the star from the current session",
		// Accept args at dispatch so the handler can consume them as a usage error
		// instead of silently forwarding `/unstar ...` to the model.
		allowArgs: true,
		handle: (command, runtime) => updateSessionStar(false, command, runtime),
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
		name: "sessions",
		priority: 91,
		description: "Show all persisted sessions (read-only)",
		handleTui: (_command, runtime) => {
			runtime.ctx.showSessionsDashboard();
			runtime.ctx.editor.setText("");
		},
	},
	{
		name: "btw",
		description: "Start an ephemeral multi-turn side chat using the current session context",
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
			switch (verb) {
				case "view": {
					const backend = await runtime.session.memoryBackend.get("memory-slash-command");
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
					const backend = await runtime.session.memoryBackend.get("memory-slash-command");
					await backend.clear(runtime.settings.getAgentDir(), runtime.cwd, runtime.session);
					await runtime.session.refreshBaseSystemPrompt();
					await runtime.output("Memory cleared.");
					return commandConsumed();
				}
				case "enqueue":
				case "rebuild": {
					const backend = await runtime.session.memoryBackend.get("memory-slash-command");
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
				await runtime.session.rescopeSessionCwd(resolvedPath, { scope: "any" });
			} catch (err) {
				return usage(`Move failed: ${errorMessage(err)}`, runtime);
			}
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
	command =>
		!QUARANTINED_UTILITY_SLASH_COMMANDS.has(command.name) &&
		(command.name !== "import-session" || IMPORT_SESSION_RETAINED_DESCRIPTOR_AUTHORITY_AVAILABLE),
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
		if (canClearComposer(runtime)) {
			runtime.ctx.editor.setText("");
		}
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
		if (canClearComposer(runtime)) {
			ctx.editor.setText("");
		}
		if (result && typeof result === "object" && "prompt" in result) return result.prompt;
		return true;
	}
	return false;
}

/** Dispatch a command explicitly authorized for trusted local non-interactive mode. */
export async function executeLocalHeadlessBuiltinSlashCommand(
	text: string,
	runtime: SlashCommandRuntime,
): Promise<false | Exclude<SlashCommandResult, undefined>> {
	const parsed = parseSlashCommand(text);
	if (!parsed) return false;
	const command = BUILTIN_SLASH_COMMAND_LOOKUP.get(parsed.name);
	if (!command?.handle || command.localHeadless !== true) return false;
	if (parsed.args.length > 0 && !command.allowArgs) return false;
	return (await command.handle(parsed, runtime)) ?? { consumed: true };
}
/** Look up a unified spec by name or alias. Used by the ACP dispatcher. */
export function lookupBuiltinSlashCommand(name: string): SlashCommandSpec | undefined {
	return BUILTIN_SLASH_COMMAND_LOOKUP.get(name);
}

export type { ParsedSlashCommand, SlashCommandResult, SlashCommandRuntime, SlashCommandSpec, TuiSlashCommandRuntime };
