import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentTool } from "@gajae-code/agent-core";
import {
	activeSnapshotPath,
	modeStatePath,
	sessionStateDir,
} from "@gajae-code/coding-agent/gjc-runtime/session-layout";
import {
	assertWorkflowMutationRawPathsAllowed,
	getWorkflowMutationDecision,
	readWorkflowGuardContext,
} from "@gajae-code/coding-agent/skill-state/workflow-mutation-guard";
import fc from "fast-check";

const roots: string[] = [];
const sessionId = "session-a";
async function fixture(skill = "deep-interview") {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-hardlink-guard-"));
	roots.push(root);
	const cwd = path.join(root, "repo");
	const scratch = path.join(root, "scratch");
	await fs.mkdir(sessionStateDir(cwd, sessionId), { recursive: true });
	await fs.mkdir(scratch);
	const now = new Date().toISOString();
	await Bun.write(
		activeSnapshotPath(cwd, sessionId),
		JSON.stringify({
			version: 1,
			active: true,
			skill,
			phase: "interviewing",
			updated_at: now,
			active_skills: [{ skill, phase: "interviewing", active: true, updated_at: now, session_id: sessionId }],
		}),
	);
	await Bun.write(
		modeStatePath(cwd, sessionId, skill),
		JSON.stringify({ active: true, current_phase: "interviewing", session_id: sessionId }),
	);
	const product = path.join(cwd, "src/product.ts");
	await Bun.write(product, "ORIGINAL");
	return { cwd, scratch, product };
}
afterEach(async () => {
	vi.restoreAllMocks();
	for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});
function tool(name: string): AgentTool {
	return {
		name,
		label: name,
		description: name,
		parameters: {} as never,
		execute: async () => ({ content: [{ type: "text", text: "ok" }] }),
	};
}
function decision(cwd: string, command: string, forceOverride = false) {
	return getWorkflowMutationDecision({ cwd, sessionId, tool: tool("bash"), args: { command }, forceOverride });
}
async function bashWrite(cwd: string, target: string) {
	const command = `printf CHANGED > '${target}'`;
	const result = await decision(cwd, command);
	if (!result.blocked) {
		const child = Bun.spawn(["/bin/sh", "-c", command], { cwd, stdout: "ignore", stderr: "pipe" });
		const stderr = await new Response(child.stderr).text();
		expect(await child.exited, stderr).toBe(0);
	}
	return result;
}
const surfaces = ["session-plans", "session-specs", "plans", "specs", "scratch"] as const;
function surfacePath(cwd: string, scratch: string, surface: string) {
	if (surface === "scratch") return path.join(scratch, "note.md");
	if (surface.startsWith("session-"))
		return path.join(sessionStateDir(cwd, sessionId), "..", surface.slice(8), "note.md");
	return path.join(cwd, ".gjc", surface, "note.md");
}

describe("planning hardlink target identity", () => {
	for (const surface of surfaces) {
		it(`blocks product hardlink writes through ${surface}`, async () => {
			const { cwd, scratch, product } = await fixture();
			const target = surfacePath(cwd, scratch, surface);
			await fs.mkdir(path.dirname(target), { recursive: true });
			await fs.link(product, target);
			expect((await fs.stat(target)).nlink).toBe(2);
			expect((await bashWrite(cwd, target)).blocked).toBe(true);
			expect(await Bun.file(product).text()).toBe("ORIGINAL");
		});
		it(`still allows new and single-link writes through ${surface}`, async () => {
			const { cwd, scratch } = await fixture();
			const target = surfacePath(cwd, scratch, surface);
			await fs.mkdir(path.dirname(target), { recursive: true });
			expect((await bashWrite(cwd, target)).blocked).toBe(false);
			expect((await fs.stat(target)).nlink).toBe(1);
			expect((await bashWrite(cwd, target)).blocked).toBe(false);
			expect(await Bun.file(target).text()).toBe("CHANGED");
		});
	}
});

