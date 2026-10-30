import { describe, expect, test, vi } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
	DESKTOP_ATTACHMENT_REQUEST_BYTES,
	type DesktopAttachment,
	desktopAttachmentBase64Bytes,
} from "../../desktop-host/src/attachment-protocol";
import {
	AttachmentPicker,
	type DesktopAttachmentDraft,
	desktopClipboardImageFiles,
	readDesktopAttachmentFile,
	readyDesktopAttachments,
	settleDesktopAttachmentDraft,
} from "../src/AttachmentPicker";

const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC";
const image: DesktopAttachment = { kind: "image", name: "capture.png", mimeType: "image/png", data: PNG };
const options = { supportsImageInput: true };

describe("browser-safe attachment base64 protocol", () => {
	test.each([
		["AA==", 1],
		["AAA=", 2],
		["AAAA", 3],
		["AQIDBA==", 4],
	] as const)("counts canonical base64 %s as %d bytes", (data, bytes) => {
		expect(desktopAttachmentBase64Bytes(data)).toBe(bytes);
	});

	test.each([
		"",
		"A",
		"AAA",
		"====",
		"AA===",
		"AA==\n",
		"AA-_",
		"data:image/png;base64,AA==",
		"AB==",
		"AAB=",
		"AA=A",
	])("rejects malformed, noncanonical or mismatched base64 %s", data => {
		expect(() => desktopAttachmentBase64Bytes(data)).toThrow("canonical base64");
	});
});

