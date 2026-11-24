/**
 * Runtime writer inventory for the ownership write-path detector (single-owner design §2.5).
 *
 * Every mutation-shaped SessionManager method on the live prototype is classified: a writer of the
 * current session's transcript, a writer of a successor's transcript, or not a transcript writer
 * (with the reason). Each writer then runs against a real transcript with ownership on and no claim
 * held, and every transcript byte it changes must have been seen by the detector first. A method
 * added later fails the classification until it is listed here, and a writer that reaches the disk
 * around the detector fails the attribution check.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { logger } from "@gajae-code/utils";
import { SessionWriteWithoutClaimError, sessionClaimSetOf } from "../../src/session/internal/session-claim-set";
import { type DefaultModelSelectionStage, SessionManager } from "../../src/session/session-manager";
import {
	claimSessionOwner,
	probeSessionOwner,
	resetSessionOwnershipForTests,
	SessionOwnershipTestHooks,
	sessionOwnershipCounters,
} from "../../src/session/session-ownership";

const supported = process.platform === "linux" || process.platform === "darwin";
const roots: string[] = [];
const managers: SessionManager[] = [];
let detectorLogs: unknown[] = [];

beforeEach(() => {
	SessionOwnershipTestHooks.mode = "observe";
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
		vi.restoreAllMocks();
		resetSessionOwnershipForTests();
	}
});

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

/** Mutation-shaped methods that write no transcript bytes of a session this manager binds. */
const NOT_TRANSCRIPT_WRITERS: Record<string, string> = {
	appendSessionRecap: "plans a recap, then writes it through appendCustomEntry",
	appendSessionRecapSharingSession: "plans a recap, then writes it through appendCustomEntrySharingSession",
	appendThinkingLevelChangeSharingSession:
		"needs AgentSession's thinking-control owner; writes through the shared append funnel like its siblings",
	restoreRollbackState: "rebinds the id; claim-set behaviour in session-claim-set.test.ts",
	restoreState: "rebinds the id; claim-set behaviour in session-claim-set.test.ts",
	setSessionFile: "rebinds the id; claim-set behaviour in session-claim-set.test.ts",
	prepareNewSession: "stages an unpublished successor in memory",
	appendPreparedModelChange: "stages into an unpublished successor; ensurePreparedNewSessionOnDisk writes it",
	appendPreparedThinkingLevelChange: "stages into an unpublished successor; ensurePreparedNewSessionOnDisk writes it",
	appendPreparedServiceTierChange: "stages into an unpublished successor; ensurePreparedNewSessionOnDisk writes it",
	appendPreparedCustomMessageEntry: "stages into an unpublished successor; ensurePreparedNewSessionOnDisk writes it",
	appendPreparedModelProfileOwnershipMarker:
		"stages into an unpublished successor; ensurePreparedNewSessionOnDisk writes it",
	discardPreparedNewSession: "removes an unpublished successor",
	discardUncommittedSession: "removes a never-committed session",
	discardDefaultModelSelectionStage: "removes a staged temp file",
	dropSession: "deletes a session; delete ownership is the scoped-claim step",
	setSessionStarredForPicker: "picker write of any session; scoped claims cover picker writes",
	setSessionMemoryMode: "in-memory mode",
	createMemoryGuardCheckpoint: "in-memory checkpoint",
	stageAdoptedArtifactManagerForTransition: "artifact storage only",
	ensureArtifactManager: "artifact storage only",
	remapStagedArtifactReferences: "staged child artifact references; staged sessions claim at commit",
	sanitizeLoadedOpenAIResponsesReplayMetadata: "load-time only; factories claim before it",
	branch: "local cursor movement",
	resetLeaf: "local cursor movement",
	prepareManagedCandidateForWrite: "open-time candidate preparation; factories claim before it",
	prepareManagedCandidateForStrictAdoption: "open-time candidate preparation; factories claim before it",
	commitStaged: "staged child publication; staged sessions claim at commit",
	rollbackCommittedStaged: "staged child rollback",
	discardStaged: "unpublished staged child cleanup",
	commitStagedNestedManaged: "staged child publication; staged sessions claim at commit",
	discardStagedNestedManaged: "unpublished staged child cleanup",
	promoteRecoveryHydrationAfterOwnershipReadyFence: "recovery hydration of an opening manager",
	deleteSessionVerified: "verified delete; delete ownership is the scoped-claim step",
	setSidecarHotSuffixBudgetForTests: "test hook",
	setParentArtifactBudgetForTests: "test hook",
};

const MUTATION_SHAPED =
	/^(append|set|clear|branch|rewrite|apply|stage|promote|discard|drop|move|fork|prepare|commit|evict|remap|rollback|reset|delete|sanitize|create|ensure|restore)/;

