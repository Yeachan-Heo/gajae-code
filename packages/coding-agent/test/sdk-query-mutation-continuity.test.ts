import { describe, expect, it } from "bun:test";
import { mkdtemp, readdir, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	CURSOR_TTL_MS,
	CursorRegistry,
	MAX_CURSORS_PER_CONNECTION,
	QueryHandlers,
	RevisionStore,
} from "../src/sdk/host/query/index.js";

const text = (n: number) => "x".repeat(n);
function surface(queue: unknown[], config: unknown[]) {
	return {
		getTranscriptEntries: () => [],
		getContextSnapshot: () => ({}),
		getGoalState: () => [],
		getTodoState: () => [],
		getDiff: () => [],
		getUsage: () => ({}),
		getModels: () => [],
		getSkillState: () => [],
		getGates: () => [],
		getConfigItems: () => config,
		getSessionMetadata: () => ({}),
		getStats: () => ({}),
		getBranchCandidates: () => [],
		getLastAssistant: () => ({}),
		getCapabilities: () => ({}),
		getAuthProviders: () => [],
		getTools: () => [],
		getQueueMessages: () => queue,
		getExtensions: () => [],
		getArtifact: () => undefined,
		getJobs: () => [],
	};
}

describe("SDK query mutation continuity", () => {
	it("keeps queue and config revisions after mutation", async () => {
		const queue = [
			{ id: "a", text: text(140_000) },
			{ id: "b", text: text(140_000) },
		];
		const config = [
			{ id: "a", value: text(140_000) },
			{ id: "b", value: text(140_000) },
		];
		const store = new RevisionStore("s");
		const handlers = new QueryHandlers(surface(queue, config), "s", store, new CursorRegistry("t", store));
		const queueFirst = await handlers.dispatch({ query: "Q21", connectionId: "c" });
		const configFirst = await handlers.dispatch({ query: "Q13", connectionId: "c" });
		queue[1] = { id: "b", text: "changed" };
		config[1] = { id: "b", value: "changed" };
		const queueNext = await handlers.dispatch({
			query: "Q21",
			cursor: queueFirst.page?.continuationCursor,
			connectionId: "c",
		});
		const configNext = await handlers.dispatch({
			query: "Q13",
			cursor: configFirst.page?.continuationCursor,
			connectionId: "c",
		});
		expect((queueNext.page?.items[0] as { text: string }).text).toContain("x");
		expect((configNext.page?.items[0] as { value: string }).value).toContain("x");
	});

	it("refuses new cursors at capacity without disturbing active snapshots and expires deterministically", async () => {
		let now = 0;
		const store = new RevisionStore("s", () => now);
		await store.createRevision("r", "id", [1, 2]);
		const registry = new CursorRegistry("t", store, () => now);
		const envelope = {
			cursorVersion: 1 as const,
			protocolMajor: 3 as const,
			sessionId: "s",
			resource: "r",
			revision: "1",
			position: { offset: 1 },
			direction: "forward",
			pageShape: {},
		};
		const context = { sessionId: "s", resource: "r", resourceId: "id", direction: "forward", pageShape: {} };
		const first = await registry.grant("c", envelope, "r", "id");
		for (let i = 1; i < MAX_CURSORS_PER_CONNECTION; i++)
			await registry.grant("c", { ...envelope, position: { offset: i + 1 } }, "r", "id");
		await expect(registry.grant("c", { ...envelope, position: { offset: 99 } }, "r", "id")).rejects.toThrow(
			"snapshot_capacity_exceeded",
		);
		expect(registry.consume(first, "c", context).revision).toBe("1");
		now += CURSOR_TTL_MS + 1;
		expect(() => registry.consume(first, "c", context)).toThrow("cursor_expired");
	});

	it("spills a single over-memory revision and reads it through a generic continuation", async () => {
		const store = new RevisionStore("s");
		const value = { body: text(17 * 1024 * 1024) };
		const revision = await store.createRevision("large", "id", value);
		expect(store.memoryBytes).toBe(0);
		expect(((await store.readRevision("large", "id", revision)) as { body: string }).body.length).toBe(
			value.body.length,
		);
		await store.close();
	});

	it("releases every pinned cursor on terminal registry close", async () => {
		const store = new RevisionStore("s");
		const revision = await store.createRevision("r", "id", [1, 2]);
		const registry = new CursorRegistry("t", store);
		const envelope = {
			cursorVersion: 1 as const,
			protocolMajor: 3 as const,
			sessionId: "s",
			resource: "r",
			revision,
			position: { offset: 1 },
			direction: "forward" as const,
			pageShape: {},
		};
		await registry.grant("c", envelope, "r", "id");
		expect(store.pinnedCount).toBe(1);
		registry.close();
		expect(registry.size).toBe(0);
		expect(store.pinnedCount).toBe(0);
		await store.close();
	});

	it("retains shared chunks through eviction and only publishes complete manifests", async () => {
		let now = 0;
		const stateRoot = await mkdtemp(join(tmpdir(), "gjc-sdk-query-test-"));
		const objects = join(stateRoot, "sdk", "snapshots", "s", "objects");
		const manifests = join(stateRoot, "sdk", "snapshots", "s", "manifests");
		const value = { body: text(17 * 1024 * 1024) };
		const store = new RevisionStore("s", () => now, { storageDir: stateRoot });
		const first = await store.createRevision("large", "one", value);
		for (const manifest of await readdir(manifests)) {
			const listed = JSON.parse(await readFile(join(manifests, manifest), "utf8")) as { chunks: { hash: string }[] };
			for (const chunk of listed.chunks) await expect(stat(join(objects, chunk.hash))).resolves.toBeDefined();
		}
		now = 1;
		const second = await store.createRevision("large", "two", value);
		for (const manifest of await readdir(manifests)) {
			const listed = JSON.parse(await readFile(join(manifests, manifest), "utf8")) as { chunks: { hash: string }[] };
			for (const chunk of listed.chunks) await expect(stat(join(objects, chunk.hash))).resolves.toBeDefined();
		}
		now += 16 * 60 * 1000;
		await store.readRevision("large", "two", second);
		store.sweep();
		await Bun.sleep(10);
		expect(await store.readRevision("large", "one", first)).toBeUndefined();
		expect(((await store.readRevision("large", "two", second)) as { body: string }).body.length).toBe(
			value.body.length,
		);
		expect((await readdir(objects)).length).toBeGreaterThan(0);
		await store.close();
	});

	it("reports missing body fields as resource_gone", async () => {
		const store = new RevisionStore("s");
		const handlers = new QueryHandlers(surface([], []), "s", store, new CursorRegistry("t", store));
		expect(
			(await handlers.dispatch({ query: "Q02", input: { entryId: "missing" }, connectionId: "c" })).error?.code,
		).toBe("resource_gone");
		expect(
			(
				await handlers.dispatch({
					query: "Q23",
					input: { resourceKind: "missing", revision: "1" },
					connectionId: "c",
				})
			).error?.code,
		).toBe("resource_gone");
	});

	it("preserves typed surface errors and converts unexpected failures to internal", async () => {
		const store = new RevisionStore("s");
		const busy = Object.assign(new Error("try later"), { code: "busy" });
		const handlers = new QueryHandlers(
			{
				...surface([], []),
				getUsage: () => {
					throw busy;
				},
				getModels: () => {
					throw new Error("surface exploded");
				},
			},
			"s",
			store,
			new CursorRegistry("t", store),
		);
		const typed = await handlers.dispatch({ query: "Q09", connectionId: "c" });
		const unexpected = await handlers.dispatch({ query: "Q10", connectionId: "c" });
		expect(typed.error).toEqual({ code: "busy", message: "try later" });
		expect(unexpected.error).toEqual({ code: "internal", message: "surface exploded" });
	});
});
