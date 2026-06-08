/**
 * `gjc harness <verb>` — AI-native stateless JSON CLI for the coding-harness
 * operations control plane (v1, gajae-code adapter).
 *
 * Every verb emits the universal contract `{ ok, state, evidence, nextAllowedActions }`.
 * Foundation milestone (M1/M2) implements: start, observe, classify, events, retire,
 * and the spec-required `owner-not-live` blocking for submit. Owner-runtime verbs
 * (recover/validate/finalize/operate) return an honest `pending-<milestone>` contract
 * until the RuntimeOwner (M3+) lands.
 */
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { Args, Command, Flags } from "@gajae-code/utils/cli";
import { resolveGjcTmuxCommand, sanitizeTmuxToken } from "../gjc-runtime/tmux-common";
import { classifyRecovery } from "../harness-control-plane/classifier";
import { callEndpoint, EndpointUnreachableError } from "../harness-control-plane/control-endpoint";
import { type ResolvedOwner, RuntimeOwner, resolveOwner } from "../harness-control-plane/owner";
import { preserveDirtyWorktree } from "../harness-control-plane/preserve";
import { buildReceipt, requiresVanishBeforeAction, type VanishEvidence } from "../harness-control-plane/receipts";
import { GajaeCodeRpc } from "../harness-control-plane/rpc-adapter";
import { classifyLeaseStatus, readLease } from "../harness-control-plane/session-lease";
import { buildResponse, buildStateView } from "../harness-control-plane/state-machine";
import {
	canonicalWorkspacePath,
	generateSessionId,
	readEvents,
	readSessionState,
	rememberHarnessSessionRoot,
	resolveHarnessRoot,
	resolveHarnessSessionRoot,
	sessionPaths,
	writeReceiptImmutable,
	writeSessionState,
} from "../harness-control-plane/storage";
import {
	DEFAULT_RETRY_BUDGET,
	type EventEnvelope,
	type GitDelta,
	type Harness as HarnessKind,
	type Observation,
	type RecoveryClassification,
	type RetryBudget,
	SESSION_SCHEMA_VERSION,
	type SessionHandle,
	type SessionState,
} from "../harness-control-plane/types";

function writeJson(value: unknown): void {
	process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function nowIso(): string {
	return new Date().toISOString();
}

function parseInput(raw: string | undefined): Record<string, unknown> {
	if (!raw?.trim()) return {};
	const parsed = JSON.parse(raw) as unknown;
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
		throw new Error("input_must_be_json_object");
	}
	return parsed as Record<string, unknown>;
}

function gitDeltaFor(workspace: string): { gitDelta: GitDelta; branch: string | null; deleted: boolean } {
	if (!existsSync(workspace)) return { gitDelta: "unknown", branch: null, deleted: true };
	let branch: string | null = null;
	try {
		branch = execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
			cwd: workspace,
			encoding: "utf8",
			stdio: ["ignore", "pipe", "ignore"],
		}).trim();
	} catch {
		branch = null;
	}
	try {
		const porcelain = execFileSync("git", ["status", "--porcelain"], {
			cwd: workspace,
			encoding: "utf8",
			stdio: ["ignore", "pipe", "ignore"],
		});
		return { gitDelta: porcelain.trim().length > 0 ? "dirty" : "clean", branch, deleted: false };
	} catch {
		return { gitDelta: "unknown", branch, deleted: false };
	}
}
interface HarnessPreflight {
	ok: boolean;
	blockers: string[];
	workspace: string;
	actualBranch: string | null;
	declaredBranch: string | null;
	normalizedIssueOrPr: string | null;
}

