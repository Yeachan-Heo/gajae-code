import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { parse } from "yaml";

/**
 * Minimal contract regressions for the Observation CI failures (#6019).
 *
 * Two product boundaries are observed here:
 *  - `embed-native --reset` restores the constant null stub without consulting the
 *    provenance gate, while a normal embedding still refuses untrusted bytes before
 *    mutating the generated file.
 *  - The dev affected-native producer transports the provenance sidecars it wrote, and
 *    every native-consuming shard rebuilds and verifies the trusted record before it
 *    executes anything that can load the addon.
 */

const root = path.resolve(import.meta.dir, "..");
const workflowPath = path.join(root, ".github/workflows/dev-ci.yml");

interface WorkflowStep {
	name?: string;
	run?: string;
	if?: string;
	with?: { path?: string };
}

interface WorkflowJob {
	steps?: WorkflowStep[];
}

interface Workflow {
	jobs: Record<string, WorkflowJob>;
}

async function readWorkflow(): Promise<Workflow> {
	return parse(await Bun.file(workflowPath).text()) as Workflow;
}

async function fixture(action: (dir: string, native: string) => Promise<void>): Promise<void> {
	const dir = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), "gjc-observation-ci-regression-"));
	try {
		const native = path.join(dir, "packages/natives/native");
		await fs.mkdir(native, { recursive: true });
		await fs.mkdir(path.join(dir, "packages/natives/scripts"), { recursive: true });
		await fs.mkdir(path.join(dir, "scripts"), { recursive: true });
		for (const file of [
			"packages/natives/scripts/embed-native.ts",
			"packages/natives/scripts/embed-guard.ts",
			"scripts/verify-diagnostic-artifact-provenance.ts",
		]) {
			await fs.copyFile(path.join(root, file), path.join(dir, file));
		}
		await Bun.write(path.join(dir, "packages/natives/package.json"), JSON.stringify({ version: "1.0.0-fixture" }));
		await Bun.write(
			path.join(native, "diagnostic-artifact.json"),
			JSON.stringify({ schema: "gjc.diagnostic-artifact", version: "1.0.0-fixture", artifacts: {} }),
		);
		// Deliberately invalid bytes: the fixture must never let this execute.
		await Bun.write(path.join(native, "pi_natives.linux-x64-baseline.node"), "NOT AN ADDON -- MUST NEVER EXECUTE");
		await Bun.write(path.join(native, "embedded-addon.js"), "export const embeddedAddon = { stale: true };\n");
		await action(dir, native);
	} finally {
		await fs.rm(dir, { recursive: true, force: true });
	}
}

function embed(dir: string, args: string[]): { exitCode: number; stderr: string } {
	const result = Bun.spawnSync({
		cmd: [process.execPath, path.join(dir, "packages/natives/scripts/embed-native.ts"), ...args],
		cwd: dir,
		env: {
			PATH: "/usr/bin:/bin",
			HOME: dir,
			TMPDIR: dir,
			TARGET_PLATFORM: "linux",
			TARGET_ARCH: "x64",
		},
		stdout: "pipe",
		stderr: "pipe",
	});
	return { exitCode: result.exitCode, stderr: new TextDecoder().decode(result.stderr) };
}

describe("Observation CI minimal contract regressions", () => {
	it("refuses an untrusted normal embedding before changing the generated file", async () => {
		await fixture(async (dir, native) => {
			const before = await Bun.file(path.join(native, "embedded-addon.js")).text();
			const result = embed(dir, []);
			expect(result.exitCode).toBe(1);
			expect(result.stderr).toContain("has no trusted digest");
			expect(await Bun.file(path.join(native, "embedded-addon.js")).text()).toBe(before);
		});
	});

	it("restores only the null stub on reset, even when a present artifact is untrusted", async () => {
		await fixture(async (dir, native) => {
			const addon = path.join(native, "pi_natives.linux-x64-baseline.node");
			const bytes = await Bun.file(addon).text();
			const result = embed(dir, ["--reset"]);
			expect(result.exitCode).toBe(0);
			const stub = await Bun.file(path.join(native, "embedded-addon.js")).text();
			expect(stub).toContain("export const embeddedAddon = null;");
			expect(stub).not.toContain("import addonPath");
			expect(await Bun.file(addon).text()).toBe(bytes);
		});
	});

	it("uploads every producer provenance sidecar beside the affected native addons", async () => {
		const workflow = await readWorkflow();
		const step = workflow.jobs["affected-native"]?.steps?.find(entry => entry.name === "Upload native addon(s)");
		const uploaded = (step?.with?.path ?? "").split(/\s+/);
		for (const variant of ["baseline", "modern"]) {
			expect(uploaded).toContain(`packages/natives/native/pi_natives.linux-x64-${variant}.node.provenance.json`);
		}
	});

	it("rebuilds and verifies provenance in native consumers before the shard runs", async () => {
		const workflow = await readWorkflow();
		const job = Object.values(workflow.jobs).find(entry =>
			entry.steps?.some(step => step.name === "Run affected task shard"),
		);
		const steps = job?.steps ?? [];
		const downloaded = steps.findIndex(step => step.name === "Download native addon(s)");
		const execute = steps.findIndex(step => step.name === "Run affected task shard");
		expect(downloaded).toBeGreaterThanOrEqual(0);
		expect(execute).toBeGreaterThan(downloaded);
		const between = steps.slice(downloaded + 1, execute);
		const script = between.map(step => step.run ?? "").join("\n");
		expect(script).toContain("--rebuild-from-sidecars packages/natives/native");
		expect(script).toContain("--verify packages/natives/native");
		// The rebuild must be gated on the same native relevance flag as the download.
		expect(between.some(step => (step.run ?? "").includes("--verify") && step.if === "${{ matrix.native }}")).toBe(true);
	});
});
