import { Database } from "bun:sqlite";
import { describe, expect, it, spyOn } from "bun:test";
import * as crypto from "node:crypto";
import * as fsSync from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { ManagedOwnerOpaqueBinding } from "@gajae-code/coding-agent/gjc-runtime/managed-owner-binding";
import {
	type AttemptCapability,
	type BootstrapRequest,
	bootstrapTmuxOwnerIsolation,
	captureOwnerGenerationBaselineSync,
	classifyCgroup,
	closeExactTmuxOwner,
	consumeCooperativeOwnerIntent,
	createOwnerIntent,
	executeTmuxOwnerIsolationPlanSync,
	isExactScopedBootstrapSuccessReceipt,
	isOwnerGenerationBaselineCurrentSync,
	isValidOwnerVerdict,
	lifecyclePaths,
	type OwnerIntent,
	observeOwnerTerminal,
	ownerProcessStartTime,
	type PlanRequest,
	parseExactOwnerJson,
	parseOwnerIsolationRequest,
	planTmuxOwnerIsolation,
	planTmuxOwnerIsolationSync,
	readSecureOwnerJson,
	replaceOwnerGeneration,
	replaceOwnerGenerationSync,
	resolveManagedOwnerPredecessorSync,
	TMUX_OWNER_ISOLATION_MAX_LINE_BYTES,
	tmuxOwnerIsolationBootstrapArgv,
} from "@gajae-code/coding-agent/gjc-runtime/tmux-owner-isolation";
import {
	isTmuxOwnerIsolationCliArgv,
	tmuxServerProof,
} from "@gajae-code/coding-agent/gjc-runtime/tmux-owner-isolation-cli";
import * as natives from "@gajae-code/natives";

const repoRoot = path.resolve(import.meta.dir, "..", "..", "..", "..");
const ownerIsolationCliEntry = path.join(repoRoot, "packages", "coding-agent", "src", "cli.ts");
const packagedGjcEntry = path.join(repoRoot, "packages", "coding-agent", "bin", "gjc.js");
const mainEntry = path.join(repoRoot, "packages", "coding-agent", "src", "main.ts");
const ownerIsolationFlag = "--internal-tmux-owner-isolation";
const invalidJsonLineResponse =
	'{"schema_version":1,"ok":false,"code":"scope_unavailable","diagnostic":"invalid_json_line"}\n';

describe("exact owner JSON framing", () => {
	const specimens: [string, Uint8Array, "value" | "framing" | "json", unknown?][] = [
		["object LF", Buffer.from("{}\n"), "value", {}],
		["no LF", Buffer.from("{}"), "framing"],
		["CRLF", Buffer.from("{}\r\n"), "framing"],
		["two terminal LFs", Buffer.from("{}\n\n"), "framing"],
		["embedded LF", Buffer.from("{\n}\n"), "framing"],
		["leading LF", Buffer.from("\n{}\n"), "framing"],
		["embedded CR", Buffer.from("{\r}\n"), "framing"],
		["empty bytes", Buffer.alloc(0), "framing"],
		["LF only", Buffer.from("\n"), "json"],
		["BOM", Buffer.from("\ufeff{}\n"), "json"],
		["invalid UTF8 in string", Uint8Array.from([34, 255, 34, 10]), "value", "�"],
		["invalid UTF8 token", Uint8Array.from([255, 10]), "json"],
		["escaped LF", Buffer.from('"\\n"\n'), "value", "\n"],
		["escaped CR", Buffer.from('"\\r"\n'), "value", "\r"],
		["surrounding horizontal whitespace", Buffer.from(" \t{} \t\n"), "value", {}],
		["null", Buffer.from("null\n"), "value", null],
		["trailing token", Buffer.from("{} true\n"), "json"],
		["duplicate keys", Buffer.from('{"key":1,"key":2}\n'), "value", { key: 2 }],
	];
	it.each(
		specimens.map(([name, bytes, kind, value]) => [name, bytes, kind, value] as const),
	)("preserves native-reader and retained-byte semantics: %s", async (_name, bytes, kind, value) => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-owner-framing-"));
		try {
			const file = path.join(root, "evidence.json");
			await fs.writeFile(file, bytes, { mode: 0o600 });
			const secure = () => readSecureOwnerJson(file);
			const retained = () => parseExactOwnerJson(bytes, "managed_owner_json_framing_invalid");
			if (kind === "value") {
				expect(secure()).toEqual(value);
				expect(retained()).toEqual(value);
			} else if (kind === "framing") {
				expect(secure).toThrow(bytes.length ? "owner_evidence_framing_invalid" : "owner_evidence_unavailable");
				expect(retained).toThrow("managed_owner_json_framing_invalid");
			} else {
				expect(secure).toThrow(SyntaxError);
				expect(retained).toThrow(SyntaxError);
			}
		} finally {
			await fs.rm(root, { recursive: true, force: true });
		}
	});

	it("keeps native failure classification and the 65536-byte bound", () => {
		const read = spyOn(natives, "readOwnerOnlyFile").mockReturnValue({ ok: false, code: "read_failed" });
		try {
			expect(() => readSecureOwnerJson("unavailable")).toThrow("owner_evidence_unavailable");
			expect(read).toHaveBeenCalledWith("unavailable", 65536);
			read.mockImplementation(() => {
				throw new Error("native-thrown");
			});
			expect(() => readSecureOwnerJson("unavailable")).toThrow("native-thrown");
		} finally {
			read.mockRestore();
		}
	});
});

describe("owner intent construction", () => {
	it.each(
		process.platform === "darwin" ? ["kernel_signal", "cooperative_intent"] : ["kernel_signal"],
	)("preserves invalid-record rejection, ordered publication and locked nonces: %s", async mode => {
		const state = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-owner-intent-shape-"));
		const ids: string[] = [];
		try {
			for (const generation of ["invalid", "first", "second"]) {
				const invalid = generation === "invalid";
				await replaceOwnerGeneration(state, "session", generation);
				const paths = lifecyclePaths(state, "session", generation);
				const request = {
					stateDir: state,
					sessionId: "session",
					generation,
					serverKey: "socket",
					pid: 10,
					startTime: "start",
					dispatchId: invalid ? "" : `dispatch-${generation}`,
					createdAt: new Date(Date.now() - 10).toISOString(),
					expiresAt: new Date(Date.now() + 5_000).toISOString(),
				};
				const randomUUID = crypto.randomUUID;
				let nonceCalls = 0;
				const nonce = spyOn(crypto, "randomUUID").mockImplementation(() => {
					const contender = new Database(paths.lockDatabaseFile);
					try {
						contender.exec("PRAGMA busy_timeout = 0");
						expect(() => contender.exec("BEGIN IMMEDIATE")).toThrow();
					} finally {
						contender.close();
					}
					const id = randomUUID();
					nonceCalls += 1;
					// Kernel lock tokens precede the intent; cooperative staging nonces follow it.
					if (!invalid && nonceCalls === (mode === "kernel_signal" ? 2 : 1)) ids.push(id);
					return id;
				});
				let signals = 0;
				let proofs = 0;
				let cleanups = 0;
				let verdicts = 0;
				try {
					const closing = closeExactTmuxOwner(request, {
						readStartTime: async () => "start",
						shutdown:
							mode === "kernel_signal"
								? {
										kind: "kernel_signal",
										sendSigterm: async () => {
											signals += 1;
										},
									}
								: {
										kind: "cooperative_intent",
										assertCooperativeOwner: () => {
											proofs += 1;
											expect(nonceCalls).toBe(proofs === 1 ? 1 : 2);
											expect(fsSync.existsSync(paths.intentFile)).toBe(false);
										},
									},
						waitForVerdict: async intent => {
							verdicts += 1;
							const expected = {
								schema_version: 1,
								intent_id: ids[ids.length - 1],
								state: "pending",
								generation,
								session_id: "session",
								server_key: "socket",
								expected_terminal: { signal: "SIGTERM", result: "owner_term_then_session_cleanup" },
								dispatch_id: request.dispatchId,
								created_at: request.createdAt,
								expires_at: request.expiresAt,
							};
							expect(JSON.stringify(intent)).toBe(JSON.stringify(expected));
							expect(await fs.readFile(paths.intentFile, "utf8")).toBe(`${JSON.stringify(expected)}\n`);
							return {
								schema_version: 1,
								generation,
								session_id: "session",
								server_key: "socket",
								observed_at: new Date().toISOString(),
								signal: "SIGTERM",
								exit_code: 0,
								result: "owner_term_then_session_cleanup",
								observer: "raw_monitor",
								classification: "expected_operator_shutdown",
								reason: "test",
								intent_id: intent.intent_id,
								dedupe_key: `owner-loss:session:${generation}`,
							};
						},
						cleanupSession: async () => {
							cleanups += 1;
						},
					});
					if (invalid) {
						await expect(closing).rejects.toThrow(
							mode === "kernel_signal" ? "owner_intent_invalid" : "owner_term_verdict_timeout",
						);
						expect([signals, proofs, cleanups, verdicts]).toEqual([0, 0, 0, 0]);
						for (const suffix of ["", ".cancelled", ".expired", ".consumed"])
							expect(fsSync.existsSync(`${paths.intentFile}${suffix}`)).toBe(false);
						continue;
					}
					await closing;
					expect(nonce).toHaveBeenCalledTimes(2);
					expect(signals).toBe(mode === "kernel_signal" ? 1 : 0);
					expect(proofs).toBe(mode === "cooperative_intent" ? 3 : 0);
					expect(cleanups).toBe(1);
					expect(verdicts).toBe(1);
				} finally {
					nonce.mockRestore();
				}
			}
			expect(ids).toHaveLength(2);
			expect(ids[0]).not.toBe(ids[1]);
		} finally {
			await fs.rm(state, { recursive: true, force: true });
		}
	});
});

