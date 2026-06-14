import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "../src/config/settings";
import type { ExtensionAPI } from "../src/extensibility/extensions";
import { createAgentSession } from "../src/sdk";
import { SessionManager } from "../src/session/session-manager";

function registerTestProvider(api: ExtensionAPI, providerName: string): void {
	api.registerProvider(providerName, {
		baseUrl: "https://example.invalid/v1",
		apiKey: "$THIRD_PARTY_TEST_KEY",
		api: "openai-responses",
		models: [
			{
				id: "model",
				name: "Model",
				reasoning: false,
				input: ["text"],
				cost: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 1000,
				maxTokens: 100,
			},
		],
	});
}

describe("Grok Build with explicit third-party extensions", () => {
	it("loads bundled and inline extensions while keeping filesystem paths quarantined", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-grok-third-party-"));
		const extensionPath = path.join(root, "third-party.ts");
		await Bun.write(
			extensionPath,
			`export default function thirdParty(api) { api.registerProvider("filesystem-test", { name: "Filesystem", baseUrl: "https://example.invalid/v1", apiKey: "$THIRD_PARTY_TEST_KEY", api: "openai-responses", models: [{ id: "model", name: "Model", reasoning: false, input: ["text"], cost: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 }, contextWindow: 1000, maxTokens: 100 }] }); }`,
		);
		try {
			const { session } = await createAgentSession({
				cwd: root,
				agentDir: root,
				settings: Settings.isolated(),
				sessionManager: SessionManager.inMemory(root),
				disableExtensionDiscovery: true,
				additionalExtensionPaths: [extensionPath],
				extensions: [api => registerTestProvider(api, "inline-test")],
				skills: [],
				rules: [],
				contextFiles: [],
				promptTemplates: [],
				slashCommands: [],
				enableMCP: false,
				enableLsp: false,
				toolNames: ["__none__"],
			});
			try {
				expect(session.modelRegistry.find("grok-build", "grok-composer-2.5-fast")).toBeTruthy();
				expect(session.modelRegistry.find("inline-test", "model")).toBeTruthy();
				expect(session.modelRegistry.find("filesystem-test", "model")).toBeUndefined();
			} finally {
				await session.dispose();
			}
		} finally {
			await fs.rm(root, { recursive: true, force: true });
		}
	});
});
