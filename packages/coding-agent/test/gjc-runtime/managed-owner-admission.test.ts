import { describe, expect, it } from "bun:test";
import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	isManagedOwnerBinding,
	isManagedOwnerSigabrtReceipt,
	type ManagedOwnerRecoverableBinding,
} from "@gajae-code/coding-agent/gjc-runtime/managed-owner-binding";
import { sessionUltragoalDir } from "@gajae-code/coding-agent/gjc-runtime/session-layout";
import { lifecyclePaths, readSecureOwnerJson } from "@gajae-code/coding-agent/gjc-runtime/tmux-owner-isolation";

const repoRoot = path.resolve(import.meta.dir, "..", "..", "..", "..");
const admissionModule = path.join(
	repoRoot,
	"packages",
	"coding-agent",
	"src",
	"gjc-runtime",
	"managed-owner-admission.ts",
);
const managedOwnerEnvironmentKeys = [
	"GJC_TMUX_OWNER_STATE_DIR",
	"GJC_COORDINATOR_SESSION_ID",
	"GJC_TMUX_OWNER_GENERATION",
	"GJC_MANAGED_OWNER_RUN_ID",
	"GJC_MANAGED_OWNER_INCARNATION",
	"GJC_MANAGED_OWNER_CHILD_TOKEN",
	"GJC_MANAGED_OWNER_PREDECESSOR_TOKEN",
	"GJC_MANAGED_OWNER_PREDECESSOR_GENERATION",
	"GJC_MANAGED_OWNER_PREDECESSOR_RUN_ID",
	"GJC_MANAGED_OWNER_PREDECESSOR_INCARNATION",
	"GJC_MANAGED_OWNER_TRANSCRIPT_PATH",
	"GJC_MANAGED_OWNER_COMMAND_JSON",
	"GJC_MANAGED_OWNER_REDACT_COMMAND",
] as const;

function managedOwnerEnvironment(overrides: Record<string, string> = {}): NodeJS.ProcessEnv {
	const env = { ...process.env };
	for (const name of managedOwnerEnvironmentKeys) delete env[name];
	return { ...env, ...overrides };
}
async function admit(
	stateDir: string,
	token?: string,
): Promise<{ admitted: boolean; exitCode: number; root: string; stderr: string }> {
	const script = `import { admitManagedOwnerBeforeCli } from ${JSON.stringify(admissionModule)}; const admission = await admitManagedOwnerBeforeCli(); console.log(JSON.stringify({ admitted: admission.kind !== "blocked", exitCode: process.exitCode ?? 0 }));`;
	const child = Bun.spawn({
		cmd: [process.execPath, "-e", script],
		cwd: repoRoot,
		stdout: "pipe",
		stderr: "pipe",
		env: {
			...managedOwnerEnvironment(),
			GJC_TMUX_OWNER_STATE_DIR: stateDir,
			GJC_COORDINATOR_SESSION_ID: "session-2681",
			GJC_TMUX_OWNER_GENERATION: "generation-2681",
			GJC_MANAGED_OWNER_RUN_ID: "run-2681",
			GJC_MANAGED_OWNER_INCARNATION: "incarnation-2681",
			...(token ? { GJC_MANAGED_OWNER_CHILD_TOKEN: token } : {}),
		},
	});
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
		child.exited,
	]);
	return {
		...(JSON.parse(stdout) as { admitted: boolean; exitCode: number }),
		exitCode,
		stderr,
		root: lifecyclePaths(stateDir, "session-2681", "generation-2681").root,
	};
}

async function writeBinding(root: string, token: string, patch: Record<string, unknown> = {}): Promise<void> {
	await fs.mkdir(root, { recursive: true, mode: 0o700 });
	const command = ["gjc", "--resume"];
	await fs.writeFile(
		path.join(root, `child-${token}.binding.json`),
		`${JSON.stringify({ schema_version: 3, binding_kind: "recoverable", generation: "generation-2681", session_id: "session-2681", run_id: "run-2681", endpoint_incarnation: "incarnation-2681", child_token: token, command, command_sha256: crypto.createHash("sha256").update(JSON.stringify(command)).digest("hex"), supervisor_pid: 1, supervisor_start_time: "1", created_at: new Date().toISOString(), ...patch })}\n`,
		{ mode: 0o600 },
	);
}

