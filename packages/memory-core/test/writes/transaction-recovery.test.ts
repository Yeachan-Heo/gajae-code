import { afterEach, describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import type { MemoryEnvironment } from "../../src/env";
import { createMemoryRootScaffold } from "../../src/storage/bootstrap-init";
import {
	getJournalPath,
	getJournalProgressPath,
	type JournalEntry,
	type JournalProgress,
	journalRelPathSet,
	readJournal,
	readJournalProgress,
} from "../../src/storage/journal";
import { type ApplyHooks, applyMemoryWithHooks, recoverJournal } from "../../src/writes/apply";
import { proposeMemory, readStagedProposal } from "../../src/writes/proposal";

const parents: string[] = [];
const RECOVERY_POINTS = ["P0", "P1", "P2", "P3", "P4", "P5", "P6", "P7", "P8", "P9"] as const;
type RecoveryPoint = (typeof RECOVERY_POINTS)[number];

type ByteSnapshot = ReadonlyMap<string, Buffer | null>;

interface RealTransactionFixture {
	readonly root: string;
	readonly proposalId: string;
	readonly mutationId: string;
	readonly paths: readonly string[];
	readonly before: ByteSnapshot;
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

function errorCode(error: unknown): string | undefined {
	if (error === null || typeof error !== "object" || !("code" in error)) return undefined;
	const code = (error as { readonly code?: unknown }).code;
	return typeof code === "string" ? code : undefined;
}

async function exists(filePath: string): Promise<boolean> {
	try {
		await fs.lstat(filePath);
		return true;
	} catch (error) {
		if (errorCode(error) === "ENOENT") return false;
		throw error;
	}
}

async function makeRoot(): Promise<string> {
	const parent = await fs.mkdtemp(path.join(os.tmpdir(), "memory-core-recovery-real-"));
	parents.push(parent);
	const root = path.join(parent, "root");
	await createMemoryRootScaffold(root);
	return root;
}

function digest(value: Uint8Array): string {
	return createHash("sha256").update(value).digest("hex");
}

async function readMaybe(root: string, relPath: string): Promise<Buffer | null> {
	try {
		return await fs.readFile(path.join(root, relPath));
	} catch (error) {
		if (errorCode(error) === "ENOENT") return null;
		throw error;
	}
}

async function snapshot(root: string, relPaths: readonly string[]): Promise<ByteSnapshot> {
	const values = new Map<string, Buffer | null>();
	for (const relPath of relPaths) values.set(relPath, await readMaybe(root, relPath));
	return values;
}

async function expectSnapshot(root: string, expected: ByteSnapshot): Promise<void> {
	for (const [relPath, expectedBytes] of expected) {
		const actual = await readMaybe(root, relPath);
		if (expectedBytes === null) {
			expect(actual).toBeNull();
			continue;
		}
		expect(actual?.equals(expectedBytes)).toBe(true);
	}
}

async function seedRealTransaction(): Promise<RealTransactionFixture> {
	const root = await makeRoot();
	const proposed = await proposeMemory(environment(root), {
		type: "decision",
		content: "Recovery matrix decision.",
		targetUri: "global://constraints/recovery-matrix.md",
	});
	if (!proposed.ok) throw new Error(proposed.error.code);
	const staged = readStagedProposal(environment(root), proposed.value.proposalId);
	if (!staged.ok) throw new Error(staged.error.code);
	const receiptPath = `global/proposals-${proposed.value.proposalId}.receipt.json`;
	// The immutable staged proposal artifact is deliberately NOT part of the
	// mutation set; only the document, the MAP, and the apply receipt are.
	const paths = Object.freeze([staged.value.documentRelPath, "MEMORY.md", receiptPath]);
	return Object.freeze({
		root,
		proposalId: proposed.value.proposalId,
		mutationId: `apply-${proposed.value.proposalId}`,
		paths,
		before: await snapshot(root, paths),
	});
}

function boundaryIndices(entryCount: number): readonly number[] {
	return Object.freeze([...new Set([0, Math.floor(entryCount / 2), entryCount - 1])]);
}

function progressSequence(kind: "stage" | "publish-begin" | "publish-end", count: number): JournalProgress[] {
	return Array.from({ length: count }, (_, index): JournalProgress => ({ kind, index }));
}

function expectedProgress(point: RecoveryPoint, index: number, entryCount: number): readonly JournalProgress[] {
	if (point === "P0" || point === "P1") return Object.freeze([]);
	if (point === "P2") return Object.freeze(progressSequence("stage", index));
	if (point === "P3") return Object.freeze(progressSequence("stage", index + 1));
	// The transaction stages every entry first, then publishes them one at a time,
	// so each already-published entry contributes a begin/end pair before the
	// in-flight entry's own `publish-begin`.
	const publishedPairs = (upTo: number): readonly JournalProgress[] =>
		Array.from({ length: upTo }, (_unused, entry) => entry).flatMap(entry => [
			{ kind: "publish-begin", index: entry } as JournalProgress,
			{ kind: "publish-end", index: entry } as JournalProgress,
		]);
	if (point === "P4" || point === "P5" || point === "P6") {
		return Object.freeze([
			...progressSequence("stage", entryCount),
			...publishedPairs(index),
			{ kind: "publish-begin", index } as JournalProgress,
		]);
	}
	if (point === "P7") {
		return Object.freeze([...progressSequence("stage", entryCount), ...publishedPairs(index + 1)]);
	}
	return Object.freeze([...progressSequence("stage", entryCount), ...publishedPairs(entryCount), { kind: "commit" }]);
}

async function expectProgressBeforeRecovery(
	fixture: RealTransactionFixture,
	point: RecoveryPoint,
	index: number,
	entries: readonly JournalEntry[],
): Promise<void> {
	const progressPath = getJournalProgressPath(fixture.root, fixture.mutationId);
	if (point === "P9") {
		expect(await exists(progressPath)).toBe(false);
		return;
	}
	const expected = expectedProgress(point, index, entries.length);
	expect(await readJournalProgress(fixture.root, fixture.mutationId)).toEqual(expected);
	expect(await exists(progressPath)).toBe(expected.length > 0);
}

async function expectJournalArtifactsGone(
	fixture: RealTransactionFixture,
	entries: readonly JournalEntry[],
): Promise<void> {
	expect(await exists(getJournalPath(fixture.root, fixture.mutationId))).toBe(false);
	expect(await exists(getJournalProgressPath(fixture.root, fixture.mutationId))).toBe(false);
	for (const entry of entries) expect(await exists(path.join(fixture.root, entry.tempPath))).toBe(false);
	expect(await fs.readdir(path.join(fixture.root, ".journal"))).toEqual([]);
}

async function expectPostImages(root: string, entries: readonly JournalEntry[]): Promise<void> {
	for (const entry of entries) {
		const bytes = await fs.readFile(path.join(root, entry.relPath));
		expect(digest(bytes)).toBe(entry.postDigest);
	}
}

async function killChildAtBoundary(
	fixture: RealTransactionFixture,
	point: RecoveryPoint,
	index: number,
): Promise<void> {
	const child = Bun.spawn([process.execPath, path.join(import.meta.dir, "transaction-recovery.test.ts")], {
		env: {
			...process.env,
			MEMORY_RECOVERY_CHILD: "1",
			MEMORY_RECOVERY_ROOT: fixture.root,
			MEMORY_RECOVERY_PROPOSAL: fixture.proposalId,
			MEMORY_RECOVERY_POINT: point,
			MEMORY_RECOVERY_INDEX: String(index),
		},
		stdout: "pipe",
		stderr: "pipe",
	});
	const [stdout, stderr] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()]);
	const exitCode = await child.exited;
	if (exitCode === 0) throw new Error(`child did not stop at ${point}/${index}: ${stdout}\n${stderr}`);
}

