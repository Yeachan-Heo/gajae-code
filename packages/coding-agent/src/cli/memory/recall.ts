/** Execute `gjc memory recall` through the public deterministic retrieval operation. */
import {
	MEMORY_EXIT_CODES,
	type MemoryEnvironment,
	type MemoryResult,
	type MemoryScopeKind,
	type RecallInput,
	type RecallResult,
	recall,
} from "@gajae-code/memory-core";

const MEMORY_SCOPES = ["global", "project", "session"] as const satisfies readonly MemoryScopeKind[];
const MAX_RESULT_LIMIT = 20;

export type MemoryRecallCommandResult = RecallResult;
export interface MemoryRecallCommandOptions {
	readonly json?: boolean;
	readonly requireResolved?: boolean;
	readonly explain?: boolean;
}

export type MemoryRecallCommandFlags = MemoryRecallCommandOptions;

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

function validOptions(options: MemoryRecallCommandOptions): MemoryResult<MemoryRecallCommandOptions> {
	if (options === null || typeof options !== "object" || Array.isArray(options)) {
		return invalid("memory recall options must be an object");
	}
	if (options.json !== undefined && typeof options.json !== "boolean") {
		return invalid("memory recall json option must be boolean");
	}
	if (options.requireResolved !== undefined && typeof options.requireResolved !== "boolean") {
		return invalid("memory recall requireResolved option must be boolean");
	}
	if (options.explain !== undefined && typeof options.explain !== "boolean") {
		return invalid("memory recall explain option must be boolean");
	}

	return { ok: true, value: options };
}

function normalizeInput(input: RecallInput): MemoryResult<RecallInput> {
	if (input === null || typeof input !== "object" || Array.isArray(input)) {
		return invalid("memory recall input must be an object");
	}
	if (typeof input.query !== "string" || input.query.normalize("NFC").trim().length === 0) {
		return invalid("memory recall query must be a non-empty string");
	}
	const query = input.query.normalize("NFC");
	if (
		[...query].some(character => {
			const codePoint = character.codePointAt(0);
			return codePoint !== undefined && codePoint < 0x20 && character !== "\t";
		})
	) {
		return invalid("memory recall query contains a control character");
	}

	let scopes: readonly MemoryScopeKind[] | undefined;
	if (input.scopes !== undefined) {
		if (!Array.isArray(input.scopes) || input.scopes.length === 0)
			return invalid("memory recall scopes must not be empty");
		const normalizedScopes: MemoryScopeKind[] = [];
		for (const scope of input.scopes) {
			if (typeof scope !== "string") return invalid("memory recall scope must be a string");
			const normalized = scope.normalize("NFC").toLowerCase();
			if (!(MEMORY_SCOPES as readonly string[]).includes(normalized)) {
				return invalid(`memory recall scope is unsupported: ${scope}`);
			}
			if (!normalizedScopes.includes(normalized as MemoryScopeKind))
				normalizedScopes.push(normalized as MemoryScopeKind);
		}
		scopes = Object.freeze(normalizedScopes);
	}
	if (input.limit !== undefined && (!Number.isSafeInteger(input.limit) || input.limit <= 0)) {
		return invalid("memory recall limit must be a positive integer");
	}
	if (input.complete !== undefined && typeof input.complete !== "boolean") {
		return invalid("memory recall complete option must be boolean");
	}
	if (input.intent !== undefined && typeof input.intent !== "string") {
		return invalid("memory recall intent must be a string");
	}
	if (input.requireResolved !== undefined && typeof input.requireResolved !== "boolean") {
		return invalid("memory recall requireResolved input must be boolean");
	}
	if (input.explain !== undefined && typeof input.explain !== "boolean") {
		return invalid("memory recall explain input must be boolean");
	}

	const limit = input.limit === undefined ? undefined : Math.min(input.limit, MAX_RESULT_LIMIT);
	return {
		ok: true,
		value: {
			query,
			...(input.intent === undefined ? {} : { intent: input.intent }),
			...(scopes === undefined ? {} : { scopes }),
			...(limit === undefined ? {} : { limit }),
			...(input.complete === undefined ? {} : { complete: input.complete }),
			...(input.requireResolved === undefined ? {} : { requireResolved: input.requireResolved }),
			...(input.explain === undefined ? {} : { explain: input.explain }),
		},
	};
}

function writeStdout(value: string): void {
	process.stdout.write(`${value}\n`);
}

interface CitationView {
	readonly uri: string;
	readonly scope: string;
	readonly relPath: string;
	readonly heading: string;
	readonly startLine: number;
	readonly endLine: number;
	readonly authority: string;
	readonly volatility: string;
	readonly updatedAt: string;
	readonly digest: string;
	readonly score?: number;
	readonly stage?: string;
}

function renderCitation(index: number, citation: CitationView): string {
	return [
		`${index}. ${citation.uri}`,
		`scope=${citation.scope}`,
		`relPath=${citation.relPath}`,
		`heading=${citation.heading}`,
		`lines=${citation.startLine}-${citation.endLine}`,
		`authority=${citation.authority}`,
		`volatility=${citation.volatility}`,
		`updatedAt=${citation.updatedAt}`,
		...(citation.score === undefined ? [] : [`score=${citation.score}`]),
		...(citation.stage === undefined ? [] : [`stage=${citation.stage}`]),
		`digest=${citation.digest}`,
	].join(" ");
}

function renderHuman(result: RecallResult): string {
	const lines = [
		`query: ${result.query}`,
		`intent: ${result.intent}`,
		`projectKey: ${result.projectKey}`,
		`status: ${result.status}`,
		`truncated: ${result.truncated ? "yes" : "no"}`,
	];
	if (result.ledgerId !== null) lines.push(`ledgerId: ${result.ledgerId}`);
	if (result.sources.length === 0) {
		lines.push("sources: none");
	} else {
		lines.push("sources:");
		for (const [index, source] of result.sources.entries()) lines.push(renderCitation(index + 1, source));
	}
	if (result.resolutions.length === 0) {
		lines.push("resolutions: none");
	} else {
		for (const [index, resolution] of result.resolutions.entries()) {
			lines.push(`resolution ${index + 1}: ${JSON.stringify(resolution)}`);
		}
	}
	if (result.volatileClaims.length === 0) {
		lines.push("volatile claims: none");
	} else {
		for (const [index, claim] of result.volatileClaims.entries()) {
			const verification = claim.verificationRequired ? "required" : "not-required";
			const hint = claim.verificationHint === null ? "" : ` hint=${JSON.stringify(claim.verificationHint)}`;
			lines.push(`volatile claim ${index + 1}: ${claim.claim} (verification=${verification}${hint})`);
		}
	}
	return lines.join("\n");
}

/** Recall claims and render sources, resolutions, and volatile verification hints. */
export async function runRecallCommand(
	environment: MemoryEnvironment,
	input: RecallInput,
	options: MemoryRecallCommandOptions = {},
): Promise<MemoryResult<RecallResult>> {
	const checkedOptions = validOptions(options);
	if (!checkedOptions.ok) return checkedOptions;
	const checkedInput = normalizeInput(input);
	if (!checkedInput.ok) return checkedInput;
	const result = await recall(environment, {
		...checkedInput.value,
		...(checkedOptions.value.requireResolved === true ? { requireResolved: true } : {}),
		...(checkedOptions.value.explain === true ? { explain: true } : {}),
	});
	if (!result.ok) return result;
	if (checkedOptions.value.json === true) {
		writeStdout(JSON.stringify(result.value, null, 2));
	} else {
		writeStdout(renderHuman(result.value));
	}
	return result;
}
