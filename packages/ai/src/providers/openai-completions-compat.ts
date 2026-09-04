/**
 * Backward-compatible provider-path re-export. The implementation lives in
 * the core-safe module so model metadata can use it without loading provider
 * implementations during startup.
 */
export {
	detectOpenAICompat,
	type GrokGeneration,
	isDirectXaiReasoningEffortModel,
	parseDirectXaiReasoningEffortGeneration,
	type ResolvedOpenAICompat,
	resolveOpenAICompat,
} from "../openai-completions-compat";
