import type { MockModel } from "@gajae-code/ai/providers/mock";
import { AssistantMessageEventStream } from "@gajae-code/ai/utils/event-stream";

/** Exercise recovery before any assistant content has been published. */
export function terminalOnlyStream(stream: MockModel["stream"]): MockModel["stream"] {
	return (model, context, options) => {
		const upstream = stream(model, context, options);
		const terminal = new AssistantMessageEventStream();
		void (async () => {
			for await (const event of upstream) {
				if (event.type === "done" || event.type === "error") terminal.push(event);
			}
			terminal.end();
		})().catch(error => terminal.fail(error));
		return terminal;
	};
}
