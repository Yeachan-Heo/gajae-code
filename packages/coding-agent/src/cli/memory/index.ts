/** Dispatch the additive M6 `gjc memory` command surface. */
import * as fs from "node:fs/promises";
import {
	MEMORY_EXIT_CODES,
	type MemoryDocumentType,
	type MemoryEnvironment,
	type MemoryError,
	type MemoryIntent,
	type MemoryResult,
	type MemoryScopeKind,
	memoryErrorEnvelope,
} from "@gajae-code/memory-core";
import { getAgentDir, getMemoryRootDir, getProjectDir } from "@gajae-code/utils";
import { Settings } from "../../config/settings";
import { SessionResolutionError } from "../../gjc-runtime/session-resolution";
import { runApplyCommand } from "./apply";
import { runCapabilitiesCommand } from "./capabilities";
import { runCheckpointCommand } from "./checkpoint";
import { runDoctorCommand } from "./doctor";
import {
	buildMemoryEnvironment,
	buildReadOnlyMemoryEnvironment,
	type MemoryEnvironmentBuildOptions,
} from "./environment";
import { runForgetCommand } from "./forget";
import { runGetCommand } from "./get";
import { runInitCommand } from "./init";
import { runProposeCommand } from "./propose";
import { runRecallCommand } from "./recall";
import { runResolveCommand } from "./resolve";
import { runResumeCommand } from "./resume";
import { runScopesCommand } from "./scopes";
import { runSearchCommand } from "./search";

export type {
	MemoryEnvironmentBuildOptions,
	MemoryEnvironmentSyncBuildOptions,
	MemoryGitDependencies,
	MemoryGitSyncDependencies,
	ReadOnlyMemoryEnvironmentBuildOptions,
} from "./environment";
export {
	buildMemoryEnvironment,
	buildMemoryEnvironmentSync,
	buildReadOnlyMemoryEnvironment,
	buildRepositorySnapshot,
	buildRepositorySnapshotSync,
} from "./environment";
export type MemoryAction =
	| "init"
	| "capabilities"
	| "scopes"
	| "resolve"
	| "get"
	| "search"
	| "recall"
	| "checkpoint"
	| "resume"
	| "doctor"
	| "propose"
	| "apply"
	| "forget";

export interface MemoryCommandFlags {
	readonly json?: boolean;
	readonly explain?: boolean;
	readonly format?: string;
	readonly intent?: string;
	readonly scopes?: readonly string[];
	readonly limit?: number;
	readonly maxBytes?: number;
	readonly complete?: boolean;
	readonly deterministic?: boolean;
	readonly requireResolved?: boolean;
	readonly asOf?: string;
	readonly sessionId?: string;
	readonly goal?: string;
	readonly task?: string;
	readonly nextSteps?: readonly string[];
	readonly constraints?: readonly string[];
	readonly decisions?: readonly string[];
	readonly risks?: readonly string[];
	readonly type?: string;
	readonly content?: string;
	readonly targetScope?: string;
	readonly targetUri?: string;
	readonly supersedes?: readonly string[];
	readonly expectedDigest?: string;
	readonly reason?: string;
}

export interface MemoryCommandArgs {
	readonly action: MemoryAction;
	readonly value?: string;
	readonly flags?: MemoryCommandFlags;
}

export interface MemoryCommandDependencies extends Omit<MemoryEnvironmentBuildOptions, "settings" | "cwd"> {
	readonly agentDir?: string;
	readonly settings?: Pick<Settings, "getAgentDir">;
	readonly cwd?: string;
}

export const MEMORY_ACTIONS = Object.freeze([
	"init",
	"capabilities",
	"scopes",
	"resolve",
	"get",
	"search",
	"recall",
	"checkpoint",
	"resume",
	"doctor",
	"propose",
	"apply",
	"forget",
] as const);

const MEMORY_SCOPES = Object.freeze(["global", "project", "session"] as const);
const MEMORY_INTENTS = Object.freeze([
	"user-preference",
	"project-convention",
	"architecture-rationale",
	"decision-history",
	"current-task-status",
	"resume-session",
	"person-identity",
	"environment",
	"debugging-history",
	"workflow-policy",
	"generic-recall",
] as const);

export function createMemoryEnvironment(
	settings: Pick<Settings, "getAgentDir">,
	now: Date = new Date(),
): MemoryEnvironment {
	return {
		memoryRoot: getMemoryRootDir(settings.getAgentDir()),
		repository: null,
		sessionId: null,
		now,
		deterministic: false,
		asOf: null,
	};
}
function errorCode(error: unknown): string | undefined {
	if (error === null || typeof error !== "object" || !("code" in error)) return undefined;
	const code = (error as { readonly code?: unknown }).code;
	return typeof code === "string" ? code : undefined;
}

