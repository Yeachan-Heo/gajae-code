import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { CURRENT_SESSION_VERSION } from "../src/sdk/session-readonly/format";
import { readSessionMetadata } from "../src/sdk/session-readonly/metadata";

const directories: string[] = [];
afterEach(async () => {
	for (const directory of directories.splice(0)) await fs.rm(directory, { recursive: true, force: true });
});

async function directory(): Promise<string> {
	const value = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-readonly-metadata-"));
	directories.push(value);
	return value;
}

describe("readonly session metadata", () => {
	it("reads the existing prefix and trailing patch semantics without native persistence or recap enrichment", async () => {
		const file = path.join(await directory(), "history.jsonl");
		const records = [
			{
				type: "session",
				version: CURRENT_SESSION_VERSION,
				id: "readonly-history",
				cwd: "/original",
				timestamp: "2026-01-02T03:04:05.000Z",
				starredPatchVersion: 1,
			},
			{
				type: "message",
				id: "first",
				message: {
					role: "user",
					content: [
						{ type: "text", text: "hello" },
						{ type: "text", text: "world" },
					],
				},
			},
			{ type: "message", id: "large", message: { role: "assistant", content: "x".repeat(80_000) } },
			{ type: "header_patch", patch: { cwd: "/moved", title: "Current title", starred: true } },
		];
		await Bun.write(file, `${records.map(record => JSON.stringify(record)).join("\n")}\n`);
		const before = await fs.stat(file, { bigint: true });
		const rows = await readSessionMetadata([file]);
		expect(rows).toHaveLength(1);
		expect(rows[0]).toMatchObject({
			path: file,
			id: "readonly-history",
			cwd: "/moved",
			title: "Current title",
			starred: true,
			firstMessage: "hello world",
			allMessagesText: "hello world",
			messageCount: 2,
			messageCountIsEstimate: true,
			size: Number(before.size),
		});
		expect(rows[0]!.created.toISOString()).toBe("2026-01-02T03:04:05.000Z");
		expect(rows[0]!.modified.getTime()).toBe(Number(before.mtimeMs));
		expect(Object.hasOwn(rows[0]!, "recap")).toBe(false);
		const after = await fs.stat(file, { bigint: true });
		expect([after.dev, after.ino, after.size, after.mtimeNs]).toEqual([
			before.dev,
			before.ino,
			before.size,
			before.mtimeNs,
		]);
	});

	it("omits unreadable selected paths without creating their parent directory", async () => {
		const parent = path.join(await directory(), "missing-parent");
		expect(await readSessionMetadata([path.join(parent, "missing.jsonl")])).toEqual([]);
		await expect(fs.lstat(parent)).rejects.toMatchObject({ code: "ENOENT" });
	});
});
