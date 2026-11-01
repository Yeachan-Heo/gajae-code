import type { AgentMessage } from "@gajae-code/agent-core";
import { getSessionMessageEntryId } from "@gajae-code/coding-agent/sdk";
import type { DesktopMessage, DesktopMessageBlock } from "./protocol";

export const HISTORY_LIMIT = 160;
export const TEXT_LIMIT = 8_000;
export const HISTORY_PAGE_BYTES = 2_000_000;
/** Maximum encoded bytes for one inline preview. The enclosing page has a shared budget too. */
export const IMAGE_PREVIEW_BYTES = 256_000;
const MAX_BLOCKS = 128;
const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
const unavailable = "Image preview is unavailable.";
const tooLarge = "Image is too large to preview.";
const record = (value: unknown): Record<string, unknown> | undefined =>
	value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
const bytes = (value: unknown): number => Buffer.byteLength(JSON.stringify(value), "utf8") + 1;
const messageId = (index: number, timestamp: unknown): string =>
	`${index}:${typeof timestamp === "number" && Number.isFinite(timestamp) ? timestamp : ""}`;

function visible(value: unknown): boolean {
	const message = record(value);
	if (!message) return false;
	if (message.role === "bashExecution" || message.role === "pythonExecution")
		return (
			typeof (message.role === "bashExecution" ? message.command : message.code) === "string" &&
			typeof message.output === "string"
		);
	if (message.role !== "user" && message.role !== "assistant" && message.role !== "toolResult") return false;
	if (message.role !== "assistant") return true;
	if (message.stopReason === "error" && typeof message.errorMessage === "string" && message.errorMessage.trim())
		return true;
	if (typeof message.content === "string") return !!message.content.trim();
	return (
		Array.isArray(message.content) &&
		message.content.some(part => {
			const block = record(part);
			return (
				(block?.type === "text" && typeof block.text === "string" && !!block.text.trim()) ||
				(block?.type === "thinking" && typeof block.thinking === "string" && !!block.thinking.trim()) ||
				block?.type === "image"
			);
		})
	);
}

export function countVisibleMessages(messages: readonly unknown[]): number {
	let count = 0;
	for (const message of messages) if (visible(message)) count++;
	return count;
}

function project(
	value: unknown,
	index: number,
	limit: number,
	redact: (text: string) => string,
	images: { remaining: number },
): DesktopMessage | undefined {
	if (!visible(value)) return undefined;
	const message = record(value)!;
	if (message.role === "bashExecution" || message.role === "pythonExecution") {
		const source = (message.role === "bashExecution" ? message.command : message.code) as string;
		const output = message.output as string;
		// Slice before concatenation/redaction to avoid copying unbounded output.
		const text = redact(`${source.slice(-limit)}\n${output.slice(-limit)}`.slice(-limit));
		return {
			id: messageId(index, message.timestamp),
			role: "tool",
			toolName: message.role === "bashExecution" ? "Direct shell" : "Direct Python",
			text,
			excludeFromContext: message.excludeFromContext === true,
			...(source.length + output.length + 1 > limit || message.truncated === true ? { truncated: true } : {}),
			...(message.cancelled === true
				? { cancelled: true }
				: typeof message.exitCode === "number" && message.exitCode !== 0
					? { isError: true }
					: {}),
		};
	}
	const role = message.role === "toolResult" ? "tool" : (message.role as "user" | "assistant");
	const entryId = role === "user" ? getSessionMessageEntryId(value as AgentMessage) : undefined;
	const blocks: DesktopMessageBlock[] = [];
	const remaining = { text: limit, thinking: limit };
	let truncated = false;
	let rich = false;
	const parts =
		typeof message.content === "string"
			? [{ type: "text", text: message.content }]
			: Array.isArray(message.content)
				? message.content
				: [];
	for (let index = parts.length - 1; index >= 0; index--) {
		const block = record(parts[index]);
		if (!block) continue;
		if (block.type === "text" || block.type === "thinking") {
			const content = block.type === "text" ? block.text : block.thinking;
			if (typeof content !== "string" || !content) continue;
			const available = remaining[block.type];
			if (blocks.length >= MAX_BLOCKS || available <= 0) {
				truncated = true;
				continue;
			}
			const text = redact(content.slice(-available));
			if (content.length > available) truncated = true;
			remaining[block.type] -= Math.min(available, content.length);
			blocks.push({ type: block.type, text });
			if (block.type === "thinking") rich = true;
		} else if (block.type === "image") {
			rich = true;
			if (blocks.length >= MAX_BLOCKS) {
				truncated = true;
				continue;
			}
			const data = block.data;
			const mimeType = block.mimeType;
			if (typeof data === "string" && (data.length > IMAGE_PREVIEW_BYTES || data.length > images.remaining))
				blocks.push({ type: "image-unavailable", reason: tooLarge });
			else if (
				typeof data !== "string" ||
				!data ||
				data.length % 4 !== 0 ||
				!/^[A-Za-z0-9+/]+={0,2}$/.test(data) ||
				typeof mimeType !== "string" ||
				!IMAGE_TYPES.has(mimeType)
			)
				blocks.push({ type: "image-unavailable", reason: unavailable });
			else if (redact(data) !== data) {
				blocks.push({ type: "image-unavailable", reason: "Image preview is unavailable for security reasons." });
			} else {
				images.remaining -= data.length;
				blocks.push({
					type: "image",
					mimeType: mimeType as "image/png" | "image/jpeg" | "image/gif" | "image/webp",
					data,
				});
			}
		}
	}
	blocks.reverse();
	let text = blocks
		.filter(block => block.type === "text")
		.map(block => block.text)
		.join("\n");
	const failed = message.stopReason === "error";
	if (!text.trim() && failed && typeof message.errorMessage === "string") {
		text = redact(message.errorMessage.slice(-limit));
		if (message.errorMessage.length > limit) truncated = true;
		if (rich && text) blocks.push({ type: "text", text });
	}
	return {
		id: messageId(index, message.timestamp),
		...(entryId ? { entryId } : {}),
		role,
		text,
		...(rich ? { blocks } : {}),
		...(truncated ? { truncated: true } : {}),
		...(typeof message.toolName === "string" ? { toolName: redact(message.toolName.slice(0, 100)) } : {}),
		...(message.isError === true || failed ? { isError: true } : {}),
	};
}

