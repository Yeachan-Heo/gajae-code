import { createHash, randomBytes } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { syncSkillActiveState } from "../skill-state/active-state";
import { buildRalplanHudSummary } from "../skill-state/workflow-hud";
import { isRestrictedRoleAgentBash } from "./restricted-role-agent-bash";
import { appendJsonl, writeArtifact, writeJsonAtomic } from "./state-writer";

/**
 * Native implementation of `gjc ralplan`.
 *
 * Two invocation shapes are handled natively:
 *
 * 1. **Consensus handoff**: `gjc ralplan [--interactive] [--deliberate] [--architect <kind>]
 *    [--critic <kind>] [--session-id <id>] "<task>"` validates the documented flag surface,
 *    seeds `.gjc/state/ralplan-state.json`, and updates the shared HUD rail via
 *    `syncSkillActiveState`. The CLI never *runs* the Planner / Architect / Critic loop itself —
 *    that lives in the bundled `/skill:ralplan` skill — but it accepts every documented flag so
 *    scripted users see a useful response and the active run is visible to the TUI.
 *
 * 2. **Artifact write**: `gjc ralplan --write --stage <type> --stage_n <N> --artifact
 *    <path-or-string> [--run-id <id>] [--session-id <id>] [--json]` persists Planner / Architect
 *    / Critic / revision / ADR / final markdown under `.gjc/plans/ralplan/<run-id>/`, maintains
 *    an `index.jsonl` audit log, copies `final` stages to `pending-approval.md`, and advances
 *    the HUD chip to reflect the latest persisted stage.
 */

export interface RalplanCommandResult {
	status: number;
	stdout?: string;
	stderr?: string;
}

const KNOWN_STAGES = ["planner", "architect", "critic", "revision", "adr", "final"] as const;
type RalplanStage = (typeof KNOWN_STAGES)[number];

const KNOWN_ARCHITECT_KINDS = new Set(["openai-code"]);
const KNOWN_CRITIC_KINDS = new Set(["openai-code"]);

const PATH_COMPONENT_RE = /^[A-Za-z0-9_-][A-Za-z0-9._-]{0,63}$/;

class RalplanCommandError extends Error {
	constructor(
		public readonly exitStatus: number,
		message: string,
	) {
		super(message);
		this.name = "RalplanCommandError";
	}
}

const VALUE_FLAGS = new Set([
	"--stage",
	"--stage_n",
	"--artifact",
	"--run-id",
	"--session-id",
	"--architect",
	"--critic",
]);

function flagValue(args: readonly string[], flag: string): string | undefined {
	const index = args.indexOf(flag);
	if (index < 0) return undefined;
	return args[index + 1];
}

function hasFlag(args: readonly string[], flag: string): boolean {
	return args.includes(flag);
}

export function isRalplanArtifactWriteInvocation(args: readonly string[]): boolean {
	return hasFlag(args, "--write");
}

function assertSafePathComponent(value: string, label: string): void {
	if (!PATH_COMPONENT_RE.test(value) || value.includes("..")) {
		throw new RalplanCommandError(2, `invalid path component for --${label}: ${value}`);
	}
}

function assertKnownStage(stage: string): asserts stage is RalplanStage {
	if (!(KNOWN_STAGES as readonly string[]).includes(stage)) {
		throw new RalplanCommandError(2, `unknown --stage: ${stage}. Expected one of: ${KNOWN_STAGES.join(", ")}.`);
	}
}

function parseStageN(raw: string | undefined): number {
	if (!raw) throw new RalplanCommandError(2, "--stage_n is required");
	if (!/^[1-9][0-9]{0,2}$/.test(raw)) {
		throw new RalplanCommandError(2, `invalid --stage_n: ${raw}. Expected integer 1..999.`);
	}
	const value = Number.parseInt(raw, 10);
	if (value < 1 || value > 999) {
		throw new RalplanCommandError(2, `invalid --stage_n: ${raw}. Expected integer 1..999.`);
	}
	return value;
}

function pad2(value: number): string {
	return value.toString().padStart(2, "0");
}

function defaultRunId(now: Date = new Date()): string {
	const yyyy = now.getUTCFullYear().toString().padStart(4, "0");
	const mm = (now.getUTCMonth() + 1).toString().padStart(2, "0");
	const dd = now.getUTCDate().toString().padStart(2, "0");
	const hh = now.getUTCHours().toString().padStart(2, "0");
	const min = now.getUTCMinutes().toString().padStart(2, "0");
	const suffix = randomBytes(2).toString("hex");
	return `${yyyy}-${mm}-${dd}-${hh}${min}-${suffix}`;
}

