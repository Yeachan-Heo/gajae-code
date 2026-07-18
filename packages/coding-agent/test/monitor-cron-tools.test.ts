import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { AgentToolContext, AgentToolResult } from "@gajae-code/agent-core";
import * as z from "zod/v4";
import { AsyncJobManager } from "../src/async/job-manager";
import { Settings } from "../src/config/settings";
import {
	CRON_RECURRING_MAX_AGE_MS,
	type CronListJobDetails,
	CronTool,
	calculateCronFireTimeMs,
	findNextCronMatchMs,
	MAX_CRON_TASKS_PER_OWNER,
	resetCronRegistryForTests,
	validateCronExpression,
} from "../src/tools/cron";
import { BUILTIN_TOOLS, type ToolSession } from "../src/tools/index";
import { MonitorTool } from "../src/tools/monitor";

interface SessionOptions {
	agentId?: string | null;
	steered?: Array<{ customType: string; content: string; details?: unknown }>;
	settings?: Settings;
}

function createSession(settings: Settings, options: SessionOptions = {}): ToolSession {
	const agentId = options.agentId ?? "0-Test";
	return {
		cwd: process.cwd(),
		hasUI: false,
		settings: options.settings ?? settings,
		getSessionFile: () => null,
		getSessionSpawns: () => null,
		getSessionId: () => "test-session",
		getAgentId: () => agentId,
		steer: (msg: { customType: string; content: string; details?: unknown }) => options.steered?.push(msg),
		sendCustomMessage: async (msg: { customType: string; content: string; details?: unknown }) => {
			options.steered?.push({ customType: msg.customType, content: msg.content, details: msg.details });
		},
		purgeQueuedCustomMessages: () => ({
			agentSteering: 0,
			agentFollowUp: 0,
			pendingNextTurn: 0,
			displaySteering: 0,
			displayFollowUp: 0,
			totalExecutable: 0,
		}),
		allocateOutputArtifact: async () => ({}),
	} as unknown as ToolSession;
}

const fixturesDir = path.resolve(import.meta.dir, "fixtures", "claude-code-tools");

async function loadFixture<T = unknown>(name: string): Promise<T> {
	const raw = await fs.readFile(path.join(fixturesDir, name), "utf8");
	return JSON.parse(raw) as T;
}

function stripJsonSchemaDialect(schema: unknown): unknown {
	if (!schema || typeof schema !== "object") return schema;
	const clone = structuredClone(schema) as Record<string, unknown>;
	delete clone.$schema;
	return clone;
}

function expectSchemaParity(toolSchema: z.ZodType, fixtureSchema: unknown): void {
	const wire = z.toJSONSchema(toolSchema);
	expect(stripJsonSchemaDialect(wire)).toEqual(fixtureSchema);
}

function expectText<T>(result: { content: ReadonlyArray<{ type: string; text?: string }>; details?: T }): {
	text: string;
	details: T;
} {
	const part = result.content[0];
	if (part?.type !== "text" || typeof part.text !== "string") {
		throw new Error("Expected the tool result to lead with a text content block");
	}
	if (result.details === undefined) {
		throw new Error("Expected tool result to include details");
	}
	return { text: part.text, details: result.details };
}

interface FakeTimer {
	id: number;
	at: number;
	callback: () => void;
	cleared: boolean;
}

async function withFakeTimers<T>(
	startMs: number,
	fn: (clock: { tick(ms: number): void; now(): number }) => T | Promise<T>,
): Promise<T> {
	const realDateNow = Date.now;
	const realSetTimeout = globalThis.setTimeout;
	const realClearTimeout = globalThis.clearTimeout;
	let now = startMs;
	let nextId = 1;
	const timers: FakeTimer[] = [];
	Date.now = () => now;
	globalThis.setTimeout = ((callback: () => void, delay?: number) => {
		const timer: FakeTimer = { id: nextId, at: now + Math.max(0, Number(delay ?? 0)), callback, cleared: false };
		nextId += 1;
		timers.push(timer);
		return timer.id as unknown as NodeJS.Timeout;
	}) as typeof setTimeout;
	globalThis.clearTimeout = ((handle?: NodeJS.Timeout) => {
		const id = Number(handle);
		for (const timer of timers) {
			if (timer.id === id) timer.cleared = true;
		}
	}) as typeof clearTimeout;
	try {
		return await fn({
			now: () => now,
			tick(ms: number) {
				const target = now + ms;
				for (;;) {
					const due = timers.filter(timer => !timer.cleared && timer.at <= target).sort((a, b) => a.at - b.at)[0];
					if (!due) break;
					now = due.at;
					due.cleared = true;
					due.callback();
				}
				now = target;
			},
		});
	} finally {
		Date.now = realDateNow;
		globalThis.setTimeout = realSetTimeout;
		globalThis.clearTimeout = realClearTimeout;
	}
}

