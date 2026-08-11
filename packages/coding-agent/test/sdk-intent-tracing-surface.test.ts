import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { INTENT_FIELD, normalizeTools } from "@gajae-code/agent-core";
import { ModelRegistry } from "@gajae-code/coding-agent/config/model-registry";
import { resetSettingsForTest, Settings } from "@gajae-code/coding-agent/config/settings";
import { createAgentSession } from "@gajae-code/coding-agent/sdk";
import { AuthStorage } from "@gajae-code/coding-agent/session/auth-storage";
import { SessionManager } from "@gajae-code/coding-agent/session/session-manager";
import { Snowflake } from "@gajae-code/utils";

setDefaultTimeout(30_000);

/**
 * `_i` is a model-facing reasoning aid whose string becomes
 * `tool_execution_start.intent` for every consumer. Gating it on `hasUI` made
 * headless top-level surfaces (ACP, print, SDK embedders) silently run a
 * different prompt and a different tool schema than the TUI, so these assert on
 * the wire shape a provider would actually receive.
 */
describe("intent tracing does not depend on the session surface", () => {
	let tempDir: string;
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;

	beforeEach(async () => {
		resetSettingsForTest();
		tempDir = path.join(os.tmpdir(), `gjc-intent-surface-${Snowflake.next()}`);
		fs.mkdirSync(tempDir, { recursive: true });
		authStorage = await AuthStorage.create(path.join(tempDir, "testauth.db"));
		modelRegistry = new ModelRegistry(authStorage, path.join(tempDir, "models.yml"));
	});

	afterEach(() => {
		resetSettingsForTest();
		authStorage?.close();
		if (tempDir && fs.existsSync(tempDir)) {
			fs.rmSync(tempDir, { recursive: true, force: true });
		}
	});

	function sessionOptions(overrides: Record<string, unknown> = {}) {
		return {
			cwd: tempDir,
			agentDir: tempDir,
			sessionManager: SessionManager.inMemory(),
			disableExtensionDiscovery: true,
			extensions: [],
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			enableMCP: false,
			enableLsp: false,
			skipPythonPreflight: true,
			workspaceTree: { rootPath: tempDir, rendered: "", truncated: false, totalLines: 0, agentsMdFiles: [] },
			toolNames: ["read"],
			rules: [],
			modelRegistry,
			...overrides,
		};
	}

	async function inspect(overrides: Record<string, unknown>): Promise<{
		promptMentionsIntentField: boolean;
		readToolHasIntentField: boolean;
	}> {
		const settings = await Settings.init({ cwd: tempDir, agentDir: tempDir });
		const { session } = await createAgentSession({ ...sessionOptions(overrides), settings } as never);
		try {
			const read = normalizeTools(session.agent.state.tools, session.agent.intentTracing)?.find(
				tool => tool.name === "read",
			);
			const properties = (read?.parameters as { properties?: Record<string, unknown> } | undefined)?.properties;
			return {
				promptMentionsIntentField: session.systemPrompt.some(block => block.includes(`\`${INTENT_FIELD}\``)),
				readToolHasIntentField: Boolean(properties && INTENT_FIELD in properties),
			};
		} finally {
			await session.dispose();
		}
	}

	test("a headless top-level session keeps the intent field the TUI session gets", async () => {
		const tui = await inspect({ hasUI: true });
		const headless = await inspect({ hasUI: false });

		expect(tui).toEqual({ promptMentionsIntentField: true, readToolHasIntentField: true });
		expect(headless).toEqual(tui);
	});

	test("a canonical sub-session still omits the intent field", async () => {
		const subSession = await inspect({ hasUI: false, taskDepth: 1, currentAgentType: "executor" });

		expect(subSession).toEqual({ promptMentionsIntentField: false, readToolHasIntentField: false });
	});
});
