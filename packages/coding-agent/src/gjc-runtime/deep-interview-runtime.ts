import { createHash, randomBytes } from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { syncSkillActiveState } from "../skill-state/active-state";
import { deriveDeepInterviewHud } from "../skill-state/workflow-hud";
import { WORKFLOW_STATE_VERSION } from "../skill-state/workflow-state-contract";
import { normalizeDeepInterviewEnvelope } from "./deep-interview-state";
import { runNativeRalplanCommand } from "./ralplan-runtime";
import { modeStatePath, sessionSpecsDir } from "./session-layout";
import { resolveGjcSessionForWrite, writeSessionActivityMarker } from "./session-resolution";
import { runNativeStateCommand } from "./state-runtime";
import { appendJsonl, readExistingStateForMutation, writeArtifact, writeWorkflowEnvelopeAtomic } from "./state-writer";

export * from "./deep-interview-recorder";

/**
 * Native implementation of `gjc deep-interview`.
 *
 * The CLI itself does not run the Socratic interview; that lives inside the `/skill:deep-interview`
 * skill executed by the agent. This handler validates the documented argument-hint surface
 * (`[--quick|--standard|--deep] <idea>`), seeds `.gjc/state/deep-interview-state.json`, and
 * updates the shared HUD rail via `syncSkillActiveState` so the active interview is visible to
 * the TUI.
 */

export interface DeepInterviewCommandResult {
	status: number;
	stdout?: string;
	stderr?: string;
}

const PATH_COMPONENT_RE = /^[A-Za-z0-9_-][A-Za-z0-9._-]{0,63}$/;

const DEFAULT_AMBIGUITY_THRESHOLD = 0.05;

const RESOLUTION_THRESHOLDS = {
	quick: 0.6,
	standard: 0.5,
	deep: 0.35,
} as const;

type DeepInterviewResolution = keyof typeof RESOLUTION_THRESHOLDS;

class DeepInterviewCommandError extends Error {
	constructor(
		public readonly exitStatus: number,
		message: string,
	) {
		super(message);
		this.name = "DeepInterviewCommandError";
	}
}

const VALUE_FLAGS = new Set([
	"--session-id",
	"--threshold",
	"--threshold-source",
	"--stage",
	"--slug",
	"--spec",
	"--handoff",
]);

function flagValue(args: readonly string[], flag: string): string | undefined {
	const index = args.indexOf(flag);
	if (index < 0) return undefined;
	return args[index + 1];
}

function hasFlag(args: readonly string[], flag: string): boolean {
	return args.includes(flag);
}

function assertSafePathComponent(value: string, label: string): void {
	if (!PATH_COMPONENT_RE.test(value) || value.includes("..")) {
		throw new DeepInterviewCommandError(2, `invalid path component for --${label}: ${value}`);
	}
}

function defaultSpecSlug(now: Date = new Date()): string {
	const yyyy = now.getUTCFullYear().toString().padStart(4, "0");
	const mm = (now.getUTCMonth() + 1).toString().padStart(2, "0");
	const dd = now.getUTCDate().toString().padStart(2, "0");
	const hh = now.getUTCHours().toString().padStart(2, "0");
	const min = now.getUTCMinutes().toString().padStart(2, "0");
	return `${yyyy}-${mm}-${dd}-${hh}${min}-${randomBytes(2).toString("hex")}`;
}

export function deepInterviewStatePath(cwd: string, sessionId?: string): string {
	const resolvedSessionId = sessionId?.trim() || process.env.GJC_SESSION_ID?.trim();
	if (!resolvedSessionId) throw new Error("deep-interview state path requires a session id");
	return modeStatePath(cwd, resolvedSessionId, "deep-interview");
}

async function resolveSpecContent(rawSpec: string, cwd: string): Promise<string> {
	const candidate = path.isAbsolute(rawSpec) ? rawSpec : path.resolve(cwd, rawSpec);
	try {
		const stat = await fs.stat(candidate);
		if (stat.isFile()) return await fs.readFile(candidate, "utf-8");
	} catch (error) {
		const err = error as NodeJS.ErrnoException;
		if (err.code !== "ENOENT" && err.code !== "ENOTDIR" && err.code !== "ENAMETOOLONG") {
			throw new DeepInterviewCommandError(2, `failed to read --spec ${candidate}: ${err.message}`);
		}
	}
	return rawSpec;
}

