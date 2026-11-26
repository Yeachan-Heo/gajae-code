/**
 * Runtime writer inventory for the ownership write-path detector (single-owner design §2.5).
 *
 * Every mutation-shaped SessionManager method on the live prototype is classified: a writer of the
 * current session's transcript, a writer of a successor's transcript, or not a transcript writer
 * (with the reason). Each writer then runs against a real transcript with ownership on and every
 * claim failing open (the factories' and prepares' claims time out), so no claim is held, and every
 * transcript byte it changes must have been seen by the detector first. With claims working, each
 * successor writer claims its successor before writing it (single-owner design §2.4). A method
 * added later fails the classification until it is listed here, and a writer that reaches the disk
 * around the detector fails the attribution check.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fsSync from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { RecoveryFsRoot } from "@gajae-code/natives";
import * as natives from "@gajae-code/natives";
import { logger } from "@gajae-code/utils";
import {
	ManagedSessionDescendantStore,
	managedDirectoryRoot,
} from "../../src/session/internal/managed-session-storage";
import {
	SessionClaimSet,
	SessionWriteWithoutClaimError,
	sessionClaimSetOf,
} from "../../src/session/internal/session-claim-set";
import type {
	MemoryGuardParticipantDescriptorV1,
	MemoryGuardRestoreResult,
	MemoryGuardSessionManagerCheckpointV1,
} from "../../src/session/memory-guard-checkpoint-participant";
import { type DefaultModelSelectionStage, SessionManager } from "../../src/session/session-manager";
import {
	claimSessionOwner,
	probeSessionOwner,
	resetSessionOwnershipForTests,
	SessionOwnershipTestHooks,
	sessionOwnershipCounters,
} from "../../src/session/session-ownership";
import {
	expectStrictDetections,
	outsideStrictSeam,
	undeclaredStrictDetections,
	useStrictWriteDetection,
} from "./strict-write-detection";
import { spyOnTranscriptWrites, type TranscriptWriteLedger } from "./transcript-write-ledger";

const supported = process.platform === "linux" || process.platform === "darwin";
/** Every claim times out, so managers go on without one and the detector alone guards the writes. */
const FAIL_OPEN_LOCKS = {
	tryAcquire: async () => ({ status: natives.FileLockAcquireStatus.TimedOut, code: "timed_out" }),
	probe: async () => ({ state: natives.FileLockProbeState.Free }),
};

/** A real claim of `sessionId`, taken around the fail-open backend. */
async function claimHeld(sessionId: string) {
	const backend = SessionOwnershipTestHooks.lockBackend;
	delete SessionOwnershipTestHooks.lockBackend;
	try {
		const result = await claimSessionOwner(sessionId, { surface: "terminal" });
		if (result.status !== "claimed") throw new Error("expected a claim");
		return result.claim;
	} finally {
		SessionOwnershipTestHooks.lockBackend = backend;
	}
}
const roots: string[] = [];
const managers: SessionManager[] = [];
let detectorLogs: unknown[] = [];
let writes: TranscriptWriteLedger;

beforeEach(() => {
	SessionOwnershipTestHooks.mode = "observe";
	SessionOwnershipTestHooks.lockBackend = FAIL_OPEN_LOCKS;
	writes = spyOnTranscriptWrites();
	// The detector's log line stays in memory: the logger's file sink lives under the real home.
	detectorLogs = [];
	vi.spyOn(logger, "warn").mockImplementation((message, context) => {
		if (message === "session_write_without_claim") detectorLogs.push(context);
	});
});

afterEach(async () => {
	try {
		for (const manager of managers.splice(0)) await manager.close().catch(() => undefined);
		for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
	} finally {
		delete SessionOwnershipTestHooks.mode;
		delete SessionOwnershipTestHooks.strictWriteDetection;
		delete SessionOwnershipTestHooks.lockBackend;
		vi.restoreAllMocks();
		resetSessionOwnershipForTests();
	}
});

/** Close every manager the test opened, so writes left for close are made (and counted) now. */
async function closeManagers(): Promise<void> {
	for (const manager of managers.splice(0)) await manager.close().catch(() => undefined);
}

function user(text: string) {
	return { role: "user" as const, content: text, timestamp: Date.now() };
}

type Kind = "managed" | "explicit";
interface Context {
	readonly first: string;
	readonly cwd: string;
	readonly file: string;
}
type Invoke = (manager: SessionManager, context: Context) => unknown;
/** A writer whose `setup` runs before measuring, so only `run`'s writes are attributed. */
interface Staged {
	readonly setup?: (manager: SessionManager, context: Context) => unknown;
	readonly run: (manager: SessionManager, context: Context, prepared: unknown) => unknown;
	/** Start from a manager whose transcript is not on disk yet. */
	readonly fresh?: boolean;
	/** Skip the flush after `setup`, so `run` is the first flush of its writes. */
	readonly unflushed?: boolean;
}
type Writer = Invoke | Staged;
const always = () => true;

