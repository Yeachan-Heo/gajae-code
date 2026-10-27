import * as fs from "node:fs/promises";
import path from "node:path";

export async function assertDeleteInsideWorkspace(cwd: string, filePath: string): Promise<void> {
	const root = await fs.realpath(cwd);
	const target = await fs.realpath(filePath);
	if (target !== root && !target.startsWith(`${root}${path.sep}`)) {
		throw new Error(`Delete escapes the workspace: ${filePath}`);
	}
}
