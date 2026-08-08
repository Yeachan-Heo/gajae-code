import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { AuthStorage } from "@gajae-code/ai";
import { Settings } from "@gajae-code/coding-agent/config/settings";
import { initializeExtensions } from "@gajae-code/coding-agent/modes/runtime-init";
import { createAgentSession } from "@gajae-code/coding-agent/sdk";
import { SessionManager } from "@gajae-code/coding-agent/session/session-manager";
import { z } from "zod/v4";

describe("custom tool lifecycle error boundaries", () => {
	const temporaryDirectories: string[] = [];
	const authStorages = new Set<AuthStorage>();

	afterEach(async () => {
		for (const storage of authStorages) storage.close();
		authStorages.clear();
		await Promise.all(
			temporaryDirectories.splice(0).map(directory => rm(directory, { recursive: true, force: true })),
		);
	});

	test("hostile custom-tool onSession errors remain non-fatal", async () => {
		const root = await mkdtemp(path.join(os.tmpdir(), "gajae-sdk-hostile-on-session-"));
		temporaryDirectories.push(root);
		const cwd = path.join(root, "project");
		const agentDir = path.join(root, "agent");
		await Promise.all([mkdir(cwd), mkdir(agentDir)]);
		const authStorage = await AuthStorage.create(path.join(agentDir, "auth.db"));
		authStorages.add(authStorage);

		const hostileError = new Proxy(Object.create(null), {
			getPrototypeOf() {
				throw new Error("prototype trap");
			},
			get() {
				throw new Error("property trap");
			},
		});
		const runtimeErrors: unknown[] = [];
		const { session } = await createAgentSession({
			cwd,
			agentDir,
			authStorage,
			settings: Settings.isolated(),
			sessionManager: SessionManager.inMemory(cwd),
			disableExtensionDiscovery: true,
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			enableMCP: false,
			enableLsp: false,
			customTools: [
				{
					name: "hostile-on-session",
					label: "Hostile onSession",
					description: "Throws a hostile proxy from onSession.",
					parameters: z.object({}),
					execute: async () => ({ content: [{ type: "text" as const, text: "ok" }] }),
					onSession: () => {
						throw hostileError;
					},
				},
			],
		});

		try {
			await initializeExtensions(session, {
				reportSendError: () => {},
				reportRuntimeError: error => runtimeErrors.push(error),
			});
			expect(runtimeErrors).toEqual([]);
		} finally {
			await session.dispose();
		}
	});
});
