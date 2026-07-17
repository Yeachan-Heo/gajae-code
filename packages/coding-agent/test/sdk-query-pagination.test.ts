import { describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, readdir, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BrokerWorkflowGateEmitter, FileGateStore } from "../src/modes/shared/agent-wire/workflow-gate-broker";
import { CursorRegistry, cursorMac, QueryHandlers, RevisionStore } from "../src/sdk/host/query/index.js";
import { Q10ThinkingMetadataError } from "../src/sdk/models.js";

const huge = (value: string) => `${value}${"x".repeat(140_000)}`;
function surface(transcript: unknown[] = []) {
	return {
		getTranscriptEntries: () => transcript,
		getContextSnapshot: () => ({}),
		getGoalState: () => [],
		getTodoState: () => [],
		getDiff: () => [],
		getUsage: () => ({}),
		getModels: () => [],
		getSkillState: () => [],
		getGates: () => [],
		getConfigItems: () => [],
		getSessionMetadata: () => ({}),
		getStats: () => ({}),
		getBranchCandidates: () => [],
		getLastAssistant: () => ({}),
		getCapabilities: () => ({}),
		getAuthProviders: () => [],
		getTools: () => [],
		getQueueMessages: () => [],
		getExtensions: () => [],
		getArtifact: () => undefined,
		getJobs: () => [],
	};
}

function handlers(transcript: unknown[]) {
	const store = new RevisionStore("s1");
	const cursors = new CursorRegistry("token", store);
	return { store, cursors, handlers: new QueryHandlers(surface(transcript), "s1", store, cursors) };
}