function terminateChild(): void {
	process.kill(process.pid, "SIGKILL");
}

async function runRecoveryChild(): Promise<void> {
	const root = process.env.MEMORY_RECOVERY_ROOT;
	const proposalId = process.env.MEMORY_RECOVERY_PROPOSAL;
	const point = process.env.MEMORY_RECOVERY_POINT as RecoveryPoint | undefined;
	const indexText = process.env.MEMORY_RECOVERY_INDEX;
	if (root === undefined || proposalId === undefined || point === undefined || indexText === undefined) {
		throw new Error("recovery child configuration is incomplete");
	}
	const index = Number(indexText);
	const hooks: ApplyHooks = {
		afterLocks: () => {
			if (point === "P0") terminateChild();
		},
		afterJournalCreate: () => {
			if (point === "P1") terminateChild();
		},
		afterStage: (_entry, entryIndex) => {
			if (point === "P2" && entryIndex === index) terminateChild();
		},
		afterStageBoundary: entryIndex => {
			if (point === "P3" && entryIndex === index) terminateChild();
		},
		afterPublishBegin: entryIndex => {
			if (point === "P4" && entryIndex === index) terminateChild();
		},
		beforePublish: (_entry, entryIndex) => {
			if (point === "P5" && entryIndex === index) terminateChild();
		},
		afterPublish: (_entry, entryIndex) => {
			if (point === "P6" && entryIndex === index) terminateChild();
		},
		afterPublishEnd: entryIndex => {
			if (point === "P7" && entryIndex === index) terminateChild();
		},
		afterCommit: () => {
			if (point === "P8") terminateChild();
		},
		afterProgressUnlink: () => {
			if (point === "P9") terminateChild();
		},
	};
	const result = await applyMemoryWithHooks(environment(root), { proposalId }, hooks);
	throw new Error(`recovery child completed instead of stopping at ${point}: ${result.ok ? "ok" : result.error.code}`);
}

