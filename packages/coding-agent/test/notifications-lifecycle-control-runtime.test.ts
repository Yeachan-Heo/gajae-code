import { describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { parseLaunchWorktreeMode } from "@gajae-code/coding-agent/gjc-runtime/launch-worktree";
import type { SessionCreateFrame } from "@gajae-code/coding-agent/notifications/index";
import {
	attachLifecycleControl,
	buildCreateArgv,
	type ControlServerLike,
	createRateLimiter,
	daemonResumeSession,
	outcomeToResponse,
} from "@gajae-code/coding-agent/notifications/lifecycle-control-runtime";
import type { LedgerEntry, OrchestratorDeps } from "@gajae-code/coding-agent/notifications/lifecycle-orchestrator";

const PAIRED = "42";

function createFrame(over: Partial<SessionCreateFrame> = {}): SessionCreateFrame {
	return {
		type: "session_create",
		requestId: "lc_1",
		lifecycleRequestId: "lc_1",
		intendedSessionId: "sess_pre_1",
		updateId: 100,
		chatId: PAIRED,
		token: "control-token",
		target: { kind: "existing_path", path: "/repo" },
		...over,
	};
}

function stubDeps(): OrchestratorDeps {
	let n = 0;
	return {
		pairedChatId: PAIRED,
		now: () => 1000,
		store: { read: async () => ({ version: 1, entries: {} }), write: async () => {} },
		audit: () => {},
		allowCreate: () => true,
		writeStartupPrompt: async () => undefined,
		spawnCreate: async (_f, ids) => ({
			sessionId: ids.intendedSessionId,
			tmuxSession: `gjc-${ids.intendedSessionId}`,
			endpointUrl: "ws://127.0.0.1:9",
			topicThreadId: "1",
		}),
		closeSession: async () => ({ processGone: true }),
		resumeSession: async () => ({
			sessionId: "s",
			tmuxSession: "gjc-s",
			endpointUrl: "",
			topicThreadId: "",
			mode: "reattached",
		}),
		newLifecycleRequestId: () => `lc-${++n}`,
		newSessionId: () => `sess-${++n}`,
	};
}

describe("lifecycle control runtime", () => {
	it("buildCreateArgv emits only launcher-supported flags (no --session-id)", () => {
		expect(buildCreateArgv(createFrame(), { intendedSessionId: "x" })).toEqual({
			cwd: "/repo",
			args: [],
		});
		expect(
			buildCreateArgv(createFrame({ target: { kind: "worktree", repo: "/r", branch: "feat/y" } }), {
				intendedSessionId: "x",
			}),
		).toEqual({ cwd: "/r", args: ["--worktree=feat/y"] });
		expect(
			buildCreateArgv(createFrame({ target: { kind: "plain_dir", path: "/new" } }), { intendedSessionId: "x" }),
		).toEqual({ cwd: "/new", args: [] });
	});

	it("buildCreateArgv expands own-home tilde paths defensively", () => {
		const home = os.homedir();

		expect(
			buildCreateArgv(createFrame({ target: { kind: "existing_path", path: "~/repo" } }), {
				intendedSessionId: "x",
			}),
		).toEqual({
			cwd: `${home}/repo`,
			args: [],
		});
		expect(
			buildCreateArgv(createFrame({ target: { kind: "worktree", repo: "~/repo", branch: "feat/y" } }), {
				intendedSessionId: "x",
			}),
		).toEqual({ cwd: `${home}/repo`, args: ["--worktree=feat/y"] });
	});

	it("worktree argv parses as a NAMED (non-detached) worktree with no stray flags", () => {
		const { args } = buildCreateArgv(createFrame({ target: { kind: "worktree", repo: "/r", branch: "feat/y" } }), {
			intendedSessionId: "x",
		});
		const { mode, remainingArgs } = parseLaunchWorktreeMode(args);
		expect(mode).toEqual({ enabled: true, detached: false, name: "feat/y" });
		expect(remainingArgs).toEqual([]);
	});

	it("a flag-shaped branch stays a named worktree (no detached/stray-flag mis-parse)", () => {
		// `--worktree=<branch>` keeps the branch a single argv token even if it
		// looks like a flag, so it can never trigger detached mode.
		const { args } = buildCreateArgv(createFrame({ target: { kind: "worktree", repo: "/r", branch: "-x" } }), {
			intendedSessionId: "x",
		});
		expect(args).toEqual(["--worktree=-x"]);
		const { mode, remainingArgs } = parseLaunchWorktreeMode(args);
		expect(mode).toEqual({ enabled: true, detached: false, name: "-x" });
		expect(remainingArgs).toEqual([]);
	});

	it("outcomeToResponse maps ok create to a create_response frame", () => {
		const entry: LedgerEntry = {
			requestHash: "h",
			state: "success",
			requestId: "lc_1",
			verb: "session_create",
			intendedSessionId: "sess_pre_1",
			sessionId: "sess_pre_1",
			createdAt: 0,
			updatedAt: 0,
			targetSummary: {},
			endpointUrl: "ws://x",
		};
		const resp = outcomeToResponse(createFrame(), { status: "ok", entry });
		expect(resp.type).toBe("session_create_response");
		if (resp.type === "session_create_response") {
			expect(resp.sessionId).toBe("sess_pre_1");
			expect(resp.matchedBy).toBe("spawn_marker");
		}
	});

	it("outcomeToResponse maps error to a lifecycle_error frame", () => {
		const resp = outcomeToResponse(createFrame(), {
			status: "error",
			reason: "rate_limited",
			message: "too many",
		});
		expect(resp.type).toBe("session_lifecycle_error");
		if (resp.type === "session_lifecycle_error") expect(resp.reason).toBe("rate_limited");
	});

	it("attachLifecycleControl wires a request through to a response", async () => {
		const responses: string[] = [];
		let handler:
			| ((err: Error | null, req: { kind: string; requestId: string; payloadJson: string }) => void)
			| undefined;
		const server: ControlServerLike = {
			onLifecycleRequest: cb => {
				handler = cb;
			},
			respond: json => responses.push(json),
		};
		attachLifecycleControl(server, stubDeps());
		expect(handler).toBeDefined();
		handler?.(null, { kind: "session_create", requestId: "lc_1", payloadJson: JSON.stringify(createFrame()) });
		await new Promise(r => setTimeout(r, 20));
		expect(responses).toHaveLength(1);
		const parsed = JSON.parse(responses[0]!);
		expect(parsed.type).toBe("session_create_response");
		expect(parsed.sessionId).toBe("sess_pre_1");
		// The control token must never appear in the response routed to clients.
		expect(responses[0]).not.toContain("control-token");
	});

	it("rate limiter allows up to N then blocks within the window", () => {
		const limit = createRateLimiter(2, 1000);
		expect(limit("42", 0)).toBe(true);
		expect(limit("42", 100)).toBe(true);
		expect(limit("42", 200)).toBe(false);
		expect(limit("42", 1300)).toBe(true); // window slid
	});

	it("serializes concurrent duplicate requests so only one spawn happens", async () => {
		const doc = { version: 1 as const, entries: {} as Record<string, unknown> };
		let spawns = 0;
		const deps = {
			...stubDeps(),
			store: {
				read: async () => JSON.parse(JSON.stringify(doc)),
				write: async (d: { version: 1; entries: Record<string, unknown> }) => {
					doc.entries = d.entries;
				},
			},
			spawnCreate: async (_f: unknown, ids: { intendedSessionId: string }) => {
				spawns++;
				await new Promise(r => setTimeout(r, 30)); // widen the race window
				return {
					sessionId: ids.intendedSessionId,
					tmuxSession: `gjc-${ids.intendedSessionId}`,
					endpointUrl: "",
					topicThreadId: "",
				};
			},
		} as unknown as OrchestratorDeps;

		const responses: string[] = [];
		let handler:
			| ((err: Error | null, req: { kind: string; requestId: string; payloadJson: string }) => void)
			| undefined;
		const server: ControlServerLike = {
			onLifecycleRequest: cb => {
				handler = cb;
			},
			respond: json => responses.push(json),
		};
		attachLifecycleControl(server, deps);

		const payload = JSON.stringify(createFrame());
		// Two identical updates arrive back-to-back (same updateId + body).
		handler?.(null, { kind: "session_create", requestId: "lc_1", payloadJson: payload });
		handler?.(null, { kind: "session_create", requestId: "lc_1", payloadJson: payload });
		await new Promise(r => setTimeout(r, 120));

		expect(spawns).toBe(1); // serial queue + durable ledger => exactly one spawn
		expect(responses).toHaveLength(2); // both get a response (one ok, one re-ack)
		expect(responses.every(r => r.includes("session_create_response"))).toBe(true);
	});

	it("daemonResumeSession fails closed against saved history (notFound / ambiguous)", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-resume-"));
		const proj = path.join(root, "proj");
		fs.mkdirSync(proj, { recursive: true });
		// Two saved histories sharing the prefix "abc".
		fs.writeFileSync(path.join(proj, "abc111.jsonl"), `${JSON.stringify({ type: "session" })}\n`);
		fs.writeFileSync(path.join(proj, "abc222.jsonl"), `${JSON.stringify({ type: "session" })}\n`);

		// No live tmux match for these unique ids, so resolution falls to history.
		const resume = daemonResumeSession(process.env, { sessionsRoot: root });

		const missing = await resume({ sessionIdOrPrefix: "zzz-no-such" });
		expect(missing).toEqual({ notFound: true });

		const ambiguous = await resume({ sessionIdOrPrefix: "abc" });
		expect("ambiguous" in ambiguous).toBe(true);
		if ("ambiguous" in ambiguous) {
			expect(ambiguous.ambiguous.map(c => c.sessionId).sort()).toEqual(["abc111", "abc222"]);
		}

		fs.rmSync(root, { recursive: true, force: true });
	});
});
