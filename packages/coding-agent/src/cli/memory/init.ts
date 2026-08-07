/** Execute `gjc memory init` through the public memory-core initializer. */
import {
	type InitMemoryRootResult,
	initMemoryRoot,
	type MemoryEnvironment,
	type MemoryResult,
} from "@gajae-code/memory-core";

export interface MemoryInitCommandFlags {
	json?: boolean;
}

export type MemoryInitCommandResult = MemoryResult<InitMemoryRootResult>;

export type MemoryInitEnvironment = MemoryEnvironment;

function writeStdout(value: string): void {
	process.stdout.write(`${value}\n`);
}

export async function runInitCommand(
	environment: MemoryInitEnvironment,
	flags: MemoryInitCommandFlags = {},
): Promise<MemoryInitCommandResult> {
	const result = await initMemoryRoot(environment);
	if (!result.ok) return result;

	if (flags.json) {
		writeStdout(JSON.stringify(result.value, null, 2));
		return result;
	}

	if (result.value.created.length === 0) {
		writeStdout(`Memory root already initialized: ${result.value.memoryRoot}`);
	} else {
		writeStdout(`Initialized memory root: ${result.value.memoryRoot} (${result.value.created.length} paths created)`);
	}
	return result;
}
