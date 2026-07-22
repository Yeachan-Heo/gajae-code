import { createHash, randomBytes } from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { YAML } from "bun";
import { syncSkillActiveState } from "../skill-state/active-state";
import { deriveDeepInterviewHud } from "../skill-state/workflow-hud";
import { WORKFLOW_STATE_VERSION } from "../skill-state/workflow-state-contract";
import {
	assertDeepInterviewInputWithinLimit,
	assertDeepInterviewIntentReview,
	type DeepInterviewIntentCategory,
	type DeepInterviewIntentItem,
	type DeepInterviewIntentManifest,
	type DeepInterviewIntentReview,
	MAX_DEEP_INTERVIEW_STRUCTURED_RESPONSE_LENGTH,
	MAX_INITIAL_CONTEXT_LENGTH,
	normalizeDeepInterviewEnvelope,
	reviewDeepInterviewIntent,
} from "./deep-interview-state";
import { runNativeRalplanCommand } from "./ralplan-runtime";
import { modeStatePath, sessionSpecsDir } from "./session-layout";
import { resolveGjcSessionForWrite, writeSessionActivityMarker } from "./session-resolution";
import { runNativeStateCommand } from "./state-runtime";
import { appendJsonl, readExistingStateForMutation, writeArtifact, writeWorkflowEnvelopeAtomic } from "./state-writer";
import { assertSafePathComponent, CommandError, flagValue, hasFlag } from "./workflow-cli-common";

export * from "./deep-interview-recorder";

/**
 * Native implementation of `gjc deep-interview`.
 *
 * The CLI itself does not run the Socratic interview; that lives inside the `/skill:deep-interview`
 * skill executed by the agent. This handler validates the documented argument-hint surface
 * (`[--trace] [--quick|--standard|--deep] <idea>`), seeds `.gjc/state/deep-interview-state.json`, and
 * updates the shared HUD rail via `syncSkillActiveState` so the active interview is visible to
 * the TUI.
 */

export interface DeepInterviewCommandResult {
	status: number;
	stdout?: string;
	stderr?: string;
}

const DEFAULT_AMBIGUITY_THRESHOLD = 0.05;

const RESOLUTION_THRESHOLDS = {
	quick: 0.6,
	standard: 0.5,
	deep: 0.35,
} as const;

const TRACE_MAX_RELEVANT_PATHS = 12;
const TRACE_MAX_PACKAGE_HINTS = 8;
const TRACE_MAX_DIRECTORY_VISITS = 1200;
const TRACE_MAX_ENTRY_VISITS = 5000;
const TRACE_MAX_PENDING_DIRECTORIES = 1200;
const TRACE_SKIP_DIRS = new Set([
	".git",
	".gjc",
	"node_modules",
	"dist",
	"build",
	"coverage",
	".next",
	".turbo",
	".cache",
	"vendor",
	"target",
	".venv",
	"venv",
	"__pycache__",
	".pytest_cache",
	"tmp",
	"temp",
	"logs",
	"out",
]);
const TRACE_SOURCE_EXTENSIONS = new Set([
	".ts",
	".tsx",
	".js",
	".jsx",
	".mts",
	".cts",
	".py",
	".rs",
	".go",
	".java",
	".kt",
	".swift",
	".md",
	".json",
	".yml",
	".yaml",
]);

interface DeepInterviewTraceSummary {
	enabled: true;
	generated_at: string;
	bounded: true;
	limits: {
		max_relevant_paths: number;
		max_package_hints: number;
		max_directory_visits: number;
		max_entry_visits: number;
		max_pending_directories: number;
	};
	idea_terms: string[];
	project_hints: string[];
	relevant_paths: Array<{ path: string; reason: string }>;
	findings: string[];
}

type DeepInterviewResolution = keyof typeof RESOLUTION_THRESHOLDS;

