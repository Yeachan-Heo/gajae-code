import type { MemorySurface, MemoryWorkloadProfile } from "./perf-corpus-schema";

export interface MemoryWorkload {
	id: string;
	surface: MemorySurface;
	tags: string[];
	run(iterations: number, sampleHighWater?: (force?: boolean) => void): number;
	teardown(): void;
}

interface MutableWorkloadState {
	arrays: Uint8Array[];
	maps: Map<string, string>[];
	strings: string[];
}

function statefulWorkload(
	id: string,
	surface: MemorySurface,
	tags: string[],
	step: (state: MutableWorkloadState, index: number) => number,
): MemoryWorkload {
	const state: MutableWorkloadState = { arrays: [], maps: [], strings: [] };
	let nextIndex = 0;
	return {
		id,
		surface,
		tags,
		run(iterations, sampleHighWater) {
			let operations = 0;
			for (let offset = 0; offset < iterations; offset++) {
				operations += step(state, nextIndex++);
				sampleHighWater?.();
			}
			return operations;
		},
		teardown() {
			state.arrays.length = 0;
			state.maps.length = 0;
			state.strings.length = 0;
			nextIndex = 0;
		},
	};
}

function sessionLifecycleProxyWorkload(): MemoryWorkload {
	return statefulWorkload("agent-session-lifecycle", "agent-session", ["messages", "materialization", "clear"], (state, index) => {
		state.strings.push(`message-${index}:${"x".repeat(512 + (index % 32))}`);
		if (state.strings.length >= 128) state.strings.length = 0;
		return 1;
	});
}

function tuiLifecycleProxyWorkload(): MemoryWorkload {
	return statefulWorkload("tui-component-churn", "tui", ["mount", "render", "dispose"], (state, index) => {
		state.strings.push(`header-${index}\nbody-${index}:${"─".repeat(40)}\nfooter-${index}`);
		if (state.strings.length > 8) state.strings.shift();
		return 3;
	});
}

export function workloadIterations(profile: MemoryWorkloadProfile): number {
	const configured = Number(process.env.GJC_MEMORY_ITERATIONS);
	if (Number.isSafeInteger(configured) && configured > 0 && configured <= 10_000_000) return configured;
	return profile === "soak" ? 100_000 : 200;
}

export function createMemoryBaselineWorkloads(): MemoryWorkload[] {
	return [
		statefulWorkload("cli-startup", "cli", ["argv", "configuration", "startup"], (state, index) => {
			const options = new Map<string, string>();
			for (let option = 0; option < 16; option++) options.set(`--option-${option}`, `${index}-${option}`);
			state.maps.push(options);
			if (state.maps.length > 8) state.maps.shift();
			return options.size;
		}),
		sessionLifecycleProxyWorkload(),
		statefulWorkload("blob-external-buffers", "blob-store", ["external", "array-buffer", "teardown"], (state, index) => {
			state.arrays.push(new Uint8Array(8_192 + (index % 8) * 1_024));
			if (state.arrays.length > 32) state.arrays.shift();
			return 1;
		}),
		statefulWorkload("worker-generation", "worker", ["generation", "heartbeat", "replacement"], (state, index) => {
			const generation = new Map<string, string>();
			generation.set("worker", `worker-${index % 8}`);
			generation.set("generation", `${index}`);
			generation.set("heartbeat", `${index * 1000}`);
			state.maps.push(generation);
			if (state.maps.length > 16) state.maps.shift();
			return generation.size;
		}),
		statefulWorkload("telegram-reconnect-queue", "telegram-daemon", ["queue", "reconnect", "settlement"], (state, index) => {
			state.strings.push(JSON.stringify({ generation: index % 4, updateId: index, text: `notice-${index}` }));
			if (state.strings.length > 64) state.strings.shift();
			return 1;
		}),
		tuiLifecycleProxyWorkload(),
		statefulWorkload("shared-native-boundary", "shared-native", ["copy", "transfer", "external"], (state, index) => {
			const source = new Uint8Array(4_096 + (index % 16) * 128);
			const copy = source.slice();
			Bun.hash.xxHash64(copy);
			state.arrays.push(copy);
			if (state.arrays.length > 24) state.arrays.shift();
			return copy.byteLength;
		}),
	];
}
