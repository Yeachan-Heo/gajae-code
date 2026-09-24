import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	beginTaskDecision,
	exportTaskDecisionEvents,
	hashTaskDecisionValue,
	streamTaskDecisionEvents,
} from "../src/task/decision-collection";

const input = {
	role: "worker",
	taskId: "task-1",
	sessionIdHash: "session-hash",
	runMode: "initial",
	requestedTier: "balanced",
	requestedSelectors: ["model-a"],
	requestedEffort: "medium",
	repoCwdHash: hashTaskDecisionValue("/repo"),
	assignmentHash: hashTaskDecisionValue("secret assignment"),
	contextHash: hashTaskDecisionValue("secret context"),
	assignment: "secret assignment",
	context: "secret context",
};

const roots: string[] = [];
async function createRoot(): Promise<string> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "task-decisions-"));
	roots.push(root);
	return root;
}
afterEach(async () => {
	for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});

test("collection disabled performs no IO", async () => {
	const root = path.join(await createRoot(), "nested");
	await expect(beginTaskDecision(input, { rootDir: root, mode: "off" })).resolves.toBeUndefined();
	await expect(fs.lstat(root)).rejects.toMatchObject({ code: "ENOENT" });
});

describe("task decision collection", () => {
	test("stores ordered events and filters content on export", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "task-decisions-"));
		const recorder = await beginTaskDecision(input, { rootDir: root, mode: "content" });
		expect(recorder).toBeDefined();
		await recorder?.recordModel({ actualModel: "model-a", effectiveEffort: "low" });
		await recorder?.finish({ status: "completed", exitCode: 0, durationMs: 12 });
		const metadata = await exportTaskDecisionEvents({ rootDir: root });
		expect(metadata).toHaveLength(3);
		expect(metadata[0]?.assignment).toBeUndefined();
		expect(metadata.map(event => event.sequence)).toEqual([0, 1, 2]);
		const content = await exportTaskDecisionEvents({ rootDir: root, includeContent: true });
		expect(content[0]?.assignment).toBe("secret assignment");
		await fs.rm(root, { recursive: true, force: true });
	});

	test("reopen preserves installation id and unfinished decisions export", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "task-decisions-"));
		const first = await beginTaskDecision(input, { rootDir: root, mode: "metadata" });
		await first?.finish({ status: "cancelled" });
		const second = await beginTaskDecision({ ...input, decisionId: "fixed" }, { rootDir: root, mode: "metadata" });
		const events = await exportTaskDecisionEvents({ rootDir: root });
		expect(events).toHaveLength(3);
		expect(events[0]?.installation_id).toBe(events[2]?.installation_id);
		expect(events[0]?.decision_id).not.toBe(events[2]?.decision_id);
		expect(events[2]?.event_type).toBe("begin");
		expect(events[2]?.assignment).toBeUndefined();
		await second?.finish({ status: "completed" });
		await fs.rm(root, { recursive: true, force: true });
	});

	test("corrupt schema fails export without creating database", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "task-decisions-"));
		const dbPath = path.join(root, "task-decisions.db");
		const db = new Database(dbPath);
		db.run("CREATE TABLE collection_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
		db.run("INSERT INTO collection_meta VALUES ('schema_version', '99')");
		db.close();
		await expect(exportTaskDecisionEvents({ rootDir: root })).rejects.toThrow();
		await fs.rm(root, { recursive: true, force: true });
	});

	test("concurrent distinct decision writers retain all events", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "task-decisions-"));
		const recorders = await Promise.all(
			["a", "b", "c"].map(taskId => beginTaskDecision({ ...input, taskId }, { rootDir: root, mode: "metadata" })),
		);
		await Promise.all(recorders.map(recorder => recorder?.finish({ status: "completed" })));
		expect(await exportTaskDecisionEvents({ rootDir: root })).toHaveLength(6);
		await fs.rm(root, { recursive: true, force: true });
	});

	test("metadata never persists content even in an explicit content export", async () => {
		const root = await createRoot();
		const recorder = await beginTaskDecision(input, { rootDir: root, mode: "metadata" });
		await recorder?.finish({ status: "paused" });
		const events = await exportTaskDecisionEvents({ rootDir: root, includeContent: true });
		expect(events).toHaveLength(2);
		expect(JSON.stringify(events)).not.toContain("secret assignment");
		expect(JSON.stringify(events)).not.toContain("secret context");
		expect(events[0]?.schema_version).toBe(1);
		expect(events[1]?.status).toBe("paused");
		if (process.platform !== "win32") {
			expect((await fs.stat(root)).mode & 0o777).toBe(0o700);
			expect((await fs.stat(path.join(root, "task-decisions.db"))).mode & 0o777).toBe(0o600);
		}
	});

	test("bounds content and ignores duplicate finish or models after finish", async () => {
		const root = await createRoot();
		const recorder = await beginTaskDecision(
			{ ...input, assignment: "x".repeat(5000) },
			{ rootDir: root, mode: "content" },
		);
		await recorder?.finish({ status: "completed" });
		await recorder?.finish({ status: "error" });
		await recorder?.recordModel({ actualModel: "not-executed" });
		const events = await exportTaskDecisionEvents({ rootDir: root, includeContent: true });
		expect(events).toHaveLength(2);
		expect(events[0]?.assignment).toBe("x".repeat(4096));
		expect(events[0]?.assignment_truncated).toBe(true);
		expect(events[1]?.status).toBe("completed");
	});

	test("records validated decisions before and after finish with authoritative late flag", async () => {
		const root = await createRoot();
		const recorder = await beginTaskDecision(
			{ ...input, decisionId: "11111111-1111-4111-8111-111111111111" },
			{ rootDir: root, mode: "metadata" },
		);
		const observation = {
			observation_id: "22222222-2222-4222-8222-222222222222",
			provider: "kev" as const,
			mode: "shadow" as const,
			requested_model: "model-a",
			candidate_tiers: ["fast", "balanced"] as const,
			recommended_tier: "balanced" as const,
			probabilities: { fast: 0.2, balanced: 0.8 },
			confidence: 0.8,
			latency_ms: 12,
			snapshot_hash: hashTaskDecisionValue("snapshot"),
		};
		await recorder?.recordDecision(observation);
		await recorder?.finish({ status: "completed" });
		await recorder?.recordDecision({ ...observation, observation_id: "33333333-3333-4333-8333-333333333333" });
		await Promise.all([recorder?.recordDecision(observation), recorder?.recordDecision(observation)]);
		const events = await exportTaskDecisionEvents({ rootDir: root });
		expect(events.map(event => event.event_type)).toEqual(["begin", "decision", "outcome", "decision"]);
		expect(events.filter(event => event.event_type === "decision")).toHaveLength(2);
		expect(events.find(event => event.observation_id === observation.observation_id)?.late).toBe(false);
		expect(events.find(event => event.observation_id === observation.observation_id)?.decision_mode).toBe("shadow");
		expect(events.find(event => event.observation_id === observation.observation_id)?.mode).toBe("metadata");
		expect(events.find(event => event.observation_id === "33333333-3333-4333-8333-333333333333")?.late).toBe(true);
		expect(events.find(event => event.event_type === "outcome")?.status).toBe("completed");
	});

	test("invalid decision probabilities fail open and corrupt decision exports are rejected", async () => {
		const root = await createRoot();
		const recorder = await beginTaskDecision(
			{ ...input, decisionId: "44444444-4444-4444-8444-444444444444" },
			{ rootDir: root, mode: "metadata" },
		);
		await recorder?.recordDecision({
			observation_id: "55555555-5555-4555-8555-555555555555",
			provider: "jev",
			mode: "routing",
			requested_model: "model-a",
			candidate_tiers: ["fast", "balanced"],
			recommended_tier: "balanced",
			probabilities: { fast: 1, balanced: 1 },
			latency_ms: 1,
		});
		await recorder?.finish({ status: "completed" });
		expect((await exportTaskDecisionEvents({ rootDir: root })).map(event => event.event_type)).toEqual([
			"begin",
			"outcome",
		]);
		const db = new Database(path.join(root, "task-decisions.db"));
		db.run("UPDATE events SET event_type = 'decision', payload_json = ? WHERE event_type = 'outcome'", [
			'{"observation_id":"malformed"}',
		]);
		db.close();
		await expect(exportTaskDecisionEvents({ rootDir: root })).rejects.toThrow();
	});

	test("late observations never recreate a removed store", async () => {
		const root = await createRoot();
		const recorder = await beginTaskDecision(input, { rootDir: root, mode: "metadata" });
		expect(recorder).toBeDefined();
		await recorder?.finish({ status: "completed" });
		await fs.rm(root, { recursive: true });
		await recorder?.recordDecision({
			observation_id: crypto.randomUUID(),
			provider: "kev",
			mode: "shadow",
			requested_model: "kev-latest",
			candidate_tiers: ["fast"],
			recommended_tier: "fast",
			probabilities: { fast: 1 },
			confidence: 1,
			latency_ms: 1,
		});
		await expect(fs.lstat(root)).rejects.toMatchObject({ code: "ENOENT" });
	});

	test("late observations cannot cross into a replacement installation with the same decision ID", async () => {
		const root = await createRoot();
		const replacement = await createRoot();
		const begin = { ...input, decisionId: crypto.randomUUID() };
		const first = await beginTaskDecision(begin, { rootDir: root, mode: "metadata" });
		const second = await beginTaskDecision(begin, { rootDir: replacement, mode: "metadata" });
		expect(first).toBeDefined();
		expect(second).toBeDefined();
		await first?.finish({ status: "completed" });
		await second?.finish({ status: "error" });
		const originalEvents = await exportTaskDecisionEvents({ rootDir: root });
		const replacementEvents = await exportTaskDecisionEvents({ rootDir: replacement });
		expect(originalEvents[0]?.installation_id).not.toBe(replacementEvents[0]?.installation_id);
		const retired = `${root}-retired`;
		roots.push(retired);
		await fs.rename(root, retired);
		await fs.rename(replacement, root);
		expect(await exportTaskDecisionEvents({ rootDir: root })).toEqual(replacementEvents);
		await first?.recordDecision({
			observation_id: crypto.randomUUID(),
			provider: "kev",
			mode: "shadow",
			requested_model: "kev-latest",
			candidate_tiers: ["fast"],
			recommended_tier: "fast",
			probabilities: { fast: 1 },
			confidence: 1,
			latency_ms: 1,
		});
		expect(await exportTaskDecisionEvents({ rootDir: root })).toEqual(replacementEvents);
	});

	test("rejects database symlinks without changing the target", async () => {
		const root = await createRoot();
		const target = path.join(root, "foreign");
		await Bun.write(target, "untouched");
		await fs.symlink(target, path.join(root, "task-decisions.db"));
		expect(await beginTaskDecision(input, { rootDir: root, mode: "metadata" })).toBeUndefined();
		await expect(exportTaskDecisionEvents({ rootDir: root })).rejects.toThrow("unsafe database");
		expect(await Bun.file(target).text()).toBe("untouched");
	});

	test("rejects invalid payloads instead of producing a misleading export", async () => {
		const root = await createRoot();
		const recorder = await beginTaskDecision(input, { rootDir: root, mode: "metadata" });
		await recorder?.finish({ status: "completed" });
		const db = new Database(path.join(root, "task-decisions.db"));
		try {
			db.run("UPDATE events SET payload_json = ? WHERE event_type = 'outcome'", ['{"status":"invented"}']);
		} finally {
			db.close();
		}
		await expect(exportTaskDecisionEvents({ rootDir: root })).rejects.toThrow();
	});

	test("retention prunes by age on the next append", async () => {
		const root = await createRoot();
		const recorder = await beginTaskDecision(input, { rootDir: root, mode: "metadata", retentionDays: 1 });
		await recorder?.finish({ status: "completed" });
		// Age the existing rows past the window without touching the writer.
		const aged = new Database(path.join(root, "task-decisions.db"));
		try {
			aged.run("UPDATE events SET created_at_ms = ?", [Date.now() - 3 * 86_400_000]);
		} finally {
			aged.close();
		}
		const second = await beginTaskDecision(
			{ ...input, taskId: "task-2" },
			{ rootDir: root, mode: "metadata", retentionDays: 1 },
		);
		await second?.finish({ status: "completed" });
		const events = await exportTaskDecisionEvents({ rootDir: root });
		expect(events.map(event => event.task_id ?? event.status)).toEqual(["task-2", "completed"]);
	});

	test("retention drops whole decisions, never leaving a partial one", async () => {
		const root = await createRoot();
		const store = { rootDir: root, mode: "metadata" as const, maxEvents: 4 };
		for (let index = 0; index < 4; index++) {
			const recorder = await beginTaskDecision({ ...input, taskId: `task-${index}` }, store);
			await recorder?.recordModel({ actualModel: `model-${index}` });
			await recorder?.finish({ status: "completed" });
		}
		// Twelve events were written; the bound is four, applied on every append.
		const events = await exportTaskDecisionEvents({ rootDir: root });
		expect(events.length).toBeLessThanOrEqual(4);
		expect(events.length).toBeGreaterThan(0);
		// Every surviving decision is complete: a `model` or `outcome` without its
		// `begin` would be a record of a task nobody can interpret.
		const groups = new Map<string, string[]>();
		for (const event of events) {
			groups.set(event.decision_id, [...(groups.get(event.decision_id) ?? []), String(event.event_type)]);
		}
		for (const types of groups.values()) expect(types).toEqual(["begin", "model", "outcome"]);
		expect(JSON.stringify(events)).not.toContain("model-0");
	});

	test("a decision still being written survives the retention boundary intact", async () => {
		const root = await createRoot();
		const store = { rootDir: root, mode: "metadata" as const, maxEvents: 3 };
		const active = await beginTaskDecision(
			{ ...input, taskId: "active", decisionId: "44444444-4444-4444-8444-444444444444" },
			store,
		);
		expect(active).toBeDefined();
		// Other decisions push the store well past the bound while `active` is open.
		for (let index = 0; index < 4; index++) {
			const other = await beginTaskDecision({ ...input, taskId: `filler-${index}` }, store);
			await other?.finish({ status: "completed" });
		}
		await active?.recordModel({ actualModel: "active-model" });
		await active?.finish({ status: "completed" });
		await active?.recordDecision({
			observation_id: "55555555-5555-4555-8555-555555555555",
			provider: "kev",
			mode: "shadow",
			requested_model: "kev-latest",
			candidate_tiers: ["fast"],
			recommended_tier: "fast",
			probabilities: { fast: 1 },
			confidence: 1,
			latency_ms: 5,
		});
		const events = await exportTaskDecisionEvents({ rootDir: root });
		const mine = events.filter(event => event.decision_id === "44444444-4444-4444-8444-444444444444");
		expect(mine.map(event => event.event_type)).toEqual(["begin", "model", "outcome", "decision"]);
	});

	test("an export is a snapshot: pruning between pages cannot truncate it", async () => {
		const root = await createRoot();
		const store = { rootDir: root, mode: "metadata" as const };
		for (let index = 0; index < 4; index++) {
			const recorder = await beginTaskDecision({ ...input, taskId: `seed-${index}` }, store);
			await recorder?.finish({ status: "completed" });
		}
		const before = await exportTaskDecisionEvents({ rootDir: root });
		expect(before).toHaveLength(8);

		const seen: string[] = [];
		const stream = streamTaskDecisionEvents({ rootDir: root, pageSize: 2 });
		// Consume the first page only, then let a writer prune rows this stream has
		// not read yet. The snapshot must still deliver the store as it was.
		seen.push(String((await stream.next()).value?.event_id));
		seen.push(String((await stream.next()).value?.event_id));
		const pruner = await beginTaskDecision({ ...input, taskId: "pruner" }, { ...store, maxEvents: 2 });
		await pruner?.finish({ status: "completed" });
		for await (const event of stream) seen.push(String(event.event_id));

		expect(seen).toEqual(before.map(event => String(event.event_id)));
		expect((await exportTaskDecisionEvents({ rootDir: root })).length).toBeLessThan(before.length);
	});

	test("export pages through a store larger than one page, in order and without gaps", async () => {
		const root = await createRoot();
		const store = { rootDir: root, mode: "metadata" as const };
		for (let index = 0; index < 5; index++) {
			const recorder = await beginTaskDecision({ ...input, taskId: `task-${index}` }, store);
			await recorder?.recordModel({ actualModel: `model-${index}` });
			await recorder?.finish({ status: "completed" });
		}
		const whole = await exportTaskDecisionEvents({ rootDir: root });
		expect(whole).toHaveLength(15);
		// Two rows per query: boundaries must neither drop nor repeat a row.
		const paged = await exportTaskDecisionEvents({ rootDir: root, pageSize: 2 });
		expect(paged.map(event => event.event_id)).toEqual(whole.map(event => event.event_id));
		expect(new Set(paged.map(event => event.event_id)).size).toBe(15);
		// Partial consumption is the point of streaming: stopping early is allowed.
		const firstThree: string[] = [];
		for await (const event of streamTaskDecisionEvents({ rootDir: root, pageSize: 2 })) {
			firstThree.push(String(event.event_id));
			if (firstThree.length === 3) break;
		}
		expect(firstThree).toEqual(whole.slice(0, 3).map(event => String(event.event_id)));
	});

	test("exporting an absent store does not create it", async () => {
		const root = path.join(await createRoot(), "absent");
		expect(await exportTaskDecisionEvents({ rootDir: root })).toEqual([]);
		await expect(fs.lstat(root)).rejects.toMatchObject({ code: "ENOENT" });
	});
});
