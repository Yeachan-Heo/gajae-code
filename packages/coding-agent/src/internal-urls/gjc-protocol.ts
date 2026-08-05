/**
 * Protocol handler for gjc:// URLs.
 *
 * Serves statically embedded documentation files bundled at build time.
 *
 * URL forms:
 * - gjc:// - Lists all available documentation files
 * - gjc://<file>.md - Reads a specific documentation file
 */
import * as path from "node:path";
import type { InternalResource, InternalUrl, ProtocolHandler } from "./types";

type DocsManifestEntry = {
	path: string;
	offset: number;
	length: number;
	sha256: string;
};

type DocsIndex = {
	EMBEDDED_DOC_FILENAMES: readonly string[];
	EMBEDDED_DOCS_MANIFEST: readonly DocsManifestEntry[];
	EMBEDDED_DOCS_PAYLOAD_PATH: string;
};

let docsIndexPromise: Promise<DocsIndex> | undefined;

function loadDocsIndex(): Promise<DocsIndex> {
	if (!docsIndexPromise) docsIndexPromise = import("./docs-index.generated");
	return docsIndexPromise;
}

function sha256(content: Uint8Array): string {
	return new Bun.CryptoHasher("sha256").update(content).digest("hex");
}

/**
 * Handler for gjc:// URLs.
 *
 * Resolves documentation file names to their content, or lists available docs.
 */
export class GjcProtocolHandler implements ProtocolHandler {
	readonly scheme = "gjc";
	readonly immutable = true;

	async resolve(url: InternalUrl): Promise<InternalResource> {
		// Extract filename from host + path
		const host = url.rawHost || url.hostname;
		const pathname = url.rawPathname ?? url.pathname;
		const filename = host ? (pathname && pathname !== "/" ? host + pathname : host) : "";

		if (!filename) {
			return this.#listDocs(url);
		}

		return this.#readDoc(filename, url);
	}

	async #listDocs(url: InternalUrl): Promise<InternalResource> {
		const { EMBEDDED_DOC_FILENAMES } = await loadDocsIndex();
		if (EMBEDDED_DOC_FILENAMES.length === 0) {
			throw new Error("No documentation files found");
		}

		const listing = EMBEDDED_DOC_FILENAMES.map(f => `- [${f}](gjc://${f})`).join("\n");
		const content = `# Documentation\n\n${EMBEDDED_DOC_FILENAMES.length} files available:\n\n${listing}\n`;

		return {
			url: url.href,
			content,
			contentType: "text/markdown",
			size: Buffer.byteLength(content, "utf-8"),
		};
	}

	async #readDoc(filename: string, url: InternalUrl): Promise<InternalResource> {
		// Validate: no traversal, no absolute paths
		if (path.isAbsolute(filename)) {
			throw new Error("Absolute paths are not allowed in gjc:// URLs");
		}

		const normalized = path.posix.normalize(filename.replaceAll("\\", "/"));
		if (normalized === ".." || normalized.startsWith("../") || normalized.includes("/../")) {
			throw new Error("Path traversal (..) is not allowed in gjc:// URLs");
		}

		const { EMBEDDED_DOC_FILENAMES, EMBEDDED_DOCS_MANIFEST, EMBEDDED_DOCS_PAYLOAD_PATH } = await loadDocsIndex();
		const entry = EMBEDDED_DOCS_MANIFEST.find(candidate => candidate.path === normalized);
		if (entry === undefined) {
			const lookup = normalized.replace(/\.md$/, "");
			const suggestions = EMBEDDED_DOC_FILENAMES.filter(
				f => f.includes(lookup) || lookup.includes(f.replace(/\.md$/, "")),
			).slice(0, 5);
			const suffix =
				suggestions.length > 0
					? `\nDid you mean: ${suggestions.join(", ")}`
					: "\nUse gjc:// to list available files.";
			throw new Error(`Documentation file not found: ${filename}${suffix}`);
		}

		const payload = Bun.file(EMBEDDED_DOCS_PAYLOAD_PATH);
		const end = entry.offset + entry.length;
		// Manifest bounds tie the generated index to the one packaged payload before any range read.
		if (
			!Number.isSafeInteger(entry.offset) ||
			!Number.isSafeInteger(entry.length) ||
			entry.offset < 0 ||
			entry.length < 0 ||
			!Number.isSafeInteger(end) ||
			end > payload.size
		) {
			throw new Error(`Embedded documentation payload bounds are invalid: ${normalized}`);
		}
		const bytes = await payload.slice(entry.offset, end).bytes();
		if (bytes.byteLength !== entry.length || sha256(bytes) !== entry.sha256) {
			throw new Error(`Embedded documentation payload integrity check failed: ${normalized}`);
		}
		const content = new TextDecoder("utf-8", { fatal: true }).decode(bytes);

		return {
			url: url.href,
			content,
			contentType: "text/markdown",
			size: bytes.byteLength,
		};
	}
}
