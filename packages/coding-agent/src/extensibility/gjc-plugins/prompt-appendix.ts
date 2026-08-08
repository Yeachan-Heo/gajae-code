import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { resolveWithinRoot } from "./paths";
import type { GjcPluginRegistryEntry, GjcSubskillParentAgent, NormalizedAppendixSurface } from "./types";
import { GjcPluginLoadError } from "./types";

/**
 * Renders plugin system/agent appendices as lower-authority, delimited blocks
 * appended AFTER the base prompt. The base/developer instructions always retain
 * higher authority; plugin appendices can never override them.
 */

const MAX_APPENDIX_BYTES = 8 * 1024;
const MAX_TOTAL_APPENDIX_BYTES = 32 * 1024;
const MAX_APPENDIX_COUNT = 32;
const MAX_NAME_LEN = 128;

function escapeAttr(value: string): string {
	const clamped = value.length > MAX_NAME_LEN ? `${value.slice(0, MAX_NAME_LEN - 1)}\u2026` : value;
	return clamped.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function sanitizePromptBody(text: string): string {
	// Strip control chars (except tab/newline), then XML-escape &, <, > so a
	// malicious body can NEVER emit a closing delimiter or fake <system>/
	// <developer>/<gjc-subskill> tag that escapes the lower-authority block.
	// The set spans C0, DEL, and C1. Carriage return can rewrite a rendered line,
	// and U+009B is a single-byte CSI that introduces an escape sequence without
	// any preceding ESC, so omitting either leaves the same injection open.
	const stripped = text.replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, "");
	return stripped.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function assertAppendixDigest(bytes: Buffer, surface: NormalizedAppendixSurface, label: string): void {
	const actual = createHash("sha256").update(bytes).digest("hex");
	if (actual.toLowerCase() !== surface.contentHash.toLowerCase()) {
		throw new GjcPluginLoadError("runtime_mismatch", `Appendix hash drift at ${label}`);
	}
}

async function readAppendixBody(
	entry: GjcPluginRegistryEntry,
	surface: NormalizedAppendixSurface,
	options?: RenderPluginAppendixOptions,
): Promise<string> {
	// Inline and file-backed appendices carry the same persisted `contentHash`
	// contract, so both verify their declared digest before the body can reach
	// the prompt; otherwise contentHash would be unaudited metadata for inline
	// surfaces.
	if (surface.content !== undefined) {
		const inlineBytes = Buffer.from(surface.content, "utf8");
		assertAppendixDigest(inlineBytes, surface, "inline appendix");
		return surface.content;
	}
	if (!surface.relativePath) return "";
	await options?.beforeRead?.(entry, surface);
	const lexical = resolveWithinRoot(entry.pluginRoot, surface.relativePath);
	let rootReal: string;
	let fileReal: string;
	try {
		[rootReal, fileReal] = await Promise.all([fs.realpath(entry.pluginRoot), fs.realpath(lexical)]);
	} catch (error) {
		throw new GjcPluginLoadError("runtime_mismatch", `Missing or unreadable appendix at ${surface.relativePath}`, {
			cause: error instanceof Error ? error : undefined,
		});
	}
	const relative = path.relative(rootReal, fileReal);
	if (relative.startsWith("..") || path.isAbsolute(relative)) {
		throw new GjcPluginLoadError(
			"runtime_mismatch",
			`Appendix escapes the installed plugin root: ${surface.relativePath}`,
		);
	}
	let bytes: Buffer;
	try {
		bytes = await fs.readFile(fileReal);
	} catch (error) {
		throw new GjcPluginLoadError("runtime_mismatch", `Missing or unreadable appendix at ${surface.relativePath}`, {
			cause: error instanceof Error ? error : undefined,
		});
	}
	assertAppendixDigest(bytes, surface, surface.relativePath);
	return bytes.toString("utf8");
}

export interface RenderPluginAppendixOptions {
	/** Test/coordination seam invoked immediately before each file-backed appendix read. */
	beforeRead?: (entry: GjcPluginRegistryEntry, surface: NormalizedAppendixSurface) => Promise<void>;
}

export interface RenderedPluginAppendices {
	/** Combined system-appendix block text (empty if none). */
	system: string;
	/** Per-agent appendix block text. */
	byAgent: Map<GjcSubskillParentAgent, string>;
	/** Stable digest of all rendered appendix content + identities (for cache/refresh). */
	digest: string;
}

/**
 * Build appendix blocks from the active, enabled registry entries in their
 * deterministic order. Per-appendix and total size caps are enforced
 * fail-closed (oversize content is dropped with a marker, never silently
 * truncated into the prompt as authoritative text).
 */
export async function renderPluginAppendices(
	entries: readonly GjcPluginRegistryEntry[],
	options?: RenderPluginAppendixOptions,
): Promise<RenderedPluginAppendices> {
	const systemBlocks: string[] = [];
	const byAgent = new Map<GjcSubskillParentAgent, string[]>();
	const digestParts: string[] = [];
	let totalBytes = 0;
	let count = 0;

	// Admission is measured on the FULL rendered block (wrapper + escaped
	// metadata + body), not just the body, and capped by per-block size, total
	// size, and appendix count.
	const admit = (block: string): boolean => {
		const bytes = Buffer.byteLength(block);
		if (bytes > MAX_APPENDIX_BYTES) return false;
		if (count >= MAX_APPENDIX_COUNT) return false;
		if (totalBytes + bytes > MAX_TOTAL_APPENDIX_BYTES) return false;
		totalBytes += bytes;
		count += 1;
		return true;
	};

	for (const entry of entries) {
		if (!entry.enabled) continue;
		const disabled = new Set(entry.disabledSurfaceIds);
		for (const sa of entry.surfaces.systemAppendices) {
			if (disabled.has(sa.extensionId)) continue;
			const body = sanitizePromptBody(await readAppendixBody(entry, sa, options));
			digestParts.push(`${sa.extensionId}:${sa.contentHash}`);
			if (!body) continue;
			const block = `<gjc-plugin-system-appendix plugin="${escapeAttr(entry.name)}" name="${escapeAttr(sa.name)}" sha256="${sa.contentHash}" authority="appendix-lower-than-system">\n${body}\n</gjc-plugin-system-appendix>`;
			if (!admit(block)) continue;
			systemBlocks.push(block);
		}
		for (const aa of entry.surfaces.agentAppendices) {
			if (disabled.has(aa.extensionId)) continue;
			const body = sanitizePromptBody(await readAppendixBody(entry, aa, options));
			digestParts.push(`${aa.extensionId}:${aa.contentHash}`);
			if (!body) continue;
			const block = `<gjc-plugin-agent-appendix plugin="${escapeAttr(entry.name)}" agent="${escapeAttr(aa.agent)}" name="${escapeAttr(aa.name)}" sha256="${aa.contentHash}" authority="appendix-lower-than-agent">\n${body}\n</gjc-plugin-agent-appendix>`;
			if (!admit(block)) continue;
			const list = byAgent.get(aa.agent) ?? [];
			list.push(block);
			byAgent.set(aa.agent, list);
		}
	}

	const digest = createHash("sha256").update(digestParts.join("\u0000")).digest("hex");
	return {
		system: systemBlocks.join("\n\n"),
		byAgent: new Map([...byAgent].map(([agent, blocks]) => [agent, blocks.join("\n\n")])),
		digest,
	};
}
