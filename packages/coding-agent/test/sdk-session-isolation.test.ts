import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { type AssistantMessage, getBundledModel } from "@gajae-code/ai";
import type { Rule } from "@gajae-code/coding-agent/capability/rule";
import { Settings } from "@gajae-code/coding-agent/config/settings";
import type { ExtensionFactory } from "@gajae-code/coding-agent/extensibility/extensions";
import { LocalProtocolHandler, resolveLocalUrlToPath } from "@gajae-code/coding-agent/internal-urls";
import { AgentRegistry } from "@gajae-code/coding-agent/registry/agent-registry";
import { createAgentSession } from "@gajae-code/coding-agent/sdk";
import { createSecretObfuscator } from "@gajae-code/coding-agent/secrets";
import type { AgentSession } from "@gajae-code/coding-agent/session/agent-session";
import { SessionManager } from "@gajae-code/coding-agent/session/session-manager";
import { getSessionsDir, Snowflake } from "@gajae-code/utils";
import { discoverAuthStorage } from "../src/sdk/session";
import { AgentStorage } from "../src/session/agent-storage";

function createTtsrRule(name: string): Rule {
	return {
		name,
		path: `/tmp/${name}.md`,
		content: "Avoid forbidden output",
		condition: ["forbidden"],
		scope: ["text"],
		_source: {
			provider: "test",
			providerName: "test",
			path: `/tmp/${name}.md`,
			level: "project",
		},
	};
}

const SECRET_ENV_PATTERNS = /(?:KEY|SECRET|TOKEN|PASSWORD|PASS|AUTH|CREDENTIAL|PRIVATE|OAUTH)(?:_|$)/i;
async function withClearedSecretEnv<T>(run: () => Promise<T>): Promise<T> {
	const removed: Array<[string, string]> = [];
	for (const [name, value] of Object.entries(process.env)) {
		if (!value || value.length < 8) continue;
		if (!SECRET_ENV_PATTERNS.test(name)) continue;
		removed.push([name, value]);
		delete process.env[name];
	}
	try {
		return await run();
	} finally {
		for (const [name, value] of removed) {
			process.env[name] = value;
		}
	}
}

function getAssistantText(message: AssistantMessage | undefined): string {
	if (!message) throw new Error("Expected assistant message");
	return message.content
		.filter((block): block is { type: "text"; text: string } => block.type === "text")
		.map(block => block.text)
		.join(" ");
}

