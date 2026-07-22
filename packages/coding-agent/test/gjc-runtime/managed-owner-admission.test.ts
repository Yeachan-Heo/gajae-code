import { describe, expect, it } from "bun:test";
import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { sessionUltragoalDir } from "@gajae-code/coding-agent/gjc-runtime/session-layout";
import { lifecyclePaths } from "@gajae-code/coding-agent/gjc-runtime/tmux-owner-isolation";

const repoRoot = path.resolve(import.meta.dir, "..", "..", "..", "..");
const admissionModule = path.join(
	repoRoot,
	"packages",
	"coding-agent",
	"src",
	"gjc-runtime",
	"managed-owner-admission.ts",
);

async function admit(stateDir: string, token?: string): Promise<{ admitted: boolean; exitCode: number; root: string }> {
	const script = `import { admitManagedOwnerBeforeCli } from ${JSON.stringify(admissionModule)}; const admission = await admitManagedOwnerBeforeCli(); console.log(JSON.stringify({ admitted: admission.kind !== "blocked", exitCode: process.exitCode ?? 0 }));`;
	const child = Bun.spawn({
		cmd: [process.execPath, "-e", script],
		cwd: repoRoot,
		stdout: "pipe",
		stderr: "pipe",
		env: {
			...process.env,
			GJC_TMUX_OWNER_STATE_DIR: stateDir,
			GJC_COORDINATOR_SESSION_ID: "session-2681",
			GJC_TMUX_OWNER_GENERATION: "generation-2681",
			GJC_MANAGED_OWNER_RUN_ID: "run-2681",
			GJC_MANAGED_OWNER_INCARNATION: "incarnation-2681",
			...(token ? { GJC_MANAGED_OWNER_CHILD_TOKEN: token } : {}),
		},
	});
	const [stdout, exitCode] = await Promise.all([new Response(child.stdout).text(), child.exited]);
	return {
		...(JSON.parse(stdout) as { admitted: boolean; exitCode: number }),
		exitCode,
		root: lifecyclePaths(stateDir, "session-2681", "generation-2681").root,
	};
}

async function writeBinding(root: string, token: string, patch: Record<string, unknown> = {}): Promise<void> {
	await fs.mkdir(root, { recursive: true });
	const command = ["gjc", "--resume"];
	await fs.writeFile(
		path.join(root, `child-${token}.binding.json`),
		`${JSON.stringify({ schema_version: 2, generation: "generation-2681", session_id: "session-2681", run_id: "run-2681", endpoint_incarnation: "incarnation-2681", child_token: token, command, command_sha256: crypto.createHash("sha256").update(JSON.stringify(command)).digest("hex"), supervisor_pid: 1, supervisor_start_time: "1", created_at: new Date().toISOString(), ...patch })}\n`,
	);
}

async function recover(
	stateDir: string,
	cwd: string,
	token: string,
	transcriptPath: string,
): Promise<{ kind: string; exitCode: number }> {
	const script = `import { admitManagedOwnerBeforeCli, completeManagedOwnerRecovery } from ${JSON.stringify(admissionModule)}; const admission = await admitManagedOwnerBeforeCli(); const terminal = admission.kind === "recovery" ? await completeManagedOwnerRecovery(admission.context) : admission; console.log(JSON.stringify({ kind: terminal.kind, exitCode: process.exitCode ?? 0 }));`;
	const child = Bun.spawn({
		cmd: [process.execPath, "-e", script],
		cwd,
		stdout: "pipe",
		stderr: "pipe",
		env: {
			...process.env,
			GJC_TMUX_OWNER_STATE_DIR: stateDir,
			GJC_COORDINATOR_SESSION_ID: "session-2681",
			GJC_TMUX_OWNER_GENERATION: "replacement-generation-2681",
			GJC_MANAGED_OWNER_RUN_ID: "replacement-run-2681",
			GJC_MANAGED_OWNER_INCARNATION: "replacement-incarnation-2681",
			GJC_MANAGED_OWNER_CHILD_TOKEN: "replacement-child-token",
			GJC_MANAGED_OWNER_PREDECESSOR_TOKEN: token,
			GJC_MANAGED_OWNER_PREDECESSOR_GENERATION: "generation-2681",
			GJC_MANAGED_OWNER_PREDECESSOR_RUN_ID: "run-2681",
			GJC_MANAGED_OWNER_PREDECESSOR_INCARNATION: "incarnation-2681",
			GJC_MANAGED_OWNER_TRANSCRIPT_PATH: transcriptPath,
		},
	});
	const [stdout, exitCode] = await Promise.all([new Response(child.stdout).text(), child.exited]);
	return { ...(JSON.parse(stdout) as { kind: string; exitCode: number }), exitCode };
}

async function writeSigabrtReceipt(root: string, token: string): Promise<void> {
	await fs.writeFile(
		path.join(root, `sigabrt-${token}.receipt.json`),
		`${JSON.stringify({
			schema_version: 2,
			generation: "generation-2681",
			session_id: "session-2681",
			run_id: "run-2681",
			endpoint_incarnation: "incarnation-2681",
			child_token: token,
			command_sha256: crypto
				.createHash("sha256")
				.update(JSON.stringify(["gjc", "--resume"]))
				.digest("hex"),
			supervisor_pid: 1,
			supervisor_start_time: "1",
			child_pid: 2,
			child_start_time: "2",
			signal: "SIGABRT",
			signal_number: 6,
			exit_code: null,
			received_at: new Date().toISOString(),
		})}\n`,
	);
}

