import { Readable, Writable } from "node:stream";
import * as acp from "@agentclientprotocol/sdk";

type CapturedState = {
	initialize?: acp.InitializeRequest;
	configSets: acp.SetSessionConfigOptionRequest[];
	promptText?: string;
	readContent?: string;
	shellOutput?: string;
	releasedTerminalRejected?: boolean;
};

const state: CapturedState = {
	configSets: [],
};

class FakeAgent implements acp.Agent {
	async authenticate(_params: acp.AuthenticateRequest): Promise<acp.AuthenticateResponse> {
		return {};
	}

	async initialize(params: acp.InitializeRequest): Promise<acp.InitializeResponse> {
		state.initialize = params;
		return {
			protocolVersion: acp.PROTOCOL_VERSION,
			agentCapabilities: {},
			agentInfo: { name: "fake-acp-agent", version: "0.0.0" },
		};
	}

	async newSession(_params: acp.NewSessionRequest): Promise<acp.NewSessionResponse> {
		return {
			sessionId: "fake-session",
			configOptions: [
				{
					id: "model",
					name: "Model",
					type: "select",
					category: "model",
					currentValue: "composer-2.5",
					options: [{ value: "composer-2.5", name: "Composer 2.5" }],
				},
				{
					id: "fast",
					name: "Fast",
					type: "select",
					currentValue: "true",
					options: [
						{ value: "false", name: "Off" },
						{ value: "true", name: "Fast" },
					],
				},
			],
		};
	}

	async setSessionConfigOption(
		params: acp.SetSessionConfigOptionRequest,
	): Promise<acp.SetSessionConfigOptionResponse> {
		state.configSets.push(params);
		return { configOptions: [] };
	}

	async prompt(params: acp.PromptRequest): Promise<acp.PromptResponse> {
		state.promptText = params.prompt.map(item => (item.type === "text" ? item.text : "")).join("\n");
		const read = await connection.readTextFile({
			sessionId: params.sessionId,
			path: "/tmp/fake-acp.txt",
		});
		state.readContent = read.content;

		const terminal = await connection.createTerminal({
			sessionId: params.sessionId,
			command: "printf",
			args: ["%s", "fake shell"],
			cwd: "/tmp",
		});
		await terminal.waitForExit();
		const terminalOutput = await terminal.currentOutput();
		state.shellOutput = terminalOutput.output;
		await terminal.release();
		try {
			await terminal.currentOutput();
			state.releasedTerminalRejected = false;
		} catch {
			state.releasedTerminalRejected = true;
		}

		await connection.sessionUpdate({
			sessionId: params.sessionId,
			update: {
				sessionUpdate: "agent_message_chunk",
				content: {
					type: "text",
					text: JSON.stringify({
						initialize: state.initialize,
						configSets: state.configSets,
						promptText: state.promptText,
						readContent: state.readContent,
						shellOutput: state.shellOutput,
						releasedTerminalRejected: state.releasedTerminalRejected,
					}),
				},
			},
		});
		return { stopReason: "end_turn" };
	}

	async cancel(_params: acp.CancelNotification): Promise<void> {}
}

let connection: acp.AgentSideConnection;
const stream = acp.ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin));
connection = new acp.AgentSideConnection(() => new FakeAgent(), stream);