interface ResolvedDeepInterviewArgs {
	resolution: DeepInterviewResolution;
	threshold: number;
	thresholdSource: string;
	sessionId: string;
	idea: string;
	language?: DeepInterviewLanguagePreference;
	json: boolean;
}

interface DeepInterviewLanguagePreference {
	code: "en" | "user";
	label: "English" | "User language";
	source: "explicit-user-request" | "initial-idea";
	instruction: string;
}

export interface ResolvedDeepInterviewSpecWriteArgs {
	stage: "final";
	slug: string;
	spec: string;
	sessionId: string;
	json: boolean;
	deliberate: boolean;
	handoff?: "ralplan";
	force: boolean;
}

export interface PersistedDeepInterviewSpec {
	slug: string;
	path: string;
	stage: "final";
	sha256: string;
	createdAt: string;
	statePath: string;
}

interface DeepInterviewSpecWriteSummary {
	skill: "deep-interview";
	stage: "final";
	slug: string;
	path: string;
	sha256: string;
	spec_path: string;
	sha: string;
	created_at: string;
	state_path: string;
	handoff?: {
		to: "ralplan";
		mode: "deliberate";
		state_path?: string;
		run_id?: string;
	};
}

async function readSettingsAmbiguityThreshold(
	settingsPath: string,
): Promise<{ threshold: number; source: string } | undefined> {
	let raw: string;
	try {
		raw = await fs.readFile(settingsPath, "utf-8");
	} catch (error) {
		const err = error as NodeJS.ErrnoException;
		if (err.code === "ENOENT") return undefined;
		return undefined;
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return undefined;
	}
	const candidate = (parsed as { gjc?: { deepInterview?: { ambiguityThreshold?: unknown } } })?.gjc?.deepInterview
		?.ambiguityThreshold;
	if (typeof candidate !== "number" || !Number.isFinite(candidate) || candidate <= 0 || candidate > 1) {
		return undefined;
	}
	return { threshold: candidate, source: settingsPath };
}

function modernSettingsPath(): string {
	const configDir = process.env.GJC_CODING_AGENT_DIR?.trim() || process.env.PI_CODING_AGENT_DIR?.trim();
	if (configDir) return path.join(configDir, "config.yml");
	const configRoot = process.env.GJC_CONFIG_DIR?.trim() || process.env.PI_CONFIG_DIR?.trim();
	if (configRoot) return path.join(configRoot, "agent", "config.yml");
	return path.join(os.homedir(), ".gjc", "agent", "config.yml");
}

async function readModernSettingsAmbiguityThreshold(): Promise<{ threshold: number; source: string } | undefined> {
	const modernConfigPath = modernSettingsPath();
	let parsed: unknown;
	try {
		parsed = (await import("bun")).YAML.parse(await fs.readFile(modernConfigPath, "utf-8"));
	} catch {
		return undefined;
	}
	const candidate = (parsed as { gjc?: { deepInterview?: { ambiguityThreshold?: unknown } } })?.gjc?.deepInterview
		?.ambiguityThreshold;
	if (typeof candidate !== "number" || !Number.isFinite(candidate) || candidate <= 0 || candidate > 1)
		return undefined;
	return { threshold: candidate, source: modernConfigPath };
}

async function resolveConfiguredAmbiguityThreshold(
	cwd: string,
): Promise<{ threshold: number; source: string } | undefined> {
	const modernValue = await readModernSettingsAmbiguityThreshold();
	if (modernValue) return modernValue;
	const projectSettings = path.join(cwd, ".gjc", "settings.json");
	const projectValue = await readSettingsAmbiguityThreshold(projectSettings);
	if (projectValue) return projectValue;
	const configDir = process.env.GJC_CONFIG_DIR?.trim() || path.join(os.homedir(), ".gjc");
	const userSettings = path.join(configDir, "settings.json");
	return await readSettingsAmbiguityThreshold(userSettings);
}

