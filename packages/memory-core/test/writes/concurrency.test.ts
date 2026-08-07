import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { parseMemoryDocument } from "../../src/documents/document-parser";
import type { MemoryEnvironment } from "../../src/env";
import {
	type ApplyReceipt,
	apply,
	type CheckpointInput,
	type CheckpointResult,
	checkpoint,
	type MemoryResult,
} from "../../src/index";
import {
	appendRetrievalLedger,
	type RetrievalLedgerInput,
	type RetrievalLedgerResult,
} from "../../src/ledger/retrieval-ledger";
import { parseMemoryMap } from "../../src/maps/map-parser";
import { createMemoryRootScaffold } from "../../src/storage/bootstrap-init";
import { getJournalPath, getJournalProgressPath } from "../../src/storage/journal";
import { proposeMemory, readStagedProposal, type StagedProposalRecord } from "../../src/writes/proposal";

const AS_OF = "2026-07-29T00:00:00.000Z";
const APPLY_COUNT = 8;
const CHECKPOINT_COUNT = 4;
const LEDGER_COUNT = 200;
const temporaryParents: string[] = [];

type ChildKind = "apply" | "checkpoint" | "ledger";

type ApplyChildOutcome = {
	readonly kind: "apply";
	readonly index: number;
	readonly result: MemoryResult<ApplyReceipt>;
};

type CheckpointChildOutcome = {
	readonly kind: "checkpoint";
	readonly index: number;
	readonly result: MemoryResult<CheckpointResult>;
};

type LedgerChildOutcome = {
	readonly kind: "ledger";
	readonly index: number;
	readonly result: MemoryResult<RetrievalLedgerResult>;
};

type ChildOutcome = ApplyChildOutcome | CheckpointChildOutcome | LedgerChildOutcome;

interface ChildConfiguration {
	readonly kind: ChildKind;
	readonly index: number;
	readonly proposalId?: string;
}

interface ChildExecution extends ChildConfiguration {
	readonly exitCode: number;
	readonly stdout: string;
	readonly stderr: string;
}

interface StagedApplyProposal {
	readonly index: number;
	readonly proposalId: string;
	readonly staged: StagedProposalRecord;
}

interface ConcurrencyFixture {
	readonly root: string;
	readonly gatePath: string;
	readonly proposals: readonly StagedApplyProposal[];
}

function environment(memoryRoot: string, sessionId: string | null = null): MemoryEnvironment {
	return {
		memoryRoot,
		repository: null,
		sessionId,
		now: new Date(AS_OF),
		deterministic: true,
		asOf: AS_OF,
	};
}

function checkpointInput(index: number): CheckpointInput {
	return {
		goal: `Concurrent checkpoint ${index}`,
		task: "Exercise a session write while apply holds the root lock.",
		nextSteps: ["Verify the final tree"],
	};
}

function ledgerInput(index: number): RetrievalLedgerInput {
	return {
		query: `Concurrent retrieval ledger entry ${index}`,
		intent: "generic-recall",
	};
}

function checkpointSession(index: number): string {
	return `concurrency-checkpoint-${index}`;
}

function ledgerSession(): string {
	return "concurrency-ledger";
}

function childConfiguration(kind: ChildKind, index: number, proposalId?: string): ChildConfiguration {
	return { kind, index, proposalId };
}

function parseChildOutcome(execution: ChildExecution): ChildOutcome {
	expect(execution.exitCode, `${execution.kind}/${execution.index}: ${execution.stderr}`).toBe(0);
	const parsed: unknown = JSON.parse(execution.stdout.trim());
	const outcome = parsed as ChildOutcome;
	expect(outcome.kind).toBe(execution.kind);
	expect(outcome.index).toBe(execution.index);
	return outcome;
}

async function waitForGate(gatePath: string): Promise<void> {
	for (;;) {
		try {
			await fs.access(gatePath);
			return;
		} catch {
			await Bun.sleep(1);
		}
	}
}

