import * as fs from "node:fs";
import * as path from "node:path";

import { getNativeDiffBindings } from "../../../internal/native-diff";

import { ToolError } from "../../../tools/tool-errors";
import type { JsStatusEvent } from "./types";

export interface HelperOptions {
	path?: string;
	hidden?: boolean;
	maxDepth?: number;
	limit?: number;
	offset?: number;
	reverse?: boolean;
	unique?: boolean;
	count?: boolean;
}

/**
 * Inputs the helper factory needs from its host runtime. `cwd` is a getter so the runtime
 * can update it between cells (e.g. when the agent's session cwd changes) without
 * recreating helpers.
 */
export interface HelperContext {
	cwd(): string;
	env: Map<string, string>;
	emitStatus(event: JsStatusEvent): void;
}

/**
 * The set of functions exposed to user code via `globalThis.__gjc_helpers__`. The JS
 * prelude reads from this bag and attaches short aliases (`read`, `write`, `tree`, ...)
 * onto the global scope.
 */
export interface HelperBundle {
	read(rawPath: string, options?: HelperOptions): Promise<string>;
	writeFile(rawPath: string, data: unknown): Promise<string>;
	append(rawPath: string, content: string): Promise<string>;
	sortText(text: string, options?: HelperOptions): string;
	uniqText(text: string, options?: HelperOptions): string | Array<[number, string]>;
	counter(items: string | string[], options?: HelperOptions): Array<[number, string]>;
	diff(rawA: string, rawB: string): Promise<string>;
	tree(searchPath?: string, options?: HelperOptions): Promise<string>;
	env(key?: string, value?: string): string | Record<string, string> | undefined;
}

const utf8Encoder = new TextEncoder();

