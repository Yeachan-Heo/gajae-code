/**
 * Behavioural guard for #7823/#7824: once a logical session publishes through shared
 * admission, every SessionManager legacy transcript writer must refuse before it
 * writes. The classification below is checked against the live SessionManager
 * prototype, so adding a new writer fails this test until it is classified and its
 * refusal (or admitted counterpart) is proven here.
 */
import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
	type DefaultModelSelectionStage,
	SessionManager,
	SharedSessionMutationUnsupportedError,
} from "@gajae-code/coding-agent/session/session-manager";

const roots: string[] = [];
const managers: SessionManager[] = [];

afterEach(async () => {
	for (const manager of managers.splice(0)) await manager.close().catch(() => undefined);
	for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});

function user(text: string) {
	return { role: "user" as const, content: text, timestamp: Date.now() };
}

type Invoke = (manager: SessionManager, context: { first: string; cwd: string; file: string }) => unknown;

/** Legacy writers of the current logical session; each must refuse after shared adoption. */
const LEGACY_WRITERS: Record<string, Invoke> = {
	appendConfiguredModelChain: m =>
		m.appendConfiguredModelChain({
			role: "default",
			entries: ["anthropic/claude-sonnet-4-5"],
			origin: "guard",
			explicitHead: true,
			cleared: false,
		}),
	appendMessage: m => m.appendMessage(user("legacy")),
	appendThinkingLevelChange: m => m.appendThinkingLevelChange("high"),
	appendServiceTierChange: m => m.appendServiceTierChange("priority"),
	appendModeChange: m => m.appendModeChange("plan"),
	appendModelChange: m => m.appendModelChange("anthropic/claude-sonnet-4-5"),
	clearModelRole: m => m.clearModelRole("default"),
	appendSessionInit: m => m.appendSessionInit({ systemPrompt: "s", task: "t", tools: [] }),
	appendCompaction: (m, { first }) => m.appendCompaction("summary", undefined, first, 1),
	appendCustomEntry: m => m.appendCustomEntry("guard", { v: 1 }),
	appendModelProfileOwnershipMarker: m => m.appendModelProfileOwnershipMarker({ kind: "cleared" }),
	appendSessionRecap: m => m.appendSessionRecap({ recap: "r" } as never),
	appendContextClearEntry: m => m.appendContextClearEntry({ sessionId: m.getSessionId() }),
	applyEntryMessageUpdates: m => m.applyEntryMessageUpdates([]),
	applyCustomMessageEntryUpdates: m => m.applyCustomMessageEntryUpdates([]),
	rewriteEntries: m => m.rewriteEntries(),
	appendCustomMessageEntry: m => m.appendCustomMessageEntry("guard", "content", true),
	appendMCPToolSelection: m => m.appendMCPToolSelection([]),
	appendDiscoveredBuiltinToolSelection: m => m.appendDiscoveredBuiltinToolSelection([]),
	appendTtsrInjection: m => m.appendTtsrInjection(["rule"]),
	evictCompactedContent: (m, { first }) => m.evictCompactedContent(first, first),
	appendLabelChange: (m, { first }) => m.appendLabelChange(first, "label"),
	branchWithSummary: (m, { first }) => m.branchWithSummary(first, "summary"),
	createBranchedSession: (m, { first }) => m.createBranchedSession(first),
	stageDefaultModelSelection: m =>
		m.stageDefaultModelSelection("anthropic/claude-sonnet-4-5", "high", { appendThinkingLevel: true }),
	promoteDefaultModelSelection: m => m.promoteDefaultModelSelection({} as DefaultModelSelectionStage),
	prepareFork: m => m.prepareFork(),
	prepareBranchedSession: (m, { first }) => m.prepareBranchedSession(first),
	fork: m => m.fork(),
	moveTo: (m, { cwd }) => m.moveTo(path.join(cwd, "moved")),
	setSessionName: m => m.setSessionName("legacy title", "user"),
	setSessionStarred: m => m.setSessionStarred(true),
	dropSession: (m, { file }) => m.dropSession(file),
};

/**
 * Mutation-shaped methods that are not legacy writers of the adopted session, with
 * the reason. Shared counterparts are proven by the shared-* suites.
 */
