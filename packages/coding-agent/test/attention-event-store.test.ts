import { describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	type AttentionEventIdentity,
	AttentionEventStore,
	type AttentionObservation,
	MAX_ATTENTION_TERMINAL_HISTORY,
} from "../src/modes/attention-event-store";

async function temporaryStatePath(): Promise<{ root: string; file: string }> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-attention-store-"));
	return { root, file: path.join(root, "attention.json") };
}

function observation(overrides: Partial<AttentionObservation> = {}): AttentionObservation {
	return {
		kind: "bash",
		sourceId: "job-1",
		generation: "generation-1",
		label: "Build",
		status: "failed",
		startedAt: 100,
		...overrides,
	};
}

describe("AttentionEventStore", () => {
	test("keys observations by kind, source, and generation and deduplicates content", async () => {
		const store = new AttentionEventStore();
		await store.observe(observation());
		await store.observe(observation());
		await store.observe(observation({ kind: "subagent" }));
		await store.observe(observation({ generation: "generation-2" }));

		expect(store.getSnapshot().events).toHaveLength(3);
		expect(store.getSnapshot().events.map(event => event.revision)).toEqual([1, 1, 1]);

		await store.observe(observation({ label: "Build retry" }));
		expect(store.getSnapshot().events.find(event => event.kind === "bash")?.revision).toBe(2);
		expect(store.getSnapshot().failedUnacknowledged).toBe(true);
	});

	test("acknowledgement is revision-bound and survives restart", async () => {
		const state = await temporaryStatePath();
		try {
			const first = new AttentionEventStore({ path: state.file, rootDir: state.root, now: () => 200 });
			await first.observe(observation());
			const identity: AttentionEventIdentity = { kind: "bash", sourceId: "job-1", generation: "generation-1" };
			const revision = first.getSnapshot().events[0]?.revision;
			expect(revision).toBe(1);
			if (revision === undefined) throw new Error("missing persisted revision");
			expect((await first.acknowledgeFailures([{ ...identity, revision }])).ok).toBe(true);
			await first.flush();
			expect(first.getSnapshot().failedUnacknowledged).toBe(false);

			const restarted = new AttentionEventStore({ path: state.file, rootDir: state.root });
			expect(restarted.getSnapshot().failedUnacknowledged).toBe(false);
			await restarted.observe(observation({ status: "done" }));
			expect(restarted.getSnapshot().events[0]?.revision).toBe(2);
			await restarted.observe(observation({ status: "failed", label: "Build retry" }));
			expect(restarted.getSnapshot().failedUnacknowledged).toBe(true);
		} finally {
			await fs.rm(state.root, { recursive: true, force: true });
		}
	});

	test("fails safe on corrupt state and does not expose unsafe label content", async () => {
		const state = await temporaryStatePath();
		try {
			await fs.writeFile(state.file, "{not-json", "utf8");
			const corrupt = new AttentionEventStore({ path: state.file, rootDir: state.root });
			expect(corrupt.getSnapshot()).toMatchObject({ status: "corrupt", events: [], failedUnacknowledged: false });
			const clean = new AttentionEventStore();
			await clean.observe(
				observation({
					label: "failed /tmp/private token=super-secret",
				}),
			);
			const event = clean.getSnapshot().events[0];
			expect(event?.label).not.toContain("/tmp/private");
			expect(event?.label).not.toContain("super-secret");
		} finally {
			await fs.rm(state.root, { recursive: true, force: true });
		}
	});

	test("retains active attention and bounds acknowledged terminal history deterministically", async () => {
		const store = new AttentionEventStore({ maxTerminalHistory: MAX_ATTENTION_TERMINAL_HISTORY });
		await store.observe(observation({ sourceId: "active", status: "running", startedAt: 1 }));
		await store.observe(observation({ sourceId: "failure", status: "failed", startedAt: 2 }));
		const failureIdentity: AttentionEventIdentity = {
			kind: "bash",
			sourceId: "failure",
			generation: "generation-1",
		};
		await store.acknowledge(failureIdentity, 1);
		for (let index = 0; index < MAX_ATTENTION_TERMINAL_HISTORY + 5; index++) {
			await store.observe(observation({ sourceId: `done-${index}`, status: "done", startedAt: index + 10 }));
		}
		const snapshot = store.getSnapshot();
		expect(snapshot.events).toHaveLength(MAX_ATTENTION_TERMINAL_HISTORY + 1);
		expect(snapshot.events.some(event => event.sourceId === "active")).toBe(true);
		expect(snapshot.events.some(event => event.sourceId === "done-0")).toBe(false);
		expect(snapshot.events.some(event => event.sourceId === `done-${MAX_ATTENTION_TERMINAL_HISTORY + 4}`)).toBe(true);

		expect(Object.isFrozen(snapshot)).toBe(true);
		expect(Object.isFrozen(snapshot.events)).toBe(true);
		expect(Object.isFrozen(snapshot.events[0] ?? {})).toBe(true);
		expect(store.getSnapshot().events).toHaveLength(MAX_ATTENTION_TERMINAL_HISTORY + 1);
	});
	test("evicts terminal history when a new observation changes the store", async () => {
		const store = new AttentionEventStore({ maxTerminalHistory: 1 });
		await store.observe(observation({ sourceId: "old", status: "done", startedAt: 1, observedAt: 1 }));
		await store.observe(observation({ sourceId: "new", status: "done", startedAt: 2, observedAt: 2 }));

		expect(store.getSnapshot().events.map(event => event.sourceId)).toEqual(["new"]);
	});
	test("reports memory-only status for pathless mutations", async () => {
		const store = new AttentionEventStore();
		expect(store.getStatus()).toBe("memory_only");
		expect((await store.observe(observation())).status).toBe("memory_only");
		const identity: AttentionEventIdentity = { kind: "bash", sourceId: "job-1", generation: "generation-1" };
		expect((await store.acknowledge(identity, 1)).status).toBe("memory_only");
		expect((await store.acknowledgeFailures([])).status).toBe("memory_only");
	});

	test("validates every expected revision before batch acknowledgement", async () => {
		const store = new AttentionEventStore();
		await store.observe(observation({ sourceId: "first" }));
		await store.observe(observation({ sourceId: "second" }));
		const expected = store.getSnapshot().events.map(event => ({
			kind: event.kind,
			sourceId: event.sourceId,
			generation: event.generation,
			revision: event.revision,
		}));
		await store.observe(observation({ sourceId: "first", label: "retry" }));
		const result = await store.acknowledgeFailures(expected);
		expect(result.ok).toBe(false);
		expect(store.getSnapshot().failedUnacknowledged).toBe(true);
		expect(store.getSnapshot().events.every(event => event.acknowledgedRevision === undefined)).toBe(true);
	});

	test("rejects new identities at the total bound without evicting active attention", async () => {
		const store = new AttentionEventStore({ maxIdentities: 2 });
		await store.observe(observation({ sourceId: "active", status: "running" }));
		await store.observe(observation({ sourceId: "failure", status: "failed" }));
		const result = await store.observe(observation({ sourceId: "overflow", status: "done" }));
		expect(result).toEqual({ ok: false, status: "overflow", changed: false });
		expect(store.getSnapshot().status).toBe("overflow");
		expect(store.getSnapshot().events.map(event => event.sourceId)).toEqual(
			expect.arrayContaining(["active", "failure"]),
		);
	});
});
