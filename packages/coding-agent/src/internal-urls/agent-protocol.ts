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

async function verifyAgentOutputMetadata(outputId: string, foundPath: string, bytes: Buffer): Promise<void> {
	const metaPath = `${foundPath}.meta.json`;
	let metaRaw: string;
	try {
		metaRaw = await Bun.file(metaPath).text();
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
	const stat = await fs.stat(foundPath);
	if (stat.size !== parsed.sizeBytes || bytes.byteLength !== parsed.sizeBytes) {
		throw new Error(`agent://${outputId} size mismatch`);
	}
	const sha256 = createHash("sha256").update(bytes).digest("hex");
	if (sha256 !== parsed.sha256) {
		throw new Error(`agent://${outputId} hash mismatch`);
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
		let anyDirExists = false;

		for (const dir of dirs) {
			try {
				await fs.stat(dir);
				anyDirExists = true;
			} catch (err) {
				if (isEnoent(err)) continue;
				throw err;
			}
			const candidate = path.join(dir, `${outputId}.md`);
			try {
				await fs.stat(candidate);
				if (foundPath) throw new Error(`agent://${outputId} ambiguous id in authorized artifacts`);
				foundPath = candidate;
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
		await verifyAgentOutputMetadata(outputId, foundPath, rawBytes);
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
