import { describe, expect, it } from "bun:test";
import type {
	ActiveProviderConnectionKind,
	ActiveProviderDescriptor,
	ModelProfileCatalogItem,
	ModelProfileErrorDetails,
	Q10CurrentThinkingLevel,
	Q10Model,
	Q10SettableThinkingLevel,
	Q10ThinkingCapabilities,
	Q10ThinkingEffort,
	Q10ThinkingMode,
	TurnPromptAcceptedResult,
	TurnPromptInput,
	TurnPromptReconciliation,
	TurnPromptStatusSelector,
} from "@gajae-code/coding-agent/sdk";
import * as publicSdk from "@gajae-code/coding-agent/sdk";
import * as bus from "@gajae-code/coding-agent/sdk/bus";
import packageJson from "../package.json";
import * as root from "../src/index";
import * as sdk from "../src/sdk";
import * as session from "../src/sdk/session";

const sdkCapabilityDtoTypes:
	| [
			Q10Model,
			Q10ThinkingCapabilities,
			Q10ThinkingEffort,
			Q10SettableThinkingLevel,
			Q10CurrentThinkingLevel,
			Q10ThinkingMode,
			ModelProfileCatalogItem,
			ModelProfileErrorDetails,
			TurnPromptAcceptedResult,
			TurnPromptReconciliation,
			TurnPromptStatusSelector,
			TurnPromptInput,
	  ]
	| undefined = undefined;

const q28DtoTypes: [ActiveProviderDescriptor, ActiveProviderConnectionKind] | undefined = undefined;

void sdkCapabilityDtoTypes;
void q28DtoTypes;

describe("SDK package exports", () => {
	it("preserves the session SDK surface and bus namespace after the namespace move", () => {
		for (const exportName of Object.keys(session)) expect(sdk).toHaveProperty(exportName);
		expect(sdk).toHaveProperty("bus");
		expect(root).toHaveProperty("createAgentSession");
	});

	it("loads the public SDK and bus package subpaths", () => {
		expect(publicSdk.createAgentSession).toBeFunction();
		expect(bus.createNotificationsExtension).toBeFunction();
		expect(publicSdk.UnknownModelProfileError).toBeFunction();
		expect(publicSdk.ModelProfileRegistryError).toBeFunction();
		expect(publicSdk.MODEL_PROFILE_DISCOVERY_QUERY).toBe("models.profiles.list");
	});

	it.each([
		"@gajae-code/coding-agent/sdk/models",
		"@gajae-code/coding-agent/sdk/models.js",
		"@gajae-code/coding-agent/sdk/lifecycle-session",
		"@gajae-code/coding-agent/sdk/lifecycle-session.js",
		"@gajae-code/coding-agent/sdk/startup-capability",
		"@gajae-code/coding-agent/sdk/startup-capability.js",
		"@gajae-code/coding-agent/sdk/providers",
		"@gajae-code/coding-agent/sdk/providers.js",
	])("rejects resolution of the private %s subpath", async subpath => {
		const child = Bun.spawn([process.execPath, "-e", `await import(${JSON.stringify(subpath)})`], {
			cwd: import.meta.dir,
			stdout: "pipe",
			stderr: "pipe",
		});
		const [stdout, stderr, exitCode] = await Promise.all([
			new Response(child.stdout).text(),
			new Response(child.stderr).text(),
			child.exited,
		]);
		const output = `${stdout}${stderr}`;

		expect(exitCode).not.toBe(0);
		expect(output).toMatch(/error/i);
		expect(output).toContain(subpath);
	});

	it("keeps internal SDK modules off the public package surface", () => {
		for (const subpath of [
			"./sdk/models",
			"./sdk/models.js",
			"./sdk/lifecycle-session",
			"./sdk/lifecycle-session.js",
			"./sdk/startup-capability",
			"./sdk/startup-capability.js",
			"./sdk/providers",
			"./sdk/providers.js",
		] as const)
			expect(packageJson.exports[subpath]).toBeNull();
	});
});
