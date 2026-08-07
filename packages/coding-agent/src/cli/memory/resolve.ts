/** Execute `gjc memory resolve` through the policy-checked memory-core resource resolver. */
import {
	MEMORY_EXIT_CODES,
	type MemoryCitation,
	type MemoryEnvironment,
	type MemoryResult,
	type ResolveReadableResourceResult,
	resolveReadableResource,
} from "@gajae-code/memory-core";

export interface MemoryResolveCommandOptions {
	readonly json?: boolean;
}

export type MemoryResolveCommandFlags = MemoryResolveCommandOptions;

export interface MemoryResourceMetadata {
	readonly schemaVersion: "gajae.memory.resource.v1";
	readonly uri: string;
	readonly relPath: string;
	readonly contentType: string;
	readonly size?: number;
	readonly digest?: string;
	readonly citation?: MemoryCitation;
}

export type MemoryResolveCommandResult = MemoryResourceMetadata;
function metadata(value: ResolveReadableResourceResult, requestedUri: string): MemoryResourceMetadata {
	return {
		schemaVersion: "gajae.memory.resource.v1",
		uri: value.uri ?? requestedUri,
		relPath: value.relPath,
		contentType: value.contentType,
		...(value.size === undefined ? {} : { size: value.size }),
		...(value.digest === undefined ? {} : { digest: value.digest }),
		...(value.citation === undefined ? {} : { citation: value.citation }),
	};
}

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

function validOptions(options: MemoryResolveCommandOptions): MemoryResult<MemoryResolveCommandOptions> {
	if (options === null || typeof options !== "object" || Array.isArray(options)) {
		return invalid("memory resolve options must be an object");
	}
	if (options.json !== undefined && typeof options.json !== "boolean") {
		return invalid("memory resolve json option must be boolean");
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
	process.stdout.write(`${value}\n`);
}

function renderHuman(value: MemoryResourceMetadata): string {
	const lines = [`uri: ${value.uri}`, `relPath: ${value.relPath}`, `contentType: ${value.contentType}`];
	if (value.size !== undefined) lines.push(`size: ${value.size}`);
	if (value.digest !== undefined) lines.push(`digest: ${value.digest}`);
	if (value.citation !== undefined) lines.push(`citation: ${JSON.stringify(value.citation)}`);
	return lines.join("\n");
}

/** Resolve a URI and render canonical resource metadata without exposing content. */
export async function runResolveCommand(
	environment: MemoryEnvironment,
	uri: string,
	options: MemoryResolveCommandOptions = {},
): Promise<MemoryResult<MemoryResourceMetadata>> {
	const checkedOptions = validOptions(options);
	if (!checkedOptions.ok) return checkedOptions;
	const checkedUri = validUri(uri);
	if (!checkedUri.ok) return checkedUri;
	const result = await resolveReadableResource(environment, { uri: checkedUri.value });
	if (!result.ok) return result;
	const value = metadata(result.value, checkedUri.value);
	if (checkedOptions.value.json === true) {
		writeStdout(JSON.stringify(value, null, 2));
	} else {
		writeStdout(renderHuman(value));
	}
	return { ok: true, value };
}