const previousInstance = AsyncJobManager.instance();
let manager: AsyncJobManager;
let settings: Settings;

beforeEach(async () => {
	settings = await Settings.init();
	manager = new AsyncJobManager({ onJobComplete: async () => {} });
	AsyncJobManager.setInstance(manager);
	resetCronRegistryForTests();
});

afterEach(async () => {
	resetCronRegistryForTests();
	await manager.dispose({ timeoutMs: 200 });
	AsyncJobManager.setInstance(previousInstance);
});

describe("MonitorTool", () => {
	it("creates an instance only when background-job support is enabled", () => {
		const session = createSession(settings);
		const tool = MonitorTool.createIf(session);
		expect(tool).toBeInstanceOf(MonitorTool);
	});

	it("matches the upstream Monitor JSON Schema exactly", async () => {
		const session = createSession(settings);
		const tool = MonitorTool.createIf(session)!;
		const fixture = await loadFixture<{ tool_name: string; input_schema: unknown }>("monitor.schema.json");
		expect(tool.name).toBe("monitor");
		expect(fixture.tool_name).toBe("Monitor");
		expectSchemaParity(tool.parameters, fixture.input_schema);
	});

	it("routes monitor execution through BashTool policy and blocks intercepted commands", async () => {
		const interceptedSettings = Settings.isolated({ "bashInterceptor.enabled": true });
		const session = createSession(interceptedSettings, { settings: interceptedSettings });
		const tool = MonitorTool.createIf(session)!;
		await expect(
			tool.execute(
				"call",
				{ command: "cat package.json", kind: "log", description: "bad read" },
				undefined,
				undefined,
				{
					toolNames: ["read"],
				} as AgentToolContext,
			),
		).rejects.toThrow(/Use the `read` tool instead/);
	});

	it("persistent monitor coalesces duplicate executable notifications", async () => {
		const steered: Array<{ customType: string; content: string; details?: unknown }> = [];
		const session = createSession(settings, { steered });
		const tool = MonitorTool.createIf(session)!;
		const result = expectText(
			await tool.execute("call", {
				command: "for i in $(seq 1 20); do printf 'same\\n'; done",
				kind: "log",
				description: "line test",
				persistent: true,
			}),
		);
		expect(result.text).toContain("persistent: true");
		await manager.waitForAll();
		await Promise.resolve();

		expect(steered.length).toBeLessThanOrEqual(3);
		expect(steered.at(-1)?.content).toContain("same");
		const slice = manager.readOutputSince(result.details.taskId, 0, { ownerId: "0-Test" });
		expect(slice?.text.match(/same\n/g)).toHaveLength(20);
	});

	it("persistent monitor preserves latest state when cap is full", async () => {
		const steered: Array<{ customType: string; content: string; details?: unknown }> = [];
		const session = createSession(settings, { steered });
		const tool = MonitorTool.createIf(session)!;
		await tool.execute("call", {
			command:
				"for i in $(seq 1 20); do printf '0 passed, 2 pending, 0 failed\\n'; done; printf '0 passed, 0 pending, 2 failed\\n'",
			kind: "poll",
			description: "state test",
			persistent: true,
		});
		await manager.waitForAll();
		await Promise.resolve();

		expect(steered.some(entry => entry.content.includes("0 passed, 0 pending, 2 failed"))).toBe(true);
		expect(steered.length).toBeLessThanOrEqual(3);
	});

	it("cancel closes monitor before abort trailing partial flush", async () => {
		const steered: Array<{ customType: string; content: string; details?: unknown }> = [];
		const session = createSession(settings, { steered });
		const tool = MonitorTool.createIf(session)!;
		const result = expectText(
			await tool.execute("call", {
				command: "printf 'partial-without-newline'; sleep 30",
				kind: "poll",
				description: "partial test",
				persistent: true,
			}),
		);
		manager.cancel(result.details.taskId, { ownerId: "0-Test" });
		await manager.waitForAll();
		await Promise.resolve();

		expect(steered.some(entry => entry.content.includes("partial-without-newline"))).toBe(false);
	});

	it("auto-cancels non-persistent monitors after the first stdout-line notification", async () => {
		const steered: Array<{ customType: string; content: string; details?: unknown }> = [];
		const session = createSession(settings, { steered });
		const tool = MonitorTool.createIf(session)!;
		await tool.execute("call", {
			command: "printf 'first\\nsecond\\n'",
			kind: "log",
			description: "one-shot monitor",
			persistent: false,
		});
		await manager.waitForAll();
		expect(steered).toHaveLength(1);
		expect(steered[0]?.content).toContain("first");
		expect(steered[0]?.content).not.toContain("second");
	});

	it("marks non-zero monitor commands as failed after delivering captured lines", async () => {
		const steered: Array<{ customType: string; content: string; details?: unknown }> = [];
		const session = createSession(settings, { steered });
		const tool = MonitorTool.createIf(session)!;
		const result = expectText(
			await tool.execute("call", {
				command: "printf 'bad\\n'; exit 2",
				kind: "log",
				description: "failing monitor",
				persistent: true,
			}),
		);
		await manager.waitForAll();
		expect(steered).toHaveLength(1);
		expect(steered[0]?.content).toContain("bad");
		expect(manager.getJob(result.details.taskId)?.status).toBe("failed");
		expect(manager.getJob(result.details.taskId)?.errorText).toContain("Command exited with code 2");
	});

	it("bounds oversized monitor notification lines while preserving the captured output", async () => {
		const steered: Array<{ customType: string; content: string; details?: unknown }> = [];
		const session = createSession(settings, { steered });
		const tool = MonitorTool.createIf(session)!;
		const result = expectText(
			await tool.execute("call", {
				command: "printf '%*sTAIL\\n' 20000 '' | tr ' ' A",
				kind: "log",
				description: "large line monitor",
				persistent: false,
			}),
		);
		await manager.waitForAll();

		expect(steered).toHaveLength(1);
		expect(Buffer.byteLength(steered[0]!.content, "utf8")).toBeLessThan(18_000);
		expect(steered[0]!.content).toContain("TAIL");
		expect(steered[0]!.content).toContain("Monitor output truncated");

		const slice = manager.readOutputSince(result.details.taskId, 0, { ownerId: "0-Test" });
		expect(slice?.text).toContain(`${"A".repeat(20_000)}TAIL`);
	});
});

