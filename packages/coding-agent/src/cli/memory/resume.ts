/** Execute `gjc memory resume` through the public checkpoint reader. */
import {
	MEMORY_EXIT_CODES,
	type MemoryEnvironment,
	type MemoryResult,
	type ResumeInput,
	type ResumeResult,
	resume,
} from "@gajae-code/memory-core";

export type MemoryResumeCommandResult = ResumeResult;

export interface MemoryResumeCommandOptions {
	readonly json?: boolean;
}

export type MemoryResumeCommandFlags = MemoryResumeCommandOptions;

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

function validOptions(options: MemoryResumeCommandOptions): MemoryResult<MemoryResumeCommandOptions> {
	if (options === null || typeof options !== "object" || Array.isArray(options)) {
		return invalid("memory resume options must be an object");
	}
	if (options.json !== undefined && typeof options.json !== "boolean") {
		return invalid("memory resume json option must be boolean");
	}
	return { ok: true, value: options };
}

function normalizeInput(input: ResumeInput | undefined): MemoryResult<ResumeInput | undefined> {
	if (input === undefined) return { ok: true, value: undefined };
	if (input === null || typeof input !== "object" || Array.isArray(input)) {
		return invalid("memory resume input must be an object");
	}
	const candidate = input as unknown as Readonly<Record<string, unknown>>;
	if (candidate.sessionId === undefined) return { ok: true, value: {} };
	if (typeof candidate.sessionId !== "string") return invalid("memory resume sessionId must be a string");
	const sessionId = candidate.sessionId.normalize("NFC").trim();
	if (sessionId.length === 0) return invalid("memory resume sessionId must not be empty");
	if (
		[...sessionId].some(character => {
			const codePoint = character.codePointAt(0);
			return codePoint !== undefined && (codePoint < 0x20 || codePoint === 0x7f);
		})
	) {
		return invalid("memory resume sessionId contains a control character");
	}
	return { ok: true, value: { sessionId } };
}

function writeStdout(value: string): void {
	process.stdout.write(`${value}\n`);
}

function renderHuman(result: ResumeResult): string {
	return [
		`session: ${result.sessionId}`,
		`goal: ${result.goal}`,
		`task: ${result.task}`,
		`next steps: ${result.nextSteps.length === 0 ? "none" : result.nextSteps.join("; ")}`,
	].join("\n");
}

/** Read a session checkpoint and render its stable handoff packet. */
export async function runResumeCommand(
	environment: MemoryEnvironment,
	input: ResumeInput | undefined,
	options: MemoryResumeCommandOptions = {},
): Promise<MemoryResult<ResumeResult>> {
	const checkedOptions = validOptions(options);
	if (!checkedOptions.ok) return checkedOptions;
	const checkedInput = normalizeInput(input);
	if (!checkedInput.ok) return checkedInput;
	const result = await resume(environment, checkedInput.value);
	if (!result.ok) return result;
	if (checkedOptions.value.json === true) {
		writeStdout(JSON.stringify(result.value, null, 2));
	} else {
		writeStdout(renderHuman(result.value));
	}
	return result;
}