describe("SDK query pagination", () => {
	it("keeps transcript pages to their first stable prefix while entries append", async () => {
		const transcript = [
			{ id: "one", body: huge("one") },
			{ id: "two", body: huge("two") },
			{ id: "three", body: huge("three") },
		];
		const query = handlers(transcript);
		const first = await query.handlers.dispatch({ query: "Q01", connectionId: "c" });
		expect(first.page?.complete).toBe(false);
		transcript.push({ id: "four", body: huge("four") });
		const second = await query.handlers.dispatch({
			query: "Q01",
			cursor: first.page?.continuationCursor,
			connectionId: "c",
		});
		const ids = [...(first.page?.items ?? []), ...(second.page?.items ?? [])].map(
			item => (item as { id: string }).id,
		);
		expect(ids).not.toContain("four");
	});

	it("uses Rust-compatible sorted canonical JSON and rejects tampered cursors", async () => {
		const envelope = {
			cursorVersion: 1 as const,
			protocolMajor: 3 as const,
			sessionId: "s1",
			resource: "transcript",
			revision: "r1",
			highWatermark: 12,
			position: { offset: 4 },
			direction: "forward",
			pageShape: { limit: 10 },
		};
		expect(cursorMac(envelope, "session-token")).toBe(
			"4b4d7428b20b857fad243e40105cec6f11a1299fcf526fd7f2718fd77b8c86fa",
		);
		const store = new RevisionStore("s1");
		await store.createRevision("x", "y", []);
		const registry = new CursorRegistry("token", store);
		const cursor = await registry.grant("c", { ...envelope, resource: "x", revision: "1" }, "x", "y");
		expect(() =>
			registry.consume(cursor.replace('"x"', '"z"'), "c", {
				sessionId: "s1",
				resource: "x",
				resourceId: "y",
				direction: "forward",
				pageShape: { limit: 10 },
			}),
		).toThrow("invalid_cursor");
	});

	it("rejects a continuation reused for a different query", async () => {
		const query = handlers([
			{ id: "one", body: huge("one") },
			{ id: "two", body: huge("two") },
		]);
		const first = await query.handlers.dispatch({ query: "Q01", connectionId: "c" });
		const reused = await query.handlers.dispatch({
			query: "Q21",
			cursor: first.page?.continuationCursor,
			connectionId: "c",
		});
		expect(reused.error?.code).toBe("invalid_input");
	});

	it("routes Q10 and every models alias through the same installed paged registry", async () => {
		const models = [
			{ provider: "one", id: "one", name: huge("one") },
			{ provider: "two", id: "two", name: huge("two") },
			{ provider: "three", id: "three", name: huge("three") },
		];
		const store = new RevisionStore("s1");
		const cursors = new CursorRegistry("token", store);
		const query = new QueryHandlers(
			{ ...surface(), getModels: () => models, installedQueries: new Set(["models.list/current"]) },
			"s1",
			store,
			cursors,
		);

		const first = await query.dispatch({ query: "models.list", input: { current: true }, connectionId: "c" });
		expect(first.page?.items.map(item => (item as { id: string }).id)).toEqual(["one"]);
		expect(first.page?.complete).toBe(false);
		const second = await query.dispatch({
			query: "models.current",
			cursor: first.page?.continuationCursor,
			connectionId: "c",
		});
		expect(second.page?.items.map(item => (item as { id: string }).id)).toEqual(["two"]);
		const third = await query.dispatch({
			query: "models.list/current",
			cursor: second.page?.continuationCursor,
			connectionId: "c",
		});
		expect(third.page?.items.map(item => (item as { id: string }).id)).toEqual(["three"]);
		expect(third.page?.complete).toBe(true);

		const raw = await query.dispatch({ query: "Q10", connectionId: "c" });
		expect(raw.page?.items.map(item => (item as { id: string }).id)).toEqual(["one"]);
	});

	it("returns safe Q10 projection failures through the query envelope", async () => {
		const store = new RevisionStore("s1");
		const query = new QueryHandlers(
			{
				...surface(),
				getModels: () => {
					throw new Q10ThinkingMetadataError("private-provider", "private-model", "missing_thinking");
				},
			},
			"s1",
			store,
			new CursorRegistry("token", store),
		);
		const response = await query.dispatch({ query: "models.current", connectionId: "c" });
		expect(response.error).toEqual({
			code: "internal",
			message: "Invalid thinking metadata for private-provider/private-model: missing_thinking",
		});
	});

	it("rotates pins so sequential completed walks do not exhaust one connection", async () => {
		const query = handlers([
			{ id: "one", body: huge("one") },
			{ id: "two", body: huge("two") },
		]);
		for (let index = 0; index < 40; index++) {
			const first = await query.handlers.dispatch({ query: "Q01", connectionId: "c" });
			const complete = await query.handlers.dispatch({
				query: "Q01",
				cursor: first.page?.continuationCursor,
				connectionId: "c",
			});
			expect(complete.page?.complete).toBe(true);
		}
		expect(query.cursors.size).toBe(0);
	}, 30000);

	it("writes owner-private chunked spills atomically with bounded buffering", async () => {
		const stateRoot = await mkdtemp(join(tmpdir(), "gjc-sdk-query-test-"));
		const snapshotDir = join(stateRoot, "sdk", "snapshots", "s1");
		const store = new RevisionStore("s1", Date.now, { storageDir: stateRoot });
		const value = { body: "x".repeat(40 * 1024 * 1024) };
		const revision = await store.createRevision("large", "id", value);
		const objects = join(snapshotDir, "objects");
		const manifests = join(snapshotDir, "manifests");
		const files = await readdir(objects);
		expect(files.length).toBeGreaterThan(1);
		for (const file of files) expect((await stat(join(objects, file))).size).toBeLessThanOrEqual(4 * 1024 * 1024);
		const manifest = JSON.parse(
			await readFile(
				join(manifests, `${createHash("sha256").update(JSON.stringify(value)).digest("hex")}.json`),
				"utf8",
			),
		) as { chunks: { hash: string; length: number }[] };
		expect(new Set(manifest.chunks.map(chunk => chunk.hash))).toEqual(new Set(files));
		expect(manifest.chunks.every(chunk => chunk.length <= 4 * 1024 * 1024)).toBe(true);
		expect(store.peakBufferedBytes).toBeLessThanOrEqual(8 * 1024 * 1024);
		for (const entry of manifest.chunks) await expect(stat(join(objects, entry.hash))).resolves.toBeDefined();
		const page = await store.readStringRange("large", "id", revision, "body", 8 * 1024 * 1024, 256 * 1024);
		expect(page).toMatchObject({ body: "x".repeat(256 * 1024), complete: false });
		expect(store.peakReadBufferedBytes).toBeLessThanOrEqual(5 * 1024 * 1024);
		if (process.platform !== "win32") {
			expect((await stat(snapshotDir)).mode & 0o777).toBe(0o700);
			expect((await stat(join(objects, files[0]!))).mode & 0o777).toBe(0o600);
		}
		await store.close();
	});

	it("settles in-progress spill writes before terminal cleanup", async () => {
		for (let index = 0; index < 3; index++) {
			const stateRoot = await mkdtemp(join(tmpdir(), "gjc-sdk-query-close-race-"));
			const store = new RevisionStore(`close-race-${index}`, Date.now, { storageDir: stateRoot });
			const write = store.createRevision("large", "id", { body: "x".repeat(8 * 1024 * 1024) });
			const close = store.close();
			await expect(write).resolves.toBe("1");
			await expect(close).resolves.toBeUndefined();
		}
	});

	it("splits large CJK and emoji snapshots at UTF-8 boundaries", async () => {
		const stateRoot = await mkdtemp(join(tmpdir(), "gjc-sdk-query-test-"));
		const snapshotDir = join(stateRoot, "sdk", "snapshots", "s1");
		const body = "漢🙂".repeat(3 * 1024 * 1024);
		const store = new RevisionStore("s1", Date.now, { storageDir: stateRoot });
		const revision = await store.createRevision("large", "multibyte", { body });
		const files = await readdir(join(snapshotDir, "objects"));
		expect(files.length).toBeGreaterThan(1);
		for (const file of files) {
			const chunk = await readFile(join(snapshotDir, "objects", file));
			expect(chunk.length).toBeLessThanOrEqual(4 * 1024 * 1024);
			expect(Buffer.from(chunk.toString("utf8"))).toEqual(chunk);
		}
		expect((await store.readRevision("large", "multibyte", revision)) as { body: string }).toEqual({ body });
		expect(store.peakBufferedBytes).toBeLessThanOrEqual(8 * 1024 * 1024);
		await store.close();
	});

	it("reads a 40 MiB transcript body page from its indexed manifest range", async () => {
		const stateRoot = await mkdtemp(join(tmpdir(), "gjc-sdk-query-test-"));
		const body = "t".repeat(40 * 1024 * 1024);
		const store = new RevisionStore("s1", Date.now, { storageDir: stateRoot });
		const cursors = new CursorRegistry("token", store);
		const query = new QueryHandlers(surface([{ id: "target", body }]), "s1", store, cursors);
		const first = await query.dispatch({ query: "Q02", input: { entryId: "target" }, connectionId: "c" });
		expect(first.page?.items[0]).toMatchObject({
			entryId: "target",
			byteOffset: 0,
			body: "t".repeat(256 * 1024),
			complete: false,
		});
		expect(store.peakReadBufferedBytes).toBeLessThanOrEqual(5 * 1024 * 1024);
		const second = await query.dispatch({ query: "Q02", cursor: first.page?.continuationCursor, connectionId: "c" });
		expect(second.page?.items[0]).toMatchObject({
			entryId: "target",
			byteOffset: 256 * 1024,
			body: "t".repeat(256 * 1024),
			complete: false,
		});
		expect(store.peakReadBufferedBytes).toBeLessThanOrEqual(5 * 1024 * 1024);
		await store.close();
	});

	it("binds transcript continuations to the cursor entry selector", async () => {
		const query = handlers([
			{ id: "one", body: "one".repeat(100_000) },
			{ id: "two", body: "two".repeat(100_000) },
		]);
		const mismatchCursor = (
			await query.handlers.dispatch({ query: "Q02", input: { entryId: "one" }, connectionId: "c" })
		).page?.continuationCursor;
		const mismatch = await query.handlers.dispatch({
			query: "Q02",
			input: { entryId: "two" },
			cursor: mismatchCursor,
			connectionId: "c",
		});
		expect(mismatch.error).toMatchObject({ code: "invalid_input", message: "cursor does not match query" });
		const first = await query.handlers.dispatch({ query: "Q02", input: { entryId: "one" }, connectionId: "c" });
		const continued = await query.handlers.dispatch({
			query: "Q02",
			cursor: first.page?.continuationCursor,
			connectionId: "c",
		});
		expect(continued.page?.items[0]).toMatchObject({ body: expect.stringContaining("one") });
	});

	it("binds resource body fields and diff query IDs to the cursor", async () => {
		const store = new RevisionStore("s1");
		const cursors = new CursorRegistry("token", store);
		const query = new QueryHandlers(surface([]), "s1", store, cursors);
		const body = "a".repeat(300_000);
		const revision = await store.createRevision("note", "one", { body, title: body.replaceAll("a", "b") });
		const first = await query.dispatch({
			query: "Q23",
			input: { resourceKind: "note", resourceId: "one", revision, field: "body" },
			connectionId: "c",
		});
		const switched = await query.dispatch({
			query: "Q23",
			input: { field: "title" },
			cursor: first.page?.continuationCursor,
			connectionId: "c",
		});
		expect(switched.error).toMatchObject({ code: "invalid_input", message: "cursor does not match query" });
		const diffSurface = { ...surface([]), getDiff: () => [huge("one"), huge("two")] };
		const diffStore = new RevisionStore("s1");
		const diffCursors = new CursorRegistry("token", diffStore);
		const diffQuery = new QueryHandlers(diffSurface, "s1", diffStore, diffCursors);
		const diffFirst = await diffQuery.dispatch({ query: "Q06", connectionId: "d" });
		const crossQuery = await diffQuery.dispatch({
			query: "Q07",
			cursor: diffFirst.page?.continuationCursor,
			connectionId: "d",
		});
		expect(crossQuery.error).toMatchObject({ code: "invalid_input", message: "cursor does not match query" });
	});
});
it("retrieves a large Q13 indexed item field by stable ID across revisions", async () => {
	const config = [{ id: "large-config", value: "é".repeat(700_000) }];
	const store = new RevisionStore("s1");
	const cursors = new CursorRegistry("token", store);
	const handlers = new QueryHandlers({ ...surface([]), getConfigItems: () => config }, "s1", store, cursors);
	const list = await handlers.dispatch({ query: "Q13", connectionId: "c" });
	const oversized = list.page?.items[0] as { continuations: { itemId: string; field: string; revision: string }[] };
	const continuation = oversized.continuations.find(item => item.field === "value")!;
	expect(continuation).toMatchObject({ itemId: "large-config", field: "value" });
	const first = await handlers.dispatch({ query: "Q23", input: continuation, connectionId: "c" });
	const second = await handlers.dispatch({ query: "Q23", cursor: first.page?.continuationCursor, connectionId: "c" });
	expect(first.page?.items[0]).toMatchObject({ byteOffset: 0, body: "é".repeat(131_072) });
	expect(second.page?.items[0]).toMatchObject({ byteOffset: 262_144 });
});

