/**
 * Protocol handler for agent:// URLs.
 *
 * Resolves agent output IDs only against artifacts directories explicitly
 * authorized by the caller's ResolveContext. Parents and subagents can share
 * outputs by passing their tree's artifacts dir at that API boundary.
 *
 * URL forms:
 * - agent://<id> - Full output content
 * - agent://<id>/<path> - JSON extraction via path form
 * - agent://<id>?q=<query> - JSON extraction via query form
 */
import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { isEnoent } from "@gajae-code/utils";
import { applyQuery, pathToQuery } from "./json-query";
import { authorizedArtifactsDirsFromContext } from "./registry-helpers";
import type { InternalResource, InternalUrl, ProtocolHandler, ResolveContext } from "./types";

interface AgentOutputMetadata {
	id: string;
	kind: "agent-output";
	sizeBytes: number;
	lineCount: number;
	sha256: string;
	createdAt: string;
}

interface ManagedOutputSelector {
	outputFilename: string;
	metadataFilename: string;
	outputSizeBytes: number;
	outputSha256: string;
	metadataSizeBytes: number;
	metadataSha256: string;
}

function isSafeGenerationFilename(filename: unknown): filename is string {
	return typeof filename === "string" && /^[a-zA-Z0-9_.-]+$/.test(filename);
}

function isManagedOutputSelector(value: unknown, outputId: string): value is ManagedOutputSelector {
	if (!value || typeof value !== "object") return false;
	const selector = value as Record<string, unknown>;
	return (
		isSafeGenerationFilename(selector.outputFilename) &&
		isSafeGenerationFilename(selector.metadataFilename) &&
		selector.outputFilename.startsWith(`${outputId}.md.`) &&
		selector.outputFilename.endsWith(".output") &&
		selector.metadataFilename === `${selector.outputFilename}.meta.json` &&
		typeof selector.outputSizeBytes === "number" &&
		typeof selector.outputSha256 === "string" &&
		typeof selector.metadataSizeBytes === "number" &&
		typeof selector.metadataSha256 === "string"
	);
}

async function readManagedOutputSelector(
	outputId: string,
	selectorPath: string,
): Promise<ManagedOutputSelector | null> {
	let raw: string;
	try {
		raw = await Bun.file(selectorPath).text();
	} catch (error) {
		if (isEnoent(error)) return null;
		throw error;
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		throw new Error(`agent://${outputId} malformed output selector`);
	}
	if (!isManagedOutputSelector(parsed, outputId)) throw new Error(`agent://${outputId} malformed output selector`);
	return parsed;
}

function isAgentOutputMetadata(value: unknown, outputId: string): value is AgentOutputMetadata {
	if (!value || typeof value !== "object") return false;
	const meta = value as Record<string, unknown>;
	return (
		meta.id === outputId &&
		meta.kind === "agent-output" &&
		typeof meta.sizeBytes === "number" &&
		typeof meta.lineCount === "number" &&
		typeof meta.sha256 === "string" &&
		typeof meta.createdAt === "string"
	);
}

async function verifyAgentOutputMetadata(
	outputId: string,
	foundPath: string,
	metadataPath: string,
	bytes: Buffer,
	selector?: ManagedOutputSelector,
): Promise<void> {
	let metaRaw: string;
	try {
		metaRaw = await Bun.file(metadataPath).text();
	} catch (err) {
		if (isEnoent(err)) throw new Error(`agent://${outputId} missing metadata`);
		throw err;
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(metaRaw);
	} catch {
		throw new Error(`agent://${outputId} malformed metadata`);
	}
	if (!isAgentOutputMetadata(parsed, outputId)) {
		throw new Error(`agent://${outputId} malformed metadata`);
	}
	const metadataBytes = Buffer.from(metaRaw, "utf8");
	const stat = await fs.stat(foundPath);
	if (stat.size !== parsed.sizeBytes || bytes.byteLength !== parsed.sizeBytes) {
		throw new Error(`agent://${outputId} size mismatch`);
	}
	const sha256 = createHash("sha256").update(bytes).digest("hex");
	if (sha256 !== parsed.sha256) {
		throw new Error(`agent://${outputId} hash mismatch`);
	}
	if (
		selector &&
		(selector.outputSizeBytes !== bytes.byteLength ||
			selector.outputSha256 !== sha256 ||
			selector.metadataSizeBytes !== metadataBytes.byteLength ||
			selector.metadataSha256 !== createHash("sha256").update(metadataBytes).digest("hex"))
	) {
		throw new Error(`agent://${outputId} selected generation mismatch`);
	}
}
/**
 * Handler for agent:// URLs.
 *
 * Resolves output IDs like "reviewer_0" to their artifact files,
 * with optional JSON extraction.
 */
