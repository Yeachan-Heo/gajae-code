import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
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

	it("owner-runtime verbs report an honest pending milestone", () => {
		const started = runHarness(["start", "--input", JSON.stringify({ harness: "gajae-code", workspace })]);
		const sessionId = started.json.evidence.handle.sessionId as string;
		const res = runHarness(["recover", "--session", sessionId]);
		expect(res.code).toBe(1);
		expect(res.json.ok).toBe(false);
		expect(res.json.evidence.pending).toBe(true);
		expect(typeof res.json.evidence.milestone).toBe("string");
	});
});
