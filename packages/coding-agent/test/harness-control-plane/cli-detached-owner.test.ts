import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { chmod, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { resolveOwner } from "../../src/harness-control-plane/owner";
import { readLease } from "../../src/harness-control-plane/session-lease";
import { createHarnessCliEnv, type HarnessCliEnv } from "./cli-workspace-env";

const repoRoot = path.resolve(import.meta.dir, "..", "..", "..", "..");
const cliEntry = path.join(repoRoot, "packages", "coding-agent", "src", "cli.ts");
const SID = "d";
const FAKE_RPC = path.join(import.meta.dir, "fixtures", "fake-rpc.ts");

let root: string;
let workspace: string;
let tmuxCommand: string;
let rpcCommandEnv: string;
let cliEnv: HarnessCliEnv;

async function createFakeTmuxBin(
	rootDir: string,
	options: { failNewSession?: boolean; skipOwnerLaunch?: boolean } = {},
): Promise<string> {
	const binDir = path.join(rootDir, ".test-bin");
	const tmuxPath = path.join(binDir, "tmux");
	const logPath = path.join(rootDir, "tmux.log");
	await mkdir(binDir, { recursive: true });
	await Bun.write(
		tmuxPath,
		`#!/usr/bin/env bash
echo "$@" >> ${JSON.stringify(logPath)}
case "$1" in
  new-session)
    ${options.failNewSession ? "echo tmux new-session failed >&2; exit 9" : ""}
    cwd="$PWD"
    for ((i=1; i<=$#; i++)); do
      if [ "\${!i}" = "-c" ]; then
        next=$((i + 1))
        cwd="\${!next}"
      fi
    done
    cmd="\${@: -1}"
    ${options.skipOwnerLaunch ? "exit 0" : '(cd "$cwd" && bash -lc "$cmd") >/dev/null 2>&1 &'}
    exit 0
    ;;
  *)
    exit 0
    ;;
esac
`,
	);
	await chmod(tmuxPath, 0o755);
	return tmuxPath;
}

async function runHarness(args: string[]): Promise<{ code: number; json: Record<string, unknown> | null }> {
	const proc = Bun.spawn(["bun", cliEntry, "harness", ...args], {
		cwd: workspace,
		env: {
			...cliEnv.env,
			GJC_HARNESS_STATE_ROOT: root,
			// Drive the REAL GajaeCodeRpc against a protocol fixture (no shipped fake seam).
			GJC_HARNESS_RPC_COMMAND: rpcCommandEnv,
			GJC_TMUX_COMMAND: tmuxCommand,
		},
		stdout: "pipe",
		stderr: "pipe",
	});
	const out = await new Response(proc.stdout).text();
	const code = await proc.exited;
	let json: Record<string, unknown> | null = null;
	try {
		json = JSON.parse(out.trim()) as Record<string, unknown>;
	} catch {
		json = null;
	}
	return { code, json };
}

const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms));

beforeEach(async () => {
	// Short paths keep the AF_UNIX socket path under the sun_path limit.
	root = await mkdtemp(path.join(tmpdir(), "h"));
	workspace = await mkdtemp(path.join(tmpdir(), "hw"));
	cliEnv = createHarnessCliEnv(repoRoot);
	tmuxCommand = await createFakeTmuxBin(root);
	rpcCommandEnv = JSON.stringify(["bun", FAKE_RPC]);
});

afterEach(async () => {
	cliEnv.cleanup();
	// Safety net: kill any lingering detached owner.
	try {
		const lease = await readLease(root, SID);
		if (lease?.pid) {
			try {
				process.kill(lease.pid, "SIGTERM");
			} catch {
				// already gone
			}
		}
	} catch {
		// no lease
	}
	await rm(root, { recursive: true, force: true });
	await rm(workspace, { recursive: true, force: true });
});

