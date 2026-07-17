import { afterEach, describe, expect, test, vi } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { getBundledModel } from "@gajae-code/ai";
import { Settings } from "@gajae-code/coding-agent/config/settings";
import { createAgentSession, type ExtensionFactory, type WorkspaceTree } from "@gajae-code/coding-agent/sdk";
import { AuthStorage } from "@gajae-code/coding-agent/session/auth-storage";
import { SessionManager } from "@gajae-code/coding-agent/session/session-manager";

const tempDirs: string[] = [];
const closeAuthStorage = AuthStorage.prototype.close;

function spyOnAuthStorageClose() {
	return vi.spyOn(AuthStorage.prototype, "close").mockImplementation(function (this: AuthStorage) {
		closeAuthStorage.call(this);
	});
}

function createTempProject(): { agentDir: string; cwd: string } {
	const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-sdk-auth-ownership-"));
	const cwd = path.join(agentDir, "project");
	fs.mkdirSync(cwd, { recursive: true });
	tempDirs.push(agentDir);
	return { agentDir, cwd };
}

function workspaceTree(cwd: string): WorkspaceTree {
	return {
		rootPath: cwd,
		rendered: ".",
		truncated: false,
		totalLines: 1,
		agentsMdFiles: [],
	};
}

function model() {
	const bundled = getBundledModel("anthropic", "claude-sonnet-4-5");
	if (!bundled) throw new Error("Expected bundled test model");
	return bundled;
}

function sessionOptions(agentDir: string, cwd: string) {
	return {
		agentDir,
		cwd,
		sessionManager: SessionManager.inMemory(cwd),
		settings: Settings.isolated(),
		model: model(),
		disableExtensionDiscovery: true,
		extensions: [],
		skills: [],
		contextFiles: [],
		promptTemplates: [],
		workspaceTree: workspaceTree(cwd),
		slashCommands: [],
		enableMCP: false,
		enableLsp: false,
		toolNames: [],
	};
}

afterEach(() => {
	vi.restoreAllMocks();
	for (const tempDir of tempDirs.splice(0)) {
		try {
			fs.rmSync(tempDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
		} catch (error) {
			// Bun's SQLite binding can retain a Windows mapping until the test
			// process exits even after Database.close(); production callers are
			// still protected because the close itself is asserted above.
			if (process.platform === "win32" && (error as NodeJS.ErrnoException).code === "EBUSY") continue;
			throw error;
		}
	}
});

describe("createAgentSession AuthStorage ownership", () => {
	test("closes the factory-owned store exactly once on dispose", async () => {
		const { agentDir, cwd } = createTempProject();
		const close = spyOnAuthStorageClose();
		const { session } = await createAgentSession(sessionOptions(agentDir, cwd));

		expect(close).not.toHaveBeenCalled();
		await session.dispose();
		expect(close).toHaveBeenCalledTimes(1);
	});

	test("closes the factory-owned store when startup fails", async () => {
		const { agentDir, cwd } = createTempProject();
		const close = spyOnAuthStorageClose();
		const failDuringStartup: ExtensionFactory = () => {
			throw new Error("extension startup failed");
		};

		await expect(
			createAgentSession({
				...sessionOptions(agentDir, cwd),
				extensions: [failDuringStartup],
			}),
		).rejects.toThrow("extension startup failed");
		expect(close).toHaveBeenCalledTimes(1);
	});

	test("leaves an embedder-supplied store open", async () => {
		const { agentDir, cwd } = createTempProject();
		const authStorage = await AuthStorage.create(path.join(agentDir, "external-auth.db"));
		const close = spyOnAuthStorageClose();
		const { session } = await createAgentSession({
			...sessionOptions(agentDir, cwd),
			authStorage,
		});

		await session.dispose();
		expect(close).not.toHaveBeenCalled();
		closeAuthStorage.call(authStorage);
	});
});
