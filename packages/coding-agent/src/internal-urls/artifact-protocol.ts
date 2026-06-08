/**
 * Protocol handler for artifact:// URLs.
 *
 * Resolves artifact IDs only against artifacts directories explicitly authorized
 * by the caller's ResolveContext. Unlike agent://, artifacts are raw text.
 *
 * URL form:
 * - artifact://<id> - Full artifact content
 *
 * Pagination is handled by the read tool via offset/limit parameters.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { isEnoent } from "@gajae-code/utils";
import { authorizedArtifactsDirsFromContext } from "./registry-helpers";
import type { InternalResource, InternalUrl, ProtocolHandler, ResolveContext } from "./types";

export class ArtifactProtocolHandler implements ProtocolHandler {
	readonly scheme = "artifact";
	readonly immutable = true;

	async resolve(url: InternalUrl, context?: ResolveContext): Promise<InternalResource> {
		const id = url.rawHost || url.hostname;
		if (!id) {
			throw new Error("artifact:// URL requires a numeric ID: artifact://0");
		}
		if (!/^\d+$/.test(id)) {
			throw new Error(`artifact:// ID must be numeric, got: ${id}`);
		}

		const dirs = authorizedArtifactsDirsFromContext(context);

		if (dirs.length === 0) {
			throw new Error("No session - artifacts unavailable");
		}

		let foundPath: string | undefined;
		let anyDirExists = false;

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
				if (f.startsWith(`${id}.`)) {
					if (foundPath) throw new Error(`artifact://${id} ambiguous id in authorized artifacts`);
					foundPath = path.join(dir, f);
				}
			}
		}

		if (!anyDirExists) {
			throw new Error("No artifacts directory found");
		}

		if (!foundPath) {
			throw new Error(`artifact://${id} not found`);
		}

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
