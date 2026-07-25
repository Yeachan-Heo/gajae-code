import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";

const MANAGED_OWNER_CHILD_TOKEN_ENV = "GJC_MANAGED_OWNER_CHILD_TOKEN";
const MANAGED_OWNER_GENERATION_ENV = "GJC_TMUX_OWNER_GENERATION";
const MANAGED_OWNER_INCARNATION_ENV = "GJC_MANAGED_OWNER_INCARNATION";
const MANAGED_OWNER_RUN_ID_ENV = "GJC_MANAGED_OWNER_RUN_ID";
const MANAGED_OWNER_SESSION_ID_ENV = "GJC_COORDINATOR_SESSION_ID";
const MANAGED_OWNER_STATE_DIR_ENV = "GJC_TMUX_OWNER_STATE_DIR";

const directorySyncModule = require.resolve("../src/utils/directory-sync");
const realDirectorySync = { ...(await import("../src/utils/directory-sync")) };
const tempDirs: string[] = [];
const managedEnvironment = [
	MANAGED_OWNER_CHILD_TOKEN_ENV,
	MANAGED_OWNER_GENERATION_ENV,
	MANAGED_OWNER_INCARNATION_ENV,
	MANAGED_OWNER_RUN_ID_ENV,
	MANAGED_OWNER_SESSION_ID_ENV,
	MANAGED_OWNER_STATE_DIR_ENV,
	"GJC_MANAGED_OWNER_COMMAND_JSON",
] as const;
const originalEnvironment = new Map(managedEnvironment.map(key => [key, process.env[key]]));

function tempDir(prefix: string): string {
	const directory = mkdtempSync(path.join(tmpdir(), prefix));
	tempDirs.push(directory);
	return directory;
}

function errnoError(code: string): NodeJS.ErrnoException {
	const error = new Error(`${code}: injected`) as NodeJS.ErrnoException;
	error.code = code;
	return error;
}

function installBarrier(code?: string): () => number {
	let calls = 0;
	mock.module(directorySyncModule, () => ({
		...realDirectorySync,
		syncDirectoryBestEffort: async () => {
			calls += 1;
			if (code) throw errnoError(code);
		},
	}));
	return () => calls;
}

function setManagedEnvironment(stateDir: string): void {
	process.env[MANAGED_OWNER_STATE_DIR_ENV] = stateDir;
	process.env[MANAGED_OWNER_SESSION_ID_ENV] = "session";
	process.env[MANAGED_OWNER_GENERATION_ENV] = "generation";
	process.env[MANAGED_OWNER_RUN_ID_ENV] = "run";
	process.env[MANAGED_OWNER_INCARNATION_ENV] = "incarnation";
	process.env[MANAGED_OWNER_CHILD_TOKEN_ENV] = "child";
	process.env.GJC_MANAGED_OWNER_COMMAND_JSON = JSON.stringify(["child"]);
}

const originalSigtermListeners = process.listeners("SIGTERM");
let originalExitCode: typeof process.exitCode;

beforeEach(() => {
	originalExitCode = process.exitCode;
});

afterEach(() => {
	mock.module(directorySyncModule, () => realDirectorySync);
	mock.restore();
	process.removeAllListeners("SIGTERM");
	for (const listener of originalSigtermListeners) process.on("SIGTERM", listener);
	process.exitCode = originalExitCode ?? 0;
	for (const [key, value] of originalEnvironment) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
	for (const directory of tempDirs.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("runtime directory barriers", () => {
	it("managed-owner-admission routes its durable handoff through the shared barrier", async () => {
		const calls = installBarrier();
		setManagedEnvironment(tempDir("gjc-admission-sync-"));
		const { admitManagedOwnerBeforeCli } = await import("../src/gjc-runtime/managed-owner-admission");
		await expect(admitManagedOwnerBeforeCli()).resolves.toEqual({ kind: "blocked" });
		expect(calls()).toBe(1);
	});

	it("managed-owner-admission fails closed when durable handoff cannot sync", async () => {
		installBarrier("EACCES");
		setManagedEnvironment(tempDir("gjc-admission-sync-"));
		const { admitManagedOwnerBeforeCli } = await import("../src/gjc-runtime/managed-owner-admission");
		await expect(admitManagedOwnerBeforeCli()).rejects.toMatchObject({ code: "EACCES" });
	});

	it("managed-owner-supervisor routes its exclusive write through the shared barrier", async () => {
		const calls = installBarrier();
		spyOn(Bun, "spawn").mockReturnValue({
			exited: Promise.resolve(0),
			pid: process.pid,
			signalCode: null,
		} as never);
		setManagedEnvironment(tempDir("gjc-supervisor-sync-"));
		const { runManagedOwnerSupervisor } = await import("../src/gjc-runtime/managed-owner-supervisor");
		await runManagedOwnerSupervisor(async () => "start").catch(() => {});
		expect(calls()).toBe(1);
	});

	it("managed-owner-supervisor propagates EACCES after its exclusive write", async () => {
		installBarrier("EACCES");
		setManagedEnvironment(tempDir("gjc-supervisor-sync-"));
		const { runManagedOwnerSupervisor } = await import("../src/gjc-runtime/managed-owner-supervisor");
		await expect(runManagedOwnerSupervisor(async () => "start")).rejects.toMatchObject({ code: "EACCES" });
	});

	it("tmux-owner-isolation routes atomicWrite through the shared barrier", async () => {
		const calls = installBarrier();
		const { replaceOwnerGeneration } = await import("../src/gjc-runtime/tmux-owner-isolation");
		await expect(replaceOwnerGeneration(tempDir("gjc-isolation-sync-"), "session", "generation")).resolves.toBe(
			"generation",
		);
		expect(calls()).toBe(2);
	});

	it("tmux-owner-isolation propagates EACCES from atomicWrite", async () => {
		installBarrier("EACCES");
		const { replaceOwnerGeneration } = await import("../src/gjc-runtime/tmux-owner-isolation");
		await expect(
			replaceOwnerGeneration(tempDir("gjc-isolation-sync-"), "session", "generation"),
		).rejects.toMatchObject({ code: "EACCES" });
	});
});