const NOT_LEGACY_WRITERS: Record<string, string> = {
	appendMessageDurably: "classifies the appendMessage refusal into its outcome; covered via appendMessage",
	appendMessageSharingSession: "admitted shared publication",
	appendCustomEntrySharingSession: "admitted shared publication",
	appendCustomMessageEntrySharingSession: "admitted shared publication",
	appendTemporaryModelChangeSharingSession: "admitted shared publication",
	appendModelProfileActivationSharingSession: "admitted shared publication",
	appendServiceTierChangeSharingSession: "admitted shared publication",
	appendControlEntriesSharingSession: "admitted shared publication (common control helper)",
	appendCompactionSharingSession: "admitted shared publication",
	appendThinkingLevelChangeSharingSession: "admitted shared publication",
	appendModeChangeSharingSession: "admitted shared publication",
	appendSessionRecapSharingSession: "admitted shared publication",
	appendToolSelectionsSharingSession: "admitted shared publication",
	appendTtsrInjectionSharingSession: "admitted shared publication",
	appendLabelChangeSharingSession: "admitted shared publication",
	setSessionNameSharingSession: "admitted shared title publication",
	setSessionStarredForPicker: "live picker star; current session guarded by set live picker star",
	appendPreparedModelChange: "writes an unpublished prepared successor",
	appendPreparedThinkingLevelChange: "writes an unpublished prepared successor",
	appendPreparedServiceTierChange: "writes an unpublished prepared successor",
	appendPreparedCustomMessageEntry: "writes an unpublished prepared successor",
	appendPreparedModelProfileOwnershipMarker: "writes an unpublished prepared successor",
	prepareNewSession: "prepares a fresh successor id",
	ensurePreparedNewSessionOnDisk: "writes an unpublished prepared successor",
	commitPreparedNewSession: "publishes a prepared successor; graph sources are guarded",
	discardPreparedNewSession: "discards an unpublished prepared successor",
	discardDefaultModelSelectionStage: "removes a legacy stage temp file only",
	discardUncommittedSession: "never-committed sessions only",
	discardStaged: "unpublished staged child cleanup",
	discardStagedNestedManaged: "unpublished staged child cleanup",
	commitStaged: "unpublished staged child publication",
	commitStagedNestedManaged: "unpublished staged child publication",
	rollbackCommittedStaged: "staged child rollback; checks persisted target header",
	remapStagedArtifactReferences: "staged child artifact remap; directly guarded",
	prepareManagedCandidateForWrite: "storage candidate preparation",
	prepareManagedCandidateForStrictAdoption: "storage candidate preparation",
	promoteRecoveryHydrationAfterOwnershipReadyFence: "recovery hydration promotion",
	deleteSessionVerified: "verified delete of a session file",
	sanitizeLoadedOpenAIResponsesReplayMetadata: "load-time only; refuses when it would mutate",
	branch: "local cursor movement, no transcript write",
	resetLeaf: "local cursor movement, no transcript write",
	ensureOnDisk: "materializes an already-owned transcript",
	ensureArtifactManager: "artifact storage only",
	stageAdoptedArtifactManagerForTransition: "artifact storage only",
	createMemoryGuardCheckpoint: "in-memory guard checkpoint",
	setSessionMemoryMode: "in-memory mode",
	setSessionFile: "switches the logical session",
	restoreState: "restores in-memory state; bars survive",
	restoreRollbackState: "restores in-memory state; bars survive",
	setSidecarHotSuffixBudgetForTests: "test hook",
	setParentArtifactBudgetForTests: "test hook",
};

const MUTATION_SHAPED =
	/^(append|set|clear|branch|rewrite|apply|stage|promote|discard|drop|move|fork|prepare|commit|evict|remap|rollback|reset|delete|sanitize|create|ensure|restore)/;

async function adopted() {
	const root = await fs.mkdtemp(path.join(import.meta.dirname, ".tmp-shared-legacy-guard-"));
	roots.push(root);
	const cwd = path.join(root, "workspace");
	const agentDir = path.join(root, "agent");
	await fs.mkdir(cwd, { recursive: true });
	await fs.mkdir(agentDir, { recursive: true, mode: 0o700 });
	const destination = SessionManager.managedDestination(cwd, agentDir);
	const manager = SessionManager.create(cwd, destination);
	managers.push(manager);
	const first = manager.appendMessage(user("first"));
	await manager.ensureOnDisk();
	await manager.flush();
	const file = manager.getSessionFile()!;
	const peer = await SessionManager.open(file, destination);
	managers.push(peer);
	expect((await peer.appendMessageSharingSession(user("unseen peer sibling"))).kind).toBe("committed");
	expect((await manager.appendMessageSharingSession(user("canonical local"))).kind).toBe("committed");
	expect(manager.requiresSharedMutationAdmission()).toBe(true);
	return { manager, first, cwd, file };
}

describe("shared legacy mutation guard (#7823, #7824)", () => {
	it("classifies every mutation-shaped SessionManager method", () => {
		const methods = Object.getOwnPropertyNames(SessionManager.prototype).filter(name => MUTATION_SHAPED.test(name));
		const unclassified = methods.filter(name => !(name in LEGACY_WRITERS) && !(name in NOT_LEGACY_WRITERS));
		expect(unclassified).toEqual([]);
		const stale = [...Object.keys(LEGACY_WRITERS), ...Object.keys(NOT_LEGACY_WRITERS)].filter(
			name => !methods.includes(name),
		);
		expect(stale).toEqual([]);
	});

	for (const [name, invoke] of Object.entries(LEGACY_WRITERS)) {
		it(`refuses ${name} after shared adoption without changing the transcript`, async () => {
			const f = await adopted();
			const bytes = await Bun.file(f.file).text();
			const leaf = f.manager.getLeafId();
			const entries = f.manager.getEntries().length;
			let outcome: { kind: "fulfilled" } | { kind: "rejected"; error: unknown };
			try {
				await invoke(f.manager, f);
				outcome = { kind: "fulfilled" };
			} catch (error) {
				outcome = { kind: "rejected", error };
			}
			expect(outcome.kind).toBe("rejected");
			if (outcome.kind === "rejected") expect(outcome.error).toBeInstanceOf(SharedSessionMutationUnsupportedError);
			expect(await Bun.file(f.file).text()).toBe(bytes);
			expect(f.manager.getLeafId()).toBe(leaf);
			expect(f.manager.getEntries()).toHaveLength(entries);
		});
	}
});
