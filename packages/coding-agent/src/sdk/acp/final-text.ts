export const ACP_FINAL_TEXT_LIMIT = 100_000;

export interface BoundedAcpFinalText {
	text: string;
	truncated: boolean;
}

export type AcpFinalTextResolution =
	| { kind: "none"; final: BoundedAcpFinalText }
	| { kind: "emit"; final: BoundedAcpFinalText; text: string }
	| { kind: "divergent"; final: BoundedAcpFinalText };

export function boundAcpFinalText(value: string): BoundedAcpFinalText {
	if (value.length <= ACP_FINAL_TEXT_LIMIT) return { text: value, truncated: false };
	let text = value.slice(0, ACP_FINAL_TEXT_LIMIT);
	const finalCodeUnit = text.charCodeAt(text.length - 1);
	if (finalCodeUnit >= 0xd800 && finalCodeUnit <= 0xdbff) text = text.slice(0, -1);
	return { text, truncated: true };
}

export function acpFinalTextFromMessage(message: unknown): BoundedAcpFinalText {
	const content = (message as { content?: unknown } | null | undefined)?.content;
	if (typeof content === "string") return boundAcpFinalText(content);
	if (!Array.isArray(content)) return { text: "", truncated: false };
	const parts: string[] = [];
	for (const block of content) {
		if (!block || typeof block !== "object" || (block as { type?: unknown }).type !== "text") continue;
		const text = (block as { text?: unknown }).text;
		if (typeof text === "string") parts.push(text);
	}
	return boundAcpFinalText(parts.join(""));
}

export function resolveAcpFinalText(streamed: string, finalText: string): AcpFinalTextResolution {
	const final = boundAcpFinalText(finalText);
	if (!final.text || streamed === final.text || streamed.includes(final.text)) return { kind: "none", final };
	if (!streamed) return { kind: "emit", final, text: final.text };
	if (final.text.startsWith(streamed)) return { kind: "emit", final, text: final.text.slice(streamed.length) };
	return { kind: "divergent", final };
}
