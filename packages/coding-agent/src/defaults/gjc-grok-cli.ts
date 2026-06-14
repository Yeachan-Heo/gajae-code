import type { ExtensionFactory } from "../extensibility/extensions/types";
import grokCliModelDefaults from "./gjc/agent.models.grok-cli.yml" with { type: "text" };
import grokBuildExtensionFactory from "./gjc/extensions/grok-build/index";

export const BUNDLED_GROK_BUILD_EXTENSION_ID = "bundled:grok-build";

export function getBundledGrokBuildExtensionFactory(): ExtensionFactory {
	return grokBuildExtensionFactory;
}

export function getBundledGrokCliModelDefaults(): string {
	return grokCliModelDefaults;
}

export async function assertBundledGrokCliDefaults(): Promise<void> {
	if (typeof grokBuildExtensionFactory !== "function") {
		throw new Error("Bundled Grok Build extension factory is missing");
	}
	if (!grokCliModelDefaults.includes("grok-composer-2.5-fast")) {
		throw new Error("Bundled Grok Build model defaults are missing Composer 2.5 Fast");
	}
}