export function createHelpers(ctx: HelperContext): HelperBundle {
	return {
		read: async (rawPath, options = {}) => {
			const { filePath, file, size } = await resolveRegularFile(ctx, rawPath);
			let text = await file.text();
			const offset = typeof options.offset === "number" ? options.offset : 1;
			const limit = typeof options.limit === "number" ? options.limit : undefined;
			if (offset > 1 || limit !== undefined) {
				const lines = text.split(/\r?\n/);
				const start = Math.max(0, offset - 1);
				const end = limit !== undefined ? start + limit : lines.length;
				text = lines.slice(start, end).join("\n");
			}
			ctx.emitStatus({ op: "read", path: filePath, bytes: size, chars: text.length });
			return text;
		},
		writeFile: async (rawPath, data) => {
			if (!isWriteData(data)) {
				throw new ToolError("write() expects string, Blob, ArrayBuffer, or TypedArray data");
			}
			const filePath = resolvePath(ctx, rawPath);
			if (typeof data === "string" || data instanceof Blob || data instanceof ArrayBuffer) {
				await Bun.write(filePath, data);
			} else {
				await Bun.write(filePath, new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
			}
			ctx.emitStatus({ op: "write", path: filePath, bytes: getDataSize(data) });
			return filePath;
		},
		append: async (rawPath, content) => {
			const target = resolvePath(ctx, rawPath);
			await Bun.write(
				target,
				`${await Bun.file(target)
					.text()
					.catch(() => "")}${content}`,
			);
			ctx.emitStatus({
				op: "append",
				path: target,
				chars: content.length,
				bytes: utf8Encoder.encode(content).byteLength,
			});
			return target;
		},
		sortText: (text, options = {}) => {
			const lines = String(text).split(/\r?\n/);
			const deduped = options.unique ? Array.from(new Set(lines)) : lines;
			const sorted = deduped.sort((a, b) => a.localeCompare(b));
			if (options.reverse) sorted.reverse();
			const result = sorted.join("\n");
			ctx.emitStatus({
				op: "sort",
				lines: sorted.length,
				reverse: options.reverse === true,
				unique: options.unique === true,
			});
			return result;
		},
		uniqText: (text, options = {}) => {
			const lines = String(text)
				.split(/\r?\n/)
				.filter(line => line.length > 0);
			const groups: Array<[number, string]> = [];
			for (const line of lines) {
				const last = groups.at(-1);
				if (last && last[1] === line) {
					last[0] += 1;
					continue;
				}
				groups.push([1, line]);
			}
			ctx.emitStatus({ op: "uniq", groups: groups.length, count_mode: options.count === true });
			if (options.count) return groups;
			return groups.map(([, line]) => line).join("\n");
		},
		counter: (items, options = {}) => {
			const values = Array.isArray(items) ? items : String(items).split(/\r?\n/).filter(Boolean);
			const counts = new Map<string, number>();
			for (const item of values) counts.set(item, (counts.get(item) ?? 0) + 1);
			const entries = Array.from(counts.entries())
				.map(([item, count]) => [count, item] as [number, string])
				.sort((a, b) => (options.reverse === false ? a[0] - b[0] : b[0] - a[0]) || a[1].localeCompare(b[1]));
			const limited = entries.slice(0, options.limit ?? entries.length);
			ctx.emitStatus({ op: "counter", unique: counts.size, total: values.length, top: limited.slice(0, 10) });
			return limited;
		},
		diff: async (rawA, rawB) => {
			const fileA = resolvePath(ctx, rawA);
			const fileB = resolvePath(ctx, rawB);
			const [a, b] = await Promise.all([Bun.file(fileA).text(), Bun.file(fileB).text()]);
			const hunks = getNativeDiffBindings().structuredPatchHunks(a, b, 3);
			const lines = [
				...(fileA === fileB ? [`Index: ${fileA}`] : []),
				"===================================================================",
				`--- ${fileA}`,
				`+++ ${fileB}`,
				...hunks.flatMap(hunk => [
					`@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`,
					...hunk.lines,
				]),
			];
			const result = `${lines.join("\n")}\n`;
			ctx.emitStatus({
				op: "diff",
				file_a: fileA,
				file_b: fileB,
				identical: a === b,
				preview: result.slice(0, 500),
			});
			return result;
		},
		tree: async (searchPath = ".", options = {}) => {
			const root = resolvePath(ctx, searchPath);
			const maxDepth = options.maxDepth ?? 3;
			const showHidden = options.hidden ?? false;
			const lines: string[] = [`${root}/`];
			let entryCount = 0;
			const walk = async (dir: string, prefix: string, depth: number): Promise<void> => {
				if (depth > maxDepth) return;
				const entries = (await fs.promises.readdir(dir, { withFileTypes: true }))
					.filter(entry => showHidden || !entry.name.startsWith("."))
					.sort((a, b) => a.name.localeCompare(b.name));
				for (let index = 0; index < entries.length; index++) {
					const entry = entries[index];
					const isLast = index === entries.length - 1;
					const connector = isLast ? "└── " : "├── ";
					const suffix = entry.isDirectory() ? "/" : "";
					lines.push(`${prefix}${connector}${entry.name}${suffix}`);
					entryCount += 1;
					if (entry.isDirectory()) {
						await walk(path.join(dir, entry.name), `${prefix}${isLast ? "    " : "│   "}`, depth + 1);
					}
				}
			};
			await walk(root, "", 1);
			const result = lines.join("\n");
			ctx.emitStatus({ op: "tree", path: root, entries: entryCount, preview: result.slice(0, 1000) });
			return result;
		},
		env: (key, value) => {
			if (!key) {
				const merged = Object.fromEntries(Object.entries(getMergedEnv(ctx)).sort(([a], [b]) => a.localeCompare(b)));
				ctx.emitStatus({ op: "env", count: Object.keys(merged).length, keys: Object.keys(merged).slice(0, 20) });
				return merged;
			}
			if (value !== undefined) {
				ctx.env.set(key, value);
				ctx.emitStatus({ op: "env", key, value, action: "set" });
				return value;
			}
			const result = ctx.env.get(key) ?? Bun.env[key];
			ctx.emitStatus({ op: "env", key, value: result, action: "get" });
			return result;
		},
	};
}

function getMergedEnv(ctx: HelperContext): Record<string, string> {
	const merged: Record<string, string> = {};
	for (const [key, value] of Object.entries(Bun.env)) {
		if (typeof value === "string") merged[key] = value;
	}
	for (const [key, value] of ctx.env) merged[key] = value;
	return merged;
}

function resolvePath(ctx: HelperContext, value: string): string {
	if (path.isAbsolute(value)) return path.normalize(value);
	return path.resolve(ctx.cwd(), value);
}

async function resolveRegularFile(
	ctx: HelperContext,
	rawPath: string,
): Promise<{ filePath: string; file: Bun.BunFile; size: number }> {
	if (/^[a-z][a-z0-9+.-]*:\/\//i.test(rawPath)) {
		throw new ToolError(`Protocol paths are not supported by read(): ${rawPath}`);
	}
	const filePath = resolvePath(ctx, rawPath);
	const file = Bun.file(filePath);
	const stat = await file.stat();
	if (stat.isDirectory()) {
		throw new ToolError(`Directory paths are not supported by read(): ${filePath}`);
	}
	return { filePath, file, size: stat.size };
}

function getDataSize(data: string | Blob | ArrayBuffer | ArrayBufferView): number {
	if (typeof data === "string") return utf8Encoder.encode(data).byteLength;
	if (data instanceof Blob) return data.size;
	if (data instanceof ArrayBuffer) return data.byteLength;
	return data.byteLength;
}

function isWriteData(value: unknown): value is string | Blob | ArrayBuffer | ArrayBufferView {
	return (
		typeof value === "string" || value instanceof Blob || value instanceof ArrayBuffer || ArrayBuffer.isView(value)
	);
}
