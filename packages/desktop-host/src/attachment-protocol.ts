/** Browser-safe attachment transport. No filesystem paths, SDK objects or persistence. */
export type DesktopAttachment =
	| { kind: "text"; name: string; text: string }
	| { kind: "image"; name: string; mimeType: DesktopAttachmentImageMime; data: string };

/** Mirrors the public SDK's supported source formats; the host checks its canonical set. */
export type DesktopAttachmentImageMime = "image/png" | "image/jpeg" | "image/gif" | "image/webp";
export const DESKTOP_ATTACHMENT_IMAGE_MIMES: readonly DesktopAttachmentImageMime[] = [
	"image/png",
	"image/jpeg",
	"image/gif",
	"image/webp",
];
/** The production desktop transport frame ceiling, including the entire JSON envelope. */
export const DESKTOP_ATTACHMENT_REQUEST_BYTES = 8 * 1024 * 1024;
export const DESKTOP_ATTACHMENT_MAX_COUNT = 16;
export const DESKTOP_ATTACHMENT_NAME_BYTES = 255;

export interface DesktopAttachmentPromptRequest {
	id: string;
	method: "prompt";
	params: {
		sessionId: string;
		/** Captured renderer owner, never a grant to reconnect or adopt a writer. */
		sessionGeneration?: number | null;
		text: string;
		attachments?: DesktopAttachment[];
		deliverAs?: "steer" | "followUp";
	};
}

export function desktopAttachmentJsonBytes(value: unknown): number {
	const json = JSON.stringify(value);
	if (json === undefined) throw new Error("Invalid attachment request.");
	return new TextEncoder().encode(json).byteLength;
}

/** Must receive the original request, not just params or the decoded attachment bytes. */
export function assertDesktopAttachmentRequestSize(request: unknown): void {
	if (desktopAttachmentJsonBytes(request) > DESKTOP_ATTACHMENT_REQUEST_BYTES)
		throw new Error("Attachment request exceeds the 8 MiB frame limit.");
}

/** Names are display-only basenames, never capabilities to open a host file. */
export function validateDesktopAttachmentName(name: unknown): asserts name is string {
	if (
		typeof name !== "string" ||
		!name.trim() ||
		name === "." ||
		name === ".." ||
		/[\\/\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/u.test(name) ||
		new TextEncoder().encode(name).byteLength > DESKTOP_ATTACHMENT_NAME_BYTES ||
		!isWellFormedText(name)
	)
		throw new Error("Attachment filename must be a safe basename of at most 255 UTF-8 bytes.");
}

function isWellFormedText(value: string): boolean {
	return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(new TextEncoder().encode(value)) === value;
}

/** UTF-8 text/code only; tabs and line endings are allowed, terminal/binary controls are not. */
export function validateDesktopAttachmentText(text: unknown): asserts text is string {
	if (
		typeof text !== "string" ||
		!isWellFormedText(text) ||
		/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/u.test(text)
	)
		throw new Error("Attachments must contain valid UTF-8 text without binary or control characters.");
}

export function isDesktopAttachmentImageMime(value: string): value is DesktopAttachmentImageMime {
	return DESKTOP_ATTACHMENT_IMAGE_MIMES.some(mime => mime === value);
}

/** Canonical padded base64, including unused pad bits. Does not allocate decoded bytes. */
export function desktopAttachmentBase64Bytes(data: unknown): number {
	if (
		typeof data !== "string" ||
		!data.length ||
		data.length > DESKTOP_ATTACHMENT_REQUEST_BYTES ||
		data.length % 4 !== 0 ||
		!/^[A-Za-z0-9+/]+={0,2}$/u.test(data)
	)
		throw new Error("Image data must be canonical base64.");
	const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
	const padding = data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0;
	const tail = alphabet.indexOf(data[data.length - padding - 1]);
	if ((padding === 2 && (tail & 15) !== 0) || (padding === 1 && (tail & 3) !== 0))
		throw new Error("Image data must be canonical base64.");
	return (data.length / 4) * 3 - padding;
}