describe("closed managed predecessor evidence", () => {
	it.skipIf(process.platform !== "linux")(
		"resolves only one exact recoverable schema-3 binding and schema-2 receipt",
		async () => {
			const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-predecessor-schema-"));
			try {
				const baseline = {
					state: "current",
					schema_version: 1,
					generation: "generation",
					session_id: "session",
					published_at: "2026-09-08T00:00:00.000Z",
				} as const;
				const root = lifecyclePaths(stateDir, "session", "generation").root;
				await fs.mkdir(root, { recursive: true, mode: 0o700 });
				const command = ["gjc", "--resume"];
				const binding = {
					schema_version: 3,
					binding_kind: "recoverable",
					generation: "generation",
					session_id: "session",
					run_id: "run",
					endpoint_incarnation: "incarnation",
					child_token: "token",
					command,
					command_sha256: crypto.createHash("sha256").update(JSON.stringify(command)).digest("hex"),
					supervisor_pid: 1,
					supervisor_start_time: "123",
					created_at: baseline.published_at,
				};
				const receipt = {
					schema_version: 2,
					generation: binding.generation,
					session_id: binding.session_id,
					run_id: binding.run_id,
					endpoint_incarnation: binding.endpoint_incarnation,
					child_token: binding.child_token,
					command_sha256: binding.command_sha256,
					supervisor_pid: binding.supervisor_pid,
					supervisor_start_time: binding.supervisor_start_time,
					child_pid: 2,
					child_start_time: "124",
					signal: "SIGABRT",
					signal_number: 6,
					exit_code: null,
					received_at: baseline.published_at,
				};
				const write = async (name: string, value: object) =>
					fs.writeFile(path.join(root, name), `${JSON.stringify(value)}\n`, { mode: 0o600 });
				await write("child-token.binding.json", binding);
				await write("sigabrt-token.receipt.json", receipt);
				const resolve = () => resolveManagedOwnerPredecessorSync(stateDir, "session", baseline);
				expect(resolve()).toEqual({
					generation: "generation",
					sessionId: "session",
					runId: "run",
					incarnation: "incarnation",
					predecessorToken: "token",
				});
				for (const patch of [
					{ schema_version: 2 },
					{ binding_kind: "opaque", command: undefined, command_sha256: undefined },
					{ binding_kind: "opaque" },
					{ extra: true },
					{ generation: "stale" },
					{ session_id: "other" },
					{ run_id: "other" },
					{ endpoint_incarnation: "other" },
					{ command: ["other"] },
					{ supervisor_pid: 0 },
					{ created_at: "invalid" },
				]) {
					await write("child-token.binding.json", { ...binding, ...patch });
					expect(resolve).toThrow("managed_owner_replacement_evidence_untrusted");
				}
				await write("child-token.binding.json", binding);
				for (const patch of [
					{ child_token: "other" },
					{ child_start_time: "" },
					{ supervisor_start_time: "other" },
					{ signal: "EXIT", exit_code: 134 },
					{ extra: true },
				]) {
					await write("sigabrt-token.receipt.json", { ...receipt, ...patch });
					expect(resolve).toThrow("managed_owner_replacement_evidence_untrusted");
				}
				await write("sigabrt-token.receipt.json", receipt);
				// Unpaired bindings remain discovery-only; a second paired candidate is ambiguous.
				await write("child-second.binding.json", { ...binding, child_token: "second" });
				expect(resolve()?.predecessorToken).toBe("token");
				await write("sigabrt-second.receipt.json", { ...receipt, child_token: "second" });
				expect(resolve).toThrow("managed_owner_replacement_evidence_ambiguous");
			} finally {
				await fs.rm(stateDir, { recursive: true, force: true });
			}
		},
	);
});

describe.skipIf(process.platform !== "darwin")("cooperative owner dispatch commit", () => {
	it("does not publish before final proof and never cancels a post-publication failure", async () => {
		for (const fault of [
			"final-proof",
			"before-rename",
			"after-rename",
			"readback",
			"release",
			"generation",
			"expired",
			"mismatched-verdict",
		]) {
			const state = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-cooperative-commit-"));
			let restore: (() => void) | undefined;
			try {
				await replaceOwnerGeneration(state, "session", "generation");
				const paths = lifecyclePaths(state, "session", "generation");
				let proofs = 0;
				let cleanups = 0;
				if (fault === "before-rename" || fault === "after-rename") {
					const original = natives.renameNoReplacePathAsync;
					const spy = spyOn(natives, "renameNoReplacePathAsync").mockImplementation(async (...args) => {
						if (fault === "after-rename") await original(...args);
						throw new Error("injected_publication_fault");
					});
					restore = () => spy.mockRestore();
				}
				if (fault === "readback") {
					const original = natives.readOwnerOnlyFile;
					const spy = spyOn(natives, "readOwnerOnlyFile").mockImplementation((file, limit) =>
						file === paths.intentFile ? { ok: false, code: "read_failed" } : original(file, limit),
					);
					restore = () => spy.mockRestore();
				}
				if (fault === "release") {
					const original = Database.prototype.exec;
					const spy = spyOn(Database.prototype, "exec").mockImplementation(function (this: Database, sql: string) {
						if (sql === "COMMIT") throw new Error("release_failed");
						return original.call(this, sql);
					});
					restore = () => spy.mockRestore();
				}
				const request = {
					stateDir: state,
					sessionId: "session",
					generation: "generation",
					serverKey: "socket",
					pid: 10,
					startTime: "provenance",
					dispatchId: "dispatch",
					createdAt: new Date(Date.now() - 10).toISOString(),
					expiresAt: new Date(Date.now() + (fault === "expired" ? -1 : 5_000)).toISOString(),
				};
				await expect(
					closeExactTmuxOwner(request, {
						readStartTime: async () => "provenance",
						shutdown: {
							kind: "cooperative_intent",
							assertCooperativeOwner: () => {
								proofs += 1;
								expect(fsSync.existsSync(paths.intentFile)).toBe(false);
								if (fault === "final-proof" && proofs === 3) throw new Error("final_proof_failed");
								if (fault === "generation" && proofs === 2)
									fsSync.writeFileSync(
										paths.generationFile,
										`${JSON.stringify({ schema_version: 1, generation: "replacement", session_id: "session", published_at: new Date().toISOString() })}\n`,
									);
							},
						},
						waitForVerdict: async () =>
							fault === "mismatched-verdict"
								? {
										schema_version: 1,
										generation: "generation",
										session_id: "session",
										server_key: "socket",
										observed_at: new Date().toISOString(),
										signal: "SIGTERM",
										exit_code: 0,
										result: "owner_term_then_session_cleanup",
										observer: "raw_monitor",
										classification: "expected_operator_shutdown",
										reason: "test",
										intent_id: "wrong-intent",
										dedupe_key: "owner-loss:session:generation",
									}
								: null,
						cleanupSession: async () => {
							cleanups += 1;
						},
					}),
				).rejects.toThrow();
				expect(cleanups).toBe(0);
				expect(fsSync.existsSync(paths.intentFile)).toBe(
					["after-rename", "readback", "release", "mismatched-verdict"].includes(fault),
				);
				for (const suffix of [".cancelled", ".expired", ".consumed"])
					expect(fsSync.existsSync(`${paths.intentFile}${suffix}`)).toBe(false);
				if (fault === "final-proof") expect(proofs).toBe(3);
			} finally {
				restore?.();
				await fs.rm(state, { recursive: true, force: true });
			}
		}
	});

	it("consumes only exact timely evidence while holding the same generation lock", async () => {
		const state = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-cooperative-consumer-"));
		try {
			await replaceOwnerGeneration(state, "session", "prior-generation");
			await observeOwnerTerminal({
				schema_version: 1,
				op: "observe_terminal",
				session_id: "session",
				owner_generation: "prior-generation",
				state_dir: state,
				socket_key: "socket",
				observer: "raw_monitor",
				observed_at: new Date().toISOString(),
				signal: "EXIT",
				exit_code: 0,
				exit_kind: "exit",
				reason: "test",
			});
			await replaceOwnerGeneration(state, "session", "generation");
			const paths = lifecyclePaths(state, "session", "generation");
			const priorAlias = readSecureOwnerJson(paths.verdictAliasFile) as Record<string, unknown>;
			const binding: ManagedOwnerOpaqueBinding = {
				schema_version: 3,
				binding_kind: "opaque",
				generation: "generation",
				session_id: "session",
				run_id: "run",
				endpoint_incarnation: "incarnation",
				child_token: "token",
				supervisor_pid: 10,
				supervisor_start_time: "provenance",
				created_at: new Date(Date.now() - 1_000).toISOString(),
			};
			const intent: OwnerIntent = {
				schema_version: 1,
				intent_id: "intent",
				state: "pending",
				generation: "generation",
				session_id: "session",
				server_key: "socket",
				expected_terminal: { signal: "SIGTERM", result: "owner_term_then_session_cleanup" },
				dispatch_id: "dispatch",
				created_at: new Date(Date.now() - 100).toISOString(),
				expires_at: new Date(Date.now() + 10_000).toISOString(),
			};
			const write = (file: string, value: unknown) =>
				fsSync.writeFileSync(file, `${JSON.stringify(value)}\n`, { mode: 0o600 });
			write(path.join(paths.root, "child-token.binding.json"), binding);
			let relays = 0;
			const poll = () =>
				consumeCooperativeOwnerIntent({
					stateDir: state,
					binding,
					serverKey: "socket",
					relay: () => {
						const contender = new Database(paths.lockDatabaseFile);
						try {
							contender.exec("PRAGMA busy_timeout = 0");
							expect(() => contender.exec("BEGIN IMMEDIATE")).toThrow();
						} finally {
							contender.close();
						}
						relays += 1;
					},
				});
			write(`${paths.intentFile}.staging`, intent);
			poll();
			expect(relays).toBe(0);
			for (const patch of [
				{ server_key: "wrong" },
				{ generation: "stale" },
				{ session_id: "wrong" },
				{ dispatch_id: "" },
				{ extra: true },
				{ created_at: new Date(Date.now() + 1_000).toISOString() },
				{ created_at: new Date(Date.now() - 2_000).toISOString() },
				{ expires_at: new Date(Date.now() - 1).toISOString() },
			]) {
				write(paths.intentFile, { ...intent, ...patch });
				poll();
				expect(relays).toBe(0);
			}
			write(paths.intentFile, intent);
			for (const suffix of [".cancelled", ".expired", ".invalidated", ".consumed"]) {
				write(`${paths.intentFile}${suffix}`, intent);
				poll();
				expect(relays).toBe(0);
				fsSync.unlinkSync(`${paths.intentFile}${suffix}`);
			}
			for (const alias of [
				{ ...priorAlias, extra: true },
				{ ...priorAlias, session_id: "other" },
				{
					...priorAlias,
					generation: "generation",
					owner_generation: "generation",
					dedupe_key: "owner-loss:session:generation",
				},
				{
					...priorAlias,
					generation: "unknown",
					owner_generation: "unknown",
					dedupe_key: "owner-loss:session:unknown",
				},
			]) {
				write(paths.verdictAliasFile, alias);
				poll();
				expect(relays).toBe(0);
			}
			write(paths.verdictAliasFile, priorAlias);
			write(path.join(paths.root, "child-token.binding.json"), { ...binding, run_id: "replacement" });
			poll();
			expect(relays).toBe(0);
			write(path.join(paths.root, "child-token.binding.json"), binding);
			const nativeRead = spyOn(natives, "readOwnerOnlyFile").mockReturnValue({ ok: false, code: "read_failed" });
			try {
				poll();
				expect(relays).toBe(0);
			} finally {
				nativeRead.mockRestore();
			}
			const held = new Database(paths.lockDatabaseFile);
			try {
				held.exec("BEGIN IMMEDIATE");
				poll();
				expect(relays).toBe(0);
				held.exec("COMMIT");
			} finally {
				held.close();
			}
			const holder = Bun.spawn({
				cmd: [
					process.execPath,
					"-e",
					`import { Database } from "bun:sqlite";
const db = new Database(${JSON.stringify(paths.lockDatabaseFile)}); db.exec("BEGIN IMMEDIATE");
process.stdout.write("locked\\n"); const timer = setTimeout(() => process.exit(93), 3_000);
await Bun.stdin.text(); db.exec("COMMIT"); db.close(); clearTimeout(timer);`,
				],
				stdin: "pipe",
				stdout: "pipe",
				stderr: "pipe",
			});
			try {
				const reader = holder.stdout.getReader();
				try {
					expect(new TextDecoder().decode((await reader.read()).value)).toBe("locked\n");
				} finally {
					reader.releaseLock();
				}
				poll();
				expect(relays).toBe(0);
			} finally {
				holder.stdin.end();
				const exited = await Promise.race([holder.exited, Bun.sleep(1_000).then(() => null)]);
				if (exited === null) {
					holder.kill("SIGKILL");
					await holder.exited;
				}
				expect(exited).toBe(0);
			}
			poll();
			expect(relays).toBe(1);
			expect(readSecureOwnerJson(paths.intentFile)).toEqual(intent);
			await replaceOwnerGeneration(state, "session", "replacement");
			poll();
			expect(relays).toBe(1);
		} finally {
			await fs.rm(state, { recursive: true, force: true });
		}
	});
});

