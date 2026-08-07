/** Execute `gjc memory get` through the policy-checked memory-core resource resolver. */
import {
	MEMORY_EXIT_CODES,
	type MemoryCitation,
	type MemoryEnvironment,
	type MemoryResult,
	type ResolveReadableResourceResult,
	resolveReadableResource,
} from "@gajae-code/memory-core";

export interface MemoryGetCommandOptions {
	readonly json?: boolean;
}

export type MemoryGetCommandFlags = MemoryGetCommandOptions;

export interface MemoryGetResult {
	readonly schemaVersion: "gajae.memory.resource.v1";
	readonly uri: string;
	readonly relPath: string;
	readonly contentType: string;
	readonly content: string;
	readonly size?: number;
	readonly digest?: string;
	readonly citation?: MemoryCitation;
}

export type MemoryGetCommandResult = MemoryGetResult;

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

function validOptions(options: MemoryGetCommandOptions): MemoryResult<MemoryGetCommandOptions> {
	if (options === null || typeof options !== "object" || Array.isArray(options)) {
		return invalid("memory get options must be an object");
	}
	if (options.json !== undefined && typeof options.json !== "boolean") {
		return invalid("memory get json option must be boolean");
	}
	return { ok: true, value: options };
}

function validUri(uri: string): MemoryResult<string> {
	if (typeof uri !== "string" || uri.trim().length === 0) return invalid("memory URI must be a non-empty string");
	if (uri.includes("\u0000") || [...uri].some(character => character.charCodeAt(0) < 0x20)) {
		return invalid("memory URI contains a control character");
	}
	return { ok: true, value: uri };
}

function writeStdout(value: string): void {
	process.stdout.write(value);
}

function writeJson(value: MemoryGetResult): void {
	writeStdout(`${JSON.stringify(value, null, 2)}\n`);
}

/** Resolve a URI and print only its content in human mode, or a versioned resource envelope in JSON mode. */
export async function runGetCommand(
	environment: MemoryEnvironment,
	uri: string,
	options: MemoryGetCommandOptions = {},
): Promise<MemoryResult<MemoryGetResult>> {
	const checkedOptions = validOptions(options);
	if (!checkedOptions.ok) return checkedOptions;
	const checkedUri = validUri(uri);
	if (!checkedUri.ok) return checkedUri;
	const result = await resolveReadableResource(environment, { uri: checkedUri.value });
	if (!result.ok) return result;
	const resource: ResolveReadableResourceResult = result.value;
	const value: MemoryGetResult = {
		schemaVersion: "gajae.memory.resource.v1",
		uri: resource.uri ?? checkedUri.value,
		relPath: resource.relPath,
		contentType: resource.contentType,
		content: resource.content,
		...(resource.size === undefined ? {} : { size: resource.size }),
		...(resource.digest === undefined ? {} : { digest: resource.digest }),
		...(resource.citation === undefined ? {} : { citation: resource.citation }),
	};
	if (checkedOptions.value.json === true) {
		writeJson(value);
	} else {
		writeStdout(value.content);
		if (!value.content.endsWith("\n")) writeStdout("\n");
	}
	return { ok: true, value };
}
