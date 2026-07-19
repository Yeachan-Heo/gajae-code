import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { type BigIntStats, constants } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import * as fsPromises from "node:fs/promises";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type CommandEntry, run } from "@gajae-code/utils/cli";
import { runWorktreeCommand } from "../src/cli/worktree-cli";
import {
	MAX_DEPTH,
	MAX_ENTRIES,
	MAX_METADATA_BYTES,
	MAX_NAME_UTF8_BYTES,
	MAX_TOTAL_METADATA_BYTES,
	METADATA_RESERVATION_BYTES,
	scanWorktrees,
	type WorktreeDiagnostic,
	WorktreeRootError,
} from "../src/cli/worktree-scanner";
import { createWorktreeCommand } from "../src/commands/worktree";

async function withRoot(run: (root: string) => Promise<void>): Promise<void> {
	const root = await mkdtemp(join(tmpdir(), "gjc-worktree-scanner-"));
	try {
		await run(root);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
}
function symbolicDirectory(stat: BigIntStats): BigIntStats {
	return {
		dev: stat.dev,
		ino: stat.ino,
		isFile: () => false,
		isDirectory: () => true,
		isSymbolicLink: () => true,
	} as BigIntStats;
}
const originalNoFollowDescriptor = Object.getOwnPropertyDescriptor(constants, "O_NOFOLLOW");
const originalNonBlockDescriptor = Object.getOwnPropertyDescriptor(constants, "O_NONBLOCK");
beforeAll(() => {
	if (typeof constants.O_NOFOLLOW !== "number" || constants.O_NOFOLLOW === 0)
		Object.defineProperty(constants, "O_NOFOLLOW", {
			value: constants.O_SYNC,
			configurable: true,
			writable: true,
		});
	if (typeof constants.O_NONBLOCK !== "number" || constants.O_NONBLOCK === 0)
		Object.defineProperty(constants, "O_NONBLOCK", {
			value: constants.O_APPEND,
			configurable: true,
			writable: true,
		});
});
afterAll(() => {
	if (originalNoFollowDescriptor) Object.defineProperty(constants, "O_NOFOLLOW", originalNoFollowDescriptor);
	else Reflect.deleteProperty(constants, "O_NOFOLLOW");
	if (originalNonBlockDescriptor) Object.defineProperty(constants, "O_NONBLOCK", originalNonBlockDescriptor);
	else Reflect.deleteProperty(constants, "O_NONBLOCK");
});
function renderedPath(value: string): string {
	return value.replaceAll("\\", "\\\\");
}
const CHUNK_BYTES_FOR_TEST = 8192;
const posixTest = test.skipIf(process.platform === "win32");

describe("bounded worktree scanner", () => {
	test("publishes fixed limits and preserves missing roots", async () => {
		expect(MAX_ENTRIES).toBe(1024);
		expect(MAX_DEPTH).toBe(2);
		expect(MAX_NAME_UTF8_BYTES).toBe(255);
		expect(MAX_METADATA_BYTES).toBe(65536);
		expect(METADATA_RESERVATION_BYTES).toBe(65537);
		expect(MAX_TOTAL_METADATA_BYTES).toBe(1048576);
		expect(await scanWorktrees({ root: join(tmpdir(), "gjc-no-such-root"), platform: "posix" })).toEqual([]);
	});

	posixTest("recognizes a valid pointer and reads bounded metadata in order", async () => {
		await withRoot(async root => {
			const candidate = join(root, "candidate");
			const target = join(candidate, "meta", "worktrees", "one");
			await mkdir(candidate, { recursive: true });
			await mkdir(target, { recursive: true });
			await writeFile(join(candidate, ".git"), `gitdir: ${target}\n`);
			await writeFile(join(target, "HEAD"), "ref: refs/heads/topic\n");
			await writeFile(join(target, "commondir"), "../..\n");
			await writeFile(join(target, "gitdir"), `${join(candidate, ".git")}\n`);
			const result = await scanWorktrees({ root, platform: "posix" });
			expect(result).toEqual([
				{
					path: renderedPath(join(root, "candidate")),
					kind: "pr-checkout",
					reasonCode: "normal-pr",
					message: "worktree metadata observed; preserved",
				},
			]);
		});
	});

	test("does not follow root or candidate symlinks and has no Windows child traversal", async () => {
		await withRoot(async root => {
			const real = join(root, "real");
			await mkdir(real);
			await symlink(real, join(root, "link"));
			const result = await scanWorktrees({ root, platform: "win32" });
			expect(result.some(entry => entry.reasonCode === "unsupported-link")).toBe(true);
		});
	});

	test("charges returned-order entries globally and emits one terminal overflow", async () => {
		await withRoot(async root => {
			await Promise.all(
				Array.from({ length: MAX_ENTRIES + 1 }, (_, index) =>
					mkdir(join(root, `entry-${String(index).padStart(4, "0")}`)),
				),
			);
			const result = await scanWorktrees({ root, platform: "posix" });
			expect(result.at(-1)).toEqual({
				path: renderedPath(root),
				kind: "overflow",
				reasonCode: "overflow",
				message: "scan limit exceeded: 1024 entries; preserved",
			});
			expect(result.filter(entry => entry.reasonCode === "overflow")).toHaveLength(1);
		});
	});
	test("does not list the directory that consumes the final entry charge", async () => {
		await withRoot(async root => {
			const boundary = join(root, "entry-1023");
			await mkdir(boundary);
			await Promise.all(
				Array.from({ length: MAX_ENTRIES - 1 }, (_, index) =>
					writeFile(join(root, `entry-${String(index).padStart(4, "0")}`), ""),
				),
			);
			const actualReaddir = fsPromises.readdir;
			const readdirSpy = spyOn(fsPromises, "readdir").mockImplementation(async (directory, options) => {
				if (String(directory) === root) {
					return Array.from({ length: MAX_ENTRIES }, (_, index) => ({
						name: `entry-${String(index).padStart(4, "0")}`,
					})) as never;
				}
				return actualReaddir(directory, options as never) as never;
			});
			try {
				const result = await scanWorktrees({ root, platform: "posix" });
				expect(result.at(-1)).toMatchObject({ kind: "overflow", reasonCode: "overflow" });
				expect(readdirSpy.mock.calls.some(call => String(call[0]) === boundary)).toBe(false);
			} finally {
				readdirSpy.mockRestore();
			}
		});
	});

	test("shares the metadata reservation budget across candidates", async () => {
		await withRoot(async root => {
			await Promise.all(
				Array.from({ length: 16 }, async (_, index) => {
					const candidate = join(root, `candidate-${String(index).padStart(2, "0")}`);
					await mkdir(candidate);
					await writeFile(join(candidate, ".git"), `gitdir: ${join(root, "missing", String(index))}\n`);
				}),
			);
			const result = await scanWorktrees({ root, platform: "posix" });
			expect(result.some(entry => entry.kind === "overflow" && entry.reasonCode === "overflow")).toBe(true);
		});
	});

	test("classifies empty and unrecognized directories without conflation", async () => {
		await withRoot(async root => {
			const empty = join(root, "empty");
			const stray = join(root, "stray");
			await mkdir(empty);
			await mkdir(stray);
			await writeFile(join(stray, "note.txt"), "content");
			const result = await scanWorktrees({ root, platform: "posix" });
			expect(result.find(entry => entry.path === renderedPath(empty))).toMatchObject({
				kind: "empty",
				reasonCode: "empty",
				message: "empty directory; preserved",
			});
			expect(result.find(entry => entry.path === renderedPath(stray))).toMatchObject({
				kind: "stray",
				reasonCode: "stray",
				message: "unrecognized directory contents; preserved",
			});
		});
	});

	posixTest("classifies an empty gitfile as malformed", async () => {
		await withRoot(async root => {
			const candidate = join(root, "empty-gitfile");
			await mkdir(candidate);
			await writeFile(join(candidate, ".git"), "");
			await expect(scanWorktrees({ root, platform: "posix" })).resolves.toEqual([
				{
					path: renderedPath(candidate),
					kind: "pr-checkout",
					reasonCode: "malformed-gitfile",
					message: "malformed .git file; preserved",
				},
			]);
		});
	});
	posixTest("rejects malformed metadata without exposing raw content", async () => {
		await withRoot(async root => {
			const candidate = join(root, "bad");
			await mkdir(candidate);
			await writeFile(join(candidate, ".git"), Buffer.from([0xff, 0xfe]));
			const result = await scanWorktrees({ root, platform: "posix" });
			expect(result[0]?.message).toBe(".git file is not valid UTF-8; preserved");
			expect(JSON.stringify(result)).not.toContain("\uFFFD");
		});
	});
	test("preserves exact worker streams for empty list and root failure", async () => {
		await withRoot(async root => {
			await expect(
				runWorktreeCommand({ root, platform: "posix", action: "list", json: false, dryRun: false }),
			).resolves.toEqual({
				stdout: "No agent-managed worktrees found.\n",
				stderr: "",
				exitCode: 0,
			});
		});
		const missing = join(tmpdir(), "gjc-worktree-worker-missing");
		await expect(
			runWorktreeCommand({ root: missing, platform: "posix", action: "list", json: false, dryRun: false }),
		).resolves.toEqual({
			stdout: "No agent-managed worktrees found.\n",
			stderr: "",
			exitCode: 0,
		});
	});

	test("rejects a linked managed root at the worker boundary", async () => {
		const directory = await mkdtemp(join(tmpdir(), "gjc-worktree-root-link-"));
		const target = join(directory, "target");
		const linked = join(directory, "linked");
		await mkdir(target);
		await symlink(target, linked);
		try {
			await expect(
				runWorktreeCommand({ root: linked, platform: "posix", action: "list", json: false, dryRun: false }),
			).resolves.toEqual({
				stdout: "",
				stderr: "error: managed worktree root cannot be read\n",
				exitCode: 1,
			});
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});
	test("processes every sibling at maximum depth", async () => {
		await withRoot(async root => {
			const parent = join(root, "parent");
			await mkdir(join(parent, "left"), { recursive: true });
			await mkdir(join(parent, "right"), { recursive: true });
			await mkdir(join(parent, "occupied"), { recursive: true });
			await writeFile(join(parent, "occupied", "note.txt"), "content");
			const result = await scanWorktrees({ root, platform: "posix" });
			expect(new Map(result.map(entry => [entry.path, entry.reasonCode]))).toEqual(
				new Map([
					[renderedPath(join(parent, "left")), "empty"],
					[renderedPath(join(parent, "right")), "empty"],
					[renderedPath(join(parent, "occupied")), "stray"],
				]),
			);
		});
	});

	posixTest("rejects pointers outside the managed root and non-reciprocal metadata", async () => {
		await withRoot(async root => {
			const candidate = join(root, "candidate");
			const target = join(tmpdir(), "gjc-worktree-outside-target");
			await mkdir(candidate);
			await writeFile(join(candidate, ".git"), `gitdir: ${target}\n`);
			const result = await scanWorktrees({ root, platform: "posix" });
			expect(result[0]?.reasonCode).toBe("pointer-outside-root");
			expect(JSON.stringify(result)).not.toContain(target);
		});
	});

	test("exposes typed root-invalid and root-unreadable failures", async () => {
		const directory = await mkdtemp(join(tmpdir(), "gjc-worktree-file-"));
		const file = join(directory, "root");
		await writeFile(file, "not a directory");
		try {
			const invalid = await scanWorktrees({ root: file, platform: "posix" }).catch(error => error);
			expect(invalid).toBeInstanceOf(WorktreeRootError);
			expect((invalid as WorktreeRootError).code).toBe("root-invalid");
			const root = join(directory, "unreadable");
			await mkdir(root);
			const actualLstat = fsPromises.lstat;
			const lstatImplementation = (async (target: Parameters<typeof fsPromises.lstat>[0]) => {
				if (String(target) === root) throw Object.assign(new Error("synthetic root failure"), { code: "EPERM" });
				return actualLstat(target, { bigint: true });
			}) as typeof fsPromises.lstat;
			const lstatSpy = spyOn(fsPromises, "lstat").mockImplementation(lstatImplementation);
			try {
				const unreadable = await scanWorktrees({ root, platform: "posix" }).catch(error => error);
				expect(unreadable).toBeInstanceOf(WorktreeRootError);
				expect((unreadable as WorktreeRootError).code).toBe("root-unreadable");
			} finally {
				lstatSpy.mockRestore();
			}
			const racedRoot = join(directory, "raced");
			await mkdir(racedRoot);
			let rootChecks = 0;
			const raceImplementation = (async (target: Parameters<typeof fsPromises.lstat>[0]) => {
				const stat = await actualLstat(target, { bigint: true });
				if (String(target) !== racedRoot || ++rootChecks < 2) return stat;
				return symbolicDirectory(stat);
			}) as typeof fsPromises.lstat;
			const raceSpy = spyOn(fsPromises, "lstat").mockImplementation(raceImplementation);
			try {
				const raced = await scanWorktrees({ root: racedRoot, platform: "posix" }).catch(error => error);
				expect(raced).toBeInstanceOf(WorktreeRootError);
				expect((raced as WorktreeRootError).code).toBe("root-invalid");
			} finally {
				raceSpy.mockRestore();
			}
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});

	test("performs zero child-path inspection for Windows candidates", async () => {
		await withRoot(async root => {
			const candidate = join(root, "candidate");
			const external = join(root, "external");
			await mkdir(candidate);
			await mkdir(external);
			await symlink(external, join(candidate, ".git"), process.platform === "win32" ? "junction" : "dir");
			await symlink(external, join(candidate, "merged"), process.platform === "win32" ? "junction" : "dir");
			const candidatePrefix = join(candidate, "child").slice(0, -"child".length);
			const externalPrefix = join(external, "child").slice(0, -"child".length);
			const lstatSpy = spyOn(fsPromises, "lstat");
			try {
				const result = await scanWorktrees({ root, platform: "win32" });
				expect(result).toEqual([
					{
						path: renderedPath(candidate),
						kind: "unsupported",
						reasonCode: "unsupported-platform-proof",
						message: "no-follow metadata proof unavailable on Windows; preserved",
					},
					{
						path: renderedPath(external),
						kind: "unsupported",
						reasonCode: "unsupported-platform-proof",
						message: "no-follow metadata proof unavailable on Windows; preserved",
					},
				]);
				expect(result.some(entry => entry.reasonCode === "unsupported-link")).toBe(false);
				expect(
					lstatSpy.mock.calls.some(call => {
						const inspected = String(call[0]);
						return inspected.startsWith(candidatePrefix) || inspected.startsWith(externalPrefix);
					}),
				).toBe(false);
			} finally {
				lstatSpy.mockRestore();
			}
		});
	});

	posixTest("requires exact reciprocal metadata inside the managed root", async () => {
		await withRoot(async root => {
			const candidate = join(root, "candidate");
			const target = join(candidate, "meta", "worktrees", "one");
			await mkdir(target, { recursive: true });
			await writeFile(join(candidate, ".git"), `gitdir: ${target}\n`);
			await writeFile(join(target, "HEAD"), "ref: refs/heads/topic\n");
			await writeFile(join(target, "commondir"), "../..\n");
			const missing = await scanWorktrees({ root, platform: "posix" });
			expect(missing.some(entry => entry.reasonCode === "metadata-raced")).toBe(true);
			await writeFile(join(target, "gitdir"), `${join(candidate, "wrong")}\n`);
			const mismatched = await scanWorktrees({ root, platform: "posix" });
			expect(mismatched.some(entry => entry.reasonCode === "invalid-pointer")).toBe(true);
		});
		await withRoot(async root => {
			const candidate = join(root, "outside-reciprocal");
			const target = join(candidate, "meta", "worktrees", "one");
			const outside = join(tmpdir(), "gjc-outside-reciprocal");
			await mkdir(target, { recursive: true });
			await writeFile(join(candidate, ".git"), `gitdir: ${target}\n`);
			await writeFile(join(target, "HEAD"), "ref: refs/heads/topic\n");
			await writeFile(join(target, "commondir"), "../..\n");
			await writeFile(join(target, "gitdir"), `${outside}\n`);
			const result = await scanWorktrees({ root, platform: "posix" });
			expect(result.some(entry => entry.reasonCode === "invalid-pointer")).toBe(true);
			expect(JSON.stringify(result)).not.toContain(outside);
		});
	});

	test("stops at the sixteenth metadata reservation", async () => {
		await withRoot(async root => {
			for (let index = 0; index < 16; index++) {
				const candidate = join(root, `candidate-${String(index).padStart(2, "0")}`);
				await mkdir(candidate);
				await writeFile(join(candidate, ".git"), `gitdir: ${join(root, "missing", String(index))}\n`);
			}
			const result = await scanWorktrees({ root, platform: "posix" });
			expect(result).toHaveLength(16);
			expect(result.slice(0, 15).every(entry => entry.reasonCode !== "overflow")).toBe(true);
			expect(result[15]).toMatchObject({ kind: "overflow", reasonCode: "overflow" });
		});
	});

	test("fails closed when O_NOFOLLOW is unavailable", async () => {
		await withRoot(async root => {
			const candidate = join(root, "no-follow-unavailable");
			await mkdir(candidate);
			await writeFile(join(candidate, ".git"), "malformed");
			const original = constants.O_NOFOLLOW;
			Object.defineProperty(constants, "O_NOFOLLOW", { value: undefined, configurable: true, writable: true });
			try {
				await expect(scanWorktrees({ root, platform: "posix" })).resolves.toEqual([
					{
						path: renderedPath(candidate),
						kind: "unsupported",
						reasonCode: "unsupported-platform-proof",
						message: "no-follow metadata proof unavailable; preserved",
					},
				]);
			} finally {
				Object.defineProperty(constants, "O_NOFOLLOW", { value: original, configurable: true, writable: true });
			}
		});
	});
	test("fails closed when O_NONBLOCK is unavailable", async () => {
		await withRoot(async root => {
			const candidate = join(root, "non-blocking-unavailable");
			await mkdir(candidate);
			await writeFile(join(candidate, ".git"), "malformed");
			const originalNoFollow = constants.O_NOFOLLOW;
			const originalNonBlock = constants.O_NONBLOCK;
			const safeNoFollow = typeof originalNoFollow === "number" ? originalNoFollow : 0;
			Object.defineProperty(constants, "O_NOFOLLOW", { value: safeNoFollow, configurable: true, writable: true });
			Object.defineProperty(constants, "O_NONBLOCK", { value: undefined, configurable: true, writable: true });
			let statCalls = 0;
			let readCalls = 0;
			let closeCalls = 0;
			const openSpy = spyOn(fsPromises, "open").mockImplementation(async () => {
				return {
					stat: async () => {
						statCalls++;
						throw new Error("unexpected stat call");
					},
					read: async () => {
						readCalls++;
						throw new Error("unexpected read call");
					},
					close: async () => {
						closeCalls++;
					},
				} as unknown as FileHandle;
			});
			const allocationSpy = spyOn(Buffer, "allocUnsafe");
			try {
				const result = await scanWorktrees({ root, platform: "posix" });
				expect(result).toEqual([
					{
						path: renderedPath(candidate),
						kind: "unsupported",
						reasonCode: "unsupported-platform-proof",
						message: "non-blocking metadata proof unavailable; preserved",
					},
				]);
				expect(result.filter(entry => entry.reasonCode === "unsupported-platform-proof")).toHaveLength(1);
				expect(openSpy).not.toHaveBeenCalled();
				expect(statCalls).toBe(0);
				expect(readCalls).toBe(0);
				expect(closeCalls).toBe(0);
				expect(allocationSpy).not.toHaveBeenCalled();
			} finally {
				allocationSpy.mockRestore();
				openSpy.mockRestore();
				Object.defineProperty(constants, "O_NOFOLLOW", {
					value: originalNoFollow,
					configurable: true,
					writable: true,
				});
				Object.defineProperty(constants, "O_NONBLOCK", {
					value: originalNonBlock,
					configurable: true,
					writable: true,
				});
			}
		});
	});
	posixTest("never opens final-component links and revalidates pointer ancestors", async () => {
		await withRoot(async root => {
			const candidate = join(root, "linked-git");
			const external = join(root, "external-metadata");
			await mkdir(candidate);
			await writeFile(external, "malformed");
			await symlink(external, join(candidate, ".git"));
			const openSpy = spyOn(fsPromises, "open");
			try {
				const result = await scanWorktrees({ root, platform: "posix" });
				expect(result.find(entry => entry.path === renderedPath(candidate))?.reasonCode).toBe("unsupported-link");
				expect(openSpy).not.toHaveBeenCalled();
			} finally {
				openSpy.mockRestore();
			}
		});
		await withRoot(async root => {
			const candidate = join(root, "ancestor-race");
			const target = join(candidate, "meta", "worktrees", "one");
			await mkdir(target, { recursive: true });
			await writeFile(join(candidate, ".git"), `gitdir: ${target}\n`);
			await writeFile(join(target, "commondir"), "../..\n");
			await writeFile(join(target, "HEAD"), "ref: refs/heads/topic\n");
			await writeFile(join(target, "gitdir"), `${join(candidate, ".git")}\n`);
			const actualLstat = fsPromises.lstat;
			let targetChecks = 0;
			const lstatImplementation = (async (inspected: Parameters<typeof fsPromises.lstat>[0]) => {
				const stat = await actualLstat(inspected, { bigint: true });
				if (String(inspected) !== target || ++targetChecks < 2) return stat;
				return symbolicDirectory(stat);
			}) as typeof fsPromises.lstat;
			const lstatSpy = spyOn(fsPromises, "lstat").mockImplementation(lstatImplementation);
			try {
				const result = await scanWorktrees({ root, platform: "posix" });
				expect(result.some(entry => entry.reasonCode === "unsupported-link")).toBe(true);
				expect(result.some(entry => entry.reasonCode === "normal-pr")).toBe(false);
			} finally {
				lstatSpy.mockRestore();
			}
		});
		await withRoot(async root => {
			const candidate = join(root, "primary-ancestor-race");
			await mkdir(candidate);
			await writeFile(join(candidate, ".git"), "malformed");
			const actualLstat = fsPromises.lstat;
			let candidateChecks = 0;
			const lstatImplementation = (async (inspected: Parameters<typeof fsPromises.lstat>[0]) => {
				const stat = await actualLstat(inspected, { bigint: true });
				if (String(inspected) !== candidate || ++candidateChecks < 3) return stat;
				return symbolicDirectory(stat);
			}) as typeof fsPromises.lstat;
			const lstatSpy = spyOn(fsPromises, "lstat").mockImplementation(lstatImplementation);
			try {
				const result = await scanWorktrees({ root, platform: "posix" });
				expect(result.find(entry => entry.path === renderedPath(candidate))?.reasonCode).toBe("unsupported-link");
				expect(result.some(entry => entry.reasonCode === "malformed-gitfile")).toBe(false);
			} finally {
				lstatSpy.mockRestore();
			}
		});
	});

	test("distinguishes directory I/O failures from path races", async () => {
		await withRoot(async root => {
			const candidate = join(root, "candidate-io");
			await mkdir(candidate);
			const actualLstat = fsPromises.lstat;
			const lstatImplementation = (async (inspected: Parameters<typeof fsPromises.lstat>[0]) => {
				if (String(inspected) === candidate)
					throw Object.assign(new Error("synthetic candidate failure"), { code: "EPERM" });
				return actualLstat(inspected, { bigint: true });
			}) as typeof fsPromises.lstat;
			const lstatSpy = spyOn(fsPromises, "lstat").mockImplementation(lstatImplementation);
			try {
				const result = await scanWorktrees({ root, platform: "posix" });
				expect(result.find(entry => entry.path === renderedPath(candidate))).toMatchObject({
					kind: "unsupported",
					reasonCode: "scan-error",
					message: "cannot inspect directory; preserved",
				});
			} finally {
				lstatSpy.mockRestore();
			}
		});
		await withRoot(async root => {
			const nested = join(root, "nested-io");
			await mkdir(nested);
			const actualReaddir = fsPromises.readdir;
			const readdirImplementation = (async (inspected: Parameters<typeof fsPromises.readdir>[0]) => {
				if (String(inspected) === nested)
					throw Object.assign(new Error("synthetic nested failure"), { code: "EIO" });
				return actualReaddir(inspected, { withFileTypes: true, encoding: "buffer" });
			}) as unknown as typeof fsPromises.readdir;
			const readdirSpy = spyOn(fsPromises, "readdir").mockImplementation(readdirImplementation);
			try {
				const result = await scanWorktrees({ root, platform: "posix" });
				expect(result.find(entry => entry.path === renderedPath(nested))).toMatchObject({
					kind: "unsupported",
					reasonCode: "scan-error",
					message: "cannot inspect directory; preserved",
				});
			} finally {
				readdirSpy.mockRestore();
			}
		});
	});

	posixTest("proves exact 15-of-16 metadata reservation operations", async () => {
		await withRoot(async root => {
			for (let index = 0; index < 16; index++) {
				const candidate = join(root, `protocol-${String(index).padStart(2, "0")}`);
				await mkdir(candidate);
				await writeFile(join(candidate, ".git"), `gitdir: ${join(root, "missing", String(index))}\n`);
			}
			const operations: string[] = [];
			const reads: Array<{ file: string; offset: number; length: number; position: number }> = [];
			const actualAllocUnsafe = Buffer.allocUnsafe;
			const allocationSpy = spyOn(Buffer, "allocUnsafe").mockImplementation(size => {
				operations.push("allocate");
				return actualAllocUnsafe(size);
			});
			const lstatSpy = spyOn(fsPromises, "lstat");
			const actualOpen = fsPromises.open;
			const openFlags: unknown[] = [];
			const openSpy = spyOn(fsPromises, "open").mockImplementation(async (target, flags) => {
				const file = String(target);
				operations.push(`open:${file}`);
				openFlags.push(flags);
				const handle = await actualOpen(target, flags);
				return {
					stat: async (_options: { bigint: true }) => {
						operations.push(`stat:${file}`);
						return handle.stat({ bigint: true });
					},
					read: async (buffer: Buffer, offset: number, length: number, position: number) => {
						operations.push(`read:${file}`);
						reads.push({ file, offset, length, position });
						return handle.read(buffer, offset, length, position);
					},
					close: async () => {
						operations.push(`close:${file}`);
						await handle.close();
					},
				} as unknown as FileHandle;
			});
			try {
				const result = await scanWorktrees({ root, platform: "posix" });
				const overflowPath = result.find(entry => entry.kind === "overflow")?.path;
				expect(overflowPath).toBeDefined();
				const gitLstatCalls = lstatSpy.mock.calls.filter(call => String(call[0]).endsWith("/.git"));
				expect(gitLstatCalls).toHaveLength(16);
				expect(new Set(gitLstatCalls.map(call => String(call[0])))).toHaveLength(16);
				expect(gitLstatCalls.every(call => String(call[0]).endsWith("/.git"))).toBe(true);
				expect(operations.filter(operation => operation.startsWith("open:"))).toHaveLength(15);
				expect(
					openFlags.every(flags => flags === (constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)),
				).toBe(true);
				expect(operations.filter(operation => operation.startsWith("stat:"))).toHaveLength(15);
				expect(
					new Set(
						operations.filter(operation => operation.startsWith("read:")).map(operation => operation.slice(5)),
					),
				).toHaveLength(15);
				expect(operations.filter(operation => operation.startsWith("close:"))).toHaveLength(15);
				expect(allocationSpy).toHaveBeenCalledTimes(15);
				expect(allocationSpy.mock.calls.every(call => call[0] === MAX_METADATA_BYTES + 1)).toBe(true);
				expect(operations).toHaveLength(90);
				for (let index = 0; index < 15; index++) {
					const sequence = operations.slice(index * 6, index * 6 + 6);
					expect(sequence.map(operation => operation.split(":")[0])).toEqual([
						"open",
						"stat",
						"allocate",
						"read",
						"read",
						"close",
					]);
					const file = sequence[0]!.slice("open:".length);
					expect(sequence[1]).toBe(`stat:${file}`);
					expect(sequence[3]).toBe(`read:${file}`);
					expect(sequence[4]).toBe(`read:${file}`);
					expect(sequence[5]).toBe(`close:${file}`);
					const fileReads = reads.filter(read => read.file === file);
					expect(fileReads).toHaveLength(2);
					expect(fileReads[0]).toMatchObject({ offset: 0, position: 0, length: CHUNK_BYTES_FOR_TEST });
					expect(fileReads[1]!.offset).toBe(fileReads[1]!.position);
					expect(fileReads[1]!.offset).toBeGreaterThan(0);
					expect(fileReads[1]!.length).toBeGreaterThan(0);
					expect(fileReads[1]!.length).toBeLessThanOrEqual(CHUNK_BYTES_FOR_TEST);
				}
				const overflowGit = `${overflowPath}/.git`;
				expect(gitLstatCalls.some(call => String(call[0]) === overflowGit)).toBe(true);
				expect(operations).not.toContain(`open:${overflowGit}`);
			} finally {
				lstatSpy.mockRestore();
				openSpy.mockRestore();
				allocationSpy.mockRestore();
			}
		});
	});

	posixTest("does not refund a reservation after an open failure", async () => {
		await withRoot(async root => {
			for (let index = 0; index < 16; index++) {
				const candidate = join(root, `nonrefundable-${String(index).padStart(2, "0")}`);
				await mkdir(candidate);
				await writeFile(join(candidate, ".git"), `gitdir: ${join(root, "missing", String(index))}\n`);
			}
			const actualOpen = fsPromises.open;
			let openCalls = 0;
			const openSpy = spyOn(fsPromises, "open").mockImplementation(async (target, flags) => {
				openCalls++;
				if (openCalls === 1) throw Object.assign(new Error("synthetic open failure"), { code: "EPERM" });
				return actualOpen(target, flags);
			});
			try {
				const result = await scanWorktrees({ root, platform: "posix" });
				expect(openCalls).toBe(15);
				expect(result.filter(entry => entry.reasonCode === "unreadable-gitfile")).toHaveLength(1);
				expect(result.at(-1)).toMatchObject({ kind: "overflow", reasonCode: "overflow" });
			} finally {
				openSpy.mockRestore();
			}
		});
	});
	test.skipIf(process.platform === "win32")(
		"does not block when metadata is replaced by a FIFO before open",
		async () => {
			await withRoot(async root => {
				const candidate = join(root, "fifo-race");
				const gitFile = join(candidate, ".git");
				await mkdir(candidate);
				await writeFile(gitFile, "malformed");

				const actualOpen = fsPromises.open;
				let swapped = false;
				const openSpy = spyOn(fsPromises, "open").mockImplementation(async (target, flags) => {
					if (String(target) === gitFile && !swapped) {
						expect(flags).toBe(constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
						swapped = true;
						await rm(gitFile, { force: true });
						const mkfifo = Bun.spawnSync(["mkfifo", gitFile], {
							stdout: "ignore",
							stderr: "ignore",
						});
						if (mkfifo.exitCode !== 0) throw new Error("mkfifo failed");
					}
					return actualOpen(target, flags);
				});

				let timeout: NodeJS.Timeout | undefined;
				let scan: Promise<WorktreeDiagnostic[]> | undefined;
				const started = performance.now();
				try {
					scan = scanWorktrees({ root, platform: "posix" });
					const result = await Promise.race([
						scan,
						new Promise<never>((_, reject) => {
							timeout = setTimeout(() => reject(new Error("FIFO metadata open hung")), 2_000);
						}),
					]).catch(async error => {
						if (!(error instanceof Error) || error.message !== "FIFO metadata open hung") throw error;
						const rescue = await actualOpen(gitFile, constants.O_WRONLY | constants.O_NONBLOCK);
						let cleanupError: unknown;
						try {
							await scan;
						} catch (cause) {
							cleanupError = cause;
						}
						try {
							await rescue.close();
						} catch (cause) {
							cleanupError ??= cause;
						}
						if (cleanupError !== undefined) throw new AggregateError([error, cleanupError], error.message);
						throw error;
					});
					expect(performance.now() - started).toBeLessThan(2_000);
					expect(result).toEqual([
						{
							path: renderedPath(candidate),
							kind: "unsupported",
							reasonCode: "metadata-raced",
							message: "filesystem metadata changed during scan; preserved",
						},
					]);
					expect(swapped).toBe(true);
					expect((await fsPromises.lstat(gitFile)).isFIFO()).toBe(true);
					expect(await fsPromises.readdir(candidate)).toEqual([".git"]);
					expect(JSON.stringify(result)).not.toContain("malformed");
				} finally {
					if (timeout !== undefined) clearTimeout(timeout);
					openSpy.mockRestore();
				}
			});
		},
	);

	posixTest("maps open, stat, read, identity, and close failures by phase", async () => {
		const scenarios: Array<{
			name: string;
			openCode?: string;
			statCode?: string;
			readCodeAfterChunk?: string;
			identitySwap?: boolean;
			closeCode?: string;
			expected: string;
		}> = [
			{ name: "open link", openCode: "ELOOP", expected: "unsupported-link" },
			{ name: "open missing", openCode: "ENOENT", expected: "metadata-raced" },
			{ name: "open denied", openCode: "EPERM", expected: "unreadable-gitfile" },
			{ name: "handle stat race", statCode: "EBADF", expected: "metadata-raced" },
			{ name: "handle stat denied", statCode: "EPERM", expected: "unreadable-gitfile" },
			{ name: "identity swap", identitySwap: true, expected: "metadata-raced" },
			{ name: "read race", readCodeAfterChunk: "EBADF", expected: "metadata-raced" },
			{ name: "partial read failure", readCodeAfterChunk: "EPERM", expected: "unreadable-gitfile" },
			{
				name: "read race and close failure",
				readCodeAfterChunk: "EBADF",
				closeCode: "EIO",
				expected: "metadata-raced",
			},
			{ name: "close failure", closeCode: "EIO", expected: "unreadable-gitfile" },
		];
		for (const scenario of scenarios) {
			await withRoot(async root => {
				const candidate = join(root, scenario.name.replaceAll(" ", "-"));
				const gitFile = join(candidate, ".git");
				await mkdir(candidate);
				await writeFile(gitFile, "malformed");
				const stat = await fsPromises.lstat(gitFile, { bigint: true });
				let reads = 0;
				const openSpy = spyOn(fsPromises, "open").mockImplementation(async () => {
					if (scenario.openCode)
						throw Object.assign(new Error("synthetic open error"), { code: scenario.openCode });
					return {
						stat: async (_options: { bigint: true }) => {
							if (scenario.statCode)
								throw Object.assign(new Error("synthetic stat error"), { code: scenario.statCode });
							if (!scenario.identitySwap) return stat;
							return {
								dev: stat.dev,
								ino: stat.ino + 1n,
								isFile: () => true,
								isDirectory: () => false,
								isSymbolicLink: () => false,
							};
						},
						read: async (buffer: Buffer, offset: number) => {
							reads++;
							if (scenario.readCodeAfterChunk && reads > 1)
								throw Object.assign(new Error("synthetic read error"), {
									code: scenario.readCodeAfterChunk,
								});
							if (reads > 1) return { bytesRead: 0, buffer };
							const content = Buffer.from("malformed");
							content.copy(buffer, offset);
							return { bytesRead: content.length, buffer };
						},
						close: async () => {
							if (scenario.closeCode)
								throw Object.assign(new Error("synthetic close error"), { code: scenario.closeCode });
						},
					} as unknown as FileHandle;
				});
				try {
					const result = await scanWorktrees({ root, platform: "posix" });
					expect(result, scenario.name).toHaveLength(1);
					expect(result[0]?.reasonCode, scenario.name).toBe(scenario.expected);
				} finally {
					openSpy.mockRestore();
				}
			});
		}
	});
	posixTest(
		"covers every hostile HEAD, commondir, and reciprocal gitdir family failure in precedence order",
		async () => {
			const families = [
				{
					name: "HEAD",
					file: "HEAD",
					failures: [
						["unreadable", "unreadable-head", "unreadable"],
						["oversize", "oversize-head", Buffer.alloc(MAX_METADATA_BYTES + 1, 0x61)],
						["invalid-utf8", "invalid-utf8-head", Buffer.from([0xff])],
						["NUL", "nul-head", Buffer.from("ref: refs/heads/topic\0")],
						["malformed", "malformed-head", "not-a-head"],
					],
					later: ["unreadable-gitdir", "oversize-gitdir", "invalid-utf8-gitdir", "nul-gitdir", "invalid-pointer"],
				},
				{
					name: "commondir",
					file: "commondir",
					failures: [
						["unreadable", "unreadable-commondir", "unreadable"],
						["oversize", "oversize-commondir", Buffer.alloc(MAX_METADATA_BYTES + 1, 0x61)],
						["invalid-utf8", "invalid-utf8-commondir", Buffer.from([0xff])],
						["NUL", "nul-commondir", Buffer.from("../..\0")],
						["malformed", "common-dir", ""],
					],
					later: [
						"unreadable-head",
						"oversize-head",
						"invalid-utf8-head",
						"nul-head",
						"malformed-head",
						"unreadable-gitdir",
					],
				},
				{
					name: "gitdir",
					file: "gitdir",
					failures: [
						["unreadable", "unreadable-gitdir", "unreadable"],
						["oversize", "oversize-gitdir", Buffer.alloc(MAX_METADATA_BYTES + 1, 0x61)],
						["invalid-utf8", "invalid-utf8-gitdir", Buffer.from([0xff])],
						["NUL", "nul-gitdir", Buffer.from(`${join("/tmp", "candidate", ".git")}\0`)],
						["malformed", "invalid-pointer", ""],
					],
					later: [],
				},
			] as const;
			for (const family of families) {
				for (const [label, expected, content] of family.failures) {
					await withRoot(async root => {
						const candidate = join(root, `${family.name}-${label}`);
						const target = join(candidate, "meta", "worktrees", "one");
						await mkdir(target, { recursive: true });
						await writeFile(join(candidate, ".git"), `gitdir: ${target}\n`);
						await writeFile(join(target, "commondir"), "../..\n");
						await writeFile(join(target, "HEAD"), "ref: refs/heads/topic\n");
						await writeFile(join(target, "gitdir"), `${join(candidate, ".git")}\n`);
						await writeFile(join(target, family.file), content);
						if (family.name === "commondir") {
							await writeFile(join(target, "HEAD"), "not-a-head");
							await writeFile(join(target, "gitdir"), "");
						} else if (family.name === "HEAD") {
							await writeFile(join(target, "gitdir"), "");
						}
						const actualOpen = fsPromises.open;
						const openSpy = spyOn(fsPromises, "open").mockImplementation(async (filePath, flags) => {
							if (label === "unreadable" && String(filePath) === join(target, family.file))
								throw Object.assign(new Error("synthetic unreadable metadata"), { code: "EACCES" });
							return actualOpen(filePath, flags);
						});
						try {
							const result = await scanWorktrees({ root, platform: "posix" });
							const candidateResult = result.find(entry => entry.path === renderedPath(candidate));
							expect(candidateResult?.reasonCode, `${family.name}/${label}`).toBe(expected);
							expect(result.some(entry => family.later.some(reason => reason === entry.reasonCode))).toBe(false);
							expect(result.some(entry => entry.reasonCode === "normal-pr")).toBe(false);
						} finally {
							openSpy.mockRestore();
						}
					});
				}
			}
		},
	);

	posixTest("distinguishes 65536-byte metadata from a 65537-byte overflow read", async () => {
		await withRoot(async root => {
			const exact = join(root, "exact");
			const oversized = join(root, "oversized");
			const invalidUtf8 = join(root, "invalid-utf8");
			await mkdir(exact);
			await mkdir(oversized);
			await mkdir(invalidUtf8);
			await writeFile(join(exact, ".git"), Buffer.alloc(MAX_METADATA_BYTES, 0x61));
			await writeFile(join(oversized, ".git"), Buffer.alloc(MAX_METADATA_BYTES + 1, 0x61));
			await writeFile(join(invalidUtf8, ".git"), Buffer.from([0xff]));
			const result = await scanWorktrees({ root, platform: "posix" });
			expect(result.find(entry => entry.path === renderedPath(exact))?.reasonCode).toBe("malformed-gitfile");
			expect(result.find(entry => entry.path === renderedPath(oversized))?.reasonCode).toBe("oversize-gitfile");
			expect(result.find(entry => entry.path === renderedPath(invalidUtf8))?.reasonCode).toBe(
				"invalid-utf8-gitfile",
			);
		});
	});

	test("maps a non-ENOENT root failure to fixed text and JSON errors", async () => {
		const dir = await mkdtemp(join(tmpdir(), "gjc-worktree-worker-file-"));
		const file = join(dir, "root");
		await writeFile(file, "not a directory");
		try {
			await expect(
				runWorktreeCommand({ root: file, platform: "posix", action: "list", json: false, dryRun: false }),
			).resolves.toEqual({
				stdout: "",
				stderr: "error: managed worktree root cannot be read\n",
				exitCode: 1,
			});
			await expect(
				runWorktreeCommand({ root: file, platform: "posix", action: "list", json: true, dryRun: false }),
			).resolves.toEqual({
				stdout: '{"error":{"code":"worktree_scan_failed","message":"managed worktree root cannot be read"}}\n',
				stderr: "",
				exitCode: 1,
			});
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	test("escapes non-ASCII display paths and caps them at 512 bytes", async () => {
		await withRoot(async root => {
			const part = "한".repeat(50);
			await mkdir(join(root, part, part), { recursive: true });
			const result = await scanWorktrees({ root, platform: "posix" });
			expect(result.some(entry => entry.path.includes("\\uD55C"))).toBe(true);
			expect(result.every(entry => Buffer.byteLength(entry.path) <= 512)).toBe(true);
			expect(result.some(entry => entry.path.endsWith("…[truncated]"))).toBe(true);
			for (const entry of result.filter(candidate => candidate.path.endsWith("…[truncated]"))) {
				const prefix = entry.path.slice(0, -"…[truncated]".length);
				expect(prefix.replace(/\\(?:\\|n|r|t|u[0-9A-F]{4})/g, "")).not.toContain("\\");
			}
		});
	});

	test.skipIf(process.platform === "win32")("renders invalid raw names once without double escaping", async () => {
		await withRoot(async root => {
			await mkdir(join(root, "bad\\name"));
			const result = await scanWorktrees({ root, platform: "posix" });
			expect(result.find(entry => entry.path.includes("bad"))?.path).toBe(`${root}/bad\\\\name`);
		});
	});
	test("renders synthetic oversized raw names with an unambiguous truncation suffix", async () => {
		await withRoot(async root => {
			const raw = Buffer.alloc(MAX_NAME_UTF8_BYTES + 1, 0x61);
			const readdirSpy = spyOn(fsPromises, "readdir").mockResolvedValue([{ name: raw }] as never);
			try {
				const result = await scanWorktrees({ root, platform: "posix" });
				expect(result).toHaveLength(1);
				expect(result[0]?.reasonCode).toBe("oversize-name");
				expect(result[0]?.path.endsWith("…[truncated]")).toBe(true);
				expect(Buffer.byteLength(result[0]?.path ?? "")).toBeLessThanOrEqual(512);
			} finally {
				readdirSpy.mockRestore();
			}
		});
	});

	test("renders synthetic invalid UTF-8 bytes as uppercase percent escapes", async () => {
		await withRoot(async root => {
			const readdirSpy = spyOn(fsPromises, "readdir").mockResolvedValue([{ name: Buffer.from([0xff]) }] as never);
			try {
				const result = await scanWorktrees({ root, platform: "posix" });
				expect(result).toEqual([
					{
						path: `${renderedPath(root)}/%FF`,
						kind: "unsupported",
						reasonCode: "invalid-name",
						message: "invalid UTF-8 directory name; preserved",
					},
				]);
			} finally {
				readdirSpy.mockRestore();
			}
		});
	});
	test.skipIf(process.platform !== "linux")(
		"renders invalid UTF-8 directory bytes as uppercase percent escapes",
		async () => {
			await withRoot(async root => {
				const invalidBytePath = Buffer.concat([Buffer.from(`${root}/`), Buffer.from([0xff])]);
				await mkdir(invalidBytePath);
				const result = await scanWorktrees({ root, platform: "posix" });
				expect(
					result.some(entry => entry.path === renderedPath(`${root}/%FF`) && entry.reasonCode === "invalid-name"),
				).toBe(true);
			});
		},
	);

	posixTest("accepts relative CRLF pointers and detached HEAD metadata", async () => {
		await withRoot(async root => {
			const candidate = join(root, "relative");
			const target = join(candidate, "meta", "worktrees", "one");
			await mkdir(target, { recursive: true });
			await writeFile(join(candidate, ".git"), "gitdir: meta/worktrees/one\r\n");
			await writeFile(join(target, "commondir"), "../..\r\n");
			await writeFile(join(target, "HEAD"), `${"a".repeat(40)}\r\n`);
			await writeFile(join(target, "gitdir"), `${join(candidate, ".git")}\r\n`);
			await expect(scanWorktrees({ root, platform: "posix" })).resolves.toEqual([
				{
					path: renderedPath(candidate),
					kind: "pr-checkout",
					reasonCode: "normal-pr",
					message: "worktree metadata observed; preserved",
				},
			]);
		});
	});

	posixTest("uses frozen diagnostics for NUL, network pointers, and bare repositories", async () => {
		await withRoot(async root => {
			const nul = join(root, "nul");
			const network = join(root, "network");
			const bare = join(root, "bare");
			await mkdir(nul);
			await mkdir(network);
			await mkdir(join(bare, ".git"), { recursive: true });
			await writeFile(join(nul, ".git"), "gitdir: inside\0\n");
			await writeFile(join(network, ".git"), "gitdir: //server/share\n");
			const result = await scanWorktrees({ root, platform: "posix" });
			expect(result.find(entry => entry.path === renderedPath(nul))).toMatchObject({
				kind: "pr-checkout",
				reasonCode: "nul-gitfile",
				message: ".git file contains NUL; preserved",
			});
			expect(result.find(entry => entry.path === renderedPath(network))).toMatchObject({
				kind: "pr-checkout",
				reasonCode: "unc-network",
				message: "network gitdir pointer unsupported; preserved",
			});
			expect(result.find(entry => entry.path === renderedPath(bare))).toMatchObject({
				kind: "pr-checkout",
				reasonCode: "bare-repository",
				message: ".git directory observed; preserved",
			});
		});
	});

	posixTest("shares one exact 15-of-16 reservation protocol across metadata categories", async () => {
		await withRoot(async root => {
			const metadataPaths: string[] = [];
			for (let index = 0; index < 4; index++) {
				const candidate = join(root, `multi-${index}`);
				const target = join(candidate, "meta", "worktrees", "one");
				const git = join(candidate, ".git");
				const commondir = join(target, "commondir");
				const head = join(target, "HEAD");
				const reciprocal = join(target, "gitdir");
				metadataPaths.push(git, commondir, head, reciprocal);
				await mkdir(target, { recursive: true });
				await writeFile(git, `gitdir: ${target}\n`);
				await writeFile(commondir, "../..\n");
				await writeFile(head, "ref: refs/heads/topic\n");
				await writeFile(reciprocal, `${git}\n`);
			}
			const metadataSet = new Set(metadataPaths);
			const lstatSpy = spyOn(fsPromises, "lstat");
			const openSpy = spyOn(fsPromises, "open");
			const allocationSpy = spyOn(Buffer, "allocUnsafe");
			try {
				const result = await scanWorktrees({ root, platform: "posix" });
				const metadataLstats = lstatSpy.mock.calls.filter(call => metadataSet.has(String(call[0])));
				expect(metadataLstats).toHaveLength(16);
				const openedMetadataPaths = openSpy.mock.calls.map(call => String(call[0]));
				expect(openedMetadataPaths).toHaveLength(15);
				expect(allocationSpy).toHaveBeenCalledTimes(15);
				expect(openedMetadataPaths).toEqual(metadataLstats.slice(0, 15).map(call => String(call[0])));
				const rejectedMetadataPath = String(metadataLstats[15]?.[0]);
				expect(openedMetadataPaths).not.toContain(rejectedMetadataPath);
				expect(result.at(-1)).toMatchObject({ kind: "overflow", reasonCode: "overflow" });
				expect(result.filter(entry => entry.reasonCode === "normal-pr")).toHaveLength(3);
			} finally {
				lstatSpy.mockRestore();
				openSpy.mockRestore();
				allocationSpy.mockRestore();
			}
		});
	});

	posixTest("renders exact list and clear report-only output contracts", async () => {
		await withRoot(async root => {
			const candidate = join(root, "bare");
			await mkdir(join(candidate, ".git"), { recursive: true });
			await expect(
				runWorktreeCommand({ root, platform: "posix", action: "list", json: false, dryRun: false }),
			).resolves.toEqual({
				stdout: `diagnostic  ${candidate}  .git directory observed; preserved\n\n1 total\n`,
				stderr: "",
				exitCode: 0,
			});
			await expect(
				runWorktreeCommand({ root, platform: "posix", action: "clear", json: false, dryRun: false }),
			).resolves.toEqual({
				stdout: `kept    ${candidate}\n\n0 removed · 1 kept\n`,
				stderr: "",
				exitCode: 0,
			});
			await expect(
				runWorktreeCommand({ root, platform: "posix", action: "clear", json: true, dryRun: false }),
			).resolves.toEqual({
				stdout: '{"removed":0,"kept":1}\n',
				stderr: "",
				exitCode: 0,
			});
			await expect(
				runWorktreeCommand({ root, platform: "posix", action: "clear", json: true, dryRun: true }),
			).resolves.toEqual({
				stdout: '{"wouldRemove":[]}\n',
				stderr: "",
				exitCode: 0,
			});
		});
	});
});

describe("worktree command factory", () => {
	test("does not resolve the root for disabled cleanup modes", async () => {
		let getterCalls = 0;
		const Command = createWorktreeCommand(() => {
			getterCalls += 1;
			return "/should-not-be-read";
		});
		const stdout: string[] = [];
		const stderr: string[] = [];
		const stdoutSpy = spyOn(process.stdout, "write").mockImplementation(chunk => {
			stdout.push(String(chunk));
			return true;
		});
		const stderrSpy = spyOn(process.stderr, "write").mockImplementation(chunk => {
			stderr.push(String(chunk));
			return true;
		});
		const previousExitCode = process.exitCode;
		try {
			await new Command(["list", "--all", "--json"], {
				bin: "gjc",
				version: "test",
				commands: new Map(),
			}).run();
			expect(getterCalls).toBe(0);
			expect(stdout.join("")).toBe(
				'{"error":{"code":"worktree_cleanup_disabled","message":"worktree cleanup is report-only"}}\n',
			);
			expect(stderr).toEqual([]);
			expect(process.exitCode).toBe(2);
		} finally {
			process.exitCode = previousExitCode ?? 0;
			stdoutSpy.mockRestore();
			stderrSpy.mockRestore();
		}
	});

	test("resolves the root exactly once for every valid form", async () => {
		await withRoot(async root => {
			const cases: Array<{ argv: string[]; stdout: string }> = [
				{ argv: [], stdout: "No agent-managed worktrees found.\n" },
				{ argv: ["list"], stdout: "No agent-managed worktrees found.\n" },
				{ argv: ["list", "--json"], stdout: "[]\n" },
				{ argv: ["clear"], stdout: "No worktrees are eligible for removal; cleanup is report-only.\n" },
				{
					argv: ["clear", "--dry-run"],
					stdout: "No worktrees are eligible for removal; cleanup is report-only.\n",
				},
				{ argv: ["clear", "--json"], stdout: '{"removed":0,"kept":0}\n' },
				{ argv: ["clear", "--dry-run", "--json"], stdout: '{"wouldRemove":[]}\n' },
			];
			for (const item of cases) {
				let getterCalls = 0;
				const Command = createWorktreeCommand(() => {
					getterCalls++;
					return root;
				});
				const stdout: string[] = [];
				const stderr: string[] = [];
				const stdoutSpy = spyOn(process.stdout, "write").mockImplementation(chunk => {
					stdout.push(String(chunk));
					return true;
				});
				const stderrSpy = spyOn(process.stderr, "write").mockImplementation(chunk => {
					stderr.push(String(chunk));
					return true;
				});
				try {
					await new Command(item.argv, { bin: "gjc", version: "test", commands: new Map() }).run();
					expect(getterCalls, item.argv.join(" ")).toBe(1);
					expect(stdout.join(""), item.argv.join(" ")).toBe(item.stdout);
					expect(stderr, item.argv.join(" ")).toEqual([]);
				} finally {
					stdoutSpy.mockRestore();
					stderrSpy.mockRestore();
				}
			}
		});
	});

	test("rejects every disabled flag combination before resolving the root", async () => {
		for (const argv of [
			["--all"],
			["--dry-run"],
			["--all", "--dry-run"],
			["list", "--dry-run"],
			["list", "--all"],
			["list", "--all", "--dry-run"],
			["clear", "--all"],
			["clear", "--all", "--dry-run"],
			["list", "--", "--all"],
			["clear", "--", "--all"],
			["list", "--", "--dry-run"],
			["clear", "list"],
			["--all", "list"],
			["-n", "list"],
			["list", "clear"],
			["clear", "clear"],
		]) {
			let getterCalls = 0;
			const Command = createWorktreeCommand(() => {
				getterCalls++;
				return "/must-not-be-read";
			});
			const stdout: string[] = [];
			const stderr: string[] = [];
			const stdoutSpy = spyOn(process.stdout, "write").mockImplementation(chunk => {
				stdout.push(String(chunk));
				return true;
			});
			const stderrSpy = spyOn(process.stderr, "write").mockImplementation(chunk => {
				stderr.push(String(chunk));
				return true;
			});
			const previousExitCode = process.exitCode;
			try {
				await new Command(argv, { bin: "gjc", version: "test", commands: new Map() }).run();
				expect(getterCalls).toBe(0);
				expect(stdout).toEqual([]);
				expect(stderr.join("")).toBe("error: worktree cleanup is report-only\n");
				expect(process.exitCode).toBe(2);
			} finally {
				process.exitCode = previousExitCode ?? 0;
				stdoutSpy.mockRestore();
				stderrSpy.mockRestore();
			}
		}
	});

	test("renders every disabled JSON form without resolving the root", async () => {
		for (const argv of [
			["--all", "--json"],
			["--dry-run", "--json"],
			["--all", "--dry-run", "--json"],
			["list", "--dry-run", "--json"],
			["list", "--all", "--json"],
			["list", "--all", "--dry-run", "--json"],
			["clear", "--all", "--json"],
			["clear", "--all", "--dry-run", "--json"],
		]) {
			let getterCalls = 0;
			const Command = createWorktreeCommand(() => {
				getterCalls++;
				return "/must-not-be-read";
			});
			const stdout: string[] = [];
			const stderr: string[] = [];
			const stdoutSpy = spyOn(process.stdout, "write").mockImplementation(chunk => {
				stdout.push(String(chunk));
				return true;
			});
			const stderrSpy = spyOn(process.stderr, "write").mockImplementation(chunk => {
				stderr.push(String(chunk));
				return true;
			});
			const previousExitCode = process.exitCode;
			try {
				await new Command(argv, { bin: "gjc", version: "test", commands: new Map() }).run();
				expect(getterCalls, argv.join(" ")).toBe(0);
				expect(stdout.join(""), argv.join(" ")).toBe(
					'{"error":{"code":"worktree_cleanup_disabled","message":"worktree cleanup is report-only"}}\n',
				);
				expect(stderr, argv.join(" ")).toEqual([]);
				expect(process.exitCode, argv.join(" ")).toBe(2);
			} finally {
				process.exitCode = previousExitCode ?? 0;
				stdoutSpy.mockRestore();
				stderrSpy.mockRestore();
			}
		}
	});

	test("framework parse errors never resolve the root", async () => {
		let getterCalls = 0;
		const Command = createWorktreeCommand(() => {
			getterCalls++;
			return "/must-not-be-read";
		});
		await expect(
			new Command(["remove"], { bin: "gjc", version: "test", commands: new Map() }).run(),
		).rejects.toBeTruthy();
		expect(getterCalls).toBe(0);
	});

	test("publishes only report-only help and examples", () => {
		const Command = createWorktreeCommand(() => "/unused");
		expect(Command.description).toBe("List report-only diagnostics for agent-managed worktrees");
		expect(Command.flags?.all).toMatchObject({ description: "Unavailable: cleanup is report-only" });
		expect(Command.flags?.["dry-run"]).toMatchObject({ description: "Preview the report-only clear summary" });
		expect(Command.examples).toEqual([
			"gjc worktree",
			"gjc worktree list --json",
			"gjc worktree clear",
			"gjc worktree clear --dry-run",
		]);
	});

	test("renders the exact report-only help snapshot", async () => {
		const Command = createWorktreeCommand(() => "/unused");
		const stdout: string[] = [];
		const stdoutSpy = spyOn(process.stdout, "write").mockImplementation(chunk => {
			stdout.push(String(chunk));
			return true;
		});
		try {
			const commands: CommandEntry[] = [{ name: "worktree", aliases: ["wt"], load: async () => Command }];
			await run({ bin: "gjc", version: "test", argv: ["worktree", "--help"], commands });
			expect(stdout.join("")).toBe(`List report-only diagnostics for agent-managed worktrees

USAGE
  $ gjc worktree [ACTION] [FLAGS]

ARGUMENTS
  ACTION   list (default) or clear (list|clear)

FLAGS
      --all      Unavailable: cleanup is report-only
  -n, --dry-run  Preview the report-only clear summary
  -j, --json     Emit machine-readable JSON

EXAMPLES
  gjc worktree
  gjc worktree list --json
  gjc worktree clear
  gjc worktree clear --dry-run
`);
		} finally {
			stdoutSpy.mockRestore();
		}
	});
});
