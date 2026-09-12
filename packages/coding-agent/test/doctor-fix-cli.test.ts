import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { DoctorReport } from "../src/cli/doctor/types";

const cli = path.resolve(import.meta.dir, "../src/cli.ts");
const bunConfig = path.resolve(import.meta.dir, "../src/sdk/broker/internal-source.bunfig.toml");
const roots: string[] = [];
interface Fixture {
	root: string;
	profile: string;
	project: string;
	file: string;
}

async function fixture(name: string, content: string): Promise<Fixture> {
	const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "gjc-doctor-fix-cli-")));
	roots.push(root);
	const profile = path.join(root, "profile");
	const project = path.join(root, "project");
	await fs.mkdir(profile, { mode: 0o700 });
	await fs.mkdir(project, { mode: 0o700 });
	const file = path.join(profile, name);
	await Bun.write(file, content);
	await fs.chmod(file, 0o600);
	return { root, profile, project, file };
}

async function invoke(f: Fixture, args: string[]): Promise<{ report: DoctorReport; exitCode: number; output: string }> {
	const child = Bun.spawn(
		[process.execPath, "--no-env-file", `--config=${bunConfig}`, cli, "doctor", "--json", ...args],
		{
			cwd: f.project,
			env: {
				PATH: process.env.PATH,
				HOME: f.root,
				GJC_CODING_AGENT_DIR: f.profile,
				NO_COLOR: "1",
				BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0",
			},
			stdin: "ignore",
			stdout: "pipe",
			stderr: "pipe",
		},
	);
	const timer = setTimeout(() => child.kill("SIGKILL"), 20_000);
	try {
		const [stdout, stderr, exitCode] = await Promise.all([
			new Response(child.stdout).text(),
			new Response(child.stderr).text(),
			child.exited,
		]);
		const report = JSON.parse(stdout) as DoctorReport;
		expect(report.summary.exitCode).toBe(exitCode);
		return { report, exitCode, output: stdout + stderr };
	} finally {
		clearTimeout(timer);
	}
}

async function snapshot(root: string): Promise<Record<string, string>> {
	const result: Record<string, string> = {};
	async function visit(directory: string): Promise<void> {
		for (const name of (await fs.readdir(directory)).sort()) {
			const file = path.join(directory, name);
			const stat = await fs.lstat(file, { bigint: true });
			const key = path.relative(root, file);
			if (stat.isDirectory()) {
				result[key] = `directory:${stat.mode}:${stat.ino}:${stat.mtimeNs}`;
				await visit(file);
			} else if (stat.isSymbolicLink()) result[key] = `link:${await fs.readlink(file)}`;
			else
				result[key] =
					`${stat.mode}:${stat.ino}:${stat.mtimeNs}:${new Bun.CryptoHasher("sha256").update(await Bun.file(file).arrayBuffer()).digest("hex")}`;
		}
	}
	await visit(root);
	return result;
}

afterEach(async () => {
	for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});

describe("doctor configuration CLI transactions", () => {
	test("restricts permissions without widening owner bits and makes repeat application inert", async () => {
		const f = await fixture("config.yml", "skills:\n  enabled: false\n");
		await fs.chmod(f.file, 0o444);
		const selection = ["--check", "permissions", "--scope", "user"];
		const diagnosis = await invoke(f, selection);
		const target = diagnosis.report.checks.find(check => check.id === "permissions.user.config")!;
		expect(target.evidence.mode).toBe(0o444);
		const args = [
			...selection,
			"--fix",
			"--repair",
			"permissions.restrict-owned-config",
			"--target",
			target.targetId,
			"--allow-risk",
			"permission-change",
			"--yes",
		];
		const applied = await invoke(f, args);
		expect(applied.exitCode, JSON.stringify(applied.report.repairs)).toBe(0);
		expect(applied.report.repairs[0].state).toBe("verified");
		expect((await fs.stat(f.file)).mode & 0o777).toBe(0o400);
		expect(await Bun.file(f.file).text()).toBe("skills:\n  enabled: false\n");
		const before = await snapshot(f.root);
		const repeated = await invoke(f, args);
		expect(repeated.exitCode).toBe(0);
		expect(repeated.report.repairs[0].state).toBe("not_needed");
		expect(await snapshot(f.root)).toEqual(before);
	}, 30_000);

	test("repairs one invalid boolean and proves repeated application writes nothing", async () => {
		const f = await fixture(
			"config.yml",
			"skills:\n  enabled: private-sentinel\n  enableSkillCommands: false\nother: preserve-me\n",
		);
		const selection = ["--check", "config", "--scope", "user"];
		const diagnosis = await invoke(f, selection);
		const target = diagnosis.report.checks.find(check => check.id === "config.user.skills.enabled")!;
		expect(target.health).toBe("error");
		const args = [
			...selection,
			"--fix",
			"--repair",
			"config.set-validated",
			"--target",
			target.targetId,
			"--set-value-json",
			"true",
			"--allow-risk",
			"config-change",
			"--yes",
		];
		const applied = await invoke(f, args);
		expect(
			applied.exitCode,
			JSON.stringify(
				applied.report.repairs.map(repair => ({
					state: repair.state,
					reason: repair.reasonCode,
					readiness: repair.readiness,
				})),
			),
		).toBe(0);
		expect(applied.report.repairs[0].state).toBe("verified");
		expect(applied.report.repairs[0].afterCheckIds.length).toBeGreaterThan(0);
		expect(applied.output).not.toContain("private-sentinel");
		expect(Bun.YAML.parse(await Bun.file(f.file).text())).toEqual({
			skills: { enabled: true, enableSkillCommands: false },
			other: "preserve-me",
		});
		const before = await snapshot(f.root);
		const repeated = await invoke(f, args);
		expect(repeated.exitCode).toBe(0);
		expect(repeated.report.repairs[0].state).toBe("not_needed");
		expect(await snapshot(f.root)).toEqual(before);
	}, 30_000);

	test("keeps a verified MCP field change while reporting an unchanged denylist blocker", async () => {
		const f = await fixture(
			"mcp.json",
			JSON.stringify({
				disabledServers: ["org.example"],
				mcpServers: { "org.example": { command: "never-execute-this", enabled: false, autoload: true } },
			}),
		);
		const selection = ["--check", "mcp", "--scope", "user"];
		const diagnosis = await invoke(f, selection);
		const target = diagnosis.report.checks.find(check => check.targetId.endsWith(":enabled"))!;
		const applied = await invoke(f, [
			...selection,
			"--fix",
			"--repair",
			"mcp.set-startup-policy",
			"--target",
			target.targetId,
			"--set-value-json",
			"true",
			"--allow-risk",
			"config-change",
			"--yes",
		]);
		expect(
			applied.exitCode,
			JSON.stringify(
				applied.report.repairs.map(repair => ({
					state: repair.state,
					reason: repair.reasonCode,
					readiness: repair.readiness,
				})),
			),
		).toBe(1);
		expect(applied.report.repairs[0]).toMatchObject({
			state: "verified",
			outcome: { mutationVerified: true, desiredStartupStateAchieved: false },
		});
		expect(await Bun.file(f.file).json()).toEqual({
			disabledServers: ["org.example"],
			mcpServers: { "org.example": { command: "never-execute-this", enabled: true, autoload: true } },
		});
		expect(applied.output).not.toContain("never-execute-this");
	}, 30_000);
});
