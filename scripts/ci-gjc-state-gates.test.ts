import { afterAll, describe, expect, test } from "bun:test";
import { $ } from "bun";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { parse } from "yaml";
import type { WorkspacePackage } from "./ci-dev-affected";
import { changedFiles, relevantStateGatePaths } from "./ci-gjc-state-gates";

const packages: WorkspacePackage[] = [
	{ name: "coding-agent", dir: "packages/coding-agent", manifest: { dependencies: { agent: "workspace:*", ai: "workspace:*" } } },
	{ name: "agent", dir: "packages/agent", manifest: { dependencies: { utils: "workspace:*" } } },
	{ name: "ai", dir: "packages/ai", manifest: {} },
	{ name: "utils", dir: "packages/utils", manifest: {} },
	{ name: "unrelated", dir: "packages/unrelated", manifest: {} },
];
const temporaryDirectories: string[] = [];
afterAll(async () => {
	await Promise.all(temporaryDirectories.map(dir => fs.rm(dir, { recursive: true, force: true })));
});

async function fixture(): Promise<string> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-state-relevance-"));
	temporaryDirectories.push(dir);
	await $`git init -q ${dir}`.quiet();
	await Bun.write(path.join(dir, "package.json"), JSON.stringify({ workspaces: ["packages/*"] }));
	for (const pkg of packages) {
		await Bun.write(path.join(dir, pkg.dir, "package.json"), JSON.stringify({ name: pkg.name, ...pkg.manifest }));
	}
	for (const script of ["ci-gjc-state-gates.ts", "ci-dev-affected.ts", "ci-risk-canary-manifest.ts"]) {
		await Bun.write(path.join(dir, "scripts", script), Bun.file(path.join(import.meta.dir, script)));
	}
	return dir;
}

async function commit(dir: string): Promise<string> {
	await $`git add .`.cwd(dir).quiet();
	await $`git -c user.name=CI -c user.email=ci@example.invalid -c commit.gpgsign=false commit -qm fixture`.cwd(dir).quiet();
	return (await $`git rev-parse HEAD`.cwd(dir).quiet()).stdout.toString().trim();
}

async function emitRelevance(dir: string, base: string) {
	const output = path.join(dir, "github-output");
	const result = Bun.spawn([process.execPath, path.join(dir, "scripts/ci-gjc-state-gates.ts"), "--emit-relevance"], {
		cwd: dir,
		env: { ...process.env, GITHUB_EVENT_NAME: "pull_request", GITHUB_BASE_SHA: base, GITHUB_EVENT_BEFORE: "", GITHUB_OUTPUT: output },
		stdout: "pipe",
		stderr: "pipe",
	});
	const [exitCode, stdout, stderr] = await Promise.all([result.exited, new Response(result.stdout).text(), new Response(result.stderr).text()]);
	return { exitCode, stdout, stderr, output: await Bun.file(output).exists() ? await Bun.file(output).text() : "" };
}

