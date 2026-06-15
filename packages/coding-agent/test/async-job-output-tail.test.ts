import { afterEach, describe, expect, test } from "bun:test";
import { AsyncJobManager } from "../src/async/job-manager";
import { JobsObserver } from "../src/modes/jobs-observer";

const OWNER = "0-Main";

function makeManager(): AsyncJobManager {
	return new AsyncJobManager({ onJobComplete: async () => {} });
}

function abortable(signal: AbortSignal): Promise<string> {
	return new Promise<string>(resolve => {
		if (signal.aborted) return resolve("aborted");
		signal.addEventListener("abort", () => resolve("aborted"), { once: true });
	});
}

function registerMonitor(manager: AsyncJobManager, label = "tail", ownerId = OWNER): string {
	return manager.register("bash", label, async ({ signal }) => abortable(signal), {
		ownerId,
		metadata: { monitor: true },
	});
}

afterEach(() => {
	AsyncJobManager.setInstance(undefined);
});

describe("AsyncJobManager.readOutputTail", () => {
	test("maxLines keeps only the final lines and flags truncation", async () => {
		const manager = makeManager();
		const id = registerMonitor(manager);
		for (const line of ["line1\n", "line2\n", "line3\n", "line4\n"]) manager.appendOutput(id, line);

		const slice = manager.readOutputTail(id, { maxLines: 2 });
		expect(slice?.text).toBe("line3\nline4");
		expect(slice?.truncated).toBe(true);
		expect(slice?.nextOffset).toBe(24);

		const all = manager.readOutputTail(id, { maxLines: 10 });
		expect(all?.text).toBe("line1\nline2\nline3\nline4\n");
		expect(all?.truncated).toBe(false);
		await manager.dispose();
	});

	test("maxBytes only visits the trailing chunks (bounded read)", async () => {
		const manager = makeManager();
		const id = registerMonitor(manager);
		for (const line of ["line1\n", "line2\n", "line3\n", "line4\n"]) manager.appendOutput(id, line);

		// 24 bytes total; last 6 bytes is exactly the final "line4\n" chunk.
		const slice = manager.readOutputTail(id, { maxBytes: 6 });
		expect(slice?.text).toBe("line4\n");
		expect(slice?.truncated).toBe(true);
		expect(slice?.startOffset).toBe(18);
		expect(slice?.nextOffset).toBe(24);
		await manager.dispose();
	});

	test("sinceOffset cursor follow returns only fresh bytes", async () => {
		const manager = makeManager();
		const id = registerMonitor(manager);
		manager.appendOutput(id, "alpha\n");
		const first = manager.readOutputTail(id, { maxBytes: 4096 });
		expect(first?.text).toBe("alpha\n");
		const cursor = first?.nextOffset ?? 0;

		// caught up -> empty, not truncated
		const caughtUp = manager.readOutputTail(id, { sinceOffset: cursor, maxBytes: 4096 });
		expect(caughtUp?.text).toBe("");
		expect(caughtUp?.truncated).toBe(false);

		// new bytes after the cursor
		manager.appendOutput(id, "beta\n");
		const fresh = manager.readOutputTail(id, { sinceOffset: cursor, maxBytes: 4096 });
		expect(fresh?.text).toBe("beta\n");
		expect(fresh?.truncated).toBe(false);
		await manager.dispose();
	});

	test("retention drop past sinceOffset returns a truncated bounded tail", async () => {
		const manager = makeManager();
		const id = registerMonitor(manager);
		// Exceed the 512 KiB retention so the oldest chunk is evicted (startOffset advances).
		const big = "x".repeat(300 * 1024);
		manager.appendOutput(id, big); // [0, 300K)
		manager.appendOutput(id, "TAILMARK\n"); // pushes total > 512K, evicts first chunk
		const slice = manager.readOutputTail(id, { sinceOffset: 0, maxBytes: 64 });
		expect(slice?.truncated).toBe(true);
		expect(slice?.text).toContain("TAILMARK");
		expect(slice?.startOffset).toBeGreaterThan(0);
		await manager.dispose();
	});

	test("never splits multibyte characters at the maxBytes boundary", async () => {
		const manager = makeManager();
		const id = registerMonitor(manager);
		// "é" is 2 UTF-8 bytes; craft output so a naive byte cut would split it.
		manager.appendOutput(id, "é".repeat(10)); // 20 bytes
		const slice = manager.readOutputTail(id, { maxBytes: 5 });
		expect(slice?.text).not.toContain("\uFFFD");
		// returned suffix is a clean run of é characters
		expect(/^é*$/.test(slice?.text ?? "")).toBe(true);
		expect(slice?.truncated).toBe(true);
		await manager.dispose();
	});

	test("unknown job and owner mismatch return undefined", async () => {
		const manager = makeManager();
		const id = registerMonitor(manager, "tail", OWNER);
		manager.appendOutput(id, "data\n");
		expect(manager.readOutputTail("ghost", { maxLines: 3 })).toBeUndefined();
		expect(manager.readOutputTail(id, { maxLines: 3 }, { ownerId: "other" })).toBeUndefined();
		await manager.dispose();
	});

	test("JobsObserver.getMonitorOutputTail delegates with owner scoping", async () => {
		const manager = makeManager();
		const observer = new JobsObserver(manager, OWNER);
		const id = registerMonitor(manager, "tail", OWNER);
		manager.appendOutput(id, "one\ntwo\nthree\n");

		const slice = observer.getMonitorOutputTail(id, { maxLines: 2 });
		expect(slice?.text).toBe("two\nthree");

		// snapshot exposes endTime field (undefined while running)
		const view = observer.getSnapshot().monitors.find(m => m.id === id);
		expect(view).toBeDefined();
		expect(view?.endTime).toBeUndefined();

		observer.dispose();
		await manager.dispose();
	});
});