async function writeRecoveryEvidence(cwd: string): Promise<string> {
	const ultragoal = sessionUltragoalDir(cwd, "session-2681");
	await fs.mkdir(ultragoal, { recursive: true });
	await fs.writeFile(path.join(ultragoal, "goals.json"), '{"goals":[]}');
	await fs.writeFile(path.join(ultragoal, "ledger.jsonl"), '{"event":"started"}\n');
	const transcript = path.join(cwd, "predecessor.jsonl");
	await fs.writeFile(
		transcript,
		'{"id":"one","parentId":null,"type":"message"}\n{"id":"two","parentId":"one","type":"yield","result":{"status":"success"}}\n{"id":"three","parentId":"two","type":"toolResult","toolCallId":"two","content":[]}\n',
	);
	return transcript;
}

describe("managed owner admission", () => {
	it("admits only the exact token binding for the current session and generation", async () => {
		const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-managed-admission-"));
		try {
			const root = lifecyclePaths(stateDir, "session-2681", "generation-2681").root;
			await writeBinding(root, "exact-token");
			const result = await admit(stateDir, "exact-token");
			expect(result.admitted).toBe(true);
			expect(result.exitCode).toBe(0);
			for (const patch of [
				{ child_token: "other-token" },
				{ session_id: "unrelated-session" },
				{ generation: "stale-generation" },
				{ command: ["replacement", 1] },
			]) {
				await writeBinding(root, "bad-token", patch);
				const rejected = await admit(stateDir, "bad-token");
				expect(rejected.admitted).toBe(false);
				expect(rejected.exitCode).toBe(75);
			}
		} finally {
			await fs.rm(stateDir, { recursive: true, force: true });
		}
	});

	it("fails closed with a durable recovery handoff for missing, traversal, and corrupt binding attempts", async () => {
		const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-managed-admission-"));
		try {
			const root = lifecyclePaths(stateDir, "session-2681", "generation-2681").root;
			await fs.mkdir(root, { recursive: true });
			for (const token of [undefined, "../escaped", "corrupt"]) {
				if (token === "corrupt") await fs.writeFile(path.join(root, "child-corrupt.binding.json"), "{bad json\n");
				const rejected = await admit(stateDir, token);
				expect(rejected.admitted).toBe(false);
				expect(rejected.exitCode).toBe(75);
			}
			const handoffs = (await fs.readdir(root)).filter(file => file.startsWith("admission-handoff-"));
			expect(handoffs.length).toBeGreaterThan(0);
			const latest = JSON.parse(
				await fs.readFile(path.join(root, handoffs[handoffs.length - 1]!), "utf8"),
			) as Record<string, unknown>;
			expect(latest).toMatchObject({
				schema_version: 2,
				session_id: "session-2681",
				generation: "generation-2681",
				state: "fail_closed_handoff",
			});
		} finally {
			await fs.rm(stateDir, { recursive: true, force: true });
		}
	});

	it("turns a recovery admission into a durable terminal handoff without changing B0 or dirty files", async () => {
		const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-managed-recovery-"));
		const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-managed-recovery-cwd-"));
		try {
			const root = lifecyclePaths(stateDir, "session-2681", "generation-2681").root;
			await writeBinding(root, "predecessor");
			await writeSigabrtReceipt(root, "predecessor");
			const transcript = await writeRecoveryEvidence(cwd);
			const goals = path.join(sessionUltragoalDir(cwd, "session-2681"), "goals.json");
			const ledger = path.join(sessionUltragoalDir(cwd, "session-2681"), "ledger.jsonl");
			const [beforeGoals, beforeLedger] = await Promise.all([
				fs.readFile(goals, "utf8"),
				fs.readFile(ledger, "utf8"),
			]);
			const dirty = path.join(cwd, "dirty.ts");
			await fs.writeFile(dirty, "export const dirty = true;\n");
			const result = await recover(stateDir, cwd, "predecessor", transcript);
			expect(result).toEqual({ kind: "handoff", exitCode: 75 });
			expect(await fs.readFile(dirty, "utf8")).toBe("export const dirty = true;\n");
			expect(await fs.readFile(goals, "utf8")).toBe(beforeGoals);
			expect(await fs.readFile(ledger, "utf8")).toBe(beforeLedger);
			const handoffs = (await fs.readdir(root)).filter(file => file.startsWith("admission-handoff-"));
			expect(handoffs).toHaveLength(1);
			expect(JSON.parse(await fs.readFile(path.join(root, handoffs[0]!), "utf8"))).toMatchObject({
				state: "fail_closed_handoff",
				reason: "safe_session_resume_seam_unavailable",
				terminal_reconciliation: "unavailable_without_owning_store_cas",
				b0_preserved: true,
			});
		} finally {
			await fs.rm(stateDir, { recursive: true, force: true });
			await fs.rm(cwd, { recursive: true, force: true });
		}
	});
});
