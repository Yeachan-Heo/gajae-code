import { SessionManager } from "../src/session/session-manager";
import { buildMemoryFixture } from "./perf-corpus.bench";
import type { MemoryWorkload } from "./memory-baseline-workloads";
import type { MemoryWorkloadProfile } from "./perf-corpus-schema";

export function createSessionWorkload(): MemoryWorkload {
	let manager = SessionManager.inMemory();
	let entryCount = 0;
	return {
		id: "agent-session-lifecycle",
		surface: "agent-session",
		tags: ["messages", "materialization", "clear"],
		run(iterations, sampleHighWater) {
			for (let index = 0; index < iterations; index++) {
				manager.appendMessage({
					role: "user",
					content: `message-${entryCount}:${"x".repeat(512 + (entryCount % 32))}`,
					timestamp: entryCount,
				});
				entryCount++;
				sampleHighWater?.();
				if (entryCount % 128 === 0) {
					manager.getEntries();
					sampleHighWater?.(true);
					manager = SessionManager.inMemory();
				}
			}
			return iterations;
		},
		teardown() {
			manager = SessionManager.inMemory();
			entryCount = 0;
		},
	};
}

if (import.meta.main) {
	const profile: MemoryWorkloadProfile = process.env.GJC_MEMORY_PROFILE === "soak" ? "soak" : "short";
	const durationTargetMs = Number(process.env.GJC_MEMORY_DURATION_MS) || 0;
	process.stdout.write(`${JSON.stringify(buildMemoryFixture(createSessionWorkload(), profile, durationTargetMs))}\n`);
}
