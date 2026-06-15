import { Database } from "bun:sqlite";
import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { MAX_EDIT_FILE_BYTES, readEditFileText } from "@gajae-code/coding-agent/edit/read-file";
import { executeReadQuery } from "@gajae-code/coding-agent/tools/sqlite-reader";

const tmpFiles: string[] = [];

afterEach(async () => {
	for (const f of tmpFiles.splice(0)) await fs.rm(f, { force: true });
});

async function writeTmp(name: string, bytes: number): Promise<string> {
	const file = path.join(os.tmpdir(), `gjc-g008-${Date.now()}-${name}`);
	await Bun.write(file, Buffer.alloc(bytes, 0x61));
	tmpFiles.push(file);
	return file;
}

describe("edit file size guard (W7 / F19)", () => {
	it("rejects a file larger than the edit byte limit with an actionable error", async () => {
		const big = await writeTmp("big.txt", MAX_EDIT_FILE_BYTES + 1024);
		await expect(readEditFileText(big, "big.txt")).rejects.toThrow(/too large to edit safely/i);
	});

	it("reads a normal-sized file unchanged", async () => {
		const small = await writeTmp("small.txt", 32);
		const text = await readEditFileText(small, "small.txt");
		expect(text.length).toBe(32);
	});

	it("rejects an oversized notebook before the notebook fast-path (F19 not bypassable via .ipynb)", async () => {
		const bigNb = await writeTmp("big.ipynb", MAX_EDIT_FILE_BYTES + 1024);
		await expect(readEditFileText(bigNb, "big.ipynb")).rejects.toThrow(/too large to edit safely/i);
	});
});

describe("sqlite raw query row cap (W7 / F20)", () => {
	it("caps an unbounded raw SELECT and flags truncation", () => {
		const db = new Database(":memory:");
		db.run("CREATE TABLE t (id INTEGER)");
		const insert = db.prepare("INSERT INTO t (id) VALUES (?)");
		for (let i = 0; i < 1500; i++) insert.run(i);
		try {
			const result = executeReadQuery(db, "SELECT * FROM t");
			expect(result.rows.length).toBe(1000); // capped, not 1500
			expect(result.truncated).toBe(true);
		} finally {
			db.close();
		}
	});

	it("returns all rows (not truncated) when under the cap", () => {
		const db = new Database(":memory:");
		db.run("CREATE TABLE t (id INTEGER)");
		const insert = db.prepare("INSERT INTO t (id) VALUES (?)");
		for (let i = 0; i < 5; i++) insert.run(i);
		try {
			const result = executeReadQuery(db, "SELECT * FROM t");
			expect(result.rows.length).toBe(5);
			expect(result.truncated).toBe(false);
		} finally {
			db.close();
		}
	});
});