/** Writers of the session the manager is bound to. Run unclaimed, each write must be detected. */
const CURRENT_WRITERS: Record<string, Writer> = {
	appendConfiguredModelChain: m =>
		m.appendConfiguredModelChain({
			role: "default",
			entries: ["anthropic/claude-sonnet-4-5"],
			origin: "inventory",
			explicitHead: true,
			cleared: false,
		}),
	appendMessage: m => m.appendMessage(user("legacy")),
	appendMessageDurably: m => m.appendMessageDurably(user("durable")),
	appendThinkingLevelChange: m => m.appendThinkingLevelChange("high"),
	appendServiceTierChange: m => m.appendServiceTierChange("priority"),
	appendModeChange: m => m.appendModeChange("plan"),
	appendModelChange: m => m.appendModelChange("anthropic/claude-sonnet-4-5"),
	clearModelRole: m => m.clearModelRole("default"),
	appendSessionInit: m => m.appendSessionInit({ systemPrompt: "s", task: "t", tools: [] }),
	appendCompaction: (m, { first }) => m.appendCompaction("summary", undefined, first, 1),
	appendCustomEntry: m => m.appendCustomEntry("inventory", { v: 1 }),
	appendModelProfileOwnershipMarker: m => m.appendModelProfileOwnershipMarker({ kind: "cleared" }),
	appendContextClearEntry: m => m.appendContextClearEntry({ sessionId: m.getSessionId() }),
	applyEntryMessageUpdates: (m, { first }) =>
		m.applyEntryMessageUpdates([{ ...m.getEntry(first), message: user("rewritten") } as never]),
	applyCustomMessageEntryUpdates: {
		setup: m => m.appendCustomMessageEntry("inventory", "before", true),
		run: (m, _context, id) =>
			m.applyCustomMessageEntryUpdates([{ ...m.getEntry(id as string), content: "after" } as never]),
	},
	rewriteEntries: m => m.rewriteEntries(),
	_persist: { setup: (m, { first }) => m.getEntry(first), run: (m, _context, entry) => m._persist(entry as never) },
	appendCustomMessageEntry: m => m.appendCustomMessageEntry("inventory", "content", true),
	appendMCPToolSelection: m => m.appendMCPToolSelection([]),
	appendDiscoveredBuiltinToolSelection: m => m.appendDiscoveredBuiltinToolSelection([]),
	appendTtsrInjection: m => m.appendTtsrInjection(["rule"]),
	evictCompactedContent: {
		setup: m => {
			// Only content blocks large enough to spill are evicted.
			m.appendMessage({ role: "user", content: [{ type: "text", text: "x".repeat(4096) }], timestamp: Date.now() });
			const firstKept = m.appendMessage(user("kept"));
			return { firstKept, compaction: m.appendCompaction("summary", undefined, firstKept, 1) };
		},
		run: (m, _context, prepared) => {
			const { firstKept, compaction } = prepared as { firstKept: string; compaction: string };
			return m.evictCompactedContent(firstKept, compaction);
		},
	},
	appendLabelChange: (m, { first }) => m.appendLabelChange(first, "label"),
	branchWithSummary: (m, { first }) => m.branchWithSummary(first, "summary"),
	stageDefaultModelSelection: async m =>
		m.promoteDefaultModelSelection(
			await m.stageDefaultModelSelection("anthropic/claude-sonnet-4-5", "high", { appendThinkingLevel: true }),
		),
	promoteDefaultModelSelection: {
		setup: m => m.stageDefaultModelSelection("anthropic/claude-sonnet-4-5", "high", { appendThinkingLevel: true }),
		run: (m, _context, stage) => m.promoteDefaultModelSelection(stage as DefaultModelSelectionStage),
	},
	moveTo: {
		setup: (_m, { cwd }) => fs.mkdir(path.join(cwd, "moved"), { recursive: true }),
		run: (m, { cwd }) => m.moveTo(path.join(cwd, "moved")),
	},
	setSessionStarred: m => m.setSessionStarred(true),
	setSessionName: m => m.setSessionName("inventory title", "user"),
	ensureOnDisk: { fresh: true, run: m => m.ensureOnDisk() },
	appendMessageSharingSession: m => m.appendMessageSharingSession(user("shared")),
	appendCustomEntrySharingSession: m => m.appendCustomEntrySharingSession("inventory", { v: 2 }),
	appendCustomMessageEntrySharingSession: m => m.appendCustomMessageEntrySharingSession("inventory", "c", true),
	appendTemporaryModelChangeSharingSession: m =>
		m.appendTemporaryModelChangeSharingSession("anthropic/claude-sonnet-4-5", undefined, always),
	appendModelProfileActivationSharingSession: m =>
		m.appendModelProfileActivationSharingSession(
			{
				configuredDefaultChain: {
					role: "default",
					entries: ["anthropic/claude-sonnet-4-5"],
					origin: "inventory",
					explicitHead: true,
					cleared: false,
				},
			} as never,
			always,
		),
	appendServiceTierChangeSharingSession: m => m.appendServiceTierChangeSharingSession("priority", true, always),
	appendControlEntriesSharingSession: m =>
		m.appendControlEntriesSharingSession([{ type: "service_tier_change", serviceTier: "priority" }], always),
	appendCompactionSharingSession: (m, { first }) =>
		m.appendCompactionSharingSession({ summary: "summary", firstKeptEntryId: first, tokensBefore: 1 }, always),
	appendModeChangeSharingSession: m => m.appendModeChangeSharingSession("plan"),
	appendToolSelectionsSharingSession: m => m.appendToolSelectionsSharingSession(["mcp_tool"], undefined, always),
	appendTtsrInjectionSharingSession: m => m.appendTtsrInjectionSharingSession(["rule"]),
	appendLabelChangeSharingSession: (m, { first }) => m.appendLabelChangeSharingSession(first, "label"),
	setSessionNameSharingSession: m => m.setSessionNameSharingSession("shared title", "user"),
};

/** Writers of a successor's transcript (a new id). Run unclaimed, each write must be detected. */
const SUCCESSOR_WRITERS: Record<string, Writer> = {
	prepareFork: m => m.prepareFork(),
	prepareBranchedSession: (m, { first }) => m.prepareBranchedSession(first),
	fork: m => m.fork(),
	createBranchedSession: (m, { first }) => m.createBranchedSession(first),
	ensurePreparedNewSessionOnDisk: async m => m.ensurePreparedNewSessionOnDisk(await m.prepareNewSession()),
	commitPreparedNewSession: async m => {
		m.commitPreparedNewSession(await m.prepareNewSession());
		m.appendMessage(user("on the successor"));
		await m.ensureOnDisk();
	},
};

/**
 * Writers that act only through the funnels above, or only in a state this scenario does not
 * reach (no queued writes, no latched failure, no completed turn). Each runs through the same
 * attribution check, without the requirement to write.
 */
