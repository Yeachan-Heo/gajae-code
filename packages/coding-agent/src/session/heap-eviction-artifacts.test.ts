import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { ToolResultMessage } from "@gajae-code/ai/core";
import { ArtifactProtocolHandler } from "../internal-urls/artifact-protocol";
import { parseInternalUrl } from "../internal-urls/parse";
import type { EvictedToolOutputHandle } from "../tools/output-meta";
import { ArtifactManager } from "./artifacts";
import { CURRENT_SESSION_VERSION, loadEntriesFromFile, parseSessionEntries, SessionManager } from "./session-manager";
import { DEFAULT_ARTIFACT_MAX_BYTES } from "./streaming-output";

function toolResult(text: string, details?: unknown): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId: "w4-call",
		toolName: "bash",
		content: [{ type: "text", text }],
		...(details === undefined ? {} : { details }),
		isError: false,
		timestamp: Date.now(),
	};
}

function sessionHeader(cwd: string, id = "w4-session"): Record<string, unknown> {
	return {
		type: "session",
		version: CURRENT_SESSION_VERSION,
		id,
		timestamp: new Date().toISOString(),
		cwd,
	};
}

function sessionLine(
	message: ToolResultMessage,
	id = "w4-message",
	parentId: string | null = null,
): Record<string, unknown> {
	return {
		type: "message",
		id,
		parentId,
		timestamp: new Date().toISOString(),
		message,
	};
}

function handle(id: string, version: 1 | 2 = 1): EvictedToolOutputHandle {
	return {
		v: version,
		artifactId: id,
		uri: `artifact://${id}`,
		encoding: "utf-8",
		bytes: 0,
		sha256: "0".repeat(64),
		complete: true,
	} as EvictedToolOutputHandle;
}

async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
	const dir = await mkdtemp(path.join(os.tmpdir(), "gjc-w4-artifacts-"));
	try {
		return await fn(dir);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
}

