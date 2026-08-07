import { afterEach, describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import * as fsSync from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	apply,
	checkpoint,
	doctor,
	forget,
	type MemoryEnvironment,
	type MemoryResult,
	propose,
	recall,
	resolveReadableResource,
	resolveReadableResourceSync,
	resume,
	search,
} from "../../src";
import { appendRetrievalLedger } from "../../src/ledger/retrieval-ledger";
import { createMemoryRootScaffold } from "../../src/storage/bootstrap-init";
import {
	appendJournalProgress,
	createJournal,
	getJournalPath,
	getJournalProgressPath,
	type JournalEntry,
	journalRelPathSet,
	readJournal,
	readJournalProgress,
} from "../../src/storage/journal";
import { type ApplyHooks, type ApplyReceipt, applyMemoryWithHooks } from "../../src/writes/apply";
import { proposeMemory, readStagedProposal, type StagedProposalRecord } from "../../src/writes/proposal";

const LIVE_APPLY_SESSION = "live-apply-session";

interface LiveApplyFixture {
	readonly root: string;
	readonly proposalId: string;
	readonly mutationId: string;
	readonly staged: StagedProposalRecord;
	readonly readyPath: string;
	readonly releasePath: string;
}

type LiveApplySubprocess = Bun.Subprocess<"ignore", "pipe", "pipe">;

interface LiveApplyExecution {
	readonly child: LiveApplySubprocess;
	readonly stdout: Promise<string>;
	readonly stderr: Promise<string>;
	readonly exited: Promise<number>;
}

const parents: string[] = [];
const TARGETS = Object.freeze(["global/next-touch-one.md", "global/next-touch-two.md"]);
const TEMPS = Object.freeze([".journal/next-touch.0.tmp", ".journal/next-touch.1.tmp"]);
const MUTATION_ID = "next-touch";
const BEFORE = Object.freeze(["before one\n", "before two\n"]);
const AFTER = Object.freeze(["after one\n", "after two\n"]);

interface PendingFixture {
	readonly root: string;
	readonly entries: readonly JournalEntry[];
	readonly snapshotPaths: readonly string[];
}

function environment(memoryRoot: string, sessionId: string | null = "demo"): MemoryEnvironment {
	return {
		memoryRoot,
		repository: null,
		sessionId,
		now: new Date("2026-07-29T00:00:00.000Z"),
		deterministic: true,
		asOf: "2026-07-29T00:00:00.000Z",
	};
}

function digest(value: string): string {
	return createHash("sha256").update(Buffer.from(value, "utf8")).digest("hex");
}

async function makeRoot(): Promise<string> {
	const parent = await fs.mkdtemp(path.join(os.tmpdir(), "memory-core-next-touch-"));
	parents.push(parent);
	const root = path.join(parent, "root");
	await createMemoryRootScaffold(root);
	return root;
}

async function writeFixture(root: string, relPath: string, content: string): Promise<void> {
	const target = path.join(root, ...relPath.split("/"));
	await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
	await fs.writeFile(target, content, { mode: 0o600 });
	await fs.chmod(target, 0o600);
}

async function readMaybe(root: string, relPath: string): Promise<Buffer | null> {
	try {
		return await fs.readFile(path.join(root, ...relPath.split("/")));
	} catch (error) {
		if (error !== null && typeof error === "object" && "code" in error && error.code === "ENOENT") return null;
		throw error;
	}
}

async function snapshot(root: string, relPaths: readonly string[]): Promise<ReadonlyMap<string, Buffer | null>> {
	const values = new Map<string, Buffer | null>();
	for (const relPath of relPaths) values.set(relPath, await readMaybe(root, relPath));
	return values;
}

async function expectSnapshot(root: string, expected: ReadonlyMap<string, Buffer | null>): Promise<void> {
	for (const [relPath, expectedBytes] of expected) {
		const actual = await readMaybe(root, relPath);
		if (expectedBytes === null) {
			expect(actual).toBeNull();
			continue;
		}
		expect(actual?.equals(expectedBytes)).toBe(true);
	}
}

