import { afterEach, describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { exactReplaceRetained } from "../native/index.js";

/**
 * Coverage for `exactReplaceRetained` (D4 self-replacement primitive).
 *
 * D4 cannot use `fs.rename`/`fs.unlink` rollback, and cannot use ordinary
 * `exactReplacePath`: that primitive's predecessor retirement scrubs the old
 * bytes in place (POSIX) or deletes them outright (Windows), either of which
 * can harm a process still mapped from (or about to re-exec) those bytes.
 * `exactReplaceRetained` instead publishes the new payload and renames the
 * *old* payload intact to a caller-preauthorized backup name in the same
 * parent -- never scrubbing, never deleting.
 *
 * No actual running host binary is replaced anywhere in this file: every
 * fixture is a plain staged/target file pair the test itself creates and
 * owns, standing in for the executable payload the production caller would
 * supply.
 */

const temporaryDirectories: string[] = [];

function sha256(contents: string): string {
	return createHash("sha256").update(contents).digest("hex");
}

async function temporaryDirectory(): Promise<string> {
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), "pi-retained-publish-"));
	temporaryDirectories.push(directory);
	return directory;
}

afterEach(async () => {
	await Promise.all(
		temporaryDirectories.splice(0).map(directory => fs.rm(directory, { recursive: true, force: true })),
	);
});

async function identityOf(pathname: string, contents: string): Promise<Record<string, unknown>> {
	const stat = await fs.stat(pathname, { bigint: true });
	const parent = await fs.stat(path.dirname(pathname), { bigint: true });
	return {
		dev: stat.dev,
		ino: stat.ino,
		nlink: stat.nlink,
		parentDev: parent.dev,
		parentIno: parent.ino,
		size: stat.size,
		mtimeNs: stat.mtimeNs,
		sha256: sha256(contents),
	};
}

