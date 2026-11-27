import { getBundledModel } from "@gajae-code/ai/models";
import { Settings } from "../../src/config/settings";
import { initializeExtensions } from "../../src/modes/runtime-init";
import { Broker } from "../../src/sdk/broker/broker";
import { BROKER_RUNTIME_CLOSE_CAPABILITY_FIELD } from "../../src/sdk/host/control/runtime-gate";
import { createSdkSessionRuntimeExtension, type SessionSdkTransport } from "../../src/sdk/host/session-runtime";
import type { SdkFrame } from "../../src/sdk/host/types";
import { createAgentSession } from "../../src/sdk/session";

const fault = process.argv[2];
const broker = new Broker({ agentDir: process.cwd() });
const discovery = await broker.start();
let receive!: (connection: string, frame: SdkFrame) => void;
let shutdown = false;
let accepted = false;
const transport: SessionSdkTransport = {
	sessionId: "idle-close-sdk-only",
	stateRoot: process.cwd(),
	token: "fixture-token",
	onFrame(handler) {
		receive = handler;
		return () => {};
	},
	sendFrame(_connection, frame) {
		if (frame.type === "control_response" && frame.id === "close") {
			accepted = frame.ok === true;
			if (fault === "rejected") throw new Error("fixture rejected write");
			return "dropped";
		}
		return "written";
	},
	start: async () => ({ url: "ws://127.0.0.1:1" }),
	stop: async () => {},
	broadcastFrame: () => {},
};
const { session } = await createAgentSession({
	cwd: process.cwd(),
	agentDir: process.cwd(),
	model: getBundledModel("anthropic", "claude-sonnet-4-5"),
	settings: Settings.isolated({ "compaction.enabled": false }),
	disableExtensionDiscovery: true,
	sdkHostModeSupported: false,
	extensions: [
		api =>
			createSdkSessionRuntimeExtension(api, {
				agentDir: process.cwd(),
				ensureBrokerImpl: async () => discovery,
				createTransport: async () => transport,
			}),
	],
});
try {
	await initializeExtensions(session, {
		reportSendError: () => {},
		reportRuntimeError: error => {
			throw error;
		},
		onShutdown: () => {
			shutdown = true;
		},
	});
	receive("broker", {
		type: "control_request",
		id: "close",
		operation: "session.close",
		input: { ifIdle: true, [BROKER_RUNTIME_CLOSE_CAPABILITY_FIELD]: process.env.GJC_LIFECYCLE_REQUEST_ID },
	});
	for (let i = 0; i < 100; i++) await Promise.resolve();
	console.log(JSON.stringify({ accepted, shutdown }));
} finally {
	await session.dispose();
	await broker.stop();
}
