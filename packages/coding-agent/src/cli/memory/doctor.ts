/** Execute `gjc memory doctor` through the public memory-core audit operation. */
import {
	type DoctorFinding,
	type DoctorInput,
	type DoctorResult,
	doctor,
	MEMORY_EXIT_CODES,
	type MemoryEnvironment,
	type MemoryResult,
} from "@gajae-code/memory-core";

export interface MemoryDoctorCommandOptions {
	readonly json?: boolean;
}

export type MemoryDoctorCommandFlags = MemoryDoctorCommandOptions;

export type MemoryDoctorCommandResult = DoctorResult;

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

function validOptions(options: MemoryDoctorCommandOptions): MemoryResult<MemoryDoctorCommandOptions> {
	if (options === null || typeof options !== "object" || Array.isArray(options)) {
		return invalid("memory doctor options must be an object");
	}
	if (options.json !== undefined && typeof options.json !== "boolean") {
		return invalid("memory doctor json option must be boolean");
	}
	return { ok: true, value: options };
}

function validInput(input: DoctorInput): MemoryResult<DoctorInput> {
	if (input === null || typeof input !== "object" || Array.isArray(input)) {
		return invalid("memory doctor input must be an object");
	}
	if (input.maxBytes !== undefined && (!Number.isSafeInteger(input.maxBytes) || input.maxBytes <= 0)) {
		return invalid("memory doctor maxBytes must be a positive safe integer");
	}
	return { ok: true, value: input };
}

function writeStdout(value: string): void {
	process.stdout.write(`${value}\n`);
}

function renderFinding(finding: DoctorFinding): string {
	const path = finding.relPath ?? "store-wide";
	return `finding: severity=${finding.severity} code=${finding.code} path=${path} detail=${finding.detail}`;
}

function renderHuman(result: MemoryDoctorCommandResult): string {
	return [`healthy: ${result.healthy}`, ...result.findings.map(renderFinding)].join("\n");
}

/** Run read-only structural, lifecycle, security, retrieval, and journal checks. */
export async function runDoctorCommand(
	environment: MemoryEnvironment,
	input: DoctorInput = {},
	options: MemoryDoctorCommandOptions = {},
): Promise<MemoryResult<MemoryDoctorCommandResult>> {
	const checkedOptions = validOptions(options);
	if (!checkedOptions.ok) return checkedOptions;
	const checkedInput = validInput(input);
	if (!checkedInput.ok) return checkedInput;
	const result = await doctor(environment, checkedInput.value);
	if (!result.ok) return result;
	if (checkedOptions.value.json === true) {
		writeStdout(JSON.stringify(result.value, null, 2));
	} else {
		writeStdout(renderHuman(result.value));
	}
	return result;
}
