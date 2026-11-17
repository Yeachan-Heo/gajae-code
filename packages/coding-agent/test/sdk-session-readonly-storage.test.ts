import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { FileSessionReader, SESSION_RANGE_READ_MAX_BYTES } from "../src/sdk/session-readonly/storage";

const directories: string[] = [];
afterEach(async () => {
	await Promise.all(directories.splice(0).map(directory => fsp.rm(directory, { recursive: true, force: true })));
});
async function fixture(): Promise<{ directory: string; file: string }> {
	const directory = await fsp.mkdtemp(path.join(os.tmpdir(), "gjc-readonly-storage-"));
	directories.push(directory);
	return { directory, file: path.join(directory, "session.jsonl") };
}

describe("shared readonly session storage", () => {
	it("reads exact descriptor snapshots, bounded byte ranges and split UTF-8 prefixes", async () => {
		const { file } = await fixture();
		const bytes = Buffer.from('α😀\n{"type":"session"}\n');
		await Bun.write(file, bytes);
		const reader = new FileSessionReader();
		const snapshot = reader.readSnapshotSync(file);
		const stat = await fsp.stat(file, { bigint: true });
		expect(snapshot.bytes).toEqual(bytes);
		expect(snapshot.stat).toMatchObject({ dev: stat.dev, ino: stat.ino, nlink: stat.nlink, size: bytes.length });
		expect(reader.readRangeSync(file, 2, 4).bytes).toEqual(Buffer.from("😀"));
		expect((await reader.readRange(file, 2, 4)).bytes).toEqual(Buffer.from("😀"));
		expect(await reader.readTextPrefix(file, 3)).toBe("α�");
	});

	it("does not create absent session directories and validates ranges before opening files", async () => {
		const { directory } = await fixture();
		const missing = path.join(directory, "absent", "session.jsonl");
		const reader = new FileSessionReader();
		expect(() => reader.readSnapshotSync(missing)).toThrow(/ENOENT/);
		await expect(reader.readText(missing)).rejects.toMatchObject({ code: "ENOENT" });
		expect(() => reader.readRangeSync(missing, 0, SESSION_RANGE_READ_MAX_BYTES + 1)).toThrow(
			"Session range read exceeds the bounded maximum",
		);
		await expect(reader.readRange(missing, Number.MAX_SAFE_INTEGER, 1)).rejects.toThrow(
			"Session range read start overflows",
		);
		expect(await reader.exists(path.dirname(missing))).toBe(false);
		expect(await fsp.readdir(directory)).toEqual([]);
	});

	it.skipIf((fs.constants.O_NOFOLLOW ?? 0) === 0)(
		"does not follow symbolic links for descriptor snapshots",
		async () => {
			const { directory, file } = await fixture();
			await Bun.write(file, "private transcript");
			const link = path.join(directory, "link.jsonl");
			await fsp.symlink(file, link);
			expect(() => new FileSessionReader().readSnapshotSync(link)).toThrow(/ELOOP/);
			expect(await Bun.file(file).text()).toBe("private transcript");
		},
	);

	it("preserves the distinct snapshot and recorded-range hardlink contracts", async () => {
		const { directory, file } = await fixture();
		await Bun.write(file, "transcript");
		await fsp.link(file, path.join(directory, "hardlink.jsonl"));
		const reader = new FileSessionReader();
		expect(reader.readSnapshotSync(file).stat.nlink).toBe(2n);
		expect(() => reader.readRangeSync(file, 0, 4)).toThrow("source_changed");
		await expect(reader.readRange(file, 0, 4)).rejects.toThrow("source_changed");
		expect(await reader.readText(file)).toBe("transcript");
	});
});
