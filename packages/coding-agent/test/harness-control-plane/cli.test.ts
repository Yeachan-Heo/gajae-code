import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { lstat, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import {
	appendEvent,
	readSessionState,
	sessionPaths,
	writeSessionState,
} from "../../src/harness-control-plane/storage";
import { createHarnessCliEnv, type HarnessCliEnv } from "./cli-workspace-env";

const repoRoot = path.resolve(import.meta.dir, "..", "..", "..", "..");
const cliEntry = path.join(repoRoot, "packages", "coding-agent", "src", "cli.ts");

let root: string;
let workspace: string;
let cliEnv: HarnessCliEnv;

beforeEach(async () => {
	root = await mkdtemp(path.join(tmpdir(), "harness-cli-root-"));
	workspace = await mkdtemp(path.join(tmpdir(), "harness-cli-ws-"));
	cliEnv = createHarnessCliEnv(repoRoot);
});

afterEach(async () => {
	cliEnv.cleanup();
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
		env: { ...cliEnv.env, GJC_HARNESS_STATE_ROOT: root },
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
function runHarnessInCwd(args: string[], cwd: string, env: NodeJS.ProcessEnv = process.env): HarnessResult {
	const proc = Bun.spawnSync(["bun", cliEntry, "harness", ...args], {
		cwd,
		env,
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
function harnessEnvWithoutStateRoot(): NodeJS.ProcessEnv {
	const env = { ...cliEnv.env };
	delete env.GJC_HARNESS_STATE_ROOT;
	return env;
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

function gitOutput(args: string[]): string {
	const proc = Bun.spawnSync(["git", ...args], { cwd: workspace, stdout: "pipe", stderr: "pipe" });
	if (proc.exitCode !== 0) throw new Error(proc.stderr.toString() || `git ${args.join(" ")} failed`);
	return proc.stdout.toString().trim();
}

async function initCleanGitWorkspace(): Promise<void> {
	if (await Bun.file(path.join(workspace, ".git")).exists()) return;
	git(["init"]);
	git(["config", "user.email", "test@example.com"]);
	git(["config", "user.name", "Test User"]);
	await writeFile(path.join(workspace, "README.md"), "fixture\n", "utf8");
	git(["add", "README.md"]);
	git(["commit", "-m", "init"]);
	git(["checkout", "-b", "feature/harness"]);
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
	it("test CLI env cleanup removes overlapping created links and preserves pre-existing links", async () => {
		const fakeRepo = await mkdtemp(path.join(tmpdir(), "harness-cli-env-repo-"));
		try {
			const packageDir = path.join(fakeRepo, "packages", "ai");
			await mkdir(packageDir, { recursive: true });
			await writeFile(path.join(packageDir, "package.json"), JSON.stringify({ name: "@gajae-code/ai" }), "utf8");
			const linkPath = path.join(fakeRepo, "node_modules", "@gajae-code", "ai");

			const first = createHarnessCliEnv(fakeRepo, {} as NodeJS.ProcessEnv);
			const second = createHarnessCliEnv(fakeRepo, {} as NodeJS.ProcessEnv);
			expect((await lstat(linkPath)).isSymbolicLink()).toBe(true);
			first.cleanup();
			expect((await lstat(linkPath)).isSymbolicLink()).toBe(true);
			second.cleanup();
			expect(await Bun.file(linkPath).exists()).toBe(false);

			await mkdir(path.dirname(linkPath), { recursive: true });
			await symlink(packageDir, linkPath, "dir");
			const withPreexistingLink = createHarnessCliEnv(fakeRepo, {} as NodeJS.ProcessEnv);
			withPreexistingLink.cleanup();
			expect((await lstat(linkPath)).isSymbolicLink()).toBe(true);
		} finally {
			await rm(fakeRepo, { recursive: true, force: true });
		}
	});

	it("preflight rejects a declared branch that differs from the actual checkout", async () => {
		await initCleanGitWorkspace();
		const res = runHarness([
			"preflight",
			"--input",
			JSON.stringify({ harness: "gajae-code", workspace, branch: "gajae-code-pr-265-review", issueOrPr: "PR-265" }),
		]);
		expect(res.code).toBe(1);
		expect(res.json.ok).toBe(false);
		expect(res.json.evidence.preflight.blockers).toContain("branch-mismatch");
		expect(res.json.evidence.preflight.actualBranch).toBe("feature/harness");
		expect(res.json.evidence.preflight.declaredBranch).toBe("gajae-code-pr-265-review");
		expect(res.json.evidence.preflight.normalizedIssueOrPr).toBe("265");
	});

	it("normalizes recognized issueOrPr forms and rejects ambiguous mixed ids", async () => {
		await initCleanGitWorkspace();
		for (const issueOrPr of [
			265,
			"265",
			"#265",
			"PR-265",
			"pr_265",
			"Yeachan-Heo/gajae-code#265",
			"https://github.com/Yeachan-Heo/gajae-code/pull/265",
		]) {
			const res = runHarness([
				"preflight",
				"--input",
				JSON.stringify({ harness: "gajae-code", workspace, issueOrPr }),
			]);
			expect(res.code).toBe(0);
			expect(res.json.evidence.preflight.normalizedIssueOrPr).toBe("265");
		}

		const bad = runHarness([
			"preflight",
			"--input",
			JSON.stringify({ harness: "gajae-code", workspace, issueOrPr: "pr-2725-recovery" }),
		]);
		expect(bad.code).toBe(1);
		expect(bad.json.evidence.preflight.blockers).toContain("invalid_issue_or_pr:pr-2725-recovery");
	});

	it("start persists normalized branch and issueOrPr metadata", async () => {
		await initCleanGitWorkspace();
		const branch = gitOutput(["rev-parse", "--abbrev-ref", "HEAD"]);
		const res = runHarness([
			"start",
			"--input",
			JSON.stringify({ harness: "gajae-code", workspace, branch, issueOrPr: "owner/repo#266" }),
		]);
		expect(res.code).toBe(0);
		expect(res.json.evidence.handle.branch).toBe(branch);
		expect(res.json.evidence.handle.issueOrPr).toBe("266");
		expect(res.json.evidence.preflight.ok).toBe(true);
	});

	it("resolves documented relative workspace sessions across caller cwd changes", async () => {
		await initCleanGitWorkspace();
		const siblingCwd = await mkdtemp(path.join(tmpdir(), "harness-cli-other-cwd-"));
		try {
			const started = runHarness(["start", "--input", JSON.stringify({ harness: "gajae-code", workspace: "." })]);
			expect(started.code).toBe(0);
			const sessionId = started.json.state.sessionId;
			expect(started.json.evidence.handle.workspace).toBe(workspace);

			const observed = runHarnessInCwd(
				["observe", "--session", sessionId, "--input", JSON.stringify({ workspace: "." })],
				siblingCwd,
				{ ...cliEnv.env },
			);
			expect(observed.code).toBe(1);
			expect(observed.json.error).toContain("session_workspace_mismatch");

			const observedFromWorkspace = runHarnessInCwd(
				["observe", "--session", sessionId, "--input", JSON.stringify({ workspace: "." })],
				workspace,
				{ ...cliEnv.env },
			);
			expect(observedFromWorkspace.code).toBe(0);
			expect(observedFromWorkspace.json.evidence.observation.cwd).toBe(workspace);
		} finally {
			await rm(siblingCwd, { recursive: true, force: true });
		}
	});

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

	it("re-acquires observe and recover by session id across cwd without state-root env", async () => {
		await initCleanGitWorkspace();
		const otherCwd = await mkdtemp(path.join(tmpdir(), "harness-cli-other-cwd-"));
		try {
			const env = harnessEnvWithoutStateRoot();
			const started = runHarnessInCwd(
				["start", "--input", JSON.stringify({ harness: "gajae-code", workspace })],
				workspace,
				env,
			);
			expect(started.code).toBe(0);
			const sessionId = started.json.evidence.handle.sessionId as string;

			await appendEvent(path.join(workspace, ".gjc", "state", "harness"), sessionId, {
				eventId: "evt-cross-cwd-prompt",
				cursor: 1,
				createdAt: "2026-06-03T00:00:01.000Z",
				severity: "info",
				kind: "prompt_accepted",
				state: { sessionId, lifecycle: "observing", harness: "gajae-code", ownerLive: true, blockers: [] },
				evidence: { signal: "prompt-accepted" },
				nextAllowedActions: [],
				writer: { ownerId: "owner-exited", leaseEpoch: 1 },
			});

			const observed = runHarnessInCwd(["observe", "--session", sessionId], otherCwd, env);
			expect(observed.code).toBe(0);
			assertContract(observed.json);
			expect(observed.json.state.sessionId).toBe(sessionId);
			expect(observed.json.evidence.observation.cwd).toBe(workspace);
			expect(observed.json.evidence.observation.observedSignals).toContain("prompt-accepted");

			const recovered = runHarnessInCwd(["recover", "--session", sessionId], otherCwd, env);
			expect(recovered.code).toBe(1);
			assertContract(recovered.json);
			expect(recovered.json.state.sessionId).toBe(sessionId);
			expect(recovered.json.evidence.reason).toBe("owner-exited-after-prompt-acceptance");
			expect(recovered.json.evidence.observation.cwd).toBe(workspace);
		} finally {
			await rm(otherCwd, { recursive: true, force: true });
		}
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

	it("observe treats clean completed owner exit as terminal recovery evidence", async () => {
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
		expect(res.json.evidence.reason).toBe("owner-exited-after-prompt-acceptance");
		expect(res.json.evidence.decision.classification).toBe("restart-clean");
		expect(res.json.evidence.decision.requiredReceiptFamily).toBe("vanish");
		expect(res.json.evidence.observation.lifecycle).toBe("blocked");
		expect(res.json.state.lifecycle).toBe("blocked");
		expect(res.json.state.blockers).toContain("owner-vanished:clean");
	});

	it("recover without owner preserves vanish evidence and explains post-acceptance owner exit", async () => {
		await initCleanGitWorkspace();
		const started = runHarness(["start", "--input", JSON.stringify({ harness: "gajae-code", workspace })]);
		const sessionId = started.json.evidence.handle.sessionId as string;
		const state = await readSessionState(root, sessionId);
		expect(state).toBeTruthy();
		if (!state) throw new Error("missing seeded state");
		state.lifecycle = "observing";
		state.handle.ownerHandle.endpoint = "synthetic-dead-owner.sock";
		state.updatedAt = "2026-06-03T00:00:00.000Z";
		await writeSessionState(root, state);
		await appendEvent(root, sessionId, {
			eventId: "evt-prompt-accepted",
			cursor: 1,
			createdAt: "2026-06-03T00:00:01.000Z",
			severity: "info",
			kind: "prompt_accepted",
			state: { sessionId, lifecycle: "observing", harness: "gajae-code", ownerLive: true, blockers: [] },
			evidence: { reason: "protocol-ack-single-flight", agentStartCursor: 1 },
			nextAllowedActions: [],
			writer: { ownerId: "owner-exited", leaseEpoch: 1 },
		});
		await appendSignal(sessionId, 2, "tool-call");

		const res = runHarness(["recover", "--session", sessionId]);

		expect(res.code).toBe(1);
		assertContract(res.json);
		expect(res.json.evidence.reason).toBe("owner-exited-after-prompt-acceptance");
		expect(res.json.evidence.ownerExit).toMatchObject({
			reason: "owner-exited-after-prompt-acceptance",
			leaseStatus: "missing",
			lastEventKind: "rpc_tool_call",
			lastSignal: "tool-call",
			promptAcceptedSeen: true,
			completedSeen: false,
		});
		expect(res.json.evidence.vanishReceiptId).toMatch(/^vanish-/);
		expect(res.json.evidence.observation.observedSignals).toEqual(
			expect.arrayContaining(["prompt-accepted", "tool-call"]),
		);
		expect(res.json.state.lifecycle).toBe("blocked");
		expect(res.json.state.blockers).toContain("owner-vanished:clean");
	});

	it("observe and events expose public-safe owner exit evidence after prompt acceptance", async () => {
		await initCleanGitWorkspace();
		const started = runHarness(["start", "--input", JSON.stringify({ harness: "gajae-code", workspace })]);
		const sessionId = started.json.evidence.handle.sessionId as string;
		const state = await readSessionState(root, sessionId);
		expect(state).toBeTruthy();
		if (!state) throw new Error("missing seeded state");
		state.lifecycle = "observing";
		state.updatedAt = "2026-06-03T00:00:00.000Z";
		await writeSessionState(root, state);
		await appendEvent(root, sessionId, {
			eventId: "evt-prompt-accepted",
			cursor: 1,
			createdAt: "2026-06-03T00:00:01.000Z",
			severity: "info",
			kind: "prompt_accepted",
			state: { sessionId, lifecycle: "observing", harness: "gajae-code", ownerLive: true, blockers: [] },
			evidence: { reason: "protocol-ack-single-flight", agentStartCursor: 1 },
			nextAllowedActions: [],
			writer: { ownerId: "owner-exited", leaseEpoch: 1 },
		});

		const observed = runHarness(["observe", "--session", sessionId]);
		const events = runHarness(["events", "--session", sessionId]);

		expect(observed.code).toBe(0);
		expect(observed.json.evidence.ownerExit).toMatchObject({
			reason: "owner-exited-after-prompt-acceptance",
			lastEventKind: "prompt_accepted",
			promptAcceptedSeen: true,
			completedSeen: false,
		});
		expect(observed.json.evidence.observation.observedSignals).toContain("prompt-accepted");
		expect(events.code).toBe(0);
		expect(events.json.evidence.ownerExit).toMatchObject({
			reason: "owner-exited-after-prompt-acceptance",
			lastEventKind: "prompt_accepted",
			promptAcceptedSeen: true,
			completedSeen: false,
		});
		expect(events.json.evidence.events).toHaveLength(1);
	});

	it("monitor distinguishes a transient endpoint gap from terminal owner loss when RPC activity continues", async () => {
		await initCleanGitWorkspace();
		const started = runHarness(["start", "--input", JSON.stringify({ harness: "gajae-code", workspace })]);
		const sessionId = started.json.evidence.handle.sessionId as string;
		const state = await readSessionState(root, sessionId);
		if (!state) throw new Error("missing seeded state");
		state.lifecycle = "observing";
		await writeSessionState(root, state);
		// A live lease (fresh heartbeat, this test process pid) — the heartbeat is the liveness signal.
		const nowMs = Date.now();
		const lease = {
			ownerId: "owner-live",
			sessionId,
			pid: process.pid,
			leaseTokenHash: "0".repeat(64),
			endpoint: { kind: "unix-socket" as const, path: "/tmp/unreachable.sock" },
			eventsPath: sessionPaths(root, sessionId).events,
			heartbeatAt: new Date(nowMs).toISOString(),
			expiresAt: new Date(nowMs + 30_000).toISOString(),
			leaseEpoch: 1,
			writer: { ownerId: "owner-live", leaseEpoch: 1 },
		};
		await writeFile(sessionPaths(root, sessionId).lease, `${JSON.stringify(lease, null, 2)}\n`, "utf8");
		await appendEvent(root, sessionId, {
			eventId: "evt-rpc-activity",
			cursor: 1,
			createdAt: new Date(nowMs).toISOString(),
			severity: "info",
			kind: "rpc_activity",
			state: { sessionId, lifecycle: "observing", harness: "gajae-code", ownerLive: true, blockers: [] },
			evidence: { coalescedFrames: 3 },
			nextAllowedActions: [],
			writer: { ownerId: "owner-live", leaseEpoch: 1 },
		});

		const monitored = runHarness(["monitor", "--session", sessionId]);
		expect(monitored.code).toBe(0);
		expect(monitored.json.evidence.ownerExit).toMatchObject({
			// Reason string is unchanged for backward-compatible consumers; the transient distinction
			// is carried by the additive `terminal`/`transient` fields.
			reason: "owner-endpoint-unreachable",
			leaseStatus: "live",
			terminal: false,
			transient: true,
		});
		expect(monitored.json.evidence.ownerExit.lastRpcActivityAt).toBeTruthy();
	});

	it("monitor does not treat a terminal completion frame as owner liveness (no transient masking)", async () => {
		await initCleanGitWorkspace();
		const started = runHarness(["start", "--input", JSON.stringify({ harness: "gajae-code", workspace })]);
		const sessionId = started.json.evidence.handle.sessionId as string;
		const state = await readSessionState(root, sessionId);
		if (!state) throw new Error("missing seeded state");
		state.lifecycle = "observing";
		await writeSessionState(root, state);
		// No lease (owner gone) plus a recent terminal completion frame.
		await appendEvent(root, sessionId, {
			eventId: "evt-rpc-completed",
			cursor: 1,
			createdAt: new Date().toISOString(),
			severity: "info",
			kind: "rpc_agent_completed",
			state: { sessionId, lifecycle: "observing", harness: "gajae-code", ownerLive: true, blockers: [] },
			evidence: { outcome: "completed", signal: "completed" },
			nextAllowedActions: [],
			writer: { ownerId: "owner-gone", leaseEpoch: 1 },
		});

		const monitored = runHarness(["monitor", "--session", sessionId]);
		expect(monitored.code).toBe(0);
		expect(monitored.json.evidence.ownerExit.terminal).toBe(true);
		expect(monitored.json.evidence.ownerExit.transient).toBe(false);
		// Completion frames are excluded from activity, so they cannot fabricate liveness.
		expect(monitored.json.evidence.ownerExit.lastRpcActivityAt).toBeNull();
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