export class AgentProtocolHandler implements ProtocolHandler {
	readonly scheme = "agent";
	readonly immutable = true;

	async resolve(url: InternalUrl, context?: ResolveContext): Promise<InternalResource> {
		const outputId = url.rawHost || url.hostname;
		if (!outputId) {
			throw new Error("agent:// URL requires an output ID: agent://<id>");
		}
		// Output IDs address a single file inside a session artifacts dir. Reject
		// path separators / traversal so a crafted id cannot escape the dir via
		// path.join(dir, `${outputId}.md`).
		if (outputId.includes("/") || outputId.includes("\\") || outputId.includes("..")) {
			throw new Error(`agent://${outputId} invalid id: path separators are not allowed`);
		}

		const urlPath = url.pathname;
		const queryParam = url.searchParams.get("q");
		const hasPathExtraction = urlPath && urlPath !== "/" && urlPath !== "";
		const hasQueryExtraction = queryParam !== null && queryParam !== "";

		if (hasPathExtraction && hasQueryExtraction) {
			throw new Error("agent:// URL cannot combine path extraction with ?q=");
		}

		const dirs = authorizedArtifactsDirsFromContext(context);

		if (dirs.length === 0) {
			throw new Error("No session - agent outputs unavailable");
		}

		let foundPath: string | undefined;
		let foundMetadataPath: string | undefined;
		let foundSelector: ManagedOutputSelector | undefined;
		let anyDirExists = false;

		for (const dir of dirs) {
			try {
				await fs.stat(dir);
				anyDirExists = true;
			} catch (err) {
				if (isEnoent(err)) continue;
				throw err;
			}
			const selector = await readManagedOutputSelector(outputId, path.join(dir, `${outputId}.md.selector.json`));
			const candidate = selector ? path.join(dir, selector.outputFilename) : path.join(dir, `${outputId}.md`);
			const metadataPath = selector ? path.join(dir, selector.metadataFilename) : `${candidate}.meta.json`;
			try {
				await fs.stat(candidate);
				if (foundPath) throw new Error(`agent://${outputId} ambiguous id in authorized artifacts`);
				foundPath = candidate;
				foundMetadataPath = metadataPath;
				foundSelector = selector ?? undefined;
			} catch (err) {
				if (!isEnoent(err)) throw err;
			}
		}

		if (!anyDirExists) {
			throw new Error("No artifacts directory found");
		}

		if (!foundPath) {
			throw new Error(`agent://${outputId} not found`);
		}

		const rawBytes = Buffer.from(await Bun.file(foundPath).arrayBuffer());
		await verifyAgentOutputMetadata(outputId, foundPath, foundMetadataPath!, rawBytes, foundSelector);
		const rawContent = rawBytes.toString("utf8");
		const notes: string[] = [];
		let content = rawContent;
		let contentType: InternalResource["contentType"] = "text/markdown";

		if (hasPathExtraction || hasQueryExtraction) {
			let jsonValue: unknown;
			try {
				jsonValue = JSON.parse(rawContent);
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				throw new Error(`Output ${outputId} is not valid JSON: ${message}`);
			}

			const query = hasPathExtraction ? pathToQuery(urlPath) : queryParam!;
			if (query) {
				const extracted = applyQuery(jsonValue, query);
				try {
					content = JSON.stringify(extracted, null, 2) ?? "null";
				} catch {
					content = String(extracted);
				}
				notes.push(`Extracted: ${query}`);
			} else {
				content = JSON.stringify(jsonValue, null, 2);
			}
			contentType = "application/json";
		}

		return {
			url: url.href,
			content,
			contentType,
			size: Buffer.byteLength(content, "utf-8"),
			sourcePath: foundPath,
			notes,
		};
	}
}
