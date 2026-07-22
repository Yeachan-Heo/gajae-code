import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { sessionUltragoalDir } from "@gajae-code/coding-agent/gjc-runtime/session-layout";
import { lifecyclePaths } from "@gajae-code/coding-agent/gjc-runtime/tmux-owner-isolation";

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

async function runSupervisor(
	stateDir: string,
	command: string[],
	env: Record<string, string> = {},
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
	const script = `import { runManagedOwnerSupervisor } from ${JSON.stringify(supervisorModule)}; await runManagedOwnerSupervisor();`;
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
			GJC_MANAGED_OWNER_COMMAND_JSON: JSON.stringify(command),
			...env,
		},
	});
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
		child.exited,
	]);
	return { exitCode, stdout, stderr };
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

	it("does not mint a SIGABRT receipt for a normally exiting child", async () => {
		const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-managed-owner-"));
		try {
			const result = await runSupervisor(stateDir, [process.execPath, "-e", "process.exit(23)"]);
			expect(result.exitCode).toBe(23);
			const root = lifecyclePaths(stateDir, "session-2681", "generation-2681").root;
			expect((await fs.readdir(root)).some(file => file.startsWith("sigabrt-"))).toBe(false);
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
