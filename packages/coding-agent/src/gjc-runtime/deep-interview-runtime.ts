import { createHash, randomBytes } from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { syncSkillActiveState } from "../skill-state/active-state";
import { buildDeepInterviewHudSummary } from "../skill-state/workflow-hud";
import { runNativeRalplanCommand } from "./ralplan-runtime";
import { runNativeStateCommand } from "./state-runtime";

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

function encodeSessionSegment(value: string): string {
	return encodeURIComponent(value).replaceAll(".", "%2E");
}

function defaultSpecSlug(now: Date = new Date()): string {
	const yyyy = now.getUTCFullYear().toString().padStart(4, "0");
	const mm = (now.getUTCMonth() + 1).toString().padStart(2, "0");
	const dd = now.getUTCDate().toString().padStart(2, "0");
	const hh = now.getUTCHours().toString().padStart(2, "0");
	const min = now.getUTCMinutes().toString().padStart(2, "0");
	return `${yyyy}-${mm}-${dd}-${hh}${min}-${randomBytes(2).toString("hex")}`;
}

function stateDirFor(cwd: string, sessionId: string | undefined): string {
	return sessionId
		? path.join(cwd, ".gjc", "state", "sessions", encodeSessionSegment(sessionId))
		: path.join(cwd, ".gjc", "state");
}

function deepInterviewStatePath(cwd: string, sessionId: string | undefined): string {
	return path.join(stateDirFor(cwd, sessionId), "deep-interview-state.json");
}

async function readJsonObject(filePath: string): Promise<Record<string, unknown>> {
	try {
		const parsed = JSON.parse(await fs.readFile(filePath, "utf-8"));
		if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
	} catch {
		// Missing/corrupt state should not prevent the sanctioned persistence CLI from writing a receipt.
	}
	return {};
}