function englishLanguagePreference(): DeepInterviewLanguagePreference {
	return {
		code: "en",
		label: "English",
		source: "explicit-user-request",
		instruction:
			"Ask every user-facing deep-interview question in English because the user explicitly requested English.",
	};
}

function userLanguagePreference(): DeepInterviewLanguagePreference {
	return {
		code: "user",
		label: "User language",
		source: "initial-idea",
		instruction:
			"Ask every user-facing deep-interview question in the user/session language inferred from the initial idea unless the user explicitly requests another language. Keep code identifiers, file paths, commands, settings/JSON keys, library/API names, and quoted source text unchanged when appropriate.",
	};
}

function resolveDeepInterviewLanguagePreference(idea: string): DeepInterviewLanguagePreference | undefined {
	if (/\b(?:answer|ask|respond|reply|write|use|speak)\s+(?:only\s+)?in\s+English\b/i.test(idea)) {
		return englishLanguagePreference();
	}
	if (/[^\p{Script=Latin}\p{Script=Common}\p{Script=Inherited}]/u.test(idea)) {
		return userLanguagePreference();
	}
	return undefined;
}

function isDeepInterviewSpecWriteInvocation(args: readonly string[]): boolean {
	return hasFlag(args, "--write");
}

async function resolveSpecWriteArgs(args: readonly string[], cwd: string): Promise<ResolvedDeepInterviewSpecWriteArgs> {
	const stage = flagValue(args, "--stage")?.trim() || "final";
	if (stage !== "final") {
		throw new DeepInterviewCommandError(2, 'unknown --stage for deep-interview --write: expected "final"');
	}

	const slug = flagValue(args, "--slug")?.trim() || defaultSpecSlug();
	assertSafePathComponent(slug, "slug");

	const rawSpec = flagValue(args, "--spec");
	if (rawSpec === undefined || rawSpec === "") {
		throw new DeepInterviewCommandError(2, "--spec is required for deep-interview --write");
	}

	const session = resolveGjcSessionForWrite(cwd, {
		flagValue: flagValue(args, "--session-id"),
		envSessionId: process.env.GJC_SESSION_ID,
	});
	const sessionId = session.gjcSessionId;
	assertSafePathComponent(sessionId, "session-id");

	const rawHandoff = flagValue(args, "--handoff")?.trim() || undefined;
	if (rawHandoff && rawHandoff !== "ralplan") {
		throw new DeepInterviewCommandError(2, 'unknown --handoff target: expected "ralplan"');
	}

	const allowedFlags = new Set([
		"--write",
		"--stage",
		"--slug",
		"--spec",
		"--session-id",
		"--handoff",
		"--deliberate",
		"--json",
		"--force",
	]);
	let skipNext = false;
	for (const arg of args) {
		if (skipNext) {
			skipNext = false;
			continue;
		}
		if (["--stage", "--slug", "--spec", "--session-id", "--handoff"].includes(arg)) {
			skipNext = true;
			continue;
		}
		if (arg.startsWith("-") && !allowedFlags.has(arg)) {
			throw new DeepInterviewCommandError(2, `unknown flag for gjc deep-interview --write: ${arg}`);
		}
	}

	return {
		stage: "final",
		slug,
		spec: await resolveSpecContent(rawSpec, cwd),
		sessionId,
		json: hasFlag(args, "--json"),
		deliberate: hasFlag(args, "--deliberate"),
		force: hasFlag(args, "--force"),
		handoff: rawHandoff as "ralplan" | undefined,
	};
}

