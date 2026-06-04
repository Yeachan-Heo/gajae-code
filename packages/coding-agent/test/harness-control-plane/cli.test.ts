import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { appendEvent, readSessionState, writeSessionState } from "../../src/harness-control-plane/storage";

const repoRoot = path.resolve(import.meta.dir, "..", "..", "..", "..");
const cliEntry = path.join(repoRoot, "packages", "coding-agent", "src", "cli.ts");

let root: string;
let workspace: string;

beforeEach(async () => {
	root = await mkdtemp(path.join(tmpdir(), "harness-cli-root-"));
	workspace = await mkdtemp(path.join(tmpdir(), "harness-cli-ws-"));
});

afterEach(async () => {
	await rm(root, { recursive: true, force: true });
	await rm(workspace, { recursive: true, force: true });
});

interface HarnessResult {
	code: number;
	json: any;
	raw: string;
}

function runHarness(args: string[]): HarnessResult {
	const proc = Bun.spawnSync(["bun", cliEntry, "harness", ...args], {
		cwd: workspace,
		env: { ...process.env, GJC_HARNESS_STATE_ROOT: root },
		stdout: "pipe",
		stderr: "pipe",
	});
	const raw = proc.stdout.toString().trim();
	let json: any = null;
	try {
		json = JSON.parse(raw);
	} catch {
		// leave null; assertions will surface the raw output
	}
	return { code: proc.exitCode ?? 0, json, raw };
}

function assertContract(res: any): void {
	expect(res, `expected contract object, got: ${JSON.stringify(res)}`).toBeTruthy();
	expect(res).toHaveProperty("state");
	expect(res).toHaveProperty("evidence");
	expect(res).toHaveProperty("nextAllowedActions");
}

function action(res: any, verb: string) {
	return (res.nextAllowedActions as any[]).find(a => a.verb === verb);
}

function git(args: string[]): void {
	const proc = Bun.spawnSync(["git", ...args], { cwd: workspace, stdout: "pipe", stderr: "pipe" });
	if (proc.exitCode !== 0) throw new Error(proc.stderr.toString() || `git ${args.join(" ")} failed`);
}

async function initCleanGitWorkspace(): Promise<void> {
	git(["init"]);
	git(["config", "user.email", "test@example.com"]);
	git(["config", "user.name", "Test User"]);
	await writeFile(path.join(workspace, "README.md"), "fixture\n", "utf8");
	git(["add", "README.md"]);
	git(["commit", "-m", "init"]);
}

async function appendSignal(sessionId: string, cursor: number, signal: string): Promise<void> {
	await appendEvent(root, sessionId, {
		eventId: `evt-${signal}-${cursor}`,
		cursor,
		createdAt: `2026-06-03T00:00:0${cursor}.000Z`,
		severity: "info",
		kind: `rpc_${signal.replaceAll("-", "_")}`,
		state: { sessionId, lifecycle: "observing", harness: "gajae-code", ownerLive: true, blockers: [] },
		evidence: { signal },
		nextAllowedActions: [],
		writer: { ownerId: "owner-exited", leaseEpoch: 1 },
	});
}

