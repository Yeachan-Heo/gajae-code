/**
 * A rejected strict-resume open must release everything it allocated.
 *
 * Strict resume opens a persistence writer to rewrite stale OpenAI Responses
 * replay metadata. When that persist fails, the half-built manager is thrown
 * away, so its writer descriptor, resident text store, and owned managed
 * authority have to go with it — and the error the caller sees has to
 * distinguish "cleanup succeeded" from "cleanup outcome is uncertain".
 *
 * The writer close lifecycle has four observable outcomes, each with its own
 * cleanup contract:
 *   - clean close                   -> release, surface the resume error alone
 *   - dispatched close + drain err  -> release, surface the resume error alone
 *   - close_unknown (quarantined)   -> release, surface an AggregateError
 *   - close_failed_retryable        -> retain and retry until a terminal close
 */

import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { SessionManager, SessionManagerTestHooks } from "@gajae-code/coding-agent/session/session-manager";
import {
	FileSessionStorage,
	MemorySessionStorage,
	type SessionStorageWriter,
	type SessionStorageWriterCloseState,
	SessionStorageWriterRetryableCloseError,
} from "@gajae-code/coding-agent/session/session-storage";

type CloseMode =
	| { kind: "clean" }
	/** The OS close is dispatched and succeeds; `close()` rethrows a drain failure. */
	| { kind: "drain_error_after_close" }
	/** The OS close was dispatched and failed: terminal, quarantined descriptor. */
	| { kind: "close_unknown" }
	/** Certified pre-dispatch failure for the first `failures` attempts. */
	| { kind: "retryable"; failures: number };

const SESSION_DIR = "/sessions";
const SOURCE_FILE = "/sessions/source.jsonl";
const WRITE_FAILURE = "injected replay-metadata persist failure";

/**
 * A resumable transcript whose assistant message still carries a rehydrated
 * OpenAI Responses payload, so strict resume must sanitize and persist it.
 */
