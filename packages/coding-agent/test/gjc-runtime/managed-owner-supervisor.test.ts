import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { sessionUltragoalDir } from "@gajae-code/coding-agent/gjc-runtime/session-layout";
import {
	createOwnerIntent,
	lifecyclePaths,
	replaceOwnerGeneration,
} from "@gajae-code/coding-agent/gjc-runtime/tmux-owner-isolation";

const repoRoot = path.resolve(import.meta.dir, "..", "..", "..", "..");
const supervisorModule = path.join(
	repoRoot,
	"packages",
	"coding-agent",
	"src",
	"gjc-runtime",
	"managed-owner-supervisor.ts",
);
const admissionModule = path.join(
	repoRoot,
	"packages",
	"coding-agent",
	"src",
	"gjc-runtime",
	"managed-owner-admission.ts",
);

function startSupervisor(
	stateDir: string,
	command: string[],
	env: Record<string, string> = {},
	options: { forceMissingNativeReferenceMarker?: string } = {},
) {
	const script = options.forceMissingNativeReferenceMarker
		? `const { appendFileSync } = await import("node:fs"); const originalSpawn = Bun.spawn; Bun.spawn = options => { const child = originalSpawn(options); const actualPid = child.pid; let pidReads = 0; Object.defineProperty(child, "pid", { configurable: true, get() { pidReads += 1; if (pidReads === 2) { appendFileSync(${JSON.stringify(options.forceMissingNativeReferenceMarker)}, "forced-missing-native-reference:" + actualPid + "\\n"); return 2_000_000_000; } return actualPid; } }); return child; }; try { const { runManagedOwnerSupervisor } = await import(${JSON.stringify(supervisorModule)}); await runManagedOwnerSupervisor(); } finally { Bun.spawn = originalSpawn; }`
		: `import { runManagedOwnerSupervisor } from ${JSON.stringify(supervisorModule)}; await runManagedOwnerSupervisor();`;
	return Bun.spawn({
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
			GJC_MANAGED_OWNER_COMMAND_JSON: JSON.stringify(command),
			...env,
		},
	});
}
async function runSupervisor(
	stateDir: string,
	command: string[],
	env: Record<string, string> = {},
	options: { forceMissingNativeReferenceMarker?: string } = {},
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
	const child = startSupervisor(stateDir, command, env, options);
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
		child.exited,
	]);
	return { exitCode, stdout, stderr };
}
async function waitForFile(file: string): Promise<void> {
	for (let attempt = 0; attempt < 100; attempt += 1) {
		try {
			await fs.access(file);
			return;
		} catch {
			await Bun.sleep(20);
		}
	}
	throw new Error(`timed_out_waiting_for_${path.basename(file)}`);
}

function fastSigabrtCommand(): string[] {
	if (process.platform !== "win32") return ["/bin/sh", "-c", "kill -ABRT $$"];
	return [process.execPath, "-e", "process.kill(process.pid, 'SIGABRT')"];
}

