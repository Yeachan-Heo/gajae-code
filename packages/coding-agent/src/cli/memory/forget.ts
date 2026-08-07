/** Execute `gjc memory forget` through the public memory-core write operation. */
import {
	type ForgetInput,
	type ForgetReceipt,
	forget,
	MEMORY_EXIT_CODES,
	type MemoryEnvironment,
	type MemoryResult,
} from "@gajae-code/memory-core";

export interface MemoryForgetCommandOptions {
	readonly json?: boolean;
}

export type MemoryForgetCommandFlags = MemoryForgetCommandOptions;
export type MemoryForgetCommandResult = ForgetReceipt;

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

function validOptions(options: MemoryForgetCommandOptions): MemoryResult<MemoryForgetCommandOptions> {
	if (options === null || typeof options !== "object" || Array.isArray(options)) {
		return invalid("memory forget options must be an object");
	}
	if (options.json !== undefined && typeof options.json !== "boolean") {
		return invalid("memory forget json option must be boolean");
	}
	return { ok: true, value: options };
}

function controlCharacter(value: string): boolean {
	return [...value].some(character => {
		const codePoint = character.codePointAt(0);
		return codePoint !== undefined && (codePoint < 0x20 || codePoint === 0x7f);
	});
}

function normalizeInput(input: ForgetInput): MemoryResult<ForgetInput> {
	if (input === null || typeof input !== "object" || Array.isArray(input)) {
		return invalid("memory forget input must be an object");
	}
	const candidate = input as unknown as Readonly<Record<string, unknown>>;
	if (typeof candidate.uri !== "string") return invalid("memory forget URI is required");
	const uri = candidate.uri.normalize("NFC").trim();
	if (uri.length === 0) return invalid("memory forget URI is required");
	if (controlCharacter(uri)) return invalid("memory forget URI contains a control character");

	let expectedDigest: string | null | undefined;
	if (candidate.expectedDigest !== undefined && candidate.expectedDigest !== null) {
		if (typeof candidate.expectedDigest !== "string") return invalid("memory forget expected digest is invalid");
		expectedDigest = candidate.expectedDigest.normalize("NFC").trim();
		if (expectedDigest.length === 0) return invalid("memory forget expected digest is invalid");
	}

	let reason: string | undefined;
	if (candidate.reason !== undefined) {
		if (typeof candidate.reason !== "string") return invalid("memory forget reason is invalid");
		reason = candidate.reason.normalize("NFC").trim();
		if (reason.length === 0) return invalid("memory forget reason is invalid");
		if (controlCharacter(reason)) return invalid("memory forget reason contains a control character");
	}

	return {
		ok: true,
		value: {
			uri,
			...(expectedDigest === undefined ? {} : { expectedDigest }),
			...(reason === undefined ? {} : { reason }),
		},
	};
}

function writeStdout(value: string): void {
	process.stdout.write(`${value}\n`);
}

function renderHuman(result: MemoryForgetCommandResult): string {
	return [
		`uri: ${result.uri}`,
		`forgotten: ${result.forgotten ? "true" : "false"}`,
		`superseded: ${result.superseded ? "true" : "false"}`,
		`marker: ${result.marker ?? "none"}`,
	].join("\n");
}

/** Tombstone a canonical document and render only successful results. */
export async function runForgetCommand(
	environment: MemoryEnvironment,
	input: ForgetInput,
	options: MemoryForgetCommandOptions = {},
): Promise<MemoryResult<MemoryForgetCommandResult>> {
	const checkedOptions = validOptions(options);
	if (!checkedOptions.ok) return checkedOptions;
	const checkedInput = normalizeInput(input);
	if (!checkedInput.ok) return checkedInput;
	const result = await forget(environment, checkedInput.value);
	if (!result.ok) return result;
	if (checkedOptions.value.json === true) {
		writeStdout(JSON.stringify(result.value, null, 2));
	} else {
		writeStdout(renderHuman(result.value));
	}
	return result;
}
