import { describe, expect, it } from "bun:test";
import * as path from "node:path";
import { BUILTIN_MODEL_PROFILES } from "../src/config/model-profiles";
import {
	getBundledGrokBuildExtensionDir,
	getBundledGrokBuildExtensionPath,
	getBundledGrokCliModelDefaultsPath,
	getBundledGrokCliVendorDir,
} from "../src/defaults/gjc-grok-cli";

describe("Grok Build post-merge sequence", () => {
	it("ships the extension, vendor tree, reference models, and grok-build-pro profile needed by the user flow", async () => {
		expect(await Bun.file(getBundledGrokBuildExtensionPath()).exists()).toBe(true);
		expect(await Bun.file(path.join(getBundledGrokBuildExtensionDir(), "package.json")).exists()).toBe(true);
		expect(await Bun.file(path.join(getBundledGrokCliVendorDir(), "src", "provider", "register.ts")).exists()).toBe(
			true,
		);
		expect(await Bun.file(getBundledGrokCliModelDefaultsPath()).exists()).toBe(true);

		const profile = BUILTIN_MODEL_PROFILES.find(definition => definition.name === "grok-build-pro");
		expect(profile?.requiredProviders).toContain("grok-build");
		expect(profile?.modelMapping.default).toBe("grok-build/grok-composer-2.5-fast");
		expect(profile?.modelMapping.executor).toBe("grok-build/grok-build");
	});
});