describe("hardlink guard entry points", () => {
	it("blocks neutral scratch aliases through each mutation tool and deferred raw paths", async () => {
		const { cwd, scratch, product } = await fixture();
		const target = path.join(scratch, "alias.ts");
		await fs.link(product, target);
		const cases = [
			["write", { path: target, content: "CHANGED" }],
			["edit", { path: target, edits: [] }],
			["ast_edit", { paths: [target] }],
			["python", { code: `open(${JSON.stringify(target)}, 'w').write('CHANGED')` }],
			["eval", { cells: [{ language: "js", code: `Bun.write(${JSON.stringify(target)}, 'CHANGED')` }] }],
		] as const;
		for (const [name, args] of cases) {
			expect((await getWorkflowMutationDecision({ cwd, sessionId, tool: tool(name), args })).blocked, name).toBe(
				true,
			);
		}
		await expect(assertWorkflowMutationRawPathsAllowed({ cwd, sessionId, rawPaths: [target] })).rejects.toThrow();
		expect(await Bun.file(product).text()).toBe("ORIGINAL");
	});
	it("still allows single-link scratch through each mutation tool and deferred raw paths", async () => {
		const { cwd, scratch } = await fixture();
		const target = path.join(scratch, "note.ts");
		await Bun.write(target, "scratch");
		for (const [name, args] of [
			["write", { path: target, content: "CHANGED" }],
			["edit", { path: target, edits: [] }],
			["ast_edit", { paths: [target] }],
			["python", { code: `open(${JSON.stringify(target)}, 'w').write('CHANGED')` }],
			["eval", { cells: [{ language: "js", code: `Bun.write(${JSON.stringify(target)}, 'CHANGED')` }] }],
		] as const) {
			expect((await getWorkflowMutationDecision({ cwd, sessionId, tool: tool(name), args })).blocked, name).toBe(
				false,
			);
		}
		await assertWorkflowMutationRawPathsAllowed({ cwd, sessionId, rawPaths: [target] });
	});
	it("blocks a multiply linked autoresearch harness through the write tool", async () => {
		const { cwd, product } = await fixture("autoresearch");
		await fs.link(product, path.join(cwd, "autoresearch.sh"));
		const result = await getWorkflowMutationDecision({
			cwd,
			sessionId,
			tool: tool("write"),
			args: { path: "autoresearch.sh", content: "CHANGED" },
		});
		expect(result.blocked).toBe(true);
		expect(await Bun.file(product).text()).toBe("ORIGINAL");
	});
	it("still allows new and single-link autoresearch harness writes through file tools", async () => {
		const { cwd } = await fixture("autoresearch");
		const created = await getWorkflowMutationDecision({
			cwd,
			sessionId,
			tool: tool("write"),
			args: { path: "autoresearch.sh", content: "CHANGED" },
		});
		expect(created.blocked).toBe(false);
		await Bun.write(path.join(cwd, "autoresearch.sh"), "scratch");
		expect((await fs.stat(path.join(cwd, "autoresearch.sh"))).nlink).toBe(1);
		const edited = await getWorkflowMutationDecision({
			cwd,
			sessionId,
			tool: tool("edit"),
			args: { path: "autoresearch.sh", edits: [] },
		});
		expect(edited.blocked).toBe(false);
	});
	it("still blocks bash writes to the autoresearch harness", async () => {
		const { cwd } = await fixture("autoresearch");
		expect((await decision(cwd, "printf CHANGED > autoresearch.sh")).blocked).toBe(true);
		await Bun.write(path.join(cwd, "autoresearch.sh"), "scratch");
		expect((await decision(cwd, "printf CHANGED > autoresearch.sh")).blocked).toBe(true);
	});
	it("still blocks a temp symlink that points at product code", async () => {
		const { cwd, scratch, product } = await fixture();
		const link = path.join(scratch, "symlink");
		await fs.symlink(product, link);
		expect((await bashWrite(cwd, link)).blocked).toBe(true);
		expect(await Bun.file(product).text()).toBe("ORIGINAL");
	});
	it("still allows an allowlisted plan symlink to a single-link product file", async () => {
		const { cwd, product } = await fixture();
		const link = path.join(cwd, ".gjc", "plans", "link");
		await fs.mkdir(path.dirname(link), { recursive: true });
		await fs.symlink(product, link);
		expect((await fs.stat(product)).nlink).toBe(1);
		expect((await decision(cwd, `printf x > '${link}'`)).blocked).toBe(false);
	});
	it("property: scratch link count decides the planning bash write", async () => {
		const { cwd, scratch, product } = await fixture();
		const names = fc.stringMatching(/^[a-z0-9]{1,12}$/);
		const kinds = fc.constantFrom("missing" as const, "single" as const, "hardlink" as const);
		await fc.assert(
			fc.asyncProperty(names, kinds, async (name, kind) => {
				const target = path.join(scratch, name);
				await fs.rm(target, { force: true });
				if (kind === "single") await Bun.write(target, "scratch");
				if (kind === "hardlink") await fs.link(product, target);
				const result = await decision(cwd, `printf CHANGED > '${target}'`);
				expect(result.blocked).toBe(kind === "hardlink");
				if (kind === "hardlink") expect(await Bun.file(product).text()).toBe("ORIGINAL");
				await fs.rm(target, { force: true });
			}),
			{ seed: 296202610, numRuns: 64 },
		);
	});
	it("fails closed on filesystem errors while retaining ENOENT new-file writes", async () => {
		const { cwd, scratch } = await fixture();
		const target = path.join(scratch, "note.md");
		const guardContext = await readWorkflowGuardContext(cwd, { sessionId });
		const spy = vi.spyOn(fs, "stat").mockRejectedValue(Object.assign(new Error("denied"), { code: "EACCES" }));
		expect(
			(
				await getWorkflowMutationDecision({
					cwd,
					sessionId,
					guardContext,
					tool: tool("bash"),
					args: { command: `printf CHANGED > '${target}'` },
				})
			).blocked,
		).toBe(true);
		spy.mockRestore();
		expect((await decision(cwd, `printf CHANGED > '${target}'`)).blocked).toBe(false);
	});
	it("blocks symlinks to multiply linked scratch files and unresolved symlink loops", async () => {
		const { cwd, scratch, product } = await fixture();
		const alias = path.join(scratch, "alias");
		const link = path.join(scratch, "symlink");
		await fs.link(product, alias);
		await fs.symlink(alias, link);
		expect((await bashWrite(cwd, link)).blocked).toBe(true);
		expect(await Bun.file(product).text()).toBe("ORIGINAL");
		const loop = path.join(scratch, "loop");
		await fs.symlink(loop, loop);
		expect((await decision(cwd, `printf CHANGED > '${loop}'`)).blocked).toBe(true);
	});
	it("still allows single-link symlinks, canonical temp spellings, and new nested scratch", async () => {
		const { cwd, scratch } = await fixture();
		const target = path.join(scratch, "single");
		await Bun.write(target, "scratch");
		const link = path.join(scratch, "symlink");
		await fs.symlink(target, link);
		expect((await bashWrite(cwd, link)).blocked).toBe(false);
		expect((await bashWrite(cwd, await fs.realpath(target))).blocked).toBe(false);
		expect((await decision(cwd, `mkdir -p '${scratch}/nested'`)).blocked).toBe(false);
		expect((await decision(cwd, `printf CHANGED > '${scratch}/nested/new'`)).blocked).toBe(false);
	});
	it("still preserves force override and inactive planning behavior for hardlinks", async () => {
		const { cwd, scratch, product } = await fixture();
		const target = path.join(scratch, "alias");
		await fs.link(product, target);
		const command = `printf CHANGED > '${target}'`;
		expect((await decision(cwd, command, true)).blocked).toBe(false);
		await fs.rm(modeStatePath(cwd, sessionId, "deep-interview"));
		expect((await decision(cwd, command)).blocked).toBe(false);
	});
});
