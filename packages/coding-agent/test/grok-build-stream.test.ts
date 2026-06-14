import { describe, expect, it, spyOn } from "bun:test";
import type { Api, Context, Model, SimpleStreamOptions } from "@gajae-code/ai";
import * as openaiResponses from "@gajae-code/ai/providers/openai-responses";
import { AssistantMessageEventStream } from "@gajae-code/ai/utils/event-stream";
import { streamGrokCli } from "../src/defaults/gjc/extensions/grok-cli-vendor/src/provider/stream";

describe("Grok Build stream wrapper", () => {
	it("forwards requests through OpenAI responses with Grok Build headers", () => {
		const captured: { model?: Model<Api>; options?: unknown } = {};
		const spy = spyOn(openaiResponses, "streamOpenAIResponses").mockImplementation((model, _context, options) => {
			captured.model = model as Model<Api>;
			captured.options = options as unknown;
			return new AssistantMessageEventStream();
		});
		try {
			const model = {
				provider: "grok-build",
				id: "grok-composer-2.5-fast",
				api: "grok-cli-responses",
			} as Model<Api>;
			const context = { messages: [], systemPrompt: [] } as unknown as Context;

			const stream = streamGrokCli(model, context, {
				sessionId: "session-123",
				headers: { "x-test": "ok" },
			} as SimpleStreamOptions);

			expect(stream).toBeInstanceOf(AssistantMessageEventStream);
			expect(spy).toHaveBeenCalledTimes(1);
			expect(captured.model?.provider).toBe("grok-build");
			expect(captured.model?.id).toBe("grok-composer-2.5-fast");
			expect(captured.model?.api).toBe("openai-responses");
			expect((captured.options as { headers?: Record<string, string> } | undefined)?.headers).toMatchObject({
				"x-test": "ok",
				"x-grok-client-identifier": "gjc-grok-cli",
				"x-grok-client-version": "0.2.33",
				"x-grok-conv-id": "session-123",
				"x-grok-model-override": "grok-composer-2.5-fast",
				"x-xai-token-auth": "xai-grok-cli",
			});
		} finally {
			spy.mockRestore();
		}
	});
});
