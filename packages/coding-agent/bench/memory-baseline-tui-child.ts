import { Container, Text } from "@gajae-code/tui";
import { buildMemoryFixture } from "./perf-corpus.bench";
import type { MemoryWorkload } from "./memory-baseline-workloads";
import type { MemoryWorkloadProfile } from "./perf-corpus-schema";

export interface TuiMemoryWorkload extends MemoryWorkload {
	currentIndex(): number;
}

export function createTuiWorkload(): TuiMemoryWorkload {
	let nextIndex = 0;
	return {
		id: "tui-component-churn",
		surface: "tui",
		tags: ["mount", "render", "dispose"],
		run(iterations, sampleHighWater) {
			let renderedLines = 0;
			for (let offset = 0; offset < iterations; offset++) {
				const index = nextIndex++;
				const container = new Container();
				container.addChild(new Text(`header-${index}`, 0, 0));
				container.addChild(new Text(`body-${index}:${"─".repeat(40)}`, 0, 0));
				container.addChild(new Text(`footer-${index}`, 0, 0));
				renderedLines += container.render(80).length;
				sampleHighWater?.(true);
				container.dispose();
			}
			return renderedLines;
		},
		currentIndex() {
			return nextIndex;
		},
		teardown() {
			nextIndex = 0;
		},
	};
}

if (import.meta.main) {
	const profile: MemoryWorkloadProfile = process.env.GJC_MEMORY_PROFILE === "soak" ? "soak" : "short";
	const durationTargetMs = Number(process.env.GJC_MEMORY_DURATION_MS) || 0;
	process.stdout.write(`${JSON.stringify(buildMemoryFixture(createTuiWorkload(), profile, durationTargetMs))}\n`);
}