interface IndirectWriter {
	/**
	 * The checked funnel its writes go through, per destination, where it writes in this scenario;
	 * such a write must be reported at that funnel. Without an entry it must write nothing. An
	 * explicit destination's lines go through the persist writer, checked when it opened.
	 */
	readonly funnel: Partial<Record<Kind, string>>;
	readonly writer: Writer;
}
/** A completed turn, so a recap of it is accepted. */
function completedTurn(m: SessionManager) {
	const requestEntryId = m.appendMessage(user("request"));
	const sourceEntryId = m.appendMessage({
		role: "assistant",
		content: [{ type: "text", text: "answer" }],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-sonnet-4-5",
		usage: {
			input: 1,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 2,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	} as never);
	return {
		text: "recap",
		sourceEntryId,
		requestEntryId,
		model: { provider: "anthropic", id: "claude-sonnet-4-5" },
		generatedAt: "2026-11-02T07:12:00.000Z",
	};
}
const APPEND_FUNNELS = { managed: "managed append", explicit: "persist writer open" } as const;
const INDIRECT_WRITERS: Record<string, IndirectWriter> = {
	appendSessionRecap: {
		funnel: APPEND_FUNNELS,
		writer: { setup: completedTurn, run: (m, _context, recap) => m.appendSessionRecap(recap as never) },
	},
	// Shared publications are managed-only; an explicit destination rejects them unwritten.
	appendSessionRecapSharingSession: {
		funnel: { managed: "managed append" },
		writer: { setup: completedTurn, run: (m, _context, recap) => m.appendSessionRecapSharingSession(recap as never) },
	},
	appendThinkingLevelChangeSharingSession: {
		funnel: {},
		writer: m => m.appendThinkingLevelChangeSharingSession("high", true, always),
	},
	newSession: { funnel: {}, writer: m => m.newSession() },
	// Managed appends and persist-writer lines land synchronously, so a flush only drains queued
	// rewrites and patch publications, each checked at its own funnel when it runs.
	flush: { funnel: {}, writer: { unflushed: true, setup: m => m.appendMessage(user("queued")), run: m => m.flush() } },
	flushBeforeLeaving: {
		funnel: {},
		writer: { unflushed: true, setup: m => m.appendMessage(user("queued")), run: m => m.flushBeforeLeaving() },
	},
	close: { funnel: {}, writer: m => m.close() },
	closeStrict: { funnel: {}, writer: m => m.closeStrict() },
	flushAndCloseStrict: { funnel: {}, writer: m => m.flushAndCloseStrict() },
	recoverPersistenceFailure: { funnel: {}, writer: m => m.recoverPersistenceFailure() },
	// A missing or empty target file is created through the rewrite funnel.
	setSessionFile: {
		funnel: { managed: "rewrite", explicit: "rewrite" },
		writer: (m, { file }) => m.setSessionFile(path.join(path.dirname(file), "missing-target.jsonl")),
	},
};

/** Methods that write no transcript bytes. Each runs, and must leave every transcript unchanged. */
const NOT_TRANSCRIPT_WRITERS: Record<string, Writer> = {
	restoreRollbackState: m => m.restoreRollbackState(m.captureState()),
	restoreState: m => m.restoreState(m.captureState()),
	prepareNewSession: m => m.prepareNewSession(),
	appendPreparedModelChange: async m => m.appendPreparedModelChange(await m.prepareNewSession(), "fixture/model"),
	appendPreparedThinkingLevelChange: async m =>
		m.appendPreparedThinkingLevelChange(await m.prepareNewSession(), "high"),
	appendPreparedServiceTierChange: async m =>
		m.appendPreparedServiceTierChange(await m.prepareNewSession(), "priority"),
	appendPreparedCustomMessageEntry: async m =>
		m.appendPreparedCustomMessageEntry(await m.prepareNewSession(), "inventory", "staged", true),
	appendPreparedModelProfileOwnershipMarker: async m =>
		m.appendPreparedModelProfileOwnershipMarker(await m.prepareNewSession(), { kind: "cleared" }),
	discardPreparedNewSession: async m => m.discardPreparedNewSession(await m.prepareNewSession()),
	discardDefaultModelSelectionStage: async m =>
		m.discardDefaultModelSelectionStage(
			await m.stageDefaultModelSelection("anthropic/claude-sonnet-4-5", "high", { appendThinkingLevel: true }),
		),
	setSessionMemoryMode: m => m.setSessionMemoryMode("shadow"),
	stageAdoptedArtifactManagerForTransition: m => m.stageAdoptedArtifactManagerForTransition(),
	ensureArtifactManager: m => m.ensureArtifactManager(),
	sanitizeLoadedOpenAIResponsesReplayMetadata: m => m.sanitizeLoadedOpenAIResponsesReplayMetadata(),
	branch: (m, { first }) => m.branch(first),
	resetLeaf: m => m.resetLeaf(),
	saveDraft: m => m.saveDraft("draft text"),
	consumeDraft: m => m.consumeDraft(),
	saveArtifact: m => m.saveArtifact("artifact text", "bash"),
	putBlob: m => m.putBlob(Buffer.from("blob")),
	setSidecarHotSuffixBudgetForTests: m => m.setSidecarHotSuffixBudgetForTests(1 << 20),
	createMemoryGuardCheckpoint: async m => {
		// The checkpoint copies the transcript, so its root sits outside the measured tree.
		const checkpointRoot = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "gjc-inventory-checkpoint-")));
		roots.push(checkpointRoot);
		writes.exempt.set(checkpointRoot, "a memory-guard checkpoint copy, not a session transcript");
		const ingressLease = m.acquireMemoryGuardParticipantIngressLease();
		try {
			return await m.createMemoryGuardCheckpoint({ ingressLease, checkpointRoot });
		} finally {
			ingressLease.release();
		}
	},
	setParentArtifactBudgetForTests: m => m.setParentArtifactBudgetForTests(1 << 20),
};

/** Writers this step does not cover; the step named in each reason does. Not run here. */
const DEFERRED_WRITERS: Record<string, string> = {
	discardUncommittedSession: "deletes a never-committed session; delete ownership is the scoped-claim step",
	dropSession: "deletes a session; delete ownership is the scoped-claim step",
	deleteSessionVerified: "verified delete; delete ownership is the scoped-claim step",
	setSessionStarredForPicker: "picker write of any session; scoped claims cover picker writes",
	remapStagedArtifactReferences: "staged child artifact references; staged sessions claim at commit",
	prepareManagedCandidateForWrite:
		"4b (H1): the TUI picker calls it on the live manager before any factory, so no claim precedes it yet",
	prepareManagedCandidateForStrictAdoption: "open-time candidate preparation; factories claim before it",
	finalizeWritableOpen: "open-time finalization; factories claim before it",
	finalizePendingWritableOpen: "open-time finalization; factories claim before it",
	commitStaged: "staged child publication; staged sessions claim at commit",
	rollbackCommittedStaged: "staged child rollback; staged sessions claim at commit (4b)",
	discardStaged: "unpublished staged child cleanup; staged sessions claim at commit (4b)",
	commitStagedNestedManaged: "staged child publication; staged sessions claim at commit",
	discardStagedNestedManaged: "unpublished staged child cleanup; staged sessions claim at commit (4b)",
	finalizeStagedCommit: "staged child publication; staged sessions claim at commit",
};

/** Writers checked by their own case below, because they need more setup than a bound manager. */
const SEPARATELY_CHECKED_WRITERS: Record<string, string> = {
	promoteRecoveryHydrationAfterOwnershipReadyFence: "the recovery promotion case",
};

/**
 * Names outside the mutation-shaped prefixes that are classified too. The remaining prototype
 * methods are getters and queries; classifying all of them (and the static methods) is left to the
 * factory-claims step.
 */
const ALSO_CLASSIFIED = [
	"_persist",
	"newSession",
	"flush",
	"flushBeforeLeaving",
	"close",
	"closeStrict",
	"flushAndCloseStrict",
	"recoverPersistenceFailure",
	"saveDraft",
	"consumeDraft",
	"saveArtifact",
	"putBlob",
	"finalizeWritableOpen",
	"finalizePendingWritableOpen",
	"finalizeStagedCommit",
] as const;

const MUTATION_SHAPED =
	/^(append|set|clear|branch|rewrite|apply|stage|promote|discard|drop|move|fork|prepare|commit|evict|remap|rollback|reset|delete|sanitize|create|ensure|restore)/;

const CLASSIFICATIONS = [
	CURRENT_WRITERS,
	SUCCESSOR_WRITERS,
	INDIRECT_WRITERS,
	NOT_TRANSCRIPT_WRITERS,
	DEFERRED_WRITERS,
	SEPARATELY_CHECKED_WRITERS,
];

function unclassified(methods: readonly string[]): string[] {
	return methods.filter(name => !CLASSIFICATIONS.some(classification => name in classification));
}

function classifiedMethods(): string[] {
	return Object.getOwnPropertyNames(SessionManager.prototype).filter(
		name => MUTATION_SHAPED.test(name) || (ALSO_CLASSIFIED as readonly string[]).includes(name),
	);
}

async function transcripts(directory: string): Promise<Map<string, string>> {
	const found = new Map<string, string>();
	for (const name of await fs.readdir(directory, { recursive: true }).catch(() => [] as string[])) {
		if (!name.endsWith(".jsonl")) continue;
		found.set(name, await fs.readFile(path.join(directory, name), "utf8"));
	}
	return found;
}

/** Full paths, under `root`, of the transcripts whose bytes differ (a removed one included). */
function changedPaths(root: string, before: Map<string, string>, after: Map<string, string>): Set<string> {
	const paths = new Set<string>();
	for (const name of new Set([...before.keys(), ...after.keys()]))
		if (before.get(name) !== after.get(name)) paths.add(path.join(root, name));
	return paths;
}

function changed(before: Map<string, string>, after: Map<string, string>): boolean {
	return changedPaths("", before, after).size > 0;
}

