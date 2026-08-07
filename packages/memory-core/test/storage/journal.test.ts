import { afterEach, describe, expect, it, spyOn } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import {
	appendJournalProgress,
	createJournal,
	getJournalPath,
	getJournalProgressPath,
	type JournalEntry,
	type MemoryJournal,
	MemoryJournalError,
	readJournal,
} from "../../src/storage/journal";

const temporaryRoots: string[] = [];

afterEach(async () => {
	await Promise.all(temporaryRoots.splice(0).map(root => fs.rm(root, { force: true, recursive: true })));
});

async function makeRoot(): Promise<string> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "memory-core-journal-"));
	temporaryRoots.push(root);
	return root;
}

async function captureError(task: () => Promise<unknown>): Promise<unknown> {
	return task().then(
		() => undefined,
		error => error,
	);
}

async function expectJournalError(task: () => Promise<unknown>, message: string): Promise<MemoryJournalError> {
	const error = await captureError(task);
	expect(error).toBeInstanceOf(MemoryJournalError);
	expect((error as MemoryJournalError).code).toBe("lock-conflict");
	expect((error as Error).message).toContain(message);
	return error as MemoryJournalError;
}

function planEntries(): JournalEntry[] {
	return [
		{
			relPath: "global/profile.md",
			expectedDigest: "pre-profile-digest",
			postDigest: "post-profile-digest",
			tempPath: ".journal/stage-profile.tmp",
		},
		{
			relPath: "projects/demo/README.md",
			expectedDigest: null,
			postDigest: "post-readme-digest",
			tempPath: ".journal/stage-readme.tmp",
		},
	];
}

async function replaceBoundDirectory(root: string, kind: "root" | "journal"): Promise<void> {
	const target = kind === "root" ? root : path.join(root, ".journal");
	const moved = `${target}.moved`;
	await fs.rename(target, moved);
	if (kind === "root") {
		temporaryRoots.push(moved);
		await fs.mkdir(root, { mode: 0o700 });
		await fs.mkdir(path.join(root, ".journal"), { mode: 0o700 });
		return;
	}
	await fs.mkdir(target, { mode: 0o700 });
}