describe("W4 artifact outcomes and version-skew gates", () => {
	test("persist=false is typed unavailable and writes no artifact", async () => {
		await withTempDir(async dir => {
			const manager = new ArtifactManager(dir);
			const outcome = await manager.publishExactText("not persisted", { persist: false });
			expect(outcome).toEqual({ outcome: "unavailable", diagnostic: "artifact persistence disabled" });
			expect(await manager.listFiles()).toEqual([]);
		});
	});

	test(">10MiB is incomplete and fail-closed without an eviction handle", async () => {
		await withTempDir(async dir => {
			const manager = new ArtifactManager(dir);
			const text = "x".repeat(DEFAULT_ARTIFACT_MAX_BYTES + 1);
			const outcome = await manager.publishExactText(text, { maxBytes: DEFAULT_ARTIFACT_MAX_BYTES });
			expect(outcome).toMatchObject({ outcome: "incomplete", bytes: DEFAULT_ARTIFACT_MAX_BYTES + 1 });
			expect("handle" in outcome).toBe(false);
			expect(await manager.listFiles()).toEqual([]);
		});
	});

	test("saved artifacts round-trip exact readRange and openReadStream bytes", async () => {
		await withTempDir(async dir => {
			const manager = new ArtifactManager(dir);
			const text = "prefix-😀-middle-漢字-suffix";
			const published = await manager.publishExactText(text, { toolType: "evicted" });
			expect(published.outcome).toBe("saved");
			if (published.outcome !== "saved") return;
			expect(published.handle.complete).toBe(true);
			expect(published.handle.bytes).toBe(Buffer.byteLength(text, "utf8"));
			expect(await manager.readRange(published.handle.artifactId, { start: 0, endExclusive: 6 })).toBe(
				text.slice(0, 6),
			);
			const stream = await manager.openReadStream(published.handle.artifactId, { start: 7, endExclusive: 13 });
			expect(await new Response(stream).text()).toBe(Buffer.from(text).subarray(7, 13).toString("utf8"));
			expect(await manager.readRange(published.handle.artifactId)).toBe(text);
		});
	});

	test("artifact-protocol range serves a bounded large-artifact read", async () => {
		await withTempDir(async dir => {
			const manager = new ArtifactManager(dir);
			const text = "0123456789abcdef".repeat(65_536);
			const published = await manager.publishExactText(text);
			expect(published.outcome).toBe("saved");
			if (published.outcome !== "saved") return;
			const handler = new ArtifactProtocolHandler();
			const resource = await handler.resolve(parseInternalUrl(`${published.handle.uri}?range=100-131`), {
				getArtifactsDir: () => dir,
			});
			expect(resource.content).toBe(text.slice(100, 132));
			expect(resource.size).toBe(Buffer.byteLength(resource.content, "utf8"));
			expect(resource.content.length).toBe(32);
		});
	});

	test("inspection hashes by stream and never performs an unrestricted full read", async () => {
		await withTempDir(async dir => {
			const manager = SessionManager.create(process.cwd(), dir);
			try {
				await manager.ensureOnDisk();
				const artifactsDir = manager.getArtifactsDir();
				expect(artifactsDir).not.toBeNull();
				if (!artifactsDir) return;
				const text = "large-".repeat(3 * 1024 * 1024);
				await mkdir(artifactsDir, { recursive: true });
				const artifactId = "77";
				await writeFile(path.join(artifactsDir, `${artifactId}.evicted.log`), text, "utf8");
				const evictedHandle: EvictedToolOutputHandle = {
					v: 1,
					artifactId,
					uri: `artifact://${artifactId}`,
					encoding: "utf-8",
					bytes: Buffer.byteLength(text, "utf8"),
					sha256: createHash("sha256").update(text, "utf8").digest("hex"),
					complete: true,
				};
				const artifactManager = manager.getArtifactManager();
				expect(artifactManager).not.toBeNull();
				if (!artifactManager) return;
				const originalReadRange = artifactManager.readRange.bind(artifactManager);
				const observedRanges: Array<{ start?: number; endExclusive?: number }> = [];
				artifactManager.readRange = async (id, range = {}) => {
					observedRanges.push(range);
					return await originalReadRange(id, range);
				};
				const inspected = await manager.inspectEvictedToolOutput(evictedHandle, { start: 123, endExclusive: 157 });
				expect(inspected.outcome).toBe("saved");
				expect(inspected.text).toBe(text.slice(123, 157));
				expect(observedRanges).toEqual([{ start: 123, endExclusive: 157 }]);
				const bounded = await manager.inspectEvictedToolOutput(evictedHandle);
				expect(bounded.outcome).toBe("saved");
				expect(bounded.text?.length).toBeLessThanOrEqual(16 * 1024 * 1024);
				expect(observedRanges).toEqual([
					{ start: 123, endExclusive: 157 },
					{ start: 0, endExclusive: 16 * 1024 * 1024 },
				]);
			} finally {
				await manager.close();
			}
		});
	});

	test("artifact-protocol bounds unqualified reads while honoring explicit ranges first", async () => {
		await withTempDir(async dir => {
			const handler = new ArtifactProtocolHandler();
			const prefix = "a".repeat(16 * 1024 * 1024);
			const suffix = "-suffix";
			await writeFile(path.join(dir, "9.tool.log"), `${prefix}${suffix}`);

			const bounded = await handler.resolve(parseInternalUrl("artifact://9"), {
				getArtifactsDir: () => dir,
			});
			expect(bounded.content.startsWith(prefix)).toBe(true);
			expect(bounded.content).toContain("Artifact truncated");
			expect(bounded.content).not.toContain(suffix);

			const ranged = await handler.resolve(parseInternalUrl("artifact://9?range=16777216-16777223"), {
				getArtifactsDir: () => dir,
			});
			expect(ranged.content).toBe(suffix);
		});
	});

	test("new-write/old-read preserves the provider-visible eviction notice while ignoring unknown details", () => {
		const notice = "[Output truncated; full output: artifact://0]";
		const raw = [
			sessionHeader(process.cwd()),
			sessionLine(
				toolResult(notice, {
					meta: { eviction: handle("0") },
				}),
			),
		];
		const loaded = parseSessionEntries(raw.map(value => JSON.stringify(value)).join("\n"));
		const message = loaded[1];
		expect(message?.type).toBe("message");
		if (message?.type !== "message") return;
		const oldReaderMessage = message.message as ToolResultMessage;
		const oldReaderDetailsIgnored = { role: oldReaderMessage.role, content: oldReaderMessage.content };
		expect(oldReaderDetailsIgnored.content).toEqual([{ type: "text", text: notice }]);
		expect((message.message as ToolResultMessage).details).toMatchObject({ meta: { eviction: { v: 1 } } });
	});

	test("old-write/new-read loads legacy tool results without eviction unchanged", () => {
		const legacyText = "legacy output remains byte-identical";
		const raw = [sessionHeader(process.cwd()), sessionLine(toolResult(legacyText))];
		const loaded = parseSessionEntries(raw.map(value => JSON.stringify(value)).join("\n"));
		const message = loaded[1];
		expect(message?.type).toBe("message");
		if (message?.type !== "message") return;
		expect(message.message).toEqual(expect.objectContaining({ content: [{ type: "text", text: legacyText }] }));
		expect((message.message as ToolResultMessage).details).toBeUndefined();
	});

	test("persisted missing artifact is typed unavailable while transcript rendering still works", async () => {
		await withTempDir(async dir => {
			const manager = SessionManager.create(process.cwd(), dir);
			try {
				await manager.ensureOnDisk();
				const artifactsDir = manager.getArtifactsDir();
				expect(artifactsDir).not.toBeNull();
				if (!artifactsDir) return;
				const artifactManager = new ArtifactManager(artifactsDir);
				const published = await artifactManager.publishExactText("evicted payload");
				expect(published.outcome).toBe("saved");
				if (published.outcome !== "saved") return;
				const artifactPath = await artifactManager.getPath(published.handle.artifactId);
				expect(artifactPath).not.toBeNull();
				if (!artifactPath) return;
				await rm(artifactPath);
				const notice = `[Output truncated; full output: ${published.handle.uri}]`;
				manager.appendMessage(toolResult(notice, { meta: { eviction: published.handle } }));
				const rendered = manager.buildSessionContext();
				expect(rendered.messages).toHaveLength(1);
				expect((rendered.messages[0] as ToolResultMessage).content).toEqual([{ type: "text", text: notice }]);
				const inspected = await manager.inspectEvictedToolOutput(published.handle);
				expect(inspected.outcome).toBe("unavailable");
			} finally {
				await manager.close();
			}
		});
	});

	test("valid handles rehydrate only after byte-length and sha256 validation", async () => {
		await withTempDir(async dir => {
			const manager = SessionManager.create(process.cwd(), dir);
			try {
				await manager.ensureOnDisk();
				const artifactManager = manager.getArtifactManager();
				expect(artifactManager).not.toBeNull();
				if (!artifactManager) return;
				const published = await artifactManager.publishExactText("stable payload");
				expect(published.outcome).toBe("saved");
				if (published.outcome !== "saved") return;

				await expect(manager.rehydrateToolResultMessage(published.handle)).resolves.toBe("stable payload");
				const byteMismatch = { ...published.handle, bytes: published.handle.bytes + 1 };
				await expect(manager.rehydrateToolResultMessage(byteMismatch)).rejects.toThrow(/byte length/i);

				const incomplete = { ...published.handle, complete: false } as unknown;
				await expect(manager.rehydrateToolResultMessage(incomplete)).rejects.toThrow(/not complete|incomplete/i);
				expect((await manager.inspectEvictedToolOutput(incomplete)).outcome).toBe("unavailable");

				const artifactPath = await artifactManager.getPath(published.handle.artifactId);
				expect(artifactPath).not.toBeNull();
				if (!artifactPath) return;
				await writeFile(artifactPath, "tampered bytes");
				const inspected = await manager.inspectEvictedToolOutput(published.handle);
				expect(inspected.outcome).toBe("unavailable");
				expect(inspected.diagnostic).toMatch(/sha256|mismatch/i);
				await expect(manager.rehydrateToolResultMessage(published.handle)).rejects.toThrow(/sha256/i);
			} finally {
				await manager.close();
			}
		});
	});
	test("custom-message rollback preserves an existing evicted-content marker", () => {
		const manager = SessionManager.inMemory();
		const id = manager.appendCustomMessageEntry("rollback", "original content", false, undefined, "agent");
		const entry = manager.getEntry(id);
		expect(entry?.type).toBe("custom_message");
		if (entry?.type !== "custom_message") return;
		const marker = {
			evictedAt: 1,
			reason: "compacted_history",
			compactionEntryId: "compaction-1",
			firstKeptEntryId: "kept-1",
			payloads: {},
		} as const;
		const restored = { ...entry, content: "restored content", evictedContent: marker };
		manager.applyCustomMessageEntryUpdates([restored], { preserveEvictedContent: true });
		const canonical = manager.getCanonicalEntryForTests(id);
		expect(canonical?.type).toBe("custom_message");
		if (canonical?.type !== "custom_message") return;
		expect(canonical.evictedContent).toEqual(marker);
	});

	test("synthetic v2 eviction metadata is ignored with a typed diagnostic", async () => {
		await withTempDir(async dir => {
			const manager = SessionManager.create(process.cwd(), dir);
			try {
				await manager.ensureOnDisk();
				const artifactsDir = manager.getArtifactsDir();
				expect(artifactsDir).not.toBeNull();
				if (!artifactsDir) return;
				const artifactManager = new ArtifactManager(artifactsDir);
				const published = await artifactManager.publishExactText("synthetic payload");
				expect(published.outcome).toBe("saved");
				if (published.outcome !== "saved") return;
				const inspected = await manager.inspectEvictedToolOutput(handle(published.handle.artifactId, 2));
				expect(inspected.outcome).toBe("unavailable");
				expect(inspected.diagnostic).toMatch(/unsupported|version|eviction/i);
			} finally {
				await manager.close();
			}
		});
	});
});