async function resolveDeepInterviewArgs(args: readonly string[], cwd: string): Promise<ResolvedDeepInterviewArgs> {
	const session = resolveGjcSessionForWrite(cwd, {
		flagValue: flagValue(args, "--session-id"),
		envSessionId: process.env.GJC_SESSION_ID,
	});
	const sessionId = session.gjcSessionId;
	assertSafePathComponent(sessionId, "session-id");

	const explicitResolutions = (["quick", "standard", "deep"] as const).filter(name => hasFlag(args, `--${name}`));
	if (explicitResolutions.length > 1) {
		throw new DeepInterviewCommandError(2, "pass at most one of --quick, --standard, --deep");
	}
	const resolution: DeepInterviewResolution | undefined = explicitResolutions[0];

	// Precedence: --threshold > settings.json (project then user) > resolution flag default > 0.05.
	let threshold: number = DEFAULT_AMBIGUITY_THRESHOLD;
	let thresholdSource = "default";
	const thresholdOverride = flagValue(args, "--threshold");
	if (thresholdOverride !== undefined) {
		const parsed = Number(thresholdOverride);
		if (!Number.isFinite(parsed) || parsed <= 0 || parsed > 1) {
			throw new DeepInterviewCommandError(
				2,
				`invalid --threshold: ${thresholdOverride}. Expected 0 < threshold <= 1.`,
			);
		}
		threshold = parsed;
		thresholdSource = flagValue(args, "--threshold-source")?.trim() || "flag:--threshold";
	} else {
		const configured = await resolveConfiguredAmbiguityThreshold(cwd);
		if (configured) {
			threshold = configured.threshold;
			thresholdSource = configured.source;
		} else if (resolution) {
			threshold = RESOLUTION_THRESHOLDS[resolution];
			thresholdSource = `flag:--${resolution}`;
		}
	}

	const ideaParts: string[] = [];
	let skipNext = false;
	for (const arg of args) {
		if (skipNext) {
			skipNext = false;
			continue;
		}
		if (VALUE_FLAGS.has(arg)) {
			skipNext = true;
			continue;
		}
		if (arg === "--quick" || arg === "--standard" || arg === "--deep" || arg === "--json") continue;
		if (arg.startsWith("-")) {
			throw new DeepInterviewCommandError(2, `unknown flag for gjc deep-interview: ${arg}`);
		}
		ideaParts.push(arg);
	}
	const idea = ideaParts.join(" ").trim();
	const effectiveResolution: DeepInterviewResolution = resolution ?? "standard";
	return {
		resolution: effectiveResolution,
		threshold,
		thresholdSource,
		sessionId,
		idea,
		language: resolveDeepInterviewLanguagePreference(idea),
		json: hasFlag(args, "--json"),
	};
}

export async function persistDeepInterviewSpec(
	cwd: string,
	resolved: ResolvedDeepInterviewSpecWriteArgs,
): Promise<PersistedDeepInterviewSpec> {
	const statePath = deepInterviewStatePath(cwd, resolved.sessionId);
	const existingRead = await readExistingStateForMutation(statePath);
	if (existingRead.kind === "corrupt" && !resolved.force) {
		throw new DeepInterviewCommandError(
			2,
			`existing deep-interview state is corrupt or tampered (${existingRead.error}); use --force to overwrite ${statePath}`,
		);
	}
	const existing = existingRead.kind === "valid" ? existingRead.value : {};

	const specPath = path.join(sessionSpecsDir(cwd, resolved.sessionId), `deep-interview-${resolved.slug}.md`);
	const content = resolved.spec.endsWith("\n") ? resolved.spec : `${resolved.spec}\n`;
	await writeArtifact(specPath, content, {
		cwd,
		audit: {
			category: "artifact",
			verb: "write",
			owner: "gjc-runtime",
			skill: "deep-interview",
			sessionId: resolved.sessionId,
		},
	});

	const sha256 = createHash("sha256").update(content).digest("hex");
	const createdAt = new Date().toISOString();
	await appendJsonl(
		path.join(sessionSpecsDir(cwd, resolved.sessionId), "deep-interview-index.jsonl"),
		{ slug: resolved.slug, stage: resolved.stage, path: specPath, created_at: createdAt, sha256 },
		{
			cwd,
			audit: {
				category: "ledger",
				verb: "append",
				owner: "gjc-runtime",
				skill: "deep-interview",
				sessionId: resolved.sessionId,
			},
		},
	);

	const payload = normalizeDeepInterviewEnvelope({
		...existing,
		active: true,
		current_phase: "handoff",
		skill: "deep-interview",
		version: WORKFLOW_STATE_VERSION,
		spec_slug: resolved.slug,
		spec_path: specPath,
		spec_sha256: sha256,
		spec_stage: resolved.stage,
		spec_persisted_at: createdAt,
		updated_at: createdAt,
	}) as Record<string, unknown>;
	if (resolved.sessionId) payload.session_id = resolved.sessionId;
	await writeWorkflowEnvelopeAtomic(statePath, payload, {
		cwd,
		receipt: {
			cwd,
			skill: "deep-interview",
			owner: "gjc-runtime",
			command: "gjc deep-interview persist-spec-state",
			sessionId: resolved.sessionId,
			nowIso: createdAt,
		},
		audit: {
			category: "state",
			verb: "write",
			owner: "gjc-runtime",
			skill: "deep-interview",
			sessionId: resolved.sessionId,
			forced: resolved.force,
		},
	});
	await writeSessionActivityMarker(cwd, resolved.sessionId, { writer: "deep-interview-runtime", path: statePath });
	await syncDeepInterviewHud({
		cwd,
		sessionId: resolved.sessionId,
		payload,
		phase: "handoff",
		specStatus: "persisted",
	});

	return {
		slug: resolved.slug,
		path: specPath,
		stage: resolved.stage,
		sha256,
		createdAt,
		statePath,
	};
}

