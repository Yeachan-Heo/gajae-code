import { describe, expect, it, vi } from "bun:test";
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
		const owned = (over: Partial<CmuxWorkspaceOwnership>): CmuxWorkspaceOwnership => ({
			hasCustomTitle: true,
			title: "current",
			...over,
		});

		it("skips when ownership is unknown (read failed)", () => {
			expect(shouldRenameCmuxWorkspace(null, "GJC: Desired")).toBe(false);
		});

		it("skips when the title already matches", () => {
			expect(shouldRenameCmuxWorkspace(owned({ title: "GJC: Desired" }), "GJC: Desired")).toBe(false);
		});

		it("renames when the workspace still has the default title", () => {
			expect(shouldRenameCmuxWorkspace(owned({ hasCustomTitle: false }), "GJC: Desired")).toBe(true);
		});

		it("preserves user-pinned titles and updates GJC-managed titles", () => {
			expect(shouldRenameCmuxWorkspace(owned({ title: "My Pinned Name" }), "GJC: Desired")).toBe(false);
			expect(shouldRenameCmuxWorkspace(owned({ title: "GJC: Session A" }), "GJC: Session B")).toBe(true);
		});
	});

	it("does not spawn outside a tty", async () => {
		let spawned = false;
		await syncCmuxWorkspaceTitle("Investigate Resolver", {
			env: cmuxEnv(),
			isTty: false,
			which: () => "/usr/local/bin/cmux",
			readOwnership: async () => ({ hasCustomTitle: false, title: "default" }),
			spawn: () => {
				spawned = true;
				return { exited: Promise.resolve(0), kill: () => {}, unref: () => {} };
			},
		});
		expect(spawned).toBe(false);
	});

	it("does not spawn when GJC_NO_CMUX_RENAME is set", async () => {
		let spawned = false;
		await syncCmuxWorkspaceTitle("Investigate Resolver", {
			env: cmuxEnv("ws-optout", { GJC_NO_CMUX_RENAME: "1" }),
			isTty: true,
			which: () => "/usr/local/bin/cmux",
			readOwnership: async () => ({ hasCustomTitle: false, title: "default" }),
			spawn: () => {
				spawned = true;
				return { exited: Promise.resolve(0), kill: () => {}, unref: () => {} };
			},
		});
		expect(spawned).toBe(false);
	});

	it("renames a default-titled workspace inside a tty cmux workspace", async () => {
		const unref = vi.fn(() => {});
		const kill = vi.fn(() => {});
		const calls: string[][] = [];

		await syncCmuxWorkspaceTitle("Investigate Resolver", {
			env: cmuxEnv("ws-default"),
			isTty: true,
			which: command => (command === "cmux" ? "/usr/local/bin/cmux" : null),
			readOwnership: async () => ({ hasCustomTitle: false, title: "~/dev/x" }),
			spawn: command => {
				calls.push(command);
				return { exited: Promise.resolve(0), kill, unref };
			},
		});

		expect(calls).toEqual([
			["/usr/local/bin/cmux", "workspace", "rename", "ws-default", "--title", "GJC: Investigate Resolver"],
		]);
		expect(unref).toHaveBeenCalledTimes(1);
		expect(kill).not.toHaveBeenCalled();
	});

	it("does not clobber a user-pinned workspace title", async () => {
		let spawned = false;
		await syncCmuxWorkspaceTitle("Investigate Resolver", {
			env: cmuxEnv("ws-userpinned"),
			isTty: true,
			which: () => "/usr/local/bin/cmux",
			readOwnership: async () => ({ hasCustomTitle: true, title: "My Pinned Name" }),
			spawn: () => {
				spawned = true;
				return { exited: Promise.resolve(0), kill: () => {}, unref: () => {} };
			},
		});
		expect(spawned).toBe(false);
	});

	it("skips renaming when ownership cannot be read", async () => {
		let spawned = false;
		await syncCmuxWorkspaceTitle("Investigate Resolver", {
			env: cmuxEnv("ws-unreadable"),
			isTty: true,
			which: () => "/usr/local/bin/cmux",
			readOwnership: async () => null,
			spawn: () => {
				spawned = true;
				return { exited: Promise.resolve(0), kill: () => {}, unref: () => {} };
			},
		});
		expect(spawned).toBe(false);
	});

	it("updates a GJC-managed title when the session name changes", async () => {
		const calls: string[][] = [];
		const spawn = (command: string[]) => {
			calls.push(command);
			return { exited: Promise.resolve(0), kill: () => {}, unref: () => {} };
		};
		await syncCmuxWorkspaceTitle("Session A task", {
			env: cmuxEnv("ws-shared"),
			isTty: true,
			which: () => "/usr/local/bin/cmux",
			readOwnership: async () => ({ hasCustomTitle: false, title: "~/dev/x" }),
			spawn,
		});
		await syncCmuxWorkspaceTitle("Session B task", {
			env: cmuxEnv("ws-shared"),
			isTty: true,
			which: () => "/usr/local/bin/cmux",
			readOwnership: async () => ({ hasCustomTitle: true, title: "GJC: Session A task" }),
			spawn,
		});
		expect(calls).toEqual([
			["/usr/local/bin/cmux", "workspace", "rename", "ws-shared", "--title", "GJC: Session A task"],
			["/usr/local/bin/cmux", "workspace", "rename", "ws-shared", "--title", "GJC: Session B task"],
		]);
	});
});
