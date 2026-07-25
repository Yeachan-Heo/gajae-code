import { afterEach, describe, expect, it, mock, spyOn } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";

const MANAGED_OWNER_CHILD_TOKEN_ENV = "GJC_MANAGED_OWNER_CHILD_TOKEN";
const MANAGED_OWNER_GENERATION_ENV = "GJC_TMUX_OWNER_GENERATION";
const MANAGED_OWNER_INCARNATION_ENV = "GJC_MANAGED_OWNER_INCARNATION";
const MANAGED_OWNER_RUN_ID_ENV = "GJC_MANAGED_OWNER_RUN_ID";
const MANAGED_OWNER_SESSION_ID_ENV = "GJC_COORDINATOR_SESSION_ID";
const MANAGED_OWNER_STATE_DIR_ENV = "GJC_TMUX_OWNER_STATE_DIR";

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

function installBarrier(code: string, throwOnCall = 1): void {
	let calls = 0;
	mock.module("../src/utils/directory-sync", () => ({
		...realDirectorySync,
		syncDirectoryBestEffort: async (directory: string) => {
			calls += 1;
			if (calls !== throwOnCall) return;
			await realDirectorySync.syncDirectoryBestEffort(directory, {
				platform: "win32",
				open: async () => ({
					sync: async () => {
						throw errnoError(code);
					},
					close: async () => {},
				}),
			});
		},
	}));
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

afterEach(() => {
	mock.module("../src/utils/directory-sync", () => realDirectorySync);
	mock.restore();
	for (const [key, value] of originalEnvironment) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
	for (const directory of tempDirs.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("runtime directory barriers", () => {
	it("managed-owner-admission tolerates classified Windows errors during durable handoff", async () => {
		installBarrier("EPERM");
		setManagedEnvironment(tempDir("gjc-admission-sync-"));
		const { admitManagedOwnerBeforeCli } = await import("../src/gjc-runtime/managed-owner-admission");
		await expect(admitManagedOwnerBeforeCli()).resolves.toEqual({ kind: "blocked" });
	});

	it("managed-owner-admission fails closed when durable handoff cannot sync", async () => {
		installBarrier("EACCES");
		setManagedEnvironment(tempDir("gjc-admission-sync-"));
		const { admitManagedOwnerBeforeCli } = await import("../src/gjc-runtime/managed-owner-admission");
		await expect(admitManagedOwnerBeforeCli()).rejects.toMatchObject({ code: "EACCES" });
	});

	it("managed-owner-supervisor tolerates classified Windows errors after its exclusive write", async () => {
		installBarrier("EPERM");
		mock.module("../src/gjc-runtime/linux-proc", () => ({ readLinuxProcStartTime: async () => "start" }));
		mock.module("@gajae-code/natives", () => ({ Process: { fromPid: () => ({ incarnation: "windows:start" }) } }));
		spyOn(Bun, "spawn").mockReturnValue({ exited: Promise.resolve(0), pid: 123, signalCode: null } as never);
		setManagedEnvironment(tempDir("gjc-supervisor-sync-"));
		const { runManagedOwnerSupervisor } = await import("../src/gjc-runtime/managed-owner-supervisor");
		await expect(runManagedOwnerSupervisor()).resolves.toBeUndefined();
	});

	it("managed-owner-supervisor propagates EACCES after its exclusive write", async () => {
		installBarrier("EACCES");
		setManagedEnvironment(tempDir("gjc-supervisor-sync-"));
		const { runManagedOwnerSupervisor } = await import("../src/gjc-runtime/managed-owner-supervisor");
		await expect(runManagedOwnerSupervisor()).rejects.toMatchObject({ code: "EACCES" });
	});

	it("tmux-owner-isolation tolerates classified Windows errors in atomicWrite", async () => {
		installBarrier("EPERM");
		const { replaceOwnerGeneration } = await import("../src/gjc-runtime/tmux-owner-isolation");
		await expect(replaceOwnerGeneration(tempDir("gjc-isolation-sync-"), "session", "generation")).resolves.toBe(
			"generation",
		);
	});

	it("tmux-owner-isolation propagates EACCES from atomicWrite", async () => {
		installBarrier("EACCES", 2);
		const { replaceOwnerGeneration } = await import("../src/gjc-runtime/tmux-owner-isolation");
		await expect(
			replaceOwnerGeneration(tempDir("gjc-isolation-sync-"), "session", "generation"),
		).rejects.toMatchObject({ code: "EACCES" });
	});
});