async function seedDeepInterviewState(cwd: string, resolved: ResolvedDeepInterviewArgs): Promise<string> {
	const statePath = deepInterviewStatePath(cwd, resolved.sessionId);
	const now = new Date().toISOString();
	const payload: Record<string, unknown> = {
		active: true,
		current_phase: "interviewing",
		skill: "deep-interview",
		version: WORKFLOW_STATE_VERSION,
		resolution: resolved.resolution,
		threshold: resolved.threshold,
		threshold_source: resolved.thresholdSource,
		state: {
			initial_idea: resolved.idea,
			rounds: [],
			established_facts: [],
			current_ambiguity: 1.0,
			threshold: resolved.threshold,
			threshold_source: resolved.thresholdSource,
		},
		updated_at: now,
	};
	if (resolved.language) {
		payload.language = resolved.language;
		(payload.state as Record<string, unknown>).language = resolved.language;
	}
	if (resolved.sessionId) payload.session_id = resolved.sessionId;
	await writeWorkflowEnvelopeAtomic(statePath, payload, {
		cwd,
		receipt: {
			cwd,
			skill: "deep-interview",
			owner: "gjc-runtime",
			command: "gjc deep-interview seed",
			sessionId: resolved.sessionId,
			nowIso: now,
		},
		audit: {
			category: "state",
			verb: "write",
			owner: "gjc-runtime",
			skill: "deep-interview",
			sessionId: resolved.sessionId,
		},
	});
	await writeSessionActivityMarker(cwd, resolved.sessionId, { writer: "deep-interview-runtime", path: statePath });
	await syncDeepInterviewHud({ cwd, sessionId: resolved.sessionId, payload, phase: "interviewing" });
	return statePath;
}

async function syncDeepInterviewHud(options: {
	cwd: string;
	sessionId?: string;
	payload: Record<string, unknown>;
	phase?: string;
	specStatus?: string;
}): Promise<void> {
	try {
		const phase =
			options.phase ??
			(typeof options.payload.current_phase === "string" ? options.payload.current_phase : "interviewing");
		await syncSkillActiveState({
			cwd: options.cwd,
			skill: "deep-interview",
			active: phase !== "complete",
			phase,
			sessionId: options.sessionId,
			source: "gjc-deep-interview-native",
			hud: deriveDeepInterviewHud(options.payload, { phase, specStatus: options.specStatus }),
		});
	} catch {
		// HUD sync is best-effort and must not change command semantics.
	}
}

