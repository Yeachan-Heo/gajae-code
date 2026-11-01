import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { DesktopMessage, DesktopMessageBlock } from "../../desktop-host/src/protocol";
import { Message } from "../src/components";

function render(message: DesktopMessage): string {
	return renderToStaticMarkup(<Message message={message} />);
}

const pngData = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR42mNQzvQHAAGOANzz4utYAAAAAElFTkSuQmCC";
const image: DesktopMessageBlock = { type: "image", mimeType: "image/png", data: pngData };

describe("desktop transcript rendering", () => {
	test("omits empty assistant records without a role, spinner or invented waiting text", () => {
		for (const blocks of [undefined, [], [{ type: "text" as const, text: "" }]]) {
			expect(render({ id: "empty", role: "assistant", text: "", blocks })).toBe("");
		}
		expect(render({ id: "whitespace", role: "assistant", text: " \n\t　" })).toBe("");
		expect(render({ id: "whitespace-blocks", role: "assistant", text: "summary", blocks: [
			{ type: "text", text: " \n" }, { type: "thinking", text: "\t　" },
		] })).toBe("");
	});

	test("renders supplied blocks in order, escaping text and exposing actual thinking in a disclosure", () => {
		const html = render({ id: "mixed", role: "assistant", text: "summary should not appear", blocks: [
			{ type: "text", text: "first <script>" },
			{ type: "thinking", text: " \n " },
			{ type: "thinking", text: "actual thought" },
			image,
			{ type: "text", text: "last text" },
		] });
		expect(html).toContain("first &lt;script&gt;");
		expect(html).toContain("<details");
		expect(html).toContain("Reasoning");
		expect(html).toContain("actual thought");
		expect(html.match(/Reasoning/g)).toHaveLength(1);
		expect(html.indexOf("first &lt;script&gt;")).toBeLessThan(html.indexOf("actual thought"));
		expect(html.indexOf("actual thought")).toBeLessThan(html.indexOf("<figure"));
		expect(html.indexOf("<figure")).toBeLessThan(html.indexOf("last text"));
		expect(html).not.toContain("summary should not appear");
		expect(render({ id: "thought", role: "assistant", text: "", blocks: [{ type: "thinking", text: "real thought" }] })).toContain("real thought");
		expect(render({ id: "plain", role: "assistant", text: "plain text" })).toContain("plain text");
	});

	test("renders safe inline images and explains unavailable and invalid media", () => {
		const html = render({ id: "user-image", role: "user", text: "", blocks: [image] });
		expect(html).toContain(`src="data:image/png;base64,${pngData}"`);
		expect(html).toContain('alt="Image in the conversation"');
		for (const bad of [
			{ type: "image", mimeType: "image/svg+xml", data: "AAAA" },
			{ type: "image", mimeType: "image/png", data: "https://example.com/image.png" },
			{ type: "image", mimeType: "image/png", data: "A===" },
			{ type: "image", mimeType: "image/png", data: "AAA" },
			{ type: "image", mimeType: "image/png", data: "AA=A" },
		] as unknown as DesktopMessageBlock[]) {
			const invalid = render({ id: "invalid", role: "user", text: "", blocks: [bad] });
			expect(invalid).toContain("This image cannot be shown");
			expect(invalid).not.toContain("<img");
			expect(invalid).not.toContain("https://example.com");
		}
		const unavailable = render({ id: "unavailable", role: "user", text: "", blocks: [{ type: "image-unavailable", reason: "<unsafe>" }] });
		expect(unavailable).toContain("&lt;unsafe&gt;");
		expect(unavailable).not.toContain("<img");
	});

	test("keeps tool disclosure, bounded content and truthful status labels", () => {
		const html = render({ id: "tool", role: "tool", toolName: "read", text: "", truncated: true, isError: true, excludeFromContext: true, blocks: [{ type: "text", text: "actual output" }, image] });
		expect(html).toContain("tool-disclosure");
		expect(html).toContain("bounded-output");
		expect(html).toContain("actual output");
		expect(html).toContain("<img");
		expect(html).toContain("Failed");
		expect(html).toContain("Excluded from model context");
		expect(html).toContain("The start of this message was omitted");
		const cancelled = render({ id: "cancelled", role: "tool", text: "", cancelled: true });
		expect(cancelled).toContain("Cancelled");
		expect(cancelled).toContain("No output");
		expect(cancelled).not.toContain("Waiting for the connection");
		expect(render({ id: "blank-tool", role: "tool", text: " \n" })).toContain("No output");
	});
});
