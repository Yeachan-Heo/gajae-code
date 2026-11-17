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
import { managedOwnerSupervisorChildArgv } from "@gajae-code/coding-agent/gjc-runtime/managed-owner-supervisor";
import { sessionUltragoalDir } from "@gajae-code/coding-agent/gjc-runtime/session-layout";
import {
	closeExactTmuxOwner,
	isValidOwnerVerdict,
	lifecyclePaths,
	readSecureOwnerJson,
	replaceOwnerGeneration,
} from "@gajae-code/coding-agent/gjc-runtime/tmux-owner-isolation";
import { publishOwnerIntentNoReplace } from "@gajae-code/coding-agent/gjc-runtime/tmux-sessions";
import type { Process } from "@gajae-code/natives";
import { nativeProcessBindings } from "@gajae-code/utils/native-process";

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

const postmortemModule = path.join(repoRoot, "packages", "utils", "src", "postmortem.ts");
/**
 * A Darwin child admitted through the production pre-CLI barrier, which installs its
 * cooperative shutdown handler and publishes readiness. `cleanup` runs as its
 * postmortem callback, as the CLI's own cleanup would.
 */
function admittedChildScript(cleanup: string, prelude = ""): string {
	return `import * as postmortem from ${JSON.stringify(postmortemModule)};
import { admitManagedOwnerBeforeCli } from ${JSON.stringify(admissionModule)};
import { writeFile } from "node:fs/promises";
${prelude}
// Final test containment, never a successful relay outcome.
setTimeout(() => process.exit(91), 6_000);
postmortem.register("fixture", async () => { ${cleanup} });
if ((await admitManagedOwnerBeforeCli()).kind !== "supervised") process.exit(92);
await writeFile(process.env.READY_FILE!, JSON.stringify({ pid: process.pid, ppid: process.ppid }));
setInterval(() => {}, 1_000);`;
}

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

type SupervisorOptions = {
	forceMissingNativeReferenceMarker?: string;
	prepareRoot?: boolean;
	/** Working directory of the supervisor process (its project `.env`). */
	cwd?: string;
	/** Bun runtime flags before `-e`, as the product's source launch passes them. */
	bunArgs?: string[];
};

