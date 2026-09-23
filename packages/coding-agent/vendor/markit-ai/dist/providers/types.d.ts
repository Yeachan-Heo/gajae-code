import type { MarkitOptions } from "../types.js";
export interface ProviderConfig {
    apiKey?: string;
    apiBase?: string;
    model?: string;
    transcriptionModel?: string;
}
export interface Provider {
    name: string;
    /** Env vars to check for API key, in priority order */
    envKeys: string[];
    /** Default API base URL */
    defaultBase: string;
    /** Default model for image description */
    defaultModel: string;
    /** Default model for audio transcription (if supported) */
    defaultTranscriptionModel?: string;
    /** Build describe/transcribe functions from resolved config */
    create(config: ResolvedConfig, prompt: string): MarkitOptions;
}
export interface ResolvedConfig {
    apiKey: string;
    apiBase: string;
    model: string;
    transcriptionModel?: string;
}
