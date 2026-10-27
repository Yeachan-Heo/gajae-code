import * as fs from "node:fs/promises";
import path from "node:path";

export async function assertCwdInsideWorkspace(workspace: string, commandCwd: string): Promise<void> {
	const realWorkspace = await fs.realpath(workspace);
	const realCwd = await fs.realpath(commandCwd);
	if (realCwd !== realWorkspace && !realCwd.startsWith(`${realWorkspace}${path.sep}`)) {
		throw new Error("restricted bash cwd must stay inside the workspace");
	}
}
