import type { ImageContent } from "@gajae-code/ai/core";
import {
	MAX_IMAGE_INPUT_BYTES,
	MAX_PASTED_IMAGE_SOURCE_BYTES,
	MAX_STAGED_PROMPT_IMAGES,
} from "../../utils/image-limits";

export const SDK_REVISION_MAX_BODY_CHARS = 65_536;

export type SdkRevisionInput =
	| {
			readonly sessionId: string;
			readonly entryId: string;
			readonly action?: "edit";
			readonly body?: string;
			readonly images?: readonly ImageContent[];
	  }
	| {
			readonly sessionId: string;
			readonly entryId: string;
			readonly action: "select";
			readonly body?: never;
			readonly images?: never;
	  };

export interface SdkRevisionEditResult {
	sessionId: string;
	revised: true;
	entryId: string;
	replacementEntryId: string;
	assistantEntryId: string;
	status: "completed";
}

export interface SdkRevisionSelectionResult {
	sessionId: string;
	selected: true;
	entryId: string;
	leafEntryId: string;
	status: "selected";
}

export type SdkRevisionResult = SdkRevisionEditResult | SdkRevisionSelectionResult;

export function validRevisionEntryId(value: unknown): value is string {
	return (
		typeof value === "string" &&
		value.trim().length > 0 &&
		value.length <= 128 &&
		value.isWellFormed() &&
		!/[\u0000-\u001f\u007f]/u.test(value)
	);
}

const FIELDS = new Set(["sessionId", "entryId", "action", "body", "images"]);
const IMAGE_FIELDS = new Set(["type", "data", "mimeType"]);
const CANONICAL_BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;
const BASE64_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/** Pure wire validation and canonical fingerprint input; decoding stays inside the runtime. */
export function normalizeSdkRevisionInput(input: Readonly<Record<string, unknown>>): SdkRevisionInput | undefined {
	if (
		Object.keys(input).some(key => !FIELDS.has(key)) ||
		!validRevisionEntryId(input.sessionId) ||
		!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(input.sessionId) ||
		!validRevisionEntryId(input.entryId)
	)
		return undefined;
	const { sessionId, entryId } = input;
	if (input.action === "select") {
		if (Object.hasOwn(input, "body") || Object.hasOwn(input, "images")) return undefined;
		return { sessionId, entryId, action: "select" };
	}
	if (Object.hasOwn(input, "action") && input.action !== "edit") return undefined;
	if (
		Object.hasOwn(input, "body") &&
		(typeof input.body !== "string" || input.body.length > SDK_REVISION_MAX_BODY_CHARS || !input.body.isWellFormed())
	)
		return undefined;
	let images: ImageContent[] | undefined;
	if (Object.hasOwn(input, "images")) {
		if (!Array.isArray(input.images) || input.images.length === 0 || input.images.length > MAX_STAGED_PROMPT_IMAGES)
			return undefined;
		images = [];
		let total = 0;
		for (const candidate of input.images) {
			if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return undefined;
			const image = candidate as Record<string, unknown>;
			if (
				Object.keys(image).some(key => !IMAGE_FIELDS.has(key)) ||
				image.type !== "image" ||
				typeof image.data !== "string" ||
				!image.data.length ||
				image.data.length % 4 !== 0 ||
				image.data.length > Math.ceil(MAX_IMAGE_INPUT_BYTES / 3) * 4 ||
				typeof image.mimeType !== "string" ||
				!["image/png", "image/jpeg", "image/webp", "image/gif"].includes(image.mimeType) ||
				!CANONICAL_BASE64.test(image.data)
			)
				return undefined;
			const padding = image.data.endsWith("==") ? 2 : image.data.endsWith("=") ? 1 : 0;
			const bytes = (image.data.length / 4) * 3 - padding;
			if (bytes <= 0 || bytes > MAX_IMAGE_INPUT_BYTES) return undefined;
			// Canonical padding bits, without allocating an untrusted decoded buffer.
			if (
				padding &&
				(BASE64_ALPHABET.indexOf(image.data[image.data.length - padding - 1]!) & (padding === 2 ? 15 : 3)) !== 0
			)
				return undefined;
			total += bytes;
			if (total > MAX_PASTED_IMAGE_SOURCE_BYTES) return undefined;
			images.push({ type: "image", data: image.data, mimeType: image.mimeType });
		}
	}
	if (!(typeof input.body === "string" && input.body.trim()) && !images?.length) return undefined;
	return {
		sessionId,
		entryId,
		action: "edit",
		body: typeof input.body === "string" ? input.body : "",
		...(images ? { images } : {}),
	};
}
