import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { AsyncJobManager } from "../src/async/job-manager";

// Phase 1 substrate tests. They exercise the manager-owned output cursor in
// isolation — no bash execution, no streaming-output sink. The bash-side
// onRawChunk wiring is covered separately by monitor-tool tests.

const noopOnJobComplete = async () => {};

describe("AsyncJobManager output cursor (Phase 1)", () => {
	let manager: AsyncJobManager;

	beforeEach(() => {
		manager = new AsyncJobManager({ onJobComplete: noopOnJobComplete });
	});

	afterEach(async () => {
		await manager.dispose({ timeoutMs: 1000 });
	});

	function registerJob(owner?: string): string {
		return manager.register(
			"bash",
			"test-job",
			async ({ signal }) => {
				// keep the job alive until the test cancels or completes it
				await new Promise<void>(resolve => {
					if (signal.aborted) {
						resolve();
						return;
					}
					signal.addEventListener("abort", () => resolve(), { once: true });
				});
				return "";
			},
			{ ownerId: owner },
		);
	}

	it("returns an empty slice for a job with no captured output yet", () => {
		const id = registerJob();
		const slice = manager.readOutputSince(id, 0);
		expect(slice).toBeDefined();
		expect(slice?.text).toBe("");
		expect(slice?.startOffset).toBe(0);
		expect(slice?.nextOffset).toBe(0);
		expect(slice?.truncated).toBe(false);
	});

	it("returns undefined for an unknown job id", () => {
		expect(manager.readOutputSince("does-not-exist", 0)).toBeUndefined();
	});

	it("appends chunks and reports monotonic UTF-8 byte offsets", () => {
		const id = registerJob();
		manager.appendOutput(id, "hello");
		manager.appendOutput(id, " world");
		const slice = manager.readOutputSince(id, 0);
		expect(slice?.text).toBe("hello world");
		expect(slice?.nextOffset).toBe(Buffer.byteLength("hello world", "utf8"));
		expect(slice?.startOffset).toBe(0);
		expect(slice?.truncated).toBe(false);
	});

	it("only returns fresh bytes when reading from the previous nextOffset", () => {
		const id = registerJob();
		manager.appendOutput(id, "line one\n");
		const first = manager.readOutputSince(id, 0);
		expect(first?.text).toBe("line one\n");
		manager.appendOutput(id, "line two\n");
		const second = manager.readOutputSince(id, first?.nextOffset ?? 0);
		expect(second?.text).toBe("line two\n");
		expect(second?.startOffset).toBe(0);
	});

	it("does not split multibyte characters under byte-offset reads", () => {
		const id = registerJob();
		const multi = "안녕"; // each codepoint is 3 UTF-8 bytes (6 bytes total)
		manager.appendOutput(id, multi);
		const slice = manager.readOutputSince(id, 0);
		expect(slice?.text).toBe(multi);
		expect(slice?.nextOffset).toBe(Buffer.byteLength(multi, "utf8"));
		const tail = manager.readOutputSince(id, 3);
		expect(tail?.text).toBe("녕");
		const insideSecondCodepoint = manager.readOutputSince(id, 4);
		expect(insideSecondCodepoint?.text).toBe("녕");
	});

	it("slices ASCII chunks from the requested byte offset", () => {
		const id = registerJob();
		manager.appendOutput(id, "alphabet");
		const tail = manager.readOutputSince(id, 5);
		expect(tail?.text).toBe("bet");
	});
	it("clamps to nextOffset and returns empty text when the cursor is ahead of the stream", () => {
		const id = registerJob();
		manager.appendOutput(id, "data");
		const slice = manager.readOutputSince(id, 1_000_000);
		expect(slice?.text).toBe("");
		expect(slice?.nextOffset).toBe(4);
		expect(slice?.truncated).toBe(false);
	});

	it("ignores empty chunks", () => {
		const id = registerJob();
		manager.appendOutput(id, "");
		const slice = manager.readOutputSince(id, 0);
		expect(slice?.text).toBe("");
		expect(slice?.nextOffset).toBe(0);
	});

	it("captures a burst of chunks without dropping any", () => {
		const id = registerJob();
		// 200 chunks dispatched synchronously simulate the burst case where the
		// throttled preview path would only have fired once. The substrate must
		// see every chunk.
		for (let i = 0; i < 200; i += 1) {
			manager.appendOutput(id, `chunk-${i}\n`);
		}
		const slice = manager.readOutputSince(id, 0);
		expect(slice?.text.startsWith("chunk-0\n")).toBe(true);
		expect(slice?.text.endsWith("chunk-199\n")).toBe(true);
		// 200 chunks × ("chunk-%d\n" with %d ranging 1-3 digits)
		const expectedBytes = (() => {
			let total = 0;
			for (let i = 0; i < 200; i += 1) total += Buffer.byteLength(`chunk-${i}\n`, "utf8");
			return total;
		})();
		expect(slice?.nextOffset).toBe(expectedBytes);
	});

	it("scopes reads by ownerId — cross-owner reads return undefined", () => {
		const ownerA = "0-OwnerA";
		const ownerB = "0-OwnerB";
		const id = registerJob(ownerA);
		manager.appendOutput(id, "private payload");
		const sliceA = manager.readOutputSince(id, 0, { ownerId: ownerA });
		expect(sliceA?.text).toBe("private payload");
		const sliceB = manager.readOutputSince(id, 0, { ownerId: ownerB });
		expect(sliceB).toBeUndefined();
	});

	it("drops captured output when the job is cancelled and eviction runs", async () => {
		const id = manager.register("bash", "evict-test", async ({ signal }) => {
			signal.addEventListener("abort", () => {});
			return "";
		});
		manager.appendOutput(id, "before-cancel");
		manager.cancel(id);
		// Cancellation alone keeps the job snapshot around (so callers can read
		// terminal state); eviction only runs after retentionMs. Force eviction
		// by disposing the manager and re-checking.
		const before = manager.readOutputSince(id, 0);
		expect(before?.text).toBe("before-cancel");
		await manager.dispose({ timeoutMs: 100 });
		expect(manager.readOutputSince(id, 0)).toBeUndefined();
	});

	it("does not duplicate formatted final result text into the stream", () => {
		const id = registerJob();
		manager.appendOutput(id, "raw process bytes");
		// Simulate the BashTool completion path: resultText is the formatted
		// tool result, but the substrate must not echo that formatted text back
		// as process output. Cancel the job first so afterEach.dispose() can
		// drain it, then mutate the snapshot.
		manager.cancel(id);
		const job = manager.getJob(id);
		if (job) {
			job.resultText = "formatted tool result with notices and artifact://...";
		}
		const slice = manager.readOutputSince(id, 0);
		expect(slice?.text).toBe("raw process bytes");
		expect(slice?.text).not.toContain("formatted tool result");
	});

	it("can be combined with cursor reads to deliver chunked deltas exactly once", () => {
		const id = registerJob();
		manager.appendOutput(id, "alpha");
		const s1 = manager.readOutputSince(id, 0);
		expect(s1?.text).toBe("alpha");
		manager.appendOutput(id, "beta");
		const s2 = manager.readOutputSince(id, s1?.nextOffset ?? 0);
		expect(s2?.text).toBe("beta");
		manager.appendOutput(id, "gamma");
		const s3 = manager.readOutputSince(id, s2?.nextOffset ?? 0);
		expect(s3?.text).toBe("gamma");
	});
});

