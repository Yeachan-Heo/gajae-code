import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	buildCmuxWorkspaceRenameCommand,
	type CmuxWorkspaceManagedOwnership,
	type CmuxWorkspaceOwnership,
	formatCmuxWorkspaceTitle,
	parseCmuxWorkspaceOwnership,
	sanitizeCmuxWorkspaceTitle,
	shouldRenameCmuxWorkspace,
	syncCmuxWorkspaceTitle,
} from "../src/utils/cmux-workspace";

function cmuxEnv(workspaceId = "workspace-123", extra: Record<string, string> = {}): NodeJS.ProcessEnv {
	return { CMUX_WORKSPACE_ID: workspaceId, ...extra } as NodeJS.ProcessEnv;
}

const LIST_JSON = JSON.stringify({
	workspaces: [
		{ id: "AAAA-1111", ref: "workspace:1", title: "Other", has_custom_title: true },
		{ id: "DF98857C", ref: "workspace:8", title: "GJC: gajae-code", has_custom_title: true },
		{ id: "CCCC-9999", ref: "workspace:9", title: "~/dev/x", has_custom_title: false },
	],
});

describe("cmux workspace title sync", () => {
	let stateDir: string;

	beforeEach(async () => {
		stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-cmux-workspace-test-"));
	});

	afterEach(async () => {
		await fs.rm(stateDir, { recursive: true, force: true });
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

		it("returns null when the workspace is not present", () => {
			expect(parseCmuxWorkspaceOwnership(LIST_JSON, "missing")).toBeNull();
		});

		it("returns null on unparseable output", () => {
			expect(parseCmuxWorkspaceOwnership("not json", "df98857c")).toBeNull();
		});
	});

	describe("shouldRenameCmuxWorkspace", () => {
		const current = (over: Partial<CmuxWorkspaceOwnership>): CmuxWorkspaceOwnership => ({
			hasCustomTitle: true,
			title: "current",
			...over,
		});
		const managed = (over: Partial<CmuxWorkspaceManagedOwnership> = {}): CmuxWorkspaceManagedOwnership => ({
			schemaVersion: 1,
			sessionId: "session-a",
			title: "GJC: Session A",
			...over,
		});

		it("fails closed when cmux ownership cannot be read", () => {
			expect(shouldRenameCmuxWorkspace(null, "GJC: Desired", managed(), "session-a")).toBe(false);
		});

		it("skips when the title already matches", () => {
			expect(
				shouldRenameCmuxWorkspace(current({ title: "GJC: Desired" }), "GJC: Desired", managed(), "session-a"),
			).toBe(false);
		});

		it("allows a default workspace to be claimed", () => {
			expect(
				shouldRenameCmuxWorkspace(
					current({ hasCustomTitle: false, title: "~/dev/x" }),
					"GJC: Desired",
					null,
					"session-a",
				),
			).toBe(true);
		});

		it("requires matching durable session and title evidence for a custom title", () => {
			const ownership = current({ title: "GJC: Session A" });
			expect(shouldRenameCmuxWorkspace(ownership, "GJC: Desired", null, "session-a")).toBe(false);
			expect(shouldRenameCmuxWorkspace(ownership, "GJC: Desired", managed(), "session-b")).toBe(false);
			expect(
				shouldRenameCmuxWorkspace(ownership, "GJC: Desired", managed({ title: "GJC: Stale title" }), "session-a"),
			).toBe(false);
			expect(shouldRenameCmuxWorkspace(ownership, "GJC: Desired", managed(), "session-a")).toBe(true);
		});
	});

	it("does not spawn outside a tty or without a session identity", async () => {
		let spawned = false;
		const options = {
			env: cmuxEnv(),
			isTty: false,
			stateDir,
			which: () => "/usr/local/bin/cmux",
			readOwnership: async () => ({ hasCustomTitle: false, title: "default" }),
			spawn: () => {
				spawned = true;
				return { exited: Promise.resolve(0), kill: () => {}, unref: () => {} };
			},
		};
		await syncCmuxWorkspaceTitle("Investigate Resolver", "session-a", options);
		await syncCmuxWorkspaceTitle("Investigate Resolver", undefined, { ...options, isTty: true });
		expect(spawned).toBe(false);
	});

	it("does not spawn when GJC_NO_CMUX_RENAME is set", async () => {
		let spawned = false;
		await syncCmuxWorkspaceTitle("Investigate Resolver", "session-a", {
			env: cmuxEnv("ws-optout", { GJC_NO_CMUX_RENAME: "1" }),
			isTty: true,
			stateDir,
			which: () => "/usr/local/bin/cmux",
			readOwnership: async () => ({ hasCustomTitle: false, title: "default" }),
			spawn: () => {
				spawned = true;
				return { exited: Promise.resolve(0), kill: () => {}, unref: () => {} };
			},
		});
		expect(spawned).toBe(false);
	});

	it("claims a default workspace and lets only that session update it", async () => {
		const calls: string[][] = [];
		let title = "~/dev/x";
		let hasCustomTitle = false;
		const options = {
			env: cmuxEnv("ws-owned"),
			isTty: true,
			stateDir,
			which: () => "/usr/local/bin/cmux",
			readOwnership: async () => ({ hasCustomTitle, title }),
			spawn: (command: string[]) => {
				calls.push(command);
				title = command.at(-1) ?? "";
				hasCustomTitle = true;
				return { exited: Promise.resolve(0), kill: () => {}, unref: () => {} };
			},
		};

		await syncCmuxWorkspaceTitle("Session A task", "session-a", options);
		await syncCmuxWorkspaceTitle("Renamed A task", "session-a", options);
		await syncCmuxWorkspaceTitle("Session B task", "session-b", options);

		expect(calls).toEqual([
			["/usr/local/bin/cmux", "workspace", "rename", "ws-owned", "--title", "GJC: Session A task"],
			["/usr/local/bin/cmux", "workspace", "rename", "ws-owned", "--title", "GJC: Renamed A task"],
		]);
	});

	it("preserves user-pinned titles even when they begin with the public GJC prefix", async () => {
		let spawned = false;
		await syncCmuxWorkspaceTitle("Investigate Resolver", "session-a", {
			env: cmuxEnv("ws-userpinned"),
			isTty: true,
			stateDir,
			which: () => "/usr/local/bin/cmux",
			readOwnership: async () => ({ hasCustomTitle: true, title: "GJC: My Pinned Name" }),
			spawn: () => {
				spawned = true;
				return { exited: Promise.resolve(0), kill: () => {}, unref: () => {} };
			},
		});
		expect(spawned).toBe(false);
	});

	it("does not claim ownership when the rename command fails", async () => {
		let title = "~/dev/x";
		let hasCustomTitle = false;
		let exitCode = 1;
		const calls: string[][] = [];
		const options = {
			env: cmuxEnv("ws-failed"),
			isTty: true,
			stateDir,
			which: () => "/usr/local/bin/cmux",
			readOwnership: async () => ({ hasCustomTitle, title }),
			spawn: (command: string[]) => {
				calls.push(command);
				return { exited: Promise.resolve(exitCode), kill: () => {}, unref: () => {} };
			},
		};

		await syncCmuxWorkspaceTitle("First attempt", "session-a", options);
		title = "GJC: First attempt";
		hasCustomTitle = true;
		exitCode = 0;
		await syncCmuxWorkspaceTitle("Second attempt", "session-a", options);

		expect(calls).toHaveLength(1);
	});

	it("serializes peer sessions so only the first claimant renames a default workspace", async () => {
		const calls: string[][] = [];
		let title = "~/dev/x";
		let hasCustomTitle = false;
		const options = {
			env: cmuxEnv("ws-concurrent"),
			isTty: true,
			stateDir,
			which: () => "/usr/local/bin/cmux",
			readOwnership: async () => ({ hasCustomTitle, title }),
			spawn: (command: string[]) => {
				calls.push(command);
				title = command.at(-1) ?? "";
				hasCustomTitle = true;
				return { exited: Promise.resolve(0), kill: () => {}, unref: () => {} };
			},
		};

		await Promise.all([
			syncCmuxWorkspaceTitle("Session A", "session-a", options),
			syncCmuxWorkspaceTitle("Session B", "session-b", options),
		]);

		expect(calls).toHaveLength(1);
	});
});
