import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as util from "node:util";
import type { AssistantMessage, Message } from "@gajae-code/ai";
import { withTimeout } from "@gajae-code/utils";
import {
	type FileEntry,
	SessionAppendPersistenceError,
	SessionManager,
	type SessionManagerCloseOutcome,
} from "../src/session/session-manager";

interface Fixture {
	root: string;
	create(): SessionManager;
	open(file: string): Promise<SessionManager>;
	expectedClose: Map<SessionManager, (outcome: SessionManagerCloseOutcome) => void>;
	finalImages: Map<string, string>;
}

async function withFixture(body: (fixture: Fixture) => Promise<void>): Promise<void> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-managed-boundaries-"));
	const cwd = path.join(root, "workspace");
	const agentDir = path.join(root, "agent");
	const managers: SessionManager[] = [];
	const expectedClose = new Map<SessionManager, (outcome: SessionManagerCloseOutcome) => void>();
	const finalImages = new Map<string, string>();
	const own = (manager: SessionManager): SessionManager => {
		managers.push(manager);
		return manager;
	};
	let primary: { error: unknown } | undefined;
	try {
		await fs.mkdir(cwd, { recursive: true });
		await fs.mkdir(agentDir, { recursive: true, mode: 0o700 });
		const destination = SessionManager.managedDestination(cwd, agentDir);
		await body({
			root,
			create: () => own(SessionManager.create(cwd, destination)),
			open: async file => own(await SessionManager.open(file, destination)),
			expectedClose,
			finalImages,
		});
	} catch (error) {
		primary = { error };
	}
	const cleanupErrors: unknown[] = [];
	const outcomes: SessionManagerCloseOutcome[] = [];
	let retainRoot = primary !== undefined;
	const closeDeadline = performance.now() + 1_500;
	for (const manager of managers.reverse()) {
		try {
			const outcome = await withTimeout(
				manager.closeStrict(),
				Math.max(1, closeDeadline - performance.now()),
				`Strict close is still pending; retaining fixture evidence: ${root}`,
			);
			outcomes.push(outcome);
			if (outcome.kind !== "closed") retainRoot = true;
			const check = expectedClose.get(manager);
			if (check) check(outcome);
			else expect(outcome).toEqual({ kind: "closed" });
		} catch (error) {
			retainRoot = true;
			cleanupErrors.push(error);
		}
	}
	for (const [file, expected] of finalImages) {
		try {
			expect(await Bun.file(file).text()).toBe(expected);
		} catch (error) {
			retainRoot = true;
			cleanupErrors.push(error);
		}
	}
	try {
		if (retainRoot) {
			await Bun.write(
				path.join(root, "verification.txt"),
				util.inspect({ primary, outcomes, cleanupErrors }, { depth: null }),
			);
		} else await fs.rm(root, { recursive: true, force: true });
	} catch (error) {
		cleanupErrors.push(error);
	}
	if (cleanupErrors.length > 0)
		throw new AggregateError(
			[...(primary ? [primary.error] : []), ...cleanupErrors],
			`Managed boundary fixture cleanup failed: ${root}`,
		);
	if (primary) throw primary.error;
}

function assistant(content: AssistantMessage["content"]): AssistantMessage {
	return {
		role: "assistant",
		content,
		timestamp: 1,
		api: "test",
		provider: "test",
		model: "test",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
	};
}

async function openPair(fixture: Fixture, message: Message) {
	const writer = fixture.create();
	const messageId = writer.appendMessage(message);
	await writer.ensureOnDisk();
	const file = writer.getSessionFile();
	if (!file) throw new Error("Expected a transcript path");
	const beforeOpen = await Bun.file(file).text();
	const first = await fixture.open(file);
	const afterFirstOpen = await Bun.file(file).text();
	const second = await fixture.open(file);
	return { file, first, second, messageId, beforeOpen, afterFirstOpen };
}

const rootMessage: Message = { role: "user", content: "shared root", timestamp: 1 };

