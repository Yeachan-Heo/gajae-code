/**
 * Skill/hook import publication must keep a destination that was a real
 * directory at validation inside that directory if an ancestor is replaced
 * before the write. The still-allowed case is a real directory (including one
 * the import creates).
 */
import { dlopen, FFIType } from "bun:ffi";
import { afterEach, expect, spyOn, test } from "bun:test";
import * as fsSync from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { applyImport, buildImportPreview } from "@gajae-code/coding-agent/customization/import";
import { resetAgentDirFromEnvironment, setAgentDir } from "@gajae-code/utils";
import fc from "fast-check";

const SKILL_MD = `---
description: Fixture skill for tests.
---

# Fixture

Do the thing.
`;

let tmpRoot: string | undefined;
const previousAgentDir = process.env.GJC_CODING_AGENT_DIR;

afterEach(async () => {
	if (previousAgentDir === undefined) delete process.env.GJC_CODING_AGENT_DIR;
	else process.env.GJC_CODING_AGENT_DIR = previousAgentDir;
	resetAgentDirFromEnvironment();
	if (tmpRoot) await fs.rm(tmpRoot, { recursive: true, force: true });
	tmpRoot = undefined;
});

async function layout(): Promise<{ projectDir: string; homeDir: string }> {
	tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-import-ancestor-"));
	const projectDir = path.join(tmpRoot, "project");
	const homeDir = path.join(tmpRoot, "home");
	await fs.mkdir(projectDir, { recursive: true });
	await fs.mkdir(homeDir, { recursive: true });
	setAgentDir(path.join(homeDir, ".gjc", "agent"));
	const skill = path.join(projectDir, ".claude", "skills", "claude-skill", "SKILL.md");
	await fs.mkdir(path.dirname(skill), { recursive: true });
	await fs.writeFile(skill, SKILL_MD);
	return { projectDir, homeDir };
}

const SAFE_SEGMENT = /^[A-Za-z0-9._-]{1,12}$/;

function createFifo(filePath: string): void {
	const library = dlopen(process.platform === "darwin" ? "/usr/lib/libSystem.B.dylib" : "libc.so.6", {
		mkfifo: { args: [FFIType.cstring, FFIType.u32], returns: FFIType.i32 },
	});
	const result = (library.symbols as unknown as { mkfifo: (pathname: string, mode: number) => number }).mkfifo(
		filePath,
		0o600,
	);
	if (result !== 0) throw new Error(`mkfifo failed for ${filePath}`);
}

test("property: import destination shape stays under the root", async () => {
	const { importDestinationShapeAllowed } = await import("@gajae-code/coding-agent/customization/import");
	fc.assert(
		fc.property(
			fc.array(fc.stringMatching(SAFE_SEGMENT), { minLength: 1, maxLength: 4 }),
			fc.stringMatching(SAFE_SEGMENT),
			(segments, name) => {
				const root = path.join("/proj", ".gjc");
				const target = path.join(root, ...segments, name);
				const allowed = importDestinationShapeAllowed(root, target);
				expect(allowed).toBe(importDestinationShapeAllowed(root, target));
				expect(allowed).toBe(true);
				expect(path.relative(root, path.dirname(target)).startsWith("..")).toBe(false);
				expect(importDestinationShapeAllowed(root, path.join(root, "..", name))).toBe(false);
				expect(importDestinationShapeAllowed(root, path.join(root, "ok", `bad\n${name}`))).toBe(false);
			},
		),
		{ seed: 424, numRuns: 64 },
	);
});

test("still allows a skill import that creates a real destination directory", async () => {
	const { projectDir, homeDir } = await layout();
	const plan = await buildImportPreview({
		product: "claude-code",
		sourceScope: "project",
		destinationScope: "project",
		surfaces: ["skills"],
		collisionPolicy: "skip",
		cwd: projectDir,
		homeDir,
	});
	const result = await applyImport(plan, { cwd: projectDir });
	const written = path.join(projectDir, ".gjc", "skills", "claude-skill", "SKILL.md");
	expect(result.ok).toBe(true);
	expect(result.entries[0]?.outcome).toBe("imported");
	const stat = await fs.lstat(written);
	expect(stat.isSymbolicLink()).toBe(false);
	expect(stat.isFile()).toBe(true);
	expect(await fs.readFile(written, "utf-8")).toContain("x-gjc-imported-from");
});

