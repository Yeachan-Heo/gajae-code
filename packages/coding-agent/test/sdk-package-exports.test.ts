import { describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
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

const q29DtoTypes: [ActiveProviderDescriptor, ActiveProviderConnectionKind] | undefined = undefined;

void sdkCapabilityDtoTypes;
void q29DtoTypes;

describe("SDK package exports", () => {
	it("preserves the session SDK surface and bus namespace after the namespace move", () => {
		for (const exportName of Object.keys(session)) expect(sdk).toHaveProperty(exportName);
		expect(sdk).toHaveProperty("bus");
		expect(root).toHaveProperty("createAgentSession");
	});

	it("keeps concrete tool classes behind the opt-in implementation barrel", async () => {
		const implementations = await import("@gajae-code/coding-agent/tools/implementations");
		expect(implementations.BashTool).toBeFunction();
		expect(implementations.ReadTool).toBeFunction();
		expect(implementations.WebSearchTool).toBeFunction();
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

	it("resolves every declared export target to a file that exists", () => {
		// A removed module can leave its exports entry behind: the package then
		// advertises a subpath that fails to resolve for consumers, and nothing in
		// the tree references it, so no import breaks to signal the drift.
		const packageDir = path.dirname(import.meta.dir); // packages/coding-agent
		const missing: string[] = [];

		const walk = (value: unknown, label: string): void => {
			if (value === null) return;
			if (typeof value === "string") {
				if (!value.startsWith("./") || value.includes("*")) return;
				if (!fs.existsSync(path.join(packageDir, value))) missing.push(`${label} -> ${value}`);
				return;
			}
			if (typeof value === "object")
				for (const [key, nested] of Object.entries(value as Record<string, unknown>))
					walk(nested, `${label}/${key}`);
		};

		const manifest = packageJson as unknown as Record<string, unknown>;
		for (const field of ["exports", "main", "module", "types", "bin"])
			if (manifest[field] !== undefined) walk(manifest[field], field);

		expect(missing).toEqual([]);
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