async function bound(kind: Kind, fresh = false) {
	const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "gjc-writer-inventory-")));
	roots.push(root);
	const cwd = path.join(root, "workspace");
	const agentDir = path.join(root, "agent");
	await fs.mkdir(cwd, { recursive: true });
	await fs.mkdir(agentDir, { recursive: true, mode: 0o700 });
	const destination =
		kind === "managed"
			? SessionManager.managedDestination(cwd, agentDir)
			: SessionManager.explicitDestination(path.join(root, "sessions"));
	const manager = SessionManager.create(cwd, destination);
	managers.push(manager);
	const first = manager.appendMessage(user("first"));
	manager.appendMessage(user("second"));
	if (!fresh) {
		await manager.ensureOnDisk();
		await manager.flush();
	}
	return { manager, root, context: { first, cwd, file: manager.getSessionFile()! } };
}

/** Run `invoke` and report whether it changed transcript bytes and how many writes the detector saw. */
async function attribute(kind: Kind, writer: Writer, claimed = false) {
	const staged: Staged = typeof writer === "function" ? { run: writer } : writer;
	const { manager, root, context } = await bound(kind, staged.fresh);
	if (claimed) {
		sessionClaimSetOf(manager).add(await claimHeld(manager.getSessionId()));
	}
	let prepared: unknown;
	try {
		prepared = await staged.setup?.(manager, context);
		if (!staged.unflushed) await manager.flush();
	} catch (error) {
		throw new Error(`setup failed: ${String(error)}`);
	}
	const before = await transcripts(root);
	const detectedBefore = sessionOwnershipCounters().session_write_without_claim;
	writes.reset();
	try {
		await staged.run(manager, context, prepared);
		await manager.flush();
	} catch {
		// A refusal is fine; only bytes that reached the disk need attribution.
	}
	// Close discards unpublished successors, so look before it too.
	const touched = changedPaths(root, before, await transcripts(root));
	// In-memory rewrites (message updates, eviction) reach the disk as rewrite debt at close.
	await manager.close().catch(() => undefined);
	for (const file of changedPaths(root, before, await transcripts(root))) touched.add(file);
	return {
		wrote: touched.size > 0,
		detected: sessionOwnershipCounters().session_write_without_claim - detectedBefore,
		/** Commits no detector call covered, and changed transcripts no spied primitive wrote. */
		unattributed: [
			...writes.uncovered,
			...[...touched].filter(file => !writes.written.has(file)).map(file => `unspied ${path.basename(file)}`),
		],
		/** Detector calls that went silent for want of a bound id. */
		unbound: [...writes.unbound],
		events: [...writes.events],
		file: context.file,
	};
}