describe("managed owner supervisor", () => {
	it("records one exact durable SIGABRT receipt and exits with the abort status", async () => {
		const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-managed-owner-"));
		try {
			const result = await runSupervisor(stateDir, fastSigabrtCommand());
			expect(result.exitCode).toBe(134);
			const root = lifecyclePaths(stateDir, "session-2681", "generation-2681").root;
			const files = await fs.readdir(root);
			const bindingFile = files.find(file => file.startsWith("child-") && file.endsWith(".binding.json"));
			const receiptFile = files.find(file => file.startsWith("sigabrt-") && file.endsWith(".receipt.json"));
			expect(bindingFile).toBeDefined();
			expect(receiptFile).toBeDefined();
			const binding = JSON.parse(await fs.readFile(path.join(root, bindingFile!), "utf8")) as Record<
				string,
				unknown
			>;
			const receipt = JSON.parse(await fs.readFile(path.join(root, receiptFile!), "utf8")) as Record<
				string,
				unknown
			>;
			expect(receipt).toMatchObject({
				schema_version: 2,
				session_id: "session-2681",
				generation: "generation-2681",
				signal: "SIGABRT",
				child_token: binding.child_token,
				signal_number: 6,
				run_id: "run-2681",
				endpoint_incarnation: "incarnation-2681",
			});
			expect(files.filter(file => file.startsWith("sigabrt-")).length).toBe(1);
		} finally {
			await fs.rm(stateDir, { recursive: true, force: true });
		}
	});
	it("does not persist or forward a Broker-redacted child command", async () => {
		const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-managed-owner-"));
		try {
			const result = await runSupervisor(
				stateDir,
				[
					process.execPath,
					"-e",
					"if (process.env.GJC_MANAGED_OWNER_COMMAND_JSON || process.env.GJC_MANAGED_OWNER_REDACT_COMMAND) process.exit(19)",
				],
				{ GJC_MANAGED_OWNER_REDACT_COMMAND: "1" },
			);
			expect(result.exitCode, result.stderr).toBe(0);
			const root = lifecyclePaths(stateDir, "session-2681", "generation-2681").root;
			const files = await fs.readdir(root);
			expect(files.filter(file => file.includes("binding") || file.includes("receipt"))).toEqual([]);
		} finally {
			await fs.rm(stateDir, { recursive: true, force: true });
		}
	});

	it("records SIGABRT through the missing native child reference path", async () => {
		if (process.platform !== "linux") return;
		const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-managed-owner-"));
		const markerFile = path.join(stateDir, "forced-missing-native-reference.marker");
		try {
			const result = await runSupervisor(
				stateDir,
				fastSigabrtCommand(),
				{},
				{
					forceMissingNativeReferenceMarker: markerFile,
				},
			);
			expect(result.exitCode, `${result.stdout}\n${result.stderr}`).toBe(134);
			expect(await fs.readFile(markerFile, "utf8")).toMatch(/^forced-missing-native-reference:\d+\n$/);
			const root = lifecyclePaths(stateDir, "session-2681", "generation-2681").root;
			const files = await fs.readdir(root);
			const bindingFiles = files.filter(file => file.startsWith("child-") && file.endsWith(".binding.json"));
			const receiptFiles = files.filter(file => file.startsWith("sigabrt-") && file.endsWith(".receipt.json"));
			expect(bindingFiles).toHaveLength(1);
			expect(receiptFiles).toHaveLength(1);
			const binding = JSON.parse(await fs.readFile(path.join(root, bindingFiles[0]!), "utf8")) as Record<
				string,
				unknown
			>;
			const receipt = JSON.parse(await fs.readFile(path.join(root, receiptFiles[0]!), "utf8")) as Record<
				string,
				unknown
			>;
			expect(receiptFiles[0]).toBe(`sigabrt-${binding.child_token}.receipt.json`);
			expect(receipt).toMatchObject({
				schema_version: 2,
				session_id: "session-2681",
				generation: "generation-2681",
				signal: "SIGABRT",
				child_token: binding.child_token,
				signal_number: 6,
				run_id: "run-2681",
				endpoint_incarnation: "incarnation-2681",
				exit_code: 134,
			});
		} finally {
			await fs.rm(stateDir, { recursive: true, force: true });
		}
	});

	it("does not mint a SIGABRT receipt for a normally exiting child", async () => {
		const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-managed-owner-"));
		try {
			const result = await runSupervisor(stateDir, [process.execPath, "-e", "process.exit(23)"]);
			expect(result.exitCode).toBe(75);
			const root = lifecyclePaths(stateDir, "session-2681", "generation-2681").root;
			expect((await fs.readdir(root)).some(file => file.startsWith("sigabrt-"))).toBe(false);
		} finally {
			await fs.rm(stateDir, { recursive: true, force: true });
		}
	});
	it("fails closed when unexpected owner-loss publication cannot persist", async () => {
		const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-managed-owner-"));
		const sessionId = "session-2681";
		const generation = "generation-2681";
		const lifecycleRoot = lifecyclePaths(stateDir, sessionId, generation).root;
		try {
			await replaceOwnerGeneration(stateDir, sessionId, generation);
			const childScript = `import { chmod } from "node:fs/promises"; import { lifecyclePaths } from ${JSON.stringify(
				path.join(repoRoot, "packages", "coding-agent", "src", "gjc-runtime", "tmux-owner-isolation.ts"),
			)}; await chmod(lifecyclePaths(process.env.GJC_TMUX_OWNER_STATE_DIR!, process.env.GJC_COORDINATOR_SESSION_ID!, process.env.GJC_TMUX_OWNER_GENERATION!).root, 0o500); process.exit(23);`;
			const result = await runSupervisor(stateDir, [process.execPath, "-e", childScript]);
			expect(result.exitCode).toBe(75);
			expect(await Bun.file(lifecyclePaths(stateDir, sessionId, generation).verdictFile).exists()).toBe(false);
			expect(await Bun.file(lifecyclePaths(stateDir, sessionId, generation).incidentFile).exists()).toBe(false);
		} finally {
			await fs.chmod(lifecycleRoot, 0o700).catch(() => undefined);
			await fs.rm(stateDir, { recursive: true, force: true });
		}
	});
	it("relays one SIGTERM to its exact child and waits for child cleanup", async () => {
		const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-managed-owner-"));
		const readyFile = path.join(stateDir, "child-ready");
		const cleanupFile = path.join(stateDir, "child-cleanup.json");
		try {
			const childScript = `import { writeFile } from "node:fs/promises";
let signals = 0;
process.on("SIGTERM", () => {
	signals += 1;
	void writeFile(process.env.CLEANUP_FILE!, JSON.stringify({ signals })).then(() => {
		setTimeout(() => process.exit(0), 300);
	});
});
await writeFile(process.env.READY_FILE!, "ready");
setInterval(() => {}, 1_000);`;
			const supervisor = startSupervisor(stateDir, [process.execPath, "-e", childScript], {
				READY_FILE: readyFile,
				CLEANUP_FILE: cleanupFile,
			});
			await waitForFile(readyFile);
			process.kill(supervisor.pid, "SIGTERM");
			await waitForFile(cleanupFile);
			expect(() => process.kill(supervisor.pid, 0)).not.toThrow();
			process.kill(supervisor.pid, "SIGTERM");
			expect(await supervisor.exited).toBe(75);
			expect(JSON.parse(await fs.readFile(cleanupFile, "utf8"))).toEqual({ signals: 1 });
		} finally {
			await fs.rm(stateDir, { recursive: true, force: true });
		}
	});
	it("does not retroactively attribute an unsolicited relay to a later operator intent", async () => {
		const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-managed-owner-"));
		const sessionId = "session-2681";
		const generation = "generation-2681";
		const readyFile = path.join(stateDir, "child-ready");
		const signalFile = path.join(stateDir, "child-signals");
		try {
			await replaceOwnerGeneration(stateDir, sessionId, generation);
			const childScript = `import { writeFileSync } from "node:fs";
let signals = 0;
process.on("SIGTERM", () => {
	signals += 1;
	writeFileSync(process.env.SIGNAL_FILE!, String(signals));
	if (signals === 1) setTimeout(() => process.exit(0), 1_000);
});
writeFileSync(process.env.READY_FILE!, "ready");
setInterval(() => {}, 1_000);`;
			const supervisor = startSupervisor(stateDir, [process.execPath, "-e", childScript], {
				READY_FILE: readyFile,
				SIGNAL_FILE: signalFile,
				GJC_TMUX_OWNER_SERVER_KEY: "server-key",
			});
			await waitForFile(readyFile);
			process.kill(supervisor.pid, "SIGTERM");
			await waitForFile(signalFile);
			expect(await fs.readFile(signalFile, "utf8")).toBe("1");
			await createOwnerIntent(stateDir, {
				generation,
				session_id: sessionId,
				server_key: "server-key",
				expected_terminal: {
					signal: "SIGTERM",
					result: "owner_term_then_session_cleanup",
				},
				dispatch_id: "late-dispatch",
				created_at: new Date(Date.now() - 1_000).toISOString(),
				expires_at: new Date(Date.now() + 60_000).toISOString(),
			});
			process.kill(supervisor.pid, "SIGTERM");
			expect(await supervisor.exited).toBe(0);
			expect(await fs.readFile(signalFile, "utf8")).toBe("1");
			const verdict = JSON.parse(
				await fs.readFile(lifecyclePaths(stateDir, sessionId, generation).verdictFile, "utf8"),
			) as Record<string, unknown>;
			expect(verdict).toMatchObject({
				classification: "unexpected_owner_loss",
				reason: "terminal_observation",
			});
			expect(verdict.intent_id).toBeUndefined();
		} finally {
			await fs.rm(stateDir, { recursive: true, force: true });
		}
	});
	it("preserves expected attribution for an active matching intent on first relay", async () => {
		const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-managed-owner-"));
		const sessionId = "session-2681";
		const generation = "generation-2681";
		const readyFile = path.join(stateDir, "child-ready");
		const signalFile = path.join(stateDir, "child-signals");
		try {
			await replaceOwnerGeneration(stateDir, sessionId, generation);
			await createOwnerIntent(stateDir, {
				generation,
				session_id: sessionId,
				server_key: "server-key",
				expected_terminal: {
					signal: "SIGTERM",
					result: "owner_term_then_session_cleanup",
				},
				dispatch_id: "matching-dispatch",
				created_at: new Date(Date.now() - 1_000).toISOString(),
				expires_at: new Date(Date.now() + 60_000).toISOString(),
			});
			const childScript = `import { writeFileSync } from "node:fs";
let signals = 0;
process.on("SIGTERM", () => {
	signals += 1;
	writeFileSync(process.env.SIGNAL_FILE!, String(signals));
	setTimeout(() => process.exit(0), 100);
});
writeFileSync(process.env.READY_FILE!, "ready");
setInterval(() => {}, 1_000);`;
			const supervisor = startSupervisor(stateDir, [process.execPath, "-e", childScript], {
				READY_FILE: readyFile,
				SIGNAL_FILE: signalFile,
				GJC_TMUX_OWNER_SERVER_KEY: "server-key",
			});
			await waitForFile(readyFile);
			process.kill(supervisor.pid, "SIGTERM");
			expect(await supervisor.exited).toBe(0);
			expect(await fs.readFile(signalFile, "utf8")).toBe("1");
			const verdict = JSON.parse(
				await fs.readFile(lifecyclePaths(stateDir, sessionId, generation).verdictFile, "utf8"),
			) as Record<string, unknown>;
			expect(verdict).toMatchObject({
				classification: "expected_operator_shutdown",
				result: "owner_term_then_session_cleanup",
			});
			expect(verdict.intent_id).toBeString();
			await expect(
				fs.access(`${lifecyclePaths(stateDir, sessionId, generation).intentFile}.consumed`),
			).resolves.toBeNull();
		} finally {
			await fs.rm(stateDir, { recursive: true, force: true });
		}
	});
	it("routes a replacement supervisor child through predecessor recovery before normal CLI", async () => {
		const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-managed-owner-"));
		const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-managed-owner-cwd-"));
		try {
			const predecessor = await runSupervisor(stateDir, fastSigabrtCommand());
			expect(predecessor.exitCode).toBe(134);
			const root = lifecyclePaths(stateDir, "session-2681", "generation-2681").root;
			const bindingFile = (await fs.readdir(root)).find(
				file => file.startsWith("child-") && file.endsWith(".binding.json"),
			);
			expect(bindingFile).toBeDefined();
			const predecessorToken = bindingFile!.slice("child-".length, -".binding.json".length);
			const ultragoal = sessionUltragoalDir(cwd, "session-2681");
			await fs.mkdir(ultragoal, { recursive: true });
			await fs.writeFile(path.join(ultragoal, "goals.json"), '{"goals":[]}');
			await fs.writeFile(path.join(ultragoal, "ledger.jsonl"), '{"event":"started"}\n');
			const transcript = path.join(cwd, "predecessor.jsonl");
			await fs.writeFile(
				transcript,
				'{"id":"yield-1","parentId":null,"type":"yield","result":{"status":"success"}}\n{"id":"result-1","parentId":"yield-1","type":"toolResult","toolCallId":"yield-1","content":[]}\n',
			);
			const childScript = `import { admitManagedOwnerBeforeCli, completeManagedOwnerRecovery } from ${JSON.stringify(admissionModule)}; process.chdir(${JSON.stringify(cwd)}); const admission = await admitManagedOwnerBeforeCli(); const terminal = admission.kind === "recovery" ? await completeManagedOwnerRecovery(admission.context) : admission; console.log(JSON.stringify({ kind: terminal.kind }));`;
			const replacement = await runSupervisor(stateDir, [process.execPath, "-e", childScript], {
				GJC_TMUX_OWNER_GENERATION: "replacement-generation-2681",
				GJC_MANAGED_OWNER_RUN_ID: "replacement-run-2681",
				GJC_MANAGED_OWNER_INCARNATION: "replacement-incarnation-2681",
				GJC_MANAGED_OWNER_PREDECESSOR_TOKEN: predecessorToken,
				GJC_MANAGED_OWNER_PREDECESSOR_GENERATION: "generation-2681",
				GJC_MANAGED_OWNER_PREDECESSOR_RUN_ID: "run-2681",
				GJC_MANAGED_OWNER_PREDECESSOR_INCARNATION: "incarnation-2681",
				GJC_MANAGED_OWNER_TRANSCRIPT_PATH: transcript,
			});
			expect(replacement.exitCode).toBe(75);
			expect(replacement.stdout).toContain('"kind":"handoff"');
			const handoffFile = (await fs.readdir(root)).find(
				file => file.startsWith("admission-handoff-") && file.endsWith(".json"),
			);
			expect(handoffFile).toBeDefined();
			expect(JSON.parse(await fs.readFile(path.join(root, handoffFile!), "utf8"))).toMatchObject({
				state: "fail_closed_handoff",
				reason: "safe_session_resume_seam_unavailable",
			});
		} finally {
			await fs.rm(stateDir, { recursive: true, force: true });
			await fs.rm(cwd, { recursive: true, force: true });
		}
	});
});