async function resolveArtifactContent(rawArtifact: string, cwd: string): Promise<string> {
	if (isRestrictedRoleAgentBash()) return rawArtifact;
	const candidate = path.isAbsolute(rawArtifact) ? rawArtifact : path.resolve(cwd, rawArtifact);
	try {
		const stat = await fs.stat(candidate);
		if (stat.isFile()) return await fs.readFile(candidate, "utf-8");
	} catch (error) {
		const err = error as NodeJS.ErrnoException;
		if (err.code !== "ENOENT" && err.code !== "ENOTDIR") {
			throw new RalplanCommandError(2, `failed to read --artifact ${candidate}: ${err.message}`);
		}
	}
	return rawArtifact;
}

/* ------------------------------ artifact write ------------------------------ */

interface ResolvedArtifactArgs {
	stage: RalplanStage;
	stageN: number;
	runId: string;
	artifact: string;
	sessionId: string | undefined;
	json: boolean;
}

function ralplanStatePath(cwd: string, sessionId: string | undefined): string {
	const stateDir = sessionId
		? path.join(cwd, ".gjc", "state", "sessions", encodeSessionSegment(sessionId))
		: path.join(cwd, ".gjc", "state");
	return path.join(stateDir, "ralplan-state.json");
}

async function readActiveRunId(cwd: string, sessionId: string | undefined): Promise<string | undefined> {
	try {
		const raw = await fs.readFile(ralplanStatePath(cwd, sessionId), "utf-8");
		const parsed = JSON.parse(raw) as { run_id?: unknown };
		const candidate = typeof parsed.run_id === "string" ? parsed.run_id.trim() : "";
		if (!candidate) return undefined;
		assertSafePathComponent(candidate, "run-id");
		return candidate;
	} catch {
		return undefined;
	}
}

async function persistActiveRunId(cwd: string, sessionId: string | undefined, runId: string): Promise<void> {
	const statePath = ralplanStatePath(cwd, sessionId);
	let existing: Record<string, unknown> = {};
	try {
		const raw = await fs.readFile(statePath, "utf-8");
		const parsed = JSON.parse(raw);
		if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
			existing = parsed as Record<string, unknown>;
		}
	} catch {
		// fresh receipt; fall through to create
	}
	if (existing.run_id === runId) return;
	existing.run_id = runId;
	if (typeof existing.skill !== "string") existing.skill = "ralplan";
	if (typeof existing.active !== "boolean") existing.active = true;
	existing.updated_at = new Date().toISOString();
	await writeJsonAtomic(statePath, existing, {
		cwd,
		audit: { category: "state", verb: "write", owner: "gjc-runtime", skill: "ralplan" },
	});
}

async function resolveArtifactArgs(args: readonly string[], cwd: string): Promise<ResolvedArtifactArgs> {
	const stage = flagValue(args, "--stage");
	if (!stage) throw new RalplanCommandError(2, "--stage is required for ralplan --write");
	assertKnownStage(stage);

	const stageN = parseStageN(flagValue(args, "--stage_n"));

	const rawArtifact = flagValue(args, "--artifact");
	if (rawArtifact === undefined || rawArtifact === "") {
		throw new RalplanCommandError(2, "--artifact is required for ralplan --write");
	}

	const sessionIdRaw = flagValue(args, "--session-id")?.trim();
	const sessionId = sessionIdRaw || undefined;
	if (sessionId) assertSafePathComponent(sessionId, "session-id");

	// Precedence for run_id:
	//   1. explicit --run-id flag
	//   2. existing run_id field in .gjc/state[/sessions/<id>]/ralplan-state.json
	//   3. explicit --session-id flag (use as run id)
	//   4. freshly generated default run id
	const explicitRunId = flagValue(args, "--run-id")?.trim();
	const runId = explicitRunId || (await readActiveRunId(cwd, sessionId)) || sessionIdRaw || defaultRunId();
	assertSafePathComponent(runId, "run-id");
	// Persist the active run id so later writes in the same loop land in the same directory.
	await persistActiveRunId(cwd, sessionId, runId);

	const artifact = await resolveArtifactContent(rawArtifact, cwd);
	return { stage: stage as RalplanStage, stageN, runId, artifact, sessionId, json: hasFlag(args, "--json") };
}

interface PersistedArtifact {
	runId: string;
	path: string;
	stage: RalplanStage;
	stageN: number;
	sha256: string;
	createdAt: string;
	pendingApprovalPath?: string;
}