it("accepts only the exact scoped bootstrap success receipt", () => {
	expect(
		isExactScopedBootstrapSuccessReceipt(
			'{"schema_version":1,"ok":true,"code":"bootstrapped","native_session_id":"$0","server_pid":12,"server_start_time":"34","session_name":"owned-session"}\n',
		),
	).toBe(true);
	for (const value of [
		'{"schema_version":1,"ok":true,"code":"bootstrapped"}\nnoise',
		'{"schema_version":2,"ok":true,"code":"bootstrapped"}',
		'{"schema_version":1,"ok":true,"code":"bootstrapped","extra":true}',
		'{"ok":true,"code":"bootstrapped"}',
		"not-json",
	])
		expect(isExactScopedBootstrapSuccessReceipt(value)).toBe(false);
});

async function runOwnerIsolationEntry(
	command: string[],
	stdin: string,
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
	const proc = Bun.spawn(command, {
		cwd: repoRoot,
		stdin: "pipe",
		stdout: "pipe",
		stderr: "pipe",
	});
	proc.stdin.write(stdin);
	proc.stdin.end();
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	return { exitCode, stdout, stderr };
}

const ownerIsolationEntries: Array<[string, string[]]> = [
	["source CLI", [process.execPath, ownerIsolationCliEntry, ownerIsolationFlag]],
	["packaged CLI", [process.execPath, packagedGjcEntry, ownerIsolationFlag]],
	[
		"direct main entry",
		[
			process.execPath,
			"-e",
			`import { main } from ${JSON.stringify(mainEntry)}; await main([${JSON.stringify(ownerIsolationFlag)}]);`,
		],
	],
];

const request: PlanRequest = {
	schema_version: 1,
	op: "plan",
	platform: "linux",
	session_id: "session",
	owner_generation: "generation",
	cwd: "/work",
	state_dir: "/tmp/state",
	socket_key: "socket",
	tmux_argv: ["tmux", "new-session", "-d", "-s", "owned-session", "literal value"],
	baseline: { state: "absent" },
};

function probe(state: "absent" | "safe" | "unsafe" | "unverifiable", cgroup = "0::/unit.service") {
	return {
		readCallerCgroup: async () => cgroup,
		probeServer: async () =>
			state === "safe"
				? {
						state,
						pid: 1,
						startTime: "1",
						cgroup: { classification: "safe" as const },
					}
				: { state },
	};
}

function holdSqliteWriteLock(databaseFile: string): Database {
	const database = new Database(databaseFile);
	database.exec("BEGIN IMMEDIATE");
	return database;
}