if (process.env.MEMORY_RECOVERY_CHILD !== undefined) {
	await runRecoveryChild();
} else {
	afterEach(async () => {
		await Promise.all(parents.splice(0).map(parent => fs.rm(parent, { recursive: true, force: true })));
	});

	describe("D-11 transaction recovery", () => {
		it("SIGKILLs the real apply lifecycle at every P0-P9 boundary and recovers twice", async () => {
			for (const point of RECOVERY_POINTS) {
				const template = await seedRealTransaction();
				for (const index of boundaryIndices(template.paths.length)) {
					const fixture = index === 0 ? template : await seedRealTransaction();
					await killChildAtBoundary(fixture, point, index);
					const journalPath = getJournalPath(fixture.root, fixture.mutationId);
					if (point === "P0") {
						expect(await exists(journalPath)).toBe(false);
						const first = await recoverJournal(environment(fixture.root));
						const second = await recoverJournal(environment(fixture.root));
						expect(first).toEqual({ ok: true, value: [] });
						expect(second).toEqual({ ok: true, value: [] });
						await expectSnapshot(fixture.root, fixture.before);
						expect(await fs.readdir(path.join(fixture.root, ".journal"))).toEqual([]);
						continue;
					}
					const journal = await readJournal(fixture.root, fixture.mutationId);
					expect(journal.entries).toHaveLength(fixture.paths.length);
					await expectProgressBeforeRecovery(fixture, point, index, journal.entries);
					const first = await recoverJournal(environment(fixture.root));
					expect(first.ok).toBe(true);
					if (!first.ok) continue;
					expect(first.value).toHaveLength(1);
					const firstOutcome = first.value[0];
					if (firstOutcome === undefined) continue;
					const rollbackable = point === "P1" || point === "P2" || point === "P3";
					const expectedState =
						(point === "P6" || point === "P7") && index === journal.entries.length - 1
							? "complete"
							: "publishable";
					expect(firstOutcome.state).toBe(
						rollbackable ? "rollbackable" : point === "P8" || point === "P9" ? "complete" : expectedState,
					);
					if (rollbackable) await expectSnapshot(fixture.root, fixture.before);
					else await expectPostImages(fixture.root, journal.entries);
					await expectJournalArtifactsGone(fixture, journal.entries);
					const afterFirst = await snapshot(fixture.root, fixture.paths);
					const second = await recoverJournal(environment(fixture.root));
					expect(second).toEqual({ ok: true, value: [] });
					const afterSecond = await snapshot(fixture.root, fixture.paths);
					await expectSnapshot(fixture.root, afterFirst);
					await expectSnapshot(fixture.root, afterSecond);
				}
			}
		});

		it("reports every affected path and retains a mixed transaction fail-closed", async () => {
			const fixture = await seedRealTransaction();
			const index = boundaryIndices(fixture.paths.length)[1] ?? 0;
			await killChildAtBoundary(fixture, "P4", index);
			const journal = await readJournal(fixture.root, fixture.mutationId);
			const mixedEntry = journal.entries[index];
			if (mixedEntry === undefined) throw new Error("mixed entry is unavailable");
			await fs.writeFile(path.join(fixture.root, mixedEntry.relPath), Buffer.from("tampered\n", "utf8"), {
				mode: 0o600,
			});
			const journalBefore = await fs.readFile(getJournalPath(fixture.root, fixture.mutationId));
			const progressBefore = await fs.readFile(getJournalProgressPath(fixture.root, fixture.mutationId));
			const expectedPaths = journalRelPathSet(journal.entries.slice(0, index + 1).map(entry => entry.relPath));
			for (let attempt = 0; attempt < 2; attempt += 1) {
				const recovered = await recoverJournal(environment(fixture.root));
				expect(recovered.ok).toBe(false);
				if (!recovered.ok) {
					expect(recovered.error.code).toBe("lock-conflict");
					if (recovered.error.code === "lock-conflict") {
						expect(recovered.error.exitCode).toBe(12);
						expect(recovered.error.relPath).toBe(expectedPaths);
					}
				}
				expect((await fs.readFile(getJournalPath(fixture.root, fixture.mutationId))).equals(journalBefore)).toBe(
					true,
				);
				expect(
					(await fs.readFile(getJournalProgressPath(fixture.root, fixture.mutationId))).equals(progressBefore),
				).toBe(true);
			}
		});
	});
}
