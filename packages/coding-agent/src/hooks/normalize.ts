import {
	CONVENTION_EVENT_CONTRACTS,
	EXTERNAL_EVENT_ALIASES,
	type HookAuthority,
	HookEventKind,
	type HookExecutionContract,
	HookSourceConvention,
} from "./events";

export const HookDiagnosticSeverity = {
	Error: "error",
	Warning: "warning",
} as const;

export type HookDiagnosticSeverity = (typeof HookDiagnosticSeverity)[keyof typeof HookDiagnosticSeverity];

export const HookDiagnosticCode = {
	UnsupportedConventionEvent: "unsupported_convention_event",
	UnrecognizedPluginEvent: "unrecognized_plugin_event",
	InvalidPluginPhase: "invalid_plugin_phase",
	InvalidToolMatcher: "invalid_tool_matcher",
	InvalidSource: "invalid_source",
	InvalidCommand: "invalid_command",
	DuplicateHook: "duplicate_hook",
	InProcessEventOutsideIr: "in_process_event_outside_hook_ir",
	SemanticMismatch: "semantic_mismatch",
} as const;

export type HookDiagnosticCode = (typeof HookDiagnosticCode)[keyof typeof HookDiagnosticCode];

export interface HookNormalizationDiagnostic {
	severity: HookDiagnosticSeverity;
	code: HookDiagnosticCode;
	message: string;
	convention: HookSourceConvention;
	externalEvent?: string;
	canonicalKind?: HookEventKind;
	source?: string;
}

export interface NormalizedHook {
	kind: HookEventKind;
	authority: HookAuthority;
	convention: HookSourceConvention;
	runtimeEvent: string;
	toolName: string;
	source: string;
	contract: HookExecutionContract;
}

export interface NormalizeHookResult {
	hook: NormalizedHook | null;
	diagnostics: HookNormalizationDiagnostic[];
}

export function resolveExecutionContract(
	convention: HookSourceConvention,
	kind: HookEventKind,
): HookExecutionContract | null {
	return CONVENTION_EVENT_CONTRACTS[convention][kind] ?? null;
}

export function resolveAuthority(convention: HookSourceConvention, kind: HookEventKind): HookAuthority | null {
	return resolveExecutionContract(convention, kind)?.authority ?? null;
}

export function resolveCanonicalKind(externalEvent: string): HookEventKind | null {
	return EXTERNAL_EVENT_ALIASES[externalEvent] ?? null;
}

export function unsupportedEventDiagnostic(
	convention: HookSourceConvention,
	externalEvent: string,
	canonicalKind: HookEventKind | null,
	source?: string,
): HookNormalizationDiagnostic {
	return {
		severity: HookDiagnosticSeverity.Error,
		code: HookDiagnosticCode.UnsupportedConventionEvent,
		message: canonicalKind
			? `Convention "${convention}" does not support canonical event "${canonicalKind}".`
			: `Convention "${convention}" received unrecognized external event "${externalEvent}".`,
		convention,
		externalEvent,
		canonicalKind: canonicalKind ?? undefined,
		source,
	};
}

function invalid(
	code: HookDiagnosticCode,
	message: string,
	convention: HookSourceConvention,
	input: { source?: string; externalEvent?: string; canonicalKind?: HookEventKind },
): NormalizeHookResult {
	return {
		hook: null,
		diagnostics: [{ severity: HookDiagnosticSeverity.Error, code, message, convention, ...input }],
	};
}

function validateSource(convention: HookSourceConvention, source: string): NormalizeHookResult | null {
	if (source.trim()) return null;
	return invalid(HookDiagnosticCode.InvalidSource, "Hook source provenance must be non-empty.", convention, {
		source,
	});
}

/** Tool identifiers are logical, case-sensitive runtime names, not filesystem paths. */
export function normalizeToolMatcher(toolName: unknown): string | null {
	if (typeof toolName !== "string") return null;
	const normalized = toolName.trim();
	if (!normalized || normalized === "." || normalized === "..") return null;
	if (normalized !== toolName) return null;
	if (normalized !== "*" && (normalized.includes("/") || normalized.includes("\\") || normalized.includes("\0"))) {
		return null;
	}
	return normalized;
}