function unclassified(methods: readonly string[]): string[] {
	return methods.filter(
		name => !(name in CURRENT_WRITERS) && !(name in SUCCESSOR_WRITERS) && !(name in NOT_TRANSCRIPT_WRITERS),
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

function changed(before: Map<string, string>, after: Map<string, string>): boolean {
	if (before.size !== after.size) return true;
	for (const [name, text] of after) if (before.get(name) !== text) return true;
	return false;
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
		const result = await claimSessionOwner(manager.getSessionId(), { surface: "terminal" });
		if (result.status !== "claimed") throw new Error("expected a claim");
		sessionClaimSetOf(manager).add(result.claim);
	}
	let prepared: unknown;
	try {
		prepared = await staged.setup?.(manager, context);
		await manager.flush();
	} catch (error) {
		throw new Error(`setup failed: ${String(error)}`);
	}
	const before = await transcripts(root);
	const detectedBefore = sessionOwnershipCounters().session_write_without_claim;
	try {
		await staged.run(manager, context, prepared);
		await manager.flush();
	} catch {
		// A refusal is fine; only bytes that reached the disk need attribution.
	}
	// Close discards unpublished successors, so look before it too.
	let wrote = changed(before, await transcripts(root));
	// In-memory rewrites (message updates, eviction) reach the disk as rewrite debt at close.
	await manager.close().catch(() => undefined);
	wrote ||= changed(before, await transcripts(root));
	return { wrote, detected: sessionOwnershipCounters().session_write_without_claim - detectedBefore };
}

describe("session ownership writer inventory", () => {
	it("classifies every mutation-shaped SessionManager method", () => {
		const methods = Object.getOwnPropertyNames(SessionManager.prototype).filter(name => MUTATION_SHAPED.test(name));
		expect(unclassified(methods)).toEqual([]);
		const listed = [
			...Object.keys(CURRENT_WRITERS),
			...Object.keys(SUCCESSOR_WRITERS),
			...Object.keys(NOT_TRANSCRIPT_WRITERS),
		];
		expect(listed.filter(name => !methods.includes(name))).toEqual([]);
		// A writer added later is caught until it is listed.
		expect(unclassified([...methods, "appendBypassingWriter"])).toEqual(["appendBypassingWriter"]);
	});

	it("the attribution check rejects a writer that reaches the disk around the detector", async () => {
		const bypass: Invoke = (_m, { file }) => fs.appendFile(file, `${JSON.stringify({ type: "custom" })}\n`);
		const result = await attribute("explicit", bypass);
		expect(result).toEqual({ wrote: true, detected: 0 });
	});

	const writers = { ...CURRENT_WRITERS, ...SUCCESSOR_WRITERS };
	const wroteSomewhere = new Set<string>();
	for (const [name, writer] of Object.entries(writers)) {
		for (const kind of ["managed", "explicit"] as const) {
			it(`${name} (${kind}): every transcript write without a claim is detected`, async () => {
				const result = await attribute(kind, writer);
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
			for (const kind of ["managed", "explicit"] as const)
				expect((await attribute(kind, writer, true)).detected).toBe(0);
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

	it("the strict seam throws before the write, and is silent for a claimed session", async () => {
		const update = (m: SessionManager, first: string) =>
			m.applyEntryMessageUpdates([{ ...m.getEntry(first), message: user("rewritten") } as never]);
		const unclaimed = await bound("explicit");
		const before = await transcripts(unclaimed.root);
		SessionOwnershipTestHooks.strictWriteDetection = true;
		update(unclaimed.manager, unclaimed.context.first);
		await expect(unclaimed.manager.rewriteEntries()).rejects.toThrow(SessionWriteWithoutClaimError);
		expect(changed(before, await transcripts(unclaimed.root))).toBe(false);

		delete SessionOwnershipTestHooks.strictWriteDetection;
		const claimed = await bound("explicit");
		const result = await claimSessionOwner(claimed.manager.getSessionId(), { surface: "terminal" });
		if (result.status !== "claimed") throw new Error("expected a claim");
		sessionClaimSetOf(claimed.manager).add(result.claim);
		const claimedBefore = await transcripts(claimed.root);
		SessionOwnershipTestHooks.strictWriteDetection = true;
		update(claimed.manager, claimed.context.first);
		await claimed.manager.rewriteEntries();
		expect(changed(claimedBefore, await transcripts(claimed.root))).toBe(true);
	});

	it("does nothing in off, even under the strict seam", async () => {
		SessionOwnershipTestHooks.mode = "off";
		SessionOwnershipTestHooks.strictWriteDetection = true;
		const { manager, root } = await bound("managed");
		const before = await transcripts(root);
		manager.appendMessage(user("off"));
		manager.rewriteEntries();
		await manager.flush();
		expect(changed(before, await transcripts(root))).toBe(true);
		expect(sessionOwnershipCounters().session_write_without_claim).toBe(0);
		expect(detectorLogs).toEqual([]);
	});
});