describe("browser selection and per-session draft ownership", () => {
	test("reads real UTF-8 File bytes without changing BOM, Unicode or line endings", async () => {
		const text = "\ufeffconst 인사 = '안녕 𝛂';\r\n\t// 끝\n";
		const file = new File([text], "예제.ts", { type: "application/typescript" });
		expect(await readDesktopAttachmentFile(file, options)).toEqual({ kind: "text", name: file.name, text });
	});

	test("reads actual clipboard-style image File bytes, including absent MIME with a supported extension", async () => {
		for (const type of ["image/png", ""]) {
			const file = new File([Buffer.from(PNG, "base64")], "clipboard.png", { type });
			expect(await readDesktopAttachmentFile(file, options)).toEqual(
				image.kind === "image" ? { ...image, name: "clipboard.png" } : image,
			);
		}
	});

	test("extracts only actual clipboard image Files and leaves ordinary text paste alone", async () => {
		const file = new File([Buffer.from(PNG, "base64")], "pasted.png", { type: "image/png" });
		const files = desktopClipboardImageFiles({
			items: [
				{ kind: "string", type: "text/plain", getAsFile: () => null },
				{ kind: "file", type: "image/png", getAsFile: () => file },
				{ kind: "file", type: "image/png", getAsFile: () => null },
				{ kind: "file", type: "application/pdf", getAsFile: () => new File(["pdf"], "excluded.pdf") },
			],
		});
		expect(files).toEqual([file]);
		expect(await readDesktopAttachmentFile(files[0], options)).toEqual({ ...image, name: file.name });
		expect(
			desktopClipboardImageFiles({ items: [{ kind: "string", type: "text/plain", getAsFile: () => null }] }),
		).toEqual([]);
	});

	test("refuses image-disabled selections before reading and rejects unsupported binary/invalid UTF-8", async () => {
		const file = new File([Buffer.from(PNG, "base64")], "capture.png", { type: "image/png" });
		const read = vi.spyOn(file, "arrayBuffer");
		try {
			await expect(readDesktopAttachmentFile(file, { supportsImageInput: false })).rejects.toThrow(
				"does not support image input",
			);
			await expect(
				readDesktopAttachmentFile(file, { supportsImageInput: true, imagesBlocked: true }),
			).rejects.toThrow("blocked in the SDK settings");
			expect(read).not.toHaveBeenCalled();
		} finally {
			read.mockRestore();
		}
		for (const binary of [
			new File(["%PDF-1.7"], "doc.pdf", { type: "application/pdf" }),
			new File([Uint8Array.of(0xff, 0xfe)], "binary.txt"),
			new File([Uint8Array.of(0x61, 0, 0x62)], "binary.bin"),
			new File(["svg"], "image.svg", { type: "image/svg+xml" }),
			new File([], "empty.png", { type: "image/png" }),
		])
			await expect(readDesktopAttachmentFile(binary, options)).rejects.toThrow();
	});

	test("refuses raw and base64-expanded oversize Files without reading bytes", async () => {
		for (const file of [
			new File([new Uint8Array(DESKTOP_ATTACHMENT_REQUEST_BYTES + 1)], "large.txt", { type: "text/plain" }),
			new File([new Uint8Array(6 * 1024 * 1024 + 1)], "large.png", { type: "image/png" }),
		]) {
			const read = vi.spyOn(file, "arrayBuffer");
			try {
				await expect(readDesktopAttachmentFile(file, options)).rejects.toThrow("8 MiB");
				expect(read).not.toHaveBeenCalled();
			} finally {
				read.mockRestore();
			}
		}
	});

	test("blocks sends while reading or errored, and never restores a removed/reset draft", () => {
		const reading: DesktopAttachmentDraft = { id: "original", name: "capture.png", size: 69, status: "reading" };
		const ready: DesktopAttachmentDraft = { ...reading, status: "ready", attachment: image };
		const failed: DesktopAttachmentDraft = {
			id: "failed",
			name: "bad.txt",
			size: 2,
			status: "error",
			error: "Invalid UTF-8",
		};
		expect(() => readyDesktopAttachments([reading])).toThrow("finish reading");
		expect(() => readyDesktopAttachments([failed])).toThrow("with an error");
		expect(readyDesktopAttachments(settleDesktopAttachmentDraft([reading], ready))).toEqual([image]);
		expect(settleDesktopAttachmentDraft([], ready)).toEqual([]);
		const differentSession: DesktopAttachmentDraft = { ...reading, id: "different-session" };
		expect(settleDesktopAttachmentDraft([differentSession], ready)).toEqual([differentSession]);
		expect(
			settleDesktopAttachmentDraft([failed], { ...failed, status: "ready", attachment: image, error: undefined }),
		).toEqual([failed]);
	});

	test("converts aggregate JSON/base64 overflow to a blocking removable error, without storing bytes in that error", () => {
		const large: DesktopAttachment = {
			kind: "image",
			name: "a.png",
			mimeType: "image/png",
			data: "A".repeat(6 * 1024 * 1024),
		};
		const first: DesktopAttachmentDraft = {
			id: "first",
			name: large.name,
			size: 4_718_592,
			status: "ready",
			attachment: large,
		};
		const reading: DesktopAttachmentDraft = { id: "second", name: large.name, size: 4_718_592, status: "reading" };
		const result: DesktopAttachmentDraft = { ...reading, status: "ready", attachment: large };
		const next = settleDesktopAttachmentDraft([first, reading], result);
		expect(next[1].status).toBe("error");
		expect(next[1].attachment).toBeUndefined();
		const rejected = next[1] as Extract<DesktopAttachmentDraft, { status: "error" }>;
		expect(rejected.error).toContain("together exceed the 8 MiB request limit");
		expect(rejected.error).not.toContain("AAAA");
		expect(() => readyDesktopAttachments(next)).toThrow("Remove the attachment with an error and select it again.");
	});

	test("renders real filename/size/pending/error/removal controls and explicit image-disabled state", () => {
		const drafts: DesktopAttachmentDraft[] = [
			{ id: "ready", name: "capture.png", size: 69, status: "ready", attachment: image },
			{ id: "pending", name: "reading.ts", size: 2048, status: "reading" },
			{ id: "error", name: "invalid.bin", size: 2, status: "error", error: "Invalid UTF-8" },
		];
		const html = renderToStaticMarkup(
			createElement(AttachmentPicker, {
				sessionId: "session-one",
				attachments: drafts,
				supportsImageInput: false,
				onChange: () => {},
			}),
		);
		expect(html).toContain('type="file"');
		expect(html).toContain('aria-busy="true"');
		expect(html).toContain("Remove capture.png");
		expect(html).toContain("2.0 KiB");
		expect(html).toContain("Invalid UTF-8");
		expect(html).toContain("Selected model has no image input");
		expect(html).toContain('aria-label="Attach file"');
		expect(html).not.toContain('aria-label="Image paste area"');
		expect(html).not.toContain('class="attachment-paste"');
		expect(html).not.toContain("Up to 16 files · 8 MiB total request");
		expect(html).not.toContain(PNG);
	});
});
