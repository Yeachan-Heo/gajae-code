/** Execute `gjc memory apply` through the public memory-core write operation. */
import {
	type ApplyInput,
	type ApplyReceipt,
	apply,
	MEMORY_EXIT_CODES,
	type MemoryEnvironment,
	type MemoryResult,
} from "@gajae-code/memory-core";

export interface MemoryApplyCommandOptions {
	readonly json?: boolean;
}

export type MemoryApplyCommandFlags = MemoryApplyCommandOptions;
export type MemoryApplyCommandResult = ApplyReceipt;

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

function validOptions(options: MemoryApplyCommandOptions): MemoryResult<MemoryApplyCommandOptions> {
	if (options === null || typeof options !== "object" || Array.isArray(options)) {
		return invalid("memory apply options must be an object");
	}
	if (options.json !== undefined && typeof options.json !== "boolean") {
		return invalid("memory apply json option must be boolean");
	}
	return { ok: true, value: options };
}

function normalizeInput(input: ApplyInput): MemoryResult<ApplyInput> {
	if (input === null || typeof input !== "object" || Array.isArray(input)) {
		return invalid("memory apply input must be an object");
	}
	const candidate = input as unknown as Readonly<Record<string, unknown>>;
	if (typeof candidate.proposalId !== "string") return invalid("memory apply proposal id is required");
	const proposalId = candidate.proposalId.normalize("NFC").trim();
	if (proposalId.length === 0) return invalid("memory apply proposal id is required");
	if (
		[...proposalId].some(character => {
			const codePoint = character.codePointAt(0);
			return codePoint !== undefined && (codePoint < 0x20 || codePoint === 0x7f);
		})
	) {
		return invalid("memory apply proposal id contains a control character");
	}
	return { ok: true, value: { proposalId } };
}

function writeStdout(value: string): void {
	process.stdout.write(`${value}\n`);
}

function renderHuman(result: MemoryApplyCommandResult): string {
	return [
		`proposalId: ${result.proposalId}`,
		`mutationId: ${result.mutationId}`,
		`applied: ${result.applied ? "true" : "false"}`,
		`changed: ${result.changed.length === 0 ? "none" : result.changed.join(", ")}`,
		`superseded: ${result.superseded.length === 0 ? "none" : result.superseded.join(", ")}`,
	].join("\n");
}

/** Apply a staged proposal and render only successful results. */
export async function runApplyCommand(
	environment: MemoryEnvironment,
	input: ApplyInput,
	options: MemoryApplyCommandOptions = {},
): Promise<MemoryResult<MemoryApplyCommandResult>> {
	const checkedOptions = validOptions(options);
	if (!checkedOptions.ok) return checkedOptions;
	const checkedInput = normalizeInput(input);
	if (!checkedInput.ok) return checkedInput;
	const result = await apply(environment, checkedInput.value);
	if (!result.ok) return result;
	if (checkedOptions.value.json === true) {
		writeStdout(JSON.stringify(result.value, null, 2));
	} else {
		writeStdout(renderHuman(result.value));
	}
	return result;
}
