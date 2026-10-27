// Prints whether agentLoop attached GenAI message content to the chat span.
// Spawned with a controlled cwd so that directory's `.env` is the project
// dotenv the capture switch must ignore.
import { agentLoop } from "@gajae-code/agent-core/agent-loop";
import { GenAIAttr, PiGenAIAttr } from "@gajae-code/agent-core/telemetry";
import type { AgentContext, AgentLoopConfig, AgentMessage } from "@gajae-code/agent-core/types";
import type { Message } from "@gajae-code/ai";
import { createMockModel } from "@gajae-code/ai/providers/mock";
import { setProjectDir } from "@gajae-code/utils";
import { context, trace } from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import { BasicTracerProvider, InMemorySpanExporter, SimpleSpanProcessor } from "@opentelemetry/sdk-trace-base";

const CANARY = "gjc-capture-canary";
const ENV_NAME = "OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT";

function identityConverter(messages: AgentMessage[]): Message[] {
	return messages.filter(
		message => message.role === "user" || message.role === "assistant" || message.role === "toolResult",
	) as Message[];
}

async function main(): Promise<void> {
	const beforeLoop = process.env.OTEL_CAPTURE_TRUST_BEFORE_LOOP;
	// "delete" removes the key after import and before the first loop.
	if (beforeLoop === "delete") delete process.env[ENV_NAME];
	else if (beforeLoop !== undefined) process.env[ENV_NAME] = beforeLoop;
	const moveTo = process.env.OTEL_CAPTURE_TRUST_MOVE_TO;
	if (moveTo !== undefined) setProjectDir(moveTo);
	trace.disable();
	context.disable();
	const contextManager = new AsyncLocalStorageContextManager().enable();
	context.setGlobalContextManager(contextManager);
	const exporter = new InMemorySpanExporter();
	const provider = new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] });
	trace.setGlobalTracerProvider(provider);

	const mock = createMockModel({
		id: "mock-model",
		provider: "mock-provider",
		responses: [{ content: ["ack"], stopReason: "stop" }],
	});
	const warnings: string[] = [];
	const prompts: AgentMessage[] = [{ role: "user", content: CANARY, timestamp: Date.now() }];
	const ctx: AgentContext = { systemPrompt: ["sys-instruction"], messages: [], tools: [] };
	const config: AgentLoopConfig = {
		model: mock.model,
		convertToLlm: identityConverter,
		telemetry: {
			tracer: provider.getTracer("otel-content-capture-trust"),
			onTelemetryWarning: warning => {
				warnings.push(warning.code);
			},
		},
	};

	for await (const _event of agentLoop(prompts, ctx, config, undefined, mock.stream)) {
		// Drain the public agent loop so chat spans finish.
	}

	const chat = exporter.getFinishedSpans().find(span => span.name === "chat mock-model");
	if (!chat) throw new Error("chat span missing");
	const input = chat.attributes[GenAIAttr.InputMessages];
	const output = chat.attributes[GenAIAttr.OutputMessages];
	const system = chat.attributes[GenAIAttr.SystemInstructions];
	const request = chat.attributes[PiGenAIAttr.RequestMessages];
	const response = chat.attributes[PiGenAIAttr.ResponseText];
	console.log(
		JSON.stringify({
			spanFound: true,
			envValue: process.env[ENV_NAME] ?? null,
			inputMessages: typeof input === "string" ? input : null,
			outputMessages: typeof output === "string" ? output : null,
			systemInstructions: typeof system === "string" ? system : null,
			requestMessages: typeof request === "string" ? request : null,
			responseText: typeof response === "string" ? response : null,
			warnings,
		}),
	);
	await provider.shutdown();
	context.disable();
	trace.disable();
}

main().catch(error => {
	console.error(error);
	process.exit(1);
});