describe("memory journal", () => {
	it("persists an immutable pre/postimage plan and refuses duplicate mutation creation", async () => {
		const root = await makeRoot();
		const mutationId = "mutation-plan";
		const entries = planEntries();
		const candidate: MemoryJournal = {
			schemaVersion: "gajae.memory.journal.v1",
			mutationId,
			entries,
		};

		const created = await createJournal(root, candidate);
		const journalPath = getJournalPath(root, mutationId);
		const expectedSerialized = `${JSON.stringify({
			schemaVersion: "gajae.memory.journal.v1",
			mutationId,
			entries,
		})}\n`;
		expect(created).toEqual(candidate);
		expect((await fs.stat(journalPath)).mode & 0o777).toBe(0o600);
		expect(await fs.readFile(journalPath, "utf8")).toBe(expectedSerialized);

		(entries[0] as { expectedDigest: string | null }).expectedDigest = "tampered-after-create";
		const persisted = await readJournal(root, mutationId);
		expect(persisted.entries[0]?.expectedDigest).toBe("pre-profile-digest");
		expect(persisted.entries[0]?.postDigest).toBe("post-profile-digest");
		const beforeDuplicate = await fs.readFile(journalPath);
		const duplicateError = await expectJournalError(() => createJournal(root, candidate), "journal already exists");
		expect(duplicateError.relPath).toBe(`${mutationId}.json`);
		expect((await fs.readFile(journalPath)).equals(beforeDuplicate)).toBe(true);
	});

	it("appends newline-delimited progress without rewriting earlier lines", async () => {
		const root = await makeRoot();
		const mutationId = "mutation-progress";
		await createJournal(root, mutationId, []);
		const progressPath = getJournalProgressPath(root, mutationId);

		await appendJournalProgress(root, mutationId, { kind: "stage", index: 0 });
		expect(await fs.readFile(progressPath, "utf8")).toBe("stage 0\n");
		const beforePublish = await fs.readFile(progressPath);
		await appendJournalProgress(progressPath, "publish-begin 0");
		expect((await fs.readFile(progressPath, "utf8")).startsWith(beforePublish.toString("utf8"))).toBe(true);
		expect(await fs.readFile(progressPath, "utf8")).toBe("stage 0\npublish-begin 0\n");

		await appendJournalProgress(root, mutationId, "publish-end", 0);
		await appendJournalProgress(root, mutationId, { kind: "commit" });
		expect(await fs.readFile(progressPath, "utf8")).toBe("stage 0\npublish-begin 0\npublish-end 0\ncommit\n");
		expect((await fs.stat(progressPath)).mode & 0o777).toBe(0o600);

		const beforeMalformed = await fs.readFile(progressPath);
		await expectJournalError(
			() => appendJournalProgress(root, mutationId, "not-a-progress"),
			"journal progress kind is invalid",
		);
		expect((await fs.readFile(progressPath)).equals(beforeMalformed)).toBe(true);
	});

	it("validates journal schema, mutation identity, and duplicate entry paths before writing", async () => {
		const root = await makeRoot();
		const journalDirectory = path.join(root, ".journal");
		await fs.mkdir(journalDirectory, { mode: 0o700 });

		const unsupportedId = "unsupported-schema";
		const unsupportedPath = getJournalPath(root, unsupportedId);
		await fs.writeFile(
			unsupportedPath,
			JSON.stringify({ schemaVersion: "wrong.version", mutationId: unsupportedId, entries: [] }),
			{ mode: 0o600 },
		);
		await expectJournalError(() => readJournal(root, unsupportedId), "journal schema is unsupported or malformed");

		const mismatchId = "path-mismatch";
		const mismatchPath = getJournalPath(root, mismatchId);
		await fs.writeFile(
			mismatchPath,
			JSON.stringify({ schemaVersion: "gajae.memory.journal.v1", mutationId: "other-id", entries: [] }),
			{ mode: 0o600 },
		);
		await expectJournalError(() => readJournal(root, mismatchId), "journal mutation id does not match its path");

		const duplicateId = "duplicate-entry";
		const duplicateEntry: JournalEntry = {
			relPath: "same.md",
			expectedDigest: null,
			postDigest: "post",
			tempPath: ".journal/stage.tmp",
		};
		await expectJournalError(
			() => createJournal(root, duplicateId, [duplicateEntry, { ...duplicateEntry }]),
			"journal contains duplicate paths",
		);
		expect(
			await fs.stat(getJournalPath(root, duplicateId)).then(
				() => true,
				() => false,
			),
		).toBe(false);

		const malformedId = "malformed-entry";
		await expectJournalError(
			() =>
				createJournal(root, {
					schemaVersion: "gajae.memory.journal.v1",
					mutationId: malformedId,
					entries: [{ relPath: "bad.md", expectedDigest: null, postDigest: "", tempPath: "tmp" }],
				}),
			"journal digest is malformed",
		);
		expect(
			await fs.stat(getJournalPath(root, malformedId)).then(
				() => true,
				() => false,
			),
		).toBe(false);
	});

	it("rejects malformed or truncated journal bytes without changing them", async () => {
		const root = await makeRoot();
		await fs.mkdir(path.join(root, ".journal"), { mode: 0o700 });
		const mutationId = "truncated";
		const journalPath = getJournalPath(root, mutationId);
		const truncated = Buffer.from(
			'{"schemaVersion":"gajae.memory.journal.v1","mutationId":"truncated","entries":[',
			"utf8",
		);
		await fs.writeFile(journalPath, truncated, { mode: 0o600 });

		await expectJournalError(() => readJournal(root, mutationId), "journal JSON is malformed");
		expect((await fs.readFile(journalPath)).equals(truncated)).toBe(true);

		const invalidProgressPath = getJournalProgressPath(root, mutationId);
		const invalidProgress = Buffer.from("publish-end", "utf8");
		await fs.writeFile(invalidProgressPath, invalidProgress, { mode: 0o600 });
		const beforeInvalidAppend = await fs.readFile(invalidProgressPath);
		await expectJournalError(
			() => appendJournalProgress(invalidProgressPath, "publish-end"),
			"journal progress is missing",
		);
		expect((await fs.readFile(invalidProgressPath)).equals(beforeInvalidAppend)).toBe(true);
	});

	it("fails closed when the root or journal directory is replaced around descriptor operations", async () => {
		for (const operation of ["create", "append"] as const) {
			for (const kind of ["root", "journal"] as const) {
				const root = await makeRoot();
				const mutationId = `binding-${operation}-${kind}`;
				if (operation === "create") await fs.mkdir(path.join(root, ".journal"), { mode: 0o700 });
				else await createJournal(root, mutationId, []);
				const originalOpen = fs.open.bind(fs);
				let replaced = false;
				const openSpy = spyOn(fs, "open").mockImplementation((async (file, flags, mode) => {
					const handle = await originalOpen(file, flags, mode);
					if (!replaced) {
						replaced = true;
						await replaceBoundDirectory(root, kind);
					}
					return handle;
				}) as typeof fs.open);
				try {
					if (operation === "create") {
						await expectJournalError(() => createJournal(root, mutationId, []), "binding changed");
					} else {
						await expectJournalError(
							() => appendJournalProgress(root, mutationId, { kind: "stage", index: 0 }),
							"binding changed",
						);
					}
				} finally {
					openSpy.mockRestore();
				}
				expect(replaced).toBe(true);
				const artifact =
					operation === "create" ? getJournalPath(root, mutationId) : getJournalProgressPath(root, mutationId);
				expect(
					await fs.stat(artifact).then(
						() => true,
						() => false,
					),
				).toBe(false);
			}
		}
	});
});
