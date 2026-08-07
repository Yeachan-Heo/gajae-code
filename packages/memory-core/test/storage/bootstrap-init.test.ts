import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { createMemoryRootScaffold, MemoryBootstrapError } from "../../src/storage/bootstrap-init";

const FILE_CONTENTS = {
	"MEMORY.md": [
		"# Memory Map",
		"",
		"<!-- AUTO:PROJECTS START -->",
		"<!-- AUTO:PROJECTS END -->",
		"",
		"<!-- AUTO:INDEX-HEALTH START -->",
		"<!-- AUTO:INDEX-HEALTH END -->",
		"",
	].join("\n"),
	"config.yaml": "version: 1\n",
	"projects/registry.yaml": "version: 1\nprojects: {}\n",
	"routes.yaml": "version: 1\nroutes: {}\n",
} as const;

const DIRECTORY_PATHS = [
	".journal",
	".locks",
	"global",
	"global/archive",
	"global/constraints",
	"global/conventions",
	"global/profile",
	"projects",
	"sessions",
] as const;

const FILE_PATHS = Object.keys(FILE_CONTENTS) as (keyof typeof FILE_CONTENTS)[];
const SCAFFOLD_PATHS = [...DIRECTORY_PATHS, ...FILE_PATHS].sort();

const temporaryRoots: string[] = [];

afterEach(async () => {
	await Promise.all(temporaryRoots.splice(0).map(root => fs.rm(root, { force: true, recursive: true })));
});

async function makeRoot(): Promise<string> {
	const parent = await fs.mkdtemp(path.join(os.tmpdir(), "memory-core-bootstrap-"));
	const root = path.join(parent, "memory-root");
	temporaryRoots.push(parent);
	return root;
}

async function makeExistingRoot(): Promise<string> {
	const root = await makeRoot();
	await fs.mkdir(root, { mode: 0o700 });
	await fs.chmod(root, 0o700);
	return root;
}

async function relativeEntries(root: string): Promise<string[]> {
	const entries: string[] = [];
	async function visit(current: string, prefix: string): Promise<void> {
		for (const entry of await fs.readdir(current, { withFileTypes: true })) {
			const relPath = prefix.length === 0 ? entry.name : `${prefix}/${entry.name}`;
			entries.push(relPath);
			if (entry.isDirectory() && !entry.isSymbolicLink()) await visit(path.join(current, entry.name), relPath);
		}
	}
	await visit(root, "");
	return entries.sort();
}

async function snapshotFiles(root: string): Promise<Map<string, Buffer>> {
	const snapshot = new Map<string, Buffer>();
	for (const relPath of FILE_PATHS) snapshot.set(relPath, await fs.readFile(path.join(root, relPath)));
	return snapshot;
}

async function expectRejected(task: () => Promise<unknown>, code: MemoryBootstrapError["code"]): Promise<void> {
	const error = await task().then(
		() => undefined,
		failure => failure,
	);
	expect(error).toBeInstanceOf(MemoryBootstrapError);
	expect((error as MemoryBootstrapError).code).toBe(code);
	expect((error as MemoryBootstrapError).reason).not.toContain(path.sep);
}