describe("GJC state gate relevance", () => {
	test.each([
		"packages/coding-agent/src/gjc-runtime/state-runtime.ts",
		"packages/coding-agent/src/defaults/gjc/skills/ultragoal/SKILL.md",
		"packages/agent/src/compaction/prompts/compaction-summary-context.md",
		"packages/ai/src/prompts/turn-aborted-guidance.md",
		"packages/agent/src/index.ts",
		"packages/utils/src/index.ts",
		"packages/agent/package.json",
		"Cargo.lock",
		"Cargo.toml",
		"rust-toolchain.toml",
		".cargo/config.toml",
		"crates/pi-natives/src/lib.rs",
		"bun.lock",
		"bunfig.toml",
		"package.json",
		"tsconfig.base.json",
		".github/workflows/dev-ci.yml",
		"scripts/ci-gjc-state-gates.ts",
		"scripts/ci-build-native.ts",
		"packages/deleted/src/index.ts",
	])("retains state, transitive dependency, native and harness relevance: %s", file => {
		expect(relevantStateGatePaths([file], packages)).toEqual([file]);
	});

	test("skips only resolved documentation and unrelated package changes", () => {
		expect(relevantStateGatePaths([
			"docs/sdk.md", "README.md", "packages/coding-agent/CHANGELOG.md",
			"packages/coding-agent/docs/guide.md", "packages/unrelated/src/index.ts",
		], packages)).toEqual([]);
		expect(relevantStateGatePaths([], packages)).toEqual([]);
		expect(relevantStateGatePaths(["docs/sdk.md", "packages/utils/src/index.ts"], packages)).toEqual(["packages/utils/src/index.ts"]);
	});

	test("does not confuse similarly prefixed package directories", () => {
		expect(relevantStateGatePaths(["packages/utils-other/src/index.ts"], [
			...packages, { name: "utils-other", dir: "packages/utils-other", manifest: {} },
		])).toEqual([]);
	});

	test("rejects unresolved paths, graph and workspace dependency edges", () => {
		expect(() => relevantStateGatePaths(null, packages)).toThrow("changed paths are unresolved");
		expect(() => relevantStateGatePaths(["docs/sdk.md"], [])).toThrow("workspace graph is unresolved");
		expect(() => relevantStateGatePaths(["docs/sdk.md"], packages.filter(pkg => pkg.name !== "utils"))).toThrow("unresolved workspace dependency utils");
		for (const file of ["", "../docs/guide.md", "/docs/guide.md"]) {
			expect(() => relevantStateGatePaths([file], packages)).toThrow("invalid changed path");
		}
	});

	test.each([
		["docs/guide.md", false],
		["packages/unrelated/src/index.ts", false],
		["packages/utils/src/index.ts", true],
		["packages/agent/src/prompts/escaped-nonascii-recovery.md", true],
		["packages/ai/src/prompts/turn-aborted-guidance.md", true],
	] as const)("emits relevance without installing dependencies or running gates: %s", async (file, relevant) => {
		const dir = await fixture();
		const base = await commit(dir);
		await Bun.write(path.join(dir, file), "changed\n");
		await commit(dir);
		const result = await emitRelevance(dir, base);
		expect(result.exitCode).toBe(0);
		expect(result.stderr).toBe("");
		expect(result.output).toBe(`relevant=${relevant}\n`);
		expect(result.stdout).not.toContain("running group");
		expect(await Bun.file(path.join(dir, "node_modules")).exists()).toBe(false);
	});

	test("missing, invalid and unavailable bases fail without emitting irrelevance", async () => {
		const dir = await fixture();
		await commit(dir);
		for (const base of ["", "0".repeat(40), "origin/dev", "a".repeat(40)]) {
			const result = await emitRelevance(dir, base);
			expect(result.exitCode).not.toBe(0);
			expect(result.output).toBe("");
		}
	});

	test("dependency graph read failures cannot emit an irrelevant success", async () => {
		const dir = await fixture();
		const base = await commit(dir);
		await Bun.write(path.join(dir, "docs/guide.md"), "documentation only\n");
		await commit(dir);
		// A failed manifest read must not turn a docs-only diff into a green skip.
		await Bun.write(path.join(dir, "packages/utils/package.json"), "{");
		const result = await emitRelevance(dir, base);
		expect(result.exitCode).not.toBe(0);
		expect(result.output).toBe("");
	});

	test.each(["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"])("rejects malformed %s before dependency normalization", async scope => {
		const dir = await fixture();
		const base = await commit(dir);
		await Bun.write(path.join(dir, "docs/guide.md"), "documentation only\n");
		await commit(dir);
		for (const malformed of [[], null, "agent", { agent: null }, { agent: 42 }, { agent: [] }]) {
			await Bun.write(path.join(dir, "packages/coding-agent/package.json"), JSON.stringify({
				name: "coding-agent", dependencies: { agent: "workspace:*" }, [scope]: malformed,
			}));
			const result = await emitRelevance(dir, base);
			expect(result.exitCode).not.toBe(0);
			expect(result.stderr).toContain(`Invalid workspace dependency map ${scope}`);
			expect(result.output).toBe("");
		}
	});

	test("omitted dependency maps remain valid for an unrelated package", async () => {
		const dir = await fixture();
		const base = await commit(dir);
		await Bun.write(path.join(dir, "packages/unrelated/package.json"), JSON.stringify({ name: "unrelated" }));
		await Bun.write(path.join(dir, "packages/unrelated/src/index.ts"), "export const changed = true;\n");
		await commit(dir);
		const result = await emitRelevance(dir, base);
		expect(result.exitCode).toBe(0);
		expect(result.output).toBe("relevant=false\n");
	});

	test("diff preserves removed relevant paths and newline filenames", async () => {
		const dir = await fixture();
		const old = "packages/coding-agent/src/old.ts";
		const renamed = "packages/unrelated/src/new\nname.ts";
		await Bun.write(path.join(dir, old), "source\n");
		const base = await commit(dir);
		await Bun.write(path.join(dir, renamed), "source\n");
		await fs.unlink(path.join(dir, old));
		await commit(dir);
		const files = await changedFiles(dir, { GITHUB_EVENT_NAME: "pull_request", GITHUB_BASE_SHA: base });
		expect(files).toEqual([old, renamed]);
		expect(relevantStateGatePaths(files, packages)).toEqual([old]);
		expect(await changedFiles(dir, { GITHUB_EVENT_NAME: "push", GITHUB_EVENT_BEFORE: base })).toEqual(files);
	});
});

