import * as fs from "node:fs";
import path from "node:path";
import { getBundledModel } from "@gajae-code/ai";
import { initializeExtensions } from "../../src/modes/runtime-init";
import { createAgentSession } from "../../src/sdk";
import { startFixtureBrokerWithLeaseForTest } from "../../src/sdk/broker/ensure";
import { createNotificationsExtension } from "../../src/sdk/bus";
import { SessionManager } from "../../src/session/session-manager";
import {
	cleanupFixtureRoot,
	createFixtureBrokerEnvironment,
	createFixtureRootCleanup,
	registerFixtureRuntime,
	withFixtureBrokerEnvironment,
} from "./fixture-broker-cleanup";
import { isolatedNotificationSettings } from "./notification-settings";

export async function startProductionSdkHost(
	cwd: string,
	options: { acceptPromptPreflightWithoutExecution?: boolean } = {},
): Promise<{
	endpoint: { url: string; token: string };
	sessionId: string;
	observed: Array<{ kind: "control" | "query"; operation: string }>;
	stop: () => Promise<void>;
}> {
	const observed: Array<{ kind: "control" | "query"; operation: string }> = [];
	const agentDir = path.join(cwd, ".gjc", "agent");
	const fixtureEnv = createFixtureBrokerEnvironment(agentDir, agentDir);
	return withFixtureBrokerEnvironment(async () => {
		const started = await startFixtureBrokerWithLeaseForTest({ agentDir, env: fixtureEnv });
		const cleanup = createFixtureRootCleanup(agentDir, agentDir, started.lease);
		try {
			const settings = isolatedNotificationSettings(agentDir);
			// Suppress the session's auto-added SDK host during construction so that
			// ONLY this fixture's explicitly-provided (instrumented) notifications
			// extension hosts a server. The auto-add is decided at construction time
			// under GJC_SDK_DISABLE=1; the explicit extension hosts later at
			// session_start with the guard already restored, so there is exactly one
			// endpoint and onSdkRequest instrumentation is never overwritten.
			const priorSdkDisable = process.env.GJC_SDK_DISABLE;
			process.env.GJC_SDK_DISABLE = "1";
			let session: Awaited<ReturnType<typeof createAgentSession>>["session"];
			try {
				({ session } = await createAgentSession({
					cwd,
					agentDir,
					sessionManager: SessionManager.inMemory(cwd),
					settings,
					model: getBundledModel("openai", "gpt-4o-mini"),
					disableExtensionDiscovery: true,
					extensions: [
						api =>
							createNotificationsExtension(api, {
								settings,
								onSdkRequest: (kind, _connectionId, frame) => {
									const operation = kind === "control" ? frame.operation : frame.query;
									if (typeof operation === "string") observed.push({ kind, operation });
								},
							}),
					],
					skills: [],
					contextFiles: [],
					promptTemplates: [],
					slashCommands: [],
					enableMCP: false,
					enableLsp: false,
				}));
			} finally {
				if (priorSdkDisable === undefined) delete process.env.GJC_SDK_DISABLE;
				else process.env.GJC_SDK_DISABLE = priorSdkDisable;
			}
			registerFixtureRuntime(cleanup, {
				key: `session:${session.sessionId}`,
				requiredOwner: "runtime-and-broker",
				shutdown: async () => {
					await session.extensionRunner?.emit({ type: "session_shutdown" });
				},
				dispose: () => session.dispose(),
			});
			if (options.acceptPromptPreflightWithoutExecution) {
				session.sendUserMessage = async (_content, promptOptions) => {
					promptOptions?.onPreflightAccepted?.();
				};
			}
			await initializeExtensions(session, {
				reportSendError: () => {},
				reportRuntimeError: () => {},
			});
			const file = path.join(cwd, ".gjc", "state", "sdk", `${session.sessionId}.json`);
			const deadline = Date.now() + 4_000;
			while (!fs.existsSync(file)) {
				if (Date.now() > deadline) throw new Error("Timed out starting production SDK host");
				await Bun.sleep(10);
			}
			const endpoint = JSON.parse(fs.readFileSync(file, "utf8")) as { url: string; token: string };
			return {
				endpoint,
				sessionId: session.sessionId,
				observed,
				stop: () => cleanupFixtureRoot(cleanup),
			};
		} catch (error) {
			try {
				await cleanupFixtureRoot(cleanup);
			} catch (cleanupError) {
				const failure = new AggregateError(
					[error, cleanupError],
					"Production SDK host setup and fixture broker cleanup both failed.",
				);
				Object.defineProperty(failure, "retryFixtureCleanup", {
					value: () => cleanupFixtureRoot(cleanup),
				});
				throw failure;
			}
			throw error;
		}
	});
}