async function pathExists(filePath: string): Promise<boolean> {
	try {
		await fs.lstat(filePath);
		return true;
	} catch (error) {
		if (error !== null && typeof error === "object" && "code" in error && error.code === "ENOENT") return false;
		throw error;
	}
}

async function seedLiveApply(): Promise<LiveApplyFixture> {
	const root = await makeRoot();
	const proposed = await proposeMemory(environment(root, null), {
		type: "decision",
		content: "A live apply must publish atomically.",
		targetUri: "global://constraints/live-apply-admission.md",
	});
	if (!proposed.ok) throw new Error(proposed.error.code);
	const staged = readStagedProposal(environment(root, null), proposed.value.proposalId);
	if (!staged.ok) throw new Error(staged.error.code);
	const parent = path.dirname(root);
	return Object.freeze({
		root,
		proposalId: proposed.value.proposalId,
		mutationId: `apply-${proposed.value.proposalId}`,
		staged: staged.value,
		readyPath: path.join(parent, "live-apply-ready"),
		releasePath: path.join(parent, "live-apply-release"),
	});
}

function pauseLiveApply(readyPath: string, releasePath: string): void {
	fsSync.writeFileSync(readyPath, "ready\n", { mode: 0o600 });
	const waitState = new Int32Array(new SharedArrayBuffer(4));
	while (!fsSync.existsSync(releasePath)) Atomics.wait(waitState, 0, 0, 10);
}

async function runLiveApplyChild(): Promise<void> {
	const root = process.env.MEMORY_LIVE_APPLY_ROOT;
	const proposalId = process.env.MEMORY_LIVE_APPLY_PROPOSAL;
	const readyPath = process.env.MEMORY_LIVE_APPLY_READY;
	const releasePath = process.env.MEMORY_LIVE_APPLY_RELEASE;
	if (root === undefined || proposalId === undefined || readyPath === undefined || releasePath === undefined) {
		throw new Error("live apply child configuration is incomplete");
	}
	const hooks: ApplyHooks = {
		afterPublishEnd: index => {
			if (index === 0) pauseLiveApply(readyPath, releasePath);
		},
	};
	const result = await applyMemoryWithHooks(environment(root, null), { proposalId }, hooks);
	process.stdout.write(JSON.stringify(result));
}

function spawnLiveApplyChild(fixture: LiveApplyFixture): LiveApplyExecution {
	const child = Bun.spawn([process.execPath, path.join(import.meta.dir, "next-touch-recovery.test.ts")], {
		env: {
			...process.env,
			MEMORY_LIVE_APPLY_CHILD: "1",
			MEMORY_LIVE_APPLY_ROOT: fixture.root,
			MEMORY_LIVE_APPLY_PROPOSAL: fixture.proposalId,
			MEMORY_LIVE_APPLY_READY: fixture.readyPath,
			MEMORY_LIVE_APPLY_RELEASE: fixture.releasePath,
		},
		stdout: "pipe",
		stderr: "pipe",
	});
	return {
		child,
		stdout: new Response(child.stdout).text(),
		stderr: new Response(child.stderr).text(),
		exited: child.exited,
	};
}

async function waitForLiveApplyReady(readyPath: string): Promise<void> {
	const deadline = Date.now() + 10_000;
	while (!fsSync.existsSync(readyPath)) {
		if (Date.now() >= deadline) throw new Error("live apply child did not reach its pause hook");
		await Bun.sleep(5);
	}
}

async function finishLiveApplyChild(execution: LiveApplyExecution): Promise<MemoryResult<ApplyReceipt>> {
	const [stdout, stderr, exitCode] = await Promise.all([execution.stdout, execution.stderr, execution.exited]);
	expect(exitCode, stderr).toBe(0);
	const parsed: unknown = JSON.parse(stdout.trim());
	return parsed as MemoryResult<ApplyReceipt>;
}

async function cleanupLiveApplyChild(execution: LiveApplyExecution, releasePath: string): Promise<void> {
	await fs.writeFile(releasePath, "release\n", { mode: 0o600 }).catch(() => undefined);
	try {
		execution.child.kill("SIGKILL");
	} catch {
		// The child may have exited between the release and cleanup attempts.
	}
	await Promise.allSettled([execution.stdout, execution.stderr, execution.exited]);
}

