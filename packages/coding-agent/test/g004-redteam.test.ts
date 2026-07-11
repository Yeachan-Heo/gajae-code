import { afterEach, describe, expect, it, setSystemTime } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { postmortem } from "@gajae-code/utils";
import {
	GJC_COORDINATOR_SESSION_ID_ENV,
	GJC_COORDINATOR_SESSION_STATE_FILE_ENV,
	persistCoordinatorRuntimeStateFromEvent,
	persistCoordinatorRuntimeStateFromPostmortem,
} from "../src/gjc-runtime/session-state-sidecar";
import { WorkerIntegrationRequestScheduler } from "../src/session/agent-session";

const tempDirs: string[] = [];
const ORIGINAL_STATE_FILE = process.env[GJC_COORDINATOR_SESSION_STATE_FILE_ENV];
const ORIGINAL_SESSION_ID = process.env[GJC_COORDINATOR_SESSION_ID_ENV];

type Deferred = { promise: Promise<void>; resolve: () => void; reject: (error: unknown) => void };

function deferred(): Deferred {
	let resolve!: () => void;
	let reject!: (error: unknown) => void;
	const promise = new Promise<void>((ok, fail) => {
		resolve = ok;
		reject = fail;
	});
	return { promise, resolve, reject };
}

async function tempRoot(): Promise<string> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-g004-redteam-"));
	tempDirs.push(dir);
	return dir;
}

async function tick(): Promise<void> {
	await Promise.resolve();
}

async function readJson(file: string): Promise<Record<string, unknown>> {
	return JSON.parse(await Bun.file(file).text()) as Record<string, unknown>;
}

async function statSignature(file: string): Promise<{ mtimeMs: number; size: number; text: string }> {
	const stat = await fs.stat(file);
	return { mtimeMs: stat.mtimeMs, size: stat.size, text: await Bun.file(file).text() };
}

afterEach(async () => {
	if (ORIGINAL_STATE_FILE === undefined) delete process.env[GJC_COORDINATOR_SESSION_STATE_FILE_ENV];
	else process.env[GJC_COORDINATOR_SESSION_STATE_FILE_ENV] = ORIGINAL_STATE_FILE;
	if (ORIGINAL_SESSION_ID === undefined) delete process.env[GJC_COORDINATOR_SESSION_ID_ENV];
	else process.env[GJC_COORDINATOR_SESSION_ID_ENV] = ORIGINAL_SESSION_ID;
	setSystemTime();
	await Promise.all(tempDirs.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true })));
});