describe("session ownership writer inventory", () => {
	it("classifies every mutation-shaped SessionManager method", () => {
		const methods = classifiedMethods();
		for (const name of ALSO_CLASSIFIED) expect(methods).toContain(name);
		expect(unclassified(methods)).toEqual([]);
		const listed = CLASSIFICATIONS.flatMap(classification => Object.keys(classification));
		expect(listed.filter(name => !methods.includes(name))).toEqual([]);
		// Each method is in exactly one classification.
		expect(listed.length).toBe(new Set(listed).size);
		// A writer added later is caught until it is listed.
		expect(unclassified([...methods, "appendBypassingWriter"])).toEqual(["appendBypassingWriter"]);
	});

	it("the attribution check rejects a writer that reaches the disk around the detector", async () => {
		const bypass: Invoke = (_m, { file }) => fs.appendFile(file, `${JSON.stringify({ type: "custom" })}\n`);
		const result = await attribute("explicit", bypass);
		expect(result).toMatchObject({ wrote: true, detected: 0 });
		expect(result.unattributed).toEqual([`fs.promises.appendFile ${path.basename(result.file)}`]);
	});

	/** A transcript's first line, its session header. */
	const headerLine = (file: string) => fsSync.readFileSync(file, "utf8").split("\n")[0]!;
	/** Write primitives a writer could reach the disk with after a checked write. */
	const BYPASSES: Record<string, (file: string) => Promise<unknown>> = {
		"fs.promises.appendFile": file => fs.appendFile(file, `${JSON.stringify({ type: "custom" })}\n`),
		"fs.appendFile": file => {
			const { promise, resolve, reject } = Promise.withResolvers<void>();
			fsSync.appendFile(file, `${JSON.stringify({ type: "custom" })}\n`, error =>
				error ? reject(error) : resolve(),
			);
			return promise;
		},
		// The overwriting bypasses keep the session header, so the write is still the session's.
		"fs.truncateSync": async file => fsSync.truncateSync(file, headerLine(file).length + 1),
		"fs.createWriteStream": file => {
			const { promise, resolve } = Promise.withResolvers<void>();
			fsSync.createWriteStream(file, { flags: "a" }).end(`${JSON.stringify({ type: "custom" })}\n`, resolve);
			return promise;
		},
		"Bun.write": file => Bun.write(file, `${headerLine(file)}\n${JSON.stringify({ type: "custom" })}\n`),
		"Bun.file().write": file => Bun.file(file).write(`${headerLine(file)}\n${JSON.stringify({ type: "custom" })}\n`),
		"Bun.file().writer": async file => {
			const sink = Bun.file(file).writer();
			sink.write(`${JSON.stringify({ type: "custom" })}\n`);
			await sink.end();
		},
	};
	describe("the write ledger's restores", () => {
		/** A detector call for `id`, so the next commit to that session's transcript is covered. */
		const check = (id = "self-test-session") => new SessionClaimSet().checkWrite("ledger self-test", id);
		/** A transcript of session `id`: its header, then one entry. */
		const bytes = (text: string, id = "self-test-session") =>
			Buffer.from(`${JSON.stringify({ type: "session", id })}\n${JSON.stringify({ type: "custom", text })}\n`);
		async function stores() {
			const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "gjc-ledger-store-")));
			roots.push(root);
			const authority = managedDirectoryRoot(root);
			const open = async (name: string) => {
				await fs.mkdir(path.join(root, name), { mode: 0o700 });
				return new ManagedSessionDescendantStore(authority, path.join(root, name));
			};
			return { root, a: await open("a"), b: await open("b") };
		}
		/** Publish `s.jsonl` (checked), then remove it as a managed removal does. */
		function publishThenRemove(store: ManagedSessionDescendantStore) {
			check();
			store.publishNoReplaceSync("s.jsonl", bytes("original"));
			store.removeExpected("s.jsonl", store.readExpected("s.jsonl")!);
		}

		it("republishing the exact bytes a removal took is a restore", async () => {
			const { a, b } = await stores();
			writes.reset();
			publishThenRemove(a);
			a.publishNoReplaceSync("s.jsonl", bytes("original"));
			expect(writes.uncovered).toEqual([]);
			a.close();
			b.close();
		});

		it("different bytes at the vacated path are a new write", async () => {
			const { a, b } = await stores();
			writes.reset();
			publishThenRemove(a);
			a.publishNoReplaceSync("s.jsonl", bytes("different"));
			expect(writes.uncovered).toEqual(["store.publishNoReplaceSync s.jsonl"]);
			a.close();
			b.close();
		});

		it("the same bytes published into another store are a new write", async () => {
			const { a, b } = await stores();
			writes.reset();
			publishThenRemove(a);
			b.publishNoReplaceSync("s.jsonl", bytes("original"));
			expect(writes.uncovered).toEqual(["store.publishNoReplaceSync s.jsonl"]);
			a.close();
			b.close();
		});

		async function files(...names: string[]) {
			const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "gjc-ledger-files-")));
			roots.push(root);
			for (const name of names) await fs.writeFile(path.join(root, name), bytes(name));
			writes.reset();
			return (name: string) => path.join(root, name);
		}

		it("renaming the moved file back is a restore; renaming a different file into its place is not", async () => {
			const at = await files("a.jsonl", "c.jsonl");
			check();
			await fs.rename(at("a.jsonl"), at("b.jsonl"));
			await fs.rename(at("c.jsonl"), at("a.jsonl"));
			expect(writes.uncovered).toEqual(["fs.promises.rename a.jsonl"]);

			const back = await files("a.jsonl");
			check();
			await fs.rename(back("a.jsonl"), back("b.jsonl"));
			await fs.rename(back("b.jsonl"), back("a.jsonl"));
			expect(writes.uncovered).toEqual([]);
		});

		it("renaming the moved file back after it became another session's transcript is a new write", async () => {
			const at = await files("a.jsonl");
			check();
			await fs.rename(at("a.jsonl"), at("b.jsonl"));
			// b.jsonl is replaced by another session's transcript, then renamed back to a.jsonl.
			await fs.rm(at("b.jsonl"));
			check("other-session");
			await fs.writeFile(at("b.jsonl"), bytes("replaced", "other-session"));
			await fs.rename(at("b.jsonl"), at("a.jsonl"));
			expect(writes.uncovered).toEqual(["fs.promises.rename a.jsonl"]);
		});

		it("a check covers only a write to its own session's transcript", async () => {
			const at = await files();
			// A check for one session, then a write to another: not covered.
			check("session-x");
			await fs.writeFile(at("y.jsonl"), bytes("y", "session-y"));
			expect(writes.uncovered).toEqual(["fs.promises.writeFile y.jsonl"]);
			// The check is still pending for its own session, and covers a write there.
			await fs.writeFile(at("x.jsonl"), bytes("x", "session-x"));
			expect(writes.uncovered).toEqual(["fs.promises.writeFile y.jsonl"]);
		});

		it("an open whose bytes follow through its handle is attributed by the header it ends with", async () => {
			const at = await files();
			check("session-x");
			for (const [name, id] of [
				["x.jsonl", "session-x"],
				["y.jsonl", "session-y"],
			] as const) {
				const handle = await fs.open(at(name), "wx");
				await handle.writeFile(bytes(name, id));
				await handle.close();
			}
			expect(writes.uncovered).toEqual(["fs.promises.open y.jsonl"]);
		});

		/** Open `file` exclusively and write a transcript of session `id` through the handle. */
		async function throughHandle(file: string, id: string) {
			const handle = await fs.open(file, "wx");
			await handle.writeFile(bytes(path.basename(file), id));
			await handle.close();
		}

		it("overwriting one session's transcript with another's is not covered by a check for the other", async () => {
			const at = await files("a.jsonl");
			check("session-b");
			await fs.writeFile(at("a.jsonl"), bytes("x", "session-b"));
			expect(writes.uncovered).toEqual(["fs.promises.writeFile a.jsonl (header changed)"]);
		});

		it("an unchecked append after a handle-written open is flagged, however often the ledger is read", async () => {
			const at = await files();
			check("session-x");
			await throughHandle(at("x.jsonl"), "session-x");
			expect(writes.uncovered).toEqual([]);
			await fs.appendFile(at("x.jsonl"), `${JSON.stringify({ type: "custom" })}\n`);
			expect(writes.uncovered).toEqual(["fs.promises.appendFile x.jsonl"]);
			expect(writes.uncovered).toEqual(["fs.promises.appendFile x.jsonl"]);
		});

		it("two opens made before either header is written share one check", async () => {
			const at = await files();
			check("session-x");
			const first = await fs.open(at("x1.jsonl"), "wx");
			const second = await fs.open(at("x2.jsonl"), "wx");
			await first.writeFile(bytes("x1", "session-x"));
			await second.writeFile(bytes("x2", "session-x"));
			await first.close();
			await second.close();
			expect(writes.uncovered).toEqual(["fs.promises.open x2.jsonl"]);
		});

		it("a header written in two appends is one session's, and the second append needs its own check", async () => {
			const at = await files();
			const header = JSON.stringify({ type: "session", id: "session-x" });
			check("session-x");
			fsSync.appendFileSync(at("x.jsonl"), header.slice(0, 10));
			fsSync.appendFileSync(at("x.jsonl"), `${header.slice(10)}\n`);
			expect(writes.uncovered).toEqual(["fs.appendFileSync x.jsonl"]);
		});

		it("an unchecked append after a new file's write stream is flagged", async () => {
			const at = await files();
			check("session-x");
			const { promise, resolve } = Promise.withResolvers<void>();
			fsSync.createWriteStream(at("x.jsonl"), { flags: "wx" }).end(bytes("x", "session-x"), resolve);
			await promise;
			await fs.appendFile(at("x.jsonl"), `${JSON.stringify({ type: "custom" })}\n`);
			expect(writes.uncovered).toEqual(["fs.promises.appendFile x.jsonl"]);
		});

		it("a write whose header never appears is not covered", async () => {
			const at = await files();
			check("session-x");
			const handle = await fs.open(at("x.jsonl"), "wx");
			await handle.writeFile(`${JSON.stringify({ type: "custom" })}\n`);
			await handle.close();
			expect(writes.uncovered).toEqual(["fs.promises.open x.jsonl (no session header)"]);
		});

		it("a first line that is not a session header names no session", async () => {
			const at = await files();
			check("session-x");
			await fs.writeFile(at("x.jsonl"), `${JSON.stringify({ type: "custom", id: "session-x" })}\n`);
			expect(writes.uncovered).toEqual(["fs.promises.writeFile x.jsonl (no session header)"]);
		});

		it("truncating a transcript to nothing is flagged as a header change", async () => {
			const at = await files("a.jsonl");
			check();
			fsSync.truncateSync(at("a.jsonl"), 0);
			expect(writes.uncovered).toEqual(["fs.truncateSync a.jsonl (header changed)"]);
		});

		it("a handle-written open is not covered by a reserved check for another session", async () => {
			const at = await files();
			check("session-y");
			await throughHandle(at("x.jsonl"), "session-x");
			// The reserved check for session-y goes back to pending, and still covers its own write.
			await fs.writeFile(at("y.jsonl"), bytes("y", "session-y"));
			expect(writes.uncovered).toEqual(["fs.promises.open x.jsonl"]);
		});

		it("a check made after a handle-written open does not cover that open", async () => {
			const at = await files();
			const handle = await fs.open(at("x.jsonl"), "wx");
			check("session-x");
			await handle.writeFile(bytes("x", "session-x"));
			await handle.close();
			expect(writes.uncovered).toEqual(["fs.promises.open x.jsonl"]);
		});

		it("reset drops pending checks", async () => {
			const at = await files();
			check("session-x");
			writes.reset();
			await fs.writeFile(at("x.jsonl"), bytes("x", "session-x"));
			expect(writes.uncovered).toEqual(["fs.promises.writeFile x.jsonl"]);
		});

		it("a new write at a vacated path ends what a later rename could restore there", async () => {
			const at = await files("a.jsonl");
			check();
			await fs.rename(at("a.jsonl"), at("b.jsonl"));
			check();
			await fs.writeFile(at("a.jsonl"), bytes("new"));
			// Renaming the original back over the new transcript is a write, not a restore.
			await fs.rename(at("b.jsonl"), at("a.jsonl"));
			expect(writes.uncovered).toEqual(["fs.promises.rename a.jsonl"]);
		});

		it("a callback write lands when its callback fires, and a failed one uses no check", async () => {
			const at = await files("a.jsonl");
			const viaCallback = (write: (done: (error: unknown) => void) => void) => {
				const { promise, resolve } = Promise.withResolvers<unknown>();
				write(resolve);
				return promise;
			};
			check("session-b");
			// The header is compared before and after the write itself, not when the call returns.
			await viaCallback(done => fsSync.writeFile(at("a.jsonl"), bytes("x", "session-b"), done));
			expect(writes.uncovered).toEqual(["fs.writeFile a.jsonl (header changed)"]);
			writes.reset();
			check("session-y");
			const failed = await viaCallback(done =>
				fsSync.appendFile(at("missing/y.jsonl"), bytes("y", "session-y"), done),
			);
			expect(failed).toBeInstanceOf(Error);
			await fs.writeFile(at("y.jsonl"), bytes("y", "session-y"));
			expect(writes.uncovered).toEqual([]);
		});

		it("a write made while another write to the transcript is still pending is its own commit", async () => {
			const at = await files("a.jsonl");
			const line = `${JSON.stringify({ type: "custom" })}\n`;
			check();
			const { promise, resolve } = Promise.withResolvers<unknown>();
			fsSync.appendFile(at("a.jsonl"), line, resolve);
			fsSync.appendFileSync(at("a.jsonl"), line);
			// The same while a promise form is pending.
			check();
			const pending = fs.appendFile(at("a.jsonl"), line);
			fsSync.appendFileSync(at("a.jsonl"), line);
			await Promise.all([promise, pending]);
			expect(writes.uncovered).toHaveLength(2);
		});

		it("a check with no write of its own covers no later write to another session", async () => {
			const at = await files();
			check("session-x");
			check("session-y");
			await fs.writeFile(at("y.jsonl"), bytes("y", "session-y"));
			await fs.writeFile(at("z.jsonl"), bytes("z", "session-z"));
			expect(writes.uncovered).toEqual(["fs.promises.writeFile z.jsonl"]);
		});

		it("a rename that did not happen vacates nothing", async () => {
			const at = await files("a.jsonl");
			await fs.writeFile(at("b.jsonl"), bytes("b", "other-session"));
			writes.reset();
			check();
			// The no-replace rename onto an existing file fails without moving anything, and leaves its
			// check pending; the replacing rename of another session's file into a.jsonl is not a restore.
			expect(natives.renameNoReplacePath(at("a.jsonl"), at("b.jsonl")).mutationState).toBe("not_committed");
			await fs.rename(at("b.jsonl"), at("a.jsonl"));
			expect(writes.uncovered).toEqual(["fs.promises.rename a.jsonl (header changed)"]);
		});
	});

	for (const [primitive, bypass] of Object.entries(BYPASSES)) {
		it(`per-write attribution rejects one checked write followed by one through ${primitive}`, async () => {
			// The operation as a whole is seen; only its second write is not.
			const mixed: Invoke = async (m, { file }) => {
				m.appendMessage(user("checked"));
				await bypass(file);
			};
			const result = await attribute("managed", mixed);
			expect(result).toMatchObject({ wrote: true });
			expect(result.detected).toBeGreaterThan(0);
			expect(result.unattributed).toEqual([`${primitive} ${path.basename(result.file)}`]);
		});
	}

	const writers = { ...CURRENT_WRITERS, ...SUCCESSOR_WRITERS };
	for (const [name, { funnel: funnels, writer }] of Object.entries(INDIRECT_WRITERS)) {
		for (const kind of ["managed", "explicit"] as const) {
			const funnel = funnels[kind];
			it(`${name} (${kind}): ${funnel ? `writes through ${funnel}, reported` : "writes nothing here"}`, async () => {
				detectorLogs = [];
				const result = await attribute(kind, writer);
				expect(result.wrote).toBe(funnel !== undefined);
				expect(result.unattributed).toEqual([]);
				if (funnel) expect((detectorLogs as { site: string }[]).map(log => log.site)).toContain(funnel);
			});
		}
	}
	for (const [name, writer] of Object.entries(NOT_TRANSCRIPT_WRITERS)) {
		it(`${name}: writes no transcript bytes`, async () => {
			for (const kind of ["managed", "explicit"] as const) {
				const result = await attribute(kind, writer);
				expect([kind, result.wrote, result.unattributed]).toEqual([kind, false, []]);
			}
		});
	}
	const wroteSomewhere = new Set<string>();
	for (const [name, writer] of Object.entries(writers)) {
		for (const kind of ["managed", "explicit"] as const) {
			it(`${name} (${kind}): every transcript write without a claim is detected`, async () => {
				const result = await attribute(kind, writer);
				// Each commit to a transcript follows its own detector call, and none of them went silent.
				// The ordered events are in the failure message.
				expect({ unattributed: result.unattributed, unbound: result.unbound }).toEqual({
					unattributed: [],
					unbound: [],
					...(result.unattributed.length + result.unbound.length > 0 ? { events: result.events } : {}),
				});
				if (result.wrote) {
					wroteSomewhere.add(name);
					expect(result.detected).toBeGreaterThan(0);
				}
			});
		}
	}

	for (const [name, writer] of Object.entries(CURRENT_WRITERS)) {
		// Claims need the native lock, which this platform may not have.
		it.if(supported)(`${name}: no detection while the current session is claimed`, async () => {
			for (const kind of ["managed", "explicit"] as const) {
				const result = await attribute(kind, writer, true);
				expect([kind, result.detected, result.unattributed]).toEqual([kind, 0, []]);
			}
		});
	}

	for (const kind of ["managed", "explicit"] as const) {
		it(`moveTo (${kind}): a failed move's rollback puts the transcript back, attributed as a restore`, async () => {
			const { manager, context } = await bound(kind);
			const target = path.join(context.cwd, "moved");
			await fs.mkdir(target);
			const bytes = await fs.readFile(context.file, "utf8");
			// Fail the target-directory check that follows the transcript's move, once it has moved.
			const lstat = fsSync.promises.lstat;
			let injected = false;
			vi.spyOn(fsSync.promises, "lstat").mockImplementation(((file: fsSync.PathLike, options?: never) => {
				if (!injected && file === target && !fsSync.existsSync(context.file)) {
					injected = true;
					return Promise.reject(Object.assign(new Error("injected"), { code: "EIO" }));
				}
				return lstat(file, options);
			}) as never);
			writes.reset();
			await expect(manager.moveTo(target)).rejects.toThrow();
			expect(injected).toBe(true);
			expect(await fs.readFile(context.file, "utf8")).toBe(bytes);
			expect(writes.events.filter(event => event.startsWith("restore "))).toHaveLength(1);
			expect(writes.uncovered).toEqual([]);
		});
	}

	it("a shared publication that creates the transcript is detected", async () => {
		const bootstrap: Staged = { fresh: true, run: m => m.appendMessageSharingSession(user("bootstrap")) };
		const result = await attribute("managed", bootstrap);
		expect(result.wrote).toBe(true);
		expect(result.detected).toBeGreaterThan(0);
	});

	it("each listed writer wrote in at least one destination", () => {
		// A rewrite of an unchanged transcript writes identical bytes; the strict-seam test below
		// proves the detector stops it before the write.
		expect(Object.keys(writers).filter(name => !wroteSomewhere.has(name))).toEqual(["rewriteEntries"]);
	});
});