async function persistArtifact(resolved: ResolvedArtifactArgs, cwd: string): Promise<PersistedArtifact> {
	const runDir = path.join(cwd, ".gjc", "plans", "ralplan", resolved.runId);

	const fileName = `stage-${pad2(resolved.stageN)}-${resolved.stage}.md`;
	const filePath = path.join(runDir, fileName);
	const content = resolved.artifact.endsWith("\n") ? resolved.artifact : `${resolved.artifact}\n`;
	await writeArtifact(filePath, content, {
		cwd,
		audit: { category: "artifact", verb: "write", owner: "gjc-runtime", skill: "ralplan" },
	});

	const sha256 = createHash("sha256").update(content).digest("hex");
	const createdAt = new Date().toISOString();
	const indexEntry = {
		stage: resolved.stage,
		stage_n: resolved.stageN,
		path: filePath,
		created_at: createdAt,
		sha256,
	};
	await appendJsonl(path.join(runDir, "index.jsonl"), indexEntry, {
		cwd,
		audit: { category: "ledger", verb: "append", owner: "gjc-runtime", skill: "ralplan" },
	});

	let pendingApprovalPath: string | undefined;
	if (resolved.stage === "final") {
		pendingApprovalPath = path.join(runDir, "pending-approval.md");
		await writeArtifact(pendingApprovalPath, content, {
			cwd,
			audit: { category: "artifact", verb: "write", owner: "gjc-runtime", skill: "ralplan" },
		});
	}

	return {
		runId: resolved.runId,
		path: filePath,
		stage: resolved.stage,
		stageN: resolved.stageN,
		sha256,
		createdAt,
		pendingApprovalPath,
	};
}

async function syncRalplanHud(options: {
	cwd: string;
	sessionId?: string;
	stage: string;
	pendingApproval: boolean;
	iteration?: number;
	latestSummary?: string;
}): Promise<void> {
	try {
		await syncSkillActiveState({
			cwd: options.cwd,
			skill: "ralplan",
			active: !options.pendingApproval || options.stage === "final",
			phase: options.stage,
			sessionId: options.sessionId,
			source: "gjc-ralplan-native",
			hud: buildRalplanHudSummary({
				stage: options.stage,
				iteration: options.iteration,
				pendingApproval: options.pendingApproval,
				latestSummary: options.latestSummary,
				updatedAt: new Date().toISOString(),
			}),
		});
	} catch {
		// HUD sync is best-effort and must not change command semantics.
	}
}

async function handleArtifactWrite(args: readonly string[], cwd: string): Promise<RalplanCommandResult> {
	const resolved = await resolveArtifactArgs(args, cwd);
	const persisted = await persistArtifact(resolved, cwd);
	await syncRalplanHud({
		cwd,
		sessionId: resolved.sessionId,
		stage: persisted.stage,
		pendingApproval: persisted.stage === "final",
		iteration: persisted.stageN,
		latestSummary: `persisted ${persisted.stage} stage ${persisted.stageN}`,
	});
	const payload: Record<string, unknown> = {
		run_id: persisted.runId,
		path: persisted.path,
		stage: persisted.stage,
		stage_n: persisted.stageN,
		sha256: persisted.sha256,
		created_at: persisted.createdAt,
	};
	if (persisted.pendingApprovalPath) payload.pending_approval_path = persisted.pendingApprovalPath;
	const stdout = resolved.json
		? `${JSON.stringify(payload, null, 2)}\n`
		: `Persisted ralplan ${persisted.stage} stage ${persisted.stageN} at ${persisted.path}.\n`;
	return { status: 0, stdout };
}

/* -------------------------------- handoff -------------------------------- */

interface ConsensusHandoffArgs {
	interactive: boolean;
	deliberate: boolean;
	architectKind?: string;
	criticKind?: string;
	sessionId?: string;
	task: string;
	json: boolean;
}

function extractPositionalTask(args: readonly string[]): string {
	const parts: string[] = [];
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
		if (arg === "--interactive" || arg === "--deliberate" || arg === "--write" || arg === "--json") continue;
		if (arg.startsWith("-")) {
			throw new RalplanCommandError(2, `unknown flag for gjc ralplan: ${arg}`);
		}
		parts.push(arg);
	}
	return parts.join(" ").trim();
}