describe("createAgentSession session storage isolation", () => {
	const tempDirs: string[] = [];

	afterEach(async () => {
		LocalProtocolHandler.resetOverrideForTests();
		AgentRegistry.resetGlobalForTests();
		if (process.platform === "win32") {
			Bun.gc(true);
			await Bun.sleep(50);
		}
		for (const tempDir of tempDirs.splice(0)) {
			fs.rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("uses the provided agentDir for the default persistent session root", async () => {
		const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `pi-sdk-session-isolation-${Snowflake.next()}-`));
		tempDirs.push(tempDir);
		const cwd = path.join(tempDir, `project-${Snowflake.next()}`);
		const agentDir = path.join(tempDir, "agent");
		fs.mkdirSync(cwd, { recursive: true });

		const { session } = await createAgentSession({
			cwd,
			agentDir,
			settings: Settings.isolated(),
			disableExtensionDiscovery: true,
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			enableMCP: false,
			enableLsp: false,
		});

		try {
			const sessionFile = session.sessionFile;
			if (!sessionFile) {
				throw new Error("Expected session file path");
			}

			expect(sessionFile.startsWith(path.join(agentDir, "sessions"))).toBe(true);
			expect(sessionFile.startsWith(getSessionsDir())).toBe(false);
		} finally {
			await session.dispose();
		}
	});
	it("keeps settings storage usable while default sessions dispose independently", async () => {
		const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `pi-sdk-shared-storage-${Snowflake.next()}-`));
		tempDirs.push(tempDir);
		const cwd = path.join(tempDir, "project");
		const agentDir = path.join(tempDir, "agent");
		fs.mkdirSync(cwd, { recursive: true });

		const settingsStorage = await AgentStorage.open(path.join(agentDir, "agent.db"));
		const options = {
			cwd,
			agentDir,
			settings: Settings.isolated(),
			disableExtensionDiscovery: true,
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			enableMCP: false,
			enableLsp: false,
		};
		const first = await createAgentSession(options);
		const second = await createAgentSession(options);
		try {
			await first.session.dispose();
			await first.session.dispose();

			settingsStorage.recordModelUsage("test/shared");
			expect(settingsStorage.getModelUsageOrder()).toContain("test/shared");
			await second.session.modelRegistry.authStorage.reload();

			const laterStorage = await discoverAuthStorage(agentDir);
			try {
				await laterStorage.reload();
			} finally {
				laterStorage.close();
			}
		} finally {
			await first.session.dispose();
			await second.session.dispose();
			settingsStorage.close();
		}
	}, 20_000);

	it("releases each session's owned local:// override on dispose", async () => {
		const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `pi-sdk-local-protocol-${Snowflake.next()}-`));
		tempDirs.push(tempDir);
		const cwd = path.join(tempDir, "project");
		const agentDir = path.join(tempDir, "agent");
		const firstArtifactsDir = path.join(tempDir, "first-artifacts");
		const secondArtifactsDir = path.join(tempDir, "second-artifacts");
		fs.mkdirSync(cwd, { recursive: true });
		const sessionOptions = {
			cwd,
			agentDir,
			settings: Settings.isolated(),
			disableExtensionDiscovery: true,
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			enableMCP: false,
			enableLsp: false,
		};
		let firstSession: AgentSession | undefined;
		let secondSession: AgentSession | undefined;
		try {
			firstSession = (
				await createAgentSession({
					...sessionOptions,
					localProtocolOptions: {
						getArtifactsDir: () => firstArtifactsDir,
						getSessionId: () => "first-local-session",
					},
				})
			).session;
			expect(resolveLocalUrlToPath("local://note.md", LocalProtocolHandler.resolveOptions()!)).toBe(
				path.join(firstArtifactsDir, "local", "note.md"),
			);

			secondSession = (
				await createAgentSession({
					...sessionOptions,
					localProtocolOptions: {
						getArtifactsDir: () => secondArtifactsDir,
						getSessionId: () => "second-local-session",
					},
				})
			).session;
			expect(resolveLocalUrlToPath("local://note.md", LocalProtocolHandler.resolveOptions()!)).toBe(
				path.join(secondArtifactsDir, "local", "note.md"),
			);

			await secondSession.dispose();
			secondSession = undefined;
			expect(resolveLocalUrlToPath("local://note.md", LocalProtocolHandler.resolveOptions()!)).toBe(
				path.join(firstArtifactsDir, "local", "note.md"),
			);
			await firstSession.dispose();
			firstSession = undefined;
			expect(LocalProtocolHandler.resolveOptions()).toBeUndefined();
		} finally {
			await secondSession?.dispose();
			await firstSession?.dispose();
		}
	});

	it("releases an owned local:// override when startup fails", async () => {
		const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `pi-sdk-local-protocol-failure-${Snowflake.next()}-`));
		tempDirs.push(tempDir);
		const cwd = path.join(tempDir, "project");
		const agentDir = path.join(tempDir, "agent");
		const artifactsDir = path.join(tempDir, "artifacts");
		fs.mkdirSync(cwd, { recursive: true });
		const throwingExtension: ExtensionFactory = () => {
			throw new Error("simulated local protocol startup failure");
		};

		await expect(
			createAgentSession({
				cwd,
				agentDir,
				settings: Settings.isolated(),
				disableExtensionDiscovery: true,
				extensions: [throwingExtension],
				skills: [],
				contextFiles: [],
				promptTemplates: [],
				slashCommands: [],
				enableMCP: false,
				enableLsp: false,
				localProtocolOptions: {
					getArtifactsDir: () => artifactsDir,
					getSessionId: () => "failed-local-session",
				},
			}),
		).rejects.toThrow("simulated local protocol startup failure");

		expect(LocalProtocolHandler.resolveOptions()).toBeUndefined();
	});
	it("wires the discovered TTSR manager into the created session", async () => {
		const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `pi-sdk-ttsr-${Snowflake.next()}-`));
		tempDirs.push(tempDir);
		const cwd = path.join(tempDir, `project-${Snowflake.next()}`);
		const agentDir = path.join(tempDir, "agent");
		const rule = createTtsrRule("sdk-ttsr-rule");
		fs.mkdirSync(cwd, { recursive: true });

		const { session } = await createAgentSession({
			cwd,
			agentDir,
			settings: Settings.isolated(),
			rules: [rule],
			disableExtensionDiscovery: true,
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			enableMCP: false,
			enableLsp: false,
		});

		try {
			expect(session.ttsrManager).toBeDefined();
			expect(session.ttsrManager?.checkDelta("forbidden", { source: "text" }).map(match => match.name)).toEqual([
				rule.name,
			]);
		} finally {
			await session.dispose();
		}
	});
	it("shows redaction guidance only when secrets are actually loaded", async () => {
		await withClearedSecretEnv(async () => {
			const redactionGuidance = "redacted as versioned `#GJC1_…#` tokens";
			const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `pi-sdk-secrets-${Snowflake.next()}-`));
			tempDirs.push(tempDir);
			const cwd = path.join(tempDir, "project");
			const agentDir = path.join(tempDir, "agent");
			fs.mkdirSync(cwd, { recursive: true });

			const commonOptions = {
				cwd,
				agentDir,
				settings: Settings.isolated({ "secrets.enabled": true }),
				disableExtensionDiscovery: true,
				skills: [],
				contextFiles: [],
				promptTemplates: [],
				slashCommands: [],
				enableMCP: false,
				enableLsp: false,
			};

			const withoutSecrets = await createAgentSession(commonOptions);
			try {
				expect(withoutSecrets.session.systemPrompt.join("\n")).not.toContain(redactionGuidance);
			} finally {
				await withoutSecrets.session.dispose();
			}

			fs.mkdirSync(path.join(cwd, ".gjc"), { recursive: true });
			fs.writeFileSync(path.join(cwd, ".gjc", "secrets.yml"), "- type: plain\n  content: sdk-secret-token-123456\n");

			const withSecrets = await createAgentSession(commonOptions);
			try {
				expect(withSecrets.session.systemPrompt.join("\n")).toContain(redactionGuidance);
			} finally {
				await withSecrets.session.dispose();
			}
		});
	});

	it("keeps restored assistant messages deobfuscated across reloads", async () => {
		await withClearedSecretEnv(async () => {
			const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `pi-sdk-session-secrets-${Snowflake.next()}-`));
			tempDirs.push(tempDir);
			const cwd = path.join(tempDir, "project");
			const agentDir = path.join(tempDir, "agent");
			fs.mkdirSync(path.join(cwd, ".gjc"), { recursive: true });
			fs.writeFileSync(path.join(cwd, ".gjc", "secrets.yml"), "- type: plain\n  content: sdk-secret-token-123456\n");

			const model = getBundledModel("anthropic", "claude-sonnet-4-5");
			if (!model) throw new Error("Expected anthropic model");

			const obfuscator = createSecretObfuscator([{ type: "plain", content: "sdk-secret-token-123456" }]);
			const initialManager = SessionManager.create(cwd, path.join(agentDir, "sessions"));
			initialManager.appendMessage({
				role: "assistant",
				content: [{ type: "text", text: obfuscator.obfuscate("token sdk-secret-token-123456") }],
				api: model.api,
				provider: model.provider,
				model: model.id,
				usage: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				stopReason: "stop",
				timestamp: Date.now(),
			});
			await initialManager.flush();
			const sessionFile = initialManager.getSessionFile();
			if (!sessionFile) throw new Error("Expected persisted session file");
			await initialManager.close();
			const transcript = fs.readFileSync(sessionFile, "utf8");
			expect(transcript).not.toContain("sdk-secret-token-123456");

			const resumedManager = await SessionManager.open(sessionFile, path.dirname(sessionFile));
			const { session } = await createAgentSession({
				cwd,
				agentDir,
				sessionManager: resumedManager,
				model,
				settings: Settings.isolated({ "secrets.enabled": true }),
				disableExtensionDiscovery: true,
				skills: [],
				contextFiles: [],
				promptTemplates: [],
				slashCommands: [],
				enableMCP: false,
				enableLsp: false,
			});
			try {
				expect(getAssistantText(session.messages.at(-1) as AssistantMessage | undefined)).toContain(
					"sdk-secret-token-123456",
				);
				await session.reload();
				expect(getAssistantText(session.messages.at(-1) as AssistantMessage | undefined)).toContain(
					"sdk-secret-token-123456",
				);
			} finally {
				await session.dispose();
			}
		});
	});
});