describe.if(supported)("successor writes are checked against the successor's id", () => {
	const successors: Record<string, (m: SessionManager, first: string) => Promise<string>> = {
		fork: async m => {
			await m.fork();
			return m.getSessionId();
		},
		prepareFork: async m => (await m.prepareFork())!.sessionId,
		prepareBranchedSession: async (m, first) => (await m.prepareBranchedSession(first)).sessionId,
		createBranchedSession: async (m, first) => {
			m.createBranchedSession(first);
			return m.getSessionId();
		},
	};
	for (const [name, run] of Object.entries(successors)) {
		it(`${name}: with the current session claimed, the unclaimed successor is still reported`, async () => {
			for (const kind of ["managed", "explicit"] as const) {
				const { manager, context } = await bound(kind);
				const current = manager.getSessionId();
				sessionClaimSetOf(manager).add(await claimHeld(current));
				detectorLogs = [];
				const successor = await run(manager, context.first);
				// A sync writer's claim is in flight at its write; the write is reported when that claim fails.
				await sessionClaimSetOf(manager).settled();
				expect(successor).not.toBe(current);
				const reported = detectorLogs as { site: string; sessionId: string }[];
				expect([kind, reported.some(log => log.site.endsWith("successor") && log.sessionId === successor)]).toEqual(
					[kind, true],
				);
				expect(reported.some(log => log.sessionId === current)).toBe(false);
			}
		});
	}

	for (const [name, run] of Object.entries(successors)) {
		it(`${name}: with claims working, the successor is claimed before it is written`, async () => {
			for (const kind of ["managed", "explicit"] as const) {
				delete SessionOwnershipTestHooks.lockBackend;
				const { manager, context } = await bound(kind);
				await manager.flush();
				const claims = sessionClaimSetOf(manager);
				await claims.settled();
				expect([kind, claims.has(manager.getSessionId())]).toEqual([kind, true]);
				detectorLogs = [];
				writes.reset();
				const successor = await run(manager, context.first);
				await manager.flush();
				await claims.settled();
				expect([kind, detectorLogs, writes.uncovered]).toEqual([kind, [], []]);
				// A rotation keeps only the successor; a prepare keeps the target beside the current id.
				expect([kind, claims.has(successor)]).toEqual([kind, true]);
				expect([kind, (await probeSessionOwner(successor)).state]).toEqual([kind, "held"]);
			}
		});
	}

	it("forkFromCaptured: the fork's publish is reported", async () => {
		const { manager, root, context } = await bound("managed");
		await manager.close();
		const capture = SessionManager.captureTranscriptStrict(context.file);
		if (capture.kind !== "captured") throw new Error(`capture failed: ${capture.reason}`);
		try {
			const destination = SessionManager.managedDestination(context.cwd, path.join(root, "agent"));
			detectorLogs = [];
			const before = sessionOwnershipCounters().session_write_without_claim;
			const forked = await SessionManager.forkFromCaptured(capture.snapshot, context.cwd, destination);
			if (forked.kind !== "forked") throw new Error(`fork failed: ${forked.reason}`);
			managers.push(forked.manager);
			expect(sessionOwnershipCounters().session_write_without_claim - before).toBeGreaterThan(0);
			expect(detectorLogs).toContainEqual({
				site: "fork successor",
				sessionId: forked.manager.getSessionId(),
				mode: "observe",
			});
		} finally {
			capture.snapshot.close();
		}
	});
});