describe("exactReplaceRetained", () => {
	it("publishes the new payload and preserves the old payload byte-for-byte at the backup path", async () => {
		const root = await temporaryDirectory();
		const source = path.join(root, "staged.bin");
		const destination = path.join(root, "app.bin");
		await fs.writeFile(source, "new-payload-bytes");
		await fs.writeFile(destination, "old-payload-bytes");
		const expectedSource = await identityOf(source, "new-payload-bytes");
		const expectedDestination = await identityOf(destination, "old-payload-bytes");

		const result = exactReplaceRetained(source, destination, "app.bin.backup", expectedSource, expectedDestination);

		expect(result.ok).toBe(true);
		expect(result.detachedPath).toBe(path.join(root, "app.bin.backup"));
		// Correct new bytes land at the destination.
		expect(await fs.readFile(destination, "utf8")).toBe("new-payload-bytes");
		// Old bytes are fully preserved (not scrubbed, not truncated) at the
		// retained backup path.
		expect(await fs.readFile(path.join(root, "app.bin.backup"), "utf8")).toBe("old-payload-bytes");
		// The staged source name is consumed; only destination + backup remain.
		await expect(fs.access(source)).rejects.toMatchObject({ code: "ENOENT" });
		// No unrecorded custody debris (e.g. a process-ID-derived private staging
		// name) is left behind: only the published destination and the exact
		// caller-recorded backup name exist in the parent directory.
		expect((await fs.readdir(root)).sort()).toEqual(["app.bin", "app.bin.backup"]);
	});

	it("refuses to publish when the source has been substituted since capture", async () => {
		const root = await temporaryDirectory();
		const source = path.join(root, "staged.bin");
		const destination = path.join(root, "app.bin");
		await fs.writeFile(source, "authorized-new");
		await fs.writeFile(destination, "old-payload");
		const expectedSource = await identityOf(source, "authorized-new");
		const expectedDestination = await identityOf(destination, "old-payload");
		await fs.writeFile(source, "attacker-substituted");

		const result = exactReplaceRetained(source, destination, "app.bin.backup", expectedSource, expectedDestination);

		expect(result.ok).toBe(false);
		expect(result.code).toBe("identity_mismatch");
		// Nothing was mutated: destination bytes and the substituted source are
		// both exactly as left, and no backup was created.
		expect(await fs.readFile(destination, "utf8")).toBe("old-payload");
		expect(await fs.readFile(source, "utf8")).toBe("attacker-substituted");
		await expect(fs.access(path.join(root, "app.bin.backup"))).rejects.toMatchObject({ code: "ENOENT" });
	});

	it("refuses to publish when the destination has been substituted since capture", async () => {
		const root = await temporaryDirectory();
		const source = path.join(root, "staged.bin");
		const destination = path.join(root, "app.bin");
		await fs.writeFile(source, "new-payload");
		await fs.writeFile(destination, "authorized-old");
		const expectedSource = await identityOf(source, "new-payload");
		const expectedDestination = await identityOf(destination, "authorized-old");
		await fs.writeFile(destination, "attacker-substituted");

		const result = exactReplaceRetained(source, destination, "app.bin.backup", expectedSource, expectedDestination);

		expect(result.ok).toBe(false);
		expect(result.code).toBe("identity_mismatch");
		expect(await fs.readFile(destination, "utf8")).toBe("attacker-substituted");
		expect(await fs.readFile(source, "utf8")).toBe("new-payload");
		await expect(fs.access(path.join(root, "app.bin.backup"))).rejects.toMatchObject({ code: "ENOENT" });
	});

	it("refuses to publish when the captured parent identity no longer matches", async () => {
		const root = await temporaryDirectory();
		const source = path.join(root, "staged.bin");
		const destination = path.join(root, "app.bin");
		await fs.writeFile(source, "new-payload");
		await fs.writeFile(destination, "old-payload");
		const expectedSource = await identityOf(source, "new-payload");
		const expectedDestination = await identityOf(destination, "old-payload");
		// Corrupt the captured parent identity so it can never match the real
		// retained parent descriptor.
		const poisonedSource = { ...expectedSource, parentIno: (expectedSource.parentIno as bigint) + 999999n };

		const result = exactReplaceRetained(source, destination, "app.bin.backup", poisonedSource, expectedDestination);

		expect(result.ok).toBe(false);
		expect(["parent_mismatch", "identity_mismatch"]).toContain(result.code);
		expect(await fs.readFile(destination, "utf8")).toBe("old-payload");
		expect(await fs.readFile(source, "utf8")).toBe("new-payload");
	});

	it("refuses an occupied backup name and leaves the old payload fully recoverable", async () => {
		const root = await temporaryDirectory();
		const source = path.join(root, "staged.bin");
		const destination = path.join(root, "app.bin");
		const backupPath = path.join(root, "app.bin.backup");
		await fs.writeFile(source, "new-payload");
		await fs.writeFile(destination, "old-payload");
		await fs.writeFile(backupPath, "foreign-occupant");
		const expectedSource = await identityOf(source, "new-payload");
		const expectedDestination = await identityOf(destination, "old-payload");

		const result = exactReplaceRetained(source, destination, "app.bin.backup", expectedSource, expectedDestination);

		expect(result.ok).toBe(false);
		// The occupied backup name must never be overwritten.
		expect(await fs.readFile(backupPath, "utf8")).toBe("foreign-occupant");
		expect(result.code).toBe("quarantine_collision");
		expect(result.retainedSuccessorPath).toBeUndefined();
		expect(result.detachedPath).toBeUndefined();
		expect(await fs.readFile(source, "utf8")).toBe("new-payload");
		expect(await fs.readFile(destination, "utf8")).toBe("old-payload");
	});

	it("rejects a hard-linked staged source before publishing anything", async () => {
		const root = await temporaryDirectory();
		const source = path.join(root, "staged.bin");
		const sourceAlias = path.join(root, "staged-alias.bin");
		const destination = path.join(root, "app.bin");
		await fs.writeFile(source, "new-payload");
		await fs.link(source, sourceAlias);
		await fs.writeFile(destination, "old-payload");
		const expectedSource = await identityOf(source, "new-payload");
		const expectedDestination = await identityOf(destination, "old-payload");

		const result = exactReplaceRetained(source, destination, "app.bin.backup", expectedSource, expectedDestination);

		expect(result.ok).toBe(false);
		expect(["hard_link_unsupported", "invalid_request", "identity_mismatch"]).toContain(result.code);
		expect(await fs.readFile(source, "utf8")).toBe("new-payload");
		expect(await fs.readFile(sourceAlias, "utf8")).toBe("new-payload");
		expect(await fs.readFile(destination, "utf8")).toBe("old-payload");
	});

	it("rejects a hard-linked destination before publishing anything", async () => {
		const root = await temporaryDirectory();
		const source = path.join(root, "staged.bin");
		const destination = path.join(root, "app.bin");
		const destinationAlias = path.join(root, "app-alias.bin");
		await fs.writeFile(source, "new-payload");
		await fs.writeFile(destination, "old-payload");
		await fs.link(destination, destinationAlias);
		const expectedSource = await identityOf(source, "new-payload");
		const expectedDestination = await identityOf(destination, "old-payload");

		const result = exactReplaceRetained(source, destination, "app.bin.backup", expectedSource, expectedDestination);

		expect(result.ok).toBe(false);
		expect(["hard_link_unsupported", "invalid_request", "identity_mismatch"]).toContain(result.code);
		expect(await fs.readFile(source, "utf8")).toBe("new-payload");
		expect(await fs.readFile(destination, "utf8")).toBe("old-payload");
		expect(await fs.readFile(destinationAlias, "utf8")).toBe("old-payload");
	});

	it.skipIf(process.platform === "win32")("rejects a symlinked staged source without following it", async () => {
		const root = await temporaryDirectory();
		const outside = path.join(root, "outside.bin");
		const source = path.join(root, "staged.bin");
		const destination = path.join(root, "app.bin");
		await fs.writeFile(outside, "outside-payload");
		await fs.symlink(outside, source);
		await fs.writeFile(destination, "old-payload");
		const outsideStat = await fs.stat(outside, { bigint: true });
		const outsideParent = await fs.stat(root, { bigint: true });
		const expectedSource = {
			dev: outsideStat.dev,
			ino: outsideStat.ino,
			nlink: outsideStat.nlink,
			parentDev: outsideParent.dev,
			parentIno: outsideParent.ino,
			size: outsideStat.size,
			mtimeNs: outsideStat.mtimeNs,
			sha256: sha256("outside-payload"),
		};
		const expectedDestination = await identityOf(destination, "old-payload");

		const result = exactReplaceRetained(source, destination, "app.bin.backup", expectedSource, expectedDestination);

		expect(result.ok).toBe(false);
		expect(["reparse_point", "identity_mismatch"]).toContain(result.code);
		expect(await fs.readFile(outside, "utf8")).toBe("outside-payload");
		expect(await fs.readFile(destination, "utf8")).toBe("old-payload");
	});

	it.skipIf(process.platform === "win32")("rejects a symlinked destination without following it", async () => {
		const root = await temporaryDirectory();
		const outside = path.join(root, "outside.bin");
		const source = path.join(root, "staged.bin");
		const destination = path.join(root, "app.bin");
		await fs.writeFile(source, "new-payload");
		await fs.writeFile(outside, "outside-old-payload");
		await fs.symlink(outside, destination);
		const expectedSource = await identityOf(source, "new-payload");
		const outsideStat = await fs.stat(outside, { bigint: true });
		const outsideParent = await fs.stat(root, { bigint: true });
		const expectedDestination = {
			dev: outsideStat.dev,
			ino: outsideStat.ino,
			nlink: outsideStat.nlink,
			parentDev: outsideParent.dev,
			parentIno: outsideParent.ino,
			size: outsideStat.size,
			mtimeNs: outsideStat.mtimeNs,
			sha256: sha256("outside-old-payload"),
		};

		const result = exactReplaceRetained(source, destination, "app.bin.backup", expectedSource, expectedDestination);

		expect(result.ok).toBe(false);
		expect(["reparse_point", "identity_mismatch"]).toContain(result.code);
		expect(await fs.readFile(outside, "utf8")).toBe("outside-old-payload");
		expect(await fs.readFile(source, "utf8")).toBe("new-payload");
	});

	it("rejects a bounded backup name that is not a single path component", async () => {
		const root = await temporaryDirectory();
		const source = path.join(root, "staged.bin");
		const destination = path.join(root, "app.bin");
		await fs.writeFile(source, "new-payload");
		await fs.writeFile(destination, "old-payload");
		const expectedSource = await identityOf(source, "new-payload");
		const expectedDestination = await identityOf(destination, "old-payload");

		for (const badName of ["../escape", "nested/backup", "", "."]) {
			const result = exactReplaceRetained(source, destination, badName, expectedSource, expectedDestination);
			expect(result.ok).toBe(false);
			expect(result.code).toBe("invalid_request");
		}
		// Nothing was mutated by any of the rejected attempts.
		expect(await fs.readFile(source, "utf8")).toBe("new-payload");
		expect(await fs.readFile(destination, "utf8")).toBe("old-payload");
	});

	it("rejects a backup name longer than the bounded 255-byte limit", async () => {
		const root = await temporaryDirectory();
		const source = path.join(root, "staged.bin");
		const destination = path.join(root, "app.bin");
		await fs.writeFile(source, "new-payload");
		await fs.writeFile(destination, "old-payload");
		const expectedSource = await identityOf(source, "new-payload");
		const expectedDestination = await identityOf(destination, "old-payload");

		const result = exactReplaceRetained(source, destination, "x".repeat(256), expectedSource, expectedDestination);

		expect(result.ok).toBe(false);
		expect(result.code).toBe("invalid_request");
	});

	it("reports typed post-effect evidence distinct from a pre-mutation refusal", async () => {
		const root = await temporaryDirectory();
		const source = path.join(root, "staged.bin");
		const destination = path.join(root, "app.bin");
		await fs.writeFile(source, "new-payload");
		await fs.writeFile(destination, "old-payload");
		const expectedSource = await identityOf(source, "new-payload");
		const expectedDestination = await identityOf(destination, "old-payload");

		const success = exactReplaceRetained(source, destination, "app.bin.backup", expectedSource, expectedDestination);

		// Successful publish result shape: no code, no error-only fields set,
		// and the backup path is reported as the (successful) detached path --
		// never conflated with a failure's retained-successor/placeholder/unknown
		// evidence, which must all stay absent on success.
		expect(success).toMatchObject({
			ok: true,
			detachedPath: path.join(root, "app.bin.backup"),
		});
		expect(success.code).toBeUndefined();
		expect(success.retainedSuccessorPath).toBeUndefined();
		expect(success.retainedPlaceholderPath).toBeUndefined();
		expect(success.retainedUnknownPath).toBeUndefined();
		expect(success.windowsErrorCode).toBeUndefined();

		// A second call against the now-stale captured identity is a distinct,
		// pre-mutation-shaped refusal: identity_mismatch, no detached/retained
		// evidence at all (nothing was renamed this time).
		const replay = exactReplaceRetained(source, destination, "app.bin.backup", expectedSource, expectedDestination);
		expect(replay.ok).toBe(false);
		expect(replay.detachedPath).toBeUndefined();
	});

	it.skipIf(process.platform !== "win32")(
		"reports a pre-mutation Windows sharing violation distinctly, never as a post-effect failure",
		async () => {
			// Issue #4330 category: a concurrent holder without delete sharing makes
			// the destination open fail with STATUS_SHARING_VIOLATION before any
			// rename. This must never be confused with a post-effect failure: no
			// detached/retained-successor/retained-placeholder path evidence may be
			// present, and the numeric NTSTATUS must be exposed distinctly.
			const root = await temporaryDirectory();
			const source = path.join(root, "staged.bin");
			const destination = path.join(root, "app.bin");
			await fs.writeFile(source, "new-payload");
			await fs.writeFile(destination, "old-payload");
			const expectedSource = await identityOf(source, "new-payload");
			const expectedDestination = await identityOf(destination, "old-payload");

			const holder = await fs.open(destination, "r+");
			try {
				const result = exactReplaceRetained(
					source,
					destination,
					"app.bin.backup",
					expectedSource,
					expectedDestination,
				);

				expect(result.ok).toBe(false);
				expect(result.code).toBe("sharing_violation");
				expect(typeof result.windowsErrorCode).toBe("string");
				expect(result.windowsErrorCode).toBe("0xC0000043");
				// Pre-mutation: no namespace evidence of any kind.
				expect(result.detachedPath).toBeUndefined();
				expect(result.retainedSuccessorPath).toBeUndefined();
				expect(result.retainedPlaceholderPath).toBeUndefined();
				expect(result.retainedUnknownPath).toBeUndefined();
				expect(await fs.readFile(destination, "utf8")).toBe("old-payload");
				expect(await fs.readFile(source, "utf8")).toBe("new-payload");
			} finally {
				await holder.close();
			}
		},
	);
});