interface WorkflowJob {
	name: string;
	if?: string;
	needs?: string[];
	outputs?: Record<string, string>;
	steps: { name?: string; id?: string; uses?: string; run?: string; with?: Record<string, unknown> }[];
}

async function workflowJobs(): Promise<Record<string, WorkflowJob>> {
	const document = parse(await Bun.file(path.join(import.meta.dir, "../.github/workflows/dev-ci.yml")).text()) as { jobs: Record<string, WorkflowJob> };
	return document.jobs;
}

describe("GJC state gate workflow dependency contract", () => {
	test("resolves relevance before all native setup and shards, on the same exact head", async () => {
		const jobs = await workflowJobs();
		const relevance = jobs["gjc-state-gates-relevance"];
		expect(relevance.outputs?.relevant).toBe("${{ steps.relevance.outputs.relevant }}");
		expect(relevance.steps.map(step => step.run).filter(Boolean)).toEqual(["bun scripts/ci-gjc-state-gates.ts --emit-relevance"]);
		expect(relevance.steps.filter(step => step.uses).map(step => step.uses?.split("@")[0])).toEqual(["actions/checkout", "oven-sh/setup-bun"]);
		expect(relevance.steps.at(-1)?.id).toBe("relevance");
		for (const name of ["gjc-state-gates-native", "gjc-state-gates-matrix"]) {
			expect(jobs[name].needs).toContain("gjc-state-gates-relevance");
			expect(jobs[name].if).toBe("${{ needs.gjc-state-gates-relevance.result == 'success' && needs.gjc-state-gates-relevance.outputs.relevant == 'true' }}");
		}
		for (const name of ["gjc-state-gates-relevance", "gjc-state-gates-native", "gjc-state-gates-matrix"]) {
			expect(jobs[name].steps.find(step => step.uses?.startsWith("actions/checkout@"))?.with?.ref).toBe("${{ github.event.pull_request.head.sha || github.sha }}");
		}
		const aggregate = jobs["gjc-state-gates"];
		expect(aggregate.name).toBe("${{ ((github.event_name == 'workflow_dispatch' && inputs.head_sha != '') || (github.event_name == 'pull_request' && github.event.action == 'edited' && (github.event.changes.body != null || github.event.changes.title != null) && github.event.changes.base == null)) && 'Not code evidence - state gates skipped' || 'gjc-state-gates' }}");
		expect(aggregate.if).toContain("always()");
		expect(aggregate.needs).toEqual(["gjc-state-gates-relevance", "gjc-state-gates-native", "gjc-state-gates-matrix"]);
	});

	test("aggregate accepts only explicit irrelevance or complete relevant success", async () => {
		const jobs = await workflowJobs();
		const script = jobs["gjc-state-gates"].steps.find(step => step.name === "Aggregate GJC state gate shards")?.run;
		if (!script) throw new Error("Missing aggregate script");
		for (const relevanceResult of ["success", "failure", "cancelled", "skipped", ""]) {
			for (const relevant of ["true", "false", "", "invalid"]) {
				for (const native of ["success", "failure", "cancelled", "skipped"]) {
					for (const shards of ["success", "failure", "cancelled", "skipped"]) {
						const command = script
							.replace("${{ needs.gjc-state-gates-relevance.result }}", relevanceResult)
							.replace("${{ needs.gjc-state-gates-relevance.outputs.relevant }}", relevant)
							.replace("${{ needs.gjc-state-gates-native.result }}", native)
							.replace("${{ needs.gjc-state-gates-matrix.result }}", shards);
						const result = Bun.spawn(["bash", "-e", "-c", command], { stdout: "ignore", stderr: "ignore" });
						const expected = relevanceResult === "success" && (
							(relevant === "true" && native === "success" && shards === "success") ||
							(relevant === "false" && native === "skipped" && shards === "skipped")
						);
						expect({ relevanceResult, relevant, native, shards, passed: await result.exited === 0 }).toEqual({ relevanceResult, relevant, native, shards, passed: expected });
					}
				}
			}
		}
	}, 30_000);
});
