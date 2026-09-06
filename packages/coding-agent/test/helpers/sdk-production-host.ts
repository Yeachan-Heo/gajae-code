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

export interface ProductionSdkHost {
	endpoint: { url: string; token: string; pid: number };
	sessionId: string;
	session: Awaited<ReturnType<typeof createAgentSession>>["session"];
	endpointMtimeMs: number;
	observed: Array<{ kind: "control" | "query"; operation: string }>;
	dispatches: Array<{ deliverAs?: string }>;
	triggerAsk: (
		question: string,
		options: string[],
	) => { registered: true; result: Promise<unknown> } | { registered: false; reason: "authority_unavailable" };
	runCommand: (text: string) => Promise<void>;
	triggerGate: (
		spec: Parameters<
			NonNullable<
				ReturnType<Awaited<ReturnType<typeof createAgentSession>>["session"]["getWorkflowGateEmitter"]>
			>["emitGate"]
		>[0],
	) => { registered: true; result: Promise<unknown> } | { registered: false; reason: "authority_unavailable" };
	stop: () => Promise<void>;
}
export async function startProductionSdkHost(
	cwd: string,
	options: { acceptPromptPreflightWithoutExecution?: boolean; notificationsInitiallyEnabled?: boolean } = {},
): Promise<ProductionSdkHost> {
	const observed: Array<{ kind: "control" | "query"; operation: string }> = [];
	const dispatches: Array<{ deliverAs?: string }> = [];
	const agentDir = path.join(cwd, ".gjc", "agent");
	const fixtureEnv = createFixtureBrokerEnvironment(agentDir, agentDir);
	return withFixtureBrokerEnvironment(async () => {
		const started = await startFixtureBrokerWithLeaseForTest({ agentDir, env: fixtureEnv });
		const cleanup = createFixtureRootCleanup(agentDir, agentDir, started.lease);
		try {
			const settings = isolatedNotificationSettings(agentDir, { "notifications.enabled": true });
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
			const originalSendUserMessage = session.sendUserMessage.bind(session);
			session.sendUserMessage = async (content, options) => {
				dispatches.push({ deliverAs: options?.deliverAs });
				return await originalSendUserMessage(content, options);
			};
			if (options.acceptPromptPreflightWithoutExecution) {
				session.sendUserMessage = async (_content, promptOptions) => {
					if (promptOptions?.onPreflightAcceptCommit) await promptOptions.onPreflightAcceptCommit();
					else promptOptions?.onPreflightAccepted?.();
				};
			}
			const priorNotifications = process.env.GJC_NOTIFICATIONS;
			process.env.GJC_NOTIFICATIONS = options.notificationsInitiallyEnabled === false ? "0" : "1";
			try {
				await initializeExtensions(session, {
					reportSendError: () => {},
					reportRuntimeError: () => {},
				});
			} finally {
				if (priorNotifications === undefined) delete process.env.GJC_NOTIFICATIONS;
				else process.env.GJC_NOTIFICATIONS = priorNotifications;
			}
			const file = path.join(cwd, ".gjc", "state", "sdk", `${session.sessionId}.json`);
			const deadline = Date.now() + 4_000;
			while (!fs.existsSync(file)) {
				if (Date.now() > deadline) throw new Error("Timed out starting production SDK host");
				await Bun.sleep(10);
			}
			const endpoint = JSON.parse(fs.readFileSync(file, "utf8")) as { url: string; token: string; pid: number };
			const endpointMtimeMs = fs.statSync(file).mtimeMs;
			const triggerAsk = (question: string, options: string[]) => {
				const authority = session.getAskAnswerSource();
				return authority
					? { registered: true as const, result: authority.awaitAnswer(question, options) }
					: { registered: false as const, reason: "authority_unavailable" as const };
			};
			const triggerGate = (
				spec: Parameters<NonNullable<ReturnType<typeof session.getWorkflowGateEmitter>>["emitGate"]>[0],
			) => {
				const authority = session.getWorkflowGateEmitter();
				return authority
					? { registered: true as const, result: authority.emitGate(spec) }
					: { registered: false as const, reason: "authority_unavailable" as const };
			};
			return {
				endpoint,
				endpointMtimeMs,
				sessionId: session.sessionId,
				session,
				observed,
				dispatches,
				triggerAsk,
				triggerGate,
				runCommand: async text => await session.prompt(text),
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
				throw failure;
			}
			throw error;
		}
	});
}
