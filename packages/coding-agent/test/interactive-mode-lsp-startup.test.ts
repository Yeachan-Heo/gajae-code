import { describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { ModelRegistry } from "@gajae-code/coding-agent/config/model-registry";
import { Settings } from "@gajae-code/coding-agent/config/settings";
import * as lsp from "@gajae-code/coding-agent/lsp";
import { createAgentSession } from "@gajae-code/coding-agent/sdk";
import { AuthStorage } from "@gajae-code/coding-agent/session/auth-storage";
import { SessionManager } from "@gajae-code/coding-agent/session/session-manager";
import { TempDir } from "@gajae-code/utils";
import {
	getLspStartupWarningMessage,
	LSP_STARTUP_EVENT_CHANNEL,
	type LspStartupEvent,
} from "../src/lsp/startup-events";
import { EventBus } from "../src/utils/event-bus";

describe("InteractiveMode LSP startup events", () => {
	it("delivers startup completion events through the shared channel", () => {
		const eventBus = new EventBus();
		const received: LspStartupEvent[] = [];
		eventBus.on(LSP_STARTUP_EVENT_CHANNEL, event => {
			received.push(event as LspStartupEvent);
		});

		const event: LspStartupEvent = {
			type: "completed",
			servers: [{ name: "rust-analyzer", status: "ready", fileTypes: [".rs"] }],
		};
		eventBus.emit(LSP_STARTUP_EVENT_CHANNEL, event);

		expect(received).toEqual([event]);
	});
	it("does not warm configured LSP servers when creating an interactive session", async () => {
		const tempDir = TempDir.createSync("@gjc-lsp-lazy-startup-");
		const authStorage = await AuthStorage.create(path.join(tempDir.path(), "auth.db"));
		const discoverSpy = vi
			.spyOn(lsp, "discoverStartupLspServers")
			.mockReturnValue([{ name: "rust-analyzer", status: "idle", fileTypes: [".rs"] }]);
		const warmupSpy = vi.spyOn(lsp, "warmupLspServers");
		try {
			const { session, lspServers } = await createAgentSession({
				cwd: tempDir.path(),
				agentDir: tempDir.path(),
				authStorage,
				modelRegistry: new ModelRegistry(authStorage),
				settings: Settings.isolated({
					"async.enabled": false,
					"bash.autoBackground.enabled": false,
					"lsp.diagnosticsOnWrite": true,
				}),
				disableExtensionDiscovery: true,
				extensions: [],
				toolNames: [],
				workspaceTree: {
					rootPath: tempDir.path(),
					rendered: "",
					truncated: false,
					totalLines: 0,
					agentsMdFiles: [],
				},
				skills: [],
				rules: [],
				contextFiles: [],
				promptTemplates: [],
				slashCommands: [],
				enableMCP: false,
				enableLsp: true,
				hasUI: true,
				skipPythonPreflight: true,
				sessionManager: SessionManager.inMemory(tempDir.path()),
				parentTaskPrefix: "test",
			});

			expect(discoverSpy).toHaveBeenCalledWith(tempDir.path());
			expect(lspServers).toEqual([{ name: "rust-analyzer", status: "idle", fileTypes: [".rs"] }]);
			expect(warmupSpy).not.toHaveBeenCalled();

			await session.dispose();
		} finally {
			vi.restoreAllMocks();
			authStorage.close();
			tempDir.removeSync();
		}
	});
	it("does not warn for optional rust-analyzer startup failures", () => {
		const event: LspStartupEvent = {
			type: "completed",
			servers: [
				{
					name: "rust-analyzer",
					status: "error",
					fileTypes: [".rs"],
					error: "LSP server exited (code 1): error: Unknown binary 'rust-analyzer' in official toolchain 'stable-x86_64-unknown-linux-gnu'.",
				},
			],
		};

		expect(getLspStartupWarningMessage(event)).toBeNull();
	});

	it("still warns for non-optional startup failures without leaking raw error detail", () => {
		const event: LspStartupEvent = {
			type: "completed",
			servers: [
				{
					name: "typescript-language-server",
					status: "error",
					fileTypes: [".ts"],
					error: "private path /home/alice/project failed",
				},
			],
		};

		expect(getLspStartupWarningMessage(event)).toBe(
			"LSP startup failed for typescript-language-server. It will retry lazily on write.",
		);
	});
});
