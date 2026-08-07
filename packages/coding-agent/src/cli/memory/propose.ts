/** Execute `gjc memory propose` through the public memory-core write operation. */
import {
	MEMORY_EXIT_CODES,
	type MemoryDocumentType,
	type MemoryEnvironment,
	type MemoryResult,
	type MemoryScopeKind,
	type ProposeInput,
	propose,
	type WriteProposal,
} from "@gajae-code/memory-core";

const MEMORY_DOCUMENT_TYPES = Object.freeze([
	"preference",
	"constraint",
	"policy",
	"convention",
	"decision",
	"fact",
	"observation",
	"hypothesis",
	"task-state",
	"handoff",
	"checkpoint",
	"note",
] as const satisfies readonly MemoryDocumentType[]);
const MEMORY_SCOPES = Object.freeze(["global", "project", "session"] as const satisfies readonly MemoryScopeKind[]);

export interface MemoryProposeCommandOptions {
	readonly json?: boolean;
}

export type MemoryProposeCommandFlags = MemoryProposeCommandOptions;
export type MemoryProposeCommandResult = WriteProposal;

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

function validOptions(options: MemoryProposeCommandOptions): MemoryResult<MemoryProposeCommandOptions> {
	if (options === null || typeof options !== "object" || Array.isArray(options)) {
		return invalid("memory propose options must be an object");
	}
	if (options.json !== undefined && typeof options.json !== "boolean") {
		return invalid("memory propose json option must be boolean");
	}
	return { ok: true, value: options };
}

function controlCharacter(value: string): boolean {
	return [...value].some(character => {
		const codePoint = character.codePointAt(0);
		return (
			codePoint !== undefined &&
			((codePoint < 0x20 && character !== "\n" && character !== "\t") || codePoint === 0x7f)
		);
	});
}

function normalizeInput(input: ProposeInput): MemoryResult<ProposeInput> {
	if (input === null || typeof input !== "object" || Array.isArray(input)) {
		return invalid("memory propose input must be an object");
	}
	const candidate = input as unknown as Readonly<Record<string, unknown>>;
	if (typeof candidate.type !== "string" || !(MEMORY_DOCUMENT_TYPES as readonly string[]).includes(candidate.type)) {
		return invalid("memory propose type is invalid");
	}
	if (typeof candidate.content !== "string" || candidate.content.normalize("NFC").trim().length === 0) {
		return invalid("memory propose content must be a non-empty string");
	}
	const content = candidate.content.normalize("NFC");
	if (controlCharacter(content)) return invalid("memory propose content contains a control character");

	let targetScope: MemoryScopeKind | undefined;
	if (candidate.targetScope !== undefined) {
		if (typeof candidate.targetScope !== "string") return invalid("memory propose target scope is invalid");
		const normalized = candidate.targetScope.normalize("NFC").trim().toLowerCase();
		if (!(MEMORY_SCOPES as readonly string[]).includes(normalized)) {
			return invalid("memory propose target scope is invalid");
		}
		targetScope = normalized as MemoryScopeKind;
	}

	let targetUri: string | undefined;
	if (candidate.targetUri !== undefined) {
		if (typeof candidate.targetUri !== "string") return invalid("memory propose target URI is invalid");
		targetUri = candidate.targetUri.normalize("NFC").trim();
		if (targetUri.length === 0) return invalid("memory propose target URI is invalid");
		if (controlCharacter(targetUri)) return invalid("memory propose target URI contains a control character");
	}

	let supersedes: readonly string[] | undefined;
	if (candidate.supersedes !== undefined) {
		if (!Array.isArray(candidate.supersedes)) return invalid("memory propose supersedes must be an array of strings");
		const normalized: string[] = [];
		for (const value of candidate.supersedes) {
			if (typeof value !== "string") return invalid("memory propose supersedes must be an array of strings");
			const item = value.normalize("NFC").trim();
			if (item.length === 0) return invalid("memory propose supersedes must not contain blank values");
			if (controlCharacter(item)) return invalid("memory propose supersedes contains a control character");
			normalized.push(item);
		}
		supersedes = Object.freeze(normalized);
	}

	return {
		ok: true,
		value: {
			type: candidate.type as MemoryDocumentType,
			content,
			...(targetScope === undefined ? {} : { targetScope }),
			...(targetUri === undefined ? {} : { targetUri }),
			...(supersedes === undefined ? {} : { supersedes }),
		},
	};
}

function writeStdout(value: string): void {
	process.stdout.write(`${value}\n`);
}

function renderConflict(conflict: WriteProposal["conflicts"][number]): string {
	return JSON.stringify(conflict);
}

function renderHuman(result: MemoryProposeCommandResult): string {
	const conflicts = result.conflicts.length === 0 ? "none" : result.conflicts.map(renderConflict).join("; ");
	return [
		`proposalId: ${result.proposalId}`,
		`recommendedUri: ${result.recommendedUri}`,
		`requiresApproval: ${result.requiresApproval ? "true" : "false"}`,
		`conflicts: ${conflicts}`,
	].join("\n");
}

/** Stage a deterministic write proposal and render only successful results. */
export async function runProposeCommand(
	environment: MemoryEnvironment,
	input: ProposeInput,
	options: MemoryProposeCommandOptions = {},
): Promise<MemoryResult<MemoryProposeCommandResult>> {
	const checkedOptions = validOptions(options);
	if (!checkedOptions.ok) return checkedOptions;
	const checkedInput = normalizeInput(input);
	if (!checkedInput.ok) return checkedInput;
	const result = await propose(environment, checkedInput.value);
	if (!result.ok) return result;
	if (checkedOptions.value.json === true) {
		writeStdout(JSON.stringify(result.value, null, 2));
	} else {
		writeStdout(renderHuman(result.value));
	}
	return result;
}
