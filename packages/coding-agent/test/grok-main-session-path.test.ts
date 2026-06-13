import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { getOAuthProviders } from "@gajae-code/ai/utils/oauth";
import { setAgentDir } from "@gajae-code/utils";
import { Settings } from "../src/config/settings";
import { getBundledGrokBuildExtensionPath } from "../src/defaults/gjc-grok-cli";
import { createAgentSession } from "../src/sdk";
import { SessionManager } from "../src/session/session-manager";

describe("bundled Grok Build session path", () => {
	it("loads Grok Build OAuth and models with extension discovery disabled", async () => {
		const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-grok-main-session-"));
		setAgentDir(agentDir);
		try {
			const { session } = await createAgentSession({
				cwd: agentDir,
				agentDir,
				settings: Settings.isolated(),
				sessionManager: SessionManager.inMemory(agentDir),
				disableExtensionDiscovery: true,
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
				const grokModels = session.modelRegistry.getAll().filter(model => model.provider === "grok-build");
				expect(grokModels.some(model => model.id === "grok-composer-2.5-fast")).toBe(true);
				expect(grokModels.some(model => model.id === "grok-build")).toBe(true);
				expect(getOAuthProviders().find(provider => provider.id === "grok-build")?.name).toBe("Grok Build");
				expect(
					(session.extensionRunner as unknown as { extensions?: Array<{ path: string }> } | undefined)?.extensions?.some(
						extension => extension.path === getBundledGrokBuildExtensionPath(),
					),
				).toBe(true);
			} finally {
				await session.dispose();
			}
		} finally {
			await fs.rm(agentDir, { recursive: true, force: true });
		}
	});
});