it("preserves ordinary admission against eighteen exact framing specimens", async () => {
	const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-admission-framing-"));
	try {
		const root = lifecyclePaths(stateDir, "session-2681", "generation-2681").root;
		const file = path.join(root, "child-framing.binding.json");
		await writeBinding(root, "framing", { binding_kind: "opaque", command: undefined, command_sha256: undefined });
		const json = (await fs.readFile(file, "utf8")).trimEnd();
		const command = ["�"];
		await writeBinding(root, "framing", {
			command,
			command_sha256: crypto.createHash("sha256").update(JSON.stringify(command)).digest("hex"),
		});
		const replacementJson = await fs.readFile(file);
		const replacementAt = replacementJson.indexOf(Buffer.from("�"));
		expect(replacementAt).toBeGreaterThan(0);
		const invalidUtf8String = Buffer.concat([
			replacementJson.subarray(0, replacementAt),
			Buffer.from([255]),
			replacementJson.subarray(replacementAt + 3),
		]);
		const specimens: [string, Uint8Array, boolean, boolean][] = [
			["LF", Buffer.from(`${json}\n`), true, true],
			["no LF", Buffer.from(json), false, false],
			["CRLF", Buffer.from(`${json}\r\n`), false, false],
			["two LFs", Buffer.from(`${json}\n\n`), false, false],
			["embedded LF", Buffer.from(`{\n${json.slice(1)}\n`), false, false],
			["leading LF", Buffer.from(`\n${json}\n`), false, false],
			["embedded CR", Buffer.from(`{\r${json.slice(1)}\n`), false, false],
			["empty", Buffer.alloc(0), false, false],
			["LF only", Buffer.from("\n"), false, false],
			["BOM", Buffer.from(`\ufeff${json}\n`), false, false],
			["invalid UTF8 in bound command", invalidUtf8String, true, true],
			["invalid UTF8 token", Buffer.from([255, 10]), false, false],
			["escaped LF scalar", Buffer.from('"\\n"\n'), true, false],
			["escaped CR scalar", Buffer.from('"\\r"\n'), true, false],
			["horizontal whitespace", Buffer.from(` \t${json} \t\n`), true, true],
			["null", Buffer.from("null\n"), true, false],
			["trailing token", Buffer.from(`${json} true\n`), false, false],
			["duplicate key", Buffer.from(`${json.slice(0, -1)},"binding_kind":"opaque"}\n`), true, true],
		];
		for (const [name, bytes, readable, admitted] of specimens) {
			await fs.writeFile(file, bytes);
			if (readable) expect(readSecureOwnerJson(file), name).toEqual(JSON.parse(Buffer.from(bytes).toString("utf8")));
			else expect(() => readSecureOwnerJson(file), name).toThrow();
			const result = await admit(stateDir, "framing");
			expect(result.admitted, name).toBe(admitted);
			expect(result.exitCode, name).toBe(admitted ? 0 : 75);
			expect(result.stderr, name).not.toContain("framing_invalid");
		}
	} finally {
		await fs.rm(stateDir, { recursive: true, force: true });
	}
}, 30_000);