describe.if(supported)("recovery promotion", () => {
	function participant(checkpoint: MemoryGuardSessionManagerCheckpointV1): MemoryGuardParticipantDescriptorV1 {
		const { blob_authority, revisions, session_id, session_name, transcript } = checkpoint;
		return { ordinal: 0, checkpoint: blob_authority, revisions, session_id, session_name, transcript };
	}
	function authority(checkpointRoot: string): RecoveryFsRoot {
		return {
			readManaged(relativePath: string) {
				try {
					return { ok: true, data: new Uint8Array(fsSync.readFileSync(path.join(checkpointRoot, relativePath))) };
				} catch {
					return { ok: false };
				}
			},
		} as RecoveryFsRoot;
	}

	/** A staged memory-guard recovery of a session holding `messages`, restored to a `kind` destination. */
	async function stagedRecovery(
		messages: readonly Parameters<SessionManager["appendMessage"]>[0][],
		kind: Kind = "explicit",
	) {
		const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "gjc-inventory-recovery-")));
		roots.push(root);
		const source = await SessionManager.open(path.join(root, "source", "checkpoint.jsonl"));
		managers.push(source);
		for (const message of messages) source.appendMessage(message);
		await source.flush();
		const cwd = path.join(root, "workspace");
		await fs.mkdir(cwd, { recursive: true });
		await fs.mkdir(path.join(root, "agent"), { recursive: true, mode: 0o700 });
		const checkpointRoot = path.join(root, "checkpoint");
		const ingressLease = source.acquireMemoryGuardParticipantIngressLease();
		let checkpoint: MemoryGuardSessionManagerCheckpointV1;
		try {
			checkpoint = await source.createMemoryGuardCheckpoint({ ingressLease, checkpointRoot });
		} finally {
			ingressLease.release();
		}
		await source.close();
		const restored = await SessionManager.restoreMemoryGuardCheckpoint({
			incidentAuthority: authority(checkpointRoot),
			participant: participant(checkpoint),
			checkpoint,
			destination:
				kind === "managed"
					? SessionManager.managedDestination(cwd, path.join(root, "agent"))
					: path.join(root, "restore"),
		});
		if (restored.kind !== "staged") throw new Error(`expected a staged recovery, got ${restored.reason}`);
		managers.push(restored.manager);
		return restored;
	}

	it("promoteRecoveryHydrationAfterOwnershipReadyFence: the promoted transcript's publish is reported", async () => {
		const restored = await stagedRecovery([user("recovered")]);
		detectorLogs = [];
		await restored.manager.promoteRecoveryHydrationAfterOwnershipReadyFence(restored.hydrationContext, {
			ownershipReady: true,
		});
		expect(detectorLogs).toContainEqual({
			site: "recovery promotion",
			sessionId: restored.manager.getSessionId(),
			mode: "observe",
		});
	});

	// An assistant reply carrying OpenAI Responses replay state the promotion sanitizes and persists.
	const stale = {
		role: "assistant",
		content: [
			{ type: "thinking", thinking: "reasoning", thinkingSignature: "stale-signature" },
			{ type: "text", text: "answer" },
		],
		api: "openai-responses",
		provider: "openai",
		model: "gpt-fixture",
		usage: {
			input: 1,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 2,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
		providerPayload: { type: "openaiResponsesHistory", items: [] },
	} as unknown as Parameters<SessionManager["appendMessage"]>[0];

	it("the replay-metadata sanitize the promotion persists first is reported before the promotion", async () => {
		// In observe the sanitize persists its patch, through the persist writer it opens, and is reported.
		const observed = await stagedRecovery([user("question"), stale]);
		detectorLogs = [];
		await observed.manager.promoteRecoveryHydrationAfterOwnershipReadyFence(observed.hydrationContext, {
			ownershipReady: true,
		});
		expect(await fs.readFile(observed.manager.getSessionFile()!, "utf8")).toContain('"type":"entry_patch"');
		const sites = (detectorLogs as { site: string }[]).map(log => log.site);
		expect(sites.indexOf("persist writer open")).toBeGreaterThanOrEqual(0);
		expect(sites.indexOf("persist writer open")).toBeLessThan(sites.indexOf("recovery promotion"));
	});

	describe("under the strict seam", () => {
		useStrictWriteDetection(closeManagers);
		const promote = (restored: Extract<MemoryGuardRestoreResult, { kind: "staged" }>) =>
			restored.manager.promoteRecoveryHydrationAfterOwnershipReadyFence(restored.hydrationContext, {
				ownershipReady: true,
			});

		it("the replay-metadata sanitize the promotion persists first is checked before it writes", async () => {
			const restored = await outsideStrictSeam(() => stagedRecovery([user("question"), stale]));
			const staged = restored.manager.getSessionFile()!;
			const assistant = restored.manager
				.getEntries()
				.find(entry => entry.type === "message" && entry.message.role === "assistant");
			// The sanitize has something to persist at promotion time.
			expect((assistant as { message: { providerPayload?: unknown } }).message.providerPayload).toBeDefined();
			const before = await fs.readFile(staged, "utf8");
			await expect(promote(restored)).rejects.toMatchObject({
				name: "SessionWriteWithoutClaimError",
				site: "persist writer open",
			});
			expectStrictDetections(1);
			// Nothing reached the staged transcript before the detector stopped it.
			expect(await fs.readFile(staged, "utf8")).toBe(before);
		});

		for (const kind of ["managed", "explicit"] as const) {
			it(`the promotion (${kind}) is refused before it publishes anything`, async () => {
				// Nothing to sanitize, so the promotion's own check is the first one reached.
				const restored = await outsideStrictSeam(() => stagedRecovery([user("recovered")], kind));
				const directory = path.dirname(restored.manager.getSessionFile()!);
				const before = await transcripts(directory);
				await expect(promote(restored)).rejects.toMatchObject({
					name: "SessionWriteWithoutClaimError",
					site: "recovery promotion",
				});
				expectStrictDetections(1);
				// No promoted transcript appeared, and the staged one is still there, unchanged.
				expect(await transcripts(directory)).toEqual(before);
			});
		}
	});
});

