import * as path from "node:path";
import { registerCustomApi } from "@gajae-code/ai";
import { getBundledModel } from "@gajae-code/ai/models";
import { createMockModel } from "@gajae-code/ai/providers/mock";
import { NotificationServer } from "@gajae-code/natives";
import { AsyncJobManager } from "../../src/async/job-manager";
import { runSessionHost } from "../../src/commands/sdk";
import { Settings } from "../../src/config/settings";
import { createLifecycleAgentSession } from "../../src/sdk/lifecycle-session";

const root = process.cwd();
process.env.ANTHROPIC_API_KEY = "fixture-key";
const releaseTurn = Promise.withResolvers<void>();
const releaseJob = Promise.withResolvers<string>();
let turnEntered = false;
let holdTurns = true;
let raceProbe = false;
let unsupported = false;
let rejectCloseResponse = false;
const sendTo = NotificationServer.prototype.sendTo;
NotificationServer.prototype.sendTo = function (connectionId, message) {
	const frame = JSON.parse(message);
	if (
		rejectCloseResponse &&
		frame.type === "control_response" &&
		frame.ok === true &&
		frame.result?.closing === true
	) {
		void Bun.write(path.join(root, "close-response-rejected.json"), JSON.stringify({ accepted: true }));
		throw new Error("Fixture rejected close response");
	}
	return sendTo.call(this, connectionId, message);
};
let providerCalls = 0;
const mock = createMockModel({
	handler: async () => {
		providerCalls++;
		turnEntered = true;
		if (holdTurns) await releaseTurn.promise;
		return { content: ["done"] };
	},
});
const servers: Bun.Server<undefined>[] = [];
await runSessionHost({
	createLifecycleAgentSession: async (options, owner) => {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Missing fixture model");
		registerCustomApi("idle-close-fixture", mock.stream, "idle-close-fixture");
		const result = await createLifecycleAgentSession(
			{
				...options,
				model,
				settings: Settings.isolated({
					"compaction.enabled": false,
					"todo.reminders": false,
				}),
				disableExtensionDiscovery: true,
			},
			owner,
		);
		if (!("session" in result)) return result;
		const session = result.session;
		Object.defineProperty(session.model!, "api", { value: "idle-close-fixture" });
		session.agent.streamFn = mock.stream;
		const prepareClose = session.prepareCloseIfIdle.bind(session);
		session.prepareCloseIfIdle = () => {
			if (unsupported) throw Object.assign(new Error("Idle close unavailable"), { code: "operation_prohibited" });
			prepareClose();
			if (raceProbe) {
				// Enter through the live ingress after the atomic fence and before shutdown.
				const attempts = [
					session.prompt("racing direct prompt"),
					session.sendUserMessage("racing prompt"),
					session.sendCustomMessage(
						{ customType: "async-result", content: "completed job", display: false },
						{ triggerTurn: true },
					),
				];
				void Promise.allSettled(attempts).then(results =>
					Bun.write(
						path.join(root, "race-result.json"),
						JSON.stringify({
							codes: results.map(result => (result.status === "rejected" ? result.reason.code : "accepted")),
							providerCalls,
						}),
					),
				);
			}
		};
		const server = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			async fetch(request) {
				const action = new URL(request.url).pathname;
				if (action === "/release") {
					session.setClientBridge(undefined);
					holdTurns = false;
					releaseTurn.resolve();
					releaseJob.resolve("job done");
				}
				if (action === "/race") raceProbe = true;
				if (action === "/unsupported") unsupported = true;
				if (action === "/reject-close") rejectCloseResponse = true;
				if (action === "/job") {
					const manager = AsyncJobManager.instance();
					if (!manager) throw new Error("No owned job manager");
					manager.register("bash", "held owned job", () => releaseJob.promise, { ownerId: session.getAgentId() });
				}
				if (action === "/queue") await session.sendUserMessage("queued prompt", { deliverAs: "followUp" });
				if (action === "/pending") {
					session.setClientBridge({ capabilities: {}, deferAgentInitiatedTurns: true });
					await session.sendCustomMessage(
						{ customType: "async-result", content: "pending completion", display: false },
						{ triggerTurn: true },
					);
				}
				return Response.json({
					turnEntered,
					providerCalls,
					streaming: session.isStreaming,
					queued: session.agent.hasQueuedMessages(),
					pending: session.queuedMessageCount,
					runningJobs: session.getAsyncJobSnapshot()?.running.length ?? 0,
					work: session.sessionWorkLease.isHeld(),
				});
			},
		});
		servers.push(server);
		await Bun.write(path.join(root, "fixture-control.json"), JSON.stringify({ url: server.url.origin }));
		return result;
	},
});
for (const server of servers) server.stop(true);
