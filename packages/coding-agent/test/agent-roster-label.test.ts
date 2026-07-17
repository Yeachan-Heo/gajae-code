import { describe, expect, it } from "bun:test";
import * as path from "node:path";
import { ModelRegistry } from "@gajae-code/coding-agent/config/model-registry";
import { Settings } from "@gajae-code/coding-agent/config/settings";
import { AgentRegistry } from "@gajae-code/coding-agent/registry/agent-registry";
import { createAgentSession } from "@gajae-code/coding-agent/sdk";
import type { AgentSession } from "@gajae-code/coding-agent/session/agent-session";
import { AuthStorage } from "@gajae-code/coding-agent/session/auth-storage";
import { SessionManager } from "@gajae-code/coding-agent/session/session-manager";
import { TempDir } from "@gajae-code/utils";

interface SessionRequest {
	registry: AgentRegistry;
	agentId: string;
	agentDisplayName?: string;
	agentRosterLabel?: string;
}

interface SessionEnvironment {
	create(request: SessionRequest): Promise<AgentSession>;
	dispose(): Promise<void>;
}

async function createSessionEnvironment(): Promise<SessionEnvironment> {
	const tempDir = TempDir.createSync("@gjc-agent-roster-label-");
	let authStorage: AuthStorage | undefined;
	try {
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "auth.db"));
		const modelRegistry = new ModelRegistry(authStorage);
		const sessions: AgentSession[] = [];
		return {
			create: async request => {
				const { session } = await createAgentSession({
					cwd: tempDir.path(),
					agentDir: tempDir.path(),
					authStorage,
					modelRegistry,
					settings: Settings.isolated({ "async.enabled": false, "bash.autoBackground.enabled": false }),
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
					enableLsp: false,
					skipPythonPreflight: true,
					sessionManager: SessionManager.inMemory(tempDir.path()),
					agentRegistry: request.registry,
					agentId: request.agentId,
					agentDisplayName: request.agentDisplayName ?? "sub",
					agentRosterLabel: request.agentRosterLabel,
					// Keep concurrent focused fixtures from installing process-global top-level services.
					parentTaskPrefix: "test",
				});
				sessions.push(session);
				return session;
			},
			dispose: async () => {
				let firstError: unknown;
				for (const session of sessions.splice(0).reverse()) {
					try {
						await session.dispose();
					} catch (error) {
						firstError ??= error;
					}
				}
				try {
					authStorage?.close();
				} catch (error) {
					firstError ??= error;
				}
				try {
					tempDir.removeSync();
				} catch (error) {
					firstError ??= error;
				}
				if (firstError !== undefined) throw firstError;
			},
		};
	} catch (error) {
		try {
			authStorage?.close();
		} finally {
			tempDir.removeSync();
		}
		throw error;
	}
}

async function createSessions(environment: SessionEnvironment, requests: SessionRequest[]): Promise<AgentSession[]> {
	const results = await Promise.allSettled(requests.map(request => environment.create(request)));
	const sessions: AgentSession[] = [];
	let rejected = false;
	let rejection: unknown;
	for (const result of results) {
		if (result.status === "fulfilled") {
			sessions.push(result.value);
		} else if (!rejected) {
			rejected = true;
			rejection = result.reason;
		}
	}
	if (rejected) throw rejection;
	return sessions;
}

describe("agent roster labels", () => {
	it("sanitizes task descriptions and falls back through task id to display name", async () => {
		const environment = await createSessionEnvironment();
		const cases = [
			{
				registry: new AgentRegistry(),
				agentId: "3-ReleaseNotes",
				agentDisplayName: "executor",
				agentRosterLabel: "  Prepare\nrelease\u0000 notes  ",
				expected: "Prepare release notes",
			},
			{
				registry: new AgentRegistry(),
				agentId: "3-ReleaseNotes",
				agentDisplayName: "executor",
				agentRosterLabel: "\n\u0000",
				expected: "3 Release Notes",
			},
			{
				registry: new AgentRegistry(),
				agentId: "\n\u0000",
				agentDisplayName: "executor",
				agentRosterLabel: "",
				expected: "executor",
			},
		];
		try {
			await createSessions(environment, cases);
			for (const testCase of cases) {
				expect(testCase.registry.get(testCase.agentId)?.rosterLabel).toBe(testCase.expected);
			}
		} finally {
			await environment.dispose();
		}
	});

	it("keeps child registration and roster visibility isolated by registry", async () => {
		const environment = await createSessionEnvironment();
		const parentRegistry = new AgentRegistry();
		const otherRegistry = new AgentRegistry();
		try {
			const [, child] = await createSessions(environment, [
				{ registry: parentRegistry, agentId: "0-Parent" },
				{ registry: parentRegistry, agentId: "1-Child" },
				{ registry: otherRegistry, agentId: "0-Other" },
				{ registry: otherRegistry, agentId: "1-OtherChild" },
			]);

			expect(parentRegistry.get("1-Child")?.session).toBe(child);
			expect(otherRegistry.get("1-Child")).toBeUndefined();
			expect(parentRegistry.listVisibleTo("0-Parent").map(peer => peer.id)).toEqual(["1-Child"]);
			expect(otherRegistry.listVisibleTo("0-Other").map(peer => peer.id)).toEqual(["1-OtherChild"]);
		} finally {
			await environment.dispose();
		}
	});
});