it("turns ordinary native read failures and exceptions into the same blocked admission", async () => {
	const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-admission-native-failure-"));
	try {
		const root = lifecyclePaths(stateDir, "session-2681", "generation-2681").root;
		await writeBinding(root, "fault");
		for (const fault of ["unavailable", "throw"]) {
			const script = `import { spyOn } from "bun:test";
import * as natives from "@gajae-code/natives";
import { admitManagedOwnerBeforeCli } from ${JSON.stringify(admissionModule)};
const calls = [];
const read = spyOn(natives, "readOwnerOnlyFile").mockImplementation((file, bound) => {
 calls.push([file, bound]);
 if (${JSON.stringify(fault)} === "throw") throw new Error("SECRET-NATIVE-FAILURE");
 return {ok:false, code:"read_failed"};
});
try { const result = await admitManagedOwnerBeforeCli(); console.log(JSON.stringify({kind:result.kind, calls})); }
finally { read.mockRestore(); }`;
			const child = Bun.spawn({
				cmd: [process.execPath, "-e", script],
				cwd: repoRoot,
				stdout: "pipe",
				stderr: "pipe",
				env: managedOwnerEnvironment({
					GJC_TMUX_OWNER_STATE_DIR: stateDir,
					GJC_COORDINATOR_SESSION_ID: "session-2681",
					GJC_TMUX_OWNER_GENERATION: "generation-2681",
					GJC_MANAGED_OWNER_RUN_ID: "run-2681",
					GJC_MANAGED_OWNER_INCARNATION: "incarnation-2681",
					GJC_MANAGED_OWNER_CHILD_TOKEN: "fault",
				}),
			});
			const [stdout, stderr, exit] = await Promise.all([
				new Response(child.stdout).text(),
				new Response(child.stderr).text(),
				child.exited,
			]);
			expect(JSON.parse(stdout)).toEqual({
				kind: "blocked",
				calls: [[path.join(root, "child-fault.binding.json"), 65536]],
			});
			expect(exit).toBe(75);
			expect(stderr).not.toContain("SECRET-NATIVE-FAILURE");
		}
	} finally {
		await fs.rm(stateDir, { recursive: true, force: true });
	}
});

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
			...managedOwnerEnvironment(),
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
		{ mode: 0o600 },
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
	it("preserves whitespace-only recoverable arguments and validates the digest of the original array", async () => {
		const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-managed-whitespace-"));
		try {
			const root = lifecyclePaths(stateDir, "session-2681", "generation-2681").root;
			for (const argument of [" ", "\t"]) {
				const command = ["/usr/bin/printf", "%s", argument];
				const command_sha256 = crypto.createHash("sha256").update(JSON.stringify(command)).digest("hex");
				await writeBinding(root, "whitespace", { command, command_sha256 });
				const binding = JSON.parse(await fs.readFile(path.join(root, "child-whitespace.binding.json"), "utf8"));
				expect(isManagedOwnerBinding(binding)).toBe(true);
				expect(binding.command).toEqual(command);
				expect(binding.command_sha256).toBe(command_sha256);
				expect((await admit(stateDir, "whitespace")).admitted).toBe(true);
				const trimmedDigest = crypto
					.createHash("sha256")
					.update(JSON.stringify(command.map(value => value.trim())))
					.digest("hex");
				expect(isManagedOwnerBinding({ ...binding, command_sha256: trimmedDigest })).toBe(false);
				for (const invalid of ["", "\0", "before\0after", 1, null]) {
					const invalidCommand = [command[0], command[1], invalid];
					expect(
						isManagedOwnerBinding({
							...binding,
							command: invalidCommand,
							command_sha256: crypto.createHash("sha256").update(JSON.stringify(invalidCommand)).digest("hex"),
						}),
					).toBe(false);
				}
				for (const key of [
					"generation",
					"session_id",
					"run_id",
					"endpoint_incarnation",
					"child_token",
					"supervisor_start_time",
				])
					expect(isManagedOwnerBinding({ ...binding, [key]: argument })).toBe(false);
			}
		} finally {
			await fs.rm(stateDir, { recursive: true, force: true });
		}
	});

	it("admits closed opaque bindings without command evidence and rejects mixed fields", async () => {
		const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-managed-opaque-"));
		try {
			const root = lifecyclePaths(stateDir, "session-2681", "generation-2681").root;
			await writeBinding(root, "opaque", { binding_kind: "opaque", command: undefined, command_sha256: undefined });
			expect((await admit(stateDir, "opaque")).admitted).toBe(true);
			for (const patch of [
				{ command: ["SECRET-COMMAND-CANARY"] },
				{ command_sha256: "a".repeat(64) },
				{ fingerprint: "secret" },
			]) {
				await writeBinding(root, "opaque", {
					binding_kind: "opaque",
					command: undefined,
					command_sha256: undefined,
					...patch,
				});
				const result = await admit(stateDir, "opaque");
				expect(result.admitted).toBe(false);
				expect(result.exitCode).toBe(75);
				expect(result.stderr).not.toContain("SECRET-COMMAND-CANARY");
			}
		} finally {
			await fs.rm(stateDir, { recursive: true, force: true });
		}
	});

	it("uses exact closed receipts and rejects every changed identity or malformed provenance", () => {
		const command = ["gjc", "--resume"];
		const binding: ManagedOwnerRecoverableBinding = {
			schema_version: 3,
			binding_kind: "recoverable",
			generation: "g",
			session_id: "s",
			run_id: "r",
			endpoint_incarnation: "i",
			child_token: "t",
			command,
			command_sha256: crypto.createHash("sha256").update(JSON.stringify(command)).digest("hex"),
			supervisor_pid: 10,
			supervisor_start_time: "123",
			created_at: "2026-09-08T01:00:00.000Z",
		};
		const receipt = {
			schema_version: 2,
			generation: "g",
			session_id: "s",
			run_id: "r",
			endpoint_incarnation: "i",
			child_token: "t",
			command_sha256: binding.command_sha256,
			supervisor_pid: 10,
			supervisor_start_time: "123",
			child_pid: 11,
			child_start_time: "124",
			signal: "SIGABRT",
			signal_number: 6,
			exit_code: null,
			received_at: binding.created_at,
		};
		expect(isManagedOwnerBinding(binding)).toBe(true);
		expect(isManagedOwnerSigabrtReceipt(receipt, binding)).toBe(true);
		for (const key of [
			"generation",
			"session_id",
			"run_id",
			"endpoint_incarnation",
			"child_token",
			"command_sha256",
			"supervisor_start_time",
		]) {
			expect(isManagedOwnerSigabrtReceipt({ ...receipt, [key]: "wrong" }, binding)).toBe(false);
		}
		for (const patch of [
			{ schema_version: 3 },
			{ extra: true },
			{ supervisor_pid: 12 },
			{ child_pid: 0 },
			{ child_pid: 1.5 },
			{ child_start_time: "" },
			{ signal: "EXIT", exit_code: 134 },
			{ signal_number: 134 },
			{ received_at: "2026-02-30T00:00:00Z" },
			{ received_at: "" },
		])
			expect(isManagedOwnerSigabrtReceipt({ ...receipt, ...patch }, binding)).toBe(false);
		for (const key of Object.keys(binding)) {
			const incomplete: Record<string, unknown> = { ...binding };
			delete incomplete[key];
			expect(isManagedOwnerBinding(incomplete)).toBe(false);
		}
	});

	it("denies token-only and partial predecessor environments without throwing or admitting CLI", async () => {
		for (const metadata of [
			{ GJC_MANAGED_OWNER_CHILD_TOKEN: "token-only" },
			{ GJC_MANAGED_OWNER_PREDECESSOR_TOKEN: "predecessor-only" },
			{ GJC_MANAGED_OWNER_CHILD_TOKEN: "" },
			{ GJC_MANAGED_OWNER_PREDECESSOR_RUN_ID: "partial" },
		] as Record<string, string>[]) {
			const script = `import { admitManagedOwnerBeforeCli } from ${JSON.stringify(admissionModule)}; const result = await admitManagedOwnerBeforeCli(); console.log(result.kind);`;
			const child = Bun.spawn({
				cmd: [process.execPath, "-e", script],
				cwd: repoRoot,
				stdout: "pipe",
				stderr: "pipe",
				env: managedOwnerEnvironment(metadata),
			});
			const [stdout, stderr, exit] = await Promise.all([
				new Response(child.stdout).text(),
				new Response(child.stderr).text(),
				child.exited,
			]);
			expect(stdout).toBe("blocked\n");
			expect(exit).toBe(75);
			expect(stderr).toBe("managed_owner_admission_blocked: handoff_not_persisted\n");
		}
	});

	it("never writes handoffs through missing, public, root-symlink or ancestor-symlink destinations", async () => {
		const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-managed-unsafe-"));
		const outside = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-managed-outside-"));
		try {
			await fs.writeFile(path.join(outside, "sentinel"), "unchanged");
			const root = lifecyclePaths(stateDir, "session-2681", "generation-2681").root;
			const missing = await admit(stateDir, "missing");
			expect(missing.exitCode).toBe(75);
			expect(await fs.readdir(stateDir)).toEqual([]);
			await fs.mkdir(path.dirname(root), { mode: 0o700 });
			await fs.symlink(outside, root);
			const linked = await admit(stateDir, "missing");
			expect(linked.admitted).toBe(false);
			expect(linked.exitCode).toBe(75);
			expect(linked.stderr).toBe("managed_owner_admission_blocked: handoff_not_persisted\n");
			await fs.unlink(root);
			await fs.mkdir(root, { mode: 0o755 });
			const publicRoot = await admit(stateDir, "missing");
			expect(publicRoot.exitCode).toBe(75);
			expect(await fs.readdir(root)).toEqual([]);
			await fs.rm(path.dirname(root), { recursive: true });
			await fs.symlink(outside, path.dirname(root));
			expect((await admit(stateDir, "missing")).exitCode).toBe(75);
			expect(await fs.readdir(outside)).toEqual(["sentinel"]);
			expect(await fs.readFile(path.join(outside, "sentinel"), "utf8")).toBe("unchanged");
		} finally {
			await fs.rm(stateDir, { recursive: true, force: true });
			await fs.rm(outside, { recursive: true, force: true });
		}
	});

	it.skipIf(process.platform !== "linux")(
		"keeps denial established when retained diagnostic creation or sync throws",
		async () => {
			const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-managed-denial-fault-"));
			try {
				const root = lifecyclePaths(stateDir, "session-2681", "generation-2681").root;
				await fs.mkdir(root, { recursive: true, mode: 0o700 });
				for (const method of ["create", "fsync"]) {
					const script = `import { spyOn } from "bun:test"; import { RecoveryFsRoot } from "@gajae-code/natives"; import { admitManagedOwnerBeforeCli } from ${JSON.stringify(admissionModule)};
				let observedExit; const fault = spyOn(RecoveryFsRoot.prototype, ${JSON.stringify(method)}).mockImplementation(() => { observedExit = process.exitCode; throw new Error("SECRET-DIAGNOSTIC-FAULT"); });
				try { const result = await admitManagedOwnerBeforeCli(); console.log(JSON.stringify({kind: result.kind, observedExit})); } finally { fault.mockRestore(); }`;
					const child = Bun.spawn({
						cmd: [process.execPath, "-e", script],
						cwd: repoRoot,
						stdout: "pipe",
						stderr: "pipe",
						env: managedOwnerEnvironment({
							GJC_TMUX_OWNER_STATE_DIR: stateDir,
							GJC_COORDINATOR_SESSION_ID: "session-2681",
							GJC_TMUX_OWNER_GENERATION: "generation-2681",
							GJC_MANAGED_OWNER_RUN_ID: "run-2681",
							GJC_MANAGED_OWNER_INCARNATION: "incarnation-2681",
							GJC_MANAGED_OWNER_CHILD_TOKEN: "missing",
						}),
					});
					const [stdout, stderr, exit] = await Promise.all([
						new Response(child.stdout).text(),
						new Response(child.stderr).text(),
						child.exited,
					]);
					expect(exit).toBe(75);
					expect(JSON.parse(stdout)).toEqual({ kind: "blocked", observedExit: 75 });
					expect(stderr).toBe("managed_owner_admission_blocked: handoff_not_persisted\n");
				}
			} finally {
				await fs.rm(stateDir, { recursive: true, force: true });
			}
		},
	);

	it("treats a coordinator session ID alone as fresh while rejecting partial owner metadata", async () => {
		const script = `import { admitManagedOwnerBeforeCli } from ${JSON.stringify(admissionModule)}; const admission = await admitManagedOwnerBeforeCli(); console.log(JSON.stringify({ kind: admission.kind }));`;
		const fresh = Bun.spawn({
			cmd: [process.execPath, "-e", script],
			cwd: repoRoot,
			stdout: "pipe",
			stderr: "pipe",
			env: managedOwnerEnvironment({ GJC_COORDINATOR_SESSION_ID: "ordinary-coordinator-session" }),
		});
		const [freshStdout, freshExitCode] = await Promise.all([new Response(fresh.stdout).text(), fresh.exited]);
		expect(freshExitCode).toBe(0);
		expect(JSON.parse(freshStdout)).toEqual({ kind: "fresh" });

		const partial = Bun.spawn({
			cmd: [process.execPath, "-e", script],
			cwd: repoRoot,
			stdout: "pipe",
			stderr: "pipe",
			env: managedOwnerEnvironment({
				GJC_COORDINATOR_SESSION_ID: "ordinary-coordinator-session",
				GJC_TMUX_OWNER_GENERATION: "partial-generation",
			}),
		});
		const [partialStderr, partialExitCode] = await Promise.all([new Response(partial.stderr).text(), partial.exited]);
		expect(partialExitCode).toBe(75);
		expect(partialStderr).toBe("managed_owner_admission_blocked: handoff_not_persisted\n");
	});
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
				{ run_id: "other-run" },
				{ endpoint_incarnation: "other-incarnation" },
				{ schema_version: 2 },
				{ binding_kind: "unknown" },
				{ supervisor_pid: 0 },
				{ supervisor_pid: 1.5 },
				{ supervisor_start_time: "" },
				{ created_at: "2026-02-30T00:00:00.000Z" },
				{ extra: true },
				{ command_sha256: "0".repeat(64) },
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
			await fs.mkdir(root, { recursive: true, mode: 0o700 });
			for (const token of [undefined, "../escaped", "corrupt"]) {
				if (token === "corrupt") await fs.writeFile(path.join(root, "child-corrupt.binding.json"), "{bad json\n");
				const rejected = await admit(stateDir, token);
				expect(rejected.admitted).toBe(false);
				expect(rejected.exitCode).toBe(75);
			}
			const handoffs = (await fs.readdir(root)).filter(file => file.startsWith("admission-handoff-"));
			if (process.platform !== "linux") {
				expect(handoffs).toHaveLength(0);
				return;
			}
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

	it("rejects opaque predecessor bindings even beside an exact-looking SIGABRT receipt", async () => {
		const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-managed-opaque-predecessor-"));
		try {
			const root = lifecyclePaths(stateDir, "session-2681", "generation-2681").root;
			await writeBinding(root, "predecessor", {
				binding_kind: "opaque",
				command: undefined,
				command_sha256: undefined,
			});
			await writeSigabrtReceipt(root, "predecessor");
			expect(await recover(stateDir, repoRoot, "predecessor", "")).toEqual({ kind: "blocked", exitCode: 75 });
		} finally {
			await fs.rm(stateDir, { recursive: true, force: true });
		}
	});

	it.skipIf(process.platform === "linux")(
		"does not expand recoverable predecessor admission beyond Linux",
		async () => {
			const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-managed-platform-"));
			try {
				const root = lifecyclePaths(stateDir, "session-2681", "generation-2681").root;
				await writeBinding(root, "predecessor");
				await writeSigabrtReceipt(root, "predecessor");
				expect(await recover(stateDir, repoRoot, "predecessor", "")).toEqual({ kind: "blocked", exitCode: 75 });
				expect((await fs.readdir(root)).filter(file => file.startsWith("admission-handoff-"))).toHaveLength(0);
			} finally {
				await fs.rm(stateDir, { recursive: true, force: true });
			}
		},
	);

	it.skipIf(process.platform !== "linux")(
		"turns a recovery admission into a durable terminal handoff without changing B0 or dirty files",
		async () => {
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
		},
	);
});