async function runConcurrencyChild(): Promise<void> {
	const kindValue = process.env.MEMORY_CONCURRENCY_KIND;
	const kind: ChildKind | undefined =
		kindValue === "apply" || kindValue === "checkpoint" || kindValue === "ledger" ? kindValue : undefined;
	const root = process.env.MEMORY_CONCURRENCY_ROOT;
	const gatePath = process.env.MEMORY_CONCURRENCY_GATE;
	const proposalId = process.env.MEMORY_CONCURRENCY_PROPOSAL;
	const indexText = process.env.MEMORY_CONCURRENCY_INDEX;
	if (kind === undefined || root === undefined || gatePath === undefined || indexText === undefined) {
		throw new Error("concurrency child configuration is incomplete");
	}
	const index = Number(indexText);
	if (!Number.isSafeInteger(index) || index < 0) throw new Error("concurrency child index is invalid");
	await waitForGate(gatePath);

	let outcome: ChildOutcome;
	if (kind === "apply") {
		if (proposalId === undefined || proposalId.length === 0) throw new Error("concurrency apply proposal is missing");
		outcome = { kind, index, result: await apply(environment(root), { proposalId }) };
	} else if (kind === "checkpoint") {
		const sessionId = checkpointSession(index);
		outcome = {
			kind,
			index,
			result: await checkpoint(environment(root, sessionId), checkpointInput(index)),
		};
	} else {
		outcome = {
			kind,
			index,
			result: await appendRetrievalLedger(environment(root, ledgerSession()), ledgerInput(index)),
		};
	}
	process.stdout.write(JSON.stringify(outcome));
}

function spawnConcurrencyChild(root: string, gatePath: string, config: ChildConfiguration): Promise<ChildExecution> {
	const child = Bun.spawn([process.execPath, path.join(import.meta.dir, "concurrency.test.ts")], {
		env: {
			...process.env,
			MEMORY_CONCURRENCY_CHILD: "1",
			MEMORY_CONCURRENCY_KIND: config.kind,
			MEMORY_CONCURRENCY_ROOT: root,
			MEMORY_CONCURRENCY_GATE: gatePath,
			MEMORY_CONCURRENCY_PROPOSAL: config.proposalId ?? "",
			MEMORY_CONCURRENCY_INDEX: String(config.index),
		},
		stdout: "pipe",
		stderr: "pipe",
	});
	return Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]).then(
		([stdout, stderr, exitCode]) => ({ ...config, exitCode, stdout, stderr }),
	);
}

async function makeFixture(): Promise<ConcurrencyFixture> {
	const parent = await fs.mkdtemp(path.join(os.tmpdir(), "memory-core-concurrency-"));
	temporaryParents.push(parent);
	const root = path.join(parent, "memory");
	await createMemoryRootScaffold(root);
	const proposals: StagedApplyProposal[] = [];
	for (let index = 0; index < APPLY_COUNT; index += 1) {
		const proposed = await proposeMemory(environment(root), {
			type: "decision",
			content: `Concurrent apply proposal ${index} has a unique postimage.`,
			targetUri: `global://constraints/concurrent-apply.md#proposal-${index}`,
		});
		if (!proposed.ok) throw new Error(proposed.error.code);
		const staged = readStagedProposal(environment(root), proposed.value.proposalId);
		if (!staged.ok) throw new Error(staged.error.code);
		proposals.push(
			Object.freeze({
				index,
				proposalId: proposed.value.proposalId,
				staged: staged.value,
			}),
		);
	}
	return {
		root,
		gatePath: path.join(parent, "start-race"),
		proposals: Object.freeze(proposals),
	};
}

async function runRace(fixture: ConcurrencyFixture): Promise<readonly ChildOutcome[]> {
	const configurations: ChildConfiguration[] = [];
	for (let index = 0; index < APPLY_COUNT; index += 1) {
		const proposal = fixture.proposals[index];
		if (proposal === undefined) throw new Error(`missing apply proposal ${index}`);
		configurations.push(childConfiguration("apply", index, proposal.proposalId));
	}
	for (let index = 0; index < CHECKPOINT_COUNT; index += 1) {
		configurations.push(childConfiguration("checkpoint", index));
	}
	for (let index = 0; index < LEDGER_COUNT; index += 1) {
		configurations.push(childConfiguration("ledger", index));
	}
	const executions = configurations.map(config => spawnConcurrencyChild(fixture.root, fixture.gatePath, config));
	await fs.writeFile(fixture.gatePath, "start\n", { mode: 0o600 });
	const completed = await Promise.all(executions);
	return Object.freeze(completed.map(parseChildOutcome));
}

async function fileExists(filePath: string): Promise<boolean> {
	return fs.lstat(filePath).then(
		() => true,
		() => false,
	);
}

