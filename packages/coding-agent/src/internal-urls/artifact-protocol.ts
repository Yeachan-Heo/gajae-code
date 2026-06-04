/**
 * Protocol handler for artifact:// URLs.
 *
 * Resolves artifact IDs against the artifacts directories of every active
 * session. Unlike agent://, artifacts are raw text with no JSON extraction.
 *
 * URL form:
 * - artifact://<id> - Full artifact content
 *
 * Pagination is handled by the read tool via offset/limit parameters.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { isEnoent } from "@gajae-code/utils";
import { artifactsDirsFromRegistry } from "./registry-helpers";
import type { InternalResource, InternalUrl, ProtocolHandler } from "./types";

export class ArtifactProtocolHandler implements ProtocolHandler {
	readonly scheme = "artifact";
	readonly immutable = true;

	async resolve(url: InternalUrl): Promise<InternalResource> {
		const id = url.rawHost || url.hostname;
		if (!id) {
			throw new Error("artifact:// URL requires a numeric ID: artifact://0");
		}
		if (!/^\d+$/.test(id)) {
			throw new Error(`artifact:// ID must be numeric, got: ${id}`);
		}

		const dirs = artifactsDirsFromRegistry();

		if (dirs.length === 0) {
			throw new Error("No session - artifacts unavailable");
		}

		const candidatePaths: string[] = [];
		let anyDirExists = false;
		const availableIds = new Set<string>();

		for (const dir of dirs) {
			let files: string[];
			try {
				files = await fs.readdir(dir);
				anyDirExists = true;
			} catch (err) {
				if (isEnoent(err)) continue;
				throw err;
			}
			for (const f of files) {
				if (f.endsWith(".meta.json")) continue;
				const m = f.match(/^(\d+)\./);
				if (m) availableIds.add(m[1]);
				if (f.startsWith(`${id}.`)) candidatePaths.push(path.join(dir, f));
			}
		}

		if (!anyDirExists) {
			throw new Error("No artifacts directory found");
		}

		if (candidatePaths.length === 0) {
			const sorted = [...availableIds].sort((a, b) => Number(a) - Number(b));
			const availableStr = sorted.length > 0 ? sorted.join(", ") : "none";
			throw new Error(`Artifact ${id} not found. Available: ${availableStr}`);
		}
		if (candidatePaths.length > 1) {
			throw new Error(`artifact://${id} ambiguous id: ${candidatePaths.length} matching artifacts`);
		}

		const foundPath = candidatePaths[0]!;
		const content = await Bun.file(foundPath).text();
		return {
			url: url.href,
			content,
			contentType: "text/plain",
			size: Buffer.byteLength(content, "utf-8"),
			sourcePath: foundPath,
		};
	}
}