class DeepInterviewCommandError extends CommandError {
	constructor(exitStatus: number, message: string) {
		super(exitStatus, message);
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

function traceTerms(idea: string): string[] {
	const terms = new Set<string>();
	for (const match of idea.toLowerCase().matchAll(/[a-z0-9][a-z0-9_-]{2,}/g)) {
		const value = match[0];
		if (["the", "and", "for", "with", "that", "this", "from", "into", "should", "would"].includes(value)) continue;
		terms.add(value);
		if (terms.size >= 12) break;
	}
	return [...terms];
}

function relativePathReason(relativePath: string, terms: readonly string[]): string | undefined {
	const normalized = relativePath.toLowerCase();
	const matched = terms.find(term => normalized.includes(term));
	if (matched) return `path matches idea term "${matched}"`;
	if (/deep[-_]?interview/i.test(relativePath)) return "path matches deep-interview workflow surface";
	if (/skill|workflow|runtime|state/i.test(relativePath)) return "path matches workflow/runtime surface";
	return undefined;
}

async function readPackageHints(cwd: string): Promise<string[]> {
	const packagePath = path.join(cwd, "package.json");
	let parsed: unknown;
	try {
		parsed = JSON.parse(await fs.readFile(packagePath, "utf-8"));
	} catch {
		return [];
	}
	const manifest = parsed as {
		name?: unknown;
		workspaces?: unknown;
		scripts?: Record<string, unknown>;
		dependencies?: Record<string, unknown>;
		devDependencies?: Record<string, unknown>;
	};
	const hints: string[] = [];
	if (typeof manifest.name === "string") hints.push(`package: ${manifest.name}`);
	if (manifest.workspaces) hints.push("workspace: package.json declares workspaces");
	const scripts = Object.keys(manifest.scripts ?? {}).slice(0, TRACE_MAX_PACKAGE_HINTS);
	if (scripts.length > 0) hints.push(`scripts: ${scripts.join(", ")}`);
	const deps = [...Object.keys(manifest.dependencies ?? {}), ...Object.keys(manifest.devDependencies ?? {})]
		.filter(name => /typescript|bun|react|vite|zod|winston|commander|oclif/i.test(name))
		.slice(0, TRACE_MAX_PACKAGE_HINTS);
	if (deps.length > 0) hints.push(`notable dependencies: ${deps.join(", ")}`);
	return hints.slice(0, TRACE_MAX_PACKAGE_HINTS);
}

async function collectRelevantTracePaths(
	cwd: string,
	terms: readonly string[],
): Promise<Array<{ path: string; reason: string }>> {
	const results: Array<{ path: string; reason: string; score: number }> = [];
	const pending: Array<{ absolutePath: string; depth: number }> = [{ absolutePath: cwd, depth: 0 }];
	let visitedDirectories = 0;
	let visitedEntries = 0;
	while (
		pending.length > 0 &&
		visitedDirectories < TRACE_MAX_DIRECTORY_VISITS &&
		visitedEntries < TRACE_MAX_ENTRY_VISITS
	) {
		const current = pending.shift();
		if (!current) break;
		visitedDirectories += 1;
		try {
			const directory = await fs.opendir(current.absolutePath);
			for await (const entry of directory) {
				visitedEntries += 1;
				if (visitedEntries > TRACE_MAX_ENTRY_VISITS) break;
				if (TRACE_SKIP_DIRS.has(entry.name)) continue;
				const absolutePath = path.join(current.absolutePath, entry.name);
				const relativePath = path.relative(cwd, absolutePath).split(path.sep).join("/");
				if (entry.isDirectory()) {
					if (current.depth < 6 && pending.length < TRACE_MAX_PENDING_DIRECTORIES) {
						pending.push({ absolutePath, depth: current.depth + 1 });
					}
					continue;
				}
				if (!entry.isFile() || !TRACE_SOURCE_EXTENSIONS.has(path.extname(entry.name))) continue;
				const reason = relativePathReason(relativePath, terms);
				if (!reason) continue;
				const termScore = terms.reduce(
					(score, term) => score + (relativePath.toLowerCase().includes(term) ? 2 : 0),
					0,
				);
				const surfaceScore = /deep[-_]?interview|skill|workflow|runtime|state/i.test(relativePath) ? 1 : 0;
				results.push({ path: relativePath, reason, score: termScore + surfaceScore });
			}
		} catch {}
	}
	return results
		.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path))
		.slice(0, TRACE_MAX_RELEVANT_PATHS)
		.map(({ path: relativePath, reason }) => ({ path: relativePath, reason }));
}

