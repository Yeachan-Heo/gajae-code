import { describe, expect, test } from "bun:test";
import { formatIdentityHeader, renderThreadedFrame } from "../src/notifications/threaded-render";

describe("renderThreadedFrame", () => {
	test("identity_header renders pinned bullets with identity flag", () => {
		const send = renderThreadedFrame({
			type: "identity_header",
			sessionId: "sess-1",
			repo: "gajae-code",
			branch: "feat/notification-surface",
			machine: "mac-studio",
			title: "Rebuild notifications",
		});
		expect(send?.method).toBe("sendMessage");
		expect(send?.identity).toBe(true);
		expect(send?.lane).toBe("finalized");
		expect(send?.text).toContain("<b>Rebuild notifications</b>");
		expect(send?.text).toContain("• repo: <code>gajae-code</code>");
		expect(send?.text).toContain("• branch: <code>feat/notification-surface</code>");
		expect(send?.text).toContain("• machine: <code>mac-studio</code>");
		expect(send?.text).toContain("• session: <code>sess-1</code>");
	});

	test("finalized turn_stream is finalized lane with no coalesce key", () => {
		const send = renderThreadedFrame({ type: "turn_stream", sessionId: "s", phase: "finalized", text: "done" });
		expect(send).toMatchObject({ method: "sendMessage", lane: "finalized", text: "done" });
		expect(send?.coalesceKey).toBeUndefined();
	});

	test("live turn_stream uses live lane and a coalesce key from messageRef", () => {
		const send = renderThreadedFrame({
			type: "turn_stream",
			sessionId: "s",
			phase: "live",
			text: "partial",
			messageRef: "m-7",
		});
		expect(send?.lane).toBe("live");
		expect(send?.coalesceKey).toBe("turn:m-7");
	});

	test("context_update omits empty fields and is undefined when fully empty", () => {
		expect(renderThreadedFrame({ type: "context_update", sessionId: "s" })).toBeUndefined();
		const send = renderThreadedFrame({
			type: "context_update",
			sessionId: "s",
			tokenUsage: "12k/200k",
			model: "opus",
		});
		expect(send?.lane).toBe("live");
		expect(send?.coalesceKey).toBe("ctx:s");
		expect(send?.text).toContain("ctx: <code>12k/200k · opus</code>");
	});

	test("image_attachment renders a sendPhoto with caption", () => {
		const send = renderThreadedFrame({
			type: "image_attachment",
			sessionId: "s",
			source: "computer",
			mime: "image/png",
			data: "AAAA",
			caption: "screen",
		});
		expect(send).toMatchObject({
			method: "sendPhoto",
			lane: "finalized",
			photoBase64: "AAAA",
			mime: "image/png",
			text: "screen",
		});
	});

	test("image_attachment without data renders nothing", () => {
		expect(renderThreadedFrame({ type: "image_attachment", sessionId: "s", mime: "image/png" })).toBeUndefined();
	});

	test("file_attachment renders a sendDocument with filename, mime, and caption", () => {
		const send = renderThreadedFrame({
			type: "file_attachment",
			sessionId: "s",
			name: "report.pdf",
			mime: "application/pdf",
			data: "QkFTRTY0",
			caption: "the report",
		});
		expect(send).toMatchObject({
			method: "sendDocument",
			lane: "finalized",
			documentBase64: "QkFTRTY0",
			fileName: "report.pdf",
			mime: "application/pdf",
			text: "the report",
		});
	});

	test("file_attachment without data renders nothing", () => {
		expect(renderThreadedFrame({ type: "file_attachment", sessionId: "s", name: "x.bin" })).toBeUndefined();
	});

	test("config_update renders a low-priority status line", () => {
		const send = renderThreadedFrame({ type: "config_update", sessionId: "s", verbosity: "verbose", redact: false });
		expect(send?.lane).toBe("idle");
		expect(send?.text).toContain("verbosity verbose");
		expect(send?.text).toContain("redact off");
	});

	test("unknown frame types render nothing", () => {
		expect(renderThreadedFrame({ type: "some_future_frame", sessionId: "s" })).toBeUndefined();
		expect(renderThreadedFrame({ sessionId: "s" })).toBeUndefined();
	});

	test("formatIdentityHeader tolerates missing fields", () => {
		expect(formatIdentityHeader({ sessionId: "s" })).toContain("• repo: <code>?</code>");
	});
});
