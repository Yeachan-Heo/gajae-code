import { describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { Args } from "@gajae-code/coding-agent/cli/args";
import { launchDefaultTmuxIfNeeded } from "@gajae-code/coding-agent/gjc-runtime/launch-tmux";
import {
	trustedManagedOwnerLaunchSessionFile,
	trustedManagedOwnerTranscriptPath,
} from "@gajae-code/coding-agent/gjc-runtime/managed-owner-admission";
import { sessionStateDir, sessionUltragoalDir } from "@gajae-code/coding-agent/gjc-runtime/session-layout";
import {
	lifecyclePaths,
	type OwnerIsolationProbeSync,
} from "@gajae-code/coding-agent/gjc-runtime/tmux-owner-isolation";

const recoveryReads = process.platform === "linux";
const sessionId = "session-2681";
const canary = "FORGED-TERMINAL-CANARY";
const admissionModule = path.join(import.meta.dir, "..", "..", "src", "gjc-runtime", "managed-owner-admission.ts");
const transcriptBody =
	`{"id":"one","parentId":null,"type":"message"}\n` +
	`{"id":"two","parentId":"one","type":"yield","result":{"status":"success","note":"${canary}"}}\n` +
	`{"id":"three","parentId":"two","type":"toolResult","toolCallId":"two","content":[]}\n`;

function args(overrides: Partial<Args> = {}): Args {
	return { messages: [], fileArgs: [], unknownFlags: new Map(), ...overrides };
}

async function tempProject(): Promise<string> {
	return await fsp.mkdtemp(path.join(os.tmpdir(), "gjc-owner-transcript-"));
}

describe("managed owner transcript provenance", () => {
	it("keeps an operator transcript path the project does not declare", async () => {
		const cwd = await tempProject();
		try {
			await fsp.writeFile(path.join(cwd, ".env"), "UNRELATED=1\n");
			expect(trustedManagedOwnerTranscriptPath({ GJC_MANAGED_OWNER_TRANSCRIPT_PATH: "operator.jsonl" }, cwd)).toBe(
				"operator.jsonl",
			);
			expect(trustedManagedOwnerLaunchSessionFile({ GJC_SESSION_FILE: "operator.jsonl" }, cwd)).toBe(
				"operator.jsonl",
			);
			expect(trustedManagedOwnerTranscriptPath({ GJC_MANAGED_OWNER_TRANSCRIPT_PATH: "operator.jsonl " }, cwd)).toBe(
				"operator.jsonl ",
			);
			expect(trustedManagedOwnerLaunchSessionFile({ GJC_SESSION_FILE: "operator.jsonl " }, cwd)).toBe(
				"operator.jsonl ",
			);
		} finally {
			await fsp.rm(cwd, { recursive: true, force: true });
		}
	});

	it("drops a project dotenv transcript path, including comments, quotes, and dynamic declarations", async () => {
		const cwd = await tempProject();
		try {
			await fsp.writeFile(path.join(cwd, ".env"), 'GJC_MANAGED_OWNER_TRANSCRIPT_PATH="predecessor.jsonl" # note\n');
			expect(
				trustedManagedOwnerTranscriptPath({ GJC_MANAGED_OWNER_TRANSCRIPT_PATH: "predecessor.jsonl" }, cwd),
			).toBe("");
			await fsp.writeFile(path.join(cwd, ".env"), "GJC_MANAGED_OWNER_TRANSCRIPT_PATH=$(printf predecessor.jsonl)\n");
			expect(
				trustedManagedOwnerTranscriptPath({ GJC_MANAGED_OWNER_TRANSCRIPT_PATH: "predecessor.jsonl" }, cwd),
			).toBe("");
			await fsp.writeFile(path.join(cwd, ".env"), "GJC_SESSION_FILE=predecessor.jsonl\n");
			expect(
				trustedManagedOwnerTranscriptPath({ GJC_MANAGED_OWNER_TRANSCRIPT_PATH: "predecessor.jsonl" }, cwd),
			).toBe("");
			expect(trustedManagedOwnerLaunchSessionFile({ GJC_SESSION_FILE: "predecessor.jsonl" }, cwd)).toBe("");
			await fsp.writeFile(path.join(cwd, ".env"), "GJC_SESSION_FILE=`printf predecessor.jsonl`\n");
			expect(trustedManagedOwnerLaunchSessionFile({ GJC_SESSION_FILE: "predecessor.jsonl" }, cwd)).toBe("");
		} finally {
			await fsp.rm(cwd, { recursive: true, force: true });
		}
	});
});

describe.skipIf(!recoveryReads)("managed owner transcript provenance through admission and launch", () => {
	it("admitManagedOwnerBeforeCli ignores a project transcript and still accepts an operator path", async () => {
		const stateDir = await fsp.mkdtemp(path.join(os.tmpdir(), "gjc-owner-admit-"));
		const cwd = await tempProject();
		try {
			await writePredecessor(stateDir);
			await writeTerminal(cwd);
			await fsp.writeFile(path.join(cwd, ".env"), "GJC_MANAGED_OWNER_TRANSCRIPT_PATH=predecessor.jsonl\n");
			const forged = await admit(stateDir, cwd, {});
			expect(forged.stderr).toContain("child admission blocked: transcript_path_untrusted");
			expect(forged.result).toEqual({ kind: "blocked", exitCode: 75 });
			expect(await journal(cwd)).not.toContain(canary);
			await fsp.rm(path.join(cwd, ".env"), { force: true });
			await removeJournal(cwd);
			const operator = await admit(stateDir, cwd, {
				GJC_MANAGED_OWNER_TRANSCRIPT_PATH: "predecessor.jsonl",
			});
			expect(operator.result).toEqual({ kind: "handoff", exitCode: 75 });
			expect(operator.handoffs).toContainEqual(
				expect.objectContaining({ reason: "safe_session_resume_seam_unavailable" }),
			);
		} finally {
			await fsp.rm(stateDir, { recursive: true, force: true });
			await fsp.rm(cwd, { recursive: true, force: true });
		}
	});

	it("admitManagedOwnerBeforeCli ignores a transcript copied from the project session file", async () => {
		const stateDir = await fsp.mkdtemp(path.join(os.tmpdir(), "gjc-owner-admit-alias-"));
		const cwd = await tempProject();
		try {
			await writePredecessor(stateDir);
			await writeTerminal(cwd);
			await fsp.writeFile(path.join(cwd, ".env"), "GJC_SESSION_FILE=predecessor.jsonl\n");
			const forged = await admit(stateDir, cwd, {
				GJC_MANAGED_OWNER_TRANSCRIPT_PATH: "predecessor.jsonl",
			});
			expect(forged.stderr).toContain("child admission blocked: transcript_path_untrusted");
			expect(forged.result.kind).toBe("blocked");
			expect(await journal(cwd)).not.toContain(canary);
			await fsp.writeFile(path.join(cwd, ".env"), "GJC_SESSION_FILE=other.jsonl\n");
			await removeJournal(cwd);
			const operator = await admit(stateDir, cwd, {
				GJC_MANAGED_OWNER_TRANSCRIPT_PATH: "predecessor.jsonl",
			});
			expect(operator.result).toEqual({ kind: "handoff", exitCode: 75 });
			expect(operator.handoffs).toContainEqual(
				expect.objectContaining({ reason: "safe_session_resume_seam_unavailable" }),
			);
		} finally {
			await fsp.rm(stateDir, { recursive: true, force: true });
			await fsp.rm(cwd, { recursive: true, force: true });
		}
	});

	it("completeManagedOwnerRecovery rejects a transcript declared after admission and still accepts an operator path", async () => {
		const stateDir = await fsp.mkdtemp(path.join(os.tmpdir(), "gjc-owner-complete-"));
		const cwd = await tempProject();
		try {
			await writePredecessor(stateDir);
			await writeTerminal(cwd);
			const changed = await admit(stateDir, cwd, { GJC_MANAGED_OWNER_TRANSCRIPT_PATH: "predecessor.jsonl" }, true);
			expect(changed.result).toEqual({ kind: "handoff", exitCode: 75 });
			expect(changed.handoffs).toContainEqual(
				expect.objectContaining({ reason: "recovery_authority_changed:transcript_path_untrusted" }),
			);
			await fsp.rm(path.join(cwd, ".env"), { force: true });
			await removeJournal(cwd);
			const operator = await admit(stateDir, cwd, { GJC_MANAGED_OWNER_TRANSCRIPT_PATH: "predecessor.jsonl" });
			expect(operator.result).toEqual({ kind: "handoff", exitCode: 75 });
			expect(operator.handoffs).toContainEqual(
				expect.objectContaining({ reason: "safe_session_resume_seam_unavailable" }),
			);
		} finally {
			await fsp.rm(stateDir, { recursive: true, force: true });
			await fsp.rm(cwd, { recursive: true, force: true });
		}
	});

	it("launchDefaultTmuxIfNeeded does not forward a project session file and still forwards an operator file", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-owner-launch-"));
		try {
			fs.writeFileSync(path.join(root, ".env"), "GJC_SESSION_FILE=predecessor.jsonl\n");
			const forged = launchReplacement(root, { GJC_SESSION_FILE: "predecessor.jsonl" });
			expect(forged).not.toContain("GJC_MANAGED_OWNER_TRANSCRIPT_PATH='predecessor.jsonl'");
			fs.rmSync(path.join(root, ".env"));
			const operator = launchReplacement(root, { GJC_SESSION_FILE: "operator.jsonl" });
			expect(operator).toContain("GJC_MANAGED_OWNER_TRANSCRIPT_PATH='operator.jsonl'");
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});
});

async function journal(cwd: string): Promise<string> {
	return await fsp.readFile(path.join(sessionStateDir(cwd, sessionId), "ultragoal-owner-loss-recovery.jsonl"), "utf8");
}

async function removeJournal(cwd: string): Promise<void> {
	await fsp.rm(path.join(sessionStateDir(cwd, sessionId), "ultragoal-owner-loss-recovery.jsonl"), { force: true });
}

async function writeTerminal(cwd: string): Promise<void> {
	const ultragoal = sessionUltragoalDir(cwd, sessionId);
	await fsp.mkdir(ultragoal, { recursive: true });
	await fsp.writeFile(path.join(ultragoal, "goals.json"), '{"goals":[]}');
	await fsp.writeFile(path.join(ultragoal, "ledger.jsonl"), '{"event":"started"}\n');
	await fsp.writeFile(path.join(cwd, "predecessor.jsonl"), transcriptBody);
}

async function writePredecessor(stateDir: string): Promise<void> {
	const root = lifecyclePaths(stateDir, sessionId, "generation-2681").root;
	await fsp.mkdir(root, { recursive: true, mode: 0o700 });
	const command = ["gjc", "--resume"];
	const commandSha256 = createHash("sha256").update(JSON.stringify(command)).digest("hex");
	const token = "predecessor";
	await fsp.writeFile(
		path.join(root, `child-${token}.binding.json`),
		`${JSON.stringify({
			schema_version: 3,
			binding_kind: "recoverable",
			generation: "generation-2681",
			session_id: sessionId,
			run_id: "run-2681",
			endpoint_incarnation: "incarnation-2681",
			child_token: token,
			command,
			command_sha256: commandSha256,
			supervisor_pid: 1,
			supervisor_start_time: "1",
			created_at: "2026-07-19T00:00:00.000Z",
		})}\n`,
		{ mode: 0o600 },
	);
	await fsp.writeFile(
		path.join(root, `sigabrt-${token}.receipt.json`),
		`${JSON.stringify({
			schema_version: 2,
			generation: "generation-2681",
			session_id: sessionId,
			run_id: "run-2681",
			endpoint_incarnation: "incarnation-2681",
			child_token: token,
			command_sha256: commandSha256,
			supervisor_pid: 1,
			supervisor_start_time: "1",
			child_pid: 2,
			child_start_time: "2",
			signal: "SIGABRT",
			signal_number: 6,
			exit_code: null,
			received_at: "2026-07-19T00:00:00.000Z",
		})}\n`,
		{ mode: 0o600 },
	);
}

async function admit(
	stateDir: string,
	cwd: string,
	extra: Record<string, string>,
	declareTranscriptBeforeComplete = false,
): Promise<{ result: { kind: string; exitCode: number }; stderr: string; handoffs: Record<string, unknown>[] }> {
	const script = `import { writeFile } from "node:fs/promises"; import { admitManagedOwnerBeforeCli, completeManagedOwnerRecovery } from ${JSON.stringify(admissionModule)}; const admission = await admitManagedOwnerBeforeCli(); if (${declareTranscriptBeforeComplete} && admission.kind === "recovery") await writeFile(".env", "GJC_MANAGED_OWNER_TRANSCRIPT_PATH=predecessor.jsonl\\n"); const terminal = admission.kind === "recovery" ? await completeManagedOwnerRecovery(admission.context) : admission; console.log(JSON.stringify({ kind: terminal.kind, exitCode: process.exitCode ?? 0 }));`;
	const env: NodeJS.ProcessEnv = { ...process.env };
	delete env.GJC_SESSION_FILE;
	delete env.GJC_MANAGED_OWNER_TRANSCRIPT_PATH;
	for (const [key, value] of Object.entries(extra)) env[key] = value;
	const child = Bun.spawn({
		cmd: [process.execPath, "--no-env-file", "-e", script],
		cwd,
		stdout: "pipe",
		stderr: "pipe",
		env: {
			...env,
			GJC_TMUX_OWNER_STATE_DIR: stateDir,
			GJC_COORDINATOR_SESSION_ID: sessionId,
			GJC_TMUX_OWNER_GENERATION: "replacement-generation-2681",
			GJC_MANAGED_OWNER_RUN_ID: "replacement-run-2681",
			GJC_MANAGED_OWNER_INCARNATION: "replacement-incarnation-2681",
			GJC_MANAGED_OWNER_CHILD_TOKEN: "replacement-child-token",
			GJC_MANAGED_OWNER_PREDECESSOR_TOKEN: "predecessor",
			GJC_MANAGED_OWNER_PREDECESSOR_GENERATION: "generation-2681",
			GJC_MANAGED_OWNER_PREDECESSOR_RUN_ID: "run-2681",
			GJC_MANAGED_OWNER_PREDECESSOR_INCARNATION: "incarnation-2681",
		},
	});
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
		child.exited,
	]);
	if (!stdout.trim()) throw new Error(stderr || `admission child exited ${exitCode} with no output`);
	const root = lifecyclePaths(stateDir, sessionId, "generation-2681").root;
	const handoffFiles = (await fsp.readdir(root)).filter(file => file.startsWith("admission-handoff-"));
	const handoffs = await Promise.all(
		handoffFiles.map(
			async file => JSON.parse(await fsp.readFile(path.join(root, file), "utf8")) as Record<string, unknown>,
		),
	);
	return {
		result: { ...(JSON.parse(stdout) as { kind: string; exitCode: number }), exitCode },
		stderr,
		handoffs,
	};
}

