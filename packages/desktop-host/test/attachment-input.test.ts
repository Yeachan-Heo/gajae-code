import { describe, expect, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import { MAX_STAGED_PROMPT_IMAGES } from "@gajae-code/coding-agent/utils/image-limits";
import { SUPPORTED_INPUT_IMAGE_MIME_TYPES } from "@gajae-code/coding-agent/utils/image-loading";
import { prepareDesktopAttachmentInput, validateDesktopAttachmentPromptRequest } from "../src/attachment-input";
import {
	assertDesktopAttachmentRequestSize,
	DESKTOP_ATTACHMENT_IMAGE_MIMES,
	DESKTOP_ATTACHMENT_MAX_COUNT,
	DESKTOP_ATTACHMENT_NAME_BYTES,
	DESKTOP_ATTACHMENT_REQUEST_BYTES,
	type DesktopAttachment,
	type DesktopAttachmentPromptRequest,
	desktopAttachmentBase64Bytes,
	desktopAttachmentJsonBytes,
	validateDesktopAttachmentName,
	validateDesktopAttachmentText,
} from "../src/attachment-protocol";
import { MAX_FRAME_BYTES, parseRequest } from "../src/protocol";

const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC";
const image: DesktopAttachment = { kind: "image", name: "capture.png", mimeType: "image/png", data: PNG };

function request(attachments: DesktopAttachment[] = [], text = "Review these files"): DesktopAttachmentPromptRequest {
	return { id: "attachment-request", method: "prompt", params: { sessionId: "session-one", text, attachments } };
}

function exactFrame(attachments: DesktopAttachment[]): DesktopAttachmentPromptRequest {
	const value = request(attachments, "");
	const remaining = DESKTOP_ATTACHMENT_REQUEST_BYTES - desktopAttachmentJsonBytes(value);
	value.params.text = "漢".repeat(Math.floor(remaining / 3)) + "a".repeat(remaining % 3);
	return value;
}

describe("desktop host attachment transport validation", () => {
	test("matches production frame and canonical SDK image formats/count", () => {
		expect(DESKTOP_ATTACHMENT_REQUEST_BYTES).toBe(MAX_FRAME_BYTES);
		const transportMimes: string[] = [...DESKTOP_ATTACHMENT_IMAGE_MIMES];
		const sdkMimes: string[] = [...SUPPORTED_INPUT_IMAGE_MIME_TYPES];
		expect(transportMimes.sort()).toEqual(sdkMimes.sort());
		expect(DESKTOP_ATTACHMENT_MAX_COUNT).toBe(MAX_STAGED_PROMPT_IMAGES);
	});

	test("admits exactly 8 MiB with text, escaped JSON and base64; rejects one byte more", () => {
		const value = exactFrame([image, { kind: "text", name: "漢字.ts", text: 'const x = "漢字";\r\n\t' }]);
		expect(desktopAttachmentJsonBytes(value)).toBe(MAX_FRAME_BYTES);
		expect(validateDesktopAttachmentPromptRequest(value).params.attachments).toEqual(value.params.attachments);
		expect(parseRequest(JSON.stringify(value)).id).toBe(value.id);
		value.params.text += "a";
		expect(() => assertDesktopAttachmentRequestSize(value)).toThrow("8 MiB");
		expect(() => validateDesktopAttachmentPromptRequest(value)).toThrow("8 MiB");
		expect(() => parseRequest(JSON.stringify(value))).toThrow("frame limit");
	});

	test("counts multibyte envelope IDs, filenames, escaped controls and every attachment", () => {
		const value = request([{ kind: "text", name: "文書.ts", text: '\t"\\漢\n' }]);
		value.id = "要求";
		expect(desktopAttachmentJsonBytes(value)).toBe(Buffer.byteLength(JSON.stringify(value), "utf8"));
		expect(desktopAttachmentJsonBytes(value)).toBeGreaterThan(JSON.stringify(value).length);
		const small = request([{ kind: "text", name: "one.txt", text: "a".repeat(4 * 1024 * 1024) }]);
		expect(validateDesktopAttachmentPromptRequest(small).params.attachments?.length).toBe(1);
		small.params.attachments?.push({ kind: "text", name: "two.txt", text: "b".repeat(4 * 1024 * 1024) });
		expect(() => validateDesktopAttachmentPromptRequest(small)).toThrow("8 MiB");
	});

	test("counts exact base64 expansion at the transport boundary before decoding", () => {
		const value = request([], "");
		value.params.attachments = [{ ...image, data: "AAAA" }];
		const overhead = desktopAttachmentJsonBytes(value) - 4;
		const base64Bytes = Math.floor((MAX_FRAME_BYTES - overhead) / 4) * 4;
		value.params.attachments = [{ ...image, data: "A".repeat(base64Bytes) }];
		const remaining = MAX_FRAME_BYTES - desktopAttachmentJsonBytes(value);
		value.params.text = "a".repeat(remaining);
		expect(desktopAttachmentJsonBytes(value)).toBe(MAX_FRAME_BYTES);
		expect(
			desktopAttachmentBase64Bytes(
				value.params.attachments[0].kind === "image" ? value.params.attachments[0].data : "",
			),
		).toBe((base64Bytes / 4) * 3);
		expect(validateDesktopAttachmentPromptRequest(value).params.attachments?.length).toBe(1);
		value.params.attachments = [{ ...image, data: "A".repeat(base64Bytes + 4) }];
		expect(() => validateDesktopAttachmentPromptRequest(value)).toThrow("8 MiB");
	});

	test("uses UTF-8 filename bytes and refuses paths/control/bidi names", () => {
		expect(
			validateDesktopAttachmentPromptRequest(request([{ kind: "text", name: "漢".repeat(85), text: "x" }])).params
				.attachments?.length,
		).toBe(1);
		expect(Buffer.byteLength("漢".repeat(85))).toBe(DESKTOP_ATTACHMENT_NAME_BYTES);
		for (const name of [
			"漢".repeat(86),
			"../secret",
			"/etc/passwd",
			"C:\\secret",
			"a\0b",
			"a\nb",
			"a\u202eb",
			"",
			".",
			"..",
		]) {
			expect(() => validateDesktopAttachmentName(name)).toThrow("safe basename");
		}
	});

	test("rejects path/source fields and renderer-supplied SDK policy overrides", () => {
		for (const attached of [
			{ kind: "text", name: "secret.txt", path: "/etc/passwd" },
			{ kind: "text", name: "safe.txt", text: "x", sourcePath: "/etc/passwd" },
			{ ...image, path: "/etc/passwd" },
			{ ...image, text: "wrong kind" },
			{ kind: "file", name: "secret.txt", data: "AA==" },
		]) {
			expect(() =>
				validateDesktopAttachmentPromptRequest({
					...request(),
					params: { ...request().params, attachments: [attached] },
				}),
			).toThrow();
		}
		for (const key of [
			"supportsImageInput",
			"autoResize",
			"imagesBlocked",
			"images",
			"sdkRunCapability",
			"preflightSignal",
		])
			expect(() =>
				validateDesktopAttachmentPromptRequest({ ...request(), params: { ...request().params, [key]: true } }),
			).toThrow("Unknown");
	});

	test("rejects invalid envelopes and prompt parameter types before framing", () => {
		for (const value of [
			null,
			[],
			{},
			{ ...request(), method: "command.run" },
			{ ...request(), id: "" },
			{ ...request(), id: "a".repeat(129) },
			{ ...request(), params: [] },
			{ ...request(), params: { sessionId: "", text: "x" } },
			{ ...request(), params: { sessionId: "session-one", text: null } },
		])
			expect(() => prepareDesktopAttachmentInput(value)).toThrow();
	});

	test("rejects malformed objects, unsupported types/count and queue modes", () => {
		for (const attachments of [
			null,
			{},
			[null],
			["path"],
			[{ ...image, mimeType: "image/svg+xml" }],
			Array.from({ length: 17 }, () => image),
		])
			expect(() =>
				validateDesktopAttachmentPromptRequest({ ...request(), params: { ...request().params, attachments } }),
			).toThrow();
		for (const deliverAs of ["drop", "follow-up", false, null])
			expect(() =>
				validateDesktopAttachmentPromptRequest({ ...request(), params: { ...request().params, deliverAs } }),
			).toThrow("delivery");
	});

	test.each([
		"",
		"AA",
		"AB==",
		"AAB=",
		`${PNG}\n`,
		"data:image/png;base64,AA==",
	])("rejects noncanonical raw image transport %s", data => {
		expect(() => prepareDesktopAttachmentInput(request([{ ...image, data }]))).toThrow("canonical base64");
	});
});

// Image semantics belong to the real quota-owning facade, not this pure mapper.
// packages/coding-agent/test/sdk-image-input.test.ts covers:
// - "block/unsupported/model-change/resize-change prevents final dispatch without a provider turn";
// - "rejects ... with exact cleanup" (MIME mismatch/alias, corruption, forged fields/base64);
// - "rejects animated images, image count and decoded-pixel limits before admission";
// - "supported static MIME types round-trip canonical bytes when auto-resize is disabled";
// - "normalization uses canonical dimensions under live shared transient reservations";
// - "normalizer refuses insufficient scratch capacity before its encoder runs";
// - "%s cancellation before admission discards only owned staged bytes" and post-admission cancellation;
// - exact source/count, session/process quotas and genuine executed-queue settlement proofs.
// These are references to the SDK's assertions, not normalization/admission proof from desktop preparation.
describe("synchronous desktop attachment framing and raw source extraction", () => {
	test("preserves text/code content, file identity, line endings and escaped names", () => {
		const text = 'const greeting = "hello 𝛂";\r\n\treturn greeting;\n';
		const input = { kind: "text" as const, name: 'review "draft".ts', text };
		const prepared = prepareDesktopAttachmentInput(request([input]));
		expect(prepared.text).toContain(text);
		expect(prepared.text).toContain(JSON.stringify(input.name));
		expect(prepared.text.startsWith("Review these files\n\n")).toBe(true);
		expect(prepared.images).toEqual([]);
		expect(Object.keys(prepared).sort()).toEqual(["images", "text"]);
	});

	test.each(["steer", "followUp"] as const)("extracts raw image sources without queue admission for %s", deliverAs => {
		const value = request([image]);
		value.params.deliverAs = deliverAs;
		const prepared = prepareDesktopAttachmentInput(value);
		expect(prepared).toEqual({
			text: value.params.text,
			images: [{ type: "image", mimeType: "image/png", data: PNG }],
		});
		expect(value.params.deliverAs).toBe(deliverAs);
	});

	test("allows image-only input and empty selected UTF-8 files, not empty prompts", () => {
		const prepared = prepareDesktopAttachmentInput(request([image], ""));
		expect(prepared.text).toBe("");
		expect(prepared.images).toEqual([{ type: "image", mimeType: "image/png", data: PNG }]);
		const emptyFile = prepareDesktopAttachmentInput(request([{ kind: "text", name: "empty.txt", text: "" }], ""));
		expect(emptyFile.text).toContain("empty.txt");
		expect(
			prepareDesktopAttachmentInput({
				id: "plain",
				method: "prompt",
				params: { sessionId: "session-one", text: "  plain text\n" },
			}),
		).toEqual({ text: "  plain text\n", images: [] });
		expect(() => prepareDesktopAttachmentInput(request([], "  "))).toThrow("empty");
	});

	test("preserves selected image ordering and declared raw sources for SDK validation", () => {
		const sources: DesktopAttachment[] = [image, { ...image, name: "second.jpg", mimeType: "image/jpeg" }];
		const prepared = prepareDesktopAttachmentInput(request(sources));
		expect(prepared.images).toEqual([
			{ type: "image", mimeType: "image/png", data: PNG },
			{ type: "image", mimeType: "image/jpeg", data: PNG },
		]);
		// Deliberately mismatched second source is not decoded here; the metered SDK facade must reject it.
		expect(sources[1].name).toBe("second.jpg");
	});

	test("rejects controls, NUL and unpaired Unicode surrogates in text DTOs", () => {
		for (const text of ["a\0b", "a\u001bb", "a\u0085b", "a\ud800b", "a\udcffb"])
			expect(() => prepareDesktopAttachmentInput(request([{ kind: "text", name: "bad.txt", text }]))).toThrow(
				"UTF-8",
			);
		expect(validateDesktopAttachmentText("\ufeff漢字\t\r\n𝛂")).toBeUndefined();
	});

	test("never opens a path while framing selected bytes or rejecting renderer paths", () => {
		const file = vi.spyOn(Bun, "file");
		const read = vi.spyOn(fs, "readFile");
		const open = vi.spyOn(fs, "open");
		try {
			const prepared = prepareDesktopAttachmentInput(
				request([image, { kind: "text", name: "passwd", text: "operator-selected content" }]),
			);
			expect(prepared.text).toContain("operator-selected content");
			expect(() =>
				prepareDesktopAttachmentInput({
					...request(),
					params: { ...request().params, attachments: [{ kind: "text", name: "secret", path: "/etc/passwd" }] },
				}),
			).toThrow("Unknown");
			expect(file).not.toHaveBeenCalled();
			expect(read).not.toHaveBeenCalled();
			expect(open).not.toHaveBeenCalled();
		} finally {
			file.mockRestore();
			read.mockRestore();
			open.mockRestore();
		}
	});
});
