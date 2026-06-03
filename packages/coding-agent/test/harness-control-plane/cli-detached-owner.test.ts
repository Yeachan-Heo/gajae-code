import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { resolveOwner } from "../../src/harness-control-plane/owner";
import { readLease } from "../../src/harness-control-plane/session-lease";

const repoRoot = path.resolve(import.meta.dir, "..", "..", "..", "..");
const cliEntry = path.join(repoRoot, "packages", "coding-agent", "src", "cli.ts");
const SID = "d";
const FAKE_RPC = path.join(import.meta.dir, "fixtures", "fake-rpc.ts");

let root: string;
let workspace: string;

async function runHarness(args: string[]): Promise<{ code: number; json: Record<string, unknown> | null }> {
	const proc = Bun.spawn(["bun", cliEntry, "harness", ...args], {
		cwd: workspace,
		env: {
			...process.env,
			GJC_HARNESS_STATE_ROOT: root,
			// Drive the REAL GajaeCodeRpc against a protocol fixture (no shipped fake seam).
			GJC_HARNESS_RPC_COMMAND: JSON.stringify(["bun", FAKE_RPC]),
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
});

afterEach(async () => {
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
	it("spawns a background owner; submit + finalize route to it cross-process; retire stops it", async () => {
		const started = await runHarness([
			"start",
			"--input",
			JSON.stringify({ harness: "gajae-code", workspace, sessionId: SID, detach: true }),
		]);
		expect(started.code).toBe(0);
		expect((started.json?.evidence as Record<string, unknown>).ownerRuntime).toBe("detached");
		expect((started.json?.state as Record<string, unknown>).ownerLive).toBe(true);

		// A separate stateless CLI invocation re-grabs and drives the background session.
		const sub = await runHarness(["submit", "--session", SID, "--input", JSON.stringify({ prompt: "go" })]);
		expect((sub.json?.evidence as Record<string, unknown>).accepted).toBe(true);
		expect((sub.json?.state as Record<string, unknown>).lifecycle).toBe("observing");

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
});