function absentThenSafeOwnerProbe(): OwnerIsolationProbeSync {
	let serverCreated = false;
	return {
		readCallerCgroup: () => "0::/user.slice/user-1000.slice/user@1000.service/app.slice/gjc.scope\n",
		probeServer: () => {
			if (!serverCreated) {
				serverCreated = true;
				return { state: "absent" };
			}
			return {
				state: "safe",
				pid: 123,
				startTime: "42",
				cgroup: { classification: "safe" },
			};
		},
		recordAttempt: () => {},
	};
}

function launchReplacement(root: string, sessionEnv: Record<string, string>): string {
	const sessionName = "replacement-session";
	fs.rmSync(path.join(root, sessionName), { recursive: true, force: true });
	const supervisorPid = process.pid;
	const supervisorStat = fs.readFileSync(`/proc/${supervisorPid}/stat`, "utf8");
	const supervisorStartTime = supervisorStat
		.slice(supervisorStat.lastIndexOf(")") + 1)
		.trim()
		.split(/\s+/)[19]!;
	const generation = "replacement-generation";
	const runId = "replacement-run";
	const incarnation = "replacement-incarnation";
	const predecessorToken = "exact-predecessor";
	const ownerRoot = lifecyclePaths(root, sessionName, generation).root;
	fs.mkdirSync(ownerRoot, { recursive: true, mode: 0o700 });
	fs.writeFileSync(
		lifecyclePaths(root, sessionName, generation).generationFile,
		`${JSON.stringify({ schema_version: 1, generation, session_id: sessionName, published_at: "2026-07-19T00:00:00.000Z" })}\n`,
	);
	const command = ["gjc", "--resume"];
	const commandSha256 = createHash("sha256").update(JSON.stringify(command)).digest("hex");
	fs.writeFileSync(
		path.join(ownerRoot, `child-${predecessorToken}.binding.json`),
		`${JSON.stringify({ schema_version: 3, binding_kind: "recoverable", generation, session_id: sessionName, run_id: runId, endpoint_incarnation: incarnation, child_token: predecessorToken, command, command_sha256: commandSha256, supervisor_pid: supervisorPid, supervisor_start_time: supervisorStartTime, created_at: "2026-07-19T00:00:00.000Z" })}\n`,
		{ mode: 0o600 },
	);
	fs.writeFileSync(
		path.join(ownerRoot, `sigabrt-${predecessorToken}.receipt.json`),
		`${JSON.stringify({ schema_version: 2, generation, session_id: sessionName, run_id: runId, endpoint_incarnation: incarnation, child_token: predecessorToken, command_sha256: commandSha256, supervisor_pid: supervisorPid, supervisor_start_time: supervisorStartTime, child_pid: 2, child_start_time: "2", signal: "SIGABRT", signal_number: 6, exit_code: null, received_at: "2026-07-19T00:00:00.000Z" })}\n`,
		{ mode: 0o600 },
	);
	const calls: string[][] = [];
	const handled = launchDefaultTmuxIfNeeded({
		parsed: args({ messages: ["hello"], tmux: true }),
		rawArgs: ["--tmux", "hello"],
		cwd: root,
		env: {
			GJC_COORDINATOR_SESSION_ID: sessionName,
			GJC_COORDINATOR_SESSION_STATE_FILE: path.join(root, "runtime-state.json"),
			GJC_TMUX_OWNER_STATE_DIR: root,
			...sessionEnv,
		},
		argv: ["bun", "cli.ts"],
		execPath: "/bin/bun",
		platform: "linux",
		tty: { stdin: true, stdout: true },
		tmuxAvailable: true,
		existingBranchSessionName: null,
		ownerIsolationProbe: absentThenSafeOwnerProbe(),
		spawnSync: (_command, spawnArgs) => {
			calls.push(spawnArgs);
			return { exitCode: 0, stdout: "$0" };
		},
	});
	expect(handled).toBe(true);
	const innerCommand = calls.find(call => call[0] === "new-session")?.at(-1);
	expect(innerCommand).toBeString();
	return innerCommand!;
}