describe("AsyncJobManager owner cleanup primitive (Phase 2)", () => {
	let manager: AsyncJobManager;

	beforeEach(() => {
		manager = new AsyncJobManager({ onJobComplete: noopOnJobComplete });
	});

	afterEach(async () => {
		await manager.dispose({ timeoutMs: 1000 });
	});

	it("rejects empty ownerId at registration", () => {
		expect(() => manager.registerOwnerCleanup("", () => {})).toThrow();
	});

	it("runs each registered cleanup exactly once on owner cleanup", () => {
		let calls = 0;
		manager.registerOwnerCleanup("0-A", () => {
			calls += 1;
		});
		manager.registerOwnerCleanup("0-A", () => {
			calls += 1;
		});
		manager.runOwnerCleanups({ ownerId: "0-A" });
		expect(calls).toBe(2);
		// Idempotent: re-running clears nothing because callbacks were removed.
		manager.runOwnerCleanups({ ownerId: "0-A" });
		expect(calls).toBe(2);
	});

	it("scopes cleanups by ownerId", () => {
		let aCalls = 0;
		let bCalls = 0;
		manager.registerOwnerCleanup("0-A", () => {
			aCalls += 1;
		});
		manager.registerOwnerCleanup("0-B", () => {
			bCalls += 1;
		});
		manager.runOwnerCleanups({ ownerId: "0-A" });
		expect(aCalls).toBe(1);
		expect(bCalls).toBe(0);
	});

	it("isolates errors so one failing cleanup does not skip siblings", () => {
		let secondRan = false;
		manager.registerOwnerCleanup("0-A", () => {
			throw new Error("boom");
		});
		manager.registerOwnerCleanup("0-A", () => {
			secondRan = true;
		});
		// Must not throw to the caller.
		expect(() => manager.runOwnerCleanups({ ownerId: "0-A" })).not.toThrow();
		expect(secondRan).toBe(true);
	});

	it("unregister function removes a single cleanup without affecting siblings", () => {
		let aCalled = false;
		let bCalled = false;
		const unregisterA = manager.registerOwnerCleanup("0-A", () => {
			aCalled = true;
		});
		manager.registerOwnerCleanup("0-A", () => {
			bCalled = true;
		});
		unregisterA();
		manager.runOwnerCleanups({ ownerId: "0-A" });
		expect(aCalled).toBe(false);
		expect(bCalled).toBe(true);
	});

	it("runs all remaining cleanups when filter is omitted (manager dispose path)", () => {
		let aCalls = 0;
		let bCalls = 0;
		manager.registerOwnerCleanup("0-A", () => {
			aCalls += 1;
		});
		manager.registerOwnerCleanup("0-B", () => {
			bCalls += 1;
		});
		manager.runOwnerCleanups();
		expect(aCalls).toBe(1);
		expect(bCalls).toBe(1);
	});

	it("dispose() runs-and-clears remaining cleanups instead of dropping them silently", async () => {
		let cleanupRan = false;
		manager.registerOwnerCleanup("0-A", () => {
			cleanupRan = true;
		});
		await manager.dispose({ timeoutMs: 100 });
		expect(cleanupRan).toBe(true);
	});
});
