import type { MermaidRenderOptions } from "@gajae-code/natives";

export type { MermaidRenderOptions };

type NativeMermaidBindings = Pick<typeof import("@gajae-code/natives"), "renderMermaidAscii">;

let nativeMermaidBindings: NativeMermaidBindings | undefined;

function getNativeMermaidBindings(): NativeMermaidBindings {
	if (!nativeMermaidBindings) {
		nativeMermaidBindings = require("@gajae-code/natives") as NativeMermaidBindings;
	}
	return nativeMermaidBindings;
}

export function renderMermaidAscii(source: string, options?: MermaidRenderOptions): string {
	return getNativeMermaidBindings().renderMermaidAscii(source, {
		...options,
		colorMode: options?.colorMode ?? "none",
	});
}

export function renderMermaidAsciiSafe(source: string, options?: MermaidRenderOptions): string | null {
	try {
		return renderMermaidAscii(source, options);
	} catch {
		return null;
	}
}

/**
 * Extract mermaid code blocks from markdown text.
 */
export function extractMermaidBlocks(markdown: string): { source: string; hash: bigint | number }[] {
	const blocks: { source: string; hash: bigint | number }[] = [];
	const regex = /```mermaid\s*\n([\s\S]*?)```/g;

	for (let match = regex.exec(markdown); match !== null; match = regex.exec(markdown)) {
		const source = match[1].trim();
		const hash = Bun.hash(source);
		blocks.push({ source, hash });
	}

	return blocks;
}
