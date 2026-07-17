import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { isEnoent } from "@gajae-code/utils";
import { AgentRegistry } from "../registry/agent-registry";
import { parseInternalUrl } from "./parse";
import { validateRelativePath } from "./skill-protocol";
import type { InternalResource, InternalUrl, ProtocolHandler } from "./types";

export interface LocalProtocolOptions {
	getArtifactsDir?: () => string | null;
	getSessionId?: () => string | null;
}

function parseLocalUrl(input: string): InternalUrl {
	return parseInternalUrl(input);
}

function ensureWithinRoot(targetPath: string, rootPath: string): void {
	if (targetPath !== rootPath && !targetPath.startsWith(`${rootPath}${path.sep}`)) {
		throw new Error("local:// URL escapes local root");
	}
}

function toLocalValidationError(error: unknown): Error {
	const message = error instanceof Error ? error.message : String(error);
	return new Error(message.replace("skill://", "local://"));
}

function getContentType(filePath: string): InternalResource["contentType"] {
	const ext = path.extname(filePath).toLowerCase();
	if (ext === ".md") return "text/markdown";
	if (ext === ".json") return "application/json";
	return "text/plain";
}

async function listFilesRecursively(rootPath: string): Promise<string[]> {
	const pending = [""];
	const files: string[] = [];

	while (pending.length > 0) {
		const relativeDir = pending.pop();
		if (relativeDir === undefined) continue;
		const absoluteDir = path.join(rootPath, relativeDir);
		const entries = await fs.readdir(absoluteDir, { withFileTypes: true });

		for (const entry of entries) {
			const entryPath = path.join(relativeDir, entry.name);
			if (entry.isDirectory()) {
				pending.push(entryPath);
				continue;
			}
			if (entry.isFile()) {
				files.push(entryPath.replaceAll(path.sep, "/"));
			}
		}
	}

	return files.sort((a, b) => a.localeCompare(b));
}

async function buildListing(url: InternalUrl, localRoot: string): Promise<InternalResource> {
	const files = await listFilesRecursively(localRoot);
	const listing = files.length === 0 ? "(empty)" : files.map(file => `- [${file}](local://${file})`).join("\n");
	const content =
		`# Local\n\n` +
		`Session-scoped scratch space for large intermediate data, subagent handoffs, and reusable planning artifacts.\n\n` +
		`Root: ${localRoot}\n\n` +
		`${files.length} file${files.length === 1 ? "" : "s"} available:\n\n` +
		`${listing}\n`;

	return {
		url: url.href,
		content,
		contentType: "text/markdown",
		size: Buffer.byteLength(content, "utf-8"),
		sourcePath: localRoot,
	};
}

function extractRelativePath(url: InternalUrl): string {
	const host = url.rawHost || url.hostname;
	const pathname = url.rawPathname ?? url.pathname;

	const combined = host
		? pathname && pathname !== "/"
			? `${host}${pathname}`
			: host
		: pathname && pathname !== "/"
			? pathname.slice(1)
			: "";

	if (!combined) {
		return "";
	}

	let decoded: string;
	try {
		decoded = decodeURIComponent(combined.replaceAll("\\", "/"));
	} catch {
		throw new Error(`Invalid URL encoding in local:// path: ${url.href}`);
	}
	try {
		validateRelativePath(decoded);
	} catch (error) {
		throw toLocalValidationError(error);
	}
	return decoded;
}

export function resolveLocalRoot(options: LocalProtocolOptions): string {
	const artifactsDir = options.getArtifactsDir?.();
	if (artifactsDir) {
		return path.resolve(artifactsDir, "local");
	}

	const sessionId = options.getSessionId?.() ?? "session";
	const safeSessionId = sessionId.replace(/[^a-zA-Z0-9_.-]/g, "_");
	return path.join(os.tmpdir(), "gjc-local", safeSessionId);
}

export function resolveLocalUrlToPath(input: string | InternalUrl, options: LocalProtocolOptions): string {
	const url = typeof input === "string" ? parseLocalUrl(input) : input;
	const localRoot = path.resolve(resolveLocalRoot(options));
	const relativePath = extractRelativePath(url);

	if (!relativePath) {
		return localRoot;
	}

	const resolved = path.resolve(localRoot, relativePath);
	ensureWithinRoot(resolved, localRoot);
	return resolved;
}