it("aligns Q23 arbitrary byte offsets past UTF-8 continuation bytes", async () => {
	const store = new RevisionStore("s1");
	const cursors = new CursorRegistry("token", store);
	const query = new QueryHandlers(surface([]), "s1", store, cursors);
	const revision = await store.createRevision("note", "multibyte", { body: "aé🙂z" });
	const insideTwoByte = await query.dispatch({
		query: "Q23",
		input: { resourceKind: "note", resourceId: "multibyte", revision, field: "body", byteOffset: 2 },
		connectionId: "c",
	});
	const insideFourByte = await query.dispatch({
		query: "Q23",
		input: { resourceKind: "note", resourceId: "multibyte", revision, field: "body", byteOffset: 4 },
		connectionId: "c",
	});
	expect(insideTwoByte.page?.items[0]).toMatchObject({ byteOffset: 3, body: "🙂z", complete: true });
	expect(insideFourByte.page?.items[0]).toMatchObject({ byteOffset: 7, body: "z", complete: true });
	expect((insideTwoByte.page?.items[0] as { body: string }).body).not.toContain("�");
	expect((insideFourByte.page?.items[0] as { body: string }).body).not.toContain("�");
	await store.close();
});

it("keeps artifact range responses below the serialized one MiB ceiling", async () => {
	const artifact = new Uint8Array(2 * 1024 * 1024).fill(7);
	let requested = 0;
	const store = new RevisionStore("s1");
	const query = new QueryHandlers(
		{
			...surface([]),
			getArtifactRange: (_id, offset, length) => {
				requested = length;
				return { bytes: artifact.subarray(offset, offset + length), totalBytes: artifact.length };
			},
		},
		"s1",
		store,
		new CursorRegistry("token", store),
	);
	const response = await query.dispatch({
		id: "large",
		query: "Q24",
		input: { artifactId: "big", length: artifact.length },
		connectionId: "c",
	});
	expect(requested).toBeLessThan(1024 * 1024);
	expect(Buffer.byteLength(JSON.stringify(response))).toBeLessThan(1024 * 1024);
	expect((response.result as { complete: boolean }).complete).toBe(false);
});
it("keeps random-sized paginated responses below the one MiB ceiling", async () => {
	for (let seed = 1; seed <= 24; seed++) {
		let state = seed;
		const next = () => {
			state = (state * 16_807) % 2_147_483_647;
			return state;
		};
		const diff = Array.from({ length: 32 }, (_, index) => ({
			id: String(index),
			body: "x".repeat(next() % 180_000),
		}));
		const store = new RevisionStore(`page-${seed}`);
		const query = new QueryHandlers(
			{ ...surface([]), getDiff: () => diff },
			`page-${seed}`,
			store,
			new CursorRegistry("token", store),
		);
		let response = await query.dispatch({ query: "Q06", connectionId: "c" });
		while (response.page) {
			expect(Buffer.byteLength(JSON.stringify(response))).toBeLessThan(1024 * 1024);
			if (response.page.complete) break;
			response = await query.dispatch({ query: "Q06", cursor: response.page.continuationCursor, connectionId: "c" });
		}
		await store.close();
	}
});