async function seedPending(): Promise<PendingFixture> {
	const root = await makeRoot();
	const entries = Object.freeze(
		TARGETS.map((relPath, index) => ({
			relPath,
			expectedDigest: digest(BEFORE[index] ?? ""),
			postDigest: digest(AFTER[index] ?? ""),
			tempPath: TEMPS[index] ?? "",
		})),
	);
	await writeFixture(root, TARGETS[0] ?? "", AFTER[0] ?? "");
	await writeFixture(root, TARGETS[1] ?? "", BEFORE[1] ?? "");
	await createJournal(root, MUTATION_ID, entries);
	await writeFixture(root, TEMPS[0] ?? "", AFTER[0] ?? "");
	await writeFixture(root, TEMPS[1] ?? "", AFTER[1] ?? "");
	await appendJournalProgress(root, MUTATION_ID, { kind: "stage", index: 0 });
	await appendJournalProgress(root, MUTATION_ID, { kind: "stage", index: 1 });
	await appendJournalProgress(root, MUTATION_ID, {
		kind: "publish-begin",
		index: 0,
	});
	return {
		root,
		entries,
		snapshotPaths: Object.freeze([
			...TARGETS,
			...TEMPS,
			`.journal/${MUTATION_ID}.json`,
			`.journal/${MUTATION_ID}.progress`,
		]),
	};
}

function expectLockConflict(result: MemoryResult<unknown>, relPath: string): void {
	expect(result.ok).toBe(false);
	if (result.ok) return;
	expect(result.error).toEqual({
		code: "lock-conflict",
		exitCode: 12,
		relPath,
	});
}

async function expectReadBlocked(
	invoke: (environment: MemoryEnvironment) => Promise<MemoryResult<unknown>>,
): Promise<void> {
	const fixture = await seedPending();
	const before = await snapshot(fixture.root, fixture.snapshotPaths);
	const result = await invoke(environment(fixture.root));
	expectLockConflict(result, TARGETS.join(","));
	await expectSnapshot(fixture.root, before);
}

/**
 * Canonical write ingresses share paths with the pending journal, so they either
 * forward-roll it or fail closed. A session-destination write (checkpoint) is
 * path-disjoint by construction: it must succeed WITHOUT touching the canonical
 * journal, which is exactly what keeps disjoint writers from being starved.
 */
async function expectSessionWriteUnaffected(
	invoke: (environment: MemoryEnvironment) => Promise<MemoryResult<unknown>>,
): Promise<void> {
	const fixture = await seedPending();
	const before = await snapshot(fixture.root, fixture.snapshotPaths);
	const result = await invoke(environment(fixture.root));
	expect(result.ok).toBe(true);
	await expectSnapshot(fixture.root, before);
}

async function expectWriteAdmitted(
	invoke: (environment: MemoryEnvironment) => Promise<MemoryResult<unknown>>,
): Promise<void> {
	const fixture = await seedPending();
	const before = await snapshot(fixture.root, fixture.snapshotPaths);
	const result = await invoke(environment(fixture.root));
	if (!result.ok && result.error.code === "lock-conflict") {
		expect(result.error.relPath).toBe(TARGETS.join(","));
		await expectSnapshot(fixture.root, before);
		return;
	}
	for (const [index, relPath] of TARGETS.entries()) {
		expect(await readMaybe(fixture.root, relPath)).toEqual(Buffer.from(AFTER[index] ?? "", "utf8"));
	}
	for (const relPath of fixture.snapshotPaths.slice(TARGETS.length)) {
		expect(await readMaybe(fixture.root, relPath)).toBeNull();
	}
}

