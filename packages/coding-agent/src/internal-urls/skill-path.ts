import * as fs from "node:fs/promises";
import * as path from "node:path";

export async function realSkillPath(baseDir: string, targetPath: string): Promise<string> {
	const realBase = await fs.realpath(baseDir);
	let realTarget: string;
	try {
		realTarget = await fs.realpath(targetPath);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") {
			throw new Error(`File not found: ${targetPath}`);
		}
		throw error;
	}
	if (realTarget !== realBase && !realTarget.startsWith(realBase + path.sep)) {
		throw new Error("Path traversal is not allowed");
	}
	return realTarget;
}
