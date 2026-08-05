import type { ThinkingLevel } from "@gajae-code/agent-core";
import type { Api, Model } from "@gajae-code/ai/core";
import { $pickenv } from "@gajae-code/utils";
import { parseFileDiffs } from "../../commit/git/diff";
import type { ConventionalAnalysis } from "../../commit/types";
import { isExcludedFile } from "../../commit/utils/exclusions";
import { runMapPhase } from "./map-phase";
import { runReducePhase } from "./reduce-phase";
import { estimateTokens } from "./utils";

const MIN_FILES_FOR_MAP_REDUCE = 4;
const MAX_FILE_TOKENS = 50_000;

export interface MapReduceSettings {
	enabled?: boolean;
	minFiles?: number;
	maxFileTokens?: number;
	maxConcurrency?: number;
	timeoutMs?: number;
}

export interface MapReduceInput {
	model: Model<Api>;
	apiKey: string;
	thinkingLevel?: ThinkingLevel;
	smolModel: Model<Api>;
	smolApiKey: string;
	smolThinkingLevel?: ThinkingLevel;
	diff: string;
	stat: string;
	scopeCandidates: string;
	typesDescription?: string;
	settings?: MapReduceSettings;
}

export function shouldUseMapReduce(diff: string, settings?: MapReduceSettings): boolean {
	if ($pickenv("GJC_COMMIT_MAP_REDUCE", "PI_COMMIT_MAP_REDUCE")?.toLowerCase() === "false") return false;
	if (settings?.enabled === false) return false;
	const minFiles = settings?.minFiles ?? MIN_FILES_FOR_MAP_REDUCE;
	const maxFileTokens = settings?.maxFileTokens ?? MAX_FILE_TOKENS;
	const files = parseFileDiffs(diff).filter(file => !isExcludedFile(file.filename));
	const fileCount = files.length;
	if (fileCount >= minFiles) return true;
	return files.some(file => estimateTokens(file.content) > maxFileTokens);
}

/**
 * Run map-reduce analysis for large diffs using smol + primary models.
 */

export async function runMapReduceAnalysis(input: MapReduceInput): Promise<ConventionalAnalysis> {
	const fileDiffs = parseFileDiffs(input.diff).filter(file => !isExcludedFile(file.filename));
	const observations = await runMapPhase({
		model: input.smolModel,
		apiKey: input.smolApiKey,
		thinkingLevel: input.smolThinkingLevel,
		files: fileDiffs,
		config: input.settings,
	});
	return runReducePhase({
		model: input.model,
		apiKey: input.apiKey,
		thinkingLevel: input.thinkingLevel,
		observations,
		stat: input.stat,
		scopeCandidates: input.scopeCandidates,
		typesDescription: input.typesDescription,
	});
}
