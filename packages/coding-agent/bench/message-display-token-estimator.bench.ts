/**
 * Benchmark the display-token heuristic over a stable small corpus.
 * Run: bun packages/coding-agent/bench/message-display-token-estimator.bench.ts
 */
import { estimateMessageTokensHeuristic } from "@gajae-code/agent-core/compaction";

const corpus = [
	{ role: "user" as const, content: [{ type: "text" as const, text: "Small prompt for estimator calibration." }] },
	{ role: "user" as const, content: [{ type: "text" as const, text: JSON.stringify({ files: Array.from({ length: 100 }, (_, i) => `src/file-${i}.ts`) }) }] },
];
const WARMUP = 20;
const ITERATIONS = 1_000;

for (let i = 0; i < WARMUP; i++) {
	for (const message of corpus) estimateMessageTokensHeuristic(message);
}
const start = Bun.nanoseconds();
for (let i = 0; i < ITERATIONS; i++) {
	for (const message of corpus) estimateMessageTokensHeuristic(message);
}
const elapsedMs = (Bun.nanoseconds() - start) / 1e6;
console.log(`message display-token heuristic: ${elapsedMs.toFixed(2)}ms total  ${(elapsedMs / ITERATIONS).toFixed(4)}ms/corpus`);