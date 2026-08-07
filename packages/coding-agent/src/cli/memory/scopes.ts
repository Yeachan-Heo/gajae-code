/** Execute `gjc memory scopes` through the public memory-core scope resolver. */
import {
	MEMORY_EXIT_CODES,
	type MemoryEnvironment,
	type MemoryResult,
	resolveScopes,
	type ScopeResolution,
} from "@gajae-code/memory-core";

export interface MemoryScopesCommandOptions {
	readonly json?: boolean;
}

export type MemoryScopesCommandFlags = MemoryScopesCommandOptions;

export type MemoryScopeDescriptor = ScopeResolution["scopes"][number];

export type MemoryScopesCommandResult = ScopeResolution;

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

function validOptions(options: MemoryScopesCommandOptions): MemoryResult<MemoryScopesCommandOptions> {
	if (options === null || typeof options !== "object" || Array.isArray(options)) {
		return invalid("memory scopes options must be an object");
	}
	if (options.json !== undefined && typeof options.json !== "boolean") {
		return invalid("memory scopes json option must be boolean");
	}
	return { ok: true, value: options };
}

function writeStdout(value: string): void {
	process.stdout.write(`${value}\n`);
}

function renderHuman(result: MemoryScopesCommandResult): string {
	return result.scopes
		.map(scope => {
			const state = scope.writable ? "writable" : "read-only";
			const root = scope.root ?? "unresolved";
			const availability = scope.available ? "" : "; unavailable";
			const reason = scope.unavailableReason === null ? "" : ` — ${scope.unavailableReason}`;
			return `${scope.kind}: ${root} (${state}${availability})${reason}`;
		})
		.join("\n");
}

/** Resolve and render exactly the global, project, and session descriptors. */
export async function runScopesCommand(
	environment: MemoryEnvironment,
	options: MemoryScopesCommandOptions = {},
): Promise<MemoryResult<MemoryScopesCommandResult>> {
	const checkedOptions = validOptions(options);
	if (!checkedOptions.ok) return checkedOptions;
	const result = await resolveScopes(environment);
	if (!result.ok) return result;
	const value = result.value;
	if (checkedOptions.value.json === true) {
		writeStdout(JSON.stringify(value, null, 2));
	} else {
		writeStdout(renderHuman(value));
	}
	return { ok: true, value };
}
