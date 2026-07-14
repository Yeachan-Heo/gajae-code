import * as fs from "node:fs";
import path from "node:path";
import { getBundledModel } from "@gajae-code/ai";
import { Settings } from "../../src/config/settings";
import { initializeExtensions } from "../../src/modes/runtime-init";
import { createAgentSession } from "../../src/sdk";
import { brokerOwnerForTest } from "../../src/sdk/broker/ensure";
import { createNotificationsExtension } from "../../src/sdk/bus";
import { SessionManager } from "../../src/session/session-manager";

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
	const settings = Settings.isolated();
	const { session } = await createAgentSession({
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
		stop: async () => {
			try {
				await session.extensionRunner?.emit({ type: "session_shutdown" });
				await session.dispose();
			} finally {
				await brokerOwnerForTest(agentDir)?.stop();
			}
		},
	};
}