describe("G004 sidecar cache and heartbeat red-team", () => {
	it("invalidates cached previous payload after an external write with different mtime and size", async () => {
		const root = await tempRoot();
		const stateFile = path.join(root, "runtime-state.json");
		process.env[GJC_COORDINATOR_SESSION_STATE_FILE_ENV] = stateFile;
		process.env[GJC_COORDINATOR_SESSION_ID_ENV] = "g004-external-cache";

		setSystemTime(new Date("2026-02-01T00:00:00.000Z"));
		await persistCoordinatorRuntimeStateFromEvent(
			{ type: "turn_start" },
			{ sessionId: "fallback", cwd: root, sessionFile: null },
		);
		const original = await readJson(stateFile);
		const originalSignature = await statSignature(stateFile);
		expect(original.current_turn_id).toBeNull();

		const external = {
			...original,
			updated_at: "2026-02-01T00:00:00.250Z",
			current_turn_id: "externally-written-turn",
			last_turn_id: "externally-written-last",
		};
		await Bun.write(stateFile, `${JSON.stringify(external, null, 2)}\n`);
		await fs.utimes(stateFile, new Date("2026-02-01T00:00:00.250Z"), new Date("2026-02-01T00:00:00.250Z"));
		const externallyWritten = await statSignature(stateFile);
		expect(externallyWritten.mtimeMs).not.toBe(originalSignature.mtimeMs);
		expect(externallyWritten.size).not.toBe(originalSignature.size);

		setSystemTime(new Date("2026-02-01T00:00:01.500Z"));
		await persistCoordinatorRuntimeStateFromEvent(
			{ type: "turn_start" },
			{ sessionId: "fallback", cwd: root, sessionFile: null },
		);

		const payload = await readJson(stateFile);
		expect(payload.current_turn_id).toBe("externally-written-turn");
		expect(payload.last_turn_id).toBe("externally-written-last");
		expect(payload.updated_at).toBe("2026-02-01T00:00:01.500Z");
	});

	it("skips duplicate running heartbeat writes, refreshes after heartbeat, and always writes terminal transitions", async () => {
		const root = await tempRoot();
		const stateFile = path.join(root, "runtime-state.json");
		process.env[GJC_COORDINATOR_SESSION_STATE_FILE_ENV] = stateFile;
		process.env[GJC_COORDINATOR_SESSION_ID_ENV] = "g004-heartbeat";

		setSystemTime(new Date("2026-02-01T00:00:00.000Z"));
		await persistCoordinatorRuntimeStateFromEvent(
			{ type: "turn_start" },
			{ sessionId: "fallback", cwd: root, sessionFile: null },
		);
		const initial = await statSignature(stateFile);

		setSystemTime(new Date("2026-02-01T00:00:00.500Z"));
		await persistCoordinatorRuntimeStateFromEvent(
			{ type: "turn_start" },
			{ sessionId: "fallback", cwd: root, sessionFile: null },
		);
		const skipped = await statSignature(stateFile);
		expect(skipped).toEqual(initial);

		setSystemTime(new Date("2026-02-01T00:00:01.200Z"));
		await persistCoordinatorRuntimeStateFromEvent(
			{ type: "turn_start" },
			{ sessionId: "fallback", cwd: root, sessionFile: null },
		);
		const refreshed = await readJson(stateFile);
		expect(refreshed.updated_at).toBe("2026-02-01T00:00:01.200Z");

		setSystemTime(new Date("2026-02-01T00:00:01.300Z"));
		await persistCoordinatorRuntimeStateFromEvent(
			{
				type: "agent_end",
				messages: [
					{ role: "assistant", content: [{ type: "text", text: "terminal evidence" }], stopReason: "stop" },
				],
			},
			{ sessionId: "fallback", cwd: root, sessionFile: null },
		);
		const terminal = await readJson(stateFile);
		expect(terminal).toMatchObject({
			state: "completed",
			updated_at: "2026-02-01T00:00:01.300Z",
			ended_at: "2026-02-01T00:00:01.300Z",
			final_response: { text: "terminal evidence", source: "agent_end" },
		});
	});

	it("postmortem sync writer overwrites non-terminal state even when heartbeat would skip async duplicates", async () => {
		const root = await tempRoot();
		const stateFile = path.join(root, "runtime-state.json");
		process.env[GJC_COORDINATOR_SESSION_STATE_FILE_ENV] = stateFile;
		process.env[GJC_COORDINATOR_SESSION_ID_ENV] = "g004-postmortem";

		setSystemTime(new Date("2026-02-01T00:00:00.000Z"));
		await persistCoordinatorRuntimeStateFromEvent(
			{ type: "turn_start" },
			{ sessionId: "fallback", cwd: root, sessionFile: null },
		);
		setSystemTime(new Date("2026-02-01T00:00:00.100Z"));
		await persistCoordinatorRuntimeStateFromPostmortem(postmortem.Reason.SIGTERM, {
			sessionId: "fallback",
			cwd: root,
			sessionFile: null,
		});

		const payload = await readJson(stateFile);
		expect(payload).toMatchObject({
			state: "errored",
			source: "process_postmortem",
			event: "process_exit",
			reason: "sigterm",
			signal: "SIGTERM",
			previous_runtime_state: "running",
		});
	});
});

describe("G004 team worker scheduler red-team", () => {
	it("single-flights, trailing-edge coalesces a burst into exactly one extra run, and flush waits until settled", async () => {
		const requests = [deferred(), deferred()];
		let calls = 0;
		let inFlight = 0;
		let maxInFlight = 0;
		let flushed = false;
		const scheduler = new WorkerIntegrationRequestScheduler(async () => {
			const request = requests[calls++];
			expect(request).toBeDefined();
			inFlight += 1;
			maxInFlight = Math.max(maxInFlight, inFlight);
			await request.promise;
			inFlight -= 1;
		});

		scheduler.enqueue();
		for (let index = 0; index < 100; index += 1) scheduler.enqueue();
		await tick();
		expect(calls).toBe(1);
		expect(maxInFlight).toBe(1);

		const flushPromise = scheduler.flush().then(() => {
			flushed = true;
		});
		await tick();
		expect(flushed).toBe(false);

		requests[0].resolve();
		await tick();
		await tick();
		expect(calls).toBe(2);
		expect(maxInFlight).toBe(1);
		expect(flushed).toBe(false);

		requests[1].resolve();
		await flushPromise;
		expect(flushed).toBe(true);
		expect(calls).toBe(2);
		expect(maxInFlight).toBe(1);
	});

	it("clears in-flight after a rejected request, drains trailing pending work, and keeps later cycles alive", async () => {
		let calls = 0;
		const scheduler = new WorkerIntegrationRequestScheduler(async () => {
			calls += 1;
			if (calls === 1) {
				scheduler.enqueue();
				throw new Error("redteam rejected request");
			}
		});

		expect(() => scheduler.enqueue()).not.toThrow();
		await expect(scheduler.flush()).resolves.toBeUndefined();
		expect(calls).toBe(2);

		scheduler.enqueue();
		await expect(scheduler.flush()).resolves.toBeUndefined();
		expect(calls).toBe(3);
	});
});