function notInitializedMemoryRoot(memoryRoot: string): MemoryResult<true> {
	return {
		ok: false,
		error: {
			code: "not-initialized",
			exitCode: MEMORY_EXIT_CODES.notInitialized,
			memoryRoot,
			remedy: "Run `gjc memory init` to create an initialized memory root.",
		},
	};
}

async function checkMemoryInitializedRoot(memoryRoot: string): Promise<MemoryResult<true>> {
	try {
		const stats = await fs.lstat(memoryRoot);
		if (!stats.isDirectory() || stats.isSymbolicLink()) return notInitializedMemoryRoot(memoryRoot);
		return { ok: true, value: true };
	} catch (error) {
		const code = errorCode(error);
		if (code === "ENOENT" || code === "ENOTDIR") return notInitializedMemoryRoot(memoryRoot);
		return {
			ok: false,
			error: {
				code: "policy-denied",
				exitCode: MEMORY_EXIT_CODES.policyDenied,
				destination: "global-canonical",
				reason: "memory root could not be inspected",
			},
		};
	}
}

function invalidActionError(action: unknown): MemoryError {
	return {
		code: "invalid-input",
		exitCode: MEMORY_EXIT_CODES.invalidInput,
		detail: `unknown memory action ${JSON.stringify(action)}; expected one of ${MEMORY_ACTIONS.join(", ")}`,
	};
}

function invalidValueError(action: MemoryAction): MemoryError {
	const label =
		action === "resolve" || action === "get" || action === "forget"
			? "URI"
			: action === "apply"
				? "proposal id"
				: "query";
	return {
		code: "invalid-input",
		exitCode: MEMORY_EXIT_CODES.invalidInput,
		detail: `memory ${action} requires a ${label} value`,
	};
}

function invalidInputError(detail: string): MemoryError {
	return {
		code: "invalid-input",
		exitCode: MEMORY_EXIT_CODES.invalidInput,
		detail,
	};
}

function unexpectedError(error: unknown): MemoryError {
	if (error instanceof SessionResolutionError) {
		return invalidInputError(error.message);
	}
	return {
		code: "policy-denied",
		exitCode: MEMORY_EXIT_CODES.policyDenied,
		destination: "global-canonical",
		reason: "memory command failed",
	};
}

function normalizeScopes(values: readonly string[] | undefined): MemoryResult<readonly MemoryScopeKind[] | undefined> {
	if (values === undefined) return { ok: true, value: undefined };
	if (!Array.isArray(values)) return { ok: false, error: invalidInputError("memory scope input must be an array") };

	const selected = new Set<MemoryScopeKind>();
	for (const value of values) {
		if (typeof value !== "string") return { ok: false, error: invalidInputError("memory scope must be a string") };
		for (const item of value.split(",")) {
			const normalized = item.normalize("NFC").trim().toLowerCase();
			if (normalized.length === 0) return { ok: false, error: invalidInputError("memory scope must not be blank") };
			if (!(MEMORY_SCOPES as readonly string[]).includes(normalized)) {
				return { ok: false, error: invalidInputError(`memory scope is unsupported: ${item.trim() || item}`) };
			}
			selected.add(normalized as MemoryScopeKind);
		}
	}

	return {
		ok: true,
		value: Object.freeze(MEMORY_SCOPES.filter(scope => selected.has(scope))),
	};
}

function normalizeIntent(value: string | undefined): MemoryResult<MemoryIntent | undefined> {
	if (value === undefined) return { ok: true, value: undefined };
	const normalized = value.normalize("NFC").trim();
	if (!(MEMORY_INTENTS as readonly string[]).includes(normalized)) {
		return { ok: false, error: invalidInputError(`memory intent is unsupported: ${value}`) };
	}
	return { ok: true, value: normalized as MemoryIntent };
}

function requiredValue(action: MemoryAction, value: string | undefined): MemoryResult<string> {
	if (
		action !== "resolve" &&
		action !== "get" &&
		action !== "search" &&
		action !== "recall" &&
		action !== "apply" &&
		action !== "forget"
	) {
		return { ok: true, value: value ?? "" };
	}
	if (value === undefined) return { ok: false, error: invalidValueError(action) };
	return { ok: true, value };
}

