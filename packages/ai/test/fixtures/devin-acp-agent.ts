/**
 * Spec-faithful ACP agent used by the Devin provider tests.
 *
 * Devin CLI is not installed in CI, so the Devin provider is exercised against
 * this fixture instead: it speaks the same Agent Client Protocol v1 over stdio
 * through the official `@agentclientprotocol/sdk`, which is the interface
 * `devin acp` implements. Scenarios are selected by argv:
 *
 *   bun test/fixtures/devin-acp-agent.ts <scenario> [receipt-path] [acp]
 *
 * The trailing `acp` verb mirrors the real argv shape the provider builds
 * (`devin acp`) and is ignored here.
 */
import * as fs from "node:fs";
import * as stream from "node:stream";
import {
	type Agent,
	AgentSideConnection,
	type NewSessionRequest,
	type NewSessionResponse,
	ndJsonStream,
	type PromptRequest,
	type PromptResponse,
	RequestError,
	type SessionConfigOption,
	type SetSessionConfigOptionRequest,
} from "@agentclientprotocol/sdk";

const scenario = process.argv[2] ?? "chat";
// The provider appends the `acp` verb after the args, so argv[3] is a receipt path
// only when the caller actually supplied one.
const receiptPath = process.argv[3] === "acp" ? undefined : process.argv[3];

function baseModelOptions(): SessionConfigOption[] {
	return [
		{
			type: "select",
			id: "model",
			name: "Model",
			category: "model",
			currentValue: "adaptive",
			options: [
				{ value: "adaptive", name: "Adaptive" },
				{ value: "opus", name: "Opus" },
				{ value: "sonnet", name: "Sonnet" },
			],
		},
		{
			type: "select",
			id: "mode",
			name: "Mode",
			category: "mode",
			currentValue: "normal",
			options: [{ value: "normal", name: "Normal" }],
		},
	];
}

class FixtureAgent implements Agent {
	readonly #connection: AgentSideConnection;
	#configOptions: SessionConfigOption[] = scenario === "no-model-option" ? [] : baseModelOptions();
	#releaseCancel: (() => void) | undefined;

	constructor(connection: AgentSideConnection) {
		this.#connection = connection;
	}

	initialize() {
		return {
			protocolVersion: 1,
			agentInfo: { name: "devin-acp-fixture", version: "1.0.0" },
			agentCapabilities: { promptCapabilities: { image: scenario === "images" } },
		};
	}

	newSession(_params: NewSessionRequest): NewSessionResponse | Promise<NewSessionResponse> {
		if (scenario === "auth") {
			throw RequestError.authRequired(undefined, "fixture requires login");
		}
		const response = { sessionId: `fixture-${scenario}`, configOptions: this.#configOptions };
		// A handshake slow enough for the caller to cancel before `session/new` lands.
		if (scenario === "slow-session") return Bun.sleep(600).then(() => response);
		return response;
	}

	authenticate() {
		return {};
	}

	setSessionConfigOption(params: SetSessionConfigOptionRequest) {
		this.#configOptions = this.#configOptions.map(option =>
			option.id === params.configId && option.type === "select" && typeof params.value === "string"
				? { ...option, currentValue: params.value }
				: option,
		);
		return { configOptions: this.#configOptions };
	}

	cancel(): void {
		// Evidence for the provider's cancellation test: the receipt only appears
		// once this agent actually received `session/cancel` over ACP.
		if (receiptPath) {
			fs.writeFileSync(receiptPath, JSON.stringify({ scenario, cancelReceived: true }));
		}
		this.#releaseCancel?.();
	}

	async #send(
		sessionId: string,
		update: Parameters<AgentSideConnection["sessionUpdate"]>[0]["update"],
	): Promise<void> {
		await this.#connection.sessionUpdate({ sessionId, update });
	}

