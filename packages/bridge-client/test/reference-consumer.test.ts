import { describe, expect, it } from "bun:test";
import { ReferenceBridgeConsumer, renderBridgeFrame } from "../src/reference-consumer";

describe("reference bridge consumer", () => {
	it("renders event, permission, and response frames as semantic HTML", () => {
		const consumer = new ReferenceBridgeConsumer();
		consumer.consume({
			protocol_version: 2,
			session_id: "sess-1",
			seq: 1,
			frame_id: "frame-1",
			type: "event",
			payload: { event_type: "message_update", event: { type: "message_update" } },
		});
		consumer.consume({
			protocol_version: 2,
			session_id: "sess-1",
			seq: 2,
			frame_id: "frame-2",
			correlation_id: "tool-1",
			type: "permission_request",
			payload: { kind: "permission", toolCall: { toolName: "bash" } },
		});
		consumer.consume({
			protocol_version: 2,
			session_id: "sess-1",
			seq: 3,
			frame_id: "frame-3",
			type: "response",
			payload: { command: "prompt", success: true },
		});
		const html = consumer.renderDocument();
		expect(html).toContain("message_update");
		expect(html).toContain("permission");
		expect(html).toContain('data-correlation="tool-1"');
		expect(html).toContain("prompt");
	});

	it("escapes payload summaries", () => {
		const rendered = renderBridgeFrame({
			protocol_version: 2,
			session_id: "sess-1",
			seq: 1,
			frame_id: "frame-1",
			type: "event<script>",
			payload: { event_type: "message_update<script>" },
		});
		expect(rendered.html).toContain("message_update&lt;script&gt;");
		expect(rendered.html).not.toContain("message_update<script>");
	});
});