async function buildDeepInterviewTraceSummary(cwd: string, idea: string): Promise<DeepInterviewTraceSummary> {
	const terms = traceTerms(idea);
	const [projectHints, relevantPaths] = await Promise.all([
		readPackageHints(cwd),
		collectRelevantTracePaths(cwd, terms),
	]);
	const findings = [
		projectHints.length > 0
			? "Project manifest was summarized into bounded package/script/dependency hints."
			: "No readable package.json manifest was found at the project root.",
		relevantPaths.length > 0
			? `Relevant path scan captured ${relevantPaths.length} bounded path hint(s) before interview questions.`
			: "Relevant path scan found no matching source/documentation paths before interview questions.",
		"Trace summary intentionally stores path-level evidence only; raw files and logs are excluded.",
	];
	return {
		enabled: true,
		generated_at: new Date().toISOString(),
		bounded: true,
		limits: {
			max_relevant_paths: TRACE_MAX_RELEVANT_PATHS,
			max_package_hints: TRACE_MAX_PACKAGE_HINTS,
			max_directory_visits: TRACE_MAX_DIRECTORY_VISITS,
			max_entry_visits: TRACE_MAX_ENTRY_VISITS,
			max_pending_directories: TRACE_MAX_PENDING_DIRECTORIES,
		},
		idea_terms: terms,
		project_hints: projectHints,
		relevant_paths: relevantPaths,
		findings,
	};
}

interface ResolvedDeepInterviewArgs {
	resolution: DeepInterviewResolution;
	threshold: number;
	thresholdSource: string;
	sessionId: string;
	idea: string;
	language?: DeepInterviewLanguagePreference;
	trace?: DeepInterviewTraceSummary;
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
		parsed = YAML.parse(await fs.readFile(modernConfigPath, "utf-8"));
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
		if (arg === "--trace") continue;
		if (arg === "--quick" || arg === "--standard" || arg === "--deep" || arg === "--json") continue;
		if (arg.startsWith("-")) {
			throw new DeepInterviewCommandError(2, `unknown flag for gjc deep-interview: ${arg}`);
		}
		ideaParts.push(arg);
	}
	const idea = ideaParts.join(" ").trim();
	assertDeepInterviewInputWithinLimit(idea, MAX_INITIAL_CONTEXT_LENGTH, "initial_idea");
	const effectiveResolution: DeepInterviewResolution = resolution ?? "standard";
	const trace = hasFlag(args, "--trace") && idea ? await buildDeepInterviewTraceSummary(cwd, idea) : undefined;
	return {
		resolution: effectiveResolution,
		threshold,
		thresholdSource,
		sessionId,
		idea,
		language: resolveDeepInterviewLanguagePreference(idea),
		trace,
		json: hasFlag(args, "--json"),
	};
}

function intentIdsInSpec(content: string): string[] {
	const ids = content.match(/(?:artifact|surface|integration|constraint):[a-z0-9][a-z0-9._/-]{0,127}/g) ?? [];
	return [...new Set(ids)].sort();
}

