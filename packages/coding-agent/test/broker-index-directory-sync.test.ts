import { afterEach, describe, expect, it, mock } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { writeBrokerDiscovery } from "../src/sdk/broker/discovery";
import { SDK_STATE_VERSION } from "../src/sdk/broker/state-version";

const realDirectorySync = { ...(await import("../src/utils/directory-sync")) };
const realFs = { ...(await import("node:fs/promises")) };
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
	for (const specifier of ["../src/utils/directory-sync", "../src/sdk/broker/../../utils/directory-sync"])
		mock.module(specifier, () => ({ ...realDirectorySync, syncDirectoryBestEffort: barrier }));
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
	for (const specifier of ["../src/utils/directory-sync", "../src/sdk/broker/../../utils/directory-sync"])
		mock.module(specifier, () => ({ ...realDirectorySync, syncDirectoryBestEffort: barrier }));
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
	mock.module("node:fs/promises", () => ({
		...realFs,
		open: async (...args: Parameters<typeof realFs.open>) => {
			const handle = await realFs.open(...args);
			return new Proxy(handle, {
				get(target, key) {
					if (key === "sync") return async () => {};
					const value = Reflect.get(target, key, target);
					return typeof value === "function" ? value.bind(target) : value;
				},
			});
		},
	}));
	const { SessionIndex } = await import("../src/sdk/broker/session-index");
	const index = new SessionIndex(agentDir);
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
	mock.module("../src/utils/directory-sync", () => realDirectorySync);
	mock.module("../src/sdk/broker/../../utils/directory-sync", () => realDirectorySync);
	mock.restore();
	mock.module("node:fs/promises", () => realFs);
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("broker discovery and session index directory barriers", () => {
	for (const [name, write] of [["discovery", writeDiscovery]] as const) {
		it(`${name} tolerates the four classified Windows directory sync errors`, async () => {
			for (const code of ["EPERM", "EINVAL", "ENOTSUP", "EOPNOTSUPP"] as const) {
				installWindowsBarrier(code);
				await expect(write(tempDir(`gjc-${name.replace(" ", "-")}-${code}-`))).resolves.toBeUndefined();
				mock.module("../src/utils/directory-sync", () => realDirectorySync);
				mock.module("../src/sdk/broker/../../utils/directory-sync", () => realDirectorySync);
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
				mock.module("../src/utils/directory-sync", () => realDirectorySync);
				mock.module("../src/sdk/broker/../../utils/directory-sync", () => realDirectorySync);
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
