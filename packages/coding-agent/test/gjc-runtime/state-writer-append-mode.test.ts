import { afterAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { appendJsonl, appendJsonlIdempotent, appendText } from "@gajae-code/coding-agent/gjc-runtime/state-writer";

// File mode and final-component symlinks are POSIX. Windows ACLs are out of scope.
const skipPosix = process.platform === "win32";
// Root ignores mode 0400, so the read-only duplicate check is meaningless there.
const skipOwnerReadOnly = skipPosix || process.getuid?.() === 0;

function jsonlKey(entry: unknown): string | undefined {
	if (!entry || typeof entry !== "object") return undefined;
	const id = (entry as { id?: unknown }).id;
	return typeof id === "string" ? id : undefined;
}
const tempRoots: string[] = [];

async function tempDir(): Promise<string> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-state-append-"));
	tempRoots.push(dir);
	return dir;
}

afterAll(async () => {
	await Promise.all(tempRoots.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true })));
});

async function modeOf(filePath: string): Promise<number> {
	return (await fs.lstat(filePath)).mode & 0o777;
}

async function seedFile(root: string, relativePath: string, contents: string, mode: number): Promise<string> {
	const absolute = path.join(root, relativePath);
	await fs.mkdir(path.dirname(absolute), { recursive: true });
	await fs.writeFile(absolute, contents, { mode });
	await fs.chmod(absolute, mode);
	return absolute;
}