function normalizeIssueOrPr(value: unknown): string | null {
	if (value === undefined || value === null) return null;
	if (typeof value === "number") {
		if (Number.isSafeInteger(value) && value > 0) return String(value);
		throw new Error(`invalid_issue_or_pr:${value}`);
	}
	if (typeof value !== "string") throw new Error("invalid_issue_or_pr:not-string-or-number");
	const trimmed = value.trim();
	if (!trimmed) return null;
	const patterns = [
		/^#?(\d+)$/i,
		/^(?:pr|pull|issue)[-_#]?(\d+)$/i,
		/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+#(\d+)$/,
		/^(?:https?:\/\/github\.com\/)?[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/(?:pull|issues)\/(\d+)\/?$/i,
	];
	for (const pattern of patterns) {
		const match = trimmed.match(pattern);
		if (match?.[1]) return match[1];
	}
	throw new Error(`invalid_issue_or_pr:${trimmed}`);
}

function gitOutput(workspace: string, args: string[]): string | null {
	try {
		return execFileSync("git", args, {
			cwd: workspace,
			encoding: "utf8",
			stdio: ["ignore", "pipe", "ignore"],
		}).trim();
	} catch {
		return null;
	}
}

function resolveInputWorkspace(input: Record<string, unknown>): string {
	return canonicalWorkspacePath(typeof input.workspace === "string" ? input.workspace : process.cwd());
}

function buildPreflight(input: Record<string, unknown>): HarnessPreflight {
	const workspace = resolveInputWorkspace(input);
	const declaredBranch = typeof input.branch === "string" && input.branch.trim() ? input.branch.trim() : null;
	const blockers: string[] = [];
	const gitRoot = gitOutput(workspace, ["rev-parse", "--show-toplevel"]);
	const actualBranch = gitRoot ? gitOutput(workspace, ["rev-parse", "--abbrev-ref", "HEAD"]) : null;
	let normalizedIssueOrPr: string | null = null;

	if (!gitRoot) blockers.push("workspace-not-git-repo");
	if (gitRoot && actualBranch === "HEAD") blockers.push("detached-head");
	if (declaredBranch && actualBranch && actualBranch !== "HEAD" && declaredBranch !== actualBranch) {
		blockers.push("branch-mismatch");
	}
	try {
		normalizedIssueOrPr = normalizeIssueOrPr(input.issueOrPr ?? input.pr ?? input.issue);
	} catch (error) {
		blockers.push(error instanceof Error ? error.message : String(error));
	}

	return {
		ok: blockers.length === 0,
		blockers,
		workspace,
		actualBranch: actualBranch === "HEAD" ? null : actualBranch,
		declaredBranch,
		normalizedIssueOrPr,
	};
}

function startFatalPreflightBlockers(input: Record<string, unknown>, preflight: HarnessPreflight): string[] {
	const strict = input.strictPreflight === true || typeof input.branch === "string";
	return preflight.blockers.filter(blocker => {
		if (blocker === "branch-mismatch") return true;
		if (blocker.startsWith("invalid_issue_or_pr:")) return true;
		if (strict && (blocker === "workspace-not-git-repo" || blocker === "detached-head")) return true;
		return false;
	});
}

/** Fallback liveness after owner routing failed: no reachable owner handled this CLI call. */
function ownerLiveFor(_state: SessionState): boolean {
	return false;
}

function pushUnique(out: string[], value: unknown): void {
	if (typeof value === "string" && !out.includes(value)) out.push(value);
}

interface CompletedTerminalEvent {
	cursor: number;
	createdAt: string;
	kind: string;
}

function completedTerminalEvent(events: EventEnvelope[]): CompletedTerminalEvent | null {
	for (const event of [...events].reverse()) {
		const signal = (event.evidence as { signal?: unknown } | undefined)?.signal;
		if (event.kind === "rpc_agent_completed" || signal === "completed") {
			return { cursor: event.cursor, createdAt: event.createdAt, kind: event.kind };
		}
	}
	return null;
}

async function buildObservation(
	root: string,
	state: SessionState,
	ownerLive: boolean,
): Promise<{
	observation: Observation;
	completedTerminalEvent: CompletedTerminalEvent | null;
}> {
	const workspace = state.handle.workspace;
	const { gitDelta, branch, deleted } = gitDeltaFor(workspace);
	const events = await readEvents(root, state.sessionId, 0);
	const observedSignals = ["SessionStart"];
	for (const event of events.slice(-200)) {
		pushUnique(observedSignals, (event.evidence as { signal?: unknown } | undefined)?.signal);
		if (event.kind === "prompt_accepted") pushUnique(observedSignals, "prompt-accepted");
	}
	const terminalEvent = completedTerminalEvent(events);
	const lastEventAt = events.at(-1)?.createdAt;
	return {
		observation: {
			lifecycle: state.lifecycle,
			ownerLive,
			cwd: workspace,
			branch: branch ?? state.handle.branch,
			gitDelta,
			lastActivityAt: lastEventAt ?? state.updatedAt,
			observedSignals,
			risk: deleted ? "deleted-worktree" : !ownerLive && gitDelta === "dirty" ? "vanished-dirty" : "normal",
		},
		completedTerminalEvent: terminalEvent,
	};
}
interface OwnerExitEvidence {
	reason: string;
	leaseStatus: string;
	pid: number | null;
	endpointPresent: boolean;
	heartbeatAt: string | null;
	expiresAt: string | null;
	lastEventKind: string | null;
	lastEventAt: string | null;
	lastSignal: string | null;
	promptAcceptedSeen: boolean;
	completedSeen: boolean;
	/** True only when the owner is genuinely gone (lease missing or process dead). */
	terminal: boolean;
	/** True when the owner process is provably alive (live lease + fresh heartbeat) but the endpoint did not route. */
	transient: boolean;
	/** ISO timestamp of the most recent non-terminal RPC-derived owner event, if any (observability only). */
	lastRpcActivityAt: string | null;
}

async function buildOwnerExitEvidence(root: string, state: SessionState): Promise<OwnerExitEvidence> {
	const lease = await readLease(root, state.sessionId);
	const leaseStatus = classifyLeaseStatus(lease);
	const events = await readEvents(root, state.sessionId, 0);
	const lastEvent = events.at(-1) ?? null;
	let lastSignal: string | null = null;
	let promptAcceptedSeen = false;
	let completedSeen = false;
	let lastRpcActivityAt: string | null = null;
	for (const event of events) {
		const signal = (event.evidence as { signal?: unknown } | undefined)?.signal;
		if (typeof signal === "string") lastSignal = signal;
		if (event.kind === "prompt_accepted" || signal === "prompt-accepted") promptAcceptedSeen = true;
		if (event.kind === "rpc_agent_completed" || signal === "completed") completedSeen = true;
		// Terminal completion/failure frames are NOT owner liveness — exclude them from activity.
		if (event.kind.startsWith("rpc_") && event.kind !== "rpc_agent_completed" && event.kind !== "rpc_agent_failed") {
			lastRpcActivityAt = event.createdAt;
		}
	}
	// Owner liveness is the lease heartbeat, never RPC frames: a "live" lease means the owner process
	// is alive and heartbeating within TTL, so a failed endpoint call is a transient observation gap.
	// Real owner loss (missing/dead lease) stays terminal and keeps its original reason string so
	// existing consumers that match on the reason continue to escalate.
	const terminal = !lease || leaseStatus === "dead";
	const transient = leaseStatus === "live";
	let reason = "owner-not-live";
	if (!lease) {
		reason = promptAcceptedSeen && !completedSeen ? "owner-exited-after-prompt-acceptance" : "owner-lease-missing";
	} else if (leaseStatus === "dead") {
		reason = promptAcceptedSeen && !completedSeen ? "owner-exited-after-prompt-acceptance" : "owner-process-dead";
	} else if (leaseStatus === "expiredAlive") {
		reason = "owner-lease-expired";
	} else if (leaseStatus === "epermAlive") {
		reason = "owner-liveness-unknown-permission-denied";
	} else {
		reason = "owner-endpoint-unreachable";
	}
	return {
		reason,
		leaseStatus,
		pid: lease?.pid ?? null,
		endpointPresent: Boolean(lease?.endpoint?.path),
		heartbeatAt: lease?.heartbeatAt ?? null,
		expiresAt: lease?.expiresAt ?? null,
		lastEventKind: lastEvent?.kind ?? null,
		lastEventAt: lastEvent?.createdAt ?? null,
		lastSignal,
		promptAcceptedSeen,
		completedSeen,
		terminal,
		transient,
		lastRpcActivityAt,
	};
}

async function writeVanishReceiptForDecision(
	root: string,
	state: SessionState,
	observation: Observation,
	classification: RecoveryClassification,
): Promise<string | null> {
	if (!requiresVanishBeforeAction(classification)) return null;
	const dirty = observation.gitDelta === "dirty" || observation.gitDelta === "unknown";
	const preservation = dirty ? preserveDirtyWorktree(observation.cwd) : null;
	const evidence: VanishEvidence = {
		classification,
		gitDelta: observation.gitDelta,
		gitStatusPorcelain: preservation
			? `tracked:${preservation.trackedDiffSha256};untracked:${preservation.untrackedManifest.length}`
			: observation.observedSignals.join(","),
		untrackedManifest: preservation?.untrackedManifest ?? [],
		preservation: preservation?.stashRef ? "stash" : "snapshot",
		stashRef: preservation?.stashRef ?? null,
		snapshotComplete: preservation?.snapshotComplete ?? true,
		forbiddenActions: dirty ? ["restart-clean", "delete", "reset"] : [],
	};
	const receipt = buildReceipt<VanishEvidence>({
		receiptId: `vanish-${Date.now()}-${randomBytes(4).toString("hex")}`,
		sessionId: state.sessionId,
		family: "vanish",
		source: "cli-recover",
		subject: {
			workspace: observation.cwd,
			branch: observation.branch,
			head: null,
			commit: null,
		},
		evidence,
	});
	await writeReceiptImmutable(root, state.sessionId, "vanish", receipt.receiptId, receipt);
	return receipt.receiptId;
}

function updateStateWithRestoredOwner(state: SessionState, leasePath: string, resolved: ResolvedOwner): void {
	state.lifecycle = "observing";
	state.blockers = state.blockers.filter(blocker => !isOwnerLivenessBlocker(blocker));
	state.handle.processHandle = {
		kind: "runtime-owner",
		ownerId: resolved.lease?.ownerId ?? null,
		pid: resolved.lease?.pid ?? null,
	};
	state.handle.ownerHandle = {
		leasePath,
		endpoint: resolved.socketPath,
		heartbeatAt: resolved.lease?.heartbeatAt ?? null,
	};
	state.updatedAt = nowIso();
}

function isOwnerLivenessBlocker(blocker: string): boolean {
	return blocker === "detached-owner-not-live" || blocker.startsWith("owner-vanished:");
}

async function reconcileCompletedOwnerExited(
	root: string,
	state: SessionState,
	observation: Observation,
	completedTerminal: CompletedTerminalEvent | null,
): Promise<SessionState> {
	if (!completedTerminal || observation.ownerLive || observation.gitDelta !== "clean") return state;
	if (state.lifecycle === "completed" || state.lifecycle === "retired") return state;
	state.lifecycle = "completed";
	state.blockers = state.blockers.filter(blocker => !isOwnerLivenessBlocker(blocker));
	state.updatedAt = nowIso();
	await writeSessionState(root, state);
	return state;
}

function needsVanishedOwnerBlock(
	state: SessionState,
	observation: Observation,
	completedTerminal: CompletedTerminalEvent | null,
): boolean {
	if (observation.ownerLive || state.lifecycle !== "observing") return false;
	if (completedTerminal || observation.observedSignals.includes("completed")) return false;
	return observation.observedSignals.some(
		signal => signal === "prompt-accepted" || signal === "tool-call" || signal === "streaming",
	);
}

async function markVanishedOwnerBlocked(
	root: string,
	state: SessionState,
	observation: Observation,
	completedTerminal: CompletedTerminalEvent | null,
): Promise<SessionState> {
	if (!needsVanishedOwnerBlock(state, observation, completedTerminal)) return state;
	const blocker = `owner-vanished:${observation.gitDelta}`;
	state.lifecycle = "blocked";
	state.blockers = state.blockers.includes(blocker) ? state.blockers : [...state.blockers, blocker];
	state.updatedAt = nowIso();
	await writeSessionState(root, state);
	return state;
}

function resolveRetryBudget(input: Record<string, unknown>): RetryBudget {
	const supplied = input.retryBudget;
	if (supplied && typeof supplied === "object" && !Array.isArray(supplied)) {
		return { ...DEFAULT_RETRY_BUDGET, ...(supplied as Partial<RetryBudget>) };
	}
	return { ...DEFAULT_RETRY_BUDGET };
}

interface OwnerSpawnResult {
	live: boolean;
	runtime: "tmux" | "detached" | "manual";
	tmuxSessionName: string | null;
	fallbackReason: string | null;
	blockerReason: string | null;
}

function shellQuote(value: string): string {
	return `'${value.replaceAll("'", "'\\''")}'`;
}

function deterministicHarnessTmuxSessionName(sessionId: string): string {
	return `gajae_code_harness_${sanitizeTmuxToken(sessionId)}`;
}

async function loadState(root: string, sessionId: string): Promise<SessionState> {
	const state = await readSessionState(root, sessionId);
	if (!state) throw new Error(`session_not_found:${sessionId}`);
	return state;
}

function requireSessionId(input: Record<string, unknown>, flagSession: string | undefined): string {
	const id = flagSession ?? (typeof input.sessionId === "string" ? input.sessionId : undefined);
	if (!id) throw new Error("missing_session_id");
	return id;
}

export default class Harness extends Command {
	static description = "Operate coding harnesses (v1: gajae-code) as a session/evidence/recovery/PR control plane";
	static strict = false;

	static args = {
		verb: Args.string({
			description: "start|preflight|submit|observe|classify|recover|validate|finalize|retire|events|monitor|operate",
			required: true,
		}),
	};

	static flags = {
		input: Flags.string({ description: "JSON object input for the verb", default: "" }),
		session: Flags.string({ char: "s", description: "Session id (re-grab a session)" }),
		cursor: Flags.string({ description: "Event cursor for events --follow (exclusive)", default: "0" }),
		follow: Flags.boolean({ description: "Tail the owner-written event log", default: false }),
		json: Flags.boolean({ char: "j", description: "Emit machine-readable JSON", default: true }),
	};

	static examples = [
		`gjc harness start --input '{"harness":"gajae-code","workspace":".","branch":"feat/x"}'`,
		"gjc harness observe --session <id>",
		`gjc harness classify --input '{"observation":{"ownerLive":false,"gitDelta":"dirty","risk":"vanished-dirty"}}'`,
		"gjc harness events --session <id> --follow",
	];

	async run(): Promise<void> {
		const { args, flags } = await this.parse(Harness);
		const verb = String(args.verb);
		let root = resolveHarnessRoot();
		try {
			const input = parseInput(flags.input);
			const sessionId = flags.session ?? (typeof input.sessionId === "string" ? input.sessionId : undefined);
			const expectedWorkspace = typeof input.workspace === "string" ? resolveInputWorkspace(input) : undefined;
			if (verb !== "start" && sessionId) {
				root = await resolveHarnessSessionRoot(root, sessionId, process.env, { expectedWorkspace });
			}
			switch (verb) {
				case "start":
					return await this.#start(root, input);
				case "preflight":
					return this.#preflight(input);
				case "observe":
					return await this.#observe(root, input, flags.session);
				case "classify":
					return await this.#classify(root, input, flags.session);
				case "submit":
					return await this.#submit(root, input, flags.session);
				case "events":
				case "monitor":
					return await this.#events(root, input, flags.session, Number(flags.cursor) || 0);
				case "retire":
					return await this.#retire(root, input, flags.session);
				case "finalize":
					return await this.#finalizeVerb(root, input, flags.session);
				case "__owner":
					return await this.#runOwner(root, input, flags.session);
				case "recover":
				case "validate":
				case "operate":
					return await this.#ownerVerbOrPending(root, verb, input, flags.session);
				default:
					throw new Error(`unknown_harness_verb:${verb}`);
			}
		} catch (error) {
			writeJson({ ok: false, error: error instanceof Error ? error.message : String(error), verb });
			process.exitCode = 1;
		}
	}

	#preflight(input: Record<string, unknown>): void {
		const preflight = buildPreflight(input);
		writeJson({
			ok: preflight.ok,
			evidence: {
				preflight,
				guidance: preflight.ok
					? "workspace metadata is normalized"
					: "fix blockers before gjc harness start; branch must match the actual checkout and issueOrPr must be numeric or a recognized PR/issue form",
			},
		});
		if (!preflight.ok) process.exitCode = 1;
	}

	async #finalizeVerb(root: string, input: Record<string, unknown>, flagSession: string | undefined): Promise<void> {
		const sessionId = requireSessionId(input, flagSession);
		if (await this.#tryOwnerRoute(root, sessionId, "finalize", { ...input, sessionId })) return;
		// finalize is owner-routed; without a live owner, report owner-not-live (start the owner first).
		const state = await loadState(root, sessionId);
		writeJson(buildResponse(state, false, { completed: false, reason: "owner-not-live" }, false));
		process.exitCode = 1;
	}

	/** Route an owner-backed verb to the live owner; fall back to a pending response when none. */
	async #ownerVerbOrPending(
		root: string,
		verb: string,
		input: Record<string, unknown>,
		flagSession: string | undefined,
	): Promise<void> {
		const sessionId = flagSession ?? (typeof input.sessionId === "string" ? input.sessionId : undefined);
		if (sessionId && (await this.#tryOwnerRoute(root, sessionId, verb, { ...input, sessionId }))) return;
		if (verb === "recover" && sessionId) return this.#recoverWithoutOwner(root, sessionId, input);
		return this.#pending(root, verb, input, flagSession);
	}

	/** Detached owner daemon (spawned by `start --detach`). Runs until retired or signalled. */
	async #runOwner(root: string, input: Record<string, unknown>, flagSession: string | undefined): Promise<void> {
		const sessionId = requireSessionId(input, flagSession);
		const sessionDir = sessionPaths(root, sessionId).gjcSessionDir;
		// Optional rpc command override (tests / non-default hosts); defaults to `gjc --mode rpc`.
		const override = process.env.GJC_HARNESS_RPC_COMMAND;
		const command = override ? (JSON.parse(override) as string[]) : undefined;
		const rpc = new GajaeCodeRpc({ sessionDir, command });
		const owner = new RuntimeOwner({ root, sessionId, rpc });
		const info = await owner.start();
		writeJson({ ok: true, owner: info });
		await new Promise<void>(resolve => {
			const stop = (): void => {
				clearInterval(timer);
				resolve();
			};
			const timer = setInterval(async () => {
				const resolved = await resolveOwner(root, sessionId);
				if (!resolved.live) stop();
			}, 500);
			timer.unref?.();
			process.on("SIGTERM", stop);
			process.on("SIGINT", stop);
		});
		await owner.stop();
		process.exit(0);
	}

	#buildOwnerCommand(sessionId: string): string[] {
		const argv1 = process.argv[1];
		return argv1
			? [process.execPath, argv1, "harness", "__owner", "--session", sessionId]
			: [process.execPath, "harness", "__owner", "--session", sessionId];
	}

	async #waitForOwner(root: string, sessionId: string): Promise<boolean> {
		for (let i = 0; i < 100; i++) {
			const owner = await resolveOwner(root, sessionId);
			if (owner.live && owner.socketPath) {
				try {
					await callEndpoint(owner.socketPath, { verb: "observe", input: { sessionId } }, 250);
					return true;
				} catch (error) {
					if (!(error instanceof EndpointUnreachableError)) throw error;
				}
			}
			await new Promise(r => setTimeout(r, 50));
		}
		return false;
	}

	#startTmuxResidentOwner(
		root: string,
		sessionId: string,
		cwd: string,
	): { started: boolean; sessionName: string; reason: string | null } {
		const tmuxCommand = resolveGjcTmuxCommand();
		if (Bun.which(tmuxCommand) === null) {
			return {
				started: false,
				sessionName: deterministicHarnessTmuxSessionName(sessionId),
				reason: "tmux-unavailable",
			};
		}
		const sessionName = deterministicHarnessTmuxSessionName(sessionId);
		const envAssignments = [`GJC_HARNESS_STATE_ROOT=${shellQuote(root)}`];
		if (process.env.GJC_HARNESS_RPC_COMMAND) {
			envAssignments.push(`GJC_HARNESS_RPC_COMMAND=${shellQuote(process.env.GJC_HARNESS_RPC_COMMAND)}`);
		}
		if (process.env.GJC_HARNESS_TEST_NODE_MODULES) {
			envAssignments.push(`GJC_HARNESS_TEST_NODE_MODULES=${shellQuote(process.env.GJC_HARNESS_TEST_NODE_MODULES)}`);
		}
		const ownerCommand = this.#buildOwnerCommand(sessionId).map(shellQuote).join(" ");
		const shellCommand = `exec env ${envAssignments.join(" ")} ${ownerCommand}`;
		const created = Bun.spawnSync([tmuxCommand, "new-session", "-d", "-s", sessionName, "-c", cwd, shellCommand], {
			stdout: "pipe",
			stderr: "pipe",
			env: process.env,
		});
		if (created.exitCode === 0) return { started: true, sessionName, reason: null };
		const stderr = created.stderr.toString().trim();
		return { started: false, sessionName, reason: stderr || "tmux-start-failed" };
	}

	/** Spawn the owner daemon. Prefer a tmux-resident owner, then explicitly fall back to detached. */
	async #spawnDetachedOwner(root: string, sessionId: string, cwd: string): Promise<OwnerSpawnResult> {
		const tmux = this.#startTmuxResidentOwner(root, sessionId, cwd);
		if (tmux.started && (await this.#waitForOwner(root, sessionId))) {
			return {
				live: true,
				runtime: "tmux",
				tmuxSessionName: tmux.sessionName,
				fallbackReason: null,
				blockerReason: null,
			};
		}
		const fallbackReason = tmux.started
			? "tmux new-session exited 0 but owner endpoint did not become routable"
			: tmux.reason;
		const cmd = this.#buildOwnerCommand(sessionId);
		const child = Bun.spawn(cmd, {
			cwd,
			env: {
				...process.env,
				GJC_HARNESS_STATE_ROOT: root,
				...(process.env.GJC_HARNESS_TEST_NODE_MODULES
					? { GJC_HARNESS_TEST_NODE_MODULES: process.env.GJC_HARNESS_TEST_NODE_MODULES }
					: {}),
			},
			stdout: "ignore",
			stderr: "ignore",
			stdin: "ignore",
		});
		child.unref();
		const live = await this.#waitForOwner(root, sessionId);
		return {
			live,
			runtime: "detached",
			tmuxSessionName: null,
			fallbackReason,
			blockerReason: live ? null : "detached-owner-not-live",
		};
	}

	async #start(root: string, input: Record<string, unknown>): Promise<void> {
		const harness = (typeof input.harness === "string" ? input.harness : "gajae-code") as HarnessKind;
		if (harness !== "gajae-code") {
			writeJson({
				ok: false,
				error: `harness_unsupported_in_v1:${harness}`,
				evidence: { seam: true, supported: ["gajae-code"] },
			});
			process.exitCode = 1;
			return;
		}
		const preflight = buildPreflight(input);
		const fatalBlockers = startFatalPreflightBlockers(input, preflight);
		if (fatalBlockers.length > 0) {
			writeJson({
				ok: false,
				error: "harness_preflight_failed",
				evidence: {
					preflight: { ...preflight, blockers: fatalBlockers, ok: false },
					guidance:
						"fix blockers before start; run gjc harness preflight with the same input for branch and issue/PR diagnostics",
				},
			});
			process.exitCode = 1;
			return;
		}
		const workspace = resolveInputWorkspace(input);
		const sessionId = typeof input.sessionId === "string" ? input.sessionId : generateSessionId();
		const eventsPath = `${root}/sessions/${sessionId}/events.jsonl`;
		const leasePath = `${root}/sessions/${sessionId}/lease.json`;
		const startedAt = nowIso();
		const handle: SessionHandle = {
			sessionId,
			harness,
			mode: input.mode === "review" || input.reviewOnly === true ? "review" : "implement",
			repo: typeof input.repo === "string" ? input.repo : null,
			workspace,
			branch: preflight.declaredBranch ?? preflight.actualBranch,
			base: typeof input.base === "string" ? input.base : null,
			issueOrPr: preflight.normalizedIssueOrPr,
			processHandle: { kind: "runtime-owner", ownerId: null, pid: null },
			rpcHandle: { kind: "rpc-subprocess", pid: null, sessionDir: `${root}/sessions/${sessionId}/gjc-session` },
			ownerHandle: { leasePath, endpoint: null, heartbeatAt: null },
			routerHandle: { kind: "default-in-owner", policy: "default-fallback", eventsPath },
			viewportHandle: { kind: "event-monitor", tmuxSessionName: null, viewOnly: true },
			startedAt,
			updatedAt: startedAt,
		};
		const state: SessionState = {
			schemaVersion: SESSION_SCHEMA_VERSION,
			sessionId,
			lifecycle: "started",
			harness,
			handle,
			retries: {},
			blockers: [],
			createdAt: startedAt,
			updatedAt: startedAt,
		};
		await writeSessionState(root, state);
		await rememberHarnessSessionRoot(root, sessionId);
		let ownerLive = false;
		let ownerRuntime: OwnerSpawnResult["runtime"] = "manual";
		let ownerFallbackReason: string | null = null;
		let ownerBlockerReason: string | null = null;
		if (input.detach === true) {
			const ownerSpawn = await this.#spawnDetachedOwner(root, sessionId, workspace);
			ownerLive = ownerSpawn.live;
			ownerRuntime = ownerSpawn.runtime;
			ownerFallbackReason = ownerSpawn.fallbackReason;
			ownerBlockerReason = ownerSpawn.blockerReason;
			handle.viewportHandle = {
				kind: "event-monitor",
				tmuxSessionName: ownerSpawn.tmuxSessionName,
				viewOnly: true,
			};
			if (ownerLive) {
				const resolved = await resolveOwner(root, sessionId);
				handle.processHandle = {
					kind: "runtime-owner",
					ownerId: resolved.lease?.ownerId ?? null,
					pid: resolved.lease?.pid ?? null,
				};
				handle.ownerHandle = {
					leasePath,
					endpoint: resolved.socketPath,
					heartbeatAt: resolved.lease?.heartbeatAt ?? null,
				};
				state.handle = handle;
				await writeSessionState(root, state);
			}
		}
		if (ownerBlockerReason) {
			const resolved = await resolveOwner(root, sessionId);
			if (resolved.live && resolved.socketPath) {
				ownerLive = true;
				ownerBlockerReason = null;
				handle.processHandle = {
					kind: "runtime-owner",
					ownerId: resolved.lease?.ownerId ?? null,
					pid: resolved.lease?.pid ?? null,
				};
				handle.ownerHandle = {
					leasePath,
					endpoint: resolved.socketPath,
					heartbeatAt: resolved.lease?.heartbeatAt ?? null,
				};
				state.handle = handle;
				await writeSessionState(root, state);
			}
		}
		if (ownerBlockerReason) {
			state.lifecycle = "blocked";
			state.blockers = [...state.blockers, ownerBlockerReason];
			state.handle = handle;
			state.updatedAt = nowIso();
			await writeSessionState(root, state);
		}
		writeJson(
			buildResponse(
				state,
				ownerLive,
				{
					handle,
					ownerRuntime,
					preflight,
					...(ownerFallbackReason ? { ownerFallbackReason } : {}),
					...(ownerBlockerReason ? { reason: ownerBlockerReason } : {}),
				},
				!ownerBlockerReason,
			),
		);
		if (ownerBlockerReason) process.exitCode = 1;
	}

	/** Returns true if a live owner handled the verb (response already printed). */
	async #tryOwnerRoute(
		root: string,
		sessionId: string,
		verb: string,
		input: Record<string, unknown>,
	): Promise<boolean> {
		const owner = await resolveOwner(root, sessionId);
		if (!owner.live || !owner.socketPath) return false;
		try {
			const res = (await callEndpoint(owner.socketPath, { verb, input })) as { ok?: boolean };
			writeJson(res);
			if (res?.ok === false) process.exitCode = 1;
			return true;
		} catch (error) {
			if (error instanceof EndpointUnreachableError) return false;
			throw error;
		}
	}

	async #observe(root: string, input: Record<string, unknown>, flagSession: string | undefined): Promise<void> {
		const sessionId = requireSessionId(input, flagSession);
		if (await this.#tryOwnerRoute(root, sessionId, "observe", { ...input, sessionId })) return;
		let state = await loadState(root, sessionId);
		const ownerLive = ownerLiveFor(state);
		const { observation, completedTerminalEvent } = await buildObservation(root, state, ownerLive);
		state = await reconcileCompletedOwnerExited(root, state, observation, completedTerminalEvent);
		const vanishedOwnerBlock = needsVanishedOwnerBlock(state, observation, completedTerminalEvent);
		state = await markVanishedOwnerBlocked(root, state, observation, completedTerminalEvent);
		const ownerExit =
			!ownerLive && (vanishedOwnerBlock || completedTerminalEvent)
				? await buildOwnerExitEvidence(root, state)
				: null;
		writeJson(
			buildResponse(state, ownerLive, {
				observation: { ...observation, lifecycle: state.lifecycle },
				readOnly: !ownerLive,
				...(vanishedOwnerBlock
					? { ownerVanished: true, blockerReason: `owner-vanished:${observation.gitDelta}` }
					: {}),
				...(completedTerminalEvent && !ownerLive
					? { completedOwnerExited: true, terminalResult: completedTerminalEvent }
					: {}),
				...(ownerExit ? { ownerExit } : {}),
			}),
		);
	}

	async #classify(root: string, input: Record<string, unknown>, flagSession: string | undefined): Promise<void> {
		const budget = resolveRetryBudget(input);
		let observation = input.observation as Partial<Observation> | undefined;
		let stateView: SessionState | null = null;
		const sessionId = flagSession ?? (typeof input.sessionId === "string" ? input.sessionId : undefined);
		if (sessionId) {
			stateView = await loadState(root, sessionId);
			if (!observation) {
				const built = await buildObservation(root, stateView, ownerLiveFor(stateView));
				observation = built.observation;
				stateView = await markVanishedOwnerBlocked(
					root,
					stateView,
					built.observation,
					built.completedTerminalEvent,
				);
			}
		}
		if (!observation) throw new Error("classify_requires_observation_or_session");
		const full: Observation = {
			lifecycle: observation.lifecycle ?? "observing",
			ownerLive: observation.ownerLive ?? false,
			cwd: observation.cwd ?? ".",
			branch: observation.branch ?? null,
			gitDelta: observation.gitDelta ?? "unknown",
			lastActivityAt: observation.lastActivityAt ?? null,
			observedSignals: observation.observedSignals ?? [],
			risk: observation.risk ?? "normal",
		};
		const decision = classifyRecovery({ observation: full, retryBudget: budget });
		if (stateView) {
			writeJson(
				buildResponse(stateView, ownerLiveFor(stateView), {
					decision,
					observation: { ...full, lifecycle: stateView.lifecycle },
				}),
			);
			return;
		}
		// Pure classify without a session: synthesize a minimal state view.
		writeJson({
			ok: true,
			state: {
				sessionId: "(none)",
				lifecycle: full.lifecycle,
				harness: "gajae-code",
				ownerLive: full.ownerLive,
				blockers: [],
			},
			evidence: { decision, observation: full },
			nextAllowedActions: [],
		});
	}

	async #submit(root: string, input: Record<string, unknown>, flagSession: string | undefined): Promise<void> {
		const sessionId = requireSessionId(input, flagSession);
		if (await this.#tryOwnerRoute(root, sessionId, "submit", { ...input, sessionId })) return;
		const state = await loadState(root, sessionId);
		// No live owner: submission is blocked (never echoed-as-accepted).
		writeJson(buildResponse(state, false, { accepted: false, submitted: false, reason: "owner-not-live" }, false));
		process.exitCode = 1;
	}

	async #events(
		root: string,
		input: Record<string, unknown>,
		flagSession: string | undefined,
		cursor: number,
	): Promise<void> {
		const sessionId = requireSessionId(input, flagSession);
		const state = await loadState(root, sessionId);
		const events = await readEvents(root, sessionId, cursor);
		const nextCursor = events.length > 0 ? events[events.length - 1].cursor : cursor;
		writeJson(
			buildResponse(state, ownerLiveFor(state), {
				events,
				cursor: nextCursor,
				note: "tail-only; events are preserved after owner exit",
				ownerLive: ownerLiveFor(state),
				ownerExit: ownerLiveFor(state) ? null : await buildOwnerExitEvidence(root, state),
			}),
		);
	}

	async #retire(root: string, input: Record<string, unknown>, flagSession: string | undefined): Promise<void> {
		const sessionId = requireSessionId(input, flagSession);
		if (await this.#tryOwnerRoute(root, sessionId, "retire", { ...input, sessionId })) return;
		const state = await loadState(root, sessionId);
		const { observation } = await buildObservation(root, state, ownerLiveFor(state));
		if (observation.gitDelta === "dirty" || observation.gitDelta === "unknown") {
			writeJson(
				buildResponse(
					state,
					false,
					{
						retired: false,
						reason: `retire-blocked:${observation.gitDelta}-delta`,
						gitDelta: observation.gitDelta,
					},
					false,
				),
			);
			process.exitCode = 1;
			return;
		}
		state.lifecycle = "retired";
		state.updatedAt = nowIso();
		await writeSessionState(root, state);
		writeJson(buildResponse(state, false, { retired: true }));
	}

	async #recoverWithoutOwner(root: string, sessionId: string, input: Record<string, unknown>): Promise<void> {
		const budget = resolveRetryBudget(input);
		let state = await loadState(root, sessionId);
		const beforeExit = await buildOwnerExitEvidence(root, state);
		const { observation, completedTerminalEvent } = await buildObservation(root, state, false);
		state = await markVanishedOwnerBlocked(root, state, observation, completedTerminalEvent);
		const decision = classifyRecovery({
			observation: { ...observation, lifecycle: state.lifecycle },
			retryBudget: budget,
		});
		const vanishReceiptId = await writeVanishReceiptForDecision(root, state, observation, decision.classification);
		const restoredOwner =
			decision.ownerRequired && beforeExit.endpointPresent
				? await this.#spawnDetachedOwner(root, sessionId, state.handle.workspace)
				: null;
		if (restoredOwner?.live) {
			const resolved = await resolveOwner(root, sessionId);
			if (resolved.live && resolved.socketPath) {
				updateStateWithRestoredOwner(state, state.handle.ownerHandle.leasePath, resolved);
				if (restoredOwner.tmuxSessionName)
					state.handle.viewportHandle.tmuxSessionName = restoredOwner.tmuxSessionName;
				await writeSessionState(root, state);
				writeJson(
					buildResponse(state, true, {
						pending: false,
						restoredOwner: true,
						decision,
						observation: { ...observation, lifecycle: state.lifecycle, ownerLive: true },
						ownerExit: beforeExit,
						ownerRuntime: restoredOwner.runtime,
						...(restoredOwner.fallbackReason ? { ownerFallbackReason: restoredOwner.fallbackReason } : {}),
						...(vanishReceiptId ? { vanishReceiptId } : {}),
					}),
				);
				return;
			}
		}
		const afterExit = await buildOwnerExitEvidence(root, state);
		writeJson(
			buildResponse(
				state,
				false,
				{
					pending: false,
					reason: afterExit.reason,
					decision,
					observation: { ...observation, lifecycle: state.lifecycle },
					ownerExit: afterExit,
					...(restoredOwner
						? {
								restoreAttempt: {
									runtime: restoredOwner.runtime,
									live: restoredOwner.live,
									fallbackReason: restoredOwner.fallbackReason,
									blockerReason: restoredOwner.blockerReason,
								},
							}
						: {}),
					...(vanishReceiptId ? { vanishReceiptId } : {}),
				},
				false,
			),
		);
		process.exitCode = 1;
	}

	async #pending(
		root: string,
		verb: string,
		input: Record<string, unknown>,
		flagSession: string | undefined,
	): Promise<void> {
		const sessionId = flagSession ?? (typeof input.sessionId === "string" ? input.sessionId : undefined);
		const milestone = verb === "recover" ? "M7" : verb === "validate" || verb === "finalize" ? "M8" : "M9";
		if (sessionId) {
			const state = await loadState(root, sessionId);
			writeJson(buildResponse(state, ownerLiveFor(state), { pending: true, milestone, verb }, false));
			process.exitCode = 1;
			return;
		}
		writeJson({
			ok: false,
			state: buildStateView(
				{
					schemaVersion: SESSION_SCHEMA_VERSION,
					sessionId: "(none)",
					lifecycle: "new",
					harness: "gajae-code",
					handle: {} as SessionHandle,
					retries: {},
					blockers: [],
					createdAt: nowIso(),
					updatedAt: nowIso(),
				},
				false,
			),
			evidence: { pending: true, milestone, verb },
			nextAllowedActions: [],
		});
		process.exitCode = 1;
	}
}
