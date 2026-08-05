import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { NativeNoReplaceResult } from "@gajae-code/natives";
import * as native from "@gajae-code/natives";
import { logger } from "@gajae-code/utils";
import { YAML } from "bun";
import { migrateJsonToYml } from "../src/config/config-file";

const NOT_COMMITTED = {
	ok: false,
	code: "atomic_rename_unavailable",
	mutationState: "not_committed",
	durabilityState: "not_attempted",
	reason: "atomic_unavailable",
	primitive: "renameat2_noreplace",
	phase: "rename",
	diagnostic: { schemaVersion: 1, collectionState: "unavailable" },
} satisfies NativeNoReplaceResult;

describe("legacy JSON to YAML config migration", () => {
	let directory: string;
	let jsonPath: string;
	let ymlPath: string;
	const sourceValue = { theme: "dark", nested: { enabled: true }, values: [1, 2, 3] };

	beforeEach(() => {
		directory = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-config-migration-"));
		jsonPath = path.join(directory, "config.json");
		ymlPath = path.join(directory, "config.yml");
		fs.writeFileSync(jsonPath, JSON.stringify(sourceValue), { mode: 0o640 });
		fs.chmodSync(jsonPath, 0o640);
	});

	afterEach(() => {
		vi.restoreAllMocks();
		fs.rmSync(directory, { recursive: true, force: true });
	});

	function tempInventory(): string[] {
		return fs.readdirSync(directory).filter(name => name.endsWith(".tmp"));
	}

	it("publishes complete parse-equivalent YAML with the source mode and retains JSON", () => {
		const trace: string[] = [];
		const originalOpen = fs.openSync.bind(fs);
		const originalWrite = fs.writeSync.bind(fs);
		const originalFchmod = fs.fchmodSync.bind(fs);
		const originalFsync = fs.fsyncSync.bind(fs);
		const originalClose = fs.closeSync.bind(fs);
		const originalPublish = native.renameNoReplacePath.bind(native);
		let tempFd: number | undefined;
		let parentFd: number | undefined;

		vi.spyOn(fs, "openSync").mockImplementation(((file, flags, mode) => {
			const fd = originalOpen(file, flags, mode);
			if (typeof file === "string" && file.endsWith(".tmp")) {
				tempFd = fd;
				trace.push("open");
			} else if (file === directory) {
				parentFd = fd;
			}
			return fd;
		}) as typeof fs.openSync);
		vi.spyOn(fs, "writeSync").mockImplementation(((...args: Parameters<typeof fs.writeSync>) => {
			if (args[0] === tempFd) trace.push("write");
			return originalWrite(...args);
		}) as typeof fs.writeSync);
		vi.spyOn(fs, "fchmodSync").mockImplementation(((fd, mode) => {
			if (fd === tempFd) trace.push("chmod");
			return originalFchmod(fd, mode);
		}) as typeof fs.fchmodSync);
		vi.spyOn(fs, "fsyncSync").mockImplementation(((fd: number) => {
			if (fd === parentFd) trace.push("parent fsync");
			else if (fd === tempFd) trace.push("temp fsync");
			return originalFsync(fd);
		}) as typeof fs.fsyncSync);
		vi.spyOn(fs, "closeSync").mockImplementation(((fd: number) => {
			if (fd === parentFd) parentFd = undefined;
			else if (fd === tempFd) {
				trace.push("close");
				tempFd = undefined;
			}
			return originalClose(fd);
		}) as typeof fs.closeSync);
		vi.spyOn(native, "renameNoReplacePath").mockImplementation((source, destination) => {
			trace.push("renameNoReplacePath");
			return originalPublish(source, destination);
		});

		migrateJsonToYml(jsonPath, ymlPath);

		expect(YAML.parse(fs.readFileSync(ymlPath, "utf8"))).toEqual(sourceValue);
		expect(JSON.parse(fs.readFileSync(jsonPath, "utf8"))).toEqual(sourceValue);
		expect(fs.statSync(ymlPath).mode & 0o777).toBe(fs.statSync(jsonPath).mode & 0o777);
		expect(trace).toEqual(["open", "write", "chmod", "temp fsync", "close", "renameNoReplacePath", "parent fsync"]);
		expect(tempInventory()).toEqual([]);
	});
	it("uses the descriptor-observed source mode rather than the pathname snapshot", () => {
		const originalLstat = fs.lstatSync.bind(fs);
		vi.spyOn(fs, "lstatSync").mockImplementation(((file: fs.PathLike) => {
			const stats = originalLstat(file);
			if (file === jsonPath) {
				Object.defineProperty(stats, "mode", {
					value: (stats.mode & ~0o777) | 0o777,
				});
			}
			return stats;
		}) as typeof fs.lstatSync);

		migrateJsonToYml(jsonPath, ymlPath);

		expect(fs.statSync(ymlPath).mode & 0o777).toBe(0o640);
	});

	it("never overwrites an existing YAML file or follows a YAML symlink", () => {
		fs.writeFileSync(ymlPath, "winner: existing\n");
		migrateJsonToYml(jsonPath, ymlPath);
		expect(fs.readFileSync(ymlPath, "utf8")).toBe("winner: existing\n");

		fs.unlinkSync(ymlPath);
		const winnerPath = path.join(directory, "winner.yml");
		fs.writeFileSync(winnerPath, "winner: symlink\n");
		fs.symlinkSync(winnerPath, ymlPath);
		migrateJsonToYml(jsonPath, ymlPath);
		expect(fs.readFileSync(winnerPath, "utf8")).toBe("winner: symlink\n");
		expect(fs.lstatSync(ymlPath).isSymbolicLink()).toBe(true);
		expect(fs.existsSync(jsonPath)).toBe(true);
		expect(tempInventory()).toEqual([]);
	});
	it("refuses a symlinked legacy source without reading or publishing it", () => {
		const actualSource = path.join(directory, "actual.json");
		fs.renameSync(jsonPath, actualSource);
		fs.symlinkSync(actualSource, jsonPath);
		const publish = vi.spyOn(native, "renameNoReplacePath");
		const warning = vi.spyOn(logger, "warn").mockImplementation(() => {});

		migrateJsonToYml(jsonPath, ymlPath);

		expect(fs.existsSync(ymlPath)).toBe(false);
		expect(fs.lstatSync(jsonPath).isSymbolicLink()).toBe(true);
		expect(publish).not.toHaveBeenCalled();
		expect(warning).toHaveBeenCalledTimes(1);
		expect(tempInventory()).toEqual([]);
	});

	it("loses a destination race without fallback, retry, or retained temp files", () => {
		const originalPublish = native.renameNoReplacePath.bind(native);
		const publish = vi.spyOn(native, "renameNoReplacePath").mockImplementation((source, destination) => {
			fs.writeFileSync(destination, "winner: concurrent\n");
			return originalPublish(source, destination);
		});
		const ordinaryRename = vi.spyOn(fs, "renameSync");

		migrateJsonToYml(jsonPath, ymlPath);

		expect(fs.readFileSync(ymlPath, "utf8")).toBe("winner: concurrent\n");
		expect(fs.existsSync(jsonPath)).toBe(true);
		expect(publish).toHaveBeenCalledTimes(1);
		expect(ordinaryRename).not.toHaveBeenCalled();
		expect(tempInventory()).toEqual([]);
	});

	it("cleans certified non-commits but retains malformed publication outcomes", () => {
		const warning = vi.spyOn(logger, "warn").mockImplementation(() => {});
		const publish = vi
			.spyOn(native, "renameNoReplacePath")
			.mockReturnValueOnce(NOT_COMMITTED)
			.mockReturnValueOnce({} as NativeNoReplaceResult);

		migrateJsonToYml(jsonPath, ymlPath);
		expect(fs.existsSync(ymlPath)).toBe(false);
		expect(tempInventory()).toEqual([]);

		migrateJsonToYml(jsonPath, ymlPath);
		expect(fs.existsSync(ymlPath)).toBe(false);
		expect(fs.existsSync(jsonPath)).toBe(true);
		expect(tempInventory()).toHaveLength(1);
		expect(publish).toHaveBeenCalledTimes(2);
		expect(warning).toHaveBeenCalledTimes(2);
	});
	it("retains its identity-bound temp when publication throws and emits sanitized stage/code evidence", () => {
		const error = new Error(`secret=${JSON.stringify(sourceValue)} path=${jsonPath}`) as NodeJS.ErrnoException;
		error.code = "EIO";
		vi.spyOn(native, "renameNoReplacePath").mockImplementation(() => {
			throw error;
		});
		const warning = vi.spyOn(logger, "warn").mockImplementation(() => {});

		migrateJsonToYml(jsonPath, ymlPath);

		expect(fs.existsSync(ymlPath)).toBe(false);
		expect(fs.existsSync(jsonPath)).toBe(true);
		expect(tempInventory()).toHaveLength(1);
		expect(warning).toHaveBeenCalledTimes(1);
		expect(warning.mock.calls[0]?.[1]).toEqual({
			outcomeCode: "migration_failed",
			stage: "publication",
			errorCode: "EIO",
			errorMessage: "Legacy config migration was not proven durable.",
		});
		const logged = JSON.stringify(warning.mock.calls);
		expect(logged).not.toContain(directory);
		expect(logged).not.toContain("dark");
	});
	it("bounds malformed publication diagnostic evidence without deleting the temp", () => {
		const warning = vi.spyOn(logger, "warn").mockImplementation(() => {});
		vi.spyOn(native, "renameNoReplacePath").mockReturnValue({
			phase: "\u001b[31mrename",
			code: "x".repeat(1_000),
		} as NativeNoReplaceResult);

		migrateJsonToYml(jsonPath, ymlPath);

		expect(tempInventory()).toHaveLength(1);
		expect(warning.mock.calls[0]?.[1]).toEqual({
			outcomeCode: "publication_outcome_indeterminate",
			stage: "publication",
			errorCode: "unknown",
			errorMessage: "Legacy config migration was not proven durable.",
		});
		expect(JSON.stringify(warning.mock.calls)).not.toContain("\u001b");
	});
	it("never rolls back a committed publication reported with a failure disposition", () => {
		const originalPublish = native.renameNoReplacePath.bind(native);
		const publish = vi.spyOn(native, "renameNoReplacePath").mockImplementation((source, destination) => ({
			...originalPublish(source, destination),
			ok: false,
			code: "committed_durability_failure",
		}));
		const warning = vi.spyOn(logger, "warn").mockImplementation(() => {});
		const ordinaryRename = vi.spyOn(fs, "renameSync");
		const unlink = vi.spyOn(fs, "unlinkSync");

		migrateJsonToYml(jsonPath, ymlPath);

		expect(YAML.parse(fs.readFileSync(ymlPath, "utf8"))).toEqual(sourceValue);
		expect(fs.existsSync(jsonPath)).toBe(true);
		expect(publish).toHaveBeenCalledTimes(1);
		expect(ordinaryRename).not.toHaveBeenCalled();
		expect(unlink).not.toHaveBeenCalled();
		expect(warning).toHaveBeenCalledTimes(1);
		expect(tempInventory()).toEqual([]);
	});

	it("preserves a committed publication when parent fsync fails and emits one bounded warning", () => {
		const originalFsync = fs.fsyncSync.bind(fs);
		const publish = vi.spyOn(native, "renameNoReplacePath");
		const warning = vi.spyOn(logger, "warn").mockImplementation(() => {});
		let parentFsyncCalls = 0;
		vi.spyOn(fs, "fsyncSync").mockImplementation(((fd: number) => {
			if (fs.fstatSync(fd).isDirectory()) {
				parentFsyncCalls++;
				const error = new Error(
					`do not expose ${directory} or ${JSON.stringify(sourceValue)}`,
				) as NodeJS.ErrnoException;
				error.code = "EIO";
				throw error;
			}
			return originalFsync(fd);
		}) as typeof fs.fsyncSync);

		migrateJsonToYml(jsonPath, ymlPath);

		expect(YAML.parse(fs.readFileSync(ymlPath, "utf8"))).toEqual(sourceValue);
		expect(fs.existsSync(jsonPath)).toBe(true);
		expect(parentFsyncCalls).toBe(1);
		expect(publish).toHaveBeenCalledTimes(1);
		expect(warning).toHaveBeenCalledTimes(1);
		const logged = JSON.stringify(warning.mock.calls);
		expect(logged).toContain("published_parent_sync_failed");
		expect(logged).not.toContain(directory);
		expect(logged).not.toContain("dark");
		expect(tempInventory()).toEqual([]);
	});
	it("preserves a committed publication when parent fsync is unsupported", () => {
		const originalFsync = fs.fsyncSync.bind(fs);
		const warning = vi.spyOn(logger, "warn").mockImplementation(() => {});
		let parentFsyncCalls = 0;
		vi.spyOn(fs, "fsyncSync").mockImplementation(((fd: number) => {
			if (fs.fstatSync(fd).isDirectory()) {
				parentFsyncCalls++;
				const error = new Error("directory fsync unsupported") as NodeJS.ErrnoException;
				error.code = "EINVAL";
				throw error;
			}
			return originalFsync(fd);
		}) as typeof fs.fsyncSync);

		migrateJsonToYml(jsonPath, ymlPath);

		expect(YAML.parse(fs.readFileSync(ymlPath, "utf8"))).toEqual(sourceValue);
		expect(fs.existsSync(jsonPath)).toBe(true);
		expect(parentFsyncCalls).toBe(1);
		expect(warning).toHaveBeenCalledTimes(1);
		expect(tempInventory()).toEqual([]);
	});

	it("cleans only its certified temp after a pre-publication write failure", () => {
		const warning = vi.spyOn(logger, "warn").mockImplementation(() => {});
		const publish = vi.spyOn(native, "renameNoReplacePath");
		vi.spyOn(fs, "writeSync").mockImplementation((() => {
			throw new Error(`secret=${JSON.stringify(sourceValue)} path=${jsonPath}`);
		}) as typeof fs.writeSync);

		migrateJsonToYml(jsonPath, ymlPath);

		expect(fs.existsSync(ymlPath)).toBe(false);
		expect(fs.existsSync(jsonPath)).toBe(true);
		expect(tempInventory()).toEqual([]);
		expect(publish).not.toHaveBeenCalled();
		expect(warning).toHaveBeenCalledTimes(1);
		const logged = JSON.stringify(warning.mock.calls);
		expect(logged).not.toContain(jsonPath);
		expect(logged).not.toContain("dark");
	});
});