describe("Cron tools", () => {
	function makeTools(options: SessionOptions = {}) {
		const session = createSession(settings, options);
		const cron = CronTool.createIf(session)!;
		return {
			session,
			cron,
			create: {
				execute: (id: string, params: { cron_expression: string; prompt: string; recurring: boolean }) =>
					cron.execute(id, { op: "create", ...params }) as Promise<
						AgentToolResult<{ id: string; cron_expression: string; recurring: boolean; nextFireAt?: number }>
					>,
			},
			list: {
				execute: (id: string, _params: Record<string, never> = {}) =>
					cron.execute(id, { op: "list" }) as Promise<AgentToolResult<{ jobs: CronListJobDetails[] }>>,
			},
			del: {
				execute: (id: string, params: { id: string }) =>
					cron.execute(id, { op: "delete", id: params.id }) as Promise<
						AgentToolResult<{ id: string; deleted: boolean }>
					>,
			},
		};
	}

	it("validates 5-field cron expressions", () => {
		expect(() => validateCronExpression("*/5 * * * *")).not.toThrow();
		expect(() => validateCronExpression("0 9 * * 1-5")).not.toThrow();
		expect(() => validateCronExpression("0 9 * *")).toThrow(/5 space-separated fields/);
		expect(() => validateCronExpression("99 * * * *")).toThrow(/out of range/);
		expect(() => validateCronExpression("*/0 * * * *")).toThrow(/step value must be a positive integer/);
		expect(() => validateCronExpression("5-1 * * * *")).toThrow(/ascending/);
	});

	it("exposes one cron tool with create/list/delete operations", () => {
		const { cron } = makeTools();
		expect(cron.name).toBe("cron");
		expect(cron.parameters.safeParse({ op: "create", cron_expression: "*/5 * * * *", prompt: "p" }).success).toBe(
			true,
		);
		expect(cron.parameters.safeParse({ op: "list" }).success).toBe(true);
		expect(cron.parameters.safeParse({ op: "delete", id: "ab12cd34" }).success).toBe(true);
		expect(cron.parameters.safeParse({ op: "bogus" }).success).toBe(false);
	});

	it("schedules a recurring task, lists it with human schedule, and returns an 8-character id", async () => {
		const { create, list } = makeTools();
		const result = expectText(
			await create.execute("call", {
				cron_expression: "*/5 * * * *",
				prompt: "poll deploys",
				recurring: true,
			}),
		);
		expect(result.details.id).toMatch(/^[a-z0-9]{8}$/);
		expect(result.details.recurring).toBe(true);
		expect(result.text).toMatch(/^Scheduled [a-z0-9]{8} \(every 5 minutes\)$/);
		const listing = expectText(await list.execute("call", {}));
		expect(listing.details.jobs).toHaveLength(1);
		expect(listing.details.jobs[0]?.cron).toBe("*/5 * * * *");
		expect(listing.text).toContain(`${result.details.id} (every 5 minutes): poll deploys`);
	});

	it("cancels a scheduled task by id and treats unknown ids as terminal no-op results", async () => {
		const { create, del, list } = makeTools();
		const scheduled = expectText(
			await create.execute("call", {
				cron_expression: "*/5 * * * *",
				prompt: "poll",
				recurring: true,
			}),
		);
		const cancelResult = expectText(await del.execute("call", { id: scheduled.details.id }));
		expect(cancelResult.details.deleted).toBe(true);
		expect(cancelResult.text).toBe(`Cancelled ${scheduled.details.id}`);
		const listing = expectText(await list.execute("call", {}));
		expect(listing.details.jobs).toHaveLength(0);
		expect(listing.text).toBe("No scheduled jobs");
		const missing = expectText(await del.execute("call", { id: "doesnotex" }));
		expect(missing.details.deleted).toBe(false);
		expect(missing.text).toBe("No scheduled task 'doesnotex' found; nothing to cancel.");
	});

	it("fires a one-shot task via fake timers and self-deletes after firing", async () => {
		const start = new Date("2026-06-02T12:00:10").getTime();
		await withFakeTimers(start, async clock => {
			const steered: Array<{ customType: string; content: string; details?: unknown }> = [];
			const { create, list } = makeTools({ steered });
			let id = "";
			const result = await create.execute("call", {
				cron_expression: "1 12 * * *",
				prompt: "run one",
				recurring: false,
			});
			id = expectText(result).details.id;
			const fireAt = calculateCronFireTimeMs({
				id,
				cronExpression: "1 12 * * *",
				baseMatchMs: new Date("2026-06-02T12:01:00").getTime(),
				recurring: false,
				nowMs: clock.now(),
			});
			clock.tick(fireAt - clock.now());
			expect(steered).toHaveLength(1);
			expect(steered[0]?.customType).toBe("cron-fire");
			expect(steered[0]?.content).toContain("run one");
			await Promise.resolve();
			expect(expectText(await list.execute("call", {})).details.jobs).toHaveLength(0);
		});
	});

	it("treats deletion of an already-fired one-shot task as terminal and non-retryable", async () => {
		const start = new Date("2026-06-02T12:00:10").getTime();
		await withFakeTimers(start, async clock => {
			const steered: Array<{ customType: string; content: string; details?: unknown }> = [];
			const { create, del, list } = makeTools({ steered });
			const result = await create.execute("call", {
				cron_expression: "1 12 * * *",
				prompt: "run one",
				recurring: false,
			});
			const id = expectText(result).details.id;
			const fireAt = calculateCronFireTimeMs({
				id,
				cronExpression: "1 12 * * *",
				baseMatchMs: new Date("2026-06-02T12:01:00").getTime(),
				recurring: false,
				nowMs: clock.now(),
			});
			clock.tick(fireAt - clock.now());
			await Promise.resolve();
			expect(expectText(await list.execute("call", {})).details.jobs).toHaveLength(0);

			const deleteResult = await del.execute("call", { id });
			const terminal = expectText(deleteResult);
			expect(terminal.details.deleted).toBe(false);
			expect(terminal.text).toBe(`No scheduled task '${id}' found; nothing to cancel.`);
			expect(deleteResult.isError).toBeUndefined();
			expect(steered.filter(entry => entry.customType === "cron-fire")).toHaveLength(1);
		});
	});

	it("reschedules recurring tasks and expires them at 7 days", async () => {
		const start = new Date("2026-06-02T12:00:10").getTime();
		await withFakeTimers(start, async clock => {
			const steered: Array<{ customType: string; content: string; details?: unknown }> = [];
			const { create, list } = makeTools({ steered });
			const result = await create.execute("call", {
				cron_expression: "*/1 * * * *",
				prompt: "tick",
				recurring: true,
			});
			const details = expectText(result).details;
			const firstBase = findNextCronMatchMs("*/1 * * * *", start)!;
			const firstFire = calculateCronFireTimeMs({
				id: details.id,
				cronExpression: "*/1 * * * *",
				baseMatchMs: firstBase,
				recurring: true,
				nowMs: start,
				expiresAt: start + CRON_RECURRING_MAX_AGE_MS,
			});
			clock.tick(firstFire - clock.now());
			expect(steered).toHaveLength(1);
			expect(expectText(await list.execute("call", {})).details.jobs).toHaveLength(1);
			clock.tick(CRON_RECURRING_MAX_AGE_MS);
			expect(expectText(await list.execute("call", {})).details.jobs).toHaveLength(0);
		});
	});

	it("isolates schedules by owner — subagent cannot list parent's tasks", async () => {
		const parentSession = createSession(settings, { agentId: "0-Parent" });
		const childSession = createSession(settings, { agentId: "0-Child" });
		const parentCron = CronTool.createIf(parentSession)!;
		const childCron = CronTool.createIf(childSession)!;
		await parentCron.execute("call", {
			op: "create",
			cron_expression: "*/5 * * * *",
			prompt: "parent-task",
			recurring: true,
		});
		const childListing = expectText(await childCron.execute("call", { op: "list" }));
		expect(childListing.details.jobs).toHaveLength(0);
	});

	it("enforces the per-owner 50-task cap", async () => {
		const { create } = makeTools();
		for (let i = 0; i < MAX_CRON_TASKS_PER_OWNER; i += 1) {
			await create.execute("call", {
				cron_expression: "*/5 * * * *",
				prompt: `task-${i}`,
				recurring: true,
			});
		}
		expect(
			create.execute("call", {
				cron_expression: "*/5 * * * *",
				prompt: "overflow",
				recurring: true,
			}),
		).rejects.toThrow(/Cron task limit reached/);
	});

	it("clears timers and schedules when owner cleanup fires", async () => {
		const { create, list } = makeTools();
		await create.execute("call", {
			cron_expression: "*/5 * * * *",
			prompt: "p",
			recurring: true,
		});
		expect(expectText(await list.execute("call", {})).details.jobs).toHaveLength(1);
		manager.runOwnerCleanups({ ownerId: "0-Test" });
		expect(expectText(await list.execute("call", {})).details.jobs).toHaveLength(0);
	});
});

describe("BUILTIN_TOOLS registry", () => {
	it("exposes monitor + cron entries", () => {
		expect(BUILTIN_TOOLS.monitor).toBeDefined();
		expect(BUILTIN_TOOLS.cron).toBeDefined();
	});

	it("constructs the new tools through the factory map when background-jobs are enabled", async () => {
		const session = createSession(settings);
		const monitor = await BUILTIN_TOOLS.monitor(session);
		const cron = await BUILTIN_TOOLS.cron(session);
		expect(monitor?.name).toBe("monitor");
		expect(cron?.name).toBe("cron");
	});
});