export function writeMemoryError(error: MemoryError, json = false): void {
	const envelope = memoryErrorEnvelope(error);
	if (json) process.stdout.write(`${JSON.stringify(envelope, null, 2)}\n`);
	process.stderr.write(`error: ${error.code}\n${JSON.stringify(envelope, null, 2)}\n`);
	process.exitCode = error.exitCode;
}

function finishMemoryResult<T>(result: MemoryResult<T>, json: boolean): void {
	if (result.ok) {
		process.exitCode = 0;
		return;
	}
	writeMemoryError(result.error, json);
}

function isReadOnlyMemoryAction(action: MemoryAction): boolean {
	return (
		action === "scopes" ||
		action === "resolve" ||
		action === "get" ||
		action === "search" ||
		action === "recall" ||
		action === "resume" ||
		action === "doctor"
	);
}

export async function runMemoryCommand(cmd: MemoryCommandArgs, deps: MemoryCommandDependencies = {}): Promise<void> {
	const format = cmd.flags?.format;
	if (format !== undefined && format !== "json" && format !== "text") {
		// A supplied `--format` signals machine-output intent, so the typed failure is
		// emitted as the versioned JSON error envelope rather than human text.
		writeMemoryError(invalidInputError("memory format must be json or text"), true);
		return;
	}
	// `--format json` is the documented machine-output spelling; `--json` remains
	// its shorthand and `--format text` forces the human renderer.
	const json = format === undefined ? Boolean(cmd.flags?.json) : format === "json";
	if (!MEMORY_ACTIONS.includes(cmd.action)) {
		writeMemoryError(invalidActionError(cmd.action), json);
		return;
	}
	if (
		(cmd.action === "init" ||
			cmd.action === "capabilities" ||
			cmd.action === "scopes" ||
			cmd.action === "checkpoint" ||
			cmd.action === "resume" ||
			cmd.action === "doctor" ||
			cmd.action === "propose") &&
		cmd.value !== undefined
	) {
		writeMemoryError(invalidInputError(`memory ${cmd.action} does not accept a value`), json);
		return;
	}
	if (
		cmd.action === "doctor" &&
		cmd.flags?.maxBytes !== undefined &&
		(!Number.isSafeInteger(cmd.flags.maxBytes) || cmd.flags.maxBytes <= 0)
	) {
		writeMemoryError(invalidInputError("memory doctor max-bytes must be a positive safe integer"), json);
		return;
	}

	try {
		if (cmd.action === "init") {
			const agentDir = deps.agentDir ?? deps.settings?.getAgentDir() ?? getAgentDir();
			const environment = createMemoryEnvironment({ getAgentDir: () => agentDir }, deps.clock?.() ?? new Date());
			finishMemoryResult(await runInitCommand(environment, { json }), json);
			return;
		}

		if (cmd.action === "capabilities") {
			runCapabilitiesCommand({ json });
			process.exitCode = 0;
			return;
		}

		const normalizedValue = requiredValue(cmd.action, cmd.value);
		if (!normalizedValue.ok) {
			writeMemoryError(normalizedValue.error, json);
			return;
		}
		const retrievalAction = cmd.action === "search" || cmd.action === "recall";
		const normalizedScopes: MemoryResult<readonly MemoryScopeKind[] | undefined> = retrievalAction
			? normalizeScopes(cmd.flags?.scopes)
			: { ok: true, value: undefined };
		if (!normalizedScopes.ok) {
			writeMemoryError(normalizedScopes.error, json);
			return;
		}
		const normalizedIntent: MemoryResult<MemoryIntent | undefined> = retrievalAction
			? normalizeIntent(cmd.flags?.intent)
			: { ok: true, value: undefined };
		if (!normalizedIntent.ok) {
			writeMemoryError(normalizedIntent.error, json);
			return;
		}
		const agentDir = deps.agentDir ?? deps.settings?.getAgentDir() ?? getAgentDir();
		const initialized = await checkMemoryInitializedRoot(getMemoryRootDir(agentDir));
		if (!initialized.ok) {
			writeMemoryError(initialized.error, json);
			return;
		}

		const cwd = deps.cwd ?? getProjectDir();
		const sessionSources = {
			...(deps.sessionSources ?? deps.session ?? {}),
			...(cmd.flags?.sessionId === undefined ? {} : { flagValue: cmd.flags.sessionId }),
		};
		const environmentOptions = {
			cwd,
			clock: deps.clock,
			asOf: retrievalAction ? (cmd.flags?.asOf ?? deps.asOf) : deps.asOf,
			deterministic: retrievalAction ? (cmd.flags?.deterministic ?? deps.deterministic) : deps.deterministic,
			sessionSources,
			env: deps.env,
			git: deps.git,
		};
		const environment = isReadOnlyMemoryAction(cmd.action)
			? await buildReadOnlyMemoryEnvironment({
					...environmentOptions,
					agentDir,
					settings: deps.settings,
				})
			: await buildMemoryEnvironment({
					...environmentOptions,
					settings: deps.settings ?? (await Settings.loadForScope({ cwd, agentDir })),
				});

		switch (cmd.action) {
			case "propose":
				finishMemoryResult(
					await runProposeCommand(
						environment,
						{
							type: cmd.flags?.type as MemoryDocumentType,
							content: cmd.flags?.content ?? "",
							...(cmd.flags?.targetScope === undefined
								? {}
								: { targetScope: cmd.flags.targetScope as MemoryScopeKind }),
							...(cmd.flags?.targetUri === undefined ? {} : { targetUri: cmd.flags.targetUri }),
							...(cmd.flags?.supersedes === undefined ? {} : { supersedes: cmd.flags.supersedes }),
						},
						{ json },
					),
					json,
				);
				return;
			case "apply":
				finishMemoryResult(
					await runApplyCommand(environment, { proposalId: normalizedValue.value }, { json }),
					json,
				);
				return;
			case "forget":
				finishMemoryResult(
					await runForgetCommand(
						environment,
						{
							uri: normalizedValue.value,
							...(cmd.flags?.expectedDigest === undefined ? {} : { expectedDigest: cmd.flags.expectedDigest }),
							...(cmd.flags?.reason === undefined ? {} : { reason: cmd.flags.reason }),
						},
						{ json },
					),
					json,
				);
				return;
			case "scopes":
				finishMemoryResult(await runScopesCommand(environment, { json }), json);
				return;
			case "resolve":
				finishMemoryResult(await runResolveCommand(environment, normalizedValue.value, { json }), json);
				return;
			case "get":
				finishMemoryResult(await runGetCommand(environment, normalizedValue.value, { json }), json);
				return;
			case "search":
				finishMemoryResult(
					await runSearchCommand(
						environment,
						{
							query: normalizedValue.value,
							...(normalizedIntent.value === undefined ? {} : { intent: normalizedIntent.value }),
							...(normalizedScopes.value === undefined ? {} : { scopes: normalizedScopes.value }),
							...(cmd.flags?.limit === undefined ? {} : { limit: cmd.flags.limit }),
							...(cmd.flags?.complete === undefined ? {} : { complete: cmd.flags.complete }),
							...(cmd.flags?.explain === true ? { explain: true } : {}),
						},
						{ json },
					),
					json,
				);
				return;
			case "recall":
				finishMemoryResult(
					await runRecallCommand(
						environment,
						{
							query: normalizedValue.value,
							...(normalizedIntent.value === undefined ? {} : { intent: normalizedIntent.value }),
							...(normalizedScopes.value === undefined ? {} : { scopes: normalizedScopes.value }),
							...(cmd.flags?.limit === undefined ? {} : { limit: cmd.flags.limit }),
							...(cmd.flags?.complete === undefined ? {} : { complete: cmd.flags.complete }),
							...(cmd.flags?.explain === true ? { explain: true } : {}),
							...(cmd.flags?.requireResolved === undefined
								? {}
								: { requireResolved: cmd.flags.requireResolved }),
						},
						{ json },
					),
					json,
				);
				return;
			case "checkpoint":
				finishMemoryResult(
					await runCheckpointCommand(
						environment,
						{
							goal: cmd.flags?.goal ?? "",
							task: cmd.flags?.task ?? "",
							nextSteps: cmd.flags?.nextSteps ?? [],
							...(cmd.flags?.constraints === undefined ? {} : { constraints: cmd.flags.constraints }),
							...(cmd.flags?.decisions === undefined ? {} : { decisions: cmd.flags.decisions }),
							...(cmd.flags?.risks === undefined ? {} : { risks: cmd.flags.risks }),
						},
						{ json },
					),
					json,
				);
				return;
			case "resume":
				finishMemoryResult(
					await runResumeCommand(
						environment,
						cmd.flags?.sessionId === undefined ? undefined : { sessionId: cmd.flags.sessionId },
						{ json },
					),
					json,
				);
				return;
			case "doctor":
				finishMemoryResult(
					await runDoctorCommand(
						environment,
						cmd.flags?.maxBytes === undefined ? {} : { maxBytes: cmd.flags.maxBytes },
						{ json },
					),
					json,
				);
				return;
		}
	} catch (error) {
		writeMemoryError(unexpectedError(error), json);
	}
}