function resolveConsensusArgs(args: readonly string[]): ConsensusHandoffArgs {
	const architectKind = flagValue(args, "--architect")?.trim() || undefined;
	if (architectKind && !KNOWN_ARCHITECT_KINDS.has(architectKind)) {
		throw new RalplanCommandError(
			2,
			`unknown --architect kind: ${architectKind}. Expected one of: ${[...KNOWN_ARCHITECT_KINDS].join(", ")}.`,
		);
	}
	const criticKind = flagValue(args, "--critic")?.trim() || undefined;
	if (criticKind && !KNOWN_CRITIC_KINDS.has(criticKind)) {
		throw new RalplanCommandError(
			2,
			`unknown --critic kind: ${criticKind}. Expected one of: ${[...KNOWN_CRITIC_KINDS].join(", ")}.`,
		);
	}
	const sessionId = flagValue(args, "--session-id")?.trim() || undefined;
	if (sessionId) assertSafePathComponent(sessionId, "session-id");
	const task = extractPositionalTask(args);
	return {
		interactive: hasFlag(args, "--interactive"),
		deliberate: hasFlag(args, "--deliberate"),
		architectKind,
		criticKind,
		sessionId,
		task,
		json: hasFlag(args, "--json"),
	};
}

function encodeSessionSegment(value: string): string {
	return encodeURIComponent(value).replaceAll(".", "%2E");
}

async function seedRalplanState(
	cwd: string,
	resolved: ConsensusHandoffArgs,
): Promise<{ statePath: string; runId: string }> {
	const stateDir = resolved.sessionId
		? path.join(cwd, ".gjc", "state", "sessions", encodeSessionSegment(resolved.sessionId))
		: path.join(cwd, ".gjc", "state");

	const statePath = path.join(stateDir, "ralplan-state.json");
	// Reuse an existing run id when present so a re-invocation of `gjc ralplan "task"` doesn't
	// orphan in-progress artifacts under a fresh run id.
	const existingRunId = await readActiveRunId(cwd, resolved.sessionId);
	const runId = existingRunId ?? resolved.sessionId ?? defaultRunId();
	assertSafePathComponent(runId, "run-id");
	const now = new Date().toISOString();
	const payload: Record<string, unknown> = {
		active: true,
		current_phase: "planner",
		skill: "ralplan",
		mode: resolved.deliberate ? "deliberate" : "short",
		interactive: resolved.interactive,
		task: resolved.task,
		run_id: runId,
		updated_at: now,
	};
	if (resolved.architectKind) payload.architect_kind = resolved.architectKind;
	if (resolved.criticKind) payload.critic_kind = resolved.criticKind;
	if (resolved.sessionId) payload.session_id = resolved.sessionId;
	await writeJsonAtomic(statePath, payload, {
		cwd,
		audit: { category: "state", verb: "write", owner: "gjc-runtime", skill: "ralplan" },
	});
	return { statePath, runId };
}

async function handleConsensusHandoff(args: readonly string[], cwd: string): Promise<RalplanCommandResult> {
	const resolved = resolveConsensusArgs(args);
	if (!resolved.task) {
		throw new RalplanCommandError(2, 'gjc ralplan requires a task description, e.g. `gjc ralplan "<task>"`.');
	}
	const { statePath, runId } = await seedRalplanState(cwd, resolved);
	const mode = resolved.deliberate ? "deliberate" : "short";
	await syncRalplanHud({
		cwd,
		sessionId: resolved.sessionId,
		stage: "planner",
		pendingApproval: false,
		iteration: 1,
		latestSummary: `${mode} run · ${resolved.interactive ? "interactive" : "automated"}`,
	});

	const summary = {
		skill: "ralplan",
		mode,
		interactive: resolved.interactive,
		architect: resolved.architectKind ?? "default",
		critic: resolved.criticKind ?? "default",
		task: resolved.task,
		state_path: statePath,
		run_id: runId,
		handoff: "Run `/skill:ralplan` inside the GJC agent to drive the Planner / Architect / Critic consensus loop.",
	};
	const stdout = resolved.json
		? `${JSON.stringify(summary, null, 2)}\n`
		: [
				`Seeded ralplan ${summary.mode} run (${resolved.interactive ? "interactive" : "automated"}) at ${statePath}.`,
				`Active run_id: ${runId}`,
				resolved.architectKind ? `Architect: ${resolved.architectKind}` : undefined,
				resolved.criticKind ? `Critic: ${resolved.criticKind}` : undefined,
				"Run `/skill:ralplan` inside the GJC agent to execute the consensus loop.",
				"",
			]
				.filter((line): line is string => Boolean(line))
				.join("\n");
	return { status: 0, stdout };
}

/* -------------------------------- entry --------------------------------- */

export async function runNativeRalplanCommand(args: string[], cwd = process.cwd()): Promise<RalplanCommandResult> {
	try {
		if (isRalplanArtifactWriteInvocation(args)) return await handleArtifactWrite(args, cwd);
		return await handleConsensusHandoff(args, cwd);
	} catch (error) {
		if (error instanceof RalplanCommandError) return { status: error.exitStatus, stderr: `${error.message}\n` };
		return { status: 1, stderr: `${error instanceof Error ? error.message : String(error)}\n` };
	}
}
