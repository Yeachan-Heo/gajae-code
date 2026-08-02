export type OAuthCredentials = {
	refresh: string;
	access: string;
	expires: number;
	enterpriseUrl?: string;
	projectId?: string;
	email?: string;
	accountId?: string;
};

export type OAuthProvider =
	| "alibaba-token-plan"
	| "anthropic"
	| "bizrouter"
	| "mara"
	| "cerebras"
	| "cloudflare-ai-gateway"
	| "cursor"
	| "deepseek"
	| "deepinfra"
	| "fireworks"
	| "firepass"
	| "fugu"
	| "github-copilot"
	| "google-gemini-cli"
	| "google-antigravity"
	| "gitlab-duo"
	| "huggingface"
	| "kimi-code"
	| "kilo"
	| "kagi"
	| "litellm"
	| "lm-studio"
	| "minimax-code"
	| "minimax-code-cn"
	| "moonshot"
	| "nvidia"
	| "nanogpt"
	| "ollama"
	| "ollama-cloud"
	| "openai-codex"
	| "openai-codex-device"
	| "opencode-go"
	| "opencode-zen"
	| "opengateway"
	| "parallel"
	| "perplexity"
	| "qianfan"
	| "qwen-portal"
	| "synthetic"
	| "tavily"
	| "together"
	| "venice"
	| "vercel-ai-gateway"
	| "vllm"
	| "xai"
	| "glm-zcode"
	| "xiaomi"
	| "xiaomi-token-plan-sgp"
	| "xiaomi-token-plan-ams"
	| "xiaomi-token-plan-cn"
	| "zenmux"
	| "opencodex"
	| "zai";

export type OAuthProviderId = OAuthProvider | (string & {});

export type OAuthPrompt = {
	message: string;
	placeholder?: string;
	allowEmpty?: boolean;
};

export type OAuthAuthInfo = {
	url: string;
	instructions?: string;
};

export interface OAuthProviderInfo {
	id: OAuthProviderId;
	name: string;
	available: boolean;
}

/** Per-login switches that change how the authorization code is delivered. */
export interface OAuthLoginOptions {
	/**
	 * Pair by pasting the authorization code the provider displays instead of
	 * waiting on a local loopback callback. Set when the browser completing the
	 * login has no network route back to the machine running gjc (SSH, remote
	 * container, headless host). Providers without a paste-a-code redirect
	 * ignore it.
	 */
	manualCode?: boolean;
}

export interface OAuthController {
	onAuth?(info: OAuthAuthInfo): void;
	onProgress?(message: string): void;
	onManualCodeInput?(): Promise<string>;
	onPrompt?(prompt: OAuthPrompt): Promise<string>;
	signal?: AbortSignal;
	fetch?: typeof globalThis.fetch;
}

export interface OAuthLoginCallbacks extends OAuthController {
	onAuth: (info: OAuthAuthInfo) => void;
	onPrompt: (prompt: OAuthPrompt) => Promise<string>;
}

export interface OAuthProviderInterface {
	readonly id: OAuthProviderId;
	readonly name: string;
	readonly sourceId?: string;
	login(callbacks: OAuthLoginCallbacks): Promise<OAuthCredentials | string>;
	refreshToken?(credentials: OAuthCredentials): Promise<OAuthCredentials>;
	getApiKey?(credentials: OAuthCredentials): string;
}
