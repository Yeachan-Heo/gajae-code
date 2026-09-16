import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { artifactTargetId, resolveDoctorRoot } from "../src/cli/doctor/ids";
import type { DoctorReport } from "../src/cli/doctor/types";

const cli = path.resolve(import.meta.dir, "../src/cli.ts");
const brokerSource = path.resolve(import.meta.dir, "../src/sdk/broker/broker.ts");
const bunConfig = path.resolve(import.meta.dir, "../src/sdk/broker/internal-source.bunfig.toml");
const roots: string[] = [];
const children: Bun.Subprocess<"ignore", "pipe", "pipe">[] = [];
interface Fixture {
	root: string;
	profile: string;
	project: string;
	env: Record<string, string | undefined>;
}
async function fixture(): Promise<Fixture> {
	const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "doctor-stale-cli-")));
	roots.push(root);
	const profile = path.join(root, "profile");
	const project = path.join(root, "project");
	await fs.mkdir(profile, { mode: 0o700 });
	await fs.mkdir(project, { mode: 0o700 });
	return {
		root,
		profile,
		project,
		env: {
			PATH: process.env.PATH,
			HOME: root,
			GJC_CODING_AGENT_DIR: profile,
			BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0",
			NO_COLOR: "1",
		},
	};
}
async function invoke(f: Fixture, args: string[]): Promise<{ report: DoctorReport; output: string; code: number }> {
	const child = Bun.spawn(
		[process.execPath, "--no-env-file", `--config=${bunConfig}`, cli, "doctor", "--json", ...args],
		{
			cwd: f.project,
			env: f.env,
			stdin: "ignore",
			stdout: "pipe",
			stderr: "pipe",
		},
	);
	children.push(child);
	const timer = setTimeout(() => child.kill("SIGKILL"), 20_000);
	try {
		const [stdout, stderr, code] = await Promise.all([
			new Response(child.stdout).text(),
			new Response(child.stderr).text(),
			child.exited,
		]);
		const report = JSON.parse(stdout) as DoctorReport;
		expect(report.summary.exitCode).toBe(code);
		return { report, output: stdout + stderr, code };
	} finally {
		clearTimeout(timer);
	}
}
async function owner(f: Fixture): Promise<Bun.Subprocess<"ignore", "pipe", "pipe">> {
	const script = path.join(f.project, "owner.ts");
	await Bun.write(
		script,
		`import { Broker } from ${JSON.stringify(brokerSource)};\nconst broker = new Broker({agentDir: ${JSON.stringify(f.profile)}});\nawait broker.start();\nprocess.stdout.write("ready\\n");\n`,
	);
	const child = Bun.spawn([process.execPath, "--no-env-file", `--config=${bunConfig}`, script], {
		cwd: f.project,
		env: f.env,
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
	});
	children.push(child);
	const reader = child.stdout.getReader();
	const timer = setTimeout(() => child.kill("SIGKILL"), 10_000);
	try {
		const first = await reader.read();
		if (first.done) throw new Error(await new Response(child.stderr).text());
		expect(new TextDecoder().decode(first.value)).toContain("ready");
	} finally {
		clearTimeout(timer);
		reader.releaseLock();
	}
	return child;
}
afterEach(async () => {
	for (const child of children.splice(0)) {
		if (child.exitCode === null) child.kill("SIGKILL");
		await child.exited;
	}
	for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});

describe("doctor exact stale artifact CLI", () => {
	test("known absent artifact is a no-op without creating service or journal directories", async () => {
		const f = await fixture();
		const target = artifactTargetId(resolveDoctorRoot("agent", f.profile).rootId, "broker", "discovery");
		const result = await invoke(f, [
			"--fix",
			"--repair",
			"service.detach-owned-stale-artifact",
			"--target",
			target,
			"--allow-risk",
			"artifact-detach",
			"--yes",
			"--check",
			"service",
		]);
		expect(result.code).toBe(0);
		expect(result.report.repairs[0].state).toBe("not_needed");
		expect(await fs.readdir(f.profile)).toEqual([]);
	});

	test("a real live owner is not stale, then only its selected discovery is retained after confirmed exit", async () => {
		const f = await fixture();
		const child = await owner(f);
		const discoveryPath = path.join(f.profile, "sdk", "broker.json");
		const ownerPath = path.join(f.profile, "sdk", "broker.lock", "owner.json");
		const ownerRecord = await Bun.file(ownerPath).text();
		const target = artifactTargetId(resolveDoctorRoot("agent", f.profile).rootId, "broker", "discovery");
		const args = [
			"--fix",
			"--repair",
			"service.detach-owned-stale-artifact",
			"--target",
			target,
			"--allow-risk",
			"artifact-detach",
			"--yes",
			"--check",
			"service",
		];
		const live = await invoke(f, args);
		expect(live.code, JSON.stringify(live.report.repairs)).toBe(3);
		expect(live.report.repairs[0].reasonCode).toBe("owner_death_unproven");
		child.kill("SIGKILL");
		await child.exited;
		const original = await Bun.file(discoveryPath).text();
		const before = await fs.lstat(discoveryPath, { bigint: true });
		const applied = await invoke(f, args);
		expect(applied.code, JSON.stringify(applied.report.repairs)).toBe(0);
		expect(applied.report.repairs[0].state).toBe("verified");
		expect(await Bun.file(discoveryPath).exists()).toBe(false);
		const quarantine = path.join(f.profile, "sdk", `.broker.json.doctor-${applied.report.runId}`);
		expect((await fs.lstat(quarantine, { bigint: true })).ino).toBe(before.ino);
		expect(await Bun.file(quarantine).text()).toBe(original);
		expect(await Bun.file(ownerPath).text()).toBe(ownerRecord);
		expect(applied.output).not.toContain(JSON.parse(original).token);
	}, 30_000);
});
