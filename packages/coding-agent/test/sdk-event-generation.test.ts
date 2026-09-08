import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { reserveEventGeneration } from "../src/sdk/host/event-generation";
import { SessionEventStream } from "../src/sdk/host/events";
import { SessionSdkHost } from "../src/sdk/host/host";

let root: string;
beforeEach(async () => {
	root = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-event-generation-"));
});
afterEach(async () => {
	await fs.rm(root, { recursive: true, force: true });
});

function host(reserve?: (minimum: number) => Promise<number>): SessionSdkHost {
	return new SessionSdkHost({
		sessionId: "resumed-session",
		stateRoot: root,
		token: "test-token",
		sendFrame: () => "written",
		onFrame: () => undefined,
		reserveEventGeneration: reserve,
	});
}

describe("durable SDK event generation", () => {
	test("a recreated host replays new events despite the previous host's high cursor", async () => {
		const first = host();
		await first.start();
		for (let i = 0; i < 175; i++) first.emitEvent({ kind: "activity" });
		const oldGeneration = first.generation;
		const oldSequence = first.events.sequence;
		await first.stop();
		const resumed = host();
		await resumed.start();
		expect(resumed.generation).toBeGreaterThan(oldGeneration);
		const replay = resumed.events.replay(oldSequence, oldGeneration);
		expect(replay.gap?.kind).toBe("generation_reset");
		expect(replay.events).toMatchObject([{ name: "session_ready", generation: resumed.generation, seq: 1 }]);
		await resumed.stop();
	});

	test("independent processes reserve distinct namespaces for the same session", async () => {
		const module = path.resolve("packages/coding-agent/src/sdk/host/event-generation.ts");
		const code = `import { reserveEventGeneration } from ${JSON.stringify(module)}; console.log(await reserveEventGeneration(Bun.argv.at(-1), "same-session", 1));`;
		const children = Array.from({ length: 4 }, () =>
			Bun.spawn([process.execPath, "-e", code, root], { stdout: "pipe", stderr: "pipe" }),
		);
		const generations = await Promise.all(
			children.map(async child => {
				const [stdout, stderr, exit] = await Promise.all([
					new Response(child.stdout).text(),
					new Response(child.stderr).text(),
					child.exited,
				]);
				expect(stderr).toBe("");
				expect(exit).toBe(0);
				return Number(stdout.trim());
			}),
		);
		expect(new Set(generations).size).toBe(4);
		expect(await reserveEventGeneration(root, "same-session", 1)).toBeGreaterThan(Math.max(...generations));
	});

	test("persisted ordering survives a clock behind the last reservation", async () => {
		const future = Date.now() + 1_000_000;
		await reserveEventGeneration(root, "clock", future);
		expect(await reserveEventGeneration(root, "clock", 1)).toBe(future + 1);
	});

	test("corruption and exhaustion fail closed instead of recycling a namespace", async () => {
		await reserveEventGeneration(root, "broken", 1);
		const db = new Database(path.join(root, "sdk-event-generations.sqlite"));
		try {
			db.query("UPDATE event_generations SET generation = ? WHERE session_id = ?").run(-1, "broken");
			await expect(reserveEventGeneration(root, "broken", 1)).rejects.toThrow("Corrupt SDK event generation");
			db.query("UPDATE event_generations SET generation = ? WHERE session_id = ?").run(
				Number.MAX_SAFE_INTEGER,
				"broken",
			);
			await expect(reserveEventGeneration(root, "broken", 1)).rejects.toThrow("SDK event generation exhausted");
		} finally {
			db.close();
		}
	});

	test("reservation failure publishes neither readiness nor broker registration", async () => {
		const instance = host(async () => {
			throw new Error("storage unavailable");
		});
		let registered = false;
		await instance.registerWithBroker({
			register: () => {
				registered = true;
			},
		});
		await expect(instance.start()).rejects.toThrow("storage unavailable");
		expect(instance.started).toBe(false);
		expect(instance.events.replay(0).events).toEqual([]);
		expect(registered).toBe(false);
	});

	test("concurrent starts share one reservation and shutdown joins pending startup", async () => {
		const allocation = Promise.withResolvers<number>();
		let calls = 0;
		const instance = host(async () => {
			calls++;
			return allocation.promise;
		});
		const first = instance.start();
		const second = instance.start();
		const stopped = instance.stop();
		allocation.resolve(42);
		expect(await first).toBe("started");
		expect(await second).toBe("already");
		expect(await stopped).toBe("stopped");
		expect(calls).toBe(1);
		expect(instance.started).toBe(false);
	});

	test("invalid reset leaves the existing event ring intact", () => {
		const stream = new SessionEventStream({ generation: 8 });
		stream.emit({ name: "kept" });
		for (const invalid of [8, 7, NaN, Infinity, 8.5, Number.MAX_SAFE_INTEGER + 1]) {
			expect(() => stream.restart(invalid)).toThrow("must advance");
			expect(stream.replay(0).events).toMatchObject([{ name: "kept", generation: 8, seq: 1 }]);
		}
	});
});
