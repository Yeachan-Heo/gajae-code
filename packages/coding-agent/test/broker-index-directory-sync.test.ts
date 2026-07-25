import { afterEach, describe, expect, it, mock } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { writeBrokerDiscovery } from "../src/sdk/broker/discovery";
import { SDK_STATE_VERSION } from "../src/sdk/broker/state-version";

const directorySyncModule = require.resolve("../src/utils/directory-sync");
const realDirectorySync = { ...(await import("../src/utils/directory-sync")) };
const tempDirs: string[] = [];

function tempDir(prefix: string): string {
	const dir = mkdtempSync(path.join(tmpdir(), prefix));
	tempDirs.push(dir);
	return dir;
}

function errnoError(code: string): NodeJS.ErrnoException {
	const error = new Error(`${code}: injected`) as NodeJS.ErrnoException;
	error.code = code;
	return error;
}

function installWindowsBarrier(code: string): void {
	const barrier = (directory: string) =>
		realDirectorySync.syncDirectoryBestEffort(directory, {
			platform: "win32",
			open: async () => ({
				sync: async () => {
					throw errnoError(code);
				},
				close: async () => {},
			}),
		});
	mock.module(directorySyncModule, () => ({ ...realDirectorySync, syncDirectoryBestEffort: barrier }));
}

function installPosixBarrier(code: string): void {
	const barrier = (directory: string) =>
		realDirectorySync.syncDirectoryBestEffort(directory, {
			platform: "linux",
			open: async () => ({
				sync: async () => {
					throw errnoError(code);
				},
				close: async () => {},
			}),
		});
	mock.module(directorySyncModule, () => ({ ...realDirectorySync, syncDirectoryBestEffort: barrier }));
}

async function writeDiscovery(agentDir: string): Promise<void> {
	await writeBrokerDiscovery(agentDir, {
		version: SDK_STATE_VERSION,
		protocolVersion: 3,
		packageGeneration: "generation-1",
		ownerId: "owner-1",
		pid: process.pid,
		incarnation: "incarnation-1",
		host: "127.0.0.1",
		port: 1234,
		url: "http://127.0.0.1:1234",
		token: "token",
		startedAt: 1_700_000_000_000,
		heartbeatAt: 1_700_000_000_001,
	});
}
async function snapshotSessionIndex(agentDir: string): Promise<void> {
	const { SessionIndex } = await import("../src/sdk/broker/session-index");
	const index = new SessionIndex(agentDir, async () => {});
	await index.append({
		type: "host_registered",
		sessionId: "session-1",
		locator: { repo: "C:/repo", stateRoot: "C:/state" },
		endpointGeneration: 1,
		pid: process.pid,
	});
	await index.snapshot();
}

afterEach(() => {
	mock.module(directorySyncModule, () => realDirectorySync);
	mock.restore();
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("broker discovery and session index directory barriers", () => {
	for (const [name, write] of [["discovery", writeDiscovery]] as const) {
		it(`${name} tolerates the four classified Windows directory sync errors`, async () => {
			for (const code of ["EPERM", "EINVAL", "ENOTSUP", "EOPNOTSUPP"] as const) {
				installWindowsBarrier(code);
				await expect(write(tempDir(`gjc-${name.replace(" ", "-")}-${code}-`))).resolves.toBeUndefined();
				mock.module(directorySyncModule, () => realDirectorySync);
			}
		});

		it(`${name} fails closed for EACCES on Windows`, async () => {
			installWindowsBarrier("EACCES");
			await expect(write(tempDir(`gjc-${name.replace(" ", "-")}-eacces-`))).rejects.toMatchObject({
				code: "EACCES",
			});
		});

		it(`${name} propagates directory errors on POSIX`, async () => {
			installPosixBarrier("EPERM");
			await expect(write(tempDir(`gjc-${name.replace(" ", "-")}-posix-`))).rejects.toMatchObject({ code: "EPERM" });
		});
	}

	for (const [name, write] of [["session index", snapshotSessionIndex]] as const) {
		it(`${name} tolerates the four classified Windows directory sync errors`, async () => {
			for (const code of ["EPERM", "EINVAL", "ENOTSUP", "EOPNOTSUPP"] as const) {
				installWindowsBarrier(code);
				await expect(write(tempDir(`gjc-${name.replace(" ", "-")}-${code}-`))).resolves.toBeUndefined();
				mock.module(directorySyncModule, () => realDirectorySync);
			}
		});

		it(`${name} fails closed for EACCES on Windows`, async () => {
			installWindowsBarrier("EACCES");
			await expect(write(tempDir(`gjc-${name.replace(" ", "-")}-eacces-`))).rejects.toMatchObject({
				code: "EACCES",
			});
		});
	}
});