async function writeJsonAtomic(filePath: string, value: unknown): Promise<void> {
	await fs.mkdir(path.dirname(filePath), { recursive: true });
	const tmp = `${filePath}.tmp-${randomBytes(6).toString("hex")}`;
	await fs.writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`);
	await fs.rename(tmp, filePath);
}

async function resolveSpecContent(rawSpec: string, cwd: string): Promise<string> {
	const candidate = path.isAbsolute(rawSpec) ? rawSpec : path.resolve(cwd, rawSpec);
	try {
		const stat = await fs.stat(candidate);
		if (stat.isFile()) return await fs.readFile(candidate, "utf-8");
	} catch (error) {
		const err = error as NodeJS.ErrnoException;
		if (err.code !== "ENOENT" && err.code !== "ENOTDIR") {
			throw new DeepInterviewCommandError(2, `failed to read --spec ${candidate}: ${err.message}`);
		}
	}
	return rawSpec;
}

interface ResolvedDeepInterviewArgs {
	resolution: DeepInterviewResolution;
	threshold: number;
	thresholdSource: string;
	sessionId?: string;
	idea: string;
	json: boolean;
}

export interface ResolvedDeepInterviewSpecWriteArgs {
	stage: "final";
	slug: string;
	spec: string;
	sessionId?: string;
	json: boolean;
	deliberate: boolean;
	handoff?: "ralplan";
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

async function resolveConfiguredAmbiguityThreshold(
	cwd: string,
): Promise<{ threshold: number; source: string } | undefined> {
	const projectSettings = path.join(cwd, ".gjc", "settings.json");
	const projectValue = await readSettingsAmbiguityThreshold(projectSettings);
	if (projectValue) return projectValue;
	const configDir = process.env.GJC_CONFIG_DIR?.trim() || path.join(os.homedir(), ".gjc");
	const userSettings = path.join(configDir, "settings.json");
	return await readSettingsAmbiguityThreshold(userSettings);
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

	const sessionId = flagValue(args, "--session-id")?.trim() || undefined;
	if (sessionId) assertSafePathComponent(sessionId, "session-id");

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
		handoff: rawHandoff as "ralplan" | undefined,
	};
}

async function resolveDeepInterviewArgs(args: readonly string[], cwd: string): Promise<ResolvedDeepInterviewArgs> {
	const sessionId = flagValue(args, "--session-id")?.trim() || undefined;
	if (sessionId) assertSafePathComponent(sessionId, "session-id");

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
		json: hasFlag(args, "--json"),
	};
}

export async function persistDeepInterviewSpec(
	cwd: string,
	resolved: ResolvedDeepInterviewSpecWriteArgs,
): Promise<PersistedDeepInterviewSpec> {
	const specsDir = path.join(cwd, ".gjc", "specs");
	await fs.mkdir(specsDir, { recursive: true });
	const specPath = path.join(specsDir, `deep-interview-${resolved.slug}.md`);
	const content = resolved.spec.endsWith("\n") ? resolved.spec : `${resolved.spec}\n`;
	await fs.writeFile(specPath, content);

	const sha256 = createHash("sha256").update(content).digest("hex");
	const createdAt = new Date().toISOString();
	await fs.appendFile(
		path.join(specsDir, "deep-interview-index.jsonl"),
		`${JSON.stringify({ slug: resolved.slug, stage: resolved.stage, path: specPath, created_at: createdAt, sha256 })}\n`,
	);

	const statePath = deepInterviewStatePath(cwd, resolved.sessionId);
	const existing = await readJsonObject(statePath);
	const payload: Record<string, unknown> = {
		...existing,
		active: true,
		current_phase: "handoff",
		skill: "deep-interview",
		version: typeof existing.version === "number" ? existing.version : 1,
		spec_slug: resolved.slug,
		spec_path: specPath,
		spec_sha256: sha256,
		spec_stage: resolved.stage,
		spec_persisted_at: createdAt,
		updated_at: createdAt,
	};
	if (resolved.sessionId) payload.session_id = resolved.sessionId;
	await writeJsonAtomic(statePath, payload);
	await syncDeepInterviewHud({
		cwd,
		sessionId: resolved.sessionId,
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
	const stateDir = resolved.sessionId
		? path.join(cwd, ".gjc", "state", "sessions", encodeSessionSegment(resolved.sessionId))
		: path.join(cwd, ".gjc", "state");
	await fs.mkdir(stateDir, { recursive: true });
	const statePath = path.join(stateDir, "deep-interview-state.json");
	const now = new Date().toISOString();
	const payload: Record<string, unknown> = {
		active: true,
		current_phase: "interviewing",
		skill: "deep-interview",
		resolution: resolved.resolution,
		threshold: resolved.threshold,
		threshold_source: resolved.thresholdSource,
		state: {
			initial_idea: resolved.idea,
			rounds: [],
			current_ambiguity: 1.0,
			threshold: resolved.threshold,
			threshold_source: resolved.thresholdSource,
		},
		updated_at: now,
	};
	if (resolved.sessionId) payload.session_id = resolved.sessionId;
	await fs.writeFile(statePath, `${JSON.stringify(payload, null, 2)}\n`);
	return statePath;
}

async function syncDeepInterviewHud(options: {
	cwd: string;
	sessionId?: string;
	phase: string;
	ambiguity?: number;
	threshold?: number;
	roundCount?: number;
	specStatus?: string;
}): Promise<void> {
	try {
		await syncSkillActiveState({
			cwd: options.cwd,
			skill: "deep-interview",
			active: options.phase !== "complete",
			phase: options.phase,
			sessionId: options.sessionId,
			source: "gjc-deep-interview-native",
			hud: buildDeepInterviewHudSummary({
				phase: options.phase,
				ambiguity: options.ambiguity,
				threshold: options.threshold,
				roundCount: options.roundCount,
				specStatus: options.specStatus,
				updatedAt: new Date().toISOString(),
			}),
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
		? `${JSON.stringify(summary, null, 2)}\n`
		: [
				`Persisted deep-interview ${persisted.stage} spec at ${persisted.path}.`,
				shouldHandoff ? "Handed off deep-interview to ralplan (deliberate)." : undefined,
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
		await syncDeepInterviewHud({
			cwd,
			sessionId: resolved.sessionId,
			phase: "interviewing",
			ambiguity: 1,
			threshold: resolved.threshold,
			roundCount: 0,
		});

		const summary = {
			skill: "deep-interview",
			resolution: resolved.resolution,
			threshold: resolved.threshold,
			threshold_source: resolved.thresholdSource,
			idea: resolved.idea,
			state_path: statePath,
			handoff: "Run `/skill:deep-interview` inside the GJC agent to drive the Socratic interview loop.",
		};
		const stdout = resolved.json
			? `${JSON.stringify(summary, null, 2)}\n`
			: [
					`Seeded deep-interview ${resolved.resolution} run at ${statePath}.`,
					`Threshold: ${(resolved.threshold * 100).toFixed(0)}% (source: ${resolved.thresholdSource}).`,
					"Run `/skill:deep-interview` inside the GJC agent to execute the interview.",
					"",
				].join("\n");
		return { status: 0, stdout };
	} catch (error) {
		if (error instanceof DeepInterviewCommandError) return { status: error.exitStatus, stderr: `${error.message}\n` };
		return { status: 1, stderr: `${error instanceof Error ? error.message : String(error)}\n` };
	}
}
