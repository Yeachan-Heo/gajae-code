import { afterEach } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export interface TrustTempDirs {
	/** Fresh directory under `os.tmpdir()` for a probe child's `cwd` or `HOME`. */
	tempDir(): string;
	/** Fresh directory, optionally holding the `.env` a probe child reads from its `cwd`. */
	projectDir(dotenv?: string): string;
}

/**
 * Temp directories for env-trust probe suites, removed after each test.
 * `prefix` keeps a directory that outlived a failing probe attributable to its suite.
 */
export function createTrustTempDirs(prefix: string): TrustTempDirs {
	const created: string[] = [];
	afterEach(() => {
		for (const dir of created.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
	});

	const tempDir = (): string => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
		created.push(dir);
		return dir;
	};

	return {
		tempDir,
		projectDir(dotenv?: string): string {
			const dir = tempDir();
			if (dotenv !== undefined) fs.writeFileSync(path.join(dir, ".env"), dotenv);
			return dir;
		},
	};
}
