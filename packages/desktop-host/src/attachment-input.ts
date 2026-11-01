import type { ImageContent } from "@gajae-code/ai/core";
import {
	assertDesktopAttachmentRequestSize,
	DESKTOP_ATTACHMENT_MAX_COUNT,
	type DesktopAttachment,
	type DesktopAttachmentPromptRequest,
	desktopAttachmentBase64Bytes,
	isDesktopAttachmentImageMime,
	validateDesktopAttachmentName,
	validateDesktopAttachmentText,
} from "./attachment-protocol";

export interface PreparedDesktopAttachmentInput {
	text: string;
	/** Raw canonical source bytes; dispatch only through createSessionImageInput(session). */
	images: ImageContent[];
}

function object(value: unknown, fields: readonly string[]): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid attachment input object.");
	const record = value as Record<string, unknown>;
	if (Object.keys(record).some(key => !fields.includes(key))) throw new Error("Unknown attachment input field.");
	return record;
}

function attachment(value: unknown): DesktopAttachment {
	const input = object(value, ["kind", "name", "text", "mimeType", "data"]);
	validateDesktopAttachmentName(input.name);
	if (input.kind === "text") {
		object(input, ["kind", "name", "text"]);
		validateDesktopAttachmentText(input.text);
		return { kind: "text", name: input.name, text: input.text };
	}
	if (input.kind === "image") {
		object(input, ["kind", "name", "mimeType", "data"]);
		if (typeof input.mimeType !== "string" || !isDesktopAttachmentImageMime(input.mimeType))
			throw new Error("Unsupported image MIME type.");
		if (typeof input.data !== "string") throw new Error("Image data must be canonical base64.");
		desktopAttachmentBase64Bytes(input.data);
		return { kind: "image", name: input.name, mimeType: input.mimeType, data: input.data };
	}
	throw new Error("Unsupported attachment kind.");
}

/** Validate the original full transport envelope; renderer paths and SDK-policy overrides are forbidden. */
export function validateDesktopAttachmentPromptRequest(value: unknown): DesktopAttachmentPromptRequest {
	assertDesktopAttachmentRequestSize(value);
	const request = object(value, ["id", "method", "params"]);
	if (typeof request.id !== "string" || !request.id || request.id.length > 128 || request.method !== "prompt")
		throw new Error("Invalid attachment prompt envelope.");
	const params = object(request.params, ["sessionId", "sessionGeneration", "text", "attachments", "deliverAs"]);
	if (typeof params.sessionId !== "string" || !params.sessionId || typeof params.text !== "string")
		throw new Error("Invalid attachment prompt parameters.");
	const generation = params.sessionGeneration;
	if (
		generation !== undefined &&
		generation !== null &&
		(typeof generation !== "number" || !Number.isSafeInteger(generation) || generation < 0)
	)
		throw new Error("Invalid prompt session generation.");
	if (params.deliverAs !== undefined && params.deliverAs !== "steer" && params.deliverAs !== "followUp")
		throw new Error("Unsupported queued attachment delivery.");
	if (
		params.attachments !== undefined &&
		(!Array.isArray(params.attachments) || params.attachments.length > DESKTOP_ATTACHMENT_MAX_COUNT)
	)
		throw new Error("Too many attachments; at most 16 files can be selected.");
	const attachments = (params.attachments as unknown[] | undefined)?.map(attachment);
	return {
		id: request.id,
		method: "prompt",
		params: {
			sessionId: params.sessionId,
			...(typeof generation === "number" || generation === null ? { sessionGeneration: generation } : {}),
			text: params.text,
			...(attachments ? { attachments } : {}),
			...(params.deliverAs ? { deliverAs: params.deliverAs } : {}),
		},
	};
}

/**
 * Synchronous transport validation and text framing only: no file access, decoding,
 * normalization or admission. The public SDK image facade owns actual model/settings
 * gates, normalization, resource quotas and settlement. Never dispatch these raw
 * images through the unmetered low-level AgentSession prompt/queue APIs.
 */
export function prepareDesktopAttachmentInput(value: unknown): PreparedDesktopAttachmentInput {
	const request = validateDesktopAttachmentPromptRequest(value);
	const attachments = request.params.attachments ?? [];
	const images: ImageContent[] = [];
	const textFiles: string[] = [];
	for (const input of attachments) {
		if (input.kind === "image") images.push({ type: "image", mimeType: input.mimeType, data: input.data });
		else
			textFiles.push(
				`--- Attached UTF-8 file: ${JSON.stringify(input.name)} ---\n${input.text}\n--- End attached file ---`,
			);
	}
	const text = [request.params.text, ...textFiles].filter(part => part.length > 0).join("\n\n");
	if (!text.trim() && images.length === 0) throw new Error("Prompt must not be empty.");
	return { text, images };
}