function buildHook(
	convention: HookSourceConvention,
	kind: HookEventKind,
	toolName: unknown,
	source: string,
): NormalizeHookResult {
	const sourceFailure = validateSource(convention, source);
	if (sourceFailure) return sourceFailure;
	const contract = resolveExecutionContract(convention, kind);
	if (!contract) return { hook: null, diagnostics: [unsupportedEventDiagnostic(convention, kind, kind, source)] };
	const matcher = normalizeToolMatcher(toolName);
	if (!matcher) {
		return invalid(
			HookDiagnosticCode.InvalidToolMatcher,
			`Invalid tool matcher "${toolName}"; matchers are case-sensitive logical names or "*", never paths.`,
			convention,
			{ source, canonicalKind: kind },
		);
	}
	return {
		hook: {
			kind,
			authority: contract.authority,
			convention,
			runtimeEvent: contract.runtimeEvent,
			toolName: matcher,
			source,
			contract,
		},
		diagnostics: [],
	};
}

export interface DirectoryHookInput {
	convention: HookSourceConvention;
	phase: "pre" | "post";
	toolName: string;
	source: string;
	/** Original discovered filename, when normalization participates in discovery. */
	externalName?: string;
}

/** Normalize discovery metadata for native, Claude, or Codex hook modules. */
export function normalizeDirectoryHook(input: DirectoryHookInput): NormalizeHookResult {
	if (
		input.convention !== HookSourceConvention.NativeGjc &&
		input.convention !== HookSourceConvention.ClaudeCode &&
		input.convention !== HookSourceConvention.Codex
	) {
		const kind = input.phase === "pre" ? HookEventKind.PreToolUse : HookEventKind.PostToolUse;
		return {
			hook: null,
			diagnostics: [unsupportedEventDiagnostic(input.convention, input.phase, kind, input.source)],
		};
	}
	if (input.convention === HookSourceConvention.Codex && input.externalName) {
		const expectedPrefix = `${input.phase}-`;
		if (!input.externalName.startsWith(expectedPrefix)) {
			return invalid(
				HookDiagnosticCode.SemanticMismatch,
				`Codex hook filename "${input.externalName}" must use the ${expectedPrefix}<tool>.ts|js convention.`,
				input.convention,
				{ source: input.source, externalEvent: input.externalName },
			);
		}
	}
	return buildHook(
		input.convention,
		input.phase === "pre" ? HookEventKind.PreToolUse : HookEventKind.PostToolUse,
		input.toolName,
		input.source,
	);
}

export interface ManagedJsonHookInput {
	externalEvent: string;
	command: string;
	source: string;
}

/** Normalize the two GJC-managed Codex hooks.json entries. */
export function normalizeManagedJsonHook(input: ManagedJsonHookInput): NormalizeHookResult {
	if (!input.command.trim()) {
		return invalid(
			HookDiagnosticCode.InvalidCommand,
			"Managed hooks.json command must be non-empty.",
			HookSourceConvention.CodexManagedJson,
			{ source: input.source, externalEvent: input.externalEvent },
		);
	}
	const kind =
		input.externalEvent === "UserPromptSubmit"
			? HookEventKind.UserPromptSubmit
			: input.externalEvent === "Stop"
				? HookEventKind.Stop
				: null;
	if (!kind) {
		return {
			hook: null,
			diagnostics: [
				unsupportedEventDiagnostic(HookSourceConvention.CodexManagedJson, input.externalEvent, null, input.source),
			],
		};
	}
	return buildHook(HookSourceConvention.CodexManagedJson, kind, "*", input.source);
}

export interface PluginHookInput {
	declaredEvent: string;
	target?: unknown;
	phase?: unknown;
	plugin: string;
	source: string;
}

