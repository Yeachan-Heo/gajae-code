import { vi } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { assertSafeDeletion, safeRmSync } from "../../../../scripts/safe-cleanup";

export interface WithTempHomeOptions {
	/**
	 * Also mock `os.homedir()` to return the temp home (default: true). The
	 * mock is restored before cleanup runs.
	 */
	mockHomedir?: boolean;
}

/**
 * Atomically run `fn` with `process.env.HOME` (and by default `os.homedir()`)
 * pointed at a fresh, owned temporary home, then restore the previous
 * environment and delete the temporary tree through the fail-closed cleanup
 * contract (issue #4794).
 *
 * Fail-closed by construction:
 * - The override is asserted to be in effect (`assertSafeDeletion`) — the temp
 *   home must be strictly inside the canonical OS temp root — BEFORE `fn`
 *   runs, so a test can never exercise home-derived paths against the real
 *   home by accident.
 * - Restore happens before removal, and removal targets the owning `mkdtemp`
 *   root captured at creation, never a value derived from `HOME` afterwards.
 * - Cleanup goes through `safeRmSync`, which refuses real-home/ancestor/
 *   out-of-root/unowned targets instead of blindly recursing.
 */
export async function withTempHome<T>(fn: (home: string) => Promise<T>, options: WithTempHomeOptions = {}): Promise<T> {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-temp-home-"));
	const home = path.join(root, "home");
	fs.mkdirSync(home, { recursive: true });
	assertSafeDeletion(home);

	const originalHome = process.env.HOME;
	const homedirSpy = options.mockHomedir === false ? undefined : vi.spyOn(os, "homedir").mockReturnValue(home);
	process.env.HOME = home;
	try {
		return await fn(home);
	} finally {
		if (originalHome === undefined) {
			delete process.env.HOME;
		} else {
			process.env.HOME = originalHome;
		}
		homedirSpy?.mockRestore();
		safeRmSync(root, { recursive: true, force: true });
	}
}