describe("gjc harness CLI (foundation)", () => {
	it("start creates a session and reports submit owner-not-live", () => {
		const res = runHarness(["start", "--input", JSON.stringify({ harness: "gajae-code", workspace })]);
		expect(res.code).toBe(0);
		assertContract(res.json);
		expect(res.json.ok).toBe(true);
		expect(res.json.state.lifecycle).toBe("started");
		expect(typeof res.json.evidence.handle.sessionId).toBe("string");
		const submit = action(res.json, "submit");
		expect(submit.available).toBe(false);
		expect(submit.reason).toBe("owner-not-live");
	});

	it("rejects non-gajae-code harness as an unsupported v1 seam", () => {
		const res = runHarness(["start", "--input", JSON.stringify({ harness: "codex", workspace })]);
		expect(res.code).toBe(1);
		expect(res.json.ok).toBe(false);
		expect(String(res.json.error)).toContain("harness_unsupported_in_v1");
	});

	it("observe re-grabs the session by id (stateless re-acquire) and stays read-only", () => {
		const started = runHarness(["start", "--input", JSON.stringify({ harness: "gajae-code", workspace })]);
		const sessionId = started.json.evidence.handle.sessionId as string;
		const res = runHarness(["observe", "--session", sessionId]);
		expect(res.code).toBe(0);
		assertContract(res.json);
		expect(res.json.state.sessionId).toBe(sessionId);
		expect(res.json.evidence.readOnly).toBe(true);
		expect(res.json.evidence.observation).toHaveProperty("gitDelta");
		expect(res.json.evidence.observation).toHaveProperty("risk");
		expect(res.json.evidence.observation).not.toHaveProperty("pane");
	});

	it("observe exposes durable completion evidence after the owner has exited", async () => {
		const started = runHarness(["start", "--input", JSON.stringify({ harness: "gajae-code", workspace })]);
		const sessionId = started.json.evidence.handle.sessionId as string;
		const state = await readSessionState(root, sessionId);
		expect(state).toBeTruthy();
		if (!state) throw new Error("missing seeded state");
		state.lifecycle = "finalizing";
		state.updatedAt = "2026-06-03T00:00:00.000Z";
		await writeSessionState(root, state);
		await appendEvent(root, sessionId, {
			eventId: "evt-completed",
			cursor: 1,
			createdAt: "2026-06-03T00:00:01.000Z",
			severity: "info",
			kind: "rpc_agent_completed",
			state: { sessionId, lifecycle: "finalizing", harness: "gajae-code", ownerLive: true, blockers: [] },
			evidence: { signal: "completed", outcome: "completed" },
			nextAllowedActions: [],
			writer: { ownerId: "owner-exited", leaseEpoch: 1 },
		});

		const res = runHarness(["observe", "--session", sessionId]);

		expect(res.code).toBe(0);
		assertContract(res.json);
		expect(res.json.state.ownerLive).toBe(false);
		expect(res.json.state.lifecycle).toBe("finalizing");
		expect(res.json.evidence.readOnly).toBe(true);
		expect(res.json.evidence.completedOwnerExited).toBe(true);
		expect(res.json.evidence.terminalResult).toEqual({
			cursor: 1,
			createdAt: "2026-06-03T00:00:01.000Z",
			kind: "rpc_agent_completed",
		});
		expect(res.json.evidence.observation.observedSignals).toContain("completed");
		expect(res.json.evidence.observation.lastActivityAt).toBe("2026-06-03T00:00:01.000Z");
	});

	it("observe treats terminal rpc_agent_completed kind without completed signal as completed owner exit", async () => {
		await initCleanGitWorkspace();
		const started = runHarness(["start", "--input", JSON.stringify({ harness: "gajae-code", workspace })]);
		const sessionId = started.json.evidence.handle.sessionId as string;
		const state = await readSessionState(root, sessionId);
		expect(state).toBeTruthy();
		if (!state) throw new Error("missing seeded state");
		state.lifecycle = "observing";
		state.updatedAt = "2026-06-03T00:00:00.000Z";
		await writeSessionState(root, state);
		await appendSignal(sessionId, 1, "prompt-accepted");
		await appendSignal(sessionId, 2, "tool-call");
		await appendSignal(sessionId, 3, "streaming");
		await appendEvent(root, sessionId, {
			eventId: "evt-completed-without-signal",
			cursor: 4,
			createdAt: "2026-06-03T00:00:04.000Z",
			severity: "info",
			kind: "rpc_agent_completed",
			state: { sessionId, lifecycle: "finalizing", harness: "gajae-code", ownerLive: true, blockers: [] },
			evidence: { outcome: "completed" },
			nextAllowedActions: [],
			writer: { ownerId: "owner-exited", leaseEpoch: 1 },
		});

		const res = runHarness(["observe", "--session", sessionId]);

		expect(res.code).toBe(0);
		assertContract(res.json);
		expect(res.json.state.ownerLive).toBe(false);
		expect(res.json.state.lifecycle).toBe("completed");
		expect(res.json.state.blockers).not.toContain("owner-vanished:clean");
		expect(res.json.evidence.ownerVanished).toBeUndefined();
		expect(res.json.evidence.blockerReason).toBeUndefined();
		expect(res.json.evidence.completedOwnerExited).toBe(true);
		expect(res.json.evidence.terminalResult).toEqual({
			cursor: 4,
			createdAt: "2026-06-03T00:00:04.000Z",
			kind: "rpc_agent_completed",
		});
		expect(res.json.evidence.observation.observedSignals).toEqual(
			expect.arrayContaining(["prompt-accepted", "tool-call", "streaming"]),
		);
		expect(res.json.evidence.observation.observedSignals).not.toContain("completed");

		const persisted = await readSessionState(root, sessionId);
		expect(persisted?.lifecycle).toBe("completed");
		expect(persisted?.blockers).not.toContain("owner-vanished:clean");
	});

	it("observe reconciles completed clean owner exit away from stale dirty vanish blocker", async () => {
		await initCleanGitWorkspace();
		const started = runHarness(["start", "--input", JSON.stringify({ harness: "gajae-code", workspace })]);
		const sessionId = started.json.evidence.handle.sessionId as string;
		const state = await readSessionState(root, sessionId);
		expect(state).toBeTruthy();
		if (!state) throw new Error("missing seeded state");
		state.lifecycle = "blocked";
		state.blockers = ["owner-vanished:dirty"];
		state.updatedAt = "2026-06-03T00:00:00.000Z";
		await writeSessionState(root, state);
		await appendEvent(root, sessionId, {
			eventId: "evt-completed-clean",
			cursor: 1,
			createdAt: "2026-06-03T00:00:01.000Z",
			severity: "info",
			kind: "rpc_agent_completed",
			state: { sessionId, lifecycle: "finalizing", harness: "gajae-code", ownerLive: true, blockers: [] },
			evidence: { outcome: "completed" },
			nextAllowedActions: [],
			writer: { ownerId: "owner-exited", leaseEpoch: 1 },
		});

		const res = runHarness(["observe", "--session", sessionId]);

		expect(res.code).toBe(0);
		assertContract(res.json);
		expect(res.json.state.lifecycle).toBe("completed");
		expect(res.json.state.blockers).not.toContain("owner-vanished:dirty");
		expect(res.json.evidence.completedOwnerExited).toBe(true);
		expect(action(res.json, "recover").available).toBe(false);
		expect(action(res.json, "recover").reason).toBe("lifecycle-terminal:completed");
		const persisted = await readSessionState(root, sessionId);
		expect(persisted?.lifecycle).toBe("completed");
		expect(persisted?.blockers).toEqual([]);
	});

	it("observe marks vanished owner after prompt/tool activity instead of silently observing clean worktree", async () => {
		await initCleanGitWorkspace();
		const started = runHarness(["start", "--input", JSON.stringify({ harness: "gajae-code", workspace })]);
		const sessionId = started.json.evidence.handle.sessionId as string;
		const state = await readSessionState(root, sessionId);
		expect(state).toBeTruthy();
		if (!state) throw new Error("missing seeded state");
		state.lifecycle = "observing";
		state.updatedAt = "2026-06-03T00:00:00.000Z";
		await writeSessionState(root, state);
		await appendSignal(sessionId, 1, "prompt-accepted");
		await appendSignal(sessionId, 2, "tool-call");
		await appendSignal(sessionId, 3, "streaming");

		const res = runHarness(["observe", "--session", sessionId]);

		expect(res.code).toBe(0);
		assertContract(res.json);
		expect(res.json.state.ownerLive).toBe(false);
		expect(res.json.state.lifecycle).toBe("blocked");
		expect(res.json.state.blockers).toContain("owner-vanished:clean");
		expect(res.json.evidence.ownerVanished).toBe(true);
		expect(res.json.evidence.blockerReason).toBe("owner-vanished:clean");
		expect(res.json.evidence.observation.lifecycle).toBe("blocked");
		expect(res.json.evidence.observation.gitDelta).toBe("clean");
		expect(res.json.evidence.observation.observedSignals).toEqual(
			expect.arrayContaining(["prompt-accepted", "tool-call", "streaming"]),
		);
		expect(action(res.json, "recover").available).toBe(true);

		const persisted = await readSessionState(root, sessionId);
		expect(persisted?.lifecycle).toBe("blocked");
		expect(persisted?.blockers).toContain("owner-vanished:clean");
	});

	it("recover without owner classifies vanished clean sessions instead of returning pending-only", async () => {
		await initCleanGitWorkspace();
		const started = runHarness(["start", "--input", JSON.stringify({ harness: "gajae-code", workspace })]);
		const sessionId = started.json.evidence.handle.sessionId as string;
		const state = await readSessionState(root, sessionId);
		expect(state).toBeTruthy();
		if (!state) throw new Error("missing seeded state");
		state.lifecycle = "observing";
		state.updatedAt = "2026-06-03T00:00:00.000Z";
		await writeSessionState(root, state);
		await appendSignal(sessionId, 1, "prompt-accepted");
		await appendSignal(sessionId, 2, "tool-call");

		const res = runHarness(["recover", "--session", sessionId]);

		expect(res.code).toBe(1);
		assertContract(res.json);
		expect(res.json.evidence.pending).toBe(false);
		expect(res.json.evidence.reason).toBe("owner-not-live");
		expect(res.json.evidence.decision.classification).toBe("restart-clean");
		expect(res.json.evidence.decision.requiredReceiptFamily).toBe("vanish");
		expect(res.json.evidence.observation.lifecycle).toBe("blocked");
		expect(res.json.state.lifecycle).toBe("blocked");
		expect(res.json.state.blockers).toContain("owner-vanished:clean");
	});

	it("submit is blocked (accepted:false, owner-not-live) and never echoed-as-accepted", () => {
		const started = runHarness(["start", "--input", JSON.stringify({ harness: "gajae-code", workspace })]);
		const sessionId = started.json.evidence.handle.sessionId as string;
		const res = runHarness(["submit", "--session", sessionId, "--input", JSON.stringify({ prompt: "hi" })]);
		expect(res.code).toBe(1);
		assertContract(res.json);
		expect(res.json.ok).toBe(false);
		expect(res.json.evidence.accepted).toBe(false);
		expect(res.json.evidence.reason).toBe("owner-not-live");
	});

	it("classify (pure, no session) maps a dirty vanish to restart-preserve-delta", () => {
		const res = runHarness([
			"classify",
			"--input",
			JSON.stringify({ observation: { ownerLive: false, gitDelta: "dirty", risk: "vanished-dirty" } }),
		]);
		expect(res.code).toBe(0);
		assertContract(res.json);
		expect(res.json.evidence.decision.classification).toBe("restart-preserve-delta");
		expect(res.json.evidence.decision.requiredReceiptFamily).toBe("vanish");
	});

	it("retire is blocked on an unknown/dirty delta (data-loss safety)", () => {
		const started = runHarness(["start", "--input", JSON.stringify({ harness: "gajae-code", workspace })]);
		const sessionId = started.json.evidence.handle.sessionId as string;
		const res = runHarness(["retire", "--session", sessionId]);
		// workspace is a bare temp dir (no git) -> gitDelta "unknown" -> retire blocked.
		expect(res.code).toBe(1);
		expect(res.json.evidence.retired).toBe(false);
		expect(String(res.json.evidence.reason)).toContain("retire-blocked");
	});

	it("non-recover owner-runtime verbs report an honest pending milestone", () => {
		const started = runHarness(["start", "--input", JSON.stringify({ harness: "gajae-code", workspace })]);
		const sessionId = started.json.evidence.handle.sessionId as string;
		const res = runHarness(["validate", "--session", sessionId]);
		expect(res.code).toBe(1);
		expect(res.json.ok).toBe(false);
		expect(res.json.evidence.pending).toBe(true);
		expect(res.json.evidence.verb).toBe("validate");
	});
});