describe("tmux owner isolation", () => {
	it("recognizes only the exact owner-isolation argv", () => {
		expect(isTmuxOwnerIsolationCliArgv([ownerIsolationFlag])).toBe(true);
		for (const argv of [[], [ownerIsolationFlag, "extra"], ["extra", ownerIsolationFlag], ["--other"]]) {
			expect(isTmuxOwnerIsolationCliArgv(argv)).toBe(false);
		}
	});

	it("treats successful whitespace-only list-sessions output as absent", async () => {
		const proof = await tmuxServerProof("socket", ["psmux"], {
			platform: "win32",
			runListSessions: () => ({ exitCode: 0, stdout: " \r\n\t", stderr: "" }),
		});
		expect(proof).toEqual({ state: "absent" });
	});

	it("treats a known no-server diagnostic as absent", async () => {
		const proof = await tmuxServerProof("socket", ["psmux"], {
			platform: "win32",
			runListSessions: () => ({
				exitCode: 1,
				stdout: "",
				stderr: "no server running on /tmp/psmux.sock",
			}),
		});
		expect(proof).toEqual({ state: "absent" });
	});

	it("accepts complete matching list-sessions rows on win32", async () => {
		const proof = await tmuxServerProof("socket", ["psmux"], {
			platform: "win32",
			runListSessions: () => ({
				exitCode: 0,
				stdout: "4242\tfirst\n4242\tsecond\n",
				stderr: "",
			}),
		});
		expect(proof).toEqual({
			state: "safe",
			pid: 4242,
			startTime: "not_applicable",
			cgroup: { classification: "not_applicable" },
			sessionNames: ["first", "second"],
		});
	});

	it.each([
		["an invalid pid", "not-a-pid\towned\n"],
		["a missing pid", "\towned\n"],
		["malformed columns", "42\towned\textra\n"],
		["inconsistent pids", "42\tfirst\n43\tsecond\n"],
		["mixed valid and invalid rows", "42\tfirst\nbroken\tsecond\n"],
	])("fails closed on non-empty list-sessions output with %s", async (_case, stdout) => {
		const proof = await tmuxServerProof("socket", ["psmux"], {
			platform: "win32",
			runListSessions: () => ({ exitCode: 0, stdout, stderr: "" }),
		});
		expect(proof).toEqual({ state: "unverifiable" });
	});

	it("invokes a compiled bootstrap with only the internal flag", () => {
		const prior = process.env.PI_COMPILED;
		process.env.PI_COMPILED = "1";
		try {
			expect(tmuxOwnerIsolationBootstrapArgv()).toEqual([process.execPath, ownerIsolationFlag]);
		} finally {
			if (prior === undefined) delete process.env.PI_COMPILED;
			else process.env.PI_COMPILED = prior;
		}
	});

	it("uses a stable non-Linux owner start identity without proc metadata", () => {
		expect(ownerProcessStartTime("darwin", null)).toBe("not_applicable");
		expect(ownerProcessStartTime("win32", "malformed")).toBe("not_applicable");
	});

	it("fails closed on malformed Linux owner start metadata", () => {
		const fields = ["S", ...Array.from({ length: 18 }, () => "0"), "1234"];
		expect(ownerProcessStartTime("linux", `1 (owner) ${fields.join(" ")}`)).toBe("1234");
		expect(ownerProcessStartTime("linux", null)).toBeNull();
		expect(ownerProcessStartTime("linux", "malformed")).toBeNull();
	});

	it.each(ownerIsolationEntries)(
		"routes exact argv through %s as one bounded JSON line",
		async (_entry, command) => {
			const privateMarker = "private-payload-must-not-appear";
			const result = await runOwnerIsolationEntry(command, `{"private":"${privateMarker}"}\n`);
			expect(result).toEqual({
				exitCode: 1,
				stdout: invalidJsonLineResponse,
				stderr: "",
			});
			expect(result.stdout.split("\n")).toEqual([invalidJsonLineResponse.trim(), ""]);
			expect(result.stdout).not.toContain(privateMarker);
		},
		20_000,
	);

	it.each(ownerIsolationEntries)(
		"publishes a generation through the canonical CAS path via %s",
		async (entry, command) => {
			const state = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-owner-cli-generation-"));
			const sessionId = `session-${entry.replace(/\W+/g, "-")}`;
			const generation = `generation-${entry.replace(/\W+/g, "-")}`;
			try {
				const request = {
					schema_version: 1,
					op: "publish_generation",
					session_id: sessionId,
					owner_generation: generation,
					state_dir: state,
					baseline: { state: "absent" },
				};
				const result = await runOwnerIsolationEntry(command, `${JSON.stringify(request)}\n`);
				expect(result.exitCode).toBe(0);
				expect(result.stderr).toBe("");
				expect(JSON.parse(result.stdout)).toEqual({
					schema_version: 1,
					ok: true,
					code: "generation_published",
					generation,
				});
				expect(captureOwnerGenerationBaselineSync(state, sessionId)).toMatchObject({
					state: "current",
					generation,
					session_id: sessionId,
				});
				const stale = await runOwnerIsolationEntry(command, `${JSON.stringify(request)}\n`);
				expect(JSON.parse(stale.stdout)).toEqual({
					schema_version: 1,
					ok: false,
					code: "scope_unavailable",
					diagnostic: "generation_publication_failed",
				});
				expect(captureOwnerGenerationBaselineSync(state, sessionId)).toMatchObject({ generation });
			} finally {
				await fs.rm(state, { recursive: true, force: true });
			}
		},
		20_000,
	);

	it.each(ownerIsolationEntries)(
		"routes a valid bounded terminal observation through %s",
		async (entry, command) => {
			const state = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-owner-cli-observe-"));
			const sessionId = `session-${entry.replace(/\W+/g, "-")}`;
			const generation = `generation-${entry.replace(/\W+/g, "-")}`;
			try {
				await replaceOwnerGeneration(state, sessionId, generation);
				const request = {
					schema_version: 1,
					op: "observe_terminal",
					session_id: sessionId,
					owner_generation: generation,
					state_dir: state,
					socket_key: `socket-${sessionId}`,
					observer: "sidecar",
					observed_at: "2026-01-01T00:00:00.000Z",
					signal: "EXIT",
					exit_code: 0,
					exit_kind: "cleanup",
					reason: "test",
				};
				const result = await runOwnerIsolationEntry(command, `${JSON.stringify(request)}\n`);
				const response = JSON.parse(result.stdout) as Record<string, unknown>;
				expect(result.exitCode).toBe(0);
				expect(result.stderr).toBe("");
				expect(response).toMatchObject({
					schema_version: 1,
					generation,
					session_id: sessionId,
					server_key: request.socket_key,
					observer: "sidecar",
					signal: "EXIT",
					result: "cleanup",
					classification: "non_operator_cleanup",
				});
				expect(result.stdout).not.toContain(state);
			} finally {
				await fs.rm(state, { recursive: true, force: true });
			}
		},
		20_000,
	);

	it("rejects a multi-line owner-isolation request without entering an interactive path", async () => {
		const result = await runOwnerIsolationEntry(
			[process.execPath, ownerIsolationCliEntry, ownerIsolationFlag],
			'{"private":"private-payload-must-not-appear"}\nextra\n',
		);
		expect(result).toEqual({
			exitCode: 1,
			stdout: invalidJsonLineResponse,
			stderr: "",
		});
		expect(result.stdout).not.toContain("private-payload-must-not-appear");
	}, 20_000);
	it("rejects an oversized owner-isolation stream at the canonical byte bound", async () => {
		const result = await runOwnerIsolationEntry(
			[process.execPath, ownerIsolationCliEntry, ownerIsolationFlag],
			`${"x".repeat(TMUX_OWNER_ISOLATION_MAX_LINE_BYTES + 1)}\n`,
		);
		expect(result).toEqual({
			exitCode: 1,
			stdout: invalidJsonLineResponse,
			stderr: "",
		});
	}, 20_000);

	it("classifies cgroups and applies the target-server truth table", async () => {
		expect(classifyCgroup({ platform: "darwin" })).toEqual({
			classification: "not_applicable",
		});
		expect(classifyCgroup({ platform: "linux", cgroupText: "0::/x.service" }).classification).toBe("unsafe_service");
		expect(classifyCgroup({ platform: "linux", cgroupText: "broken" }).classification).toBe("unverifiable");
		expect(classifyCgroup({ platform: "linux", cgroupText: "0::/" })).toEqual({
			classification: "safe",
			scope: "/",
		});
		expect(
			classifyCgroup({
				platform: "linux",
				cgroupText: "0::/app.slice/app-demo.scope",
			}).classification,
		).toBe("safe");
		expect(
			classifyCgroup({
				platform: "linux",
				cgroupText:
					"0::/user.slice/user-1000.slice/user@1000.service/app.slice/app-org.gnome.Terminal.slice/vte-spawn-4006c3d1-0f5c-4ddb-b522-7b73d1f1fb59.scope",
			}),
		).toEqual({
			classification: "safe",
			scope: "/user.slice/user-1000.slice/user@1000.service/app.slice/app-org.gnome.Terminal.slice/vte-spawn-4006c3d1-0f5c-4ddb-b522-7b73d1f1fb59.scope",
		});
		expect(
			classifyCgroup({
				platform: "linux",
				cgroupText: "0::/user.slice/user-1001.slice/user@1000.service/app.slice/vte-spawn-4006c3d1.scope",
			}).classification,
		).toBe("unverifiable");
		expect(
			classifyCgroup({
				platform: "linux",
				cgroupText: "0::/system.slice/vte-spawn-4006c3d1.scope",
			}).classification,
		).toBe("unverifiable");
		expect(
			await planTmuxOwnerIsolation(
				request,
				probe(
					"absent",
					"0::/user.slice/user-1000.slice/user@1000.service/app.slice/app-org.gnome.Terminal.slice/vte-spawn-4006c3d1.scope",
				),
			),
		).toMatchObject({ ok: true, code: "not_required", classification: { classification: "safe" } });
		expect(
			(
				await planTmuxOwnerIsolation(request, {
					...probe("safe"),
					probeServer: async () => ({ state: "safe" }),
				})
			).code,
		).toBe("server_unverifiable");
		expect((await planTmuxOwnerIsolation(request, probe("safe"))).ok).toBe(true);
		expect((await planTmuxOwnerIsolation(request, probe("unsafe"))).code).toBe("server_unsafe");
		expect((await planTmuxOwnerIsolation(request, probe("unverifiable"))).code).toBe("server_unverifiable");
	});

	it("rejects a stale caller baseline before direct or scoped planning", async () => {
		const state = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-owner-plan-baseline-"));
		try {
			const baseline = captureOwnerGenerationBaselineSync(state, "session");
			replaceOwnerGenerationSync(state, "session", "competing", baseline);
			const staleRequest: PlanRequest = { ...request, state_dir: state, baseline };
			expect(await planTmuxOwnerIsolation(staleRequest, probe("safe"))).toMatchObject({
				ok: false,
				code: "scope_unavailable",
				diagnostic: "owner_generation_stale",
			});
			expect(
				planTmuxOwnerIsolationSync(staleRequest, {
					readCallerCgroup: () => "0::/caller.service",
					probeServer: () => ({ state: "absent" }),
					recordAttempt: () => {
						throw new Error("stale plan must not record an attempt");
					},
				}),
			).toMatchObject({ ok: false, code: "scope_unavailable", diagnostic: "owner_generation_stale" });
		} finally {
			await fs.rm(state, { recursive: true, force: true });
		}
	});

	it("accepts only structurally safe non-Linux not-applicable server proofs", async () => {
		const nonLinux = { ...request, platform: "darwin" as const };
		const safeProof = {
			state: "safe" as const,
			pid: 1,
			startTime: "1",
			cgroup: { classification: "not_applicable" as const },
		};
		const planned = await planTmuxOwnerIsolation(nonLinux, {
			...probe("absent"),
			probeServer: async () => safeProof,
		});
		expect(planned).toMatchObject({ ok: true, server_state: "safe" });
		expect(
			executeTmuxOwnerIsolationPlanSync(planned, {
				socketKey: "socket",
				spawn: () => ({ exitCode: 0 }),
				probeServer: () => safeProof,
			}),
		).toMatchObject({ ok: true });
		expect(
			await planTmuxOwnerIsolation(request, {
				...probe("absent"),
				probeServer: async () => safeProof,
			}),
		).toMatchObject({
			ok: false,
			code: "server_unverifiable",
		});
	});

	it("preserves argv literally and bounds the JSON-line protocol", async () => {
		const result = await planTmuxOwnerIsolation(
			{ ...request, platform: "darwin" },
			probe("absent", null as unknown as string),
		);
		expect(result.ok && result.execution.argv).toEqual(request.tmux_argv);
		expect(parseOwnerIsolationRequest(JSON.stringify({ ...request, tmux_argv: ["tmux", ""] }))?.op).toBe("plan");
		expect(parseOwnerIsolationRequest(`${JSON.stringify(request)}\nextra`)).toBeNull();
		expect(parseOwnerIsolationRequest(JSON.stringify({ ...request, extra: true }))).toBeNull();
		expect(parseOwnerIsolationRequest("x".repeat(16 * 1024 + 1))).toBeNull();
		expect(
			await planTmuxOwnerIsolation(request, {
				readCallerCgroup: async () => {
					throw new Error("unavailable");
				},
				probeServer: async () => ({ state: "absent" }),
			}),
		).toMatchObject({ ok: false, code: "scope_unavailable" });
	});

	it("plans and executes managed paths synchronously with a post-spawn server proof", () => {
		const attempts: string[] = [];
		const scoped = planTmuxOwnerIsolationSync(request, {
			readCallerCgroup: () => "0::/caller.service",
			probeServer: () => ({ state: "absent" }),
			recordAttempt: input => attempts.push(input.attempt.token),
		});
		expect(scoped.ok && scoped.execution.mode).toBe("scoped");
		expect(scoped.ok && scoped.execution.attempt_session).toBe("owned-session");
		expect(attempts).toHaveLength(1);
		const calls: Array<{ argv: string[]; stdin?: string }> = [];
		const executed = executeTmuxOwnerIsolationPlanSync(scoped, {
			socketKey: "socket",
			spawn: (argv, stdin) => {
				calls.push({ argv, stdin });
				return {
					exitCode: 0,
					stdout:
						'{"schema_version":1,"ok":true,"code":"bootstrapped","native_session_id":"$0","server_pid":12,"server_start_time":"34","session_name":"owned-session"}\n',
				};
			},
			probeServer: socketKey => ({
				state: "safe",
				pid: 12,
				startTime: "34",
				cgroup: { classification: "safe", scope: `/gjc-${socketKey}.scope` },
			}),
		});
		expect(executed).toMatchObject({
			ok: true,
			server_key: "socket",
			server_pid: 12,
			server_start_time: "34",
			server_session: "owned-session",
		});
		expect(calls).toHaveLength(1);
		expect(calls[0]?.argv).toEqual(scoped.ok && scoped.execution.mode === "scoped" ? scoped.execution.argv : []);
		expect(calls[0]?.stdin).toBe(
			scoped.ok && scoped.execution.mode === "scoped" ? scoped.execution.stdin_line : undefined,
		);
		expect(calls[0]?.argv.slice(0, 6)).toEqual([
			"systemd-run",
			"--user",
			"--scope",
			"--quiet",
			"--unit",
			scoped.ok && scoped.execution.mode === "scoped" ? scoped.execution.expected_scope : "",
		]);
		expect(calls[0]?.argv).not.toContain("sh");
		expect(calls[0]?.argv).not.toContain("-c");
		expect(calls[0]?.argv).not.toContain(calls[0]?.stdin ?? "");
	});

	it("rejects a scoped receipt when its creating server was replaced", () => {
		const scoped = planTmuxOwnerIsolationSync(request, {
			readCallerCgroup: () => "0::/caller.service",
			probeServer: () => ({ state: "absent" }),
			recordAttempt: () => undefined,
		});
		const outcome = executeTmuxOwnerIsolationPlanSync(scoped, {
			socketKey: "socket",
			spawn: () => ({
				exitCode: 0,
				stdout:
					'{"schema_version":1,"ok":true,"code":"bootstrapped","native_session_id":"$0","server_pid":12,"server_start_time":"34","session_name":"owned-session"}\n',
			}),
			probeServer: () => ({
				state: "safe",
				pid: 13,
				startTime: "35",
				cgroup: { classification: "safe" },
			}),
		});
		expect(outcome).toMatchObject({ ok: false, code: "server_race" });
	});

	it("fails closed synchronously for unsafe proof and failed scoped outcome", () => {
		const unsafe = planTmuxOwnerIsolationSync(request, {
			readCallerCgroup: () => "0::/x.service",
			probeServer: () => ({ state: "unsafe" }),
			recordAttempt: () => {
				throw new Error("must not persist");
			},
		});
		expect(unsafe).toMatchObject({ ok: false, code: "server_unsafe" });
		const direct = planTmuxOwnerIsolationSync(
			{ ...request, platform: "darwin" },
			{
				readCallerCgroup: () => null,
				probeServer: () => ({ state: "safe" }),
				recordAttempt: () => {
					throw new Error("must not persist");
				},
			},
		);
		const rejected = executeTmuxOwnerIsolationPlanSync(direct, {
			socketKey: "socket",
			spawn: () => ({ exitCode: 0 }),
			probeServer: () => ({ state: "unverifiable" }),
		});
		expect(rejected).toMatchObject({ ok: false, code: "server_unverifiable" });
	});

	it("rejects a direct execution when the pre-existing server identity changes", () => {
		const planned = planTmuxOwnerIsolationSync(
			{ ...request, platform: "darwin" },
			{
				readCallerCgroup: () => null,
				probeServer: () => ({
					state: "safe",
					pid: 12,
					startTime: "before",
					cgroup: { classification: "not_applicable" },
				}),
				recordAttempt: () => undefined,
			},
		);
		expect(planned).toMatchObject({
			ok: true,
			execution: {
				server_key: "socket",
				server_pid: 12,
				server_start_time: "before",
			},
		});
		expect(
			executeTmuxOwnerIsolationPlanSync(planned, {
				socketKey: "socket",
				spawn: () => ({ exitCode: 0 }),
				probeServer: () => ({
					state: "safe",
					pid: 12,
					startTime: "after",
					cgroup: { classification: "not_applicable" },
				}),
			}),
		).toMatchObject({ ok: false, code: "server_race" });
	});

	it("refuses a stale direct generation before spawn and after its post-spawn proof", () => {
		const planned = planTmuxOwnerIsolationSync(
			{ ...request, platform: "darwin" },
			{
				readCallerCgroup: () => null,
				probeServer: () => ({
					state: "safe",
					pid: 12,
					startTime: "before",
					cgroup: { classification: "not_applicable" },
				}),
				recordAttempt: () => undefined,
			},
		);
		let spawns = 0;
		expect(
			executeTmuxOwnerIsolationPlanSync(planned, {
				socketKey: "socket",
				isCurrentGeneration: () => false,
				spawn: () => {
					spawns += 1;
					return { exitCode: 0 };
				},
				probeServer: () => ({
					state: "safe",
					pid: 12,
					startTime: "before",
					cgroup: { classification: "not_applicable" },
				}),
			}),
		).toMatchObject({ ok: false, diagnostic: "owner_generation_stale" });
		expect(spawns).toBe(0);
		let current = true;
		const cleaned: Array<{ nativeSessionId: string; sessionName: string }> = [];
		expect(
			executeTmuxOwnerIsolationPlanSync(planned, {
				socketKey: "socket",
				isCurrentGeneration: () => current,
				spawn: () => {
					current = false;
					return { exitCode: 0, stdout: "$0" };
				},
				probeServer: () => ({
					state: "safe",
					pid: 12,
					startTime: "before",
					cgroup: { classification: "not_applicable" },
				}),
				cleanupSpawned: ({ execution, nativeSessionId }) => {
					cleaned.push({ nativeSessionId, sessionName: execution.attempt_session });
				},
			}),
		).toMatchObject({ ok: false, diagnostic: "owner_generation_stale" });
		expect(cleaned).toEqual([{ nativeSessionId: "$0", sessionName: "owned-session" }]);
		current = true;
		expect(
			executeTmuxOwnerIsolationPlanSync(planned, {
				socketKey: "socket",
				isCurrentGeneration: () => current,
				spawn: () => {
					current = false;
					return { exitCode: 0 };
				},
				probeServer: () => ({
					state: "safe",
					pid: 12,
					startTime: "before",
					cgroup: { classification: "not_applicable" },
				}),
				cleanupSpawned: () => {},
			}),
		).toMatchObject({ ok: false, diagnostic: "owner_generation_stale_cleanup_uncertain" });
		current = true;
		expect(
			executeTmuxOwnerIsolationPlanSync(planned, {
				socketKey: "socket",
				isCurrentGeneration: () => current,
				spawn: () => {
					current = false;
					return { exitCode: 0, stdout: "$0" };
				},
				probeServer: () => ({
					state: "safe",
					pid: 12,
					startTime: "before",
					cgroup: { classification: "not_applicable" },
				}),
				cleanupSpawned: () => {
					throw new Error("guard refused");
				},
			}),
		).toMatchObject({ ok: false, diagnostic: "owner_generation_stale_cleanup_uncertain" });
		current = true;
		let replacementCleanupCalls = 0;
		expect(
			executeTmuxOwnerIsolationPlanSync(planned, {
				socketKey: "socket",
				isCurrentGeneration: () => current,
				spawn: () => {
					current = false;
					return { exitCode: 0, stdout: "$0" };
				},
				probeServer: () => ({
					state: "safe",
					pid: 99,
					startTime: "replacement",
					cgroup: { classification: "not_applicable" },
				}),
				cleanupSpawned: () => {
					replacementCleanupCalls += 1;
				},
			}),
		).toMatchObject({ ok: false, diagnostic: "owner_generation_stale_cleanup_uncertain" });
		expect(replacementCleanupCalls).toBe(0);
		current = true;
		expect(
			executeTmuxOwnerIsolationPlanSync(planned, {
				socketKey: "socket",
				isCurrentGeneration: () => current,
				spawn: () => {
					current = false;
					return { exitCode: 0, stdout: "$0" };
				},
				probeServer: () => {
					throw new Error("probe unavailable");
				},
				cleanupSpawned: () => {
					throw new Error("must not clean without proof");
				},
			}),
		).toMatchObject({ ok: false, diagnostic: "owner_generation_stale_cleanup_uncertain" });
		const absentPlanned = planTmuxOwnerIsolationSync(
			{ ...request, platform: "darwin" },
			{
				readCallerCgroup: () => null,
				probeServer: () => ({ state: "absent" }),
				recordAttempt: () => undefined,
			},
		);
		current = true;
		let absentCleanupCalls = 0;
		expect(
			executeTmuxOwnerIsolationPlanSync(absentPlanned, {
				socketKey: "socket",
				isCurrentGeneration: () => current,
				spawn: () => {
					current = false;
					return { exitCode: 0, stdout: "$0" };
				},
				probeServer: () => ({
					state: "safe",
					pid: 12,
					startTime: "new-server",
					cgroup: { classification: "not_applicable" },
				}),
				cleanupSpawned: () => {
					absentCleanupCalls += 1;
				},
			}),
		).toMatchObject({ ok: false, diagnostic: "owner_generation_stale_cleanup_uncertain" });
		expect(absentCleanupCalls).toBe(0);
	});

	it("requires bootstrap self-proof before spawning exact argv", async () => {
		const state = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-owner-bootstrap-"));
		const attempt: AttemptCapability = {
			token: "token",
			session_name: "owned",
			socket_key: "socket",
			server_absent_before: true,
			baseline: { state: "absent" as const },
			expires_at: new Date(Date.now() + 5_000).toISOString(),
		};

		const attemptDir = path.join(state, "session", "owner-lifecycle");
		await fs.mkdir(attemptDir, { recursive: true });
		await replaceOwnerGeneration(state, "session", "prior-generation");
		attempt.baseline = captureOwnerGenerationBaselineSync(state, "session");
		await fs.writeFile(
			path.join(attemptDir, "attempt-token.json"),
			JSON.stringify({
				schema_version: 1,
				generation: "generation",
				session_id: "session",
				created_at: "2026-01-01T00:00:00.000Z",
				...attempt,
			}),
		);
		const bootstrap: BootstrapRequest = {
			schema_version: 1,
			op: "bootstrap",
			session_id: "session",
			owner_generation: "generation",
			state_dir: state,
			socket_key: "socket",
			expected_scope: "gjc-owner-token.scope",
			tmux_argv: ["tmux", "new-session", "-s", "owned", "a b"],
			attempt,
		};
		const calls: string[][] = [];
		const proofPrefixes: Array<string[] | undefined> = [];
		const result = await bootstrapTmuxOwnerIsolation(bootstrap, {
			readSelfCgroup: async () => "0::/gjc-owner-token.scope",

			spawn: argv => {
				calls.push(argv);
				return { exitCode: 0, stdout: "$0\n" };
			},
			probeServer: async (_socketKey, tmuxControlArgv) => {
				proofPrefixes.push(tmuxControlArgv);
				return {
					state: "safe",
					pid: 1,
					startTime: "1",
					cgroup: { classification: "safe" },
				};
			},
		});
		expect(result.ok).toBe(true);
		expect(JSON.parse(await fs.readFile(path.join(attemptDir, "generation.json"), "utf8"))).toMatchObject({
			generation: "prior-generation",
		});
		expect(calls).toEqual([["tmux", "new-session", "-s", "owned", "a b"]]);

		expect(proofPrefixes).toEqual([["tmux"]]);
		const explicitAttempt: AttemptCapability = {
			token: "explicit-token",
			session_name: "owned-explicit",
			socket_key: "opaque socket",
			server_absent_before: true,
			baseline: { state: "absent" as const },
			expires_at: new Date(Date.now() + 5_000).toISOString(),
		};
		explicitAttempt.baseline = captureOwnerGenerationBaselineSync(state, "session");

		await fs.writeFile(
			path.join(attemptDir, "attempt-explicit-token.json"),
			JSON.stringify({
				schema_version: 1,
				generation: "generation",
				session_id: "session",
				created_at: "2026-01-01T00:00:00.000Z",
				...explicitAttempt,
			}),
		);
		const explicitPrefixes: Array<string[] | undefined> = [];
		await expect(
			bootstrapTmuxOwnerIsolation(
				{
					...bootstrap,
					socket_key: "opaque socket",
					expected_scope: "gjc-owner-explicit-token.scope",
					tmux_argv: ["tmux", "-L", "explicit", "new-session", "-s", "owned-explicit", "a b"],

					attempt: explicitAttempt,
				},
				{
					readSelfCgroup: async () => "0::/gjc-owner-explicit-token.scope",

					spawn: () => ({ exitCode: 0, stdout: "$0\n" }),
					probeServer: async (_socketKey, tmuxControlArgv) => {
						explicitPrefixes.push(tmuxControlArgv);
						return {
							state: "safe",
							pid: 1,
							startTime: "1",
							cgroup: { classification: "safe" },
						};
					},
				},
			),
		).resolves.toMatchObject({ ok: true });
		expect(explicitPrefixes).toEqual([["tmux", "-L", "explicit"]]);
		const planPrefixes: Array<string[] | undefined> = [];
		for (const tmux_argv of [
			request.tmux_argv,
			["tmux", "-L", "explicit", "new-session", "-d", "-s", "owned-session", "literal value"],
		]) {
			await planTmuxOwnerIsolation(
				{ ...request, tmux_argv },
				{
					readCallerCgroup: async () => null,
					probeServer: async (_socketKey, tmuxControlArgv) => {
						planPrefixes.push(tmuxControlArgv);
						return {
							state: "safe",
							pid: 1,
							startTime: "1",
							cgroup: { classification: "safe" },
						};
					},
				},
			);
		}
		expect(planPrefixes).toEqual([["tmux"], ["tmux", "-L", "explicit"]]);
		const denied = await bootstrapTmuxOwnerIsolation(bootstrap, {
			readSelfCgroup: async () => "0::/bad.service",
			spawn: () => {
				throw new Error("must not spawn");
			},
			probeServer: async () => ({ state: "absent" }),
		});
		expect(denied.code).toBe("scope_bootstrap_failed");
		const replay = await bootstrapTmuxOwnerIsolation(bootstrap, {
			readSelfCgroup: async () => "0::/gjc-owner-token.scope",

			spawn: () => ({ exitCode: 0 }),
			probeServer: async () => ({
				state: "safe",
				pid: 1,
				startTime: "1",
				cgroup: { classification: "safe" },
			}),
		});
		expect(replay).toMatchObject({
			ok: false,
			diagnostic: "attempt_capability_invalid",
		});
		await fs.rm(state, { recursive: true, force: true });
	});

	it("never cleans after an unsafe or unrelated post-spawn server proof", async () => {
		const state = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-owner-bootstrap-cleanup-"));
		const sessionId = "session";
		const generation = "generation";
		const root = lifecyclePaths(state, sessionId, generation).root;
		const expires_at = new Date(Date.now() + 5_000).toISOString();
		const qualifyingAttempt: AttemptCapability = {
			token: "qualifying-token",
			session_name: "qualifying-session",
			socket_key: "qualifying-socket",
			server_absent_before: true,
			baseline: { state: "absent" as const },
			expires_at,
		};
		const nonQualifyingAttempt: AttemptCapability = {
			token: "non-qualifying-token",
			session_name: "non-qualifying-session",
			socket_key: "non-qualifying-socket",
			server_absent_before: true,
			baseline: { state: "absent" as const },
			expires_at,
		};
		const qualifyingProof = {
			state: "unsafe" as const,
			pid: 41,
			startTime: "42",
			sessionNames: [qualifyingAttempt.session_name],
		};
		const nonQualifyingProof = {
			state: "unsafe" as const,
			pid: 43,
			startTime: "44",
			sessionNames: ["unrelated-session"],
		};
		let spawnCount = 0;
		try {
			await fs.mkdir(root, { recursive: true });
			await replaceOwnerGeneration(state, sessionId, generation);
			qualifyingAttempt.baseline = captureOwnerGenerationBaselineSync(state, sessionId);
			nonQualifyingAttempt.baseline = captureOwnerGenerationBaselineSync(state, sessionId);
			for (const attempt of [qualifyingAttempt, nonQualifyingAttempt]) {
				await fs.writeFile(
					path.join(root, `attempt-${attempt.token}.json`),
					JSON.stringify({
						schema_version: 1,
						generation,
						session_id: sessionId,
						created_at: "2026-01-01T00:00:00.000Z",
						...attempt,
					}),
				);
			}
			for (const [attempt, proof] of [
				[qualifyingAttempt, qualifyingProof],
				[nonQualifyingAttempt, nonQualifyingProof],
			] as const) {
				const result = await bootstrapTmuxOwnerIsolation(
					{
						schema_version: 1,
						op: "bootstrap",
						session_id: sessionId,
						owner_generation: generation,
						state_dir: state,
						socket_key: attempt.socket_key,
						expected_scope: `gjc-owner-${attempt.token}.scope`,
						tmux_argv: ["tmux", "-L", attempt.token, "new-session", "-s", attempt.session_name, "a b"],
						attempt,
					},
					{
						readSelfCgroup: async () => `0::/gjc-owner-${attempt.token}.scope`,
						spawn: () => {
							spawnCount += 1;
							return { exitCode: 0, stdout: "$0\n" };
						},
						probeServer: async () => proof,
					},
				);
				expect(result).toMatchObject({
					ok: false,
					code: "scope_bootstrap_failed",
					diagnostic: "server_proof_failed_cleanup_uncertain",
				});
			}
			expect(spawnCount).toBe(2);
		} finally {
			await fs.rm(state, { recursive: true, force: true });
		}
	});

	it("rejects a stale bootstrap generation before consuming its capability or spawning", async () => {
		const state = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-owner-bootstrap-stale-"));
		const attempt = {
			token: "stale-token",
			session_name: "owned",
			socket_key: "socket",
			server_absent_before: true,
			baseline: { state: "absent" as const },
			expires_at: new Date(Date.now() + 5_000).toISOString(),
		};
		const root = lifecyclePaths(state, "session", "stale").root;
		try {
			await replaceOwnerGeneration(state, "session", "current");
			await fs.mkdir(root, { recursive: true });
			const attemptFile = path.join(root, `attempt-${attempt.token}.json`);
			await fs.writeFile(
				attemptFile,
				JSON.stringify({
					schema_version: 1,
					generation: "stale",
					session_id: "session",
					created_at: "2026-01-01T00:00:00.000Z",
					...attempt,
				}),
			);
			let spawnCount = 0;
			const result = await bootstrapTmuxOwnerIsolation(
				{
					schema_version: 1,
					op: "bootstrap",
					session_id: "session",
					owner_generation: "stale",
					state_dir: state,
					socket_key: "socket",
					expected_scope: "gjc-owner-stale-token.scope",
					tmux_argv: ["tmux", "new-session", "-s", "owned"],
					attempt,
				},
				{
					readSelfCgroup: async () => "0::/gjc-owner-stale-token.scope",
					spawn: () => {
						spawnCount += 1;
						return { exitCode: 0, stdout: "$0" };
					},
					probeServer: async () => ({ state: "absent" }),
				},
			);
			expect(result).toMatchObject({
				ok: false,
				diagnostic: "attempt_capability_invalid",
			});
			expect(spawnCount).toBe(0);
			await expect(fs.access(attemptFile)).resolves.toBeNull();
			await expect(fs.access(`${attemptFile}.consumed`)).rejects.toThrow();
		} finally {
			await fs.rm(state, { recursive: true, force: true });
		}
	});

	it("serializes concurrent generation replacements without reusable lock files", async () => {
		const state = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-owner-generation-lock-"));
		try {
			await replaceOwnerGeneration(state, "session", "initial");
			const [first, second] = await Promise.all([
				replaceOwnerGeneration(state, "session", "first"),
				replaceOwnerGeneration(state, "session", "second"),
			]);
			expect(new Set([first, second])).toEqual(new Set(["first", "second"]));
			expect(await fs.readdir(lifecyclePaths(state, "session", "second").root)).not.toContain("generation.lock");
		} finally {
			await fs.rm(state, { recursive: true, force: true });
		}
	});

	it("rejects stale generations before creating a SIGTERM intent", async () => {
		const state = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-owner-"));
		await replaceOwnerGeneration(state, "session", "current");
		await expect(
			closeExactTmuxOwner(
				{
					stateDir: state,
					sessionId: "session",
					generation: "stale",
					serverKey: "socket",
					pid: process.pid,
					startTime: "start",
					dispatchId: "dispatch",
					createdAt: "2026-01-01T00:00:00.000Z",
					expiresAt: "2026-01-01T00:01:00.000Z",
				},
				{
					readStartTime: async () => "start",
					shutdown: {
						kind: "kernel_signal",
						sendSigterm: async () => {
							throw new Error("must not signal");
						},
					},
					waitForVerdict: async () => null,
					cleanupSession: async () => undefined,
				},
			),
		).rejects.toThrow("owner_generation_mismatch");
		await expect(fs.access(lifecyclePaths(state, "session", "stale").intentFile)).rejects.toThrow();
		await fs.rm(state, { recursive: true, force: true });
	});

	it("writes verdict before consuming a matching attempt intent and converges observers", async () => {
		const state = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-owner-"));
		const generation = await replaceOwnerGeneration(state, "session", "generation");
		await createOwnerIntent(state, {
			generation,
			session_id: "session",
			server_key: "socket",
			expected_terminal: {
				signal: "SIGTERM",
				result: "owner_term_then_session_cleanup",
			},
			dispatch_id: "dispatch",
			created_at: "2026-01-01T00:00:00.000Z",
			expires_at: "2026-01-01T00:01:00.000Z",
		});
		const observed = {
			schema_version: 1 as const,
			op: "observe_terminal" as const,
			session_id: "session",
			owner_generation: generation,
			state_dir: state,
			socket_key: "socket",
			observer: "sidecar" as const,
			observed_at: "2026-01-01T00:00:01.000Z",
			signal: "SIGTERM" as const,
			exit_code: 0,
			exit_kind: "exit",
			reason: "owner_exit",
			operator_dispatch_id: "dispatch",
		};
		const first = await observeOwnerTerminal(observed);
		const second = await observeOwnerTerminal({
			...observed,
			observer: "raw_monitor",
			reason: "different",
		});
		expect(first.classification).toBe("expected_operator_shutdown");
		expect(second).toEqual(first);
		await expect(
			fs.access(path.join(state, "session", "owner-lifecycle", "intent-generation.json.consumed")),
		).resolves.toBeNull();
		await expect(Bun.file(path.join(state, "session", "owner-lifecycle", "verdict.json")).json()).resolves.toEqual({
			...first,
			owner_generation: generation,
		});
		await fs.rm(state, { recursive: true, force: true });
	});

	it("rejects a foreign generation while using the shared SQLite lock database", async () => {
		const state = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-owner-"));
		try {
			await replaceOwnerGeneration(state, "session", "current");
			await expect(
				observeOwnerTerminal({
					schema_version: 1,
					op: "observe_terminal",
					session_id: "session",
					owner_generation: "foreign",
					state_dir: state,
					socket_key: "socket",
					observer: "sidecar",
					observed_at: "2026-01-01T00:00:01.000Z",
					signal: "EXIT",
					exit_code: 0,
					exit_kind: "exit",
					reason: "sidecar",
				}),
			).rejects.toThrow("generation_mismatch");
		} finally {
			await fs.rm(state, { recursive: true, force: true });
		}
	});

	it("elects one immutable verdict from concurrent unique contenders", async () => {
		const state = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-owner-concurrent-"));
		try {
			const generation = await replaceOwnerGeneration(state, "session", "generation");
			const observation = {
				schema_version: 1 as const,
				op: "observe_terminal" as const,
				session_id: "session",
				owner_generation: generation,
				state_dir: state,
				socket_key: "socket",
				observer: "sidecar" as const,
				observed_at: "2026-01-01T00:00:01.000Z",
				signal: "SIGTERM" as const,
				exit_code: 0,
				exit_kind: "exit",
				reason: "sidecar",
			};
			const [first, second] = await Promise.all([
				observeOwnerTerminal(observation),
				observeOwnerTerminal({ ...observation, observer: "raw_monitor", reason: "raw_terminal" }),
			]);
			expect(second).toEqual(first);
			expect(await fs.access(lifecyclePaths(state, "session", generation).lockDatabaseFile)).toBeNull();
		} finally {
			await fs.rm(state, { recursive: true, force: true });
		}
	});

	it("does not coalesce current and foreign-generation terminal observations", async () => {
		const state = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-owner-generation-observation-"));
		try {
			const generation = await replaceOwnerGeneration(state, "session", "current");
			const observation = {
				schema_version: 1 as const,
				op: "observe_terminal" as const,
				session_id: "session",
				owner_generation: generation,
				state_dir: state,
				socket_key: "socket",
				observer: "sidecar" as const,
				observed_at: "2026-01-01T00:00:01.000Z",
				signal: "EXIT" as const,
				exit_code: 0,
				exit_kind: "exit",
				reason: "sidecar",
			};
			const current = observeOwnerTerminal(observation);
			const foreign = observeOwnerTerminal({ ...observation, owner_generation: "foreign" });
			await expect(foreign).rejects.toThrow("generation_mismatch");
			await expect(current).resolves.toMatchObject({ generation, server_key: "socket" });
		} finally {
			await fs.rm(state, { recursive: true, force: true });
		}
	});

	it("does not coalesce terminal observations from different socket authorities", async () => {
		const state = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-owner-socket-observation-"));
		try {
			const generation = await replaceOwnerGeneration(state, "session", "generation");
			const observation = {
				schema_version: 1 as const,
				op: "observe_terminal" as const,
				session_id: "session",
				owner_generation: generation,
				state_dir: state,
				socket_key: "socket-a",
				observer: "sidecar" as const,
				observed_at: "2026-01-01T00:00:01.000Z",
				signal: "EXIT" as const,
				exit_code: 0,
				exit_kind: "exit",
				reason: "sidecar",
			};
			const [first, second] = await Promise.allSettled([
				observeOwnerTerminal(observation),
				observeOwnerTerminal({ ...observation, socket_key: "socket-b" }),
			]);
			if (first.status === "fulfilled") {
				expect(second.status).toBe("rejected");
				expect(["socket-a", "socket-b"]).toContain(first.value.server_key);
				if (second.status === "rejected") expect(second.reason.message).toBe("immutable_record_conflict");
			} else {
				expect(second.status).toBe("fulfilled");
				expect(first.reason.message).toBe("immutable_record_conflict");
				if (second.status === "fulfilled") expect(["socket-a", "socket-b"]).toContain(second.value.server_key);
			}
		} finally {
			await fs.rm(state, { recursive: true, force: true });
		}
	});

	it("rejects a partial persisted verdict and still records the observed owner-loss incident", async () => {
		const state = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-owner-"));
		try {
			const generation = await replaceOwnerGeneration(state, "session", "generation");
			const paths = lifecyclePaths(state, "session", generation);
			await fs.writeFile(
				paths.verdictFile,
				JSON.stringify({
					schema_version: 1,
					generation,
					session_id: "session",
					server_key: "socket",
				}),
			);
			await expect(
				observeOwnerTerminal({
					schema_version: 1,
					op: "observe_terminal",
					session_id: "session",
					owner_generation: generation,
					state_dir: state,
					socket_key: "socket",
					observer: "sidecar",
					observed_at: "2026-01-01T00:00:01.000Z",
					signal: "SIGTERM",
					exit_code: 0,
					exit_kind: "owner_lost",
					reason: "sidecar",
				}),
			).rejects.toThrow("immutable_record_conflict");
			await expect(fs.access(paths.incidentFile)).resolves.toBeNull();
		} finally {
			await fs.rm(state, { recursive: true, force: true });
		}
	});

	it("times out while another SQLite transaction is held", async () => {
		const state = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-owner-"));
		try {
			const generation = await replaceOwnerGeneration(state, "session", "generation");
			const paths = lifecyclePaths(state, "session", generation);
			const holder = holdSqliteWriteLock(paths.lockDatabaseFile);
			try {
				await expect(
					observeOwnerTerminal({
						schema_version: 1,
						op: "observe_terminal",
						session_id: "session",
						owner_generation: generation,
						state_dir: state,
						socket_key: "socket",
						observer: "sidecar",
						observed_at: "2026-01-01T00:00:01.000Z",
						signal: "EXIT",
						exit_code: 0,
						exit_kind: "exit",
						reason: "sidecar",
					}),
				).rejects.toThrow("verdict_lock_contended");
			} finally {
				holder.close();
			}
			await expect(
				observeOwnerTerminal({
					schema_version: 1,
					op: "observe_terminal",
					session_id: "session",
					owner_generation: generation,
					state_dir: state,
					socket_key: "socket",
					observer: "sidecar",
					observed_at: "2026-01-01T00:00:01.000Z",
					signal: "EXIT",
					exit_code: 0,
					exit_kind: "exit",
					reason: "sidecar",
				}),
			).resolves.toMatchObject({ classification: "unexpected_owner_loss" });
		} finally {
			await fs.rm(state, { recursive: true, force: true });
		}
	});

	it("cancels failed and expires nonauthorizing current-generation SIGTERM intents without cleanup", async () => {
		const state = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-owner-"));
		let signals = 0;
		let cleanups = 0;
		const dependencies = {
			readStartTime: async () => "start",
			shutdown: {
				kind: "kernel_signal" as const,
				sendSigterm: async () => {
					signals += 1;
					throw new Error("dispatch_failed");
				},
			},
			waitForVerdict: async () => null,
			cleanupSession: async () => {
				cleanups += 1;
			},
		};
		const requestFor = (generation: string, expiresAt: string) => ({
			stateDir: state,
			sessionId: "session",
			generation,
			serverKey: "socket",
			pid: process.pid,
			startTime: "start",
			dispatchId: `dispatch-${generation}`,
			createdAt: "2026-01-01T00:00:00.000Z",
			expiresAt,
		});
		await replaceOwnerGeneration(state, "session", "dispatch-failure");
		await expect(
			closeExactTmuxOwner(requestFor("dispatch-failure", "2099-01-01T00:00:00.000Z"), dependencies),
		).rejects.toThrow("dispatch_failed");
		await expect(
			fs.access(`${lifecyclePaths(state, "session", "dispatch-failure").intentFile}.cancelled`),
		).resolves.toBeNull();
		await replaceOwnerGeneration(state, "session", "expired");
		await expect(
			closeExactTmuxOwner(requestFor("expired", "2020-01-01T00:00:00.000Z"), dependencies),
		).rejects.toThrow("owner_intent_invalid");
		expect(signals).toBe(1);
		expect(cleanups).toBe(0);
		await expect(fs.access(lifecyclePaths(state, "session", "expired").intentFile)).rejects.toThrow();
		for (const [generation, verdict] of [
			["null-verdict", null],
			[
				"mismatched-verdict",
				{
					schema_version: 1 as const,
					generation: "mismatched-verdict",
					session_id: "session",
					server_key: "socket",
					observed_at: "2026-01-01T00:00:00.000Z",
					signal: "SIGTERM" as const,
					exit_code: 0,
					result: "owner_term_then_session_cleanup",
					observer: "sidecar" as const,
					classification: "expected_operator_shutdown" as const,
					reason: "test",
					intent_id: "wrong-intent",
					dedupe_key: "owner-loss:session:mismatched-verdict",
				},
			],
		] as const) {
			await replaceOwnerGeneration(state, "session", generation);
			await expect(
				closeExactTmuxOwner(requestFor(generation, "2099-01-01T00:00:00.000Z"), {
					...dependencies,
					shutdown: {
						kind: "kernel_signal",
						sendSigterm: async () => {
							signals += 1;
						},
					},
					waitForVerdict: async () => verdict,
				}),
			).rejects.toThrow("owner_term_verdict_timeout");
			await expect(
				fs.access(`${lifecyclePaths(state, "session", generation).intentFile}.expired`),
			).resolves.toBeNull();
		}
		await replaceOwnerGeneration(state, "session", "replayed");
		await createOwnerIntent(state, {
			generation: "replayed",
			session_id: "session",
			server_key: "socket",
			expected_terminal: {
				signal: "SIGTERM",
				result: "owner_term_then_session_cleanup",
			},
			dispatch_id: "prior-dispatch",
			created_at: "2026-01-01T00:00:00.000Z",
			expires_at: "2099-01-01T00:00:00.000Z",
		});
		await expect(
			closeExactTmuxOwner(requestFor("replayed", "2099-01-01T00:00:00.000Z"), dependencies),
		).rejects.toThrow("owner_intent_replay");
		expect(signals).toBe(3);
		expect(cleanups).toBe(0);
		await fs.rm(state, { recursive: true, force: true });
	});

	it("publishes only when the captured generation baseline remains exact", () => {
		const state = fsSync.mkdtempSync(path.join(os.tmpdir(), "gjc-owner-generation-cas-"));
		try {
			const absent = captureOwnerGenerationBaselineSync(state, "session");
			replaceOwnerGenerationSync(state, "session", "first", absent);
			const baseline = captureOwnerGenerationBaselineSync(state, "session");
			replaceOwnerGenerationSync(state, "session", "newer", baseline);
			const current = captureOwnerGenerationBaselineSync(state, "session");
			expect(() => replaceOwnerGenerationSync(state, "session", "first", current)).toThrow("generation_replay");
			expect(() => replaceOwnerGenerationSync(state, "session", "newer", current)).toThrow("generation_replay");
			expect(() => replaceOwnerGenerationSync(state, "session", "stale", baseline)).toThrow(
				"baseline_generation_changed",
			);
			expect(captureOwnerGenerationBaselineSync(state, "session")).toMatchObject({
				state: "current",
				generation: "newer",
				session_id: "session",
				schema_version: 1,
			});
			const republished = captureOwnerGenerationBaselineSync(state, "session");
			fsSync.writeFileSync(
				lifecyclePaths(state, "session", "ignored").generationFile,
				JSON.stringify({
					schema_version: 1,
					generation: "newer",
					session_id: "session",
					published_at: "2026-01-01T00:00:00.000Z",
				}),
			);
			expect(isOwnerGenerationBaselineCurrentSync(state, "session", republished)).toBe(false);
			expect(() => replaceOwnerGenerationSync(state, "session", "stale", republished)).toThrow(
				"baseline_generation_changed",
			);
			fsSync.writeFileSync(
				lifecyclePaths(state, "session", "ignored").generationFile,
				'{"schema_version":1,"generation":"newer"}',
			);
			expect(() => captureOwnerGenerationBaselineSync(state, "session")).toThrow("baseline_generation_corrupt");
		} finally {
			fsSync.rmSync(state, { recursive: true, force: true });
		}
	});

	it("rejects noncanonical terminal observations before writing a journal or verdict", async () => {
		const state = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-owner-terminal-timestamp-"));
		try {
			await replaceOwnerGeneration(state, "session", "generation");
			const paths = lifecyclePaths(state, "session", "generation");
			await expect(
				observeOwnerTerminal({
					schema_version: 1,
					op: "observe_terminal",
					session_id: "session",
					owner_generation: "generation",
					state_dir: state,
					socket_key: "socket",
					observer: "sidecar",
					observed_at: "2026-01-01T00:00:00+01:00",
					signal: "EXIT",
					exit_code: 0,
					exit_kind: "exit",
					reason: "test",
				} as never),
			).rejects.toThrow("terminal_observation_invalid");
			await expect(fs.access(paths.journalFile)).rejects.toThrow();
			await expect(fs.access(paths.verdictFile)).rejects.toThrow();
		} finally {
			await fs.rm(state, { recursive: true, force: true });
		}
	});

	it("rejects malformed persisted verdicts even when a coherent alias could mirror them", () => {
		const verdict = {
			schema_version: 1,
			generation: "generation",
			session_id: "session",
			server_key: "socket",
			observed_at: "2026-01-01T00:00:00.000Z",
			signal: "SIGTERM",
			exit_code: null,
			result: "owner_term_then_session_cleanup",
			observer: "sidecar",
			classification: "expected_operator_shutdown",
			reason: "test",
			intent_id: "intent",
			dedupe_key: "owner-loss:session:generation",
		};
		expect(isValidOwnerVerdict(verdict)).toBe(true);
		for (const malformed of [
			{ ...verdict, schema_version: 2 },
			{ ...verdict, observer: "unknown" },
			{ ...verdict, observed_at: "not-a-timestamp" },
			{ ...verdict, observed_at: "2026-01-01T00:00:00+01:00" },
			{ ...verdict, observed_at: "2026-01-01 00:00:00Z" },
			{ ...verdict, observed_at: "2026-02-29T00:00:00Z" },
			{ ...verdict, observed_at: "2026-01-01T24:00:00Z" },
			{ ...verdict, observed_at: "2026-01-01T00:00:00.1Z" },
			{ ...verdict, dedupe_key: "wrong" },
			{ ...verdict, unexpected: true },
		])
			expect(isValidOwnerVerdict(malformed)).toBe(false);
	});

	it("keeps expired/replayed intents nonauthorizing and isolates replacement generations", async () => {
		const state = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-owner-"));
		await replaceOwnerGeneration(state, "session", "old");
		await createOwnerIntent(state, {
			generation: "old",
			session_id: "session",
			server_key: "socket",
			expected_terminal: {
				signal: "SIGTERM",
				result: "owner_term_then_session_cleanup",
			},
			dispatch_id: "dispatch",
			created_at: "2026-01-01T00:00:00.000Z",
			expires_at: "2026-01-01T00:00:00.000Z",
		});
		const replacement = await replaceOwnerGeneration(state, "session", "new");
		expect(replacement).toBe("new");
		await expect(
			observeOwnerTerminal({
				schema_version: 1,
				op: "observe_terminal",
				session_id: "session",
				owner_generation: "old",
				state_dir: state,
				socket_key: "socket",
				observer: "sidecar",
				observed_at: "2026-01-01T00:00:01.000Z",
				signal: "SIGTERM",
				exit_code: 0,
				exit_kind: "exit",
				reason: "x",
				operator_dispatch_id: "dispatch",
			}),
		).rejects.toThrow("generation_mismatch");
		await fs.rm(state, { recursive: true, force: true });
	});
	it("rejects malformed owner intents before they can authorize an expected terminal verdict", async () => {
		const state = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-owner-intent-"));
		try {
			await expect(
				createOwnerIntent(state, {
					generation: "generation",
					session_id: "session",
					server_key: "socket",
					expected_terminal: {
						signal: "SIGTERM",
						result: "owner_term_then_session_cleanup",
					},
					dispatch_id: "dispatch",
					created_at: "2026-01-01T00:01:00.000Z",
					expires_at: "2026-01-01T00:00:00.000Z",
				}),
			).rejects.toThrow("owner_intent_invalid");
		} finally {
			await fs.rm(state, { recursive: true, force: true });
		}
	});
});
