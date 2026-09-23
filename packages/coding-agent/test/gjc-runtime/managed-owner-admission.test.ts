import { describe, expect, it } from "bun:test";
import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { sessionStateDir } from "@gajae-code/coding-agent/gjc-runtime/session-layout";
import * as managedOwnerAdmission from "../../src/gjc-runtime/managed-owner-admission";
import { lifecyclePaths } from "../../src/gjc-runtime/tmux-owner-isolation";
import { runTmuxOwnerIsolationCli } from "../../src/gjc-runtime/tmux-owner-isolation-cli";

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
] as const;

function managedOwnerEnvironment(overrides: Record<string, string> = {}): NodeJS.ProcessEnv {
	const env = { ...process.env };
	for (const name of managedOwnerEnvironmentKeys) delete env[name];
	return { ...env, ...overrides };
}
async function admit(
	stateDir: string,
	token?: string,
	platform?: NodeJS.Platform,
): Promise<{ admitted: boolean; exitCode: number; root: string; stderr: string }> {
	// The stub runs after the hoisted import on purpose: admission reads the
	// platform when it is called, while the native loader reads it while the
	// module graph evaluates and rejects any tag this host cannot supply.
	const stub = platform ? `Object.defineProperty(process, "platform", { value: ${JSON.stringify(platform)} });` : "";
	const script = `import { admitManagedOwnerBeforeCli } from ${JSON.stringify(admissionModule)}; ${stub} const admission = await admitManagedOwnerBeforeCli(); console.log(JSON.stringify({ admitted: admission.kind !== "blocked", exitCode: process.exitCode ?? 0 }));`;
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
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
		child.exited,
	]);
	return {
		...(JSON.parse(stdout) as { admitted: boolean; exitCode: number }),
		exitCode,
		root: lifecyclePaths(stateDir, "session-2681", "generation-2681").root,
		stderr,
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

describe("managed owner admission", () => {
	it("exposes no predecessor recovery mutators and excludes owner admission as a package subpath", async () => {
		expect(managedOwnerAdmission).not.toHaveProperty("admitManagedOwnerPredecessorBeforeLaunch");
		expect(managedOwnerAdmission).not.toHaveProperty("completeManagedOwnerRecovery");
		const specifiers = [
			"@gajae-code/coding-agent/gjc-runtime/managed-owner-admission",
			"@gajae-code/coding-agent/gjc-runtime/managed-owner-admission.js",
			"@gajae-code/coding-agent/gjc-runtime/tmux-owner-isolation",
			"@gajae-code/coding-agent/gjc-runtime/tmux-owner-isolation.js",
			"@gajae-code/coding-agent/gjc-runtime/tmux-owner-isolation-cli",
			"@gajae-code/coding-agent/gjc-runtime/tmux-owner-isolation-cli.js",
		];
		const source = `for (const specifier of ${JSON.stringify(specifiers)}) { try { require.resolve(specifier); process.exitCode = 1; break; } catch (error) { if (!(error && typeof error === "object" && "code" in error && error.code === "ERR_PACKAGE_PATH_NOT_EXPORTED")) { process.exitCode = 2; break; } } }`;
		const child = Bun.spawnSync(["node", "-e", source], { cwd: repoRoot, stdout: "pipe", stderr: "pipe" });
		expect(child.exitCode, Buffer.from(child.stderr).toString("utf8")).toBe(0);
		const packageManifest = (await Bun.file(
			path.join(repoRoot, "packages", "coding-agent", "package.json"),
		).json()) as {
			exports: Record<string, unknown>;
		};
		expect(packageManifest.exports["./gjc-runtime/managed-owner-admission"]).toBeNull();
		expect(packageManifest.exports["./gjc-runtime/managed-owner-admission.js"]).toBeNull();
		expect(packageManifest.exports["./gjc-runtime/tmux-owner-isolation"]).toBeNull();
		expect(packageManifest.exports["./gjc-runtime/tmux-owner-isolation.js"]).toBeNull();
		expect(packageManifest.exports["./gjc-runtime/tmux-owner-isolation-cli"]).toBeNull();
		expect(packageManifest.exports["./gjc-runtime/tmux-owner-isolation-cli.js"]).toBeNull();
	});

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
		expect(partialExitCode).not.toBe(0);
		expect(partialStderr).toContain("managed_owner_admission_metadata_invalid");
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

	it("attributes an unsupported exact binding reader to its platform while staying blocked", async () => {
		const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-managed-admission-platform-"));
		try {
			const root = lifecyclePaths(stateDir, "session-2681", "generation-2681").root;
			await writeBinding(root, "exact-token");
			// The binding is valid; only the platform guard blocks it. "sunos" is never
			// the host, so a sunos-attributed outcome also proves the stub really applied.
			for (const platform of ["sunos", "darwin"] as const) {
				const result = await admit(stateDir, "exact-token", platform);
				expect(result).toMatchObject({ admitted: false, exitCode: 75 });
				expect(result.stderr).toBe(
					`child admission blocked: exact_child_binding_unavailable (platform ${platform}: exact binding reader unsupported)\n`,
				);
			}
			const handoffs = (await fs.readdir(root)).filter(file => file.startsWith("admission-handoff-"));
			expect(handoffs).toHaveLength(2);
			const records = await Promise.all(
				handoffs.map(async file => JSON.parse(await fs.readFile(path.join(root, file), "utf8"))),
			);
			for (const record of records)
				expect(record).toMatchObject({
					state: "fail_closed_handoff",
					reason: "exact_child_binding_unavailable",
					evidence_reader: "unsupported_platform",
				});
			expect(records.map(record => record.platform).sort()).toEqual(["darwin", "sunos"]);
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

	it("rejects arbitrary predecessor admission protocol requests without changing recovery state", async () => {
		const stateDir = path.join(os.tmpdir(), `gjc-untrusted-predecessor-${crypto.randomUUID()}`);
		const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-untrusted-predecessor-cwd-"));
		try {
			const request = {
				schema_version: 1,
				op: "admit_predecessor",
				state_dir: stateDir,
				cwd,
				session_id: "session-2681",
				owner_generation: "replacement-generation-2681",
				owner_run_id: "replacement-run-2681",
				owner_incarnation: "replacement-incarnation-2681",
				predecessor_generation: "generation-2681",
				predecessor_run_id: "run-2681",
				predecessor_incarnation: "incarnation-2681",
				predecessor_token: "attacker-selected-token",
				transcript_path: path.join(cwd, "not-a-transcript.jsonl"),
			};
			const response = JSON.parse(await runTmuxOwnerIsolationCli(JSON.stringify(request))) as Record<
				string,
				unknown
			>;
			expect(response).toMatchObject({
				ok: false,
				code: "scope_unavailable",
				diagnostic: "invalid_json_line",
			});
			expect(
				await fs.access(stateDir).then(
					() => true,
					() => false,
				),
			).toBe(false);
			expect(
				await fs.access(path.join(sessionStateDir(cwd, "session-2681"), "ultragoal-owner-loss-recovery.json")).then(
					() => true,
					() => false,
				),
			).toBe(false);
			expect(
				await fs
					.access(path.join(sessionStateDir(cwd, "session-2681"), "ultragoal-owner-loss-recovery.jsonl"))
					.then(
						() => true,
						() => false,
					),
			).toBe(false);
		} finally {
			await fs.rm(cwd, { recursive: true, force: true });
		}
	});
});