async function listFiles(root: string, relative = ""): Promise<readonly string[]> {
	const directory = relative.length === 0 ? root : path.join(root, ...relative.split("/"));
	const entries = await fs.readdir(directory, { withFileTypes: true });
	const files: string[] = [];
	for (const entry of entries) {
		const child = relative.length === 0 ? entry.name : `${relative}/${entry.name}`;
		if (entry.isDirectory()) {
			files.push(...(await listFiles(root, child)));
		} else {
			files.push(child);
		}
	}
	return Object.freeze(files.sort());
}

async function expectFinalTree(
	fixture: ConcurrencyFixture,
	winner: ApplyReceipt,
	winningProposal: StagedApplyProposal,
): Promise<void> {
	expect(fixture.proposals).toHaveLength(APPLY_COUNT);
	expect(new Set(fixture.proposals.map(proposal => proposal.proposalId)).size).toBe(APPLY_COUNT);
	expect(new Set(fixture.proposals.map(proposal => `global/proposals-${proposal.proposalId}.receipt.json`)).size).toBe(
		APPLY_COUNT,
	);
	const mapRouteUris = fixture.proposals.flatMap(proposal => proposal.staged.mapRoutes.map(route => route.uri));
	expect(mapRouteUris).toHaveLength(APPLY_COUNT);
	expect(new Set(mapRouteUris).size).toBe(APPLY_COUNT);
	expect(new Set(fixture.proposals.map(proposal => proposal.staged.documentRelPath)).size).toBe(1);
	expect(new Set(fixture.proposals.map(proposal => proposal.staged.proposal.expectedDigest)).size).toBe(1);
	expect(new Set(fixture.proposals.map(proposal => proposal.staged.mapExpectedDigest)).size).toBe(1);
	expect(new Set(fixture.proposals.map(proposal => proposal.staged.documentContent)).size).toBe(APPLY_COUNT);
	expect(new Set(fixture.proposals.map(proposal => proposal.staged.mapContent)).size).toBe(APPLY_COUNT);

	const canonicalPath = path.join(fixture.root, winningProposal.staged.documentRelPath);
	const canonical = await fs.readFile(canonicalPath, "utf8");
	expect(canonical).toBe(winningProposal.staged.documentContent);
	for (const proposal of fixture.proposals) {
		if (proposal.index === winningProposal.index) continue;
		expect(canonical).not.toBe(proposal.staged.documentContent);
	}
	const parsedDocument = parseMemoryDocument({
		content: canonical,
		relPath: winningProposal.staged.documentRelPath,
		uri: winningProposal.staged.proposal.recommendedUri,
	});
	expect(parsedDocument.ok).toBe(true);

	const mapContent = await fs.readFile(path.join(fixture.root, "MEMORY.md"), "utf8");
	expect(mapContent).toBe(winningProposal.staged.mapContent);
	const parsedMap = parseMemoryMap(mapContent, "MEMORY.md");
	expect(parsedMap.ok).toBe(true);
	if (!parsedMap.ok) return;
	const winningRoutes = winningProposal.staged.mapRoutes.map(route => route.uri);
	expect(winningRoutes).toHaveLength(1);
	expect(parsedMap.value.routes.map(route => route.uri)).toEqual(winningRoutes);
	for (const proposal of fixture.proposals) {
		if (proposal.index === winningProposal.index) continue;
		for (const route of proposal.staged.mapRoutes) {
			expect(parsedMap.value.routes.map(candidate => candidate.uri)).not.toContain(route.uri);
		}
	}

	const receiptRelPath = `global/proposals-${winningProposal.proposalId}.receipt.json`;
	const receiptPath = path.join(fixture.root, receiptRelPath);
	const receipt = JSON.parse(await fs.readFile(receiptPath, "utf8")) as ApplyReceipt;
	expect(receipt).toEqual(winner);
	expect(receipt).toMatchObject({
		schemaVersion: "gajae.memory.apply-receipt.v1",
		proposalId: winningProposal.proposalId,
		mutationId: `apply-${winningProposal.proposalId}`,
		applied: true,
	});
	expect(receipt.changed).toContain(winningProposal.staged.documentRelPath);
	expect(receipt.changed).toContain("MEMORY.md");
	expect(receipt.superseded).toEqual([]);
	for (const proposal of fixture.proposals) {
		if (proposal.index === winningProposal.index) continue;
		expect(await fileExists(path.join(fixture.root, `global/proposals-${proposal.proposalId}.receipt.json`))).toBe(
			false,
		);
	}

	const files = await listFiles(fixture.root);
	expect(
		files.filter(
			relPath => (relPath.startsWith("global/") || relPath.startsWith("projects/")) && relPath.endsWith(".md"),
		),
	).toEqual([winningProposal.staged.documentRelPath]);
	expect(files.filter(relPath => /^global\/proposals-[^/]+\.receipt\.json$/u.test(relPath))).toEqual([receiptRelPath]);
	expect(files.filter(relPath => relPath.startsWith(".journal/") || relPath.endsWith(".tmp"))).toEqual([]);
	expect(await fileExists(getJournalPath(fixture.root, winner.mutationId))).toBe(false);
	expect(await fileExists(getJournalProgressPath(fixture.root, winner.mutationId))).toBe(false);
	expect(await fs.readdir(path.join(fixture.root, ".journal"))).toEqual([]);
}