	async prompt(params: PromptRequest): Promise<PromptResponse> {
		const sessionId = params.sessionId;
		// `slow-chunks`/`slow-session` use the receipt to prove whether a prompt was
		// forwarded at all; the `cancel` scenario owns the receipt elsewhere.
		if (
			receiptPath &&
			(scenario === "slow-chunks" || scenario === "slow-session" || scenario === "chunk-then-silence")
		) {
			fs.writeFileSync(receiptPath, JSON.stringify({ scenario, promptReceived: true, pid: process.pid }));
		}
		switch (scenario) {
			case "slow-chunks": {
				// 8 updates, 120ms apart (~1s of activity): a gap-based idle budget never
				// expires while a whole-turn deadline would.
				for (let index = 0; index < 8; index++) {
					await Bun.sleep(120);
					await this.#send(sessionId, {
						sessionUpdate: "agent_message_chunk",
						content: { type: "text", text: `${index}` },
					});
				}
				return { stopReason: "end_turn" };
			}
			case "slow-session":
				return { stopReason: "end_turn" };
			case "chunk-then-silence": {
				// One update, then silence: the re-armed idle budget must still expire.
				await this.#send(sessionId, {
					sessionUpdate: "agent_message_chunk",
					content: { type: "text", text: "alive" },
				});
				await Bun.sleep(10_000);
				return { stopReason: "cancelled" };
			}
			case "chat": {
				await this.#send(sessionId, {
					sessionUpdate: "agent_thought_chunk",
					content: { type: "text", text: "planning" },
				});
				await this.#send(sessionId, {
					sessionUpdate: "agent_message_chunk",
					content: { type: "text", text: "hello " },
				});
				await this.#send(sessionId, {
					sessionUpdate: "agent_message_chunk",
					content: { type: "text", text: "world" },
				});
				await this.#send(sessionId, {
					sessionUpdate: "tool_call",
					toolCallId: "call-1",
					title: "Run the test suite",
					kind: "execute",
					status: "pending",
					rawInput: { command: "bun test" },
				});
				await this.#send(sessionId, {
					sessionUpdate: "tool_call_update",
					toolCallId: "call-1",
					status: "completed",
					content: [{ type: "content", content: { type: "text", text: "ok" } }],
				});
				await this.#send(sessionId, {
					sessionUpdate: "agent_message_chunk",
					content: { type: "text", text: " done" },
				});
				return { stopReason: "end_turn" };
			}
			case "permission":
			case "permission-reject-only":
			case "permission-allow-always-only": {
				const allowOnce = { optionId: "allow-once", name: "Allow once", kind: "allow_once" as const };
				const allowAlways = { optionId: "allow-always", name: "Always allow", kind: "allow_always" as const };
				const rejectOnce = { optionId: "reject-once", name: "Reject", kind: "reject_once" as const };
				const rejectAlways = { optionId: "reject-always", name: "Always reject", kind: "reject_always" as const };
				const options =
					scenario === "permission-reject-only"
						? [rejectOnce]
						: scenario === "permission-allow-always-only"
							? [allowAlways, rejectAlways]
							: [allowOnce, allowAlways, rejectOnce];
				const response = await this.#connection.requestPermission({
					sessionId,
					toolCall: { toolCallId: "call-perm", title: "Delete build output", kind: "delete" },
					options,
				});
				await this.#send(sessionId, {
					sessionUpdate: "agent_message_chunk",
					content: { type: "text", text: `decision:${JSON.stringify(response.outcome)}` },
				});
				return { stopReason: "end_turn" };
			}
			case "cancel": {
				await this.#send(sessionId, {
					sessionUpdate: "agent_message_chunk",
					content: { type: "text", text: "waiting-for-cancel" },
				});
				await new Promise<void>(resolve => {
					this.#releaseCancel = resolve;
				});
				return { stopReason: "cancelled" };
			}
			case "session": {
				await this.#send(sessionId, {
					sessionUpdate: "agent_message_chunk",
					content: { type: "text", text: `session:${sessionId}` },
				});
				return { stopReason: "end_turn" };
			}
			case "model": {
				const modelOption = this.#configOptions.find(option => option.category === "model");
				const current = modelOption?.type === "select" ? modelOption.currentValue : "none";
				await this.#send(sessionId, {
					sessionUpdate: "agent_message_chunk",
					content: { type: "text", text: `model:${current}` },
				});
				return { stopReason: "end_turn" };
			}
			case "images": {
				const imageCount = params.prompt.filter(block => block.type === "image").length;
				const textCount = params.prompt.filter(block => block.type === "text").length;
				await this.#send(sessionId, {
					sessionUpdate: "agent_message_chunk",
					content: { type: "text", text: `images:${imageCount}:texts:${textCount}` },
				});
				return { stopReason: "end_turn" };
			}
			case "crash": {
				await this.#send(sessionId, {
					sessionUpdate: "agent_message_chunk",
					content: { type: "text", text: "about to crash" },
				});
				// Kills the agent process mid-turn so the provider must report a crash.
				process.exit(9);
				break;
			}
			case "refusal":
				return { stopReason: "refusal" };
			case "limits":
				return { stopReason: "max_tokens" };
			default:
				break;
		}
		return { stopReason: "end_turn" };
	}
}

const connection = new AgentSideConnection(
	conn => new FixtureAgent(conn),
	ndJsonStream(stream.Writable.toWeb(process.stdout), stream.Readable.toWeb(process.stdin)),
);
await connection.closed;