describe("managed storage shared boundaries", () => {
	it("refuses stale armed rewrite debt without replacing a peer commit, including close", async () => {
		await withFixture(async fixture => {
			const { file, first, second, messageId } = await openPair(fixture, { ...rootMessage });
			// This small case arms legacy rewrite debt; it is not the actual file-cap route.
			// fixtures/shared-publication-realcap-probe.ts covers the unmodified 128 MiB cap.
			const entry = second.getEntry(messageId);
			if (entry?.type !== "message" || entry.message.role !== "user") throw new Error("Expected the user entry");
			second.applyEntryMessageUpdates([{ ...entry, message: { ...entry.message, content: "rewritten in place" } }]);
			expect(JSON.stringify(second.getEntry(messageId))).toContain("rewritten in place");
			first.appendMessage({ role: "user", content: "from first", timestamp: 2 });
			await first.flush();
			const advanced = await Bun.file(file).text();
			expect(advanced).toContain("from first");
			let refusal: unknown;
			try {
				second.appendMessage({ role: "user", content: "from second", timestamp: 3 });
			} catch (error) {
				refusal = error;
			}
			if (!(refusal instanceof SessionAppendPersistenceError))
				throw new Error("Expected replacement refusal", { cause: refusal });
			expect(refusal.message).toContain("managed_replace_identity_mismatch");
			fixture.expectedClose.set(second, outcome => {
				expect(outcome.kind).toBe("close_failed_retryable");
				if (outcome.kind !== "closed") expect(outcome.error).toBe(refusal.persistenceError);
			});
			const after = await Bun.file(file).text();
			expect(after).toBe(advanced);
			expect(after).not.toContain("from second");
			expect(after).not.toContain("rewritten in place");
			fixture.finalImages.set(file, advanced);
		});
	});

	it("sanitizes replay metadata in resident views without publishing at open or close", async () => {
		await withFixture(async fixture => {
			const message = assistant([
				{ type: "thinking", thinking: "kept reasoning", thinkingSignature: "signature-to-strip" },
			]);
			message.providerPayload = { type: "openaiResponsesHistory", items: [] };
			const { file, first, second, beforeOpen, afterFirstOpen } = await openPair(fixture, message);
			expect(beforeOpen).toContain("signature-to-strip");
			expect(afterFirstOpen).toBe(beforeOpen);
			expect(afterFirstOpen).not.toContain("entry_patch");
			// Default managed open already sanitized memory without publishing. This does not
			// claim the separate bounded-resume lane armed replacement debt.
			expect(first.sanitizeLoadedOpenAIResponsesReplayMetadata()).toBe(false);
			expect(JSON.stringify(first.getEntries())).not.toContain("signature-to-strip");
			expect(JSON.stringify(second.getEntries())).not.toContain("signature-to-strip");
			expect(await Bun.file(file).text()).toBe(beforeOpen);
			const reopened = await fixture.open(file);
			expect(JSON.stringify(reopened.getEntries())).not.toContain("signature-to-strip");
			expect(await Bun.file(file).text()).toBe(beforeOpen);
			fixture.finalImages.set(file, beforeOpen);
		});
	});

	it("follows same-owner relocation and refuses an opener at the old path", async () => {
		await withFixture(async fixture => {
			const { file, first, second } = await openPair(fixture, { ...rootMessage });
			const before = await Bun.file(file).text();
			const nextCwd = path.join(fixture.root, "moved-workspace");
			await fs.mkdir(nextCwd);
			await first.moveTo(nextCwd);
			const movedPath = first.getSessionFile();
			if (!movedPath) throw new Error("Expected the moved transcript path");
			expect(movedPath).not.toBe(file);
			expect(await Bun.file(file).exists()).toBe(false);
			const moved = await Bun.file(movedPath).text();
			expect(moved.split("\n").slice(1)).toEqual(before.split("\n").slice(1));
			expect(moved).toContain("moved-workspace");
			const ownerOutcome = await first.appendMessageSharingSession({
				role: "user",
				content: "from owner after move",
				timestamp: 2,
			});
			expect(ownerOutcome.kind).toBe("committed");
			const advanced = await Bun.file(movedPath).text();
			expect(advanced).toContain("from owner after move");
			const staleOutcome = await second.appendMessageSharingSession({
				role: "user",
				content: "from stale opener",
				timestamp: 3,
			});
			expect(staleOutcome).toMatchObject({ kind: "stale", reason: "transcript_moved" });
			expect(await Bun.file(file).exists()).toBe(false);
			expect(await Bun.file(movedPath).text()).toBe(advanced);
			expect(advanced).not.toContain("from stale opener");
			fixture.finalImages.set(movedPath, advanced);
		});
	});

	it.each([
		false,
		true,
	])("rehydrates the full evicted payload through fidelity from a later opener (materialize=%s)", async materialize => {
		await withFixture(async fixture => {
			const writer = fixture.create();
			const payload = "needle-payload-".repeat(20_000);
			const evictableId = writer.appendMessage(assistant([{ type: "text", text: payload }]));
			const keptId = writer.appendMessage({ role: "user", content: "kept turn", timestamp: 2 });
			await writer.ensureOnDisk();
			const file = writer.getSessionFile();
			if (!file) throw new Error("Expected a transcript path");
			const compactionId = writer.appendCompaction("summary", undefined, keptId, 100);
			await writer.flush();
			const evictor = await fixture.open(file);
			expect(evictor.getSessionMemoryStats()).toMatchObject({ sidecarEnabled: true, coldRetirementActive: false });
			expect(evictor.evictCompactedContent(keptId, compactionId).evictedEntries).toBeGreaterThan(0);
			const evictionMarker = {
				reason: "compacted_history",
				compactionEntryId: compactionId,
				firstKeptEntryId: keptId,
			};
			if (materialize) {
				for (let attempt = 0; attempt < 2; attempt++)
					expect(evictor.getEntries().find(entry => entry.id === evictableId)).toMatchObject({
						evictedContent: evictionMarker,
					});
			}
			const appendedId = evictor.appendMessage({ role: "user", content: "after eviction", timestamp: 3 });
			expect(evictor.getLeafId()).toBe(appendedId);
			await evictor.flush();
			const onDisk = await Bun.file(file).text();
			const rows = Bun.JSONL.parse(onDisk) as FileEntry[];
			expect(rows.find(entry => entry.id === appendedId)).toMatchObject({ type: "message", parentId: compactionId });
			expect(rows.find(entry => entry.id === evictableId)).toMatchObject({ evictedContent: evictionMarker });
			expect(onDisk).not.toContain("needle-payload-needle-payload-needle-payload");
			const reader = await fixture.open(file);
			const entry = reader.getEntry(evictableId);
			if (entry?.type !== "message") throw new Error("Expected the evicted entry");
			expect(JSON.stringify(entry.message)).not.toContain("needle-payload-");
			expect(JSON.stringify(entry.message)).toContain("evicted to durable cold storage");
			expect(JSON.stringify(reader.getEntries())).not.toContain("needle-payload-");
			const fidelity = reader.getEntryForFidelity(evictableId);
			if (fidelity?.type !== "message" || fidelity.message.role !== "assistant")
				throw new Error("Expected the assistant fidelity entry");
			expect(fidelity.message.content).toEqual([{ type: "text", text: payload }]);
			fixture.finalImages.set(file, onDisk);
			// Eviction/read fidelity is established here, not an unexercised blob-GC collision.
		});
	});
});