test.skipIf(process.platform === "win32")(
	"does not publish a skill outside the destination when its directory is replaced before publication",
	async () => {
		const { projectDir, homeDir } = await layout();
		const skills = path.join(projectDir, ".gjc", "skills");
		const outside = path.join(tmpRoot!, "outside");
		await fs.mkdir(skills, { recursive: true });
		await fs.mkdir(outside, { recursive: true });
		const plan = await buildImportPreview({
			product: "claude-code",
			sourceScope: "project",
			destinationScope: "project",
			surfaces: ["skills"],
			collisionPolicy: "skip",
			cwd: projectDir,
			homeDir,
		});
		let swapped = false;
		const originalMkdir = fs.mkdir.bind(fs);
		const mkdir = spyOn(fs, "mkdir").mockImplementation((async (target, options) => {
			const destinationRoot = path.join(projectDir, ".gjc");
			if (
				!swapped &&
				typeof target === "string" &&
				(target === destinationRoot || target.startsWith(`${destinationRoot}${path.sep}`))
			) {
				swapped = true;
				await fs.rename(skills, `${skills}-real`);
				await fs.symlink(outside, skills);
			}
			return originalMkdir(target, options);
		}) as typeof fs.mkdir);
		try {
			const result = await applyImport(plan, { cwd: projectDir });
			expect(swapped).toBe(true);
			expect(result.ok).toBe(false);
			expect(result.entries.some(entry => entry.reason?.includes("symlink"))).toBe(true);
			await expect(fs.lstat(path.join(outside, "claude-skill", "SKILL.md"))).rejects.toThrow();
			const leaked = await fs.readdir(outside).catch(() => []);
			expect(leaked).toEqual([]);
		} finally {
			mkdir.mockRestore();
		}
	},
);

test("still allows overwriting a skill that already exists in a real directory", async () => {
	const { projectDir, homeDir } = await layout();
	const destination = path.join(projectDir, ".gjc", "skills", "claude-skill", "SKILL.md");
	await fs.mkdir(path.dirname(destination), { recursive: true });
	await fs.writeFile(destination, "previous skill\n");
	const plan = await buildImportPreview({
		product: "claude-code",
		sourceScope: "project",
		destinationScope: "project",
		surfaces: ["skills"],
		collisionPolicy: "overwrite",
		cwd: projectDir,
		homeDir,
	});
	const result = await applyImport(plan, { cwd: projectDir });
	expect(result.ok).toBe(true);
	expect(result.entries[0]?.outcome).toBe("overwritten");
	expect(await fs.readFile(destination, "utf-8")).toContain("x-gjc-imported-from");
});

test.skipIf(process.platform === "win32")(
	"does not report success when the destination directory is moved before verification",
	async () => {
		const { projectDir, homeDir } = await layout();
		const parent = path.join(projectDir, ".gjc", "skills", "claude-skill");
		const moved = `${parent}-moved`;
		const plan = await buildImportPreview({
			product: "claude-code",
			sourceScope: "project",
			destinationScope: "project",
			surfaces: ["skills"],
			collisionPolicy: "skip",
			cwd: projectDir,
			homeDir,
		});
		let movedParent = false;
		const originalWrite = fsSync.writeFileSync;
		const writeFile = spyOn(fsSync, "writeFileSync").mockImplementation(((...args: unknown[]) => {
			const written = originalWrite.apply(fsSync, args as Parameters<typeof fsSync.writeFileSync>);
			if (!movedParent && typeof args[0] === "number" && fsSync.existsSync(parent)) {
				movedParent = true;
				fsSync.renameSync(parent, moved);
				fsSync.mkdirSync(parent);
			}
			return written;
		}) as typeof fsSync.writeFileSync);
		try {
			const result = await applyImport(plan, { cwd: projectDir });
			expect(movedParent).toBe(true);
			expect(result.ok).toBe(false);
			expect(result.entries.some(entry => entry.outcome === "imported")).toBe(false);
			expect(result.entries.some(entry => entry.reason?.includes("verification"))).toBe(true);
			await expect(fs.lstat(path.join(moved, "SKILL.md"))).rejects.toThrow();
			await expect(fs.lstat(path.join(parent, "SKILL.md"))).rejects.toThrow();
		} finally {
			writeFile.mockRestore();
		}
	},
);