/** Fit the newest visible tail without separating rich text from its plain-text summary. */
function fitMessage(message: DesktopMessage, budget: number): DesktopMessage | undefined {
	const base = { ...message, text: "", truncated: true };
	if (!message.blocks) {
		if (bytes(base) > budget) return undefined;
		const characters = Array.from(message.text);
		let low = 0;
		let high = characters.length;
		while (low < high) {
			const middle = Math.ceil((low + high) / 2);
			if (bytes({ ...base, text: characters.slice(-middle).join("") }) <= budget) low = middle;
			else high = middle - 1;
		}
		return low ? { ...base, text: characters.slice(-low).join("") } : undefined;
	}
	const retained: DesktopMessageBlock[] = [];
	const candidate = (blocks: DesktopMessageBlock[]): DesktopMessage => ({
		...base,
		blocks,
		text: blocks
			.filter(block => block.type === "text")
			.map(block => block.text)
			.join("\n"),
	});
	if (bytes(candidate([])) > budget) return undefined;
	for (let index = message.blocks.length - 1; index >= 0; index--) {
		let block = message.blocks[index]!;
		if (block.type === "image") block = { type: "image-unavailable", reason: tooLarge };
		if (bytes(candidate([block, ...retained])) <= budget) {
			retained.unshift(block);
			continue;
		}
		if (block.type === "image-unavailable") continue;
		if (block.type === "text" || block.type === "thinking") {
			const characters = Array.from(block.text);
			let low = 0;
			let high = characters.length;
			while (low < high) {
				const middle = Math.ceil((low + high) / 2);
				const partial = { ...block, text: characters.slice(-middle).join("") };
				if (bytes(candidate([partial, ...retained])) <= budget) low = middle;
				else high = middle - 1;
			}
			if (low) retained.unshift({ ...block, text: characters.slice(-low).join("") });
		}
		break;
	}
	return retained.length ? candidate(retained) : undefined;
}

export function fitMessages(
	messages: DesktopMessage[],
	budget: number,
): { messages: DesktopMessage[]; truncated: boolean } {
	const result: DesktopMessage[] = [];
	// bytes() includes one comma per item; a nonempty array needs one additional bracket byte.
	let remaining = Math.max(0, budget - 1);
	let truncated = false;
	for (let i = messages.length - 1; i >= 0; i--) {
		let message = messages[i]!;
		let size = bytes(message);
		if (size > remaining && message.blocks?.some(block => block.type === "image")) {
			message = {
				...message,
				truncated: true,
				blocks: message.blocks.map(block =>
					block.type === "image" ? { type: "image-unavailable" as const, reason: tooLarge } : block,
				),
			};
			truncated = true;
			size = bytes(message);
		}
		if (size > remaining) {
			const fitted = fitMessage(message, remaining);
			if (fitted) result.push(fitted);
			return { messages: result.reverse(), truncated: true };
		}
		remaining -= size;
		result.push(message);
	}
	return { messages: result.reverse(), truncated };
}

export function projectMessages(
	messages: readonly unknown[],
	redact: (text: string) => string = text => text,
	imageBudget = 500_000,
): DesktopMessage[] {
	const result: DesktopMessage[] = [];
	const images = { remaining: imageBudget };
	for (let i = messages.length - 1; i >= 0 && result.length < HISTORY_LIMIT; i--) {
		const message = project(messages[i], i, TEXT_LIMIT, redact, images);
		if (message) result.push(message);
	}
	return result.reverse();
}

export function projectHistoryPage(
	messages: readonly unknown[],
	offset: number,
	limit: number,
	redact: (text: string) => string = text => text,
): { total: number; page: DesktopMessage[]; truncated: boolean } {
	let total = 0;
	const page: DesktopMessage[] = [];
	let budget = HISTORY_PAGE_BYTES - 1;
	const images = { remaining: HISTORY_PAGE_BYTES };
	let full = false;
	for (let index = 0; index < messages.length; index++) {
		if (!visible(messages[index])) continue;
		if (total++ < offset || full || page.length >= limit) continue;
		let message = project(messages[index], index, 32_000, redact, images)!;
		let size = bytes(message);
		if (size > budget && message.blocks?.some(block => block.type === "image")) {
			message = {
				...message,
				blocks: message.blocks.map(block =>
					block.type === "image" ? { type: "image-unavailable" as const, reason: tooLarge } : block,
				),
			};
			size = bytes(message);
		}
		if (size > budget) {
			full = true;
			continue;
		}
		budget -= size;
		page.push(message);
	}
	return { total, page, truncated: offset + page.length < total };
}
