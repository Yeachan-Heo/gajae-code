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
import { existsSync } from "node:fs";
import { Args, Command, Flags } from "@gajae-code/utils/cli";
import { classifyRecovery } from "../harness-control-plane/classifier";
import { callEndpoint, EndpointUnreachableError } from "../harness-control-plane/control-endpoint";
import { RuntimeOwner, resolveOwner } from "../harness-control-plane/owner";
import { GajaeCodeRpc } from "../harness-control-plane/rpc-adapter";
import { buildResponse, buildStateView } from "../harness-control-plane/state-machine";
import {
	generateSessionId,
	readEvents,
	readSessionState,
	resolveHarnessRoot,
	sessionPaths,
	writeSessionState,
} from "../harness-control-plane/storage";
import {
	DEFAULT_RETRY_BUDGET,
	type GitDelta,
	type Harness as HarnessKind,
	type Observation,
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

/** Owner liveness — always false in the foundation build (RuntimeOwner is M3). */
function ownerLiveFor(_state: SessionState): boolean {
	return false;
}

function buildObservation(state: SessionState, ownerLive: boolean): Observation {
	const workspace = state.handle.workspace;
	const { gitDelta, branch, deleted } = gitDeltaFor(workspace);
	return {
		lifecycle: state.lifecycle,
		ownerLive,
		cwd: workspace,
		branch: branch ?? state.handle.branch,
		gitDelta,
		lastActivityAt: state.updatedAt,
		observedSignals: ["SessionStart"],
		risk: deleted ? "deleted-worktree" : "normal",
	};
}

function resolveRetryBudget(input: Record<string, unknown>): RetryBudget {
	const supplied = input.retryBudget;
	if (supplied && typeof supplied === "object" && !Array.isArray(supplied)) {
		return { ...DEFAULT_RETRY_BUDGET, ...(supplied as Partial<RetryBudget>) };
	}
	return { ...DEFAULT_RETRY_BUDGET };
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
			description: "start|submit|observe|classify|recover|validate|finalize|retire|events|monitor|operate",
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
		const root = resolveHarnessRoot();
		try {
			const input = parseInput(flags.input);
			switch (verb) {
				case "start":
					return await this.#start(root, input);
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

	/** Spawn the detached owner daemon and poll until it holds the lease. */
	async #spawnDetachedOwner(root: string, sessionId: string, cwd: string): Promise<boolean> {
		const argv1 = process.argv[1];
		const cmd = argv1
			? [process.execPath, argv1, "harness", "__owner", "--session", sessionId]
			: [process.execPath, "harness", "__owner", "--session", sessionId];
		const child = Bun.spawn(cmd, {
			cwd,
			env: { ...process.env, GJC_HARNESS_STATE_ROOT: root },
			stdout: "ignore",
			stderr: "ignore",
			stdin: "ignore",
		});
		child.unref();
		for (let i = 0; i < 100; i++) {
			if ((await resolveOwner(root, sessionId)).live) return true;
			await new Promise(r => setTimeout(r, 50));
		}
		return false;
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
		const workspace = typeof input.workspace === "string" ? input.workspace : process.cwd();
		const sessionId = typeof input.sessionId === "string" ? input.sessionId : generateSessionId();
		const eventsPath = `${root}/sessions/${sessionId}/events.jsonl`;
		const leasePath = `${root}/sessions/${sessionId}/lease.json`;
		const startedAt = nowIso();
		const handle: SessionHandle = {
			sessionId,
			harness,
			repo: typeof input.repo === "string" ? input.repo : null,
			workspace,
			branch: typeof input.branch === "string" ? input.branch : null,
			base: typeof input.base === "string" ? input.base : null,
			issueOrPr: typeof input.issueOrPr === "string" ? input.issueOrPr : null,
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
		let ownerLive = false;
		if (input.detach === true) {
			ownerLive = await this.#spawnDetachedOwner(root, sessionId, workspace);
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
		writeJson(buildResponse(state, ownerLive, { handle, ownerRuntime: ownerLive ? "detached" : "manual" }));
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
		const state = await loadState(root, sessionId);
		const ownerLive = ownerLiveFor(state);
		const observation = buildObservation(state, ownerLive);
		writeJson(buildResponse(state, ownerLive, { observation, readOnly: !ownerLive }));
	}

	async #classify(root: string, input: Record<string, unknown>, flagSession: string | undefined): Promise<void> {
		const budget = resolveRetryBudget(input);
		let observation = input.observation as Partial<Observation> | undefined;
		let stateView: SessionState | null = null;
		const sessionId = flagSession ?? (typeof input.sessionId === "string" ? input.sessionId : undefined);
		if (sessionId) {
			stateView = await loadState(root, sessionId);
			if (!observation) observation = buildObservation(stateView, ownerLiveFor(stateView));
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
			writeJson(buildResponse(stateView, ownerLiveFor(stateView), { decision, observation: full }));
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
				note: "tail-only; live producer (owner) lands in M3/M5",
			}),
		);
	}

	async #retire(root: string, input: Record<string, unknown>, flagSession: string | undefined): Promise<void> {
		const sessionId = requireSessionId(input, flagSession);
		if (await this.#tryOwnerRoute(root, sessionId, "retire", { ...input, sessionId })) return;
		const state = await loadState(root, sessionId);
		const observation = buildObservation(state, ownerLiveFor(state));
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
