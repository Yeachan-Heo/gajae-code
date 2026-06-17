/**
 * Optional research data description loading for RLM mode.
 *
 * Precedence: an explicit --data <path> (required to exist) overrides the
 * project-root DATA.md, which auto-loads when present and is silently skipped
 * when absent.
 */
import * as path from "node:path";

export interface RlmDataContext {
	/** Absolute path the content was loaded from. */
	path: string;
	content: string;
}

export async function loadRlmDataContext(cwd: string, dataFlag: string | undefined): Promise<RlmDataContext | null> {
	const target = dataFlag ? path.resolve(cwd, dataFlag) : path.join(cwd, "DATA.md");
	const file = Bun.file(target);
	if (!(await file.exists())) {
		if (dataFlag) {
			throw new Error(`--data file not found: ${target}`);
		}
		return null;
	}
	return { path: target, content: await file.text() };
}
