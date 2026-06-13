/**
 * Session retained-memory bench.
 *
 * Measures RSS/heap retained-heap growth and post-GC return for a large session
 * whose entries carry big text bodies (the path externalized by EphemeralBlobStore
 * in v3 #548), plus a warm `getEntries()` rematerialization. Emits the corpus
 * `rssMemory` shape so it can feed the profiling corpus (see docs/perf-profiling-corpus.md).
 *
 * Run with GC exposed for a meaningful return sample:
 *   bun --smol --expose-gc packages/coding-agent/bench/session-memory.bench.ts
 * (Without --expose-gc, returnBytes is null and only growth is reported.)
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { SessionManager } from "../src/session/session-manager";
import type { RssMemoryMetric } from "./perf-corpus-schema";

export interface SessionMemoryReport {
	entryCount: number;
	largeBodyChars: number;
	warmGetEntriesCount: number;
	rssMemory: RssMemoryMetric;
}

function bigText(index: number, chars: number): string {
	// Deterministic large body; varied per entry so it is not trivially deduped.
	return `entry-${index} ${"x".repeat(chars)}`;
}

/**
 * Build a session with `entryCount` large-body entries, then measure retained RSS
 * growth and post-GC return after a warm `getEntries()` materialization.
 */
export function measureSessionMemory(entryCount = 4_000, largeBodyChars = 2_048): SessionMemoryReport {
	const gc = (globalThis as { gc?: () => void }).gc;
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-session-memory-"));
	try {
		gc?.();
		const baselineBytes = process.memoryUsage().rss;
		const heapBaselineBytes = process.memoryUsage().heapUsed;

		const manager = SessionManager.create(root, path.join(root, "sessions"));
		for (let i = 0; i < entryCount; i++) {
			manager.appendMessage({ role: "user", content: bigText(i, largeBodyChars), timestamp: Date.now() });
		}
		// Warm materialization path (caller-owned clones).
		const entries = manager.getEntries();
		const warmGetEntriesCount = entries.length;

		const peakBytes = process.memoryUsage().rss;
		gc?.();
		const returnBytes = gc ? process.memoryUsage().rss : null;
		const heapReturnBytes = gc ? process.memoryUsage().heapUsed : null;

		const report: SessionMemoryReport = {
			entryCount,
			largeBodyChars,
			warmGetEntriesCount,
			rssMemory: {
				baselineBytes,
				peakBytes,
				growthBytes: peakBytes - baselineBytes,
				returnBytes,
				heapBaselineBytes,
				heapReturnBytes,
			},
		};
		if (!Number.isFinite(report.rssMemory.growthBytes)) {
			throw new Error("session memory bench produced a non-finite growth measurement");
		}
		return report;
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
}

if (import.meta.main) {
	const report = measureSessionMemory();
	process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}