/** Normalize only manifest shapes that the constrained plugin compiler accepts. */
export function normalizePluginHook(input: PluginHookInput): NormalizeHookResult {
	if (input.declaredEvent === "session_start" || input.declaredEvent === "session_shutdown") {
		if (input.phase !== undefined || input.target !== undefined) {
			return invalid(
				HookDiagnosticCode.InvalidPluginPhase,
				`Plugin "${input.plugin}" ${input.declaredEvent} hooks do not accept target or phase.`,
				HookSourceConvention.GjcPlugin,
				{ source: input.source, externalEvent: input.declaredEvent },
			);
		}
		return buildHook(
			HookSourceConvention.GjcPlugin,
			input.declaredEvent === "session_start" ? HookEventKind.SessionStart : HookEventKind.SessionShutdown,
			"*",
			input.source,
		);
	}
	if (input.declaredEvent !== "tool_call" && input.declaredEvent !== "tool_result") {
		return invalid(
			HookDiagnosticCode.UnrecognizedPluginEvent,
			`Plugin "${input.plugin}" declared unsupported event "${input.declaredEvent}"; aliases cannot expand plugin authority.`,
			HookSourceConvention.GjcPlugin,
			{ source: input.source, externalEvent: input.declaredEvent },
		);
	}

	if (input.declaredEvent === "tool_call") {
		if (!input.target || (input.phase !== "before" && input.phase !== "after")) {
			return invalid(
				HookDiagnosticCode.InvalidPluginPhase,
				`Plugin "${input.plugin}" tool_call hooks require both target and before/after phase.`,
				HookSourceConvention.GjcPlugin,
				{ source: input.source, externalEvent: input.declaredEvent },
			);
		}
		return buildHook(
			HookSourceConvention.GjcPlugin,
			input.phase === "before" ? HookEventKind.PreToolUse : HookEventKind.PostToolUse,
			input.target,
			input.source,
		);
	}

	if (input.phase !== "after") {
		return invalid(
			HookDiagnosticCode.InvalidPluginPhase,
			`Plugin "${input.plugin}" tool_result hooks require phase "after".`,
			HookSourceConvention.GjcPlugin,
			{ source: input.source, externalEvent: input.declaredEvent },
		);
	}
	return buildHook(HookSourceConvention.GjcPlugin, HookEventKind.PostToolUse, input.target ?? "*", input.source);
}

export interface InProcessHookInput {
	registeredEvent: string;
	source: string;
}

export function normalizeInProcessHook(input: InProcessHookInput): NormalizeHookResult {
	if (input.registeredEvent === "turn_end") {
		return invalid(
			HookDiagnosticCode.SemanticMismatch,
			"turn_end fires once per turn and is not equivalent to provider Stop/agent_end.",
			HookSourceConvention.InProcess,
			{ source: input.source, externalEvent: input.registeredEvent, canonicalKind: HookEventKind.Stop },
		);
	}
	const kind =
		input.registeredEvent === "before_agent_start"
			? HookEventKind.UserPromptSubmit
			: input.registeredEvent === "tool_call"
				? HookEventKind.PreToolUse
				: input.registeredEvent === "tool_result"
					? HookEventKind.PostToolUse
					: input.registeredEvent === "agent_end"
						? HookEventKind.Stop
						: input.registeredEvent === "session_start"
							? HookEventKind.SessionStart
							: input.registeredEvent === "session_shutdown"
								? HookEventKind.SessionShutdown
								: null;
	if (!kind) {
		return {
			hook: null,
			diagnostics: [
				{
					severity: HookDiagnosticSeverity.Warning,
					code: HookDiagnosticCode.InProcessEventOutsideIr,
					message: `In-process event "${input.registeredEvent}" remains on the broader HookAPI and is not normalized.`,
					convention: HookSourceConvention.InProcess,
					externalEvent: input.registeredEvent,
					source: input.source,
				},
			],
		};
	}
	return buildHook(HookSourceConvention.InProcess, kind, "*", input.source);
}

export interface BatchNormalizeResult {
	hooks: NormalizedHook[];
	diagnostics: HookNormalizationDiagnostic[];
}

/** Stable first-wins deduplication; rejected and duplicate entries remain visible as diagnostics. */
export function normalizeHookBatch(results: ReadonlyArray<NormalizeHookResult>): BatchNormalizeResult {
	const hooks: NormalizedHook[] = [];
	const diagnostics: HookNormalizationDiagnostic[] = [];
	const seen = new Map<string, NormalizedHook>();

	for (const result of results) {
		diagnostics.push(...result.diagnostics);
		if (!result.hook) continue;
		const key = `${result.hook.convention}\0${result.hook.kind}\0${result.hook.toolName}\0${result.hook.source}`;
		const prior = seen.get(key);
		if (prior) {
			diagnostics.push({
				severity: HookDiagnosticSeverity.Warning,
				code: HookDiagnosticCode.DuplicateHook,
				message: `Duplicate hook descriptor ignored; first occurrence remains ordered first.`,
				convention: result.hook.convention,
				canonicalKind: result.hook.kind,
				source: result.hook.source,
			});
			continue;
		}
		seen.set(key, result.hook);
		hooks.push(result.hook);
	}

	return { hooks, diagnostics };
}
