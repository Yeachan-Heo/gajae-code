export interface MarkitConfig {
    llm?: {
        /** Provider name: "openai" (default), "anthropic", or any registered provider */
        provider?: string;
        /** API base URL (overrides provider default) */
        apiBase?: string;
        /** API key — prefer env vars over storing here */
        apiKey?: string;
        /** Model override (overrides provider default) */
        model?: string;
        /** Transcription model override */
        transcriptionModel?: string;
    };
}
/**
 * Walk up from cwd to find .markit/ directory.
 */
export declare function findConfigDir(): string | null;
/**
 * Load config from .markit/config.json.
 */
export declare function loadConfig(): MarkitConfig;
/**
 * Save config to .markit/config.json. Creates .markit/ if needed.
 */
export declare function saveConfig(config: MarkitConfig): void;
