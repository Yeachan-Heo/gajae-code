import { vi } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import {
	ManagedPreparedFileRemovalError,
	ManagedSessionDescendantStore,
	type ManagedTreeRemovalOutcome,
	ManagedTreeRemovalTestHooks,
	managedDirectoryRoot,
} from "../../src/session/internal/managed-session-storage";

if (process.platform !== "linux") throw new Error("FIFO recovery probe requires Linux");
const parent = process.argv[2];
if (!parent) throw new Error("Missing fixture parent");
const root = fs.mkdtempSync(path.join(parent, "managed-"));
fs.chmodSync(root, 0o700);
const store = new ManagedSessionDescendantStore(managedDirectoryRoot(root), root);
const originalOpen = fs.openSync;
const previousHook = ManagedTreeRemovalTestHooks.afterPreparedFileRemoval;
try {
	const transcript = path.join(root, "transcript");
	await Bun.write(transcript, "original retained bytes");
	fs.chmodSync(transcript, 0o600);
	const snapshot = store.readExpected("transcript");
	if (!snapshot) throw new Error("Missing fixture snapshot");
	const backup = path.join(root, "retained-original");
	let actual = "";
	let observed: ManagedTreeRemovalOutcome | undefined;
	let substitutions = 0;
	let firstOpenWasOriginal = false;
	let openedFd: number | undefined;
	ManagedTreeRemovalTestHooks.afterPreparedFileRemoval = (_target, outcome) => {
		observed = outcome;
		if (outcome.route !== "retained" || !outcome.result.recoveryPhysicalPath)
			throw new Error("Missing actual retained path");
		actual = outcome.result.recoveryPhysicalPath;
		vi.spyOn(fs, "openSync").mockImplementation((pathname, flags, mode) => {
			if (pathname === actual && substitutions === 0) {
				// checkFile has already lstat'ed the regular file; intercept its first security open.
				const before = fs.lstatSync(actual, { bigint: true });
				firstOpenWasOriginal = before.isFile() && before.ino === snapshot.identity.ino;
				if (!firstOpenWasOriginal) throw new Error("Retained original changed before substitution");
				fs.renameSync(actual, backup);
				const fifo = Bun.spawnSync(["mkfifo", "-m", "600", actual], {
					stdout: "pipe",
					stderr: "pipe",
				});
				if (fifo.exitCode !== 0) throw new Error(`mkfifo failed: ${fifo.stderr.toString()}`);
				substitutions++;
				openedFd = originalOpen(pathname, flags, mode);
				return openedFd;
			}
			return originalOpen(pathname, flags, mode);
		});
	};
	let failure: unknown;
	let successReceipt = false;
	try {
		store.removeExpectedForPreparedDiscard("transcript", snapshot);
		successReceipt = true;
	} catch (error) {
		failure = error;
	}
	const managedFailure = failure instanceof ManagedPreparedFileRemovalError ? failure : undefined;
	let fdClosed = false;
	if (openedFd !== undefined) {
		try {
			fs.fstatSync(openedFd);
		} catch (error) {
			fdClosed = (error as NodeJS.ErrnoException).code === "EBADF";
		}
	}
	const saved = fs.lstatSync(backup, { bigint: true });
	process.stdout.write(
		JSON.stringify({
			typedFailure: managedFailure !== undefined,
			phase: managedFailure?.phase ?? null,
			cause: managedFailure?.cause instanceof Error ? managedFailure.cause.message : null,
			outcomePreserved: managedFailure !== undefined && managedFailure.outcome === observed,
			substitutions,
			firstOpenWasOriginal,
			fifoRetained: fs.lstatSync(actual).isFIFO(),
			backupIdentityPreserved:
				saved.isFile() && saved.ino === snapshot.identity.ino && saved.dev === snapshot.identity.dev,
			backupBytesPreserved: Buffer.from(await Bun.file(backup).arrayBuffer()).equals(snapshot.bytes),
			transcriptAbsent: !fs.existsSync(transcript),
			fdClosed,
			successReceipt,
		}),
	);
} finally {
	vi.restoreAllMocks();
	if (previousHook) ManagedTreeRemovalTestHooks.afterPreparedFileRemoval = previousHook;
	else delete ManagedTreeRemovalTestHooks.afterPreparedFileRemoval;
	store.close();
}
