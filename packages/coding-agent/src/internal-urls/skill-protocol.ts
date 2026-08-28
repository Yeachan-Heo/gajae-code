/**
 * Protocol handler for skill:// URLs.
 *
 * Resolves skill names to their SKILL.md files or relative paths within skill directories.
 *
 * URL forms:
 * - skill://<name> - Reads SKILL.md
 * - skill://<name>/<path> - Reads relative path within skill's baseDir
 */
import * as path from "node:path";
import { getActiveSkills } from "../extensibility/skills";
import type { InternalResource, InternalUrl, ProtocolHandler, ResolveContext } from "./types";

function getContentType(filePath: string): InternalResource["contentType"] {
	const ext = path.extname(filePath).toLowerCase();
	if (ext === ".md") return "text/markdown";
	return "text/plain";
}

/**
 * Validate that a path is safe (no traversal, no absolute paths).
 */
export function validateRelativePath(relativePath: string): void {
	if (path.isAbsolute(relativePath)) {
		throw new Error("Absolute paths are not allowed in skill:// URLs");
	}

	const normalized = path.normalize(relativePath);
	if (normalized.startsWith("..") || normalized.includes("/../") || normalized.includes("/..")) {
		throw new Error("Path traversal (..) is not allowed in skill:// URLs");
	}
}

/**
 * Handler for skill:// URLs.
 */
export class SkillProtocolHandler implements ProtocolHandler {
	readonly scheme = "skill";
	readonly immutable = true;

	async resolve(url: InternalUrl, context?: ResolveContext): Promise<InternalResource> {
		const skills = context?.skills ?? getActiveSkills();

		const skillName = url.rawHost || url.hostname;
		if (!skillName) {
			throw new Error("skill:// URL requires a skill name: skill://<name>");
		}

		const skill = skills.find(s => s.name === skillName);
		if (!skill) {
			const available = skills.filter(s => s.hide !== true).map(s => s.name);
			const availableStr = available.length > 0 ? available.join(", ") : "none";
			throw new Error(`Unknown skill: ${skillName}\nAvailable: ${availableStr}`);
		}

		let targetPath: string;
		const urlPath = url.pathname;
		const hasRelativePath = urlPath && urlPath !== "/" && urlPath !== "";

		if (hasRelativePath) {
			if (skill.baseDir.startsWith("embedded:")) {
				throw new Error(`Embedded skill ${skill.name} does not include relative file assets`);
			}
			const relativePath = decodeURIComponent(urlPath.slice(1));
			validateRelativePath(relativePath);
			targetPath = path.join(skill.baseDir, relativePath);

			const resolvedPath = path.resolve(targetPath);
			const resolvedBaseDir = path.resolve(skill.baseDir);
			if (!resolvedPath.startsWith(resolvedBaseDir + path.sep) && resolvedPath !== resolvedBaseDir) {
				throw new Error("Path traversal is not allowed");
			}
		} else {
			targetPath = skill.filePath;
		}

		if (!hasRelativePath && skill.loadContent) {
			const content = await skill.loadContent();
			return {
				url: url.href,
				content,
				contentType: "text/markdown",
				size: Buffer.byteLength(content, "utf-8"),
				sourcePath: targetPath,
				notes: [],
			};
		}

		if (typeof skill.content === "string" && !hasRelativePath) {
			return {
				url: url.href,
				content: skill.content,
				contentType: "text/markdown",
				size: Buffer.byteLength(skill.content, "utf-8"),
				sourcePath: targetPath,
				notes: [],
			};
		}

		const file = Bun.file(targetPath);
		if (!(await file.exists())) {
			throw new Error(`File not found: ${targetPath}`);
		}

		const content = await file.text();
		return {
			url: url.href,
			content,
			contentType: getContentType(targetPath),
			size: Buffer.byteLength(content, "utf-8"),
			sourcePath: targetPath,
			notes: [],
		};
	}
}