function resolveLockedIntentReview(existing: unknown, content: string): DeepInterviewIntentReview | undefined {
	const envelope = normalizeDeepInterviewEnvelope(existing);
	const state = envelope.state;
	if (!state) return undefined;
	if (state.intent_contract === undefined) {
		if (state.intent_contract_required === true)
			throw new DeepInterviewCommandError(
				2,
				"deep-interview locked intent blocks spec persistence: missing Round 0 intent contract",
			);
		return undefined;
	}
	const locked = state.intent_contract as DeepInterviewIntentManifest;
	const observedIds = intentIdsInSpec(content);
	const rounds = Array.isArray(state.rounds)
		? state.rounds
				.filter(
					(round): round is Record<string, unknown> =>
						Boolean(round) && typeof round === "object" && !Array.isArray(round),
				)
				.map(round => ({ round: round.round, answer_hash: round.answer_hash }))
		: [];
	try {
		if (state.intent_review === undefined) {
			if (locked.items.some(item => !observedIds.includes(item.id))) throw new Error("missing intent review");
			const lockedById = new Map(locked.items.map(item => [item.id, item]));
			const observedItems: DeepInterviewIntentItem[] = observedIds.map(id => {
				const existingItem = lockedById.get(id);
				if (existingItem) return existingItem;
				return {
					id,
					category: id.slice(0, id.indexOf(":")) as DeepInterviewIntentCategory,
					statement: id,
				};
			});
			return reviewDeepInterviewIntent(locked, observedItems, {
				status: "not_required",
				supporting_substitutions: [],
			});
		}
		assertDeepInterviewIntentReview(state.intent_review, locked, observedIds, rounds);
		return state.intent_review as DeepInterviewIntentReview;
	} catch (error) {
		throw new DeepInterviewCommandError(
			2,
			`deep-interview locked intent blocks spec persistence: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
}

export async function persistDeepInterviewSpec(
	cwd: string,
	resolved: ResolvedDeepInterviewSpecWriteArgs,
): Promise<PersistedDeepInterviewSpec> {
	assertDeepInterviewInputWithinLimit(
		resolved.spec,
		MAX_DEEP_INTERVIEW_STRUCTURED_RESPONSE_LENGTH,
		"structured deep-interview response",
	);
	const statePath = deepInterviewStatePath(cwd, resolved.sessionId);
	const existingRead = await readExistingStateForMutation(statePath);
	if (existingRead.kind === "corrupt" && !resolved.force) {
		throw new DeepInterviewCommandError(
			2,
			`existing deep-interview state is corrupt or tampered (${existingRead.error}); use --force to overwrite ${statePath}`,
		);
	}
	const existing = existingRead.kind === "valid" ? existingRead.value : {};

	const content = resolved.spec.endsWith("\n") ? resolved.spec : `${resolved.spec}\n`;
	const intentReview = resolveLockedIntentReview(existing, content);
	const specPath = path.join(sessionSpecsDir(cwd, resolved.sessionId), `deep-interview-${resolved.slug}.md`);
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
	if (intentReview) {
		const state = payload.state as Record<string, unknown>;
		state.intent_review = intentReview;
	}
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
	assertDeepInterviewInputWithinLimit(resolved.idea, MAX_INITIAL_CONTEXT_LENGTH, "initial_idea");
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
			intent_contract_required: true,
			rounds: [],
			established_facts: [],
			current_ambiguity: 1.0,
			threshold: resolved.threshold,
			threshold_source: resolved.thresholdSource,
		},
		updated_at: now,
	};
	if (resolved.trace) {
		payload.trace = resolved.trace;
		(payload.state as Record<string, unknown>).trace = resolved.trace;
		(payload.state as Record<string, unknown>).trace_summary = resolved.trace;
		(payload.state as Record<string, unknown>).codebase_context = {
			source: "trace",
			summary: resolved.trace.findings,
			relevant_paths: resolved.trace.relevant_paths,
			project_hints: resolved.trace.project_hints,
		};
	}
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
			trace: resolved.trace,
			state_path: statePath,
			handoff: "/skill:deep-interview",
		};
		const stdout = resolved.json
			? `${JSON.stringify(summary)}\n`
			: [
					`deep-interview seed state_path=${statePath}`,
					`resolution=${resolved.resolution} threshold=${resolved.threshold} threshold_source=${resolved.thresholdSource}`,
					resolved.trace ? `trace=enabled bounded_paths=${resolved.trace.relevant_paths.length}` : undefined,
					"handoff=/skill:deep-interview",
					"",
				].join("\n");
		return { status: 0, stdout };
	} catch (error) {
		if (error instanceof CommandError) return { status: error.exitStatus, stderr: `${error.message}\n` };
		return { status: 1, stderr: `${error instanceof Error ? error.message : String(error)}\n` };
	}
}
