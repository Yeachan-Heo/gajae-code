import { afterEach, describe, expect, it, spyOn } from "bun:test";
import type { BigIntStats, PathLike } from "node:fs";
import * as fsSync from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { exactUnlinkDirect } from "@gajae-code/natives";
import { writeCoordinatorAtomic } from "../src/coordinator-mcp/durability";
import {
	COORDINATOR_JSON_SCAN_CAP,
	listCoordinatorJsonFiles,
	listCoordinatorJsonFilesWithRetry,
	type ProjectionScanDirectory,
	ProjectionScanTestHooks,
} from "../src/coordinator-mcp/projection-scan";
import { collectEmptyDeleteReceipts, runEmptyDeleteGc } from "../src/gjc-runtime/empty-delete-gc";
import { runGjcGcCommand } from "../src/gjc-runtime/gc-runtime";
import {
	reclaimStaleSessionStateLock,
	removeVerifiedEmptyQuarantine,
	SessionStateLockTestHooks,
	SessionStateLockUnavailableError,
	setSessionStateLockNativeBindings,
} from "../src/gjc-runtime/session-state-lock";
import {
	GJC_COORDINATOR_SESSION_STATE_FILE_ENV,
	persistCoordinatorRuntimeStateFromEvent,
} from "../src/gjc-runtime/session-state-sidecar";
import { exactIdentityNativeBindings, installExactIdentityNatives } from "./helpers/exact-identity-natives";

const tempDirs: string[] = [];
const ORIGINAL_STATE_FILE = process.env[GJC_COORDINATOR_SESSION_STATE_FILE_ENV];
const ORIGINAL_OWNER_HOST_ID = SessionStateLockTestHooks.ownerHostId;
const ORIGINAL_UNQUALIFIED_OWNER_IS_LOCAL = SessionStateLockTestHooks.unqualifiedOwnerIsLocal;
installExactIdentityNatives();

afterEach(async () => {
	if (ORIGINAL_STATE_FILE === undefined) delete process.env[GJC_COORDINATOR_SESSION_STATE_FILE_ENV];
	else process.env[GJC_COORDINATOR_SESSION_STATE_FILE_ENV] = ORIGINAL_STATE_FILE;
	ProjectionScanTestHooks.platform = undefined;
	SessionStateLockTestHooks.ownerHostId = ORIGINAL_OWNER_HOST_ID;
	SessionStateLockTestHooks.unqualifiedOwnerIsLocal = ORIGINAL_UNQUALIFIED_OWNER_IS_LOCAL;
	SessionStateLockTestHooks.quarantineMints = undefined;
	SessionStateLockTestHooks.lastQuarantineName = undefined;
	SessionStateLockTestHooks.forcedQuarantineName = undefined;
	SessionStateLockTestHooks.probeProcessSignal = undefined;
	setSessionStateLockNativeBindings(undefined);
	installExactIdentityNatives();
	await Promise.all(tempDirs.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true })));
});

async function tempRoot(prefix: string): Promise<string> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
	tempDirs.push(dir);
	return dir;
}

