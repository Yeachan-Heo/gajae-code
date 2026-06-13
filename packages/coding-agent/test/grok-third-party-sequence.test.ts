import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "../src/config/settings";
import { createAgentSession } from "../src/sdk";
import { SessionManager } from "../src/session/session-manager";

describe("Grok Build with explicit third-party extensions", () => {
	it("loads bundled Grok Build alongside caller-supplied extension paths", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-grok-third-party-"));
		const extensionPath = path.join(root, "third-party.ts");
		await Bun.write(
			extensionPath,
			`export default function thirdParty(api) { api.registerProvider("third-party-test", { name: "Third Party", baseUrl: "https://example.invalid/v1", apiKey: "$THIRD_PARTY_TEST_KEY", api: "openai-responses", models: [{ id: "model", name: "Model", reasoning: false, input: ["text"], cost: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 }, contextWindow: 1000, maxTokens: 100 }] }); }`,
		);
		try {
			const { session } = await createAgentSession({
				cwd: root,
				agentDir: root,
				settings: Settings.isolated(),
				sessionManager: SessionManager.inMemory(root),
				disableExtensionDiscovery: true,
				additionalExtensionPaths: [extensionPath],
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
				expect(session.modelRegistry.find("third-party-test", "model")).toBeTruthy();
			} finally {
				await session.dispose();
			}
		} finally {
			await fs.rm(root, { recursive: true, force: true });
		}
	});
});