test.skipIf(process.platform === "win32")(
	"rechecks the lexical destination after reading through the pinned parent",
	async () => {
		const { projectDir, homeDir } = await layout();
		const parent = path.join(projectDir, ".gjc", "skills", "claude-skill");
		const moved = `${parent}-moved`;
		const plan = await buildImportPreview({
			product: "claude-code",
			sourceScope: "project",
			destinationScope: "project",
			surfaces: ["skills"],
			collisionPolicy: "skip",
			cwd: projectDir,
			homeDir,
		});
		let movedParent = false;
		const originalRead = fsSync.readFileSync;
		const readFile = spyOn(fsSync, "readFileSync").mockImplementation(((...args: unknown[]) => {
			const content = originalRead.apply(fsSync, args as Parameters<typeof fsSync.readFileSync>);
			if (!movedParent && typeof args[0] === "number") {
				movedParent = true;
				fsSync.renameSync(parent, moved);
				fsSync.mkdirSync(parent);
			}
			return content;
		}) as typeof fsSync.readFileSync);
		try {
			const result = await applyImport(plan, { cwd: projectDir });
			expect(movedParent).toBe(true);
			expect(result.ok).toBe(false);
			expect(result.entries.some(entry => entry.outcome === "imported")).toBe(false);
			expect(result.entries.some(entry => entry.reason?.includes("verification"))).toBe(true);
			await expect(fs.lstat(path.join(moved, "SKILL.md"))).rejects.toThrow();
			await expect(fs.lstat(path.join(parent, "SKILL.md"))).rejects.toThrow();
		} finally {
			readFile.mockRestore();
		}
	},
);

test.skipIf(process.platform === "win32")(
	"rejects a FIFO swapped into the destination without blocking verification",
	async () => {
		const { projectDir, homeDir } = await layout();
		const target = path.join(projectDir, ".gjc", "skills", "claude-skill", "SKILL.md");
		const plan = await buildImportPreview({
			product: "claude-code",
			sourceScope: "project",
			destinationScope: "project",
			surfaces: ["skills"],
			collisionPolicy: "skip",
			cwd: projectDir,
			homeDir,
		});
		let replaced = false;
		const originalLstat = fsSync.lstatSync;
		const lstat = spyOn(fsSync, "lstatSync").mockImplementation(((...args: unknown[]) => {
			const stat = originalLstat.apply(fsSync, args as Parameters<typeof fsSync.lstatSync>);
			if (!replaced && args[0] === target && stat?.isFile()) {
				replaced = true;
				fsSync.unlinkSync(target);
				createFifo(target);
			}
			return stat;
		}) as typeof fsSync.lstatSync);
		try {
			const result = await applyImport(plan, { cwd: projectDir });
			expect(replaced).toBe(true);
			expect(result.ok).toBe(false);
			expect(result.entries.some(entry => entry.reason?.includes("not a regular file"))).toBe(true);
			await expect(fs.lstat(target)).rejects.toThrow();
		} finally {
			lstat.mockRestore();
		}
	},
);

test.skipIf(process.platform === "win32")(
	"rejects oversized overwrite batches before changing any destination files",
	async () => {
		const { projectDir, homeDir } = await layout();
		const skillCount = 128;
		const defaultDestination = path.join(projectDir, ".gjc", "skills", "claude-skill", "SKILL.md");
		await fs.mkdir(path.dirname(defaultDestination), { recursive: true });
		await fs.writeFile(defaultDestination, "previous claude-skill\n");
		for (let index = 0; index < skillCount; index++) {
			const name = `skill-${index}`;
			const source = path.join(projectDir, ".claude", "skills", name, "SKILL.md");
			const destination = path.join(projectDir, ".gjc", "skills", name, "SKILL.md");
			await fs.mkdir(path.dirname(source), { recursive: true });
			await fs.writeFile(source, SKILL_MD);
			await fs.mkdir(path.dirname(destination), { recursive: true });
			await fs.writeFile(destination, `previous ${name}\n`);
		}
		const plan = await buildImportPreview({
			product: "claude-code",
			sourceScope: "project",
			destinationScope: "project",
			surfaces: ["skills"],
			collisionPolicy: "overwrite",
			cwd: projectDir,
			homeDir,
		});
		const result = await applyImport(plan, { cwd: projectDir });
		expect(result.ok).toBe(false);
		expect(result.entries).toHaveLength(skillCount + 1);
		expect(result.entries.every(entry => entry.outcome === "failed")).toBe(true);
		expect(result.entries.every(entry => entry.reason?.includes("distinct destination directories"))).toBe(true);
		expect(await fs.readFile(defaultDestination, "utf-8")).toBe("previous claude-skill\n");
		for (let index = 0; index < skillCount; index++) {
			const name = `skill-${index}`;
			const destination = path.join(projectDir, ".gjc", "skills", name, "SKILL.md");
			expect(await fs.readFile(destination, "utf-8")).toBe(`previous ${name}\n`);
		}
	},
);