describe("empty .gjc-delete-* latch", () => {
	it("Test 1: planted 0-byte .gjc-delete-* is never opened or parsed", async () => {
		const dir = await tempRoot("gjc-scan-");
		const live = path.join(dir, "live.json");
		const debris = path.join(dir, ".gjc-delete-session-state-lock-aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa.json");
		await fs.writeFile(live, JSON.stringify({ session_id: "live", state: "ready_for_input" }));
		await fs.writeFile(debris, "");
		const opened: string[] = [];
		const io = {
			readdir: (target: string) => fs.readdir(target),
			lstat: (file: string) => fs.lstat(file),
			readFile: async (file: string, encoding: "utf8") => {
				opened.push(file);
				return fs.readFile(file, encoding);
			},
		};
		const scan = await listCoordinatorJsonFiles(dir, io);
		expect(scan.values).toHaveLength(1);
		expect((scan.values[0] as { session_id: string }).session_id).toBe("live");
		expect(opened.every(file => !file.includes(".gjc-delete-"))).toBe(true);
		expect(scan.skippedDebris).toBeGreaterThan(0);
	});

	it("Test 1 race: a candidate that becomes unsafe is reported incomplete without reading it", async () => {
		const dir = await tempRoot("gjc-scan-race-");
		const candidate = path.join(dir, "candidate.json");
		await fs.writeFile(candidate, JSON.stringify({ session_id: "candidate" }));
		const scan = await listCoordinatorJsonFiles(dir, {
			readdir: target => fs.readdir(target),
			lstat: file => fs.lstat(file),
			readFile: (file, encoding) => fs.readFile(file, encoding),
			readFileSafe: async () => {
				const error = new Error("candidate became a symlink") as NodeJS.ErrnoException;
				error.code = "ELOOP";
				throw error;
			},
		});
		expect(scan.values).toEqual([]);
		expect(scan.raced).toBe(1);
		expect(scan.incomplete).toBe(true);
		expect(scan.capped).toBe(true);
	});

	it("Test 1 recovery: six concurrent projection writers settle within bounded retries", async () => {
		const dir = await tempRoot("gjc-scan-retry-");
		for (let index = 0; index < 6; index++)
			await fs.writeFile(
				path.join(dir, `session-${index}.json`),
				JSON.stringify({ session_id: `session-${index}` }),
			);
		let attempts = 0;
		const scan = await listCoordinatorJsonFilesWithRetry(
			dir,
			{
				readdir: async target => fs.readdir(target),
				lstat: async file => {
					if (path.basename(file) === "session-0.json" && attempts < 2) {
						attempts += 1;
						const error = new Error("concurrent writer replaced candidate") as NodeJS.ErrnoException;
						error.code = "ELOOP";
						throw error;
					}
					return fs.lstat(file);
				},
				readFile: (file, encoding) => fs.readFile(file, encoding),
			},
			10,
			3,
		);
		expect(attempts).toBe(2);
		expect(scan.values).toHaveLength(6);
		expect(scan.incomplete).toBe(false);
		expect(scan.raced).toBe(0);
	});

	it("Test 1 recovery: owner disappearance never becomes an authoritative empty result", async () => {
		const stat = {
			size: 0,
			dev: 1n,
			ino: 2n,
			isDirectory: () => true,
			isFile: () => false,
			isSymbolicLink: () => false,
		};
		const error = new Error("owner disappeared") as NodeJS.ErrnoException;
		error.code = "ENOENT";
		let opens = 0;
		const scan = await listCoordinatorJsonFilesWithRetry(
			"/owner-disappeared",
			{
				readdir: async () => [],
				lstat: async () => stat,
				readFile: async () => "{}",
				openDirectory: async () => {
					opens += 1;
					return {
						stat,
						readdir: async () => {
							throw error;
						},
						lstat: async () => stat,
						readFile: async () => "{}",
						close: async () => {},
					};
				},
			},
			COORDINATOR_JSON_SCAN_CAP,
			3,
		);
		expect(opens).toBe(3);
		expect(scan.values).toEqual([]);
		expect(scan.incomplete).toBe(true);
		expect(scan.raced).toBe(1);
	});

	it.skipIf(process.platform !== "linux")(
		"Test 1 race: a post-enumeration symlink candidate is raced, not skipped",
		async () => {
			const dir = await tempRoot("gjc-scan-candidate-reparse-race-");
			const candidate = path.join(dir, "candidate.json");
			const target = path.join(dir, "candidate-target.txt");
			await fs.writeFile(candidate, JSON.stringify({ session_id: "source" }));
			await fs.writeFile(target, JSON.stringify({ session_id: "target" }));
			const realReaddir = fs.readdir;
			const readdirSpy = spyOn(fs, "readdir");
			let replaced = false;
			readdirSpy.mockImplementation((async (directory: PathLike) => {
				const entries = await realReaddir(directory);
				if (!replaced && String(directory).startsWith("/proc/self/fd/")) {
					replaced = true;
					await fs.unlink(candidate);
					await fs.symlink(target, candidate);
				}
				return entries;
			}) as unknown as typeof fs.readdir);
			try {
				const scan = await listCoordinatorJsonFiles(dir);
				expect(replaced).toBe(true);
				expect(scan.values).toEqual([]);
				expect(scan.parsed).toBe(0);
				expect(scan.raced).toBe(1);
				expect(scan.skippedEmpty).toBe(0);
				expect(scan.incomplete).toBe(true);
				expect(scan.capped).toBe(true);
			} finally {
				readdirSpy.mockRestore();
			}
		},
	);

	it.skipIf(process.platform !== "linux")(
		"Test 1 race: a valid replacement after enumeration is not parsed as the candidate",
		async () => {
			const dir = await tempRoot("gjc-scan-candidate-race-");
			const candidate = path.join(dir, "candidate.json");
			const replacement = path.join(dir, "candidate-replacement.tmp");
			await fs.writeFile(candidate, JSON.stringify({ session_id: "source" }));
			await fs.writeFile(replacement, JSON.stringify({ session_id: "target" }));
			const realLstat = fs.lstat as unknown as (file: PathLike, options?: unknown) => Promise<BigIntStats>;
			let replaced = false;
			const lstatSpy = spyOn(fs, "lstat");
			lstatSpy.mockImplementation((async (file: PathLike, options: unknown) => {
				const stat = await realLstat(file, options);
				if (
					!replaced &&
					String(file).startsWith("/proc/self/fd/") &&
					path.basename(String(file)) === "candidate.json"
				) {
					replaced = true;
					await fs.rename(replacement, candidate);
				}
				return stat;
			}) as unknown as typeof fs.lstat);
			try {
				const scan = await listCoordinatorJsonFiles(dir);
				expect(replaced).toBe(true);
				expect(scan.values).toEqual([]);
				expect(scan.parsed).toBe(0);
				expect(scan.raced).toBe(1);
				expect(scan.incomplete).toBe(true);
				expect(scan.capped).toBe(true);
			} finally {
				lstatSpy.mockRestore();
			}
		},
	);

	it("Test 1 root race: replacement enumeration is incomplete without a foreign record", async () => {
		const dir = await tempRoot("gjc-scan-root-race-");
		const replacement = `${dir}-replacement`;
		tempDirs.push(replacement);
		await fs.writeFile(path.join(dir, "original.json"), JSON.stringify({ session_id: "original" }));
		const scan = await listCoordinatorJsonFiles(dir, {
			readdir: async target => {
				await fs.rename(target, replacement);
				await fs.mkdir(target);
				await fs.writeFile(path.join(target, "foreign.json"), JSON.stringify({ session_id: "foreign" }));
				return ["foreign.json"];
			},
			lstat: file => fs.lstat(file),
			readFile: (file, encoding) => fs.readFile(file, encoding),
		});
		expect(scan.values).toEqual([]);
		expect(scan.incomplete).toBe(true);
		expect(scan.capped).toBe(true);
		expect(scan.raced).toBe(1);
	});

	it("Test 1 root ABA: pinned authority survives post-enumeration swap and restore", async () => {
		const dir = await tempRoot("gjc-scan-root-aba-");
		const replacement = `${dir}-replacement`;
		tempDirs.push(replacement);
		const original = path.join(dir, "record.json");
		await fs.writeFile(original, JSON.stringify({ session_id: "original" }));
		const foreign = JSON.stringify({ session_id: "foreign" });
		const rootStat = await fs.lstat(dir, { bigint: true });
		let restored = false;
		const authority: ProjectionScanDirectory = {
			stat: rootStat,
			readdir: async () => {
				await fs.rename(dir, replacement);
				await fs.mkdir(dir);
				await fs.writeFile(path.join(dir, "record.json"), foreign);
				return ["record.json"];
			},
			lstat: async entry => fs.lstat(path.join(replacement, entry), { bigint: true }),
			readFile: async entry => {
				const value = await fs.readFile(path.join(replacement, entry), "utf8");
				await fs.rm(dir, { recursive: true, force: true });
				await fs.rename(replacement, dir);
				restored = true;
				return value;
			},
			close: async () => {
				if (!restored) {
					await fs.rm(dir, { recursive: true, force: true });
					await fs.rename(replacement, dir);
				}
			},
		};
		const scan = await listCoordinatorJsonFiles(dir, {
			readdir: async () => {
				throw new Error("unpinned readdir used");
			},
			lstat: async () => {
				throw new Error("unpinned lstat used");
			},
			readFile: async () => {
				throw new Error("unpinned read used");
			},
			openDirectory: async () => authority,
		});
		expect(restored).toBe(true);
		expect(scan.values).toEqual([{ session_id: "original" }]);
		expect(scan.values).not.toEqual([{ session_id: "foreign" }]);
		expect(scan.incomplete).toBe(false);
	});

	it("Test 1 unsupported authority: scan fails closed without foreign values", async () => {
		const dir = await tempRoot("gjc-scan-unsupported-");
		const io = {
			readdir: async () => [],
			lstat: async () => {
				throw new Error("unpinned lstat used");
			},
			readFile: async () => JSON.stringify({ session_id: "foreign" }),
			openDirectory: async () => {
				const error = new Error("coordinator_projection_safe_read_unsupported") as NodeJS.ErrnoException;
				error.code = "coordinator_projection_safe_read_unsupported";
				throw error;
			},
		};
		const scan = await listCoordinatorJsonFiles(dir, io);
		expect(scan.values).toEqual([]);
		expect(scan.incomplete).toBe(true);
		expect(scan.raced).toBe(1);
		expect(scan.capped).toBe(true);
	});

	it("Test 1 Windows authority: stable regular JSON remains readable", async () => {
		const dir = await tempRoot("gjc-scan-win-stable-");
		ProjectionScanTestHooks.platform = "win32";
		await fs.writeFile(path.join(dir, "stable.json"), JSON.stringify({ session_id: "stable" }));

		const scan = await listCoordinatorJsonFiles(dir);

		expect(scan.values).toEqual([{ session_id: "stable" }]);
		expect(scan.parsed).toBe(1);
		expect(scan.raced).toBe(0);
		expect(scan.incomplete).toBe(false);
	});

	it("Test 1 Windows authority: root replacement fails closed", async () => {
		const dir = await tempRoot("gjc-scan-win-root-race-");
		const replacement = `${dir}-replacement`;
		tempDirs.push(replacement);
		ProjectionScanTestHooks.platform = "win32";
		await fs.writeFile(path.join(dir, "original.json"), JSON.stringify({ session_id: "original" }));

		const realReaddir = fs.readdir;
		const readdirSpy = spyOn(fs, "readdir");
		readdirSpy.mockImplementation((async (target: PathLike) => {
			const entries = await realReaddir(target);
			if (String(target) === dir) {
				await fs.rename(dir, replacement);
				await fs.mkdir(dir);
				await fs.writeFile(path.join(dir, "foreign.json"), JSON.stringify({ session_id: "foreign" }));
			}
			return entries;
		}) as unknown as typeof fs.readdir);
		try {
			const scan = await listCoordinatorJsonFiles(dir);
			expect(scan.values).toEqual([]);
			expect(scan.raced).toBe(1);
			expect(scan.incomplete).toBe(true);
			expect(scan.capped).toBe(true);
		} finally {
			readdirSpy.mockRestore();
		}
	});

	it("Test 1 Windows authority: candidate replacement fails closed before parsing", async () => {
		const dir = await tempRoot("gjc-scan-win-candidate-race-");
		const candidate = path.join(dir, "candidate.json");
		const replacement = path.join(dir, "candidate-replacement.tmp");
		ProjectionScanTestHooks.platform = "win32";
		await fs.writeFile(candidate, JSON.stringify({ session_id: "source" }));
		await fs.writeFile(replacement, JSON.stringify({ session_id: "target" }));

		const realLstat = fs.lstat as unknown as (file: PathLike, options?: unknown) => Promise<BigIntStats>;
		const lstatSpy = spyOn(fs, "lstat");
		let enumerated = false;
		lstatSpy.mockImplementation((async (file: PathLike, options: unknown) => {
			const stat = await realLstat(file, options);
			if (!enumerated && String(file) === candidate) {
				enumerated = true;
				await fs.rename(replacement, candidate);
				await fs.writeFile(replacement, JSON.stringify({ session_id: "replacement" }));
			}
			return stat;
		}) as unknown as typeof fs.lstat);
		try {
			const scan = await listCoordinatorJsonFiles(dir);
			expect(enumerated).toBe(true);
			expect(scan.values).toEqual([]);
			expect(scan.raced).toBe(1);
			expect(scan.incomplete).toBe(true);
			expect(scan.capped).toBe(true);
		} finally {
			lstatSpy.mockRestore();
		}
	});

	it("Test 1 Windows authority: ctime-only candidate replacement fails closed", async () => {
		const dir = await tempRoot("gjc-scan-win-ctime-race-");
		const candidate = path.join(dir, "candidate.json");
		ProjectionScanTestHooks.platform = "win32";
		await fs.writeFile(candidate, JSON.stringify({ session_id: "source" }));

		const realLstat = fs.lstat as unknown as (file: PathLike, options?: unknown) => Promise<BigIntStats>;
		const lstatSpy = spyOn(fs, "lstat");
		let candidateLstatCalls = 0;
		// Leave the enumerated identity without ctime so this exercises the
		// before/opened and relinked/opened Windows checks, not sameProjectionFile.
		const cloneStatWithCtime = (stat: BigIntStats, ctimeNs?: bigint): BigIntStats => {
			const clone = Object.create(Object.getPrototypeOf(stat)) as BigIntStats;
			Object.assign(clone, stat);
			if (ctimeNs === undefined) delete (clone as unknown as { ctimeNs?: bigint }).ctimeNs;
			else clone.ctimeNs = ctimeNs;
			return clone;
		};
		lstatSpy.mockImplementation((async (file: PathLike, options: unknown) => {
			const stat = await realLstat(file, options);
			if (String(file) !== candidate) return stat;
			const call = candidateLstatCalls++;
			return cloneStatWithCtime(stat, call === 0 ? undefined : call === 1 ? 1n : 2n);
		}) as unknown as typeof fs.lstat);
		const realOpen = fs.open;
		const openSpy = spyOn(fs, "open");
		openSpy.mockImplementation((async (file: PathLike, flags: unknown) => {
			if (String(file) !== candidate) return realOpen(file, flags as never);
			const stat = await realLstat(file, { bigint: true });
			const opened = cloneStatWithCtime(stat, 2n);
			return {
				stat: async () => opened,
				readFile: async () => JSON.stringify({ session_id: "source" }),
				close: async () => {},
			} as unknown as fs.FileHandle;
		}) as unknown as typeof fs.open);
		try {
			const scan = await listCoordinatorJsonFiles(dir);
			expect(scan.values).toEqual([]);
			expect(scan.parsed).toBe(0);
			expect(scan.raced).toBe(1);
			expect(scan.incomplete).toBe(true);
			expect(scan.capped).toBe(true);
		} finally {
			openSpy.mockRestore();
			lstatSpy.mockRestore();
		}
	});

	it("Test 1 Windows authority: candidate reparse replacement fails closed", async () => {
		const dir = await tempRoot("gjc-scan-win-reparse-race-");
		const candidate = path.join(dir, "candidate.json");
		const source = path.join(dir, "candidate-source.txt");
		ProjectionScanTestHooks.platform = "win32";
		await fs.writeFile(candidate, JSON.stringify({ session_id: "source" }));
		await fs.writeFile(source, JSON.stringify({ session_id: "reparse-target" }));

		const realLstat = fs.lstat as unknown as (file: PathLike, options?: unknown) => Promise<BigIntStats>;
		const lstatSpy = spyOn(fs, "lstat");
		let enumerated = false;
		lstatSpy.mockImplementation((async (file: PathLike, options: unknown) => {
			const stat = await realLstat(file, options);
			if (!enumerated && String(file) === candidate) {
				enumerated = true;
				await fs.unlink(candidate);
				await fs.symlink(source, candidate);
			}
			return stat;
		}) as unknown as typeof fs.lstat);
		try {
			const scan = await listCoordinatorJsonFiles(dir);
			expect(enumerated).toBe(true);
			expect(scan.values).toEqual([]);
			expect(scan.raced).toBe(1);
			expect(scan.incomplete).toBe(true);
			expect(scan.capped).toBe(true);
		} finally {
			lstatSpy.mockRestore();
		}
	});

	it("Test 1 Windows authority: unsupported platform remains fail-closed", async () => {
		const dir = await tempRoot("gjc-scan-unsupported-platform-");
		ProjectionScanTestHooks.platform = "darwin";
		await fs.writeFile(path.join(dir, "foreign.json"), JSON.stringify({ session_id: "foreign" }));

		const scan = await listCoordinatorJsonFiles(dir);

		expect(scan.values).toEqual([]);
		expect(scan.raced).toBe(1);
		expect(scan.incomplete).toBe(true);
		expect(scan.capped).toBe(true);
	});

	it("Test 1 lazy namespace: initial missing directory is a complete empty scan", async () => {
		const dir = await tempRoot("gjc-scan-lazy-empty-");
		const io = {
			readdir: async () => [],
			lstat: async () => {
				throw new Error("unpinned lstat used");
			},
			readFile: async () => JSON.stringify({ session_id: "foreign" }),
			openDirectory: async () => {
				const error = new Error("missing projection namespace") as NodeJS.ErrnoException;
				error.code = "ENOENT";
				throw error;
			},
		};
		const scan = await listCoordinatorJsonFiles(dir, io);
		expect(scan).toEqual({
			values: [],
			parsed: 0,
			capped: false,
			skippedDebris: 0,
			skippedEmpty: 0,
			raced: 0,
			incomplete: false,
		});
	});

	it("Test 1 authority race: missing directory after acquisition is incomplete", async () => {
		const stat = {
			size: 0,
			dev: 1n,
			ino: 2n,
			isDirectory: () => true,
			isFile: () => false,
			isSymbolicLink: () => false,
		};
		const error = new Error("directory disappeared") as NodeJS.ErrnoException;
		error.code = "ENOENT";
		const authority: ProjectionScanDirectory = {
			stat,
			readdir: async () => {
				throw error;
			},
			lstat: async () => stat,
			readFile: async () => "{}",
			close: async () => {},
		};
		const scan = await listCoordinatorJsonFiles("/missing-after-acquire", {
			readdir: async () => [],
			lstat: async () => stat,
			readFile: async () => "{}",
			openDirectory: async () => authority,
		});
		expect(scan.values).toEqual([]);
		expect(scan.capped).toBe(true);
		expect(scan.incomplete).toBe(true);
		expect(scan.raced).toBe(1);
	});

	it.skipIf(process.platform !== "linux")(
		"Test 1 over-cap: debris pile + few valid records succeeds without unreadable",
		async () => {
			const dir = await tempRoot("gjc-cap-");
			await fs.writeFile(path.join(dir, "a.json"), JSON.stringify({ session_id: "a" }));
			await fs.writeFile(path.join(dir, "b.json"), JSON.stringify({ session_id: "b" }));
			for (let i = 0; i < COORDINATOR_JSON_SCAN_CAP + 5; i++) {
				await fs.writeFile(
					path.join(dir, `.gjc-delete-session-state-lock-${i.toString(16).padStart(32, "0")}.json`),
					"",
				);
			}
			const scan = await listCoordinatorJsonFiles(dir);
			expect(scan.capped).toBe(false);
			expect(scan.values).toHaveLength(2);
			// Writing 10k+ debris files is I/O-bound: on Windows CI disks this exceeds
			// the default 5s test timeout without being a behavioral failure.
		},
		60000,
	);

	it.skipIf(process.platform !== "linux")(
		"Test 1: zero-byte canonical JSON fails closed instead of being ignored",
		async () => {
			const dir = await tempRoot("gjc-postcap-");
			await fs.writeFile(path.join(dir, "live.json"), JSON.stringify({ session_id: "live" }));
			await fs.writeFile(path.join(dir, "empty.json"), "");
			await expect(listCoordinatorJsonFiles(dir, undefined, 10)).rejects.toThrow("Unexpected EOF");
		},
	);

	it("Test 2: leftover empty at reserved name is removed before exchange", async () => {
		const dir = await tempRoot("gjc-mint-");
		const reserved = ".gjc-delete-session-state-lock-bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb.json";
		await fs.writeFile(path.join(dir, reserved), "");
		await removeVerifiedEmptyQuarantine(dir, reserved);
		expect(
			await fs.stat(path.join(dir, reserved)).then(
				() => "present",
				() => "gone",
			),
		).toBe("gone");
		await fs.writeFile(path.join(dir, reserved), "body");
		await removeVerifiedEmptyQuarantine(dir, reserved);
		expect(await fs.readFile(path.join(dir, reserved), "utf8")).toBe("body");
	});

	it("Test 2b: stale reclaim does not refuse a planted leftover at forced quarantine name", async () => {
		const dir = await tempRoot("gjc-reclaim-");
		const stateFile = path.join(dir, "session.json");
		const lockFile = `${stateFile}.lock`;
		const reserved = ".gjc-delete-session-state-lock-cccccccc-cccc-cccc-cccc-cccccccccccc.json";
		await fs.writeFile(stateFile, JSON.stringify({ state: "running" }));
		await fs.writeFile(path.join(dir, reserved), "");
		await fs.writeFile(
			lockFile,
			JSON.stringify({
				pid: 2 ** 22 - 1,
				start_time: "unknown",
				token: "dead",
				owner_host_id: "local-host",
			}),
		);
		SessionStateLockTestHooks.ownerHostId = () => "local-host";
		SessionStateLockTestHooks.unqualifiedOwnerIsLocal = true;
		SessionStateLockTestHooks.probeProcessSignal = () => {
			throw Object.assign(new Error("missing"), { code: "ESRCH" });
		};
		SessionStateLockTestHooks.forcedQuarantineName = reserved;
		await expect(reclaimStaleSessionStateLock(lockFile)).resolves.toBeUndefined();
		expect(
			await fs.stat(lockFile).then(
				() => "present",
				() => "gone",
			),
		).toBe("gone");
	});

	it("Test 3: turn-start persist then next lock cycle can rewrite off running", async () => {
		const dir = await tempRoot("gjc-running-");
		const stateFile = path.join(dir, "runtime-state.json");
		process.env[GJC_COORDINATOR_SESSION_STATE_FILE_ENV] = stateFile;
		await persistCoordinatorRuntimeStateFromEvent(
			{ type: "turn_start" },
			{ sessionId: "sid", cwd: dir, sessionFile: null },
		);
		const first = JSON.parse(await fs.readFile(stateFile, "utf8")) as { state: string };
		expect(first.state).toBe("running");
		await persistCoordinatorRuntimeStateFromEvent(
			{ type: "agent_end", messages: [] },
			{ sessionId: "sid", cwd: dir, sessionFile: null },
		);
		const second = JSON.parse(await fs.readFile(stateFile, "utf8")) as { state: string };
		expect(second.state).not.toBe("running");
		delete process.env[GJC_COORDINATOR_SESSION_STATE_FILE_ENV];
	});

	it("Test 4: gc operands keep non-empty/symlink/missing-root and prune only empty prefix", async () => {
		const root = await tempRoot("gjc-gc-root-");
		const empty = path.join(root, ".gjc-delete-session-state-lock-dddddddd-dddd-dddd-dddd-dddddddddddd.json");
		const live = path.join(root, "live.json");
		const other = path.join(root, ".gjc-delete-session-state-lock-eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee.json");
		await fs.writeFile(empty, "");
		await fs.writeFile(live, "{}");
		await fs.writeFile(other, "not-empty");
		const missing = path.join(root, "no-such-root");
		const dry = await runEmptyDeleteGc({ roots: [root, missing], prune: false });
		expect(dry.would_remove).toBe(1);
		expect(dry.records.find(r => r.action === "would_remove")?.observationOnly).toBe(true);
		expect(dry.records.some(r => r.reason === "missing_root")).toBe(true);
		expect(dry.errors).toEqual([`${missing}: missing_root`]);
		expect(dry.records.some(r => r.reason === "non_empty")).toBe(true);
		const pruned = await runEmptyDeleteGc({ roots: [root], prune: true });
		expect(pruned.removed).toBe(1);
		await expect(fs.stat(empty)).rejects.toMatchObject({ code: "ENOENT" });
		expect(await fs.readFile(other, "utf8")).toBe("not-empty");
		expect(await fs.readFile(live, "utf8")).toBe("{}");
	});

	it("Test 4b: symlink root skipped; forged non-UUID and GC-minted names never collected", async () => {
		const root = await tempRoot("gjc-gc-id-");
		const linked = path.join(root, "linked-root");
		await fs.symlink(root, linked);
		const viaLink = await runEmptyDeleteGc({ roots: [linked], prune: false });
		expect(viaLink.records.some(r => r.reason === "symlink_root")).toBe(true);
		const viaTrailingLink = await runEmptyDeleteGc({ roots: [`${linked}${path.sep}`], prune: false });
		expect(viaTrailingLink.records).toEqual([expect.objectContaining({ action: "skipped", reason: "symlink_root" })]);
		const viaDotLink = await runEmptyDeleteGc({ roots: [`${linked}${path.sep}.`], prune: false });
		expect(viaDotLink.records).toEqual([expect.objectContaining({ action: "skipped", reason: "symlink_root" })]);
		const empty = path.join(root, ".gjc-delete-session-state-lock-ffffffff-ffff-ffff-ffff-ffffffffffff.json");
		const shortHex = path.join(root, ".gjc-delete-session-state-lock-aaaaaaaa.json");
		const gcMinted = path.join(root, ".gjc-delete-gc-33333333-3333-3333-3333-333333333333.json");
		await Promise.all([fs.writeFile(empty, ""), fs.writeFile(shortHex, ""), fs.writeFile(gcMinted, "")]);
		const collected = await collectEmptyDeleteReceipts(root);
		expect(collected.find(r => r.path === empty)?.identity).toBeDefined();
		expect(collected.find(r => r.path === shortHex)).toBeUndefined();
		expect(collected.find(r => r.path === gcMinted)).toBeUndefined();
		const pruned = await runEmptyDeleteGc({ roots: [root], prune: true });
		expect(pruned.removed).toBe(1);
		// The forged suffix and the GC-minted namespace survive a prune untouched.
		expect(await fs.readFile(shortHex, "utf8")).toBe("");
		expect(await fs.readFile(gcMinted, "utf8")).toBe("");
	});

	it("Test 4c: replacement planted after collection is refused by identity drift", async () => {
		const root = await tempRoot("gjc-gc-drift-");
		const file = path.join(root, ".gjc-delete-session-state-lock-22222222-2222-2222-2222-222222222222.json");
		await fs.writeFile(file, "");
		const collected = await collectEmptyDeleteReceipts(root);
		const wouldRemove = collected.find(r => r.action === "would_remove");
		expect(wouldRemove?.identity).toBeDefined();
		// Swap the object out from under the collected identity: same pathname, and on
		// inode-recycling filesystems even the same inode — but a later mtime.
		await Bun.sleep(20);
		await fs.unlink(file);
		await fs.writeFile(file, "payload");
		const pruned = await runEmptyDeleteGc({ roots: [root], prune: true });
		const row = pruned.records.find(r => r.path === file);
		// The non-empty replacement is kept before any unlink is attempted; the
		// identity-drift refusal is proven separately at the native boundary below.
		expect(row?.action).toBe("kept");
		expect(["non_empty", "identity_drift"]).toContain(row?.reason ?? "");
		expect(pruned.removed).toBe(0);
		// The replacement survives: no deletion path may consume it.
		expect(await fs.readFile(file, "utf8")).toBe("payload");
		// Native-boundary drift proof: the stale collected identity must be refused
		// against the replaced object, and the replacement must remain.
		const driftResult = exactUnlinkDirect(file, {
			...wouldRemove!.identity!,
			quarantineName: ".gjc-delete-drift-probe.json",
		});
		expect(driftResult.ok).toBe(false);
		expect(driftResult.code).toBe("identity_mismatch");
		expect(await fs.readFile(file, "utf8")).toBe("payload");
	});

	it("Test 4d: readdir/lstat race records a raced skipped candidate instead of omitting it", async () => {
		const root = await tempRoot("gjc-gc-race-");
		const gone = path.join(root, ".gjc-delete-session-state-lock-44444444-4444-4444-4444-444444444444.json");
		const live = path.join(root, ".gjc-delete-session-state-lock-55555555-5555-5555-5555-555555555555.json");
		await fs.writeFile(gone, "");
		await fs.writeFile(live, "");
		// Model the discovery race deterministically: both entries are present at readdir,
		// but `gone` vanished before its lstat. Discovery must record the raced candidate
		// instead of silently shrinking the report.
		const collected = await collectEmptyDeleteReceipts(root, {
			lstat: async (file, options) => {
				if (file === gone) {
					const error = new Error(`ENOENT: no such file or directory, lstat '${file}'`) as NodeJS.ErrnoException;
					error.code = "ENOENT";
					throw error;
				}
				return fs.lstat(file, options);
			},
		});
		expect(collected.find(r => r.path === gone)).toEqual(
			expect.objectContaining({ action: "skipped", reason: "raced" }),
		);
		expect(collected.find(r => r.path === live)?.action).toBe("would_remove");
	});

	it("Test 4e: root replacement during discovery reports a root race without external paths", async () => {
		const root = await tempRoot("gjc-gc-root-race-");
		const replacement = `${root}-replacement`;
		tempDirs.push(replacement);
		const receipt = path.join(root, ".gjc-delete-session-state-lock-66666666-6666-6666-6666-666666666666.json");
		await fs.writeFile(receipt, "");
		let rootChecks = 0;
		const collected = await collectEmptyDeleteReceipts(root, {
			lstat: async (file, options) => {
				if (file === path.resolve(root) && rootChecks++ === 1) {
					await fs.rename(root, replacement);
					await fs.mkdir(root);
					await fs.writeFile(
						path.join(root, ".gjc-delete-session-state-lock-77777777-7777-7777-7777-777777777777.json"),
						'{"foreign":true}',
					);
				}
				return fs.lstat(file, options);
			},
		});
		expect(rootChecks).toBe(2);
		expect(collected).toEqual([
			expect.objectContaining({ root, path: root, action: "skipped", reason: "root_race" }),
		]);
		expect(collected.every(record => !record.path.includes("77777777"))).toBe(true);
		const report = await runEmptyDeleteGc({ roots: [root], prune: true }, { collect: async () => collected });
		expect(report.records).toEqual(collected);
		expect(report.errors).toEqual([`${root}: root_race`]);
	});

	it("Test 4f: collect-to-prune replacement keeps the successor and reports identity drift", async () => {
		const root = await tempRoot("gjc-gc-orchestration-race-");
		const file = path.join(root, ".gjc-delete-session-state-lock-88888888-8888-8888-8888-888888888888.json");
		await fs.writeFile(file, "");
		let collected = false;
		const report = await runEmptyDeleteGc(
			{ roots: [root], prune: true },
			{
				collect: async candidateRoot => {
					const records = await collectEmptyDeleteReceipts(candidateRoot);
					await fs.unlink(file);
					await fs.writeFile(file, "successor");
					collected = true;
					return records;
				},
			},
		);
		expect(collected).toBe(true);
		expect(report.records).toEqual([
			expect.objectContaining({ path: file, action: "kept", reason: "identity_drift" }),
		]);
		expect(report.errors).toEqual([]);
		expect(report.removed).toBe(0);
		expect(await fs.readFile(file, "utf8")).toBe("successor");
	});

	it("Test 4 CLI: empty-delete-receipts requires operand", async () => {
		const result = await runGjcGcCommand(["--empty-delete-receipts", "--json"], "/tmp", process.env, []);
		expect(result.status).toBe(2);
		expect(result.stderr).toContain("empty_delete_receipts_requires_root_or_manifest");
	});

	it("Test 4b CLI: JSON and text reports include identity-safe empty-delete results", async () => {
		const root = await tempRoot("gjc-gc-report-");
		const empty = path.join(root, ".gjc-delete-session-state-lock-11111111-1111-1111-1111-111111111111.json");
		await fs.writeFile(empty, "");
		const json = await runGjcGcCommand(["--empty-delete-receipts", "--root", root, "--json"], root, process.env, []);
		expect(json.status).toBe(0);
		const parsed = JSON.parse(json.stdout) as {
			empty_delete_receipts?: { records: Array<{ identity?: { dev: unknown } }> };
		};
		expect(parsed.empty_delete_receipts?.records[0]?.identity?.dev).toBeTypeOf("string");
		const text = await runGjcGcCommand(["--empty-delete-receipts", "--root", root], root, process.env, []);
		expect(text.status).toBe(0);
		expect(text.stdout).toContain("Empty .gjc-delete receipts");
	});

	it("Test 4c CLI: malformed manifest is a structured usage error", async () => {
		const root = await tempRoot("gjc-gc-manifest-");
		const manifest = path.join(root, "manifest.json");
		await fs.writeFile(manifest, "{");
		const result = await runGjcGcCommand(["--empty-delete-receipts", "--manifest", manifest], root, process.env, []);
		expect(result.status).toBe(2);
		expect(result.stderr).toContain("manifest_invalid");
	});

	it("Test 4d CLI: malformed manifest with --prune mutates nothing", async () => {
		const root = await tempRoot("gjc-gc-preflight-");
		const manifest = path.join(root, "manifest.json");
		const empty = path.join(root, ".gjc-delete-session-state-lock-44444444-4444-4444-4444-444444444444.json");
		await fs.writeFile(manifest, "{");
		await fs.writeFile(empty, "");
		const result = await runGjcGcCommand(
			["--prune", "--empty-delete-receipts", "--manifest", manifest, "--root", root],
			root,
			process.env,
			[],
		);
		expect(result.status).toBe(2);
		expect(result.stdout).toBe("");
		// Operand validation failed before any store could prune: the receipt is intact.
		expect(await fs.readFile(empty, "utf8")).toBe("");
	});

	it("Test 4e CLI: a following option token is a missing operand, not a root", async () => {
		const root = await tempRoot("gjc-gc-opttoken-");
		const result = await runGjcGcCommand(["--empty-delete-receipts", "--root", "--json"], root, process.env, []);
		expect(result.status).toBe(2);
		expect(result.stderr).toContain("missing_root");
		const manifest = await runGjcGcCommand(
			["--empty-delete-receipts", "--manifest", "--json"],
			root,
			process.env,
			[],
		);
		expect(manifest.status).toBe(2);
		expect(manifest.stderr).toContain("missing_manifest");
		// A declared SHORT option is just as much an option token: `-j` must be a
		// missing operand, never a root path that lets a normal prune proceed.
		const shortRoot = await runGjcGcCommand(
			["--prune", "--empty-delete-receipts", "--root", "-j"],
			root,
			process.env,
			[],
		);
		expect(shortRoot.status).toBe(2);
		expect(shortRoot.stderr).toContain("missing_root");
		const shortManifest = await runGjcGcCommand(
			["--prune", "--empty-delete-receipts", "--manifest", "-h"],
			root,
			process.env,
			[],
		);
		expect(shortManifest.status).toBe(2);
		expect(shortManifest.stderr).toContain("missing_manifest");
	});

	it("Test 4f CLI: every supplied manifest is validated, not just the last", async () => {
		const root = await tempRoot("gjc-gc-dupmanifest-");
		const malformed = path.join(root, "malformed.json");
		const valid = path.join(root, "valid.json");
		const empty = path.join(root, ".gjc-delete-session-state-lock-66666666-6666-6666-6666-666666666666.json");
		await fs.writeFile(malformed, "{");
		await fs.writeFile(valid, JSON.stringify({ roots: [root] }));
		await fs.writeFile(empty, "");
		const result = await runGjcGcCommand(
			["--prune", "--empty-delete-receipts", "--manifest", malformed, "--manifest", valid],
			root,
			process.env,
			[],
		);
		expect(result.status).toBe(2);
		expect(result.stderr).toContain("manifest_invalid");
		// The malformed first manifest failed the preflight: the receipt is intact.
		expect(await fs.readFile(empty, "utf8")).toBe("");
	});

	it("Test 4g CLI: root/manifest operands without --empty-delete-receipts are a usage error", async () => {
		const root = await tempRoot("gjc-gc-orphan-");
		const manifest = path.join(root, "manifest.json");
		const empty = path.join(root, ".gjc-delete-session-state-lock-77777777-7777-7777-7777-777777777777.json");
		await fs.writeFile(manifest, JSON.stringify({ roots: [root] }));
		await fs.writeFile(empty, "");
		const orphanRoot = await runGjcGcCommand(["--prune", "--root", root], root, process.env, []);
		expect(orphanRoot.status).toBe(2);
		expect(orphanRoot.stderr).toContain("empty_delete_operands_require_feature_flag");
		const orphanManifest = await runGjcGcCommand(["--prune", "--manifest", manifest], root, process.env, []);
		expect(orphanManifest.status).toBe(2);
		expect(orphanManifest.stderr).toContain("empty_delete_operands_require_feature_flag");
		// Neither run reached any prune: the receipt is intact.
		expect(await fs.readFile(empty, "utf8")).toBe("");
	});

	it("Test 4h CLI: a null manifest is a structured shape error, not a crash", async () => {
		const root = await tempRoot("gjc-gc-nullmanifest-");
		const manifest = path.join(root, "manifest.json");
		await fs.writeFile(manifest, "null");
		const result = await runGjcGcCommand(
			["--prune", "--empty-delete-receipts", "--manifest", manifest],
			root,
			process.env,
			[],
		);
		expect(result.status).toBe(2);
		expect(result.stderr).toContain("manifest_shape_invalid");
	});

	it("Test 2c: replacement swapped in inside the cleanup race window survives", async () => {
		const dir = await tempRoot("gjc-quarantine-toctou-");
		const reserved = ".gjc-delete-session-state-lock-55555555-5555-5555-5555-555555555555.json";
		const target = path.join(dir, reserved);
		await fs.writeFile(target, "");
		// Inject the replacement INSIDE the race window: the production lstat has
		// already captured the empty identity when the bytes change underneath it.
		// A lstat-then-plain-unlink implementation would delete the payload here; the
		// identity-bound direct unlink must refuse and leave every byte in place.
		setSessionStateLockNativeBindings(() => ({
			...exactIdentityNativeBindings,
			exactUnlinkDirect: (targetPath, identity) => {
				fsSync.writeFileSync(targetPath, "operator payload");
				return exactIdentityNativeBindings.exactUnlinkDirect(targetPath, identity);
			},
		}));
		await removeVerifiedEmptyQuarantine(dir, reserved);
		expect(await fs.readFile(target, "utf8")).toBe("operator payload");
	});

	it("Test 2c parent race: replacement directory is refused by parent identity", async () => {
		const dir = await tempRoot("gjc-quarantine-parent-race-");
		const replacement = `${dir}-replacement`;
		tempDirs.push(replacement);
		const reserved = ".gjc-delete-session-state-lock-66666666-6666-6666-6666-666666666666.json";
		const target = path.join(dir, reserved);
		await fs.writeFile(target, "");
		setSessionStateLockNativeBindings(() => ({
			...exactIdentityNativeBindings,
			exactUnlinkDirect: (targetPath, identity) => {
				const originalParent = fsSync.statSync(path.dirname(targetPath), { bigint: true });
				expect(identity.parentDev).toBe(originalParent.dev);
				expect(identity.parentIno).toBe(originalParent.ino);
				fsSync.renameSync(path.dirname(targetPath), replacement);
				fsSync.mkdirSync(path.dirname(targetPath));
				return { ok: false, code: "parent_mismatch" };
			},
		}));
		await expect(removeVerifiedEmptyQuarantine(dir, reserved)).rejects.toBeInstanceOf(
			SessionStateLockUnavailableError,
		);
		expect(await fs.readFile(path.join(replacement, reserved), "utf8")).toBe("");
		expect(await fs.readdir(dir)).toEqual([]);
	});

	it("Test 2d: a backslash traversal quarantine name is refused before any join", async () => {
		const dir = await tempRoot("gjc-quarantine-backslash-");
		// The victim is planted at the RESOLVED location so the fixture runs on both
		// platforms: on Windows the child\..\ form traverses to dir/victim; on POSIX
		// it is a literal backslash filename inside dir. Either way the guard must
		// refuse the name before path.join, and the planted bytes must survive.
		const name = ".gjc-delete-child\\..\\victim";
		const planted = process.platform === "win32" ? path.join(dir, "victim") : path.join(dir, name);
		await fs.writeFile(planted, "");
		await removeVerifiedEmptyQuarantine(dir, name);
		// The victim is EMPTY on purpose: a non-empty file would be kept by the size
		// gate even without the backslash guard, making this test vacuous. Only the
		// single-component name guard can save an empty, single-link victim.
		expect(await fs.readFile(planted, "utf8")).toBe("");
	});

	it("Test 2e: a stranded detached object fails closed with retained evidence", async () => {
		const dir = await tempRoot("gjc-quarantine-retained-");
		const reserved = ".gjc-delete-session-state-lock-88888888-8888-8888-8888-888888888888.json";
		const target = path.join(dir, reserved);
		await fs.writeFile(target, "");
		const stranded = path.join(dir, ".gjc-delete-cleanup-stranded.json");
		setSessionStateLockNativeBindings(() => ({
			...exactIdentityNativeBindings,
			exactUnlinkDirect: () => ({ ok: false, code: "identity_mismatch", detachedPath: stranded }),
		}));
		const failure = await removeVerifiedEmptyQuarantine(dir, reserved).then(
			() => undefined,
			(error: unknown) => error,
		);
		expect(failure).toBeInstanceOf(SessionStateLockUnavailableError);
		const cause = (failure as { cause?: Error }).cause;
		expect(cause?.message).toContain("identity_mismatch");
		expect(cause?.message).toContain(stranded);
		// The verified-empty leftover is untouched for operator recovery.
		expect(await fs.readFile(target, "utf8")).toBe("");
	});

	it("Test 2f: the native exact unlink refuses a quarantine collision", async () => {
		const dir = await tempRoot("gjc-quarantine-collision-");
		const target = path.join(dir, "victim");
		const quarantine = ".gjc-delete-collision.json";
		const detached = path.join(dir, quarantine);
		await fs.writeFile(target, "");
		await fs.writeFile(detached, "pre-existing quarantine occupant");
		const stat = await fs.lstat(target, { bigint: true });
		const result = exactUnlinkDirect(target, {
			dev: stat.dev,
			ino: stat.ino,
			nlink: stat.nlink,
			size: stat.size,
			mtimeNs: stat.mtimeNs,
			sha256: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
			quarantineName: quarantine,
		});
		if (process.platform === "win32") {
			// Windows direct unlink is handle-bound and never uses the quarantine
			// pathname: the validated victim is deleted and the occupant is irrelevant.
			expect(result.ok).toBe(true);
			await expect(fs.lstat(target)).rejects.toMatchObject({ code: "ENOENT" });
		} else {
			expect(result.ok).toBe(false);
			expect(result.code).toBe("quarantine_collision");
			// No-replace semantics: BOTH objects survive untouched.
			expect(await fs.readFile(target, "utf8")).toBe("");
		}
		expect(await fs.readFile(detached, "utf8")).toBe("pre-existing quarantine occupant");
	});

	it("Test 2g: a dangling symlink at the quarantine name is still a native collision", async () => {
		const dir = await tempRoot("gjc-quarantine-dangling-");
		const target = path.join(dir, "victim");
		const quarantine = ".gjc-delete-dangling.json";
		const detached = path.join(dir, quarantine);
		await fs.writeFile(target, "");
		// existsSync follows links and reports a DANGLING symlink as absent; the
		// native rename-no-replace must still refuse to overwrite it.
		await fs.symlink(path.join(dir, "nonexistent-target"), detached);
		const stat = await fs.lstat(target, { bigint: true });
		const result = exactUnlinkDirect(target, {
			dev: stat.dev,
			ino: stat.ino,
			nlink: stat.nlink,
			size: stat.size,
			mtimeNs: stat.mtimeNs,
			sha256: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
			quarantineName: quarantine,
		});
		if (process.platform === "win32") {
			// Windows direct unlink is handle-bound and never uses the quarantine
			// pathname: the validated victim is deleted and the symlink is irrelevant.
			expect(result.ok).toBe(true);
			await expect(fs.lstat(target)).rejects.toMatchObject({ code: "ENOENT" });
		} else {
			expect(result.ok).toBe(false);
			expect(result.code).toBe("quarantine_collision");
			// Both the victim and the dangling symlink survive untouched.
			expect(await fs.readFile(target, "utf8")).toBe("");
		}
		expect((await fs.lstat(detached)).isSymbolicLink()).toBe(true);
	});

	it("Test 5: atomic write leaves no 0-byte canonical on crash-before-rename", async () => {
		const dir = await tempRoot("gjc-atomic-");
		const file = path.join(dir, "canonical.json");
		await writeCoordinatorAtomic(file, '{"ok":true}\n');
		expect(await fs.readFile(file, "utf8")).toBe('{"ok":true}\n');
		await expect(
			writeCoordinatorAtomic(file, '{"next":true}\n', {
				rename: async () => {
					throw new Error("injected_rename_fault");
				},
			}),
		).rejects.toThrow("injected_rename_fault");
		expect(await fs.readFile(file, "utf8")).toBe('{"ok":true}\n');
		const leftovers = (await fs.readdir(dir)).filter(name => name.endsWith(".tmp"));
		expect(leftovers).toEqual([]);
	});
});
