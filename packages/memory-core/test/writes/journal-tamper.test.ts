import { afterEach, describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import type { MemoryEnvironment } from "../../src/env";
import {
	appendJournalProgress,
	createJournal,
	getJournalPath,
	getJournalProgressPath,
	type JournalEntry,
} from "../../src/storage/journal";
import { recoverJournal } from "../../src/writes/apply";

const parents: string[] = [];

afterEach(async () => {
	await Promise.all(parents.splice(0).map(parent => fs.rm(parent, { recursive: true, force: true })));
});

function digest(value: string): string {
	return createHash("sha256").update(Buffer.from(value, "utf8")).digest("hex");
}

function environment(memoryRoot: string): MemoryEnvironment {
	return {
		memoryRoot,
		repository: null,
		sessionId: null,
		now: new Date("2026-07-29T00:00:00.000Z"),
		deterministic: true,
		asOf: "2026-07-29T00:00:00.000Z",
	};
}

async function makeRoot(): Promise<string> {
	const parent = await fs.mkdtemp(path.join(os.tmpdir(), "memory-core-tamper-"));
	parents.push(parent);
	const root = path.join(parent, "root");
	await fs.mkdir(root, { mode: 0o700 });
	await fs.mkdir(path.join(root, ".locks"), { mode: 0o700 });
	await fs.mkdir(path.join(root, "global"), { mode: 0o700 });
	return root;
}

async function seed(root: string, mutationId: string, tempContent = "after"): Promise<JournalEntry> {
	const entry: JournalEntry = {
		relPath: "global/item.md",
		expectedDigest: digest("before"),
		postDigest: digest(tempContent),
		tempPath: `.journal/${mutationId}.tmp`,
	};
	await fs.writeFile(path.join(root, entry.relPath), "before", { mode: 0o600 });
	await createJournal(root, mutationId, [entry]);
	await fs.writeFile(path.join(root, entry.tempPath), tempContent, { mode: 0o600 });
	await appendJournalProgress(root, mutationId, { kind: "stage", index: 0 });
	await appendJournalProgress(root, mutationId, { kind: "publish-begin", index: 0 });
	return entry;
}

async function expectTampered(root: string, mutationId: string, relPath = "global/item.md"): Promise<void> {
	const journalBefore = await fs.readFile(getJournalPath(root, mutationId));
	const progressBefore = await fs.readFile(getJournalProgressPath(root, mutationId));
	const result = await recoverJournal(environment(root));
	expect(result.ok).toBe(false);
	if (result.ok) return;
	const error = result.error;
	expect(error.code).toBe("lock-conflict");
	expect(error.exitCode).toBe(12);
	if (error.code !== "lock-conflict") return;
	expect(error.relPath).toContain(relPath);
	expect((await fs.readFile(getJournalPath(root, mutationId))).equals(journalBefore)).toBe(true);
	expect((await fs.readFile(getJournalProgressPath(root, mutationId))).equals(progressBefore)).toBe(true);
}

describe("D-11 journal tamper detection", () => {
	it("fails closed when target bytes change after publish-begin", async () => {
		const root = await makeRoot();
		const mutationId = "target-mutated";
		await seed(root, mutationId);
		await fs.writeFile(path.join(root, "global/item.md"), "unexpected");
		await expectTampered(root, mutationId);
	});

	it("fails closed when the temp is deleted or its bytes change", async () => {
		for (const mode of ["deleted", "mutated"] as const) {
			const root = await makeRoot();
			const mutationId = `temp-${mode}`;
			const entry = await seed(root, mutationId);
			if (mode === "deleted") await fs.unlink(path.join(root, entry.tempPath));
			else await fs.writeFile(path.join(root, entry.tempPath), "tampered");
			await expectTampered(root, mutationId, entry.relPath);
		}
	});

	it("fails closed when the target is replaced with a directory", async () => {
		const root = await makeRoot();
		const mutationId = "target-directory";
		await seed(root, mutationId);
		await fs.unlink(path.join(root, "global/item.md"));
		await fs.mkdir(path.join(root, "global/item.md"), { mode: 0o700 });
		await expectTampered(root, mutationId);
	});

	it("retains a truncated journal and a progress line ending mid-record", async () => {
		for (const mode of ["journal", "progress"] as const) {
			const root = await makeRoot();
			const mutationId = `truncated-${mode}`;
			const entry = await seed(root, mutationId);
			if (mode === "journal")
				await fs.writeFile(getJournalPath(root, mutationId), Buffer.from('{"schemaVersion":', "utf8"));
			else
				await fs.writeFile(getJournalProgressPath(root, mutationId), Buffer.from("stage 0\npublish-begin", "utf8"));
			const result = await recoverJournal(environment(root));
			expect(result.ok).toBe(false);
			if (result.ok) continue;
			const error = result.error;
			expect(error.code).toBe("lock-conflict");
			expect(error.exitCode).toBe(12);
			if (error.code !== "lock-conflict") continue;
			expect(error.relPath).toContain(mode === "progress" ? entry.relPath : mutationId);
			expect(await fs.lstat(getJournalPath(root, mutationId))).toBeDefined();
			expect(await fs.lstat(getJournalProgressPath(root, mutationId))).toBeDefined();
		}
	});

	it("fails closed when postDigest matches neither disk image", async () => {
		const root = await makeRoot();
		const mutationId = "bad-postimage";
		const entry = await seed(root, mutationId);
		await fs.writeFile(
			getJournalPath(root, mutationId),
			`${JSON.stringify({
				schemaVersion: "gajae.memory.journal.v1",
				mutationId,
				entries: [{ ...entry, postDigest: digest("neither") }],
			})}\n`,
		);
		await expectTampered(root, mutationId);
	});

	it("fails closed when publish-begin is unstaged", async () => {
		const root = await makeRoot();
		const mutationId = "unstaged-publish-begin";
		const entry = await seed(root, mutationId);
		await fs.writeFile(getJournalProgressPath(root, mutationId), "publish-begin 0\n", { mode: 0o600 });
		await expectTampered(root, mutationId, entry.relPath);
		expect(await fs.readFile(path.join(root, entry.relPath), "utf8")).toBe("before");
		expect(await fs.readFile(path.join(root, entry.tempPath), "utf8")).toBe("after");
	});

	it("fails closed when stage indices are out of order", async () => {
		const root = await makeRoot();
		const mutationId = "out-of-order-stage";
		const entries: JournalEntry[] = [
			{
				relPath: "global/first.md",
				expectedDigest: digest("before-first"),
				postDigest: digest("after-first"),
				tempPath: `.journal/${mutationId}.0.tmp`,
			},
			{
				relPath: "global/second.md",
				expectedDigest: digest("before-second"),
				postDigest: digest("after-second"),
				tempPath: `.journal/${mutationId}.1.tmp`,
			},
		];
		for (const entry of entries) {
			await fs.writeFile(
				path.join(root, entry.relPath),
				entry.relPath.includes("first") ? "before-first" : "before-second",
				{
					mode: 0o600,
				},
			);
		}
		await createJournal(root, mutationId, entries);
		await fs.writeFile(path.join(root, entries[0]?.tempPath ?? ""), "after-first", { mode: 0o600 });
		await fs.writeFile(path.join(root, entries[1]?.tempPath ?? ""), "after-second", { mode: 0o600 });
		await fs.writeFile(getJournalProgressPath(root, mutationId), "stage 1\nstage 0\n", { mode: 0o600 });
		await expectTampered(root, mutationId, entries[0]?.relPath ?? "global/first.md");
		expect(await fs.readFile(path.join(root, "global/first.md"), "utf8")).toBe("before-first");
		expect(await fs.readFile(path.join(root, "global/second.md"), "utf8")).toBe("before-second");
	});

	it("retains a valid staged temp while completing a no-progress recovery", async () => {
		const root = await makeRoot();
		const mutationId = "p9-retained-temp";
		const entry = await seed(root, mutationId);
		await fs.writeFile(path.join(root, entry.relPath), "after", { mode: 0o600 });
		await fs.rm(getJournalProgressPath(root, mutationId), { force: true });
		const result = await recoverJournal(environment(root));
		expect(result).toEqual({
			ok: true,
			value: [
				{
					mutationId,
					state: "complete",
					relPaths: [entry.relPath],
				},
			],
		});
		expect(await fs.readFile(path.join(root, entry.relPath), "utf8")).toBe("after");
		expect(
			await fs.lstat(path.join(root, entry.tempPath)).then(
				() => true,
				() => false,
			),
		).toBe(false);
		expect(
			await fs.lstat(getJournalPath(root, mutationId)).then(
				() => true,
				() => false,
			),
		).toBe(false);
	});

	it("fails closed when recovery authorization rejects a digest-matching secret temp", async () => {
		const root = await makeRoot();
		const mutationId = "secret-recovery-temp";
		// A real detectable credential shape: the temp digest matches the journal
		// postimage, so only the recovery-time secret rescan can reject it.
		const secretContent = "after token=sk-live-abcdefghijklmnopqrstuvwx";
		const entry = await seed(root, mutationId, secretContent);
		const targetBefore = await fs.readFile(path.join(root, entry.relPath));
		const journalBefore = await fs.readFile(getJournalPath(root, mutationId));
		const progressBefore = await fs.readFile(getJournalProgressPath(root, mutationId));
		const result = await recoverJournal(environment(root));
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.error.code).toBe("lock-conflict");
		expect(result.error.exitCode).toBe(12);
		if (result.error.code !== "lock-conflict") return;
		expect(result.error.relPath).toContain(entry.relPath);
		expect((await fs.readFile(path.join(root, entry.relPath))).equals(targetBefore)).toBe(true);
		expect((await fs.readFile(getJournalPath(root, mutationId))).equals(journalBefore)).toBe(true);
		expect((await fs.readFile(getJournalProgressPath(root, mutationId))).equals(progressBefore)).toBe(true);
		expect(await fs.readFile(path.join(root, entry.tempPath), "utf8")).toBe(secretContent);
	});

	it("refuses a journal whose tempPath names a canonical document", async () => {
		const root = await makeRoot();
		const canonical = "global/item.md";
		await fs.writeFile(path.join(root, canonical), "before", { mode: 0o600 });
		// A tampered plan must never be able to point recovery cleanup at real memory
		// content: accepting this would let P9 unlink a canonical document and still
		// report completion.
		await expect(
			createJournal(root, "aliased-temp", [
				{
					relPath: canonical,
					expectedDigest: digest("before"),
					postDigest: digest("before"),
					tempPath: canonical,
				},
			]),
		).rejects.toMatchObject({ code: "lock-conflict", exitCode: 12 });
		expect(await fs.readFile(path.join(root, canonical), "utf8")).toBe("before");
	});
});