it("describes an arbitrarily large indexed item from manifest metadata before reading its body", async () => {
	const stateRoot = await mkdtemp(join(tmpdir(), "gjc-sdk-query-test-"));
	const value = "x".repeat(40 * 1024 * 1024);
	const store = new RevisionStore("s1", Date.now, { storageDir: stateRoot });
	const cursors = new CursorRegistry("token", store);
	const query = new QueryHandlers(
		{ ...surface([]), getConfigItems: () => [{ id: "huge", value }] },
		"s1",
		store,
		cursors,
	);
	const list = await query.dispatch({ query: "Q13", connectionId: "c" });
	const descriptor = list.page?.items[0] as {
		id: string;
		continuations: { field: string; itemId: string; revision: string }[];
	};
	expect(descriptor).toMatchObject({ id: "huge", error: { code: "item_too_large" } });
	expect(store.peakReadBufferedBytes).toBe(0);
	const completedList = await query.dispatch({
		query: "Q13",
		cursor: list.page?.continuationCursor,
		connectionId: "c",
	});
	expect(completedList.page).toMatchObject({ items: [], complete: true });
	const continuation = descriptor.continuations.find(item => item.field === "value")!;
	const body = await query.dispatch({ query: "Q23", input: continuation, connectionId: "c" });
	expect(body.page?.items[0]).toMatchObject({ byteOffset: 0, body: "x".repeat(256 * 1024), complete: false });
	expect(store.peakReadBufferedBytes).toBeLessThanOrEqual(5 * 1024 * 1024);
	await store.close();
});

