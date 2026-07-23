import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { type AssistantMessage, getBundledModel } from "@gajae-code/ai";
import type { Rule } from "@gajae-code/coding-agent/capability/rule";
import { Settings } from "@gajae-code/coding-agent/config/settings";
import type { ExtensionFactory } from "@gajae-code/coding-agent/extensibility/extensions";
import { LocalProtocolHandler, resolveLocalRoot, resolveLocalUrlToPath } from "@gajae-code/coding-agent/internal-urls";
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
	it("records cleanup_pending when managed legacy-local retirement is durably retained", async () => {
		const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `gjc-sdk-local-resume-${Snowflake.next()}-`));
		tempDirs.push(tempDir);
		const cwd = path.join(tempDir, "project");
		const agentDir = path.join(tempDir, "agent");
		fs.mkdirSync(cwd, { recursive: true });

		const destination = SessionManager.managedDestination(cwd, agentDir);
		const initialManager = SessionManager.create(cwd, destination);
		initialManager.appendMessage({ role: "user", content: "legacy local migration", timestamp: Date.now() });
		await initialManager.flush();
		const sessionFile = initialManager.getSessionFile();
		if (!sessionFile) throw new Error("Expected persisted managed session path");
		await initialManager.close();

		const resumedManager = await SessionManager.open(sessionFile, destination);
		const artifactsDir = resumedManager.getArtifactsDir();
		if (!artifactsDir) throw new Error("Expected resumed managed artifacts path");
		const legacyLocalRoot = path.join(artifactsDir, "local");
		fs.mkdirSync(legacyLocalRoot, { recursive: true, mode: 0o700 });
		fs.writeFileSync(path.join(legacyLocalRoot, "resume.md"), "preserved", { mode: 0o600 });
		const { session } = await createAgentSession({
			cwd,
			agentDir,
			sessionManager: resumedManager,
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
			const localOptions = {
				getArtifactsDir: () => resumedManager.getArtifactsDir(),
				isManagedDestination: () => resumedManager.isManagedDestination(),
				getManagedLegacyLocalMigrationSource: () => resumedManager.getManagedLegacyLocalMigrationSource(),
				getSessionId: () => resumedManager.getSessionId(),
			};
			const resumedPath = resolveLocalUrlToPath("local://resume.md", localOptions);
			expect(resumedPath).toBe(path.join(resolveLocalRoot(localOptions), "resume.md"));
			expect(fs.readFileSync(resumedPath, "utf8")).toBe("preserved");
			expect(
				fs.readFileSync(path.join(resolveLocalRoot(localOptions), ".gjc-local-legacy-migrated-v1"), "utf8"),
			).toBe("cleanup_pending\n");
		} finally {
			await session.dispose();
		}
	}, 20_000);

	it("migrates a switched managed session's legacy local:// root before resolution (#2925)", async () => {
		const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `gjc-sdk-local-switch-${Snowflake.next()}-`));
		tempDirs.push(tempDir);
		const cwd = path.join(tempDir, "project");
		const agentDir = path.join(tempDir, "agent");
		fs.mkdirSync(cwd, { recursive: true });

		const destination = SessionManager.managedDestination(cwd, agentDir);

		// Session A — start here so createAgentSession initializes A's local root only.
		const sessionA = SessionManager.create(cwd, destination);
		sessionA.appendMessage({ role: "user", content: "session A", timestamp: Date.now() });
		await sessionA.flush();
		const sessionAFile = sessionA.getSessionFile();
		if (!sessionAFile) throw new Error("Expected session A path");
		await sessionA.close();

		// Session B — carry a legacy artifacts/local tree that needs verified migration.
		const sessionB = SessionManager.create(cwd, destination);
		sessionB.appendMessage({ role: "user", content: "session B", timestamp: Date.now() });
		await sessionB.flush();
		const sessionBFile = sessionB.getSessionFile();
		if (!sessionBFile) throw new Error("Expected session B path");
		const sessionBArtifacts = sessionB.getArtifactsDir();
		if (!sessionBArtifacts) throw new Error("Expected session B artifacts path");
		const legacyLocalRoot = path.join(sessionBArtifacts, "local");
		fs.mkdirSync(legacyLocalRoot, { recursive: true, mode: 0o700 });
		fs.writeFileSync(path.join(legacyLocalRoot, "switched.md"), "switched-bytes", { mode: 0o600 });
		await sessionB.close();

		const managerA = await SessionManager.open(sessionAFile, destination);
		const { session } = await createAgentSession({
			cwd,
			agentDir,
			sessionManager: managerA,
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
			expect(await session.switchSession(sessionBFile)).toBe(true);

			const localOptions = {
				getArtifactsDir: () => session.sessionManager.getArtifactsDir(),
				isManagedDestination: () => session.sessionManager.isManagedDestination(),
				getManagedLegacyLocalMigrationSource: () => session.sessionManager.getManagedLegacyLocalMigrationSource(),
				getSessionId: () => session.sessionManager.getSessionId(),
			};
			const resolved = resolveLocalUrlToPath("local://switched.md", localOptions);
			expect(resolved).toBe(path.join(resolveLocalRoot(localOptions), "switched.md"));
			expect(fs.readFileSync(resolved, "utf8")).toBe("switched-bytes");
			// Legacy source retired after verified migration (marker may be verified or cleanup_pending).
			expect(fs.existsSync(path.join(legacyLocalRoot, "switched.md"))).toBe(false);
			const marker = fs.readFileSync(
				path.join(resolveLocalRoot(localOptions), ".gjc-local-legacy-migrated-v1"),
				"utf8",
			);
			expect(marker === "verified\n" || marker === "cleanup_pending\n").toBe(true);
		} finally {
			await session.dispose();
		}
	}, 30_000);

	it("initializes a default local root without shadowing an explicit owner", async () => {
		const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `gjc-sdk-local-owner-${Snowflake.next()}-`));
		tempDirs.push(tempDir);
		const cwd = path.join(tempDir, "project");
		const agentDir = path.join(tempDir, "agent");
		fs.mkdirSync(cwd, { recursive: true });
		const owned = {
			getArtifactsDir: () => path.join(tempDir, "owned-artifacts"),
			getSessionId: () => "owned-local-session",
		};
		const disposeOwned = LocalProtocolHandler.installOverride(owned);

		let session: AgentSession | undefined;
		try {
			session = (
				await createAgentSession({
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
				})
			).session;
			expect(LocalProtocolHandler.resolveOptions()).toBe(owned);
			await session.dispose();
			session = undefined;
			expect(LocalProtocolHandler.resolveOptions()).toBe(owned);
		} finally {
			await session?.dispose();
			disposeOwned();
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

			// Dispose the first (bottom-of-stack) override while the second remains installed;
			// only the first session's override may be removed and the second must still resolve.
			await firstSession.dispose();
			firstSession = undefined;
			expect(resolveLocalUrlToPath("local://note.md", LocalProtocolHandler.resolveOptions()!)).toBe(
				path.join(secondArtifactsDir, "local", "note.md"),
			);

			// Disposing the remaining second override restores the default/fallback resolution.
			await secondSession.dispose();
			secondSession = undefined;
			expect(LocalProtocolHandler.resolveOptions()).toBeUndefined();

			// Managed-destination sessions retain their owner-only external gjc-local root.
			expect(
				resolveLocalRoot({
					getArtifactsDir: () => firstArtifactsDir,
					isManagedDestination: () => true,
					getSessionId: () => "managed-owner-session",
				}),
			).toBe(path.join(os.tmpdir(), "gjc-local", "managed-owner-session"));
		} finally {
			await secondSession?.dispose();
			await firstSession?.dispose();
		}
	});

	it("restores the previous session's local:// override when the top override is disposed (LIFO)", async () => {
		const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `pi-sdk-local-protocol-lifo-${Snowflake.next()}-`));
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

			// Dispose the top-of-stack (second) override; the previous (first) override must be restored.
			await secondSession.dispose();
			secondSession = undefined;
			expect(resolveLocalUrlToPath("local://note.md", LocalProtocolHandler.resolveOptions()!)).toBe(
				path.join(firstArtifactsDir, "local", "note.md"),
			);

			// Disposing the last remaining override restores the default/fallback resolution.
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