describe("W4 session cache retainers and rewrite invalidation", () => {
	test("materialized entries and context caches drop evicted marker after canonical rewrite", () => {
		const marker = `session-cache-marker-${crypto.randomUUID()}-${"y".repeat(4_096)}`;
		const manager = SessionManager.inMemory();
		const entryId = manager.appendMessage(toolResult(marker));
		const materialized = manager.getEntries();
		const context = manager.buildSessionContext();
		expect(JSON.stringify(materialized)).toContain(marker);
		expect(JSON.stringify(context)).toContain(marker);
		const statsBefore = manager.getObservabilityStatsForTests();

		const updated = materialized.find(entry => entry.type === "message" && entry.id === entryId);
		expect(updated?.type).toBe("message");
		if (updated?.type !== "message") return;
		const updatedToolResult = updated.message as ToolResultMessage;
		updatedToolResult.content = [{ type: "text", text: "[Output truncated - digest only]" }];
		updatedToolResult.prunedAt = Date.now();
		manager.applyEntryMessageUpdates([updated]);

		expect(JSON.stringify(manager.getEntries())).not.toContain(marker);
		expect(JSON.stringify(manager.buildSessionContext())).not.toContain(marker);
		const statsAfter = manager.getObservabilityStatsForTests();
		expect(statsAfter.materializedEntriesCachePopulateCount).toBeGreaterThan(
			statsBefore.materializedEntriesCachePopulateCount,
		);
		expect(manager.hotRetainedMessageCharsForTests()).toBeLessThan(
			statsBefore.materializedEntriesCachePopulateCount + marker.length + 1,
		);
	});
});

describe("W4 persisted transcript compatibility", () => {
	test("persisted v1 eviction details survive load and provider context reconstruction", async () => {
		await withTempDir(async dir => {
			const sessionFile = path.join(dir, "w4.jsonl");
			const notice = "[Output truncated; full output: artifact://0]";
			const lines = [
				sessionHeader(process.cwd()),
				sessionLine(toolResult(notice, { meta: { eviction: handle("0") } })),
			];
			await writeFile(sessionFile, `${lines.map(value => JSON.stringify(value)).join("\n")}\n`, "utf8");
			const loaded = await loadEntriesFromFile(sessionFile);
			expect(loaded).toHaveLength(2);
			const manager = await SessionManager.open(sessionFile, dir);
			const context = manager.buildSessionContext();
			expect((context.messages[0] as ToolResultMessage).content).toEqual([{ type: "text", text: notice }]);
		});
	});
});
