import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { managedSessionTransactionLocksDirectory } from "../src/session/internal/managed-session-scope";
import {
	ManagedSessionBusyError,
	withManagedSessionTransaction,
} from "../src/session/internal/managed-session-transaction";

// The exclusion token is the pair (lock directory, logical session id). Two opens
// that derive different directories for the same session silently stop excluding
// each other, so the derivation itself is the contract under test here.

const roots: string[] = [];

afterEach(async () => {
	for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});

async function makeSessionDirectory(): Promise<{ root: string; sessionDirectory: string; aliasRoot: string }> {
	const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "gjc-lock-directory-")));
	roots.push(root);
	const sessionDirectory = path.join(root, "sessions", "project");
	await fs.mkdir(sessionDirectory, { recursive: true, mode: 0o700 });
	const aliasRoot = path.join(root, "alias");
	await fs.symlink(root, aliasRoot, "dir");
	return { root, sessionDirectory, aliasRoot };
}

describe("transaction lock directory derivation", () => {
	it("derives one directory from the session root, not the process cwd", async () => {
		const { sessionDirectory } = await makeSessionDirectory();
		const derived = managedSessionTransactionLocksDirectory(sessionDirectory);
		expect(derived).toBe(path.join(await fs.realpath(sessionDirectory), ".gjc-managed-session-internal", "locks"));
		// Relative and dot-segment spellings of the same directory must agree.
		expect(managedSessionTransactionLocksDirectory(`${sessionDirectory}/./`)).toBe(derived);
		expect(managedSessionTransactionLocksDirectory(path.join(sessionDirectory, "child", ".."))).toBe(derived);
	});

	it("collapses a symlinked spelling of the same directory", async () => {
		const { sessionDirectory, aliasRoot } = await makeSessionDirectory();
		const aliased = path.join(aliasRoot, "sessions", "project");
		expect(aliased).not.toBe(sessionDirectory);
		expect(managedSessionTransactionLocksDirectory(aliased)).toBe(
			managedSessionTransactionLocksDirectory(sessionDirectory),
		);
	});

	it("excludes two opens that reached the same session through different aliases", async () => {
		const { sessionDirectory, aliasRoot } = await makeSessionDirectory();
		const direct = managedSessionTransactionLocksDirectory(sessionDirectory);
		const aliased = managedSessionTransactionLocksDirectory(path.join(aliasRoot, "sessions", "project"));
		await fs.mkdir(direct, { recursive: true, mode: 0o700 });
		const sessionId = "01a1b5b3-12fe-7136-9c85-ad1b859d6ca8";

		const held = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const first = withManagedSessionTransaction({ locksDirectory: direct, sessionId }, async () => {
			held.resolve();
			await release.promise;
			return "first";
		});
		await held.promise;
		try {
			// Same session reached through the alias must contend, not acquire.
			await expect(
				withManagedSessionTransaction({ locksDirectory: aliased, sessionId, waitMs: 150 }, async () => "second"),
			).rejects.toBeInstanceOf(ManagedSessionBusyError);
			// A different session in the same directory is unaffected.
			await expect(
				withManagedSessionTransaction(
					{ locksDirectory: aliased, sessionId: "01a1b5b3-12fe-7136-9c85-ad1b859d6ca9", waitMs: 0 },
					async () => "other",
				),
			).resolves.toBe("other");
		} finally {
			release.resolve();
		}
		await expect(first).resolves.toBe("first");
	});
});