async function handleSpecWrite(args: readonly string[], cwd: string): Promise<DeepInterviewCommandResult> {
	const resolved = await resolveSpecWriteArgs(args, cwd);
	const persisted = await persistDeepInterviewSpec(cwd, resolved);
	const shouldHandoff = resolved.deliberate || resolved.handoff === "ralplan";
	const summary: DeepInterviewSpecWriteSummary = {
		skill: "deep-interview",
		stage: persisted.stage,
		slug: persisted.slug,
		path: persisted.path,
		sha256: persisted.sha256,
		spec_path: persisted.path,
		sha: persisted.sha256,
		created_at: persisted.createdAt,
		state_path: persisted.statePath,
	};

	if (shouldHandoff) {
		const ralplanArgs = ["--deliberate", "--json"];
		if (resolved.sessionId) ralplanArgs.push("--session-id", resolved.sessionId);
		ralplanArgs.push(persisted.path);
		const ralplanResult = await runNativeRalplanCommand(ralplanArgs, cwd);
		if (ralplanResult.status !== 0) {
			throw new DeepInterviewCommandError(
				ralplanResult.status,
				ralplanResult.stderr?.trim() || "failed to seed ralplan",
			);
		}

		const handoffArgs = ["handoff", "--mode", "deep-interview", "--to", "ralplan", "--json"];
		if (resolved.sessionId) handoffArgs.push("--session-id", resolved.sessionId);
		else handoffArgs.push("--session-id", "");
		const handoffResult = await runNativeStateCommand(handoffArgs, cwd);
		if (handoffResult.status !== 0) {
			throw new DeepInterviewCommandError(
				handoffResult.status,
				handoffResult.stderr?.trim() || "failed to hand off deep-interview to ralplan",
			);
		}

		const ralplanPayload = ralplanResult.stdout ? (JSON.parse(ralplanResult.stdout) as Record<string, unknown>) : {};
		summary.handoff = {
			to: "ralplan",
			mode: "deliberate",
			state_path: typeof ralplanPayload.state_path === "string" ? ralplanPayload.state_path : undefined,
			run_id: typeof ralplanPayload.run_id === "string" ? ralplanPayload.run_id : undefined,
		};
	}

	const stdout = resolved.json
		? `${JSON.stringify(summary)}\n`
		: [
				`deep-interview spec_path=${persisted.path}`,
				`sha=${persisted.sha256}`,
				`state_path=${persisted.statePath}`,
				shouldHandoff
					? `handoff=ralplan run_id=${summary.handoff?.run_id ?? ""} state_path=${summary.handoff?.state_path ?? ""}`
					: undefined,
				"",
			]
				.filter((line): line is string => Boolean(line))
				.join("\n");
	return { status: 0, stdout };
}

export async function runNativeDeepInterviewCommand(
	args: string[],
	cwd = process.cwd(),
): Promise<DeepInterviewCommandResult> {
	try {
		if (isDeepInterviewSpecWriteInvocation(args)) return await handleSpecWrite(args, cwd);
		const resolved = await resolveDeepInterviewArgs(args, cwd);
		if (!resolved.idea) {
			throw new DeepInterviewCommandError(
				2,
				'gjc deep-interview requires an idea, e.g. `gjc deep-interview "<idea>"`.',
			);
		}
		const statePath = await seedDeepInterviewState(cwd, resolved);

		const summary = {
			skill: "deep-interview",
			resolution: resolved.resolution,
			threshold: resolved.threshold,
			threshold_source: resolved.thresholdSource,
			idea: resolved.idea,
			language: resolved.language,
			state_path: statePath,
			handoff: "/skill:deep-interview",
		};
		const stdout = resolved.json
			? `${JSON.stringify(summary)}\n`
			: [
					`deep-interview seed state_path=${statePath}`,
					`resolution=${resolved.resolution} threshold=${resolved.threshold} threshold_source=${resolved.thresholdSource}`,
					"handoff=/skill:deep-interview",
					"",
				].join("\n");
		return { status: 0, stdout };
	} catch (error) {
		if (error instanceof DeepInterviewCommandError) return { status: error.exitStatus, stderr: `${error.message}\n` };
		return { status: 1, stderr: `${error instanceof Error ? error.message : String(error)}\n` };
	}
}
