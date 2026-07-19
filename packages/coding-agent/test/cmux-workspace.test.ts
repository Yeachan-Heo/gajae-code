import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	buildCmuxWorkspaceRenameCommand,
	type CmuxWorkspaceOwnership,
	formatCmuxWorkspaceTitle,
	parseCmuxWorkspaceOwnership,
	sanitizeCmuxWorkspaceTitle,
	shouldRenameCmuxWorkspace,
	syncCmuxWorkspaceTitle,
} from "../src/utils/cmux-workspace";

function cmuxEnv(workspaceId = "workspace-123", extra: Record<string, string> = {}): NodeJS.ProcessEnv {
	return { CMUX_WORKSPACE_ID: workspaceId, CMUX_SOCKET_PATH: "/tmp/cmux-test.sock", ...extra } as NodeJS.ProcessEnv;
}

const LIST_JSON = JSON.stringify({
	workspaces: [
		{ id: "AAAA-1111", ref: "workspace:1", title: "Other", has_custom_title: true },
		{ id: "DF98857C", ref: "workspace:8", title: "GJC: gajae-code", has_custom_title: true },
		{ id: "CCCC-9999", ref: "workspace:9", title: "~/dev/x", has_custom_title: false },
	],
});

describe("cmux workspace title sync", () => {
	let root: string;
	let lockDir: string;

	beforeEach(async () => {
		root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "gjc-cmux-workspace-test-")));
		lockDir = path.join(root, "locks");
	});

	afterEach(async () => {
		await fs.rm(root, { recursive: true, force: true });
	});

	it("builds an explicit workspace rename command with the GJC prefix", () => {
		expect(buildCmuxWorkspaceRenameCommand("Investigate Resolver", cmuxEnv())).toEqual({
			command: "cmux",
			args: ["workspace", "rename", "workspace-123", "--title", "GJC: Investigate Resolver"],
		});
	});

	it("skips when the current terminal is not a cmux workspace", () => {
		expect(buildCmuxWorkspaceRenameCommand("Investigate Resolver", {} as NodeJS.ProcessEnv)).toBeNull();
	});

	it("sanitizes control characters and whitespace", () => {
		expect(sanitizeCmuxWorkspaceTitle("  Fix\u0001\u001b  cmux\n\tworkspace  ")).toBe("Fix cmux workspace");
	});

	it("prefixes cmux workspace titles once", () => {
		expect(formatCmuxWorkspaceTitle("Investigate Resolver")).toBe("GJC: Investigate Resolver");
		expect(formatCmuxWorkspaceTitle("GJC: Investigate Resolver")).toBe("GJC: Investigate Resolver");
	});

	describe("parseCmuxWorkspaceOwnership", () => {
		it("matches by UUID id case-insensitively", () => {
			expect(parseCmuxWorkspaceOwnership(LIST_JSON, "df98857c")).toEqual({
				hasCustomTitle: true,
				title: "GJC: gajae-code",
			});
		});

		it("matches by workspace ref", () => {
			expect(parseCmuxWorkspaceOwnership(LIST_JSON, "workspace:9")).toEqual({
				hasCustomTitle: false,
				title: "~/dev/x",
			});
		});

		it("returns null for missing or malformed data", () => {
			expect(parseCmuxWorkspaceOwnership(LIST_JSON, "missing")).toBeNull();
			expect(parseCmuxWorkspaceOwnership("not json", "df98857c")).toBeNull();
		});
	});

	describe("shouldRenameCmuxWorkspace", () => {
		const current = (over: Partial<CmuxWorkspaceOwnership>): CmuxWorkspaceOwnership => ({
			hasCustomTitle: true,
			title: "current",
			...over,
		});

		it("fails closed when ownership is unknown or the title already matches", () => {
			expect(shouldRenameCmuxWorkspace(null, "GJC: Desired")).toBe(false);
			expect(shouldRenameCmuxWorkspace(current({ title: "GJC: Desired" }), "GJC: Desired")).toBe(false);
		});

		it("allows a default workspace to be claimed", () => {
			expect(shouldRenameCmuxWorkspace(current({ hasCustomTitle: false }), "GJC: Desired")).toBe(true);
		});

		it("requires an exact last verified title for custom-title updates", () => {
			const ownership = current({ title: "GJC: Session A" });
			expect(shouldRenameCmuxWorkspace(ownership, "GJC: Session B")).toBe(false);
			expect(shouldRenameCmuxWorkspace(ownership, "GJC: Session B", "GJC: Other")).toBe(false);
			expect(shouldRenameCmuxWorkspace(ownership, "GJC: Session B", "GJC: Session A")).toBe(true);
			expect(
				shouldRenameCmuxWorkspace(current({ title: "GJC: Session A " }), "GJC: Session B", "GJC: Session A"),
			).toBe(false);
		});
	});

	it("skips outside a tty and honors GJC_NO_CMUX_RENAME", async () => {
		let spawned = false;
		const options = {
			env: cmuxEnv(),
			isTty: false,
			lockDir,
			which: () => "/usr/local/bin/cmux",
			readOwnership: async () => ({ hasCustomTitle: false, title: "default" }),
			spawn: () => {
				spawned = true;
				return { exited: Promise.resolve(0), kill: () => {}, unref: () => {} };
			},
		};
		await syncCmuxWorkspaceTitle("Investigate Resolver", options);
		await syncCmuxWorkspaceTitle("Investigate Resolver", {
			...options,
			isTty: true,
			env: cmuxEnv("workspace-123", { GJC_NO_CMUX_RENAME: "1" }),
		});
		expect(spawned).toBe(false);
	});

	it("claims a default workspace, verifies it, and follows later renames in the same process", async () => {
		const claims = new Map<string, string>();
		const calls: string[][] = [];
		let title = "~/dev/x";
		let hasCustomTitle = false;
		const options = {
			env: cmuxEnv("ws-owned"),
			isTty: true,
			lockDir,
			claims,
			which: () => "/usr/local/bin/cmux",
			readOwnership: async () => ({ hasCustomTitle, title }),
			spawn: (command: string[]) => {
				calls.push(command);
				title = command.at(-1) ?? "";
				hasCustomTitle = true;
				return { exited: Promise.resolve(0), kill: () => {}, unref: () => {} };
			},
		};

		await syncCmuxWorkspaceTitle("Session A", options);
		await syncCmuxWorkspaceTitle("Session A renamed", options);

		expect(calls).toEqual([
			["/usr/local/bin/cmux", "workspace", "rename", "ws-owned", "--title", "GJC: Session A"],
			["/usr/local/bin/cmux", "workspace", "rename", "ws-owned", "--title", "GJC: Session A renamed"],
		]);
		expect(claims.size).toBe(1);
		expect((await fs.stat(lockDir)).mode & 0o777).toBe(0o700);
	});
	it("bounds process-lifetime claims", async () => {
		const claims = new Map<string, string>();
		for (let index = 0; index < 40; index++) {
			let reads = 0;
			const desired = `GJC: Session ${index}`;
			await syncCmuxWorkspaceTitle(`Session ${index}`, {
				env: cmuxEnv(`workspace-${index}`),
				isTty: true,
				lockDir,
				claims,
				which: () => "/usr/local/bin/cmux",
				readOwnership: async () => {
					reads++;
					return reads === 1
						? { hasCustomTitle: false, title: "default" }
						: { hasCustomTitle: true, title: desired };
				},
				spawn: () => ({ exited: Promise.resolve(0), kill: () => {}, unref: () => {} }),
			});
		}
		expect(claims.size).toBe(32);
	});

	it("keeps ownership across fork or branch identity changes in the same process", async () => {
		const claims = new Map<string, string>();
		const calls: string[][] = [];
		let title = "default";
		let hasCustomTitle = false;
		const options = {
			env: cmuxEnv("ws-fork"),
			isTty: true,
			lockDir,
			claims,
			which: () => "/usr/local/bin/cmux",
			readOwnership: async () => ({ hasCustomTitle, title }),
			spawn: (command: string[]) => {
				calls.push(command);
				title = command.at(-1) ?? "";
				hasCustomTitle = true;
				return { exited: Promise.resolve(0), kill: () => {}, unref: () => {} };
			},
		};

		await syncCmuxWorkspaceTitle("Parent session", options);
		await syncCmuxWorkspaceTitle("Branched session", options);
		expect(calls).toHaveLength(2);
	});

	it("revokes its claim after a user or peer changes the title, including a GJC-prefixed title", async () => {
		const claims = new Map<string, string>();
		const calls: string[][] = [];
		let title = "default";
		let hasCustomTitle = false;
		const options = {
			env: cmuxEnv("ws-pinned"),
			isTty: true,
			lockDir,
			claims,
			which: () => "/usr/local/bin/cmux",
			readOwnership: async () => ({ hasCustomTitle, title }),
			spawn: (command: string[]) => {
				calls.push(command);
				title = command.at(-1) ?? "";
				hasCustomTitle = true;
				return { exited: Promise.resolve(0), kill: () => {}, unref: () => {} };
			},
		};

		await syncCmuxWorkspaceTitle("Owned", options);
		title = "GJC: Peer desired";
		await syncCmuxWorkspaceTitle("Peer desired", options);
		title = "GJC: Owned";
		await syncCmuxWorkspaceTitle("Claim stays revoked", options);

		expect(calls).toHaveLength(1);
		expect(claims.size).toBe(0);
	});

	it("does not claim on exit-zero without an exact post-rename readback", async () => {
		const claims = new Map<string, string>();
		let reads = 0;
		await syncCmuxWorkspaceTitle("Desired", {
			env: cmuxEnv("ws-noop"),
			isTty: true,
			lockDir,
			claims,
			which: () => "/usr/local/bin/cmux",
			readOwnership: async () => {
				reads++;
				return reads === 1
					? { hasCustomTitle: false, title: "default" }
					: { hasCustomTitle: true, title: "Wrong target" };
			},
			spawn: () => ({ exited: Promise.resolve(0), kill: () => {}, unref: () => {} }),
		});
		expect(reads).toBe(2);
		expect(claims.size).toBe(0);
	});
	it("rejects parseable workspace-list output from a non-zero process", async () => {
		const fakeCmux = path.join(root, "failing-cmux.ts");
		await Bun.write(
			fakeCmux,
			`#!/usr/bin/env bun
process.stdout.write(JSON.stringify({ workspaces: [{ id: "ws-list-fail", title: "default", has_custom_title: false }] }));
process.exit(1);
`,
		);
		await fs.chmod(fakeCmux, 0o700);
		let renamed = false;
		await syncCmuxWorkspaceTitle("Must not rename", {
			env: cmuxEnv("ws-list-fail"),
			isTty: true,
			lockDir,
			claims: new Map(),
			which: () => fakeCmux,
			spawn: () => {
				renamed = true;
				return { exited: Promise.resolve(0), kill: () => {}, unref: () => {} };
			},
		});
		expect(renamed).toBe(false);
	});
	it("force-kills a timed-out rename, releases the lock, and records no claim", async () => {
		const claims = new Map<string, string>();
		const exited = new Promise<number>(() => {});
		let killedWith: number | NodeJS.Signals | undefined;
		const started = Date.now();
		await syncCmuxWorkspaceTitle("Timeout", {
			env: cmuxEnv("ws-timeout"),
			isTty: true,
			lockDir,
			claims,
			which: () => "/usr/local/bin/cmux",
			readOwnership: async () => ({ hasCustomTitle: false, title: "default" }),
			spawn: () => ({
				exited,
				kill: signal => {
					killedWith = signal;
				},
				unref: () => {},
			}),
		});
		expect(killedWith).toBe("SIGKILL");
		expect(Date.now() - started).toBeLessThan(2_500);
		expect(claims.size).toBe(0);
		expect(await fs.readdir(lockDir)).toEqual([]);
	});

	it("refuses a symlinked lock directory", async () => {
		const target = path.join(root, "real-locks");
		const symlink = path.join(root, "linked-locks");
		await fs.mkdir(target);
		await fs.symlink(target, symlink);
		let spawned = false;
		await syncCmuxWorkspaceTitle("Desired", {
			env: cmuxEnv("ws-symlink"),
			isTty: true,
			lockDir: symlink,
			claims: new Map(),
			which: () => "/usr/local/bin/cmux",
			readOwnership: async () => ({ hasCustomTitle: false, title: "default" }),
			spawn: () => {
				spawned = true;
				return { exited: Promise.resolve(0), kill: () => {}, unref: () => {} };
			},
		});
		expect(spawned).toBe(false);
	});

	it("serializes real peer processes and leaves no durable ownership claim after restart", async () => {
		const fakeCmux = path.join(root, "fake-cmux.ts");
		const stateFile = path.join(root, "workspace.json");
		const logFile = path.join(root, "renames.log");
		await Bun.write(stateFile, JSON.stringify({ title: "default", hasCustomTitle: false }));
		await Bun.write(
			fakeCmux,
			`#!/usr/bin/env bun
const fs = await import("node:fs/promises");
const args = process.argv.slice(2);
const stateFile = process.env.FAKE_CMUX_STATE;
const logFile = process.env.FAKE_CMUX_LOG;
if (!stateFile || !logFile) process.exit(2);
const state = JSON.parse(await Bun.file(stateFile).text());
if (args[0] === "workspace" && args[1] === "list") {
  process.stdout.write(JSON.stringify({ workspaces: [{ id: "ws-real", ref: "workspace:1", title: state.title, has_custom_title: state.hasCustomTitle }] }));
  process.exit(0);
}
if (args[0] === "workspace" && args[1] === "rename") {
  const title = args.at(-1);
  await Bun.sleep(75);
  await Bun.write(stateFile, JSON.stringify({ title, hasCustomTitle: true }));
  await fs.appendFile(logFile, title + "\\n");
  process.exit(0);
}
process.exit(3);
`,
		);
		await fs.chmod(fakeCmux, 0o700);

		const modulePath = path.resolve(import.meta.dir, "../src/utils/cmux-workspace.ts");
		const childCode = `import { syncCmuxWorkspaceTitle } from ${JSON.stringify(modulePath)};
await syncCmuxWorkspaceTitle(process.env.SESSION_NAME, { isTty: true, lockDir: process.env.CMUX_LOCK_DIR, which: () => process.env.FAKE_CMUX, env: process.env });`;
		const childEnv = (name: string): NodeJS.ProcessEnv => ({
			...process.env,
			SESSION_NAME: name,
			CMUX_WORKSPACE_ID: "ws-real",
			CMUX_SOCKET_PATH: path.join(root, "cmux.sock"),
			CMUX_LOCK_DIR: lockDir,
			FAKE_CMUX: fakeCmux,
			FAKE_CMUX_STATE: stateFile,
			FAKE_CMUX_LOG: logFile,
		});
		const runChild = (name: string) =>
			Bun.spawn([process.execPath, "-e", childCode], {
				env: childEnv(name),
				stdout: "pipe",
				stderr: "pipe",
			});
		await fs.mkdir(lockDir, { mode: 0o700 });
		const key = `${path.join(root, "cmux.sock")}\u0000ws-real`;
		const guardFile = path.join(lockDir, `${crypto.createHash("sha256").update(key).digest("hex")}.guard`);
		const readyFile = path.join(root, "stale-lock-ready");
		const fileLockPath = path.resolve(import.meta.dir, "../src/config/file-lock.ts");
		const staleOwner = Bun.spawn(
			[
				process.execPath,
				"-e",
				`import { withFileLock } from ${JSON.stringify(fileLockPath)};
await withFileLock(process.env.GUARD_FILE, async () => {
	await Bun.write(process.env.READY_FILE, "ready");
	await Bun.sleep(60_000);
});`,
			],
			{
				env: { ...process.env, GUARD_FILE: guardFile, READY_FILE: readyFile },
				stdout: "pipe",
				stderr: "pipe",
			},
		);
		const readyDeadline = Date.now() + 5_000;
		while (!(await Bun.file(readyFile).exists())) {
			if (Date.now() > readyDeadline) throw new Error("stale lock owner did not acquire the guard");
			await Bun.sleep(10);
		}
		staleOwner.kill();
		await staleOwner.exited;
		const recovered = runChild("Recovered session");
		expect(await recovered.exited).toBe(0);
		expect((await Bun.file(logFile).text()).trim().split("\n")).toHaveLength(1);
		expect(await fs.readdir(lockDir)).toEqual([]);
		await Bun.write(stateFile, JSON.stringify({ title: "default", hasCustomTitle: false }));
		await Bun.write(logFile, "");

		const first = runChild("Session A");
		const second = runChild("Session B");
		expect(await Promise.all([first.exited, second.exited])).toEqual([0, 0]);
		const initialRenames = (await Bun.file(logFile).text()).trim().split("\n");
		expect(initialRenames).toHaveLength(1);

		const restarted = runChild("Restarted session");
		expect(await restarted.exited).toBe(0);
		const finalRenames = (await Bun.file(logFile).text()).trim().split("\n");
		expect(finalRenames).toEqual(initialRenames);
		expect(await fs.readdir(lockDir)).toEqual([]);
	});
});