if (process.env.MEMORY_LIVE_APPLY_CHILD !== undefined) {
	await runLiveApplyChild();
} else {
	afterEach(async () => {
		await Promise.all(parents.splice(0).map(parent => fs.rm(parent, { recursive: true, force: true })));
	});

	describe("next-touch journal recovery admission", () => {
		it("fails closed on every read ingress without changing a partial tree", async () => {
			await expectReadBlocked(async environmentValue => search(environmentValue, { query: "next-touch" }));
			await expectReadBlocked(async environmentValue => recall(environmentValue, { query: "next-touch" }));
			await expectReadBlocked(environmentValue =>
				resolveReadableResource(environmentValue, "global://next-touch-one.md"),
			);
			await expectReadBlocked(async environmentValue => resume(environmentValue, { sessionId: "demo" }));
			await expectReadBlocked(async environmentValue =>
				Promise.resolve(resolveReadableResourceSync(environmentValue, "global://next-touch-one.md")),
			);
		});

		it("fails closed while a live apply holds the root lock", async () => {
			const fixture = await seedLiveApply();
			let execution: LiveApplyExecution | null = null;
			try {
				const childExecution = spawnLiveApplyChild(fixture);
				execution = childExecution;
				await waitForLiveApplyReady(fixture.readyPath);
				const journal = await readJournal(fixture.root, fixture.mutationId);
				expect(journal.entries.length).toBeGreaterThan(1);
				const affectedRelPaths = journalRelPathSet(journal.entries.map(entry => entry.relPath));
				const finalIndex = journal.entries.length - 1;
				const progress = await readJournalProgress(fixture.root, fixture.mutationId);
				expect(progress.at(-1)).toEqual({ kind: "publish-end", index: 0 });
				expect(progress).not.toContainEqual({ kind: "publish-begin", index: finalIndex });
				expect(await pathExists(path.join(fixture.root, ".locks", "apply.lock", "owner.json"))).toBe(true);
				expect(await pathExists(getJournalPath(fixture.root, fixture.mutationId))).toBe(true);
				expect(await pathExists(getJournalProgressPath(fixture.root, fixture.mutationId))).toBe(true);

				const snapshotPaths = Object.freeze([
					...journal.entries.map(entry => entry.relPath),
					...journal.entries.map(entry => entry.tempPath),
					`.journal/${fixture.mutationId}.json`,
					`.journal/${fixture.mutationId}.progress`,
					`global/proposals-${fixture.proposalId}.json`,
				]);
				const before = await snapshot(fixture.root, snapshotPaths);
				const firstEntry = journal.entries[0];
				if (firstEntry === undefined) throw new Error("live apply journal has no first entry");
				const firstBytes = before.get(firstEntry.relPath);
				if (firstBytes === undefined || firstBytes === null)
					throw new Error("live apply first entry was not published");
				expect(createHash("sha256").update(firstBytes).digest("hex")).toBe(firstEntry.postDigest);
				expect(before.get(firstEntry.tempPath)).not.toBeNull();

				const readEnvironment = environment(fixture.root, null);
				// The child is a live apply owner; reads must not trust owner liveness to bypass journal admission.
				const readIngresses: readonly ((environmentValue: MemoryEnvironment) => Promise<MemoryResult<unknown>>)[] =
					[
						environmentValue => search(environmentValue, { query: "live apply" }),
						environmentValue => recall(environmentValue, { query: "live apply" }),
						environmentValue => resolveReadableResource(environmentValue, fixture.staged.proposal.recommendedUri),
						environmentValue => resume(environmentValue, { sessionId: LIVE_APPLY_SESSION }),
						environmentValue =>
							Promise.resolve(
								resolveReadableResourceSync(environmentValue, fixture.staged.proposal.recommendedUri),
							),
					];
				for (const invoke of readIngresses) {
					const result = await invoke(readEnvironment);
					expectLockConflict(result, affectedRelPaths);
					await expectSnapshot(fixture.root, before);
				}

				const checkpointResult = await checkpoint(environment(fixture.root, LIVE_APPLY_SESSION), {
					goal: "Preserve session writes during live apply.",
					task: "Exercise path-scoped journal admission.",
					nextSteps: ["Release the apply child"],
				});
				expect(checkpointResult.ok).toBe(true);
				if (!checkpointResult.ok) throw new Error(checkpointResult.error.code);
				const ledgerResult = await appendRetrievalLedger(environment(fixture.root, LIVE_APPLY_SESSION), {
					query: "live apply retrieval",
					intent: "generic-recall",
				});
				expect(ledgerResult.ok).toBe(true);
				if (!ledgerResult.ok) throw new Error(ledgerResult.error.code);
				expect(ledgerResult.value.written).toBe(true);
				await expectSnapshot(fixture.root, before);

				await fs.writeFile(fixture.releasePath, "release\n", { mode: 0o600 });
				const applied = await finishLiveApplyChild(childExecution);
				expect(applied.ok).toBe(true);
				if (!applied.ok) throw new Error(applied.error.code);
				expect(applied.value).toMatchObject({
					proposalId: fixture.proposalId,
					mutationId: fixture.mutationId,
					applied: true,
				});
				for (const entry of journal.entries) {
					const bytes = await fs.readFile(path.join(fixture.root, ...entry.relPath.split("/")));
					expect(createHash("sha256").update(bytes).digest("hex")).toBe(entry.postDigest);
					expect(await pathExists(path.join(fixture.root, ...entry.tempPath.split("/")))).toBe(false);
				}
				expect(await pathExists(getJournalPath(fixture.root, fixture.mutationId))).toBe(false);
				expect(await pathExists(getJournalProgressPath(fixture.root, fixture.mutationId))).toBe(false);
				expect(await fs.readdir(path.join(fixture.root, ".journal"))).toEqual([]);
				expect(await pathExists(path.join(fixture.root, ".locks", "apply.lock"))).toBe(false);
			} finally {
				if (execution !== null) await cleanupLiveApplyChild(execution, fixture.releasePath);
			}
		}, 30_000);

		it("forward-rolls or fails closed on every write ingress", async () => {
			await expectSessionWriteUnaffected(environmentValue =>
				checkpoint(environmentValue, {
					goal: "goal",
					task: "task",
					nextSteps: ["next"],
				}),
			);
			await expectWriteAdmitted(environmentValue =>
				propose(environmentValue, {
					type: "decision",
					content: "Next-touch recovery write.",
					targetUri: "global://next-touch-proposal.md",
				}),
			);
			await expectWriteAdmitted(environmentValue => apply(environmentValue, { proposalId: "missing" }));
			await expectWriteAdmitted(environmentValue => forget(environmentValue, { uri: "global://missing.md" }));
		});

		it("keeps doctor read-only while reporting the journal finding", async () => {
			const fixture = await seedPending();
			const before = await snapshot(fixture.root, fixture.snapshotPaths);
			const result = await doctor(environment(fixture.root));
			expect(result.ok).toBe(true);
			if (!result.ok) return;
			expect(result.value.findings.map(finding => finding.code)).toEqual(
				expect.arrayContaining(["journal.recoverable"]),
			);
			await expectSnapshot(fixture.root, before);
		});

		it("leaves a clean store unaffected at every ingress", async () => {
			const ingresses: readonly ((environmentValue: MemoryEnvironment) => Promise<MemoryResult<unknown>>)[] = [
				environmentValue => search(environmentValue, { query: "clean" }),
				environmentValue => recall(environmentValue, { query: "clean" }),
				environmentValue => resolveReadableResource(environmentValue, "global://missing.md"),
				environmentValue => resume(environmentValue, { sessionId: "demo" }),
				environmentValue => Promise.resolve(resolveReadableResourceSync(environmentValue, "global://missing.md")),
				environmentValue =>
					checkpoint(environmentValue, {
						goal: "goal",
						task: "task",
						nextSteps: ["next"],
					}),
				environmentValue =>
					propose(environmentValue, {
						type: "decision",
						content: "Clean-store proposal.",
						targetUri: "global://clean-proposal.md",
					}),
				environmentValue => apply(environmentValue, { proposalId: "missing" }),
				environmentValue => forget(environmentValue, { uri: "global://missing.md" }),
				environmentValue => doctor(environmentValue),
			];
			for (const invoke of ingresses) {
				const root = await makeRoot();
				const result = await invoke(environment(root));
				if (!result.ok) expect(result.error.code).not.toBe("lock-conflict");
			}
		});
	});
}