if (process.env.MEMORY_CONCURRENCY_CHILD !== undefined) {
	await runConcurrencyChild();
} else {
	afterEach(async () => {
		await Promise.all(temporaryParents.splice(0).map(parent => fs.rm(parent, { recursive: true, force: true })));
	});
	describe("memory multi-process write concurrency", () => {
		it("commits one distinct apply while checkpoints and retrieval appends proceed on one root", async () => {
			const fixture = await makeFixture();
			const outcomes = await runRace(fixture);
			const applies = outcomes.filter((outcome): outcome is ApplyChildOutcome => outcome.kind === "apply");
			const checkpoints = outcomes.filter(
				(outcome): outcome is CheckpointChildOutcome => outcome.kind === "checkpoint",
			);
			const ledgers = outcomes.filter((outcome): outcome is LedgerChildOutcome => outcome.kind === "ledger");

			expect(applies).toHaveLength(APPLY_COUNT);
			expect(checkpoints).toHaveLength(CHECKPOINT_COUNT);
			expect(ledgers).toHaveLength(LEDGER_COUNT);

			const winners = applies.filter(outcome => outcome.result.ok);
			const conflicts = applies.filter(outcome => !outcome.result.ok);
			expect(winners).toHaveLength(1);
			expect(conflicts).toHaveLength(APPLY_COUNT - 1);
			for (const conflict of conflicts) {
				if (conflict.result.ok) continue;
				expect(conflict.result.error).toMatchObject({ code: "lock-conflict", exitCode: 12 });
			}
			const winner = winners[0];
			if (winner === undefined || !winner.result.ok) return;
			const winningProposal = fixture.proposals[winner.index];
			expect(winningProposal).toBeDefined();
			if (winningProposal === undefined) return;
			expect(winner.result.value.proposalId).toBe(winningProposal.proposalId);

			expect(checkpoints.every(outcome => outcome.result.ok)).toBe(true);
			for (const checkpoint of checkpoints) {
				if (!checkpoint.result.ok) continue;
				const session = checkpointSession(checkpoint.index);
				const checkpointPath = path.join(fixture.root, "sessions", session, "checkpoint.md");
				expect(await fileExists(checkpointPath)).toBe(true);
				const parsed = parseMemoryDocument({
					content: await fs.readFile(checkpointPath, "utf8"),
					relPath: `sessions/${session}/checkpoint.md`,
					uri: checkpoint.result.value.uri,
				});
				expect(parsed.ok).toBe(true);
			}

			expect(ledgers.every(outcome => outcome.result.ok && outcome.result.value.written)).toBe(true);
			const ledgerPath = path.join(fixture.root, "sessions", ledgerSession(), "retrieval-ledger.jsonl");
			const ledgerBytes = await fs.readFile(ledgerPath);
			expect(ledgerBytes.length).toBeGreaterThan(0);
			expect(ledgerBytes[ledgerBytes.length - 1]).toBe(0x0a);
			const ledgerLines = ledgerBytes.toString("utf8").split("\n").slice(0, -1);
			expect(ledgerLines).toHaveLength(LEDGER_COUNT);
			const ledgerRecords = ledgerLines.map(line => {
				expect(line).not.toContain("\r");
				const record = JSON.parse(line) as {
					readonly schemaVersion: string;
					readonly queryId: string;
				};
				expect(record.schemaVersion).toBe("gajae.memory.retrieval-ledger-entry.v1");
				expect(record.queryId).toMatch(/^memq_[0-9a-f]{64}$/u);
				return record;
			});
			expect(new Set(ledgerRecords.map(record => record.queryId)).size).toBe(LEDGER_COUNT);

			await expectFinalTree(fixture, winner.result.value, winningProposal);
		}, 30_000);
	});
}
