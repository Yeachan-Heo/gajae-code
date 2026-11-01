import { afterAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { persistTaskTokenLog, taskTokenLogFromChat } from "./token-log";

// Mode bits and final-component symlinks are POSIX. Windows ACLs are out of scope.
const skipPosix = process.platform === "win32";
const skipOwnerReadOnly = skipPosix || process.getuid?.() === 0;
const tempRoots: string[] = [];

async function tempDir(): Promise<string> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-token-log-mode-"));
	tempRoots.push(dir);
	return dir;
}

afterAll(async () => {
	await Promise.all(tempRoots.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true })));
});

function entry(id: string) {
	return taskTokenLogFromChat(
		{ inputTokens: 1, outputTokens: 2, cachedInputTokens: 0, cacheWriteTokens: 0 },
		{ subagentId: id, turn: 1, at: "2026-01-01T00:00:00.000Z" },
	);
}

async function modeOf(filePath: string): Promise<number> {
	return (await fs.lstat(filePath)).mode & 0o777;
}

describe("task token log mode", () => {
	it.skipIf(skipPosix)("refuses a symlink token-log.jsonl", async () => {
		const root = await tempDir();
		const outside = path.join(root, "outside.jsonl");
		await fs.writeFile(outside, "kept");
		const dir = path.join(root, "logs");
		await fs.mkdir(dir);
		const link = path.join(dir, "token-log.jsonl");
		await fs.symlink(outside, link);

		await expect(persistTaskTokenLog(entry("root"), { dir })).rejects.toThrow(/not a regular file/);
		expect(await fs.readFile(outside, "utf8")).toBe("kept");
		expect((await fs.lstat(link)).isSymbolicLink()).toBe(true);
	});

	it.skipIf(skipPosix)("refuses a symlink token-log directory", async () => {
		const root = await tempDir();
		const outside = path.join(root, "outside");
		await fs.mkdir(outside);
		const dir = path.join(root, "token-logs");
		await fs.symlink(outside, dir);

		await expect(persistTaskTokenLog(entry("root"), { dir })).rejects.toThrow(/not a directory/);
		expect(await fs.readdir(outside)).toEqual([]);
		expect((await fs.lstat(dir)).isSymbolicLink()).toBe(true);
	});

	it.skipIf(skipPosix)("creates a token log as mode 0600 under a permissive umask", async () => {
		const previous = process.umask(0);
		try {
			const root = await tempDir();
			const dir = path.join(root, "logs");
			await persistTaskTokenLog(entry("root"), { dir });
			expect(await modeOf(dir)).toBe(0o700);
			expect(await modeOf(path.join(dir, "token-log.jsonl"))).toBe(0o600);
		} finally {
			process.umask(previous);
		}
	});

	it.skipIf(skipPosix)("tightens an existing mode 0666 token log to 0600", async () => {
		const root = await tempDir();
		const dir = path.join(root, "logs");
		await fs.mkdir(dir, { mode: 0o700 });
		const file = path.join(dir, "token-log.jsonl");
		await fs.writeFile(file, "", { mode: 0o666 });
		await fs.chmod(file, 0o666);

		await persistTaskTokenLog(entry("root"), { dir });

		expect(await modeOf(file)).toBe(0o600);
		expect(await fs.readFile(file, "utf8")).toContain('"subagentId":"root"');
	});

	it.skipIf(skipPosix)("tightens an existing mode 0777 token-log directory to 0700", async () => {
		const root = await tempDir();
		const dir = path.join(root, "logs");
		await fs.mkdir(dir, { mode: 0o777 });
		await fs.chmod(dir, 0o777);

		await persistTaskTokenLog(entry("root"), { dir });

		expect(await modeOf(dir)).toBe(0o700);
		expect(await modeOf(path.join(dir, "token-log.jsonl"))).toBe(0o600);
	});

	it("still allows a second append to a regular token log", async () => {
		const root = await tempDir();
		const dir = path.join(root, "logs");
		await persistTaskTokenLog(entry("one"), { dir });
		await persistTaskTokenLog(entry("two"), { dir });
		const text = await fs.readFile(path.join(dir, "token-log.jsonl"), "utf8");
		expect(text).toContain('"subagentId":"one"');
		expect(text).toContain('"subagentId":"two"');
	});

	it.skipIf(skipPosix)("still allows a token log through a symlinked parent", async () => {
		const root = await tempDir();
		const realParent = path.join(root, "real");
		await fs.mkdir(realParent);
		const via = path.join(root, "via");
		await fs.symlink(realParent, via);
		const dir = path.join(via, "token-logs");

		await persistTaskTokenLog(entry("via"), { dir });

		expect(await fs.readFile(path.join(realParent, "token-logs", "token-log.jsonl"), "utf8")).toContain(
			'"subagentId":"via"',
		);
	});

	it.skipIf(skipPosix)("keeps owner mode 0600 when appending a token log", async () => {
		const root = await tempDir();
		const dir = path.join(root, "logs");
		await fs.mkdir(dir, { mode: 0o700 });
		const file = path.join(dir, "token-log.jsonl");
		await fs.writeFile(file, "", { mode: 0o600 });

		await persistTaskTokenLog(entry("root"), { dir });

		expect(await modeOf(file)).toBe(0o600);
		expect(await fs.readFile(file, "utf8")).toContain('"subagentId":"root"');
	});

	it.skipIf(skipOwnerReadOnly)("still allows a token log in a mode 0300 directory", async () => {
		const root = await tempDir();
		const dir = path.join(root, "logs");
		await fs.mkdir(dir, { mode: 0o700 });
		await fs.chmod(dir, 0o300);
		try {
			await persistTaskTokenLog(entry("root"), { dir });
			expect(await fs.readFile(path.join(dir, "token-log.jsonl"), "utf8")).toContain('"subagentId":"root"');
		} finally {
			await fs.chmod(dir, 0o700);
		}
	});

	it.skipIf(skipOwnerReadOnly)("leaves a mode 0400 token log unchanged when the append cannot write", async () => {
		const root = await tempDir();
		const dir = path.join(root, "logs");
		await fs.mkdir(dir, { mode: 0o700 });
		const file = path.join(dir, "token-log.jsonl");
		await fs.writeFile(file, "kept\n", { mode: 0o600 });
		await fs.chmod(file, 0o400);

		await expect(persistTaskTokenLog(entry("root"), { dir })).rejects.toThrow(/EACCES/);
		expect(await fs.readFile(file, "utf8")).toBe("kept\n");
		expect(await modeOf(file)).toBe(0o400);
	});
});