/**
 * Protocol handler for local:// URLs.
 *
 * URL forms:
 * - local:// - Lists files at the session local root
 * - local://<path> - Reads a file under the session local root
 */
export class LocalProtocolHandler implements ProtocolHandler {
	readonly scheme = "local";
	readonly immutable = false;

	static #override: LocalProtocolOptions | undefined;
	static #ownedOverrides: Array<{ options: LocalProtocolOptions }> = [];

	/**
	 * Install an explicit local-protocol mapping owned by the caller.
	 *
	 * The most recently installed live mapping wins. The returned disposer removes
	 * only this registration and is safe to call more than once.
	 */
	static installOverride(value: LocalProtocolOptions): () => void {
		const registration = { options: value };
		LocalProtocolHandler.#ownedOverrides.push(registration);
		let disposed = false;
		return () => {
			if (disposed) return;
			disposed = true;
			const index = LocalProtocolHandler.#ownedOverrides.indexOf(registration);
			if (index !== -1) LocalProtocolHandler.#ownedOverrides.splice(index, 1);
		};
	}

	/**
	 * Install a process-global test override that wins over owned and registry
	 * mappings. Prefer {@link installOverride} for lifecycle-bound production use.
	 */
	static setOverride(value: LocalProtocolOptions | undefined): void {
		LocalProtocolHandler.#override = value;
	}

	/** Reset all process-global local-protocol overrides. Test-only. */
	static resetOverrideForTests(): void {
		LocalProtocolHandler.#override = undefined;
		LocalProtocolHandler.#ownedOverrides = [];
	}

	/**
	 * Returns the active local-protocol options.
	 *
	 * Resolution order:
	 * 1. Direct test override installed via {@link setOverride}.
	 * 2. The most recently installed live owned override.
	 * 3. A live main session in `AgentRegistry.global()`.
	 */
	static resolveOptions(): LocalProtocolOptions | undefined {
		const override = LocalProtocolHandler.#override;
		if (override) return override;
		const ownedOverride = LocalProtocolHandler.#ownedOverrides.at(-1)?.options;
		if (ownedOverride) return ownedOverride;
		const main = AgentRegistry.global()
			.list()
			.find(ref => ref.kind === "main" && ref.session && (ref.status === "running" || ref.status === "idle"));
		const sessionManager = main?.session?.sessionManager;
		if (!sessionManager) return undefined;
		return {
			getArtifactsDir: () => sessionManager.getArtifactsDir(),
			getSessionId: () => sessionManager.getSessionId(),
		};
	}

	async resolve(url: InternalUrl): Promise<InternalResource> {
		const opts = LocalProtocolHandler.resolveOptions();
		if (!opts) {
			throw new Error("No session - local:// unavailable");
		}

		const localRoot = path.resolve(resolveLocalRoot(opts));
		await fs.mkdir(localRoot, { recursive: true });

		let resolvedRoot: string;
		try {
			resolvedRoot = await fs.realpath(localRoot);
		} catch (error) {
			if (isEnoent(error)) {
				throw new Error("Unable to initialize local:// root");
			}
			throw error;
		}

		const relativePath = extractRelativePath(url);
		const targetPath = relativePath ? path.resolve(resolvedRoot, relativePath) : resolvedRoot;
		ensureWithinRoot(targetPath, resolvedRoot);

		if (targetPath === resolvedRoot) {
			return buildListing(url, resolvedRoot);
		}

		const parentDir = path.dirname(targetPath);
		try {
			const realParent = await fs.realpath(parentDir);
			ensureWithinRoot(realParent, resolvedRoot);
		} catch (error) {
			if (!isEnoent(error)) throw error;
		}

		let realTargetPath: string;
		try {
			realTargetPath = await fs.realpath(targetPath);
		} catch (error) {
			if (isEnoent(error)) {
				throw new Error(`Local file not found: ${url.href}`);
			}
			throw error;
		}

		ensureWithinRoot(realTargetPath, resolvedRoot);

		const stat = await fs.stat(realTargetPath);
		if (!stat.isFile()) {
			throw new Error(`local:// URL must resolve to a file: ${url.href}`);
		}

		const content = await Bun.file(realTargetPath).text();
		return {
			url: url.href,
			content,
			contentType: getContentType(realTargetPath),
			size: Buffer.byteLength(content, "utf-8"),
			sourcePath: realTargetPath,
			notes: ["Use write path local://<file> to persist large intermediate artifacts across turns."],
		};
	}
}
