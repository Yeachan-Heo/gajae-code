import browserAsidePrompt from "./prompts/agent-fragments/browser-aside.md" with { type: "text" };

export type BrowserBackendId = "native" | "aside";

export interface BrowserBackend {
	readonly id: BrowserBackendId;
	readonly exposesBuiltinTool: boolean;
	readonly developerInstructions?: string;
}

interface BrowserBackendSettingsSource {
	get(key: string): unknown;
}

const nativeBrowserBackend: BrowserBackend = {
	id: "native",
	exposesBuiltinTool: true,
};

const asideBrowserBackend: BrowserBackend = {
	id: "aside",
	exposesBuiltinTool: false,
	developerInstructions: browserAsidePrompt.trim(),
};

/** Resolve the configured browser backend. Aside is strictly opt-in. */
export function resolveBrowserBackend(settings: BrowserBackendSettingsSource): BrowserBackend {
	return settings.get("browser.backend") === "aside" ? asideBrowserBackend : nativeBrowserBackend;
}
