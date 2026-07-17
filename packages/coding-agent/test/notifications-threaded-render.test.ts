import { describe, expect, test } from "bun:test";
import { formatContextUpdate, formatIdentityHeader, renderThreadedFrame } from "../src/sdk/bus/threaded-render";

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

	test("finalized turn_stream suppresses dot-only placeholders", () => {
		expect(
			renderThreadedFrame({ type: "turn_stream", sessionId: "s", phase: "finalized", text: "." }),
		).toBeUndefined();
		expect(
			renderThreadedFrame({ type: "turn_stream", sessionId: "s", phase: "finalized", text: " . \n" }),
		).toBeUndefined();
		expect(
			renderThreadedFrame({ type: "turn_stream", sessionId: "s", phase: "finalized", text: "   " }),
		).toBeUndefined();
	});

	test("finalized turn_stream preserves meaningful completion summaries", () => {
		const send = renderThreadedFrame({
			type: "turn_stream",
			sessionId: "s",
			phase: "finalized",
			text: "Background job completed: tests passed",
		});
		expect(send).toMatchObject({
			method: "sendMessage",
			lane: "finalized",
			text: "Background job completed: tests passed",
		});
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
		expect(send?.text).toContain("session: <code>s</code>");

		const withCwd = formatContextUpdate({ type: "context_update", sessionId: "session-full", cwd: "gajae-worktree" });
		expect(withCwd).toContain("session: <code>session-full</code>");
		expect(withCwd).toContain("cwd: <code>gajae-worktree</code>");
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

	test("control_command_result renders escaped status output", () => {
		const send = renderThreadedFrame({
			type: "control_command_result",
			sessionId: "s",
			status: "ok",
			message: "Context: <25>/100 (25.0%)",
		});
		expect(send?.lane).toBe("idle");
		expect(send?.text).toContain("✅ Context: &lt;25&gt;/100 (25.0%)");
	});

	test("tool_activity edits a started bubble with its terminal result", () => {
		const started = renderThreadedFrame({
			type: "tool_activity",
			sessionId: "s",
			toolCallId: "call-7",
			toolName: "shell",
			phase: "started",
			argsSummary: "bun test",
		});
		const completed = renderThreadedFrame({
			type: "tool_activity",
			sessionId: "s",
			toolCallId: "call-7",
			toolName: "shell",
			phase: "completed",
			resultSummary: "passed",
		});
		expect(started).toMatchObject({ lane: "live", coalesceKey: "tool:call-7", editable: true });
		expect(completed).toMatchObject({ lane: "finalized", coalesceKey: "tool:call-7", editable: true });
		expect(started?.text).toContain("⚙ shell — started");
		expect(completed?.text).toContain("⚙ shell — ok");
		expect(completed?.richMarkdown).toBeUndefined();
	});

	test("reasoning_summary converts markdown once and remains editable", () => {
		const send = renderThreadedFrame({
			type: "reasoning_summary",
			sessionId: "s",
			turnRef: "turn-9",
			text: "<unsafe> & **bold**",
		});
		expect(send).toMatchObject({ lane: "finalized", coalesceKey: "reason:turn-9", editable: true });
		expect(send?.text).toBe("&lt;unsafe&gt; &amp; <b>bold</b>");
		expect(send?.text).not.toContain("&amp;lt;");
		expect(send?.richMarkdown).toBeUndefined();
	});
	test("reasoning_summary without a turnRef sends a fresh finalized message", () => {
		const send = renderThreadedFrame({ type: "reasoning_summary", sessionId: "s", text: "safe summary" });
		expect(send).toMatchObject({ lane: "finalized", editable: false });
		expect(send?.coalesceKey).toBeUndefined();
	});
	test("unknown frame types render nothing", () => {
		expect(renderThreadedFrame({ type: "some_future_frame", sessionId: "s" })).toBeUndefined();
		expect(renderThreadedFrame({ sessionId: "s" })).toBeUndefined();
	});

	test("formatIdentityHeader tolerates missing fields", () => {
		expect(formatIdentityHeader({ sessionId: "s" })).toContain("• repo: <code>?</code>");
	});
});

describe("renderThreadedFrame rich final-answer marker", () => {
	// The rich delivery marker (`richMarkdown`) is derived ONLY from a frame's
	// `finalAnswer` bit - never inferred from `phase` - and carries the RAW
	// markdown (pre-HTML), so the daemon can promote a rich final answer while
	// `text` stays the HTML-rendered fallback.
	test("a finalAnswer turn_stream carries the raw markdown as richMarkdown", () => {
		const raw = "**bold** answer with `code` and a [link](https://example.com)";
		const send = renderThreadedFrame({
			type: "turn_stream",
			sessionId: "s",
			phase: "finalized",
			finalAnswer: true,
			text: raw,
		});
		expect(send?.richMarkdown).toBe(raw);
		// richMarkdown is the RAW markdown, not the HTML-rendered `text`.
		expect(send?.text).not.toBe(raw);
		expect(send?.text).toContain("<b>bold</b>");
	});

	test("a finalized turn_stream with finalAnswer:false has no richMarkdown", () => {
		const send = renderThreadedFrame({
			type: "turn_stream",
			sessionId: "s",
			phase: "finalized",
			finalAnswer: false,
			text: "done",
		});
		expect(send?.lane).toBe("finalized");
		expect(send?.richMarkdown).toBeUndefined();
	});

	test("a finalized turn_stream without finalAnswer has no richMarkdown (marker not inferred from phase)", () => {
		const send = renderThreadedFrame({ type: "turn_stream", sessionId: "s", phase: "finalized", text: "done" });
		expect(send?.lane).toBe("finalized");
		expect(send?.richMarkdown).toBeUndefined();
	});

	test("a live turn_stream has no richMarkdown", () => {
		const send = renderThreadedFrame({
			type: "turn_stream",
			sessionId: "s",
			phase: "live",
			text: "partial",
			messageRef: "m-7",
		});
		expect(send?.lane).toBe("live");
		expect(send?.richMarkdown).toBeUndefined();
	});
});