it("streams an oversized root object as monotonic bounded canonical JSON ranges", async () => {
	const value = { body: "x".repeat(2 * 1024 * 1024), kind: "context" };
	const store = new RevisionStore("s1");
	const cursors = new CursorRegistry("token", store);
	const query = new QueryHandlers({ ...surface([]), getContextSnapshot: () => value }, "s1", store, cursors);
	let response = await query.dispatch({ query: "Q03", connectionId: "c" });
	const offsets: number[] = [];
	while (response.page) {
		const item = response.page.items[0] as { byteOffset: number; body: string; complete: boolean };
		offsets.push(item.byteOffset);
		expect(Buffer.byteLength(item.body)).toBeLessThanOrEqual(256 * 1024);
		expect(Buffer.byteLength(JSON.stringify(response))).toBeLessThan(1024 * 1024);
		if (response.page.complete) break;
		response = await query.dispatch({ query: "Q03", cursor: response.page.continuationCursor, connectionId: "c" });
	}
	expect(offsets.length).toBeGreaterThan(1);
	expect(offsets.every((offset, index) => index === 0 || offset > offsets[index - 1]!)).toBe(true);
	expect((response.page?.items[0] as { complete: boolean }).complete).toBe(true);
	await store.close();
});

it("incrementally continues very large escaped emoji fields through bounded snapshot reads", async () => {
	const stateRoot = await mkdtemp(join(tmpdir(), "gjc-sdk-query-test-"));
	const reads: { start: number; end: number }[] = [];
	const unit = `"\\${String.fromCharCode(0x08, 0x0c, 0x0a, 0x0d, 0x09, 0x00)}🙂`;
	const body = unit.repeat(750_000);
	const store = new RevisionStore("s1", Date.now, {
		storageDir: stateRoot,
		onReadRange: (start, end) => reads.push({ start, end }),
	});
	const revision = await store.createRevision("note", "escaped", { body });
	const serializedBytes = await store.revisionByteLength("note", "escaped", revision);
	if (serializedBytes === undefined) throw new Error("missing escaped revision");
	expect(serializedBytes).toBeGreaterThan(16 * 1024 * 1024);
	reads.length = 0;

	const emojiOffset = Buffer.byteLength(unit) * 125_000 + 9;
	const insideEmoji = await store.readStringRange("note", "escaped", revision, "body", emojiOffset, 256 * 1024);
	if (!insideEmoji) throw new Error("missing emoji continuation page");
	expect(insideEmoji.offset).toBe(Buffer.byteLength(unit) * 125_001);
	expect(Buffer.from(insideEmoji.body).toString("utf8")).toBe(insideEmoji.body);

	const pages: string[] = [];
	const offsets: number[] = [];
	let offset = 0;
	let complete = false;
	while (!complete) {
		const page = await store.readStringRange("note", "escaped", revision, "body", offset, 256 * 1024);
		if (!page) throw new Error("missing escaped continuation page");
		expect(page.offset).toBe(offset);
		expect(Buffer.byteLength(page.body)).toBeLessThanOrEqual(256 * 1024);
		expect(Buffer.from(page.body).toString("utf8")).toBe(page.body);
		pages.push(page.body);
		offsets.push(page.offset);
		offset += Buffer.byteLength(page.body);
		complete = page.complete;
	}
	expect(pages.join("")).toBe(body);
	expect(offsets.length).toBeGreaterThan(1);
	expect(offsets.every((pageOffset, index) => index === 0 || pageOffset > offsets[index - 1]!)).toBe(true);
	expect(reads.length).toBeGreaterThan(1);
	expect(reads.every(({ start, end }) => end - start <= 512 * 1024)).toBe(true);
	expect(reads.every(({ start, end }) => end - start < serializedBytes)).toBe(true);
	await store.close();
}, 30_000);