describe("createMemoryRootScaffold", () => {
	it("creates the exact isolated scaffold with fixed content and restrictive modes", async () => {
		const root = await makeRoot();
		const receipt = await createMemoryRootScaffold(root);

		expect(receipt.schemaVersion).toBe("gajae.memory.init-receipt.v1");
		expect(receipt.memoryRoot).toBe(await fs.realpath(root));
		expect(receipt.created).toEqual(SCAFFOLD_PATHS);
		expect(receipt.alreadyPresent).toEqual([]);
		expect(await relativeEntries(root)).toEqual(SCAFFOLD_PATHS);
		expect(await fs.readdir(root)).not.toContain("cwd");
		expect(await fs.readdir(root)).not.toContain("project");
		expect(await fs.readdir(root)).not.toContain("session");

		expect((await fs.stat(root)).mode & 0o777).toBe(0o700);
		for (const relPath of DIRECTORY_PATHS) {
			const stats = await fs.lstat(path.join(root, relPath));
			expect(stats.isDirectory()).toBe(true);
			expect(stats.isSymbolicLink()).toBe(false);
			expect(stats.mode & 0o777).toBe(0o700);
		}
		for (const relPath of FILE_PATHS) {
			const stats = await fs.lstat(path.join(root, relPath));
			expect(stats.isFile()).toBe(true);
			expect(stats.isSymbolicLink()).toBe(false);
			expect(stats.mode & 0o777).toBe(0o600);
			expect(await fs.readFile(path.join(root, relPath), "utf8")).toBe(FILE_CONTENTS[relPath]);
		}
	});

	it("is idempotent and leaves every existing byte unchanged on the second call", async () => {
		const root = await makeRoot();
		await createMemoryRootScaffold(root);
		const before = await snapshotFiles(root);

		const receipt = await createMemoryRootScaffold(root);

		expect(receipt.schemaVersion).toBe("gajae.memory.init-receipt.v1");
		expect(receipt.memoryRoot).toBe(await fs.realpath(root));
		expect(receipt.created).toEqual([]);
		expect(receipt.alreadyPresent).toEqual(SCAFFOLD_PATHS);
		const after = await snapshotFiles(root);
		for (const relPath of FILE_PATHS)
			expect(after.get(relPath)?.equals(before.get(relPath) ?? Buffer.alloc(0))).toBe(true);
		expect(await relativeEntries(root)).toEqual(SCAFFOLD_PATHS);
	});

	it("never truncates or replaces pre-existing regular files", async () => {
		const root = await makeExistingRoot();
		await fs.mkdir(path.join(root, "projects"), { mode: 0o700 });
		const sentinels = new Map<string, string>([
			["MEMORY.md", "user-owned memory\n"],
			["config.yaml", "version: 99\ncustom: true\n"],
			["projects/registry.yaml", "version: 7\nprojects: {keep: me}\n"],
			["routes.yaml", "version: 4\nroutes: {custom: route}\n"],
		]);
		for (const [relPath, content] of sentinels)
			await fs.writeFile(path.join(root, relPath), content, { mode: 0o600 });
		const before = await snapshotFiles(root);

		const preExisting = new Set<string>(["projects", ...sentinels.keys()]);
		const receipt = await createMemoryRootScaffold(root);

		expect(receipt.created).toEqual(SCAFFOLD_PATHS.filter(relPath => !preExisting.has(relPath)));
		expect(receipt.alreadyPresent).toEqual(SCAFFOLD_PATHS.filter(relPath => preExisting.has(relPath)));
		for (const [relPath, content] of sentinels) {
			expect(await fs.readFile(path.join(root, relPath), "utf8")).toBe(content);
			expect((await fs.lstat(path.join(root, relPath))).mode & 0o777).toBe(0o600);
		}
		const after = await snapshotFiles(root);
		for (const relPath of FILE_PATHS)
			expect(after.get(relPath)?.equals(before.get(relPath) ?? Buffer.alloc(0))).toBe(true);
	});

	it("rejects a root symlink and does not initialize its target", async () => {
		const root = await makeRoot();
		const target = path.join(path.dirname(root), "target");
		await fs.mkdir(target, { mode: 0o700 });
		await fs.symlink(target, root, "dir");

		await expectRejected(() => createMemoryRootScaffold(root), "root-symlink");
		expect(await fs.readdir(target)).toEqual([]);
	});

	it.skipIf(process.platform === "win32")(
		"canonicalizes safe parent aliases and rejects unsafe canonical ancestors",
		async () => {
			const container = await fs.mkdtemp(path.join(os.tmpdir(), "memory-core-bootstrap-alias-"));
			temporaryRoots.push(container);

			const safeParent = path.join(container, "safe-parent");
			await fs.mkdir(safeParent, { mode: 0o700 });
			const safeAlias = path.join(container, "safe-alias");
			await fs.symlink(safeParent, safeAlias, "dir");
			const receipt = await createMemoryRootScaffold(path.join(safeAlias, "memory-root"));
			expect(receipt.memoryRoot).toBe(path.join(await fs.realpath(safeParent), "memory-root"));

			const unsafeParent = path.join(container, "unsafe-parent");
			const nestedParent = path.join(unsafeParent, "nested");
			await fs.mkdir(nestedParent, { recursive: true, mode: 0o700 });
			await fs.chmod(unsafeParent, 0o777);
			const unsafeAlias = path.join(container, "unsafe-alias");
			await fs.symlink(nestedParent, unsafeAlias, "dir");
			await expectRejected(
				() => createMemoryRootScaffold(path.join(unsafeAlias, "memory-root")),
				"root-mode-insecure",
			);
		},
	);

	it("rejects non-directory roots and non-directory or symlink scaffold paths", async () => {
		const fileRoot = await makeRoot();
		await fs.writeFile(fileRoot, "do not truncate\n");
		await expectRejected(() => createMemoryRootScaffold(fileRoot), "root-not-directory");
		expect(await fs.readFile(fileRoot, "utf8")).toBe("do not truncate\n");

		const directoryRoot = await makeExistingRoot();
		await fs.writeFile(path.join(directoryRoot, ".journal"), "not a directory\n");
		await expectRejected(() => createMemoryRootScaffold(directoryRoot), "scaffold-path-type-mismatch");
		expect(await fs.readFile(path.join(directoryRoot, ".journal"), "utf8")).toBe("not a directory\n");

		const symlinkRoot = await makeExistingRoot();
		const target = path.join(path.dirname(symlinkRoot), "memory-target.md");
		await fs.writeFile(target, "target remains intact\n");
		await fs.symlink(target, path.join(symlinkRoot, "MEMORY.md"));
		await expectRejected(() => createMemoryRootScaffold(symlinkRoot), "scaffold-path-type-mismatch");
		expect(await fs.readFile(target, "utf8")).toBe("target remains intact\n");
	});

	it("rejects existing roots that are not exactly 0700 on POSIX", async () => {
		if (process.platform === "win32") return;
		const root = await makeExistingRoot();
		await fs.chmod(root, 0o755);

		await expectRejected(() => createMemoryRootScaffold(root), "root-mode-insecure");
		expect(await fs.readdir(root)).toEqual([]);
	});
});