describe("gjc harness start --detach (detached owner lifecycle, B1)", () => {
	it("spawns a tmux-resident owner; submit + finalize route to it cross-process; retire stops it", async () => {
		const started = await runHarness([
			"start",
			"--input",
			JSON.stringify({ harness: "gajae-code", workspace, sessionId: SID, detach: true }),
		]);
		expect(started.code).toBe(0);
		const evidence = started.json?.evidence as Record<string, unknown>;
		expect(evidence.ownerRuntime).toBe("tmux");
		expect((started.json?.state as Record<string, unknown>).ownerLive).toBe(true);
		const handle = evidence.handle as { viewportHandle?: { tmuxSessionName?: string | null } };
		expect(handle.viewportHandle?.tmuxSessionName).toBe(`gajae_code_harness_${SID}`);

		// A separate stateless CLI invocation re-grabs and drives the background session.
		const sub = await runHarness(["submit", "--session", SID, "--input", JSON.stringify({ prompt: "go" })]);
		expect((sub.json?.evidence as Record<string, unknown>).accepted).toBe(true);
		expect((sub.json?.state as Record<string, unknown>).lifecycle).toBe("observing");

		// AC-9: the detached owner maps the real RPC frame stream -> observe surfaces tool-call -> completed.
		let signals: string[] = [];
		for (let i = 0; i < 40; i++) {
			const o = await runHarness(["observe", "--session", SID]);
			signals =
				((o.json?.evidence as Record<string, unknown>)?.observation as { observedSignals?: string[] })
					?.observedSignals ?? [];
			if (signals.includes("completed")) break;
			await sleep(50);
		}
		expect(signals).toContain("tool-call");
		expect(signals).toContain("completed");

		// Owner-backed finalize: the evidence gate HONESTLY refuses without real commit/PR/tests
		// (no fake completion evidence in shipped code).
		const fin = await runHarness(["finalize", "--session", SID]);
		const finEvidence = (fin.json?.evidence as Record<string, unknown>).finalize as Record<string, unknown>;
		expect(finEvidence).toBeTruthy();
		expect(finEvidence.completed).toBe(false);
		expect((finEvidence.blockers as unknown[]).length).toBeGreaterThan(0);

		// Retire stops the owner and releases the lease.
		const ret = await runHarness(["retire", "--session", SID]);
		expect((ret.json?.evidence as Record<string, unknown>).retired).toBe(true);

		let after = await resolveOwner(root, SID);
		for (let i = 0; i < 80 && after.live; i++) {
			await sleep(50);
			after = await resolveOwner(root, SID);
		}
		expect(after.live).toBe(false);
	}, 60_000);

	it("falls back explicitly when tmux exits zero without launching the owner", async () => {
		tmuxCommand = await createFakeTmuxBin(root, { skipOwnerLaunch: true });
		const started = await runHarness([
			"start",
			"--input",
			JSON.stringify({ harness: "gajae-code", workspace, sessionId: SID, detach: true }),
		]);
		expect(started.code).toBe(0);
		const evidence = started.json?.evidence as Record<string, unknown>;
		expect(evidence.ownerRuntime).toBe("detached");
		expect(evidence.ownerFallbackReason).toBe("tmux new-session exited 0 but owner endpoint did not become routable");
		expect((started.json?.state as Record<string, unknown>).ownerLive).toBe(true);
		expect(evidence.ownerRuntime).not.toBe("manual");

		const ret = await runHarness(["retire", "--session", SID]);
		expect((ret.json?.evidence as Record<string, unknown>).retired).toBe(true);
	}, 60_000);

	it("reports blocked only after detached owner endpoint remains unavailable", async () => {
		tmuxCommand = await createFakeTmuxBin(root, { skipOwnerLaunch: true });
		const originalRpcCommandEnv = rpcCommandEnv;
		rpcCommandEnv = "{";
		try {
			const started = await runHarness([
				"start",
				"--input",
				JSON.stringify({ harness: "gajae-code", workspace, sessionId: SID, detach: true }),
			]);
			expect(started.code).toBe(1);
			expect(started.json?.ok).toBe(false);
			const state = started.json?.state as Record<string, unknown>;
			const evidence = started.json?.evidence as Record<string, unknown>;
			expect(state.lifecycle).toBe("blocked");
			expect(state.ownerLive).toBe(false);
			expect(state.blockers).toContain("detached-owner-not-live");
			expect(evidence.ownerRuntime).toBe("detached");
			expect(evidence.reason).toBe("detached-owner-not-live");

			const submit = await runHarness(["submit", "--session", SID, "--input", JSON.stringify({ prompt: "go" })]);
			expect(submit.code).toBe(1);
			expect(submit.json?.ok).toBe(false);
			expect((submit.json?.state as Record<string, unknown>).ownerLive).toBe(false);
			expect((submit.json?.evidence as Record<string, unknown>).accepted).toBe(false);
			expect((submit.json?.evidence as Record<string, unknown>).reason).toBe("owner-not-live");
			expect(submit.json?.nextAllowedActions).toContainEqual({
				verb: "submit",
				available: false,
				reason: "lifecycle-blocked",
			});
		} finally {
			rpcCommandEnv = originalRpcCommandEnv;
		}
	}, 60_000);
	it("falls back explicitly when tmux cannot start", async () => {
		tmuxCommand = await createFakeTmuxBin(root, { failNewSession: true });
		const started = await runHarness([
			"start",
			"--input",
			JSON.stringify({ harness: "gajae-code", workspace, sessionId: SID, detach: true }),
		]);
		expect(started.code).toBe(0);
		const evidence = started.json?.evidence as Record<string, unknown>;
		expect(evidence.ownerRuntime).toBe("detached");
		expect(evidence.ownerFallbackReason).toContain("tmux new-session failed");
		expect((started.json?.state as Record<string, unknown>).ownerLive).toBe(true);

		const ret = await runHarness(["retire", "--session", SID]);
		expect((ret.json?.evidence as Record<string, unknown>).retired).toBe(true);
	}, 60_000);
});