function startSupervisor(
	stateDir: string,
	command: string[],
	env: Record<string, string> = {},
	options: SupervisorOptions = {},
) {
	if (options.prepareRoot !== false)
		fsSync.mkdirSync(lifecyclePaths(stateDir, "session-2681", "generation-2681").root, {
			recursive: true,
			mode: 0o700,
		});
	// `bun -e` drops a literal `--` from its argv, so embed the supervisor CLI arguments.
	const supervisorArgs = JSON.stringify(["--internal-managed-owner-supervisor", "--", ...command]);
	const script = options.forceMissingNativeReferenceMarker
		? `import { appendFileSync } from "node:fs"; import { runManagedOwnerSupervisor } from ${JSON.stringify(supervisorModule)}; const originalSpawn = Bun.spawn; Bun.spawn = options => { const child = originalSpawn(options); const actualPid = child.pid; let pidReads = 0; Object.defineProperty(child, "pid", { configurable: true, get() { pidReads += 1; if (pidReads === 2) { appendFileSync(${JSON.stringify(options.forceMissingNativeReferenceMarker)}, "forced-missing-native-reference:" + actualPid + "\\n"); return 2_000_000_000; } return actualPid; } }); return child; }; try { await runManagedOwnerSupervisor(${supervisorArgs}); } finally { Bun.spawn = originalSpawn; }`
		: `import { runManagedOwnerSupervisor } from ${JSON.stringify(supervisorModule)}; await runManagedOwnerSupervisor(${supervisorArgs});`;
	return Bun.spawn({
		cmd: [process.execPath, ...(options.bunArgs ?? []), "-e", script],
		cwd: options.cwd ?? repoRoot,
		stdout: "pipe",
		stderr: "pipe",
		env: {
			...cleanManagedEnvironment(),
			GJC_TMUX_OWNER_STATE_DIR: stateDir,
			GJC_COORDINATOR_SESSION_ID: "session-2681",
			GJC_TMUX_OWNER_GENERATION: "generation-2681",
			GJC_MANAGED_OWNER_RUN_ID: "run-2681",
			GJC_MANAGED_OWNER_INCARNATION: "incarnation-2681",
			// As a first launch: no generation had been published when the session was created.
			GJC_MANAGED_OWNER_LAUNCH_BASELINE: "absent",
			...env,
		},
	});
}
async function runSupervisor(
	stateDir: string,
	command: string[],
	env: Record<string, string> = {},
	options: SupervisorOptions = {},
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
				const supervisorArgs = JSON.stringify(["--internal-managed-owner-supervisor", "--", ...command]);
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
try { await runManagedOwnerSupervisor(${supervisorArgs}); process.exitCode = 22; } catch { process.exitCode = 75; } finally { for (const spy of spies.reverse()) spy.mockRestore(); process.stdout.write(JSON.stringify({fired})); }`;
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
						// As a first launch: no generation had been published when the session was created.
						GJC_MANAGED_OWNER_LAUNCH_BASELINE: "absent",
						GJC_MANAGED_OWNER_REDACT_COMMAND: "1",
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

	it("delivers empty arguments to its child and rejects only an empty executable", async () => {
		const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-managed-empty-argument-"));
		try {
			const child = `process.exit(JSON.stringify(process.argv.slice(1)) === ${JSON.stringify(JSON.stringify(["", "tail"]))} ? 0 : 9)`;
			const delivered = await runSupervisor(stateDir, [process.execPath, "-e", child, "", "tail"]);
			expect(delivered.exitCode, delivered.stderr).toBe(0);
			expect(() => managedOwnerSupervisorChildArgv(["--internal-managed-owner-supervisor", "--", ""])).toThrow(
				"managed_owner_command_invalid",
			);
			expect(() => managedOwnerSupervisorChildArgv(["--internal-managed-owner-supervisor", "--"])).toThrow(
				"managed_owner_command_invalid",
			);
			expect(() => managedOwnerSupervisorChildArgv(["--internal-managed-owner-supervisor", "gjc"])).toThrow(
				"managed_owner_command_invalid",
			);
			expect(
				managedOwnerSupervisorChildArgv(["--internal-managed-owner-supervisor", "--", "gjc", "", "--"]),
			).toEqual(["gjc", "", "--"]);
		} finally {
			await fs.rm(stateDir, { recursive: true, force: true });
		}
	});

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
	it.skipIf(process.platform !== "darwin")(
		"keeps project .env malloc variables out of the supervised child's startup environment on macOS",
		async () => {
			const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-managed-malloc-env-"));
			try {
				const workspace = path.join(stateDir, "workspace");
				await fs.mkdir(workspace);
				await fs.writeFile(
					path.join(workspace, ".env"),
					"MallocStackLogging=0\nMallocStackLoggingNoCompact=1\nGJC_F3_DOTENV_PROBE=loaded\n",
				);
				const observed = path.join(stateDir, "child-env.json");
				// The child records its own OS startup environment, as later spawns inherit it.
				const command = [
					"/bin/sh",
					"-c",
					`printf '{"malloc":"%s","noCompact":"%s","probe":"%s"}' "\${MallocStackLogging-unset}" "\${MallocStackLoggingNoCompact-unset}" "\${GJC_F3_DOTENV_PROBE-unset}" > ${JSON.stringify(observed)}`,
				];
				const environment = cleanManagedEnvironment();
				delete environment.MallocStackLogging;
				delete environment.MallocStackLoggingNoCompact;
				const result = await runSupervisor(
					stateDir,
					command,
					// The launcher's re-exec guard is inherited, so the child never scrubs itself.
					{ GJC_MALLOC_ENV_REEXEC: "1" },
					// The product's macOS source launch: no Bun dotenv autoload, cwd = workspace.
					{ cwd: workspace, bunArgs: ["--no-env-file"] },
				);
				expect(result.exitCode, result.stderr).toBe(0);
				// The project overlay did reach the supervisor (the probe passes through),
				// but the malloc variables do not reach the child.
				expect(JSON.parse(await fs.readFile(observed, "utf8"))).toEqual({
					malloc: "unset",
					noCompact: "unset",
					probe: "loaded",
				});
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
				`import { admitManagedOwnerBeforeCli } from ${JSON.stringify(admissionModule)}; const canary = "OPAQUE-COMMAND-CANARY"; if (!process.env.GJC_MANAGED_OWNER_CHILD_TOKEN || process.env.GJC_MANAGED_OWNER_REDACT_COMMAND) process.exit(19); if ((await admitManagedOwnerBeforeCli()).kind !== "supervised") process.exit(20);`,
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

	it("keeps a child supervised after it copies its genuine token or whole tuple into the project .env", async () => {
		for (const names of [
			["GJC_MANAGED_OWNER_CHILD_TOKEN"],
			[
				"GJC_MANAGED_OWNER_CHILD_TOKEN",
				"GJC_TMUX_OWNER_STATE_DIR",
				"GJC_COORDINATOR_SESSION_ID",
				"GJC_TMUX_OWNER_GENERATION",
				"GJC_MANAGED_OWNER_RUN_ID",
				"GJC_MANAGED_OWNER_INCARNATION",
				"GJC_MANAGED_OWNER_LAUNCH_BASELINE",
			],
		]) {
			const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-managed-dotenv-reflect-"));
			try {
				const workspace = path.join(stateDir, "workspace");
				await fs.mkdir(workspace);
				// Equality with a dotenv value is not provenance: the inherited owner context
				// still selects exact binding verification instead of an ordinary fresh start.
				const command = [
					process.execPath,
					"-e",
					`import { writeFileSync } from "node:fs"; import { admitManagedOwnerBeforeCli } from ${JSON.stringify(admissionModule)};
writeFileSync(".env", ${JSON.stringify(names)}.map(name => name + "=" + process.env[name]).join("\\n") + "\\n");
if ((await admitManagedOwnerBeforeCli()).kind !== "supervised") process.exit(20);
if (!process.env.GJC_MANAGED_OWNER_CHILD_TOKEN) process.exit(21);`,
				];
				const result = await runSupervisor(stateDir, command, {}, { cwd: workspace });
				expect(result.exitCode, `${names.length} names: ${result.stderr}`).toBe(0);
				const dotenv = await fs.readFile(path.join(workspace, ".env"), "utf8");
				expect(dotenv).toMatch(/^GJC_MANAGED_OWNER_CHILD_TOKEN=[0-9a-f-]{36}$/m);
			} finally {
				await fs.rm(stateDir, { recursive: true, force: true });
			}
		}
	});

	it("never reads project dotenv layers during supervised admission", async () => {
		const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-managed-dotenv-fifo-"));
		const workspace = path.join(stateDir, "workspace");
		const fifo = path.join(workspace, ".env");
		const ready = path.join(stateDir, "ready");
		let supervisor: ReturnType<typeof startSupervisor> | undefined;
		let output: Promise<[string, string]> | undefined;
		// The child inherits the supervisor's stdout and stderr, so both streams end
		// only once the supervisor and its child have exited. No pid is signalled.
		const stopAll = async (): Promise<boolean> => {
			supervisor?.kill("SIGKILL");
			if (!output) return true;
			let closed = false;
			void output.then(() => {
				closed = true;
			});
			const giveUpAt = Date.now() + 15_000;
			while (!closed && Date.now() < giveUpAt) {
				// Release a child blocked opening the FIFO so its own exit timer can run.
				try {
					fsSync.closeSync(fsSync.openSync(fifo, fsSync.constants.O_WRONLY | fsSync.constants.O_NONBLOCK));
				} catch {}
				await Bun.sleep(100);
			}
			return closed;
		};
		try {
			await fs.mkdir(workspace);
			// A FIFO blocks any unbounded read; admission must decide from its inherited context.
			// The exit timer is armed before the admission module loads.
			const command = [
				process.execPath,
				"-e",
				`setTimeout(() => process.exit(91), 10_000);
const { writeFileSync } = await import("node:fs");
const { admitManagedOwnerBeforeCli } = await import(${JSON.stringify(admissionModule)});
if (Bun.spawnSync(["mkfifo", ".env"]).exitCode !== 0) process.exit(19);
writeFileSync(${JSON.stringify(ready)}, "ready");
if ((await admitManagedOwnerBeforeCli()).kind !== "supervised") process.exit(20);
process.exit(0);`,
			];
			supervisor = startSupervisor(stateDir, command, {}, { cwd: workspace });
			output = Promise.all([new Response(supervisor.stdout).text(), new Response(supervisor.stderr).text()]);
			let supervisorExited = false;
			void supervisor.exited.then(() => {
				supervisorExited = true;
			});
			// Readiness is written just before admission, so import time is not timed.
			const readyBy = Date.now() + 15_000;
			while (!fsSync.existsSync(ready) && !supervisorExited && Date.now() < readyBy) await Bun.sleep(20);
			expect(fsSync.existsSync(ready)).toBe(true);
			// The supervisor exits only after its child, so this bounds the child's admission.
			const blocked =
				(await Promise.race([supervisor.exited, Bun.sleep(3_000).then(() => "timeout" as const)])) === "timeout";
			const exitCode = blocked ? null : await supervisor.exited;
			expect(await stopAll()).toBe(true);
			expect({ blocked, exitCode }, (await output)[1]).toEqual({ blocked: false, exitCode: 0 });
		} finally {
			await stopAll();
			await fs.rm(stateDir, { recursive: true, force: true });
		}
	}, 45_000);

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
	it.each(
		process.platform === "darwin" ? ["os-signal", "cooperative", "cooperative-os-race"] : ["os-signal"],
	)("relays one SIGTERM to its exact child and waits for child cleanup: %s", async mode => {
		const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-managed-owner-"));
		const readyFile = path.join(stateDir, "child-ready");
		const cleanupFile = path.join(stateDir, "child-cleanup.json");
		let supervisor: Bun.Subprocess | undefined;
		let childReference: Process | null = null;
		let supervisorExited = false;
		let relayVerified = false;
		let closing: Promise<unknown> | undefined;
		const failures: unknown[] = [];
		try {
			await replaceOwnerGeneration(stateDir, "session-2681", "generation-2681");
			// A cooperative relay reaches the child through its admitted handler, which
			// ends it through the postmortem SIGTERM shutdown (exit 143).
			const childScript =
				mode === "os-signal"
					? `import { writeFile } from "node:fs/promises";
let signals = 0;
// Final test containment, never a successful relay outcome.
setTimeout(() => process.exit(91), 6_000);
process.on("SIGTERM", () => {
	signals += 1;
	void writeFile(process.env.CLEANUP_FILE!, JSON.stringify({ signals })).then(() => {
		setTimeout(() => process.exit(0), 300);
	});
});
await writeFile(process.env.READY_FILE!, JSON.stringify({ pid: process.pid, ppid: process.ppid }));
setInterval(() => {}, 1_000);`
					: admittedChildScript(
							"signals += 1; await writeFile(process.env.CLEANUP_FILE!, JSON.stringify({ signals })); await Bun.sleep(300);",
							"let signals = 0;",
						);
			const childExit = mode === "os-signal" ? 0 : 143;
			supervisor = startSupervisor(stateDir, [process.execPath, "-e", childScript], {
				READY_FILE: readyFile,
				CLEANUP_FILE: cleanupFile,
				GJC_TMUX_OWNER_SERVER_KEY: "fixture-socket",
			});
			void supervisor.exited.then(() => {
				supervisorExited = true;
			});
			await waitForFile(readyFile);
			const ready = JSON.parse(await fs.readFile(readyFile, "utf8")) as { pid: number; ppid: number };
			expect(ready.ppid).toBe(supervisor.pid);
			childReference = nativeProcessBindings().Process.fromPid(ready.pid);
			expect(childReference?.ppid).toBe(supervisor.pid);
			expect(childReference?.incarnation).toBeTruthy();
			if (mode === "os-signal") supervisor.kill("SIGTERM");
			else {
				const ownedSupervisor = supervisor;
				const paths = lifecyclePaths(stateDir, "session-2681", "generation-2681");
				const bindingFile = (await fs.readdir(paths.root)).find(file => file.endsWith(".binding.json"))!;
				const binding = readSecureOwnerJson(path.join(paths.root, bindingFile));
				if (!isManagedOwnerBinding(binding)) throw new Error("fixture_binding_invalid");
				const nativeSupervisor = nativeProcessBindings().Process.fromPid(supervisor.pid);
				closing = closeExactTmuxOwner(
					{
						stateDir,
						sessionId: binding.session_id,
						generation: binding.generation,
						serverKey: "fixture-socket",
						pid: binding.supervisor_pid,
						startTime: binding.supervisor_start_time,
						dispatchId: "fixture-dispatch",
						createdAt: new Date().toISOString(),
						expiresAt: new Date(Date.now() + 3_000).toISOString(),
					},
					{
						readStartTime: async () => nativeSupervisor?.incarnation ?? null,
						shutdown: {
							kind: "cooperative_intent",
							publishNoReplace: publishOwnerIntentNoReplace,
							assertCooperativeOwner: () => {
								expect(nativeSupervisor?.incarnation).toBe(binding.supervisor_start_time);
								expect(readSecureOwnerJson(path.join(paths.root, bindingFile))).toEqual(binding);
							},
						},
						waitForVerdict: async intent => {
							const exit = await Promise.race([ownedSupervisor.exited, Bun.sleep(3_000).then(() => null)]);
							expect(exit).toBe(childExit);
							// The supervisor reconciled the child's own exit after the relay.
							expect(readSecureOwnerJson(paths.childExitFile)).toMatchObject({
								intent_id: intent.intent_id,
								child_pid: ready.pid,
								signal: null,
								exit_code: 143,
								explained: true,
							});
							expect(readSecureOwnerJson(paths.shutdownCauseFile)).toMatchObject({
								cause: "cooperative",
								child_pid: ready.pid,
							});
							const verdict = readSecureOwnerJson(paths.verdictFile);
							if (!isValidOwnerVerdict(verdict) || verdict.intent_id !== intent.intent_id) return null;
							expect(readSecureOwnerJson(paths.verdictAliasFile)).toEqual({
								...verdict,
								owner_generation: binding.generation,
							});
							return verdict;
						},
						cleanupSession: async () => {
							expect(supervisorExited).toBe(true);
						},
					},
				);
				void closing.catch(() => {});
				if (mode === "cooperative-os-race") {
					await waitForFile(paths.intentFile);
					supervisor.kill("SIGTERM");
				}
			}
			await waitForFile(cleanupFile);
			const supervisorPid = supervisor.pid;
			expect(() => process.kill(supervisorPid, 0)).not.toThrow();
			supervisor.kill("SIGTERM");
			const exit = await Promise.race([supervisor.exited, Bun.sleep(2_000).then(() => null)]);
			expect(exit).toBe(childExit);
			if (closing) await closing;
			expect(await childReference?.waitForExit({ timeoutMs: 1_000 })).toBe(true);
			expect(JSON.parse(await fs.readFile(cleanupFile, "utf8"))).toEqual({ signals: 1 });
			expect(
				(await fs.readdir(lifecyclePaths(stateDir, "session-2681", "generation-2681").root)).some(file =>
					file.startsWith("sigabrt-"),
				),
			).toBe(false);
			relayVerified = true;
		} catch (error) {
			failures.push(error);
		} finally {
			try {
				if (supervisor && !supervisorExited) {
					try {
						supervisor.kill("SIGTERM");
					} catch {}
				}
				// Retain exact child evidence even if the normal ready assertion failed.
				if (!childReference && supervisor) {
					try {
						const ready = JSON.parse(await fs.readFile(readyFile, "utf8")) as { pid: number; ppid: number };
						const candidate = nativeProcessBindings().Process.fromPid(ready.pid);
						if (ready.ppid === supervisor.pid && candidate?.ppid === supervisor.pid) childReference = candidate;
					} catch {}
				}
				const childExited = childReference ? await childReference.waitForExit({ timeoutMs: 8_000 }) : false;
				if (closing) await closing.catch(() => {});
				if (supervisor && childExited && !supervisorExited) {
					// Only after separately proving child exit may parent teardown escalate.
					try {
						supervisor.kill("SIGKILL");
					} catch {}
					await Promise.race([supervisor.exited, Bun.sleep(1_000)]);
				}
				if (relayVerified && childExited && supervisorExited)
					await fs.rm(stateDir, { recursive: true, force: true });
				else if (!childExited || !supervisorExited)
					failures.push(new Error(`managed_owner_test_cleanup_unproven:${stateDir}`));
			} catch (error) {
				failures.push(error);
			}
		}
		if (failures.length > 0) throw new AggregateError(failures, "Managed supervisor verification or teardown failed");
	}, 20_000);
	it.skipIf(process.platform !== "darwin")(
		"never relays to a child whose shutdown began before admission",
		async () => {
			const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-managed-owner-"));
			const readyFile = path.join(stateDir, "child-ready");
			let supervisor: Bun.Subprocess | undefined;
			try {
				await replaceOwnerGeneration(stateDir, "session-2681", "generation-2681");
				// The unrelated SIGTERM starts a slow postmortem cleanup before admission
				// could install any cause recorder.
				const childScript = admittedChildScript(
					"",
					'postmortem.register("slow", () => Bun.sleep(1_500)); process.kill(process.pid, "SIGTERM"); await Bun.sleep(50);',
				);
				supervisor = startSupervisor(stateDir, [process.execPath, "-e", childScript], {
					READY_FILE: readyFile,
					GJC_TMUX_OWNER_SERVER_KEY: "fixture-socket",
				});
				const ownedSupervisor = supervisor;
				await waitForFile(readyFile);
				const paths = lifecyclePaths(stateDir, "session-2681", "generation-2681");
				expect(fsSync.existsSync(paths.cooperativeReadyFile)).toBe(false);
				const bindingFile = (await fs.readdir(paths.root)).find(file => file.endsWith(".binding.json"))!;
				const binding = readSecureOwnerJson(path.join(paths.root, bindingFile));
				if (!isManagedOwnerBinding(binding)) throw new Error("fixture_binding_invalid");
				const nativeSupervisor = nativeProcessBindings().Process.fromPid(supervisor.pid);
				const closing = closeExactTmuxOwner(
					{
						stateDir,
						sessionId: binding.session_id,
						generation: binding.generation,
						serverKey: "fixture-socket",
						pid: binding.supervisor_pid,
						startTime: binding.supervisor_start_time,
						dispatchId: "fixture-dispatch",
						createdAt: new Date().toISOString(),
						expiresAt: new Date(Date.now() + 3_000).toISOString(),
					},
					{
						readStartTime: async () => nativeSupervisor?.incarnation ?? null,
						shutdown: {
							kind: "cooperative_intent",
							publishNoReplace: publishOwnerIntentNoReplace,
							assertCooperativeOwner: () => {},
						},
						waitForVerdict: async () => {
							await Promise.race([ownedSupervisor.exited, Bun.sleep(3_000)]);
							const verdict = readSecureOwnerJson(paths.verdictFile);
							return isValidOwnerVerdict(verdict) ? verdict : null;
						},
						cleanupSession: async () => {},
					},
				);
				await expect(closing).rejects.toThrow("owner_term_verdict_timeout");
				expect(await ownedSupervisor.exited).toBe(143);
				// The pending intent was never relayed, so nothing can claim the shutdown.
				expect(fsSync.existsSync(paths.relayFile)).toBe(false);
				expect(fsSync.existsSync(paths.relayPendingFile)).toBe(false);
				expect(fsSync.existsSync(paths.childExitFile)).toBe(false);
			} finally {
				if (supervisor && supervisor.exitCode === null && supervisor.signalCode === null)
					supervisor.kill("SIGTERM");
				await fs.rm(stateDir, { recursive: true, force: true });
			}
		},
		20_000,
	);
	it.skipIf(process.platform !== "darwin")(
		"never attributes a shutdown an unrelated SIGTERM began to a later cooperative relay",
		async () => {
			const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-managed-owner-"));
			const readyFile = path.join(stateDir, "child-ready");
			const cleanupFile = path.join(stateDir, "child-cleanup");
			let supervisor: Bun.Subprocess | undefined;
			try {
				await replaceOwnerGeneration(stateDir, "session-2681", "generation-2681");
				// A slow cleanup keeps the child running and relayable after the SIGTERM.
				const childScript = admittedChildScript(
					`await writeFile(process.env.CLEANUP_FILE!, "started"); await Bun.sleep(1_500);`,
				);
				supervisor = startSupervisor(stateDir, [process.execPath, "-e", childScript], {
					READY_FILE: readyFile,
					CLEANUP_FILE: cleanupFile,
					GJC_TMUX_OWNER_SERVER_KEY: "fixture-socket",
				});
				const ownedSupervisor = supervisor;
				await waitForFile(readyFile);
				const ready = JSON.parse(await fs.readFile(readyFile, "utf8")) as { pid: number };
				process.kill(ready.pid, "SIGTERM");
				await waitForFile(cleanupFile);
				const paths = lifecyclePaths(stateDir, "session-2681", "generation-2681");
				const bindingFile = (await fs.readdir(paths.root)).find(file => file.endsWith(".binding.json"))!;
				const binding = readSecureOwnerJson(path.join(paths.root, bindingFile));
				if (!isManagedOwnerBinding(binding)) throw new Error("fixture_binding_invalid");
				const nativeSupervisor = nativeProcessBindings().Process.fromPid(supervisor.pid);
				let published: unknown = null;
				const closing = closeExactTmuxOwner(
					{
						stateDir,
						sessionId: binding.session_id,
						generation: binding.generation,
						serverKey: "fixture-socket",
						pid: binding.supervisor_pid,
						startTime: binding.supervisor_start_time,
						dispatchId: "fixture-dispatch",
						createdAt: new Date().toISOString(),
						expiresAt: new Date(Date.now() + 4_000).toISOString(),
					},
					{
						readStartTime: async () => nativeSupervisor?.incarnation ?? null,
						shutdown: {
							kind: "cooperative_intent",
							publishNoReplace: publishOwnerIntentNoReplace,
							assertCooperativeOwner: () => {},
						},
						waitForVerdict: async () => {
							await Promise.race([ownedSupervisor.exited, Bun.sleep(4_000)]);
							published = readSecureOwnerJson(paths.verdictFile);
							return isValidOwnerVerdict(published) ? published : null;
						},
						cleanupSession: async () => {},
					},
				);
				await expect(closing).rejects.toThrow("owner_term_verdict_timeout");
				expect(await ownedSupervisor.exited).toBe(143);
				// The relay was delivered while the child was still shutting down ...
				expect(readSecureOwnerJson(paths.relayFile)).toMatchObject({ dispatch_id: "fixture-dispatch" });
				// ... but the child had already handled the unrelated SIGTERM first.
				expect(readSecureOwnerJson(paths.shutdownCauseFile)).toMatchObject({
					child_pid: ready.pid,
					cause: "signal",
					signal: "SIGTERM",
				});
				expect(readSecureOwnerJson(paths.childExitFile)).toMatchObject({
					child_pid: ready.pid,
					signal: null,
					exit_code: 143,
					explained: false,
				});
				expect(published).toMatchObject({ classification: "unexpected_owner_loss" });
				expect(published).not.toHaveProperty("intent_id");
			} finally {
				if (supervisor && supervisor.exitCode === null && supervisor.signalCode === null)
					supervisor.kill("SIGTERM");
				await fs.rm(stateDir, { recursive: true, force: true });
			}
		},
		20_000,
	);
	it.skipIf(process.platform !== "darwin").each([
		["SIGABRT before any verdict of its own", false, "abort"],
		["SIGABRT after its own expected verdict", true, "abort"],
		["a failure exit after its own expected verdict", true, "exit-1"],
	] as const)(
		"preserves an unexplained child exit after a cooperative relay as owner loss: %s",
		async (_case, publishVerdict, fault) => {
			const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-managed-owner-"));
			const readyFile = path.join(stateDir, "child-ready");
			const childVerdictFile = path.join(stateDir, "child-verdict.json");
			let supervisor: Bun.Subprocess | undefined;
			try {
				await replaceOwnerGeneration(stateDir, "session-2681", "generation-2681");
				// The relay starts the child's shutdown; it optionally publishes the expected
				// verdict its sidecar would, then dies of an unrelated fault mid-cleanup.
				const childScript = admittedChildScript(
					`if (process.env.PUBLISH_VERDICT === "1") {
	const env = process.env;
	const paths = lifecyclePaths(env.GJC_TMUX_OWNER_STATE_DIR!, env.GJC_COORDINATOR_SESSION_ID!, env.GJC_TMUX_OWNER_GENERATION!);
	// The sidecar's capture saw this relay; wait out its confirmation under the lock.
	let relay: { dispatch_id: string } | null = null;
	for (let attempt = 0; !relay && attempt < 200; attempt += 1) {
		try { relay = readSecureOwnerJson(paths.relayFile) as { dispatch_id: string }; } catch { await Bun.sleep(5); }
	}
	const verdict = await observeOwnerTerminal({ schema_version: 1, op: "observe_terminal", session_id: env.GJC_COORDINATOR_SESSION_ID!, owner_generation: env.GJC_TMUX_OWNER_GENERATION!, state_dir: env.GJC_TMUX_OWNER_STATE_DIR!, socket_key: env.GJC_TMUX_OWNER_SERVER_KEY!, observer: "sidecar", observed_at: new Date().toISOString(), signal: "SIGTERM", exit_code: null, exit_kind: "SIGTERM", reason: "process_postmortem", operator_dispatch_id: relay?.dispatch_id });
	await writeFile(env.CHILD_VERDICT_FILE!, JSON.stringify(verdict));
}
if (process.env.FAULT === "exit-1") process.exit(1);
process.kill(process.pid, "SIGABRT");`,
					`import { lifecyclePaths, observeOwnerTerminal, readSecureOwnerJson } from ${JSON.stringify(path.join(repoRoot, "packages", "coding-agent", "src", "gjc-runtime", "tmux-owner-isolation.ts"))};`,
				);
				supervisor = startSupervisor(stateDir, [process.execPath, "-e", childScript], {
					READY_FILE: readyFile,
					CHILD_VERDICT_FILE: childVerdictFile,
					PUBLISH_VERDICT: publishVerdict ? "1" : "0",
					FAULT: fault,
					GJC_TMUX_OWNER_SERVER_KEY: "fixture-socket",
				});
				const ownedSupervisor = supervisor;
				await waitForFile(readyFile);
				const paths = lifecyclePaths(stateDir, "session-2681", "generation-2681");
				const bindingFile = (await fs.readdir(paths.root)).find(file => file.endsWith(".binding.json"))!;
				const binding = readSecureOwnerJson(path.join(paths.root, bindingFile));
				if (!isManagedOwnerBinding(binding)) throw new Error("fixture_binding_invalid");
				const nativeSupervisor = nativeProcessBindings().Process.fromPid(supervisor.pid);
				let published: unknown = null;
				let cleanups = 0;
				const closing = closeExactTmuxOwner(
					{
						stateDir,
						sessionId: binding.session_id,
						generation: binding.generation,
						serverKey: "fixture-socket",
						pid: binding.supervisor_pid,
						startTime: binding.supervisor_start_time,
						dispatchId: "fixture-dispatch",
						createdAt: new Date().toISOString(),
						expiresAt: new Date(Date.now() + 3_000).toISOString(),
					},
					{
						readStartTime: async () => nativeSupervisor?.incarnation ?? null,
						shutdown: {
							kind: "cooperative_intent",
							publishNoReplace: publishOwnerIntentNoReplace,
							assertCooperativeOwner: () => {},
						},
						waitForVerdict: async () => {
							await Promise.race([ownedSupervisor.exited, Bun.sleep(3_000)]);
							published = readSecureOwnerJson(paths.verdictFile);
							return isValidOwnerVerdict(published) ? published : null;
						},
						cleanupSession: async () => {
							cleanups += 1;
						},
					},
				);
				await expect(closing).rejects.toThrow(
					publishVerdict ? "owner_term_child_exit_unexplained" : "owner_term_verdict_timeout",
				);
				expect(cleanups).toBe(0);
				expect(await ownedSupervisor.exited).toBe(fault === "abort" ? 134 : 1);
				const ready = JSON.parse(await fs.readFile(readyFile, "utf8")) as { pid: number };
				// The supervisor's reconciliation of the actual exit outranks any verdict.
				expect(readSecureOwnerJson(paths.childExitFile)).toMatchObject({
					child_pid: ready.pid,
					dispatch_id: "fixture-dispatch",
					signal: fault === "abort" ? "SIGABRT" : null,
					exit_code: fault === "abort" ? null : 1,
					explained: false,
				});
				expect(readSecureOwnerJson(paths.incidentFile)).toMatchObject({
					classification: "unexpected_owner_loss",
					dedupe_key: "owner-loss:session-2681:generation-2681",
				});
				if (publishVerdict) {
					// The child's own verdict was expected and remains immutable history.
					expect(JSON.parse(await fs.readFile(childVerdictFile, "utf8"))).toMatchObject({
						classification: "expected_operator_shutdown",
					});
					expect(published).toMatchObject({ classification: "expected_operator_shutdown" });
				} else {
					expect(published).toMatchObject({
						classification: "unexpected_owner_loss",
						signal: "UNKNOWN",
						exit_code: 134,
					});
					expect(published).not.toHaveProperty("intent_id");
				}
			} finally {
				if (supervisor && supervisor.exitCode === null && supervisor.signalCode === null)
					supervisor.kill("SIGTERM");
				await fs.rm(stateDir, { recursive: true, force: true });
			}
		},
		20_000,
	);
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