it("reconstructs Q12 workflow gate state after a client restart without reviving the orphaned gate", async () => {
	const stateRoot = await mkdtemp(join(tmpdir(), "gjc-sdk-q12-restart-"));
	const storePath = join(stateRoot, "workflow-gates.json");
	const first = new BrokerWorkflowGateEmitter("q12-session", new FileGateStore(storePath));
	void first.emitGate({ stage: "ralplan", kind: "approval", schema: { type: "string", enum: ["approve"] } });
	const restarted = new BrokerWorkflowGateEmitter("q12-session", new FileGateStore(storePath));
	void restarted.emitGate({
		stage: "ralplan",
		kind: "approval",
		schema: { type: "string", enum: ["approve"] },
	});
	const store = new RevisionStore("q12-session");
	const query = new QueryHandlers(
		{ ...surface([]), getGates: () => restarted.listWorkflowGateQueryRecords!() },
		"q12-session",
		store,
		new CursorRegistry("token", store),
	);
	const response = await query.dispatch({ query: "Q12", connectionId: "restarted-client" });
	if (!response.page) throw new Error("Q12 did not return a page");
	const gates = response.page.items as Array<Record<string, unknown>>;
	expect(gates).toEqual(
		expect.arrayContaining([
			expect.objectContaining({ id: expect.stringMatching(/^diagnostic:/), tag: "quarantined" }),
			expect.objectContaining({ id: expect.stringMatching(/^pending:/), tag: "pending" }),
		]),
	);
	expect(gates.filter(gate => gate.tag === "pending")).toHaveLength(1);
	expect(gates.find(gate => gate.tag === "quarantined")).toMatchObject({
		lifecycle: { reason: "orphaned_after_process_restart" },
	});
	await store.close();
});