describe.if(supported)("the detector", () => {
	it("in production it logs and counts, and never claims or throws", async () => {
		const { manager } = await bound("managed");
		const id = manager.getSessionId();
		const before = sessionOwnershipCounters().session_write_without_claim;
		manager.appendMessage(user("unclaimed"));
		manager.appendMessage(user("unclaimed again"));
		await manager.flush();
		expect(sessionOwnershipCounters().session_write_without_claim - before).toBeGreaterThanOrEqual(2);
		expect(await probeSessionOwner(id)).toEqual({ state: "free" });
		expect(sessionClaimSetOf(manager).sessionIds).toEqual([]);
		// Logged once per session and site, counted every time.
		expect(detectorLogs).toContainEqual({ site: "managed append", sessionId: id, mode: "observe" });
		const sites = detectorLogs.map(log => (log as { site: string }).site);
		expect(new Set(sites).size).toBe(sites.length);
	});

	describe("under the strict seam", () => {
		useStrictWriteDetection(closeManagers);
		const update = (m: SessionManager, first: string) =>
			m.applyEntryMessageUpdates([{ ...m.getEntry(first), message: user("rewritten") } as never]);

		it("throws before the write", async () => {
			const unclaimed = await outsideStrictSeam(() => bound("explicit"));
			const before = await transcripts(unclaimed.root);
			update(unclaimed.manager, unclaimed.context.first);
			await expect(unclaimed.manager.rewriteEntries()).rejects.toThrow(SessionWriteWithoutClaimError);
			expect(changed(before, await transcripts(unclaimed.root))).toBe(false);
			expectStrictDetections(1);
		});

		it("is silent for a claimed session", async () => {
			const claimed = await outsideStrictSeam(async () => {
				const fixture = await bound("explicit");
				sessionClaimSetOf(fixture.manager).add(await claimHeld(fixture.manager.getSessionId()));
				return fixture;
			});
			const before = await transcripts(claimed.root);
			update(claimed.manager, claimed.context.first);
			await claimed.manager.rewriteEntries();
			expect(changed(before, await transcripts(claimed.root))).toBe(true);
		});

		it("a strict throw a caller swallows is still counted against the test", async () => {
			const { manager } = await outsideStrictSeam(() => bound("managed"));
			try {
				manager.appendMessage(user("swallowed"));
			} catch {
				// A caller that turns the refusal into an outcome.
			}
			// Without this declaration the afterEach check fails the test.
			expect(undeclaredStrictDetections()).toBe(1);
			expectStrictDetections(1);
		});

		for (const kind of ["managed", "explicit"] as const) {
			it(`a ${kind} session's move is refused before it moves the transcript`, async () => {
				const { manager, root, context } = await outsideStrictSeam(async () => {
					const fixture = await bound(kind);
					await fs.mkdir(path.join(fixture.context.cwd, "moved"));
					return fixture;
				});
				const before = await transcripts(root);
				const published: string[] = [];
				manager.registerMovePublicationListener(move => {
					published.push(move.newCwd);
				});
				await expect(manager.moveTo(path.join(context.cwd, "moved"))).rejects.toMatchObject({
					name: "SessionWriteWithoutClaimError",
					site: "session move",
				});
				expectStrictDetections(1);
				expect(await transcripts(root)).toEqual(before);
				expect(manager.getSessionFile()).toBe(context.file);
				// Refused before the move's publication effects: no listener heard of it.
				expect(published).toEqual([]);
			});
		}

		for (const kind of ["managed", "explicit"] as const) {
			it(`a ${kind} session never written to disk moves without a report`, async () => {
				// Nothing to republish, so nothing to check.
				const { manager, root, context } = await outsideStrictSeam(async () => {
					const fixture = await bound(kind, true);
					await fs.mkdir(path.join(fixture.context.cwd, "moved"));
					return fixture;
				});
				const before = await transcripts(root);
				await manager.moveTo(path.join(context.cwd, "moved"));
				expect(manager.getSessionFile()).not.toBe(context.file);
				expect(await transcripts(root)).toEqual(before);
			});
		}

		it("does nothing in off", async () => {
			SessionOwnershipTestHooks.mode = "off";
			const { manager, root, context } = await bound("managed");
			const before = await transcripts(root);
			manager.appendMessage(user("off"));
			manager.rewriteEntries();
			await manager.flush();
			await fs.mkdir(path.join(context.cwd, "moved"));
			const published: string[] = [];
			manager.registerMovePublicationListener(move => {
				published.push(move.newCwd);
			});
			await manager.moveTo(path.join(context.cwd, "moved"));
			expect(manager.getSessionFile()).not.toBe(context.file);
			expect(published).toEqual([path.join(context.cwd, "moved")]);
			expect(changed(before, await transcripts(root))).toBe(true);
			expect(detectorLogs).toEqual([]);
		});
	});
});