describe("state writer append mode", () => {
	it.skipIf(skipPosix)("refuses a symlink appendText target", async () => {
		const root = await tempDir();
		const outside = path.join(root, "outside.txt");
		await fs.writeFile(outside, "kept");
		const link = await seedFile(root, ".gjc/logs/notes.txt", "", 0o600);
		await fs.rm(link);
		await fs.symlink(outside, link);

		await expect(appendText(".gjc/logs/notes.txt", "pwned", { cwd: root })).rejects.toThrow(/not a regular file/);
		expect(await fs.readFile(outside, "utf-8")).toBe("kept");
		expect((await fs.lstat(link)).isSymbolicLink()).toBe(true);
	});

	it.skipIf(skipPosix)("refuses a symlink appendJsonl target", async () => {
		const root = await tempDir();
		const outside = path.join(root, "outside.jsonl");
		await fs.writeFile(outside, "");
		const link = await seedFile(root, ".gjc/logs/ledger.jsonl", "", 0o600);
		await fs.rm(link);
		await fs.symlink(outside, link);

		await expect(appendJsonl(".gjc/logs/ledger.jsonl", { secret: true }, { cwd: root })).rejects.toThrow(
			/not a regular file/,
		);
		expect(await fs.readFile(outside, "utf-8")).toBe("");
		expect((await fs.lstat(link)).isSymbolicLink()).toBe(true);
	});

	it.skipIf(skipPosix)("refuses a symlink appendJsonlIdempotent target", async () => {
		const root = await tempDir();
		const outside = path.join(root, "outside.jsonl");
		await fs.writeFile(outside, '{"id":"a"}\n');
		const link = await seedFile(root, ".gjc/logs/ledger.jsonl", "", 0o600);
		await fs.rm(link);
		await fs.symlink(outside, link);

		await expect(
			appendJsonlIdempotent(
				".gjc/logs/ledger.jsonl",
				{ id: "b" },
				{
					cwd: root,
					key: entry => (entry && typeof entry === "object" ? String((entry as { id?: unknown }).id) : undefined),
				},
			),
		).rejects.toThrow(/not a regular file/);
		expect(await fs.readFile(outside, "utf-8")).toBe('{"id":"a"}\n');
	});

	it.skipIf(skipPosix)("tightens an existing mode 0666 text file to 0600", async () => {
		const root = await tempDir();
		const absolute = await seedFile(root, ".gjc/logs/notes.txt", "old\n", 0o666);
		expect(await modeOf(absolute)).toBe(0o666);

		await appendText(".gjc/logs/notes.txt", "new\n", { cwd: root });

		expect(await modeOf(absolute)).toBe(0o600);
		expect(await fs.readFile(absolute, "utf-8")).toBe("old\nnew\n");
	});

	it.skipIf(skipPosix)("tightens an existing mode 0644 jsonl file to 0600", async () => {
		const root = await tempDir();
		const absolute = await seedFile(root, ".gjc/logs/ledger.jsonl", "", 0o644);

		await appendJsonl(".gjc/logs/ledger.jsonl", { ok: true }, { cwd: root });

		expect(await modeOf(absolute)).toBe(0o600);
		expect(JSON.parse((await fs.readFile(absolute, "utf-8")).trim())).toEqual({ ok: true });
	});

	it.skipIf(skipPosix)("creates a text file as mode 0600 under a permissive umask", async () => {
		const previous = process.umask(0);
		try {
			const root = await tempDir();
			await appendText(".gjc/logs/fresh.txt", "fresh\n", { cwd: root });
			const absolute = path.join(root, ".gjc/logs/fresh.txt");
			expect(await modeOf(absolute)).toBe(0o600);
			expect(await fs.readFile(absolute, "utf-8")).toBe("fresh\n");
		} finally {
			process.umask(previous);
		}
	});

	it("still allows a second append to a regular jsonl file", async () => {
		const root = await tempDir();
		await appendJsonl(".gjc/logs/ledger.jsonl", { n: 1 }, { cwd: root });
		await appendJsonl(".gjc/logs/ledger.jsonl", { n: 2 }, { cwd: root });
		expect(await fs.readFile(path.join(root, ".gjc/logs/ledger.jsonl"), "utf-8")).toBe('{"n":1}\n{"n":2}\n');
	});

	it.skipIf(skipPosix)("tightens a mode 0666 file when the idempotent append is a duplicate", async () => {
		const root = await tempDir();
		const absolute = await seedFile(root, ".gjc/logs/ledger.jsonl", '{"id":"a"}\n', 0o666);
		await fs.chmod(absolute, 0o666);

		const result = await appendJsonlIdempotent(
			".gjc/logs/ledger.jsonl",
			{ id: "a", note: "again" },
			{
				cwd: root,
				key: jsonlKey,
			},
		);

		expect(result.appended).toBe(false);
		expect(result.duplicate).toEqual({ id: "a" });
		expect(await fs.readFile(absolute, "utf-8")).toBe('{"id":"a"}\n');
		expect(await modeOf(absolute)).toBe(0o600);
	});

	it.skipIf(skipOwnerReadOnly)("still allows a duplicate idempotent append to a mode 0400 file", async () => {
		const root = await tempDir();
		const absolute = await seedFile(root, ".gjc/logs/ledger.jsonl", '{"id":"a"}\n', 0o600);
		await fs.chmod(absolute, 0o400);

		const result = await appendJsonlIdempotent(
			".gjc/logs/ledger.jsonl",
			{ id: "a", note: "again" },
			{
				cwd: root,
				key: jsonlKey,
			},
		);

		expect(result.appended).toBe(false);
		expect(result.duplicate).toEqual({ id: "a" });
		expect(await fs.readFile(absolute, "utf-8")).toBe('{"id":"a"}\n');
		expect(await modeOf(absolute)).toBe(0o400);
	});

	it.skipIf(skipOwnerReadOnly)("refuses a new idempotent row on a mode 0400 file", async () => {
		const root = await tempDir();
		const absolute = await seedFile(root, ".gjc/logs/ledger.jsonl", '{"id":"a"}\n', 0o600);
		await fs.chmod(absolute, 0o400);

		await expect(
			appendJsonlIdempotent(".gjc/logs/ledger.jsonl", { id: "b" }, { cwd: root, key: jsonlKey }),
		).rejects.toThrow(/EACCES/);
		expect(await fs.readFile(absolute, "utf-8")).toBe('{"id":"a"}\n');
		expect(await modeOf(absolute)).toBe(0o400);
	});

	it.skipIf(skipPosix)("keeps owner mode 0600 when appending text", async () => {
		const root = await tempDir();
		const absolute = await seedFile(root, ".gjc/logs/notes.txt", "old\n", 0o600);

		await appendText(".gjc/logs/notes.txt", "new\n", { cwd: root });

		expect(await modeOf(absolute)).toBe(0o600);
		expect(await fs.readFile(absolute, "utf-8")).toBe("old\nnew\n");
	});
});
