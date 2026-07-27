import { Container, Text } from "@gajae-code/tui";
import { buildMemoryFixture } from "./perf-corpus.bench";
import type { MemoryWorkload } from "./memory-baseline-workloads";
import type { MemoryWorkloadProfile } from "./perf-corpus-schema";

function createTuiWorkload(): MemoryWorkload {
	return {
		id: "tui-component-churn",
		surface: "tui",
		tags: ["mount", "render", "dispose"],
		run(iterations) {
			let renderedLines = 0;
			for (let index = 0; index < iterations; index++) {
				const container = new Container();
				container.addChild(new Text(`header-${index}`, 0, 0));
				container.addChild(new Text(`body-${index}:${"─".repeat(40)}`, 0, 0));
				container.addChild(new Text(`footer-${index}`, 0, 0));
				renderedLines += container.render(80).length;
				container.dispose();
			}
			return renderedLines;
		},
		teardown() {},
	};
}

const profile: MemoryWorkloadProfile = process.env.GJC_MEMORY_PROFILE === "soak" ? "soak" : "short";
const durationTargetMs = Number(process.env.GJC_MEMORY_DURATION_MS) || 0;
process.stdout.write(`${JSON.stringify(buildMemoryFixture(createTuiWorkload(), profile, durationTargetMs))}\n`);