function transcript(): string {
	const header = {
		type: "session",
		id: "rejected-open",
		timestamp: new Date(0).toISOString(),
		cwd: "/cwd",
		version: 5,
	};
	const user = {
		type: "message",
		id: "m1",
		parentId: null,
		timestamp: new Date(0).toISOString(),
		message: { role: "user", content: "hello", timestamp: 0 },
	};
	const assistant = {
		type: "message",
		id: "m2",
		parentId: "m1",
		timestamp: new Date(0).toISOString(),
		message: {
			role: "assistant",
			content: [{ type: "text", text: "hi" }],
			api: "openai-responses",
			provider: "openai",
			model: "gpt-test",
			usage: {
				input: 1,
				output: 1,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 2,
				premiumRequests: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: 1,
			providerPayload: { type: "openaiResponsesHistory", items: [{ id: "resp_1" }] },
		},
	};
	return `${JSON.stringify(header)}\n${JSON.stringify(user)}\n${JSON.stringify(assistant)}\n`;
}

/**
 * Memory storage whose writer fails the replay-metadata persist (rejecting the
 * resume with the writer already live) and whose close outcome is scripted.
 */
class RejectedOpenStorage extends MemorySessionStorage {
	closeAttempts = 0;
	successfulCloses = 0;
	#mode: CloseMode;

	constructor(mode: CloseMode) {
		super();
		this.#mode = mode;
	}

	/** Let a persistently retryable writer finally reach a terminal close. */
	settle(mode: CloseMode): void {
		this.#mode = mode;
	}

	override openWriter(
		writerPath: string,
		options?: { flags?: "a" | "w"; onError?: (err: Error) => void },
	): SessionStorageWriter {
		const inner = super.openWriter(writerPath, options);
		const owner = this;
		let closeState: SessionStorageWriterCloseState = "open";
		let closeError: Error | undefined;
		return {
			writeLine() {
				throw new Error(WRITE_FAILURE);
			},
			writeLineSync() {
				throw new Error(WRITE_FAILURE);
			},
			flush: () => inner.flush(),
			fsync: () => inner.fsync(),
			fsyncSync: () => inner.fsyncSync?.(),
			async close() {
				owner.closeAttempts++;
				const mode = owner.#mode;
				if (mode.kind === "retryable" && owner.closeAttempts <= mode.failures) {
					// Certified PRE-dispatch failure: no OS close ran, descriptor
					// ownership stays proven, so a later retry is safe.
					closeState = "close_failed_retryable";
					closeError = new SessionStorageWriterRetryableCloseError("injected pre-dispatch close failure");
					throw closeError;
				}
				if (mode.kind === "close_unknown") {
					await inner.close();
					closeState = "close_unknown";
					closeError = new Error("injected dispatched close failure");
					throw closeError;
				}
				await inner.close();
				closeState = "closed";
				owner.successfulCloses++;
				if (mode.kind === "drain_error_after_close") {
					closeError = new Error("injected queued write drain failure");
					throw closeError;
				}
			},
			closeSync() {
				owner.closeAttempts++;
				inner.closeSync();
				closeState = "closed";
				owner.successfulCloses++;
			},
			getError: () => inner.getError(),
			getCloseState: () => closeState,
			getCloseError: () => closeError,
		};
	}
}

async function rejectedOpen(storage: RejectedOpenStorage): Promise<unknown> {
	storage.ensureDirSync(SESSION_DIR);
	storage.writeTextSync(SOURCE_FILE, transcript());
	try {
		await SessionManager.open(
			SOURCE_FILE,
			SessionManager.explicitDestination(SESSION_DIR),
			storage,
			"copy-retain",
			"enabled",
		);
	} catch (error) {
		return error;
	}
	throw new Error("expected the strict resume to be rejected");
}

async function waitFor(predicate: () => boolean, label: string): Promise<void> {
	for (let attempt = 0; attempt < 400; attempt++) {
		if (predicate()) return;
		await Bun.sleep(25);
	}
	throw new Error(`timed out waiting for ${label}`);
}

describe("rejected strict-resume open cleanup", () => {
	it("surfaces the resume error alone when the writer closes cleanly", async () => {
		const storage = new RejectedOpenStorage({ kind: "clean" });
		const error = await rejectedOpen(storage);

		expect(error).toBeInstanceOf(Error);
		expect(error).not.toBeInstanceOf(AggregateError);
		expect((error as Error).message).toContain(WRITE_FAILURE);
		expect(storage.successfulCloses).toBe(1);
	});

	it("treats a confirmed close carrying a drain failure as successful cleanup", async () => {
		// The OS close was dispatched and succeeded; `close()` only rethrew the saved
		// drain error. Reporting that as a cleanup failure would hide the real resume
		// rejection behind an AggregateError claiming the descriptor leaked.
		const storage = new RejectedOpenStorage({ kind: "drain_error_after_close" });
		const error = await rejectedOpen(storage);

		expect(error).not.toBeInstanceOf(AggregateError);
		expect((error as Error).message).toContain(WRITE_FAILURE);
		expect(storage.successfulCloses).toBe(1);
		// Terminal: no background retry keeps hammering an already closed writer.
		await Bun.sleep(200);
		expect(storage.closeAttempts).toBe(1);
	});

	it("reports an AggregateError when the close outcome is quarantined", async () => {
		const storage = new RejectedOpenStorage({ kind: "close_unknown" });
		const error = await rejectedOpen(storage);

		expect(error).toBeInstanceOf(AggregateError);
		const aggregate = error as AggregateError;
		expect(aggregate.message).toContain("cleanup failed");
		expect(aggregate.errors).toHaveLength(2);
		expect((aggregate.errors[0] as Error).message).toContain(WRITE_FAILURE);
		expect((aggregate.errors[1] as Error).message).toContain("injected dispatched close failure");
		// A quarantined descriptor is terminal: never retried, never finalizer-closed.
		await Bun.sleep(200);
		expect(storage.closeAttempts).toBe(1);
	});

	it("retries a certified pre-dispatch close failure inline before giving up", async () => {
		const storage = new RejectedOpenStorage({ kind: "retryable", failures: 1 });
		const error = await rejectedOpen(storage);

		// The immediate second attempt lands, so the caller sees only the resume error.
		expect(error).not.toBeInstanceOf(AggregateError);
		expect((error as Error).message).toContain(WRITE_FAILURE);
		expect(storage.closeAttempts).toBe(2);
		expect(storage.successfulCloses).toBe(1);
	});

	it("retains a persistently retryable writer and releases it once the close lands", async () => {
		const storage = new RejectedOpenStorage({ kind: "retryable", failures: Number.MAX_SAFE_INTEGER });
		const error = await rejectedOpen(storage);

		// Inline cleanup could not finish, so the caller is told the outcome is not
		// clean instead of being handed a silent descriptor leak.
		expect(error).toBeInstanceOf(AggregateError);
		expect((error as AggregateError).message).toContain("cleanup failed");
		expect(storage.closeAttempts).toBe(2);
		expect(storage.successfulCloses).toBe(0);

		// Ownership is retained by a background retry until the descriptor reaches a
		// terminal state; the writer must not be abandoned after the inline attempts.
		await waitFor(() => storage.closeAttempts > 2, "a background cleanup retry");
		storage.settle({ kind: "clean" });
		await waitFor(() => storage.successfulCloses === 1, "the retried close to land");

		const attemptsAtRelease = storage.closeAttempts;
		await Bun.sleep(500);
		// Once terminal, the retry loop stops instead of spinning forever.
		expect(storage.closeAttempts).toBe(attemptsAtRelease);
	});
});

describe("managed strict-resume target races", () => {
	it("rejects a target removed after strict revalidation without recreating it", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-strict-missing-"));
		const cwd = path.join(root, "cwd");
		const agentDir = path.join(root, "agent");
		await fs.mkdir(cwd, { recursive: true });
		const storage = new FileSessionStorage();
		const destination = SessionManager.managedDestination(cwd, agentDir, storage);
		const sourceFile = path.join(destination.directory, "strict-missing.jsonl");
		storage.writeTextSync(sourceFile, transcript());
		let hookCalls = 0;
		SessionManagerTestHooks.beforeStrictMissingCheck = filePath => {
			if (filePath !== sourceFile || hookCalls++ > 0) return;
			storage.unlinkSync(sourceFile);
		};
		try {
			await expect(SessionManager.open(sourceFile, destination, storage, "copy-retain", "enabled")).rejects.toThrow(
				"Could not open session: unstable",
			);
			expect(storage.existsSync(sourceFile)).toBe(false);
			expect(hookCalls).toBe(1);
		} finally {
			SessionManagerTestHooks.beforeStrictMissingCheck = undefined;
			await fs.rm(root, { recursive: true, force: true });
		}
	});

	it("rejects a large bounded target removed before eager fallback without recreating it", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-bounded-missing-"));
		const cwd = path.join(root, "cwd");
		const agentDir = path.join(root, "agent");
		await fs.mkdir(cwd, { recursive: true });
		const storage = new FileSessionStorage();
		const destination = SessionManager.managedDestination(cwd, agentDir, storage);
		const sourceFile = path.join(destination.directory, "bounded-missing.jsonl");
		storage.writeTextSync(sourceFile, transcript());
		let hookCalls = 0;
		SessionManagerTestHooks.eagerHydrationMaxBytesOverride = 1;
		SessionManagerTestHooks.sidecarTailBufferBytesOverride = 1;
		SessionManagerTestHooks.beforeStrictMissingCheck = filePath => {
			if (filePath !== sourceFile || hookCalls++ > 0) return;
			storage.unlinkSync(sourceFile);
		};
		try {
			await expect(SessionManager.open(sourceFile, destination, storage, "copy-retain", "enabled")).rejects.toThrow(
				"Could not open session: unstable",
			);
			expect(storage.existsSync(sourceFile)).toBe(false);
			expect(hookCalls).toBe(1);
		} finally {
			SessionManagerTestHooks.beforeStrictMissingCheck = undefined;
			SessionManagerTestHooks.eagerHydrationMaxBytesOverride = undefined;
			SessionManagerTestHooks.sidecarTailBufferBytesOverride = undefined;
			await fs.rm(root, { recursive: true, force: true });
		}
	});

	it("rejects a large bounded target replaced before final acceptance", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-bounded-replaced-"));
		const cwd = path.join(root, "cwd");
		const agentDir = path.join(root, "agent");
		await fs.mkdir(cwd, { recursive: true });
		const storage = new FileSessionStorage();
		const destination = SessionManager.managedDestination(cwd, agentDir, storage);
		const sourceFile = path.join(destination.directory, "bounded-replaced.jsonl");
		const replacement = transcript().replaceAll("rejected-open", "replacement");
		storage.writeTextSync(sourceFile, transcript());
		SessionManagerTestHooks.eagerHydrationMaxBytesOverride = 1;
		SessionManagerTestHooks.sidecarTailBufferBytesOverride = 1;
		SessionManagerTestHooks.beforeManagedResumeAcceptance = filePath => {
			if (filePath === sourceFile) storage.writeTextSync(sourceFile, replacement);
		};
		try {
			await expect(SessionManager.open(sourceFile, destination, storage, "copy-retain", "enabled")).rejects.toThrow(
				"Could not open session: unstable",
			);
			expect(storage.readTextSync(sourceFile)).toBe(replacement);
		} finally {
			SessionManagerTestHooks.beforeManagedResumeAcceptance = undefined;
			SessionManagerTestHooks.eagerHydrationMaxBytesOverride = undefined;
			SessionManagerTestHooks.sidecarTailBufferBytesOverride = undefined;
			await fs.rm(root, { recursive: true, force: true });
		}
	});

	it("rejects a large bounded target replaced after acceptance without persisting", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-bounded-return-"));
		const cwd = path.join(root, "cwd");
		const agentDir = path.join(root, "agent");
		await fs.mkdir(cwd, { recursive: true });
		const storage = new FileSessionStorage();
		const destination = SessionManager.managedDestination(cwd, agentDir, storage);
		const sourceFile = path.join(destination.directory, "bounded-return.jsonl");
		const replacement = transcript().replaceAll("rejected-open", "replacement");
		storage.writeTextSync(sourceFile, transcript());
		SessionManagerTestHooks.eagerHydrationMaxBytesOverride = 1;
		SessionManagerTestHooks.sidecarTailBufferBytesOverride = 1;
		SessionManagerTestHooks.beforeManagedResumeReturn = filePath => {
			if (filePath === sourceFile) storage.writeTextSync(sourceFile, replacement);
		};
		try {
			await expect(SessionManager.open(sourceFile, destination, storage, "copy-retain", "enabled")).rejects.toThrow(
				"Could not open session: unstable",
			);
			expect(storage.readTextSync(sourceFile)).toBe(replacement);
		} finally {
			SessionManagerTestHooks.beforeManagedResumeReturn = undefined;
			SessionManagerTestHooks.eagerHydrationMaxBytesOverride = undefined;
			SessionManagerTestHooks.sidecarTailBufferBytesOverride = undefined;
			await fs.rm(root, { recursive: true, force: true });
		}
	});

	it("initializes an initially missing managed target with bounded mode enabled", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-bounded-create-"));
		const cwd = path.join(root, "cwd");
		const agentDir = path.join(root, "agent");
		await fs.mkdir(cwd, { recursive: true });
		const storage = new FileSessionStorage();
		const destination = SessionManager.managedDestination(cwd, agentDir, storage);
		const sourceFile = path.join(destination.directory, "new.jsonl");
		let manager: SessionManager | undefined;
		try {
			manager = await SessionManager.open(sourceFile, destination, storage, "copy-retain", "enabled");
			expect(storage.existsSync(sourceFile)).toBe(true);
			expect(manager.getSessionFile()).toBe(sourceFile);
		} finally {
			await manager?.close();
			await fs.rm(root, { recursive: true, force: true });
		}
	});

	it("propagates retained authority stat failures instead of pathname fallback", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-retained-stat-"));
		const cwd = path.join(root, "cwd");
		const agentDir = path.join(root, "agent");
		await fs.mkdir(cwd, { recursive: true });
		const storage = new FileSessionStorage();
		const destination = SessionManager.managedDestination(cwd, agentDir, storage);
		const sourceFile = path.join(destination.directory, "source.jsonl");
		storage.writeTextSync(sourceFile, transcript());
		SessionManagerTestHooks.beforeManagedSourceStat = () => {
			throw new Error("source_changed");
		};
		try {
			await expect(SessionManager.open(sourceFile, destination, storage, "copy-retain", "enabled")).rejects.toThrow(
				"source_changed",
			);
			expect(storage.readTextSync(sourceFile)).toBe(transcript());
		} finally {
			SessionManagerTestHooks.beforeManagedSourceStat = undefined;
			await fs.rm(root, { recursive: true, force: true });
		}
	});

	it("propagates retained root disappearance instead of treating the target as missing", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-retained-root-"));
		const cwd = path.join(root, "cwd");
		const agentDir = path.join(root, "agent");
		await fs.mkdir(cwd, { recursive: true });
		const storage = new FileSessionStorage();
		const destination = SessionManager.managedDestination(cwd, agentDir, storage);
		const sourceFile = path.join(destination.directory, "source.jsonl");
		storage.writeTextSync(sourceFile, transcript());
		SessionManagerTestHooks.beforeManagedSourceStat = async () => {
			await fs.rm(destination.directory, { recursive: true, force: true });
		};
		try {
			await expect(
				SessionManager.open(sourceFile, destination, storage, "copy-retain", "enabled"),
			).rejects.toThrow();
			expect(storage.existsSync(sourceFile)).toBe(false);
		} finally {
			SessionManagerTestHooks.beforeManagedSourceStat = undefined;
			await fs.rm(root, { recursive: true, force: true });
		}
	});

	it("rejects root replacement after missing-target authority acceptance", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-missing-root-race-"));
		const cwd = path.join(root, "cwd");
		const agentDir = path.join(root, "agent");
		await fs.mkdir(cwd, { recursive: true });
		const storage = new FileSessionStorage();
		const destination = SessionManager.managedDestination(cwd, agentDir, storage);
		const sourceFile = path.join(destination.directory, "source.jsonl");
		const replacement = transcript().replaceAll("rejected-open", "replacement");
		SessionManagerTestHooks.beforeManagedMissingInit = async () => {
			await fs.rm(destination.directory, { recursive: true, force: true });
			await fs.mkdir(destination.directory, { recursive: true });
			storage.writeTextSync(sourceFile, replacement);
		};
		try {
			await expect(
				SessionManager.open(sourceFile, destination, storage, "copy-retain", "enabled"),
			).rejects.toThrow();
			expect(storage.readTextSync(sourceFile)).toBe(replacement);
		} finally {
			SessionManagerTestHooks.beforeManagedMissingInit = undefined;
			await fs.rm(root, { recursive: true, force: true });
		}
	});

	it("preserves an occupant installed immediately before missing-target publication", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-missing-publish-"));
		const cwd = path.join(root, "cwd");
		const agentDir = path.join(root, "agent");
		await fs.mkdir(cwd, { recursive: true });
		const storage = new FileSessionStorage();
		const destination = SessionManager.managedDestination(cwd, agentDir, storage);
		const sourceFile = path.join(destination.directory, "source.jsonl");
		const replacement = transcript().replaceAll("rejected-open", "replacement");
		SessionManagerTestHooks.beforeManagedMissingPublish = () => {
			storage.writeTextSync(sourceFile, replacement);
		};
		try {
			await expect(
				SessionManager.open(sourceFile, destination, storage, "copy-retain", "enabled"),
			).rejects.toThrow();
			expect(storage.readTextSync(sourceFile)).toBe(replacement);
		} finally {
			SessionManagerTestHooks.beforeManagedMissingPublish = undefined;
			await fs.rm(root, { recursive: true, force: true });
		}
	});

	it("does not recreate a managed root removed immediately before missing publication", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-missing-publish-root-"));
		const cwd = path.join(root, "cwd");
		const agentDir = path.join(root, "agent");
		await fs.mkdir(cwd, { recursive: true });
		const storage = new FileSessionStorage();
		const destination = SessionManager.managedDestination(cwd, agentDir, storage);
		const sourceFile = path.join(destination.directory, "source.jsonl");
		SessionManagerTestHooks.beforeManagedMissingPublish = async () => {
			await fs.rm(destination.directory, { recursive: true, force: true });
		};
		try {
			await expect(
				SessionManager.open(sourceFile, destination, storage, "copy-retain", "enabled"),
			).rejects.toThrow();
			expect(storage.existsSync(destination.directory)).toBe(false);
			expect(storage.existsSync(sourceFile)).toBe(false);
		} finally {
			SessionManagerTestHooks.beforeManagedMissingPublish = undefined;
			await fs.rm(root, { recursive: true, force: true });
		}
	});

	it("rejects replacement after missing-target publication without mutating the successor", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-missing-return-"));
		const cwd = path.join(root, "cwd");
		const agentDir = path.join(root, "agent");
		await fs.mkdir(cwd, { recursive: true });
		const storage = new FileSessionStorage();
		const destination = SessionManager.managedDestination(cwd, agentDir, storage);
		const sourceFile = path.join(destination.directory, "source.jsonl");
		const replacement = transcript().replaceAll("rejected-open", "replacement");
		SessionManagerTestHooks.beforeManagedMissingReturn = () => {
			storage.writeTextSync(sourceFile, replacement);
		};
		try {
			await expect(SessionManager.open(sourceFile, destination, storage, "copy-retain", "enabled")).rejects.toThrow(
				"Could not open session: unstable",
			);
			expect(storage.readTextSync(sourceFile)).toBe(replacement);
		} finally {
			SessionManagerTestHooks.beforeManagedMissingReturn = undefined;
			await fs.rm(root, { recursive: true, force: true });
		}
	});

	it("does not recreate a managed root removed after the final publication assertion", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-missing-asserted-root-"));
		const cwd = path.join(root, "cwd");
		const agentDir = path.join(root, "agent");
		await fs.mkdir(cwd, { recursive: true });
		const storage = new FileSessionStorage();
		const destination = SessionManager.managedDestination(cwd, agentDir, storage);
		const sourceFile = path.join(destination.directory, "source.jsonl");
		SessionManagerTestHooks.afterManagedMissingAssertion = async () => {
			await fs.rm(destination.directory, { recursive: true, force: true });
		};
		try {
			await expect(
				SessionManager.open(sourceFile, destination, storage, "copy-retain", "enabled"),
			).rejects.toThrow();
			expect(storage.existsSync(destination.directory)).toBe(false);
			expect(storage.existsSync(sourceFile)).toBe(false);
		} finally {
			SessionManagerTestHooks.afterManagedMissingAssertion = undefined;
			await fs.rm(root, { recursive: true, force: true });
		}
	});

	it("does not rewrite a successor installed after managed resume acceptance", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-managed-close-successor-"));
		const cwd = path.join(root, "cwd");
		const agentDir = path.join(root, "agent");
		await fs.mkdir(cwd, { recursive: true });
		const storage = new FileSessionStorage();
		const destination = SessionManager.managedDestination(cwd, agentDir, storage);
		const sourceFile = path.join(destination.directory, "source.jsonl");
		const replacement = transcript().replaceAll("rejected-open", "replacement");
		storage.writeTextSync(sourceFile, transcript());
		const manager = await SessionManager.open(sourceFile, destination, storage, "copy-retain", "enabled");
		storage.writeTextSync(sourceFile, replacement);
		try {
			await expect(manager.close()).rejects.toThrow("managed_replace_identity_mismatch");
			expect(storage.readTextSync(sourceFile)).toBe(replacement);
		} finally {
			await manager.close().catch(() => undefined);
			await fs.rm(root, { recursive: true, force: true });
		}
	});

	it("does not append to a successor installed after managed resume acceptance", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-managed-append-successor-"));
		const cwd = path.join(root, "cwd");
		const agentDir = path.join(root, "agent");
		await fs.mkdir(cwd, { recursive: true });
		const storage = new FileSessionStorage();
		const destination = SessionManager.managedDestination(cwd, agentDir, storage);
		const sourceFile = path.join(destination.directory, "source.jsonl");
		const replacement = transcript().replaceAll("rejected-open", "replacement");
		storage.writeTextSync(sourceFile, transcript());
		const manager = await SessionManager.open(sourceFile, destination, storage, "copy-retain", "enabled");
		storage.writeTextSync(sourceFile, replacement);
		try {
			expect(() => manager.appendMessage({ role: "user", content: "must not persist", timestamp: 1 })).toThrow(
				"managed_replace_identity_mismatch",
			);
			expect(storage.readTextSync(sourceFile)).toBe(replacement);
		} finally {
			await manager.close().catch(() => undefined);
			await fs.rm(root, { recursive: true, force: true });
		}
	});

	it("restores full resident state and identity when managed switch identity fails", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-switch-identity-"));
		const cwd = path.join(root, "cwd");
		const agentDir = path.join(root, "agent");
		await fs.mkdir(cwd, { recursive: true });
		const storage = new FileSessionStorage();
		const destination = SessionManager.managedDestination(cwd, agentDir, storage);
		const sourceFile = path.join(destination.directory, "source.jsonl");
		storage.writeTextSync(sourceFile, transcript());
		let manager: SessionManager | undefined;
		try {
			manager = await SessionManager.open(sourceFile, destination, storage, "copy-retain", "enabled");
			const originalSessionId = manager.getSessionId();
			const originalSessionFile = manager.getSessionFile();
			const targetFile = path.join(destination.directory, "target.jsonl");
			storage.writeTextSync(targetFile, transcript().replaceAll("rejected-open", "target-session"));
			// Inject failure: delete the target file right before identity adoption
			SessionManagerTestHooks.beforeManagedSwitchIdentity = async (filePath: string) => {
				if (filePath === targetFile) {
					storage.unlinkSync(targetFile);
				}
			};
			await expect(manager.setSessionFile(targetFile)).rejects.toThrow();
			// Verify the manager fully restored to the original session
			expect(manager.getSessionId()).toBe(originalSessionId);
			expect(manager.getSessionFile()).toBe(originalSessionFile);
			// Verify the original session content is intact (not cross-session)
			expect(storage.existsSync(sourceFile)).toBe(true);
			expect(storage.readTextSync(sourceFile)).toBe(transcript());
		} finally {
			SessionManagerTestHooks.beforeManagedSwitchIdentity = undefined;
			await manager?.close().catch(() => undefined);
			await fs.rm(root, { recursive: true, force: true });
		}
	});
});
