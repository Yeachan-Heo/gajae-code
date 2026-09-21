/**
 * Protocol handler for `embedded:` URLs.
 *
 * Bundled GJC skills and skill fragments have no filesystem home: the skill
 * tool, skill discovery, and the skill registry all report the stable
 * identifier `embedded:gjc/<catalog relative path>` (for example
 * `embedded:gjc/skills/ultragoal/SKILL.md`). This handler resolves exactly
 * those identifiers back to the bundled catalog content so the path a tool
 * prints is a path `read` can open.
 *
 * URL forms (the `embedded:` and `embedded://` spellings are equivalent):
 * - `embedded:gjc/skills/<name>/SKILL.md` — bundled skill body
 * - `embedded:gjc/skills/<name>` — skill baseDir, resolves to its SKILL.md
 * - `embedded:gjc/skill-fragments/<parent>/<fragment>.md` — bundled fragment
 */
import { BUNDLED_GJC_SKILL_CATALOG, type BundledGjcSkillCatalogEntry } from "../defaults/gjc-skills.generated";
import type { InternalResource, InternalUrl, ProtocolHandler } from "./types";

const GJC_NAMESPACE = "gjc";

function normalizeRelativePath(relativePath: string): string {
	return relativePath.replace(/^\/+/, "").replace(/\/+$/, "");
}

function findCatalogEntry(relativePath: string): BundledGjcSkillCatalogEntry | undefined {
	const direct = BUNDLED_GJC_SKILL_CATALOG.find(entry => entry.relativePath === relativePath);
	if (direct) return direct;
	// `baseDir` identifiers point at the skill directory, not the body file.
	return BUNDLED_GJC_SKILL_CATALOG.find(entry => entry.relativePath === `${relativePath}/SKILL.md`);
}

function availablePaths(): string {
	return BUNDLED_GJC_SKILL_CATALOG.map(entry => `embedded:${GJC_NAMESPACE}/${entry.relativePath}`).join(", ");
}

/**
 * Handler for `embedded:` URLs.
 */
export class EmbeddedProtocolHandler implements ProtocolHandler {
	readonly scheme = "embedded";
	readonly immutable = true;

	async resolve(url: InternalUrl): Promise<InternalResource> {
		const namespace = (url.rawHost || url.hostname || "").toLowerCase();
		if (namespace !== GJC_NAMESPACE) {
			throw new Error(
				`Unknown embedded namespace: ${namespace || "(empty)"}\nOnly embedded:${GJC_NAMESPACE}/... is resolvable.`,
			);
		}

		let rawRelativePath = url.rawPathname ?? url.pathname ?? "";
		try {
			rawRelativePath = decodeURIComponent(rawRelativePath);
		} catch {
			// Leave the raw form in place; the lookup below reports it verbatim.
		}
		const relativePath = normalizeRelativePath(rawRelativePath);
		if (!relativePath) {
			throw new Error(
				`embedded:${GJC_NAMESPACE}/ URL requires a bundled resource path, e.g. embedded:${GJC_NAMESPACE}/skills/ultragoal/SKILL.md`,
			);
		}
		if (relativePath.split("/").includes("..")) {
			throw new Error("Path traversal (..) is not allowed in embedded: URLs");
		}

		const entry = findCatalogEntry(relativePath);
		if (!entry) {
			throw new Error(
				`Unknown embedded resource: embedded:${GJC_NAMESPACE}/${relativePath}\nAvailable: ${availablePaths()}`,
			);
		}

		const content = await entry.loadContent();
		return {
			url: url.href,
			content,
			contentType: "text/markdown",
			size: Buffer.byteLength(content, "utf-8"),
			notes: [],
		};
	}
}
