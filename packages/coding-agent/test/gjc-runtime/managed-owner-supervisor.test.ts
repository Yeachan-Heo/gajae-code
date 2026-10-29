import { describe, expect, it } from "bun:test";
import * as crypto from "node:crypto";
import * as fsSync from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	isManagedOwnerBinding,
	isManagedOwnerSigabrtReceipt,
} from "@gajae-code/coding-agent/gjc-runtime/managed-owner-binding";
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

function cleanManagedEnvironment(): NodeJS.ProcessEnv {
	const env = { ...process.env };
	for (const key of Object.keys(env)) {
		if (
			key.startsWith("GJC_MANAGED_OWNER_") ||
			key.startsWith("GJC_TMUX_OWNER_") ||
			key === "GJC_COORDINATOR_SESSION_ID"
		)
			delete env[key];
	}
	return env;
}

function startSupervisor(
	stateDir: string,
	command: string[],
	env: Record<string, string> = {},
	options: { forceMissingNativeReferenceMarker?: string; prepareRoot?: boolean } = {},
) {
	if (options.prepareRoot !== false)
		fsSync.mkdirSync(lifecyclePaths(stateDir, "session-2681", "generation-2681").root, {
			recursive: true,
			mode: 0o700,
		});
	const script = options.forceMissingNativeReferenceMarker
		? `import { appendFileSync } from "node:fs"; import { runManagedOwnerSupervisor } from ${JSON.stringify(supervisorModule)}; const originalSpawn = Bun.spawn; Bun.spawn = options => { const child = originalSpawn(options); const actualPid = child.pid; let pidReads = 0; Object.defineProperty(child, "pid", { configurable: true, get() { pidReads += 1; if (pidReads === 2) { appendFileSync(${JSON.stringify(options.forceMissingNativeReferenceMarker)}, "forced-missing-native-reference:" + actualPid + "\\n"); return 2_000_000_000; } return actualPid; } }); return child; }; try { await runManagedOwnerSupervisor(); } finally { Bun.spawn = originalSpawn; }`
		: `import { runManagedOwnerSupervisor } from ${JSON.stringify(supervisorModule)}; await runManagedOwnerSupervisor();`;
	return Bun.spawn({
		cmd: [process.execPath, "-e", script],
		cwd: repoRoot,
		stdout: "pipe",
		stderr: "pipe",
		env: {
			...cleanManagedEnvironment(),
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
	options: { forceMissingNativeReferenceMarker?: string; prepareRoot?: boolean } = {},
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

// A real supervisor rereads its binding through the owner-only reader, which is
// unsupported on Windows; Broker launches there select headless instead.
describe.skipIf(process.platform === "win32")("managed owner supervisor", () => {
	it("delivers exact whitespace arguments to a nonredacted child and preserves their binding digest", async () => {
		const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-managed-whitespace-child-"));
		try {
			const scriptFile = path.join(stateDir, "whitespace-child.ts");
			await fs.writeFile(scriptFile, "process.stdout.write(JSON.stringify(process.argv.slice(2)));\n");
			const argumentsToPreserve = [" ", "\t", "  \t  "];
			const command = [process.execPath, scriptFile, ...argumentsToPreserve];
			const result = await runSupervisor(stateDir, command);
			expect(result.exitCode, result.stderr).toBe(0);
			expect(JSON.parse(result.stdout)).toEqual(argumentsToPreserve);
			const root = lifecyclePaths(stateDir, "session-2681", "generation-2681").root;
			const files = (await fs.readdir(root)).filter(file => file.endsWith(".binding.json"));
			expect(files).toHaveLength(1);
			const binding = JSON.parse(await fs.readFile(path.join(root, files[0]!), "utf8"));
			expect(isManagedOwnerBinding(binding)).toBe(true);
			expect(binding.binding_kind).toBe("recoverable");
			expect(binding.command).toEqual(command);
			expect(binding.command_sha256).toBe(crypto.createHash("sha256").update(JSON.stringify(command)).digest("hex"));
		} finally {
			await fs.rm(stateDir, { recursive: true, force: true });
		}
	});

	it("admits an opaque supervisor child through the actual source CLI entry", async () => {
		const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-managed-cli-admission-"));
		try {
			const result = await runSupervisor(
				stateDir,
				[process.execPath, path.join(repoRoot, "packages/coding-agent/src/cli.ts"), "--version"],
				{ GJC_MANAGED_OWNER_REDACT_COMMAND: "1" },
			);
			expect(result.exitCode, result.stderr).toBe(0);
			expect(result.stdout.trim()).not.toBe("");
			const root = lifecyclePaths(stateDir, "session-2681", "generation-2681").root;
			const files = await fs.readdir(root);
			expect(files.filter(file => file.endsWith(".binding.json"))).toHaveLength(1);
			expect(files.some(file => file.startsWith("admission-handoff-") || file.startsWith("sigabrt-"))).toBe(false);
		} finally {
			await fs.rm(stateDir, { recursive: true, force: true });
		}
	});

	it("blocks spawn on exclusive creation, file-sync, directory-sync, or exact-reread failure", async () => {
		for (const fault of ["create", "file-sync", "directory-sync", "reread"]) {
			const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-managed-publication-fault-"));
			try {
				const root = lifecyclePaths(stateDir, "session-2681", "generation-2681").root;
				await fs.mkdir(root, { recursive: true, mode: 0o700 });
				const marker = path.join(stateDir, "child-started");
				const command = [
					process.execPath,
					"-e",
					`import * as fs from "node:fs"; fs.writeFileSync(${JSON.stringify(marker)}, "SECRET-FAULT-CANARY");`,
				];
				const script = `import { spyOn } from "bun:test"; import * as fs from "node:fs/promises"; import * as natives from "@gajae-code/natives"; import { runManagedOwnerSupervisor } from ${JSON.stringify(supervisorModule)};
const fault = ${JSON.stringify(fault)}; let fired = false; const originalOpen = fs.open; const spies = [];
if (fault === "reread") spies.push(spyOn(natives, "readOwnerOnlyFile").mockImplementation(() => { fired = true; return {ok: false, code: "read_failed"}; }));
else spies.push(spyOn(fs, "open").mockImplementation(async (...args) => {
 const pathname = String(args[0]); const staging = pathname.endsWith(".staging");
 if (fault === "create" && staging) { fired = true; throw new Error("SECRET-FAULT-CANARY"); }
 const handle = await originalOpen(...args);
 if ((fault === "file-sync" && staging) || (fault === "directory-sync" && pathname === ${JSON.stringify(root)})) spies.push(spyOn(handle, "sync").mockImplementation(async () => { fired = true; throw new Error("SECRET-FAULT-CANARY"); }));
 return handle;
}));
try { await runManagedOwnerSupervisor(); process.exitCode = 22; } catch { process.exitCode = 75; } finally { for (const spy of spies.reverse()) spy.mockRestore(); process.stdout.write(JSON.stringify({fired})); }`;
				const child = Bun.spawn({
					cmd: [process.execPath, "-e", script],
					cwd: repoRoot,
					stdout: "pipe",
					stderr: "pipe",
					env: {
						...cleanManagedEnvironment(),
						GJC_TMUX_OWNER_STATE_DIR: stateDir,
						GJC_COORDINATOR_SESSION_ID: "session-2681",
						GJC_TMUX_OWNER_GENERATION: "generation-2681",
						GJC_MANAGED_OWNER_RUN_ID: "run-2681",
						GJC_MANAGED_OWNER_INCARNATION: "incarnation-2681",
						GJC_MANAGED_OWNER_REDACT_COMMAND: "1",
						GJC_MANAGED_OWNER_COMMAND_JSON: JSON.stringify(command),
					},
				});
				const [stdout, stderr, exit] = await Promise.all([
					new Response(child.stdout).text(),
					new Response(child.stderr).text(),
					child.exited,
				]);
				expect(exit, stderr).toBe(75);
				expect(JSON.parse(stdout)).toEqual({ fired: true });
				expect(fsSync.existsSync(marker)).toBe(false);
				expect(stderr).not.toContain("SECRET-FAULT-CANARY");
			} finally {
				await fs.rm(stateDir, { recursive: true, force: true });
			}
		}
	});

	it("publishes private binding evidence before the first child side effect", async () => {
		const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-managed-ordering-"));
		try {
			const root = lifecyclePaths(stateDir, "session-2681", "generation-2681").root;
			const script = `import * as fs from "node:fs"; const root = ${JSON.stringify(root)}; const file = root + "/child-" + process.env.GJC_MANAGED_OWNER_CHILD_TOKEN + ".binding.json"; const record = JSON.parse(fs.readFileSync(file, "utf8")); if (record.binding_kind !== "opaque" || (fs.statSync(file).mode & 0o777) !== 0o600 || (fs.statSync(root).mode & 0o777) !== 0o700) process.exit(21); fs.writeFileSync(${JSON.stringify(path.join(stateDir, "child-started"))}, "binding-present");`;
			const result = await runSupervisor(stateDir, [process.execPath, "-e", script], {
				GJC_MANAGED_OWNER_REDACT_COMMAND: "1",
			});
			expect(result.exitCode, result.stderr).toBe(0);
			expect(await fs.readFile(path.join(stateDir, "child-started"), "utf8")).toBe("binding-present");
		} finally {
			await fs.rm(stateDir, { recursive: true, force: true });
		}
	});

	it("does not spawn or leak command errors when the lifecycle root is missing, public, or symlinked", async () => {
		const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-managed-publish-failure-"));
		const outside = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-managed-publish-outside-"));
		try {
			const root = lifecyclePaths(stateDir, "session-2681", "generation-2681").root;
			const command = [
				process.execPath,
				"-e",
				`import * as fs from "node:fs"; fs.writeFileSync(${JSON.stringify(path.join(outside, "child-started"))}, "SECRET-PUBLICATION-CANARY");`,
			];
			for (const kind of ["missing", "public", "symlink"]) {
				if (kind === "public") {
					await fs.mkdir(root, { recursive: true, mode: 0o755 });
					// mkdir modes are masked by umask; the public fixture must not depend on it.
					await fs.chmod(root, 0o755);
				}
				if (kind === "symlink") {
					await fs.rmdir(root);
					await fs.symlink(outside, root);
				}
				const result = await runSupervisor(
					stateDir,
					command,
					{ GJC_MANAGED_OWNER_REDACT_COMMAND: "1" },
					{ prepareRoot: false },
				);
				expect(result.exitCode).not.toBe(0);
				expect(result.stderr).not.toContain("SECRET-PUBLICATION-CANARY");
				expect(await fs.readdir(outside)).toEqual([]);
			}
		} finally {
			await fs.rm(stateDir, { recursive: true, force: true });
			await fs.rm(outside, { recursive: true, force: true });
		}
	});

	it.skipIf(process.platform !== "linux")(
		"never emits opaque recovery receipts in either SIGABRT exit branch",
		async () => {
			for (const forceMissing of [false, true]) {
				const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-managed-opaque-abort-"));
				try {
					const marker = path.join(stateDir, "native-reference.marker");
					const result = await runSupervisor(
						stateDir,
						fastSigabrtCommand(),
						{ GJC_MANAGED_OWNER_REDACT_COMMAND: "1" },
						forceMissing ? { forceMissingNativeReferenceMarker: marker } : {},
					);
					expect(result.exitCode, result.stderr).toBe(134);
					const root = lifecyclePaths(stateDir, "session-2681", "generation-2681").root;
					const files = await fs.readdir(root);
					expect(files.filter(file => file.endsWith(".binding.json"))).toHaveLength(1);
					expect(files.filter(file => file.endsWith(".receipt.json"))).toHaveLength(0);
					if (forceMissing)
						expect(await fs.readFile(marker, "utf8")).toContain("forced-missing-native-reference:");
				} finally {
					await fs.rm(stateDir, { recursive: true, force: true });
				}
			}
		},
	);

	it("does not interpret numeric exit 134 as SIGABRT", async () => {
		const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-managed-numeric-abort-"));
		try {
			const result = await runSupervisor(stateDir, [process.execPath, "-e", "process.exit(134)"]);
			expect(result.exitCode).toBe(134);
			expect(
				(await fs.readdir(lifecyclePaths(stateDir, "session-2681", "generation-2681").root)).filter(file =>
					file.startsWith("sigabrt-"),
				),
			).toEqual([]);
		} finally {
			await fs.rm(stateDir, { recursive: true, force: true });
		}
	});

	it("keeps opaque command bytes and derived digests out of failed-spawn artifacts and diagnostics", async () => {
		const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-managed-opaque-spawn-failure-"));
		try {
			const command = [path.join(stateDir, "MISSING-OPAQUE-COMMAND-CANARY")];
			const result = await runSupervisor(stateDir, command, { GJC_MANAGED_OWNER_REDACT_COMMAND: "1" });
			expect(result.exitCode).not.toBe(0);
			const root = lifecyclePaths(stateDir, "session-2681", "generation-2681").root;
			const files = await fs.readdir(root);
			expect(files.filter(file => file.endsWith(".binding.json"))).toHaveLength(1);
			const evidence =
				result.stdout +
				result.stderr +
				(await Promise.all(files.map(file => fs.readFile(path.join(root, file), "utf8")))).join("");
			for (const probe of [
				"MISSING-OPAQUE-COMMAND-CANARY",
				JSON.stringify(command),
				crypto.createHash("sha256").update(JSON.stringify(command)).digest("hex"),
			])
				expect(evidence).not.toContain(probe);
		} finally {
			await fs.rm(stateDir, { recursive: true, force: true });
		}
	});

	it.skipIf(process.platform !== "darwin")("does not publish recoverable SIGABRT authority on macOS", async () => {
		const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-managed-macos-abort-"));
		try {
			const result = await runSupervisor(stateDir, fastSigabrtCommand());
			expect(result.exitCode, result.stderr).toBe(134);
			const files = await fs.readdir(lifecyclePaths(stateDir, "session-2681", "generation-2681").root);
			expect(files.filter(file => file.endsWith(".binding.json"))).toHaveLength(1);
			expect(files.filter(file => file.endsWith(".receipt.json"))).toHaveLength(0);
		} finally {
			await fs.rm(stateDir, { recursive: true, force: true });
		}
	});

	it.skipIf(process.platform !== "linux")(
		"records one exact durable SIGABRT receipt and exits with the abort status",
		async () => {
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
				expect(isManagedOwnerBinding(binding)).toBe(true);
				if (!isManagedOwnerBinding(binding) || binding.binding_kind !== "recoverable")
					throw new Error("invalid fixture binding");
				expect(isManagedOwnerSigabrtReceipt(receipt, binding)).toBe(true);
				expect(files.filter(file => file.startsWith("sigabrt-")).length).toBe(1);
			} finally {
				await fs.rm(stateDir, { recursive: true, force: true });
			}
		},
	);
	it("does not persist or forward a Broker-redacted child command", async () => {
		const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-managed-owner-"));
		try {
			const command = [
				process.execPath,
				"-e",
				`import { admitManagedOwnerBeforeCli } from ${JSON.stringify(admissionModule)}; const canary = "OPAQUE-COMMAND-CANARY"; if (!process.env.GJC_MANAGED_OWNER_CHILD_TOKEN || process.env.GJC_MANAGED_OWNER_COMMAND_JSON || process.env.GJC_MANAGED_OWNER_REDACT_COMMAND) process.exit(19); if ((await admitManagedOwnerBeforeCli()).kind !== "supervised") process.exit(20);`,
			];
			const result = await runSupervisor(stateDir, command, { GJC_MANAGED_OWNER_REDACT_COMMAND: "1" });
			expect(result.exitCode, result.stderr).toBe(0);
			const root = lifecyclePaths(stateDir, "session-2681", "generation-2681").root;
			const files = await fs.readdir(root);
			const bindings = files.filter(file => file.endsWith(".binding.json"));
			expect(bindings).toHaveLength(1);
			expect(files.filter(file => file.includes("receipt"))).toEqual([]);
			const text = await fs.readFile(path.join(root, bindings[0]!), "utf8");
			const binding = JSON.parse(text);
			expect(isManagedOwnerBinding(binding)).toBe(true);
			expect(binding.binding_kind).toBe("opaque");
			for (const probe of [
				"OPAQUE-COMMAND-CANARY",
				JSON.stringify(command),
				crypto.createHash("sha256").update(JSON.stringify(command)).digest("hex"),
			]) {
				expect(text + result.stdout + result.stderr).not.toContain(probe);
			}
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
			expect(result.exitCode).toBe(23);
			const root = lifecyclePaths(stateDir, "session-2681", "generation-2681").root;
			expect((await fs.readdir(root)).some(file => file.startsWith("sigabrt-"))).toBe(false);
		} finally {
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
			expect(await supervisor.exited).toBe(0);
			expect(JSON.parse(await fs.readFile(cleanupFile, "utf8"))).toEqual({ signals: 1 });
		} finally {
			await fs.rm(stateDir, { recursive: true, force: true });
		}
	});
	it.skipIf(process.platform !== "linux")(
		"routes a replacement supervisor child through predecessor recovery before normal CLI",
		async () => {
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
		},
	);
	// Windows has no owner-only reader, so a real supervisor cannot start a child there.
	it.skipIf(process.platform === "linux" || process.platform === "win32")(
		"keeps a replacement supervisor child blocked off Linux without persisting a predecessor handoff",
		async () => {
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
				// Durable private publication needs Linux owner-only directory authority.
				expect(replacement.exitCode).toBe(75);
				expect(replacement.stdout).toContain('"kind":"blocked"');
				expect(replacement.stderr).toContain("managed_owner_admission_blocked: handoff_not_persisted");
				expect((await fs.readdir(root)).filter(file => file.startsWith("admission-handoff-"))).toEqual([]);
			} finally {
				await fs.rm(stateDir, { recursive: true, force: true });
				await fs.rm(cwd, { recursive: true, force: true });
			}
		},
	);
});
