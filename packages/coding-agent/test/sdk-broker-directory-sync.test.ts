import { afterEach, describe, expect, it, mock } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { writeSessionLifecycleFailure } from "../src/sdk/broker/lifecycle";
import { LifecycleLedger } from "../src/sdk/broker/lifecycle-ledger";

// Plain snapshot BEFORE any module mock: Bun patches the live namespace, so
// restoring with the namespace object itself would restore the mock.
const realDirectorySync = { ...(await import("../src/utils/directory-sync")) };

function installBarrierMock(impl: (directory: string) => Promise<void>): string[] {
	const calls: string[] = [];
	mock.module("../src/utils/directory-sync", () => ({
		...realDirectorySync,
		syncDirectoryBestEffort: (directory: string) => {
			calls.push(directory);
			return impl(directory);
		},
	}));
	return calls;
}

function errnoError(code: string): NodeJS.ErrnoException {
	const error = new Error(`${code}: injected`) as NodeJS.ErrnoException;
	error.code = code;
	return error;
}

const tempDirs: string[] = [];

function tempDir(prefix: string): string {
	const dir = mkdtempSync(path.join(tmpdir(), prefix));
	tempDirs.push(dir);
	return dir;
}

afterEach(() => {
	mock.module("../src/utils/directory-sync", () => realDirectorySync);
	mock.restore();
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("LifecycleLedger compaction directory barrier", () => {
	async function compactOnce(agentDir: string): Promise<void> {
		const ledger = await new LifecycleLedger(agentDir, { maxRows: 2 }).open();
		await ledger.begin("identity-1", "request-1");
		await ledger.transition("identity-1", "effect_started", {});
		// The third row exceeds maxRows and forces #compact, whose atomic rewrite
		// publishes through the shared directory barrier.
		await ledger.transition("identity-1", "terminal_ok", { response: { ok: true, result: {} } });
	}

	it("publishes the compacted ledger through the shared directory barrier", async () => {
		const calls = installBarrierMock(async () => {});
		const agentDir = tempDir("gjc-ledger-sync-");
		await compactOnce(agentDir);
		expect(calls).toEqual([path.join(agentDir, "sdk")]);
	});

	it("fails the compaction when the directory barrier reports an unclassified failure", async () => {
		installBarrierMock(async () => {
			throw errnoError("EACCES");
		});
		const agentDir = tempDir("gjc-ledger-sync-fail-");
		await expect(compactOnce(agentDir)).rejects.toMatchObject({ code: "EACCES" });
	});

	it("completes the compaction when the real barrier tolerates a classified Windows sync failure", async () => {
		// Route the consumer through the REAL barrier implementation while the
		// injected directory handle raises the genuine Windows EPERM.
		mock.module("../src/utils/directory-sync", () => ({
			...realDirectorySync,
			syncDirectoryBestEffort: (directory: string) =>
				realDirectorySync.syncDirectoryBestEffort(directory, {
					platform: "win32",
					open: async () => ({
						sync: async () => {
							throw errnoError("EPERM");
						},
						close: async () => {},
					}),
				}),
		}));
		const agentDir = tempDir("gjc-ledger-sync-tolerated-");
		await expect(compactOnce(agentDir)).resolves.toBeUndefined();
	});
});

describe("writeSessionLifecycleFailure directory barrier", () => {
	const failure = { phase: "startup", reason: "failed", message: "startup exploded" } as const;
	const rollback = {
		endpointGeneration: null,
		fenced: true,
		runtimeRemoved: true,
		hostStopped: true,
		brokerRegistrationReleased: true,
	};

	it("publishes the failure artifact and then syncs the metadata directory", async () => {
		const calls = installBarrierMock(async () => {});
		const root = tempDir("gjc-lifecycle-failure-sync-");
		await writeSessionLifecycleFailure(root, "session-1", "marker-1", failure, rollback, undefined, "incarnation-1");
		const artifacts = await fs.readdir(path.join(root, "sdk"));
		expect(artifacts.some(name => name.includes("session-1.lifecycle.failure.marker-1"))).toBe(true);
		expect(calls).toEqual([path.join(root, "sdk")]);
	});

	it("propagates an unclassified directory-barrier failure after publication", async () => {
		installBarrierMock(async () => {
			throw errnoError("EACCES");
		});
		const root = tempDir("gjc-lifecycle-failure-sync-fail-");
		await expect(
			writeSessionLifecycleFailure(root, "session-1", "marker-1", failure, rollback, undefined, "incarnation-1"),
		).rejects.toMatchObject({ code: "EACCES" });
	});
});
