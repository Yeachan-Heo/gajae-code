/** Execute `gjc memory checkpoint` through the public checkpoint writer. */
import {
	type CheckpointInput,
	type CheckpointResult,
	checkpoint,
	MEMORY_EXIT_CODES,
	type MemoryEnvironment,
	type MemoryResult,
} from "@gajae-code/memory-core";

export type MemoryCheckpointCommandResult = CheckpointResult;

export interface MemoryCheckpointCommandOptions {
	readonly json?: boolean;
}

export type MemoryCheckpointCommandFlags = MemoryCheckpointCommandOptions;

function invalid<T>(detail: string): MemoryResult<T> {
	return {
		ok: false,
		error: {
			code: "invalid-input",
			exitCode: MEMORY_EXIT_CODES.invalidInput,
			detail,
		},
	};
}

function validOptions(options: MemoryCheckpointCommandOptions): MemoryResult<MemoryCheckpointCommandOptions> {
	if (options === null || typeof options !== "object" || Array.isArray(options)) {
		return invalid("memory checkpoint options must be an object");
	}
	if (options.json !== undefined && typeof options.json !== "boolean") {
		return invalid("memory checkpoint json option must be boolean");
	}
	return { ok: true, value: options };
}

function controlCharacter(value: string): boolean {
	return [...value].some(character => {
		const codePoint = character.codePointAt(0);
		return codePoint !== undefined && (codePoint < 0x20 || codePoint === 0x7f);
	});
}

function normalizeText(value: unknown, field: string): MemoryResult<string> {
	if (typeof value !== "string") return invalid(`memory checkpoint ${field} must be a string`);
	const normalized = value.normalize("NFC").trim();
	if (normalized.length === 0) return invalid(`memory checkpoint ${field} must be a non-empty string`);
	if (controlCharacter(normalized)) return invalid(`memory checkpoint ${field} contains a control character`);
	return { ok: true, value: normalized };
}

function normalizeList(value: unknown, field: string): MemoryResult<readonly string[]> {
	if (value === undefined) return { ok: true, value: Object.freeze([]) };
	if (!Array.isArray(value)) return invalid(`memory checkpoint ${field} must be an array of strings`);
	const normalized: string[] = [];
	for (const [index, item] of value.entries()) {
		const checked = normalizeText(item, `${field}[${index}]`);
		if (!checked.ok) return checked;
		normalized.push(checked.value);
	}
	return { ok: true, value: Object.freeze(normalized) };
}

function normalizeInput(input: CheckpointInput): MemoryResult<CheckpointInput> {
	if (input === null || typeof input !== "object" || Array.isArray(input)) {
		return invalid("memory checkpoint input must be an object");
	}
	const candidate = input as unknown as Readonly<Record<string, unknown>>;
	const goal = normalizeText(candidate.goal, "goal");
	if (!goal.ok) return goal;
	const task = normalizeText(candidate.task, "task");
	if (!task.ok) return task;
	const nextSteps = normalizeList(candidate.nextSteps, "next-step");
	if (!nextSteps.ok) return nextSteps;
	if (nextSteps.value.length > 3) return invalid("memory checkpoint next-step accepts at most three entries");
	const constraints = normalizeList(candidate.constraints, "constraint");
	if (!constraints.ok) return constraints;
	const decisions = normalizeList(candidate.decisions, "decision");
	if (!decisions.ok) return decisions;
	const risks = normalizeList(candidate.risks, "risk");
	if (!risks.ok) return risks;
	return {
		ok: true,
		value: {
			goal: goal.value,
			task: task.value,
			nextSteps: nextSteps.value,
			constraints: constraints.value,
			decisions: decisions.value,
			risks: risks.value,
		},
	};
}

function writeStdout(value: string): void {
	process.stdout.write(`${value}\n`);
}

function renderHuman(result: CheckpointResult): string {
	return `checkpoint: ${result.uri} session=${result.sessionId} digest=${result.digest}`;
}

/** Persist a session checkpoint and render its receipt without handling failures. */
export async function runCheckpointCommand(
	environment: MemoryEnvironment,
	input: CheckpointInput,
	options: MemoryCheckpointCommandOptions = {},
): Promise<MemoryResult<CheckpointResult>> {
	const checkedOptions = validOptions(options);
	if (!checkedOptions.ok) return checkedOptions;
	const checkedInput = normalizeInput(input);
	if (!checkedInput.ok) return checkedInput;
	const result = await checkpoint(environment, checkedInput.value);
	if (!result.ok) return result;
	if (checkedOptions.value.json === true) {
		writeStdout(JSON.stringify(result.value, null, 2));
	} else {
		writeStdout(renderHuman(result.value));
	}
	return result;
}
