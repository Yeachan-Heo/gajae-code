import { describe, expect, it, vi } from "bun:test";
import {
	buildCmuxWorkspaceRenameCommand,
	formatCmuxWorkspaceTitle,
	sanitizeCmuxWorkspaceTitle,
	syncCmuxWorkspaceTitle,
} from "../src/utils/cmux-workspace";

function cmuxEnv(workspaceId = "workspace-123"): NodeJS.ProcessEnv {
	return { CMUX_WORKSPACE_ID: workspaceId } as NodeJS.ProcessEnv;
}

describe("cmux workspace title sync", () => {
	it("builds an explicit workspace rename command", () => {
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

	it("does not spawn outside a tty", () => {
		let spawned = false;
		syncCmuxWorkspaceTitle("Investigate Resolver", {
			env: cmuxEnv(),
			isTty: false,
			which: () => "/usr/local/bin/cmux",
			spawn: () => {
				spawned = true;
				return { exited: Promise.resolve(0), kill: () => {}, unref: () => {} };
			},
		});

		expect(spawned).toBe(false);
	});

	it("spawns a best-effort cmux rename inside a tty cmux workspace", () => {
		const unref = vi.fn(() => {});
		const kill = vi.fn(() => {});
		const calls: string[][] = [];
		const seenEnv: NodeJS.ProcessEnv[] = [];

		syncCmuxWorkspaceTitle("Investigate Resolver", {
			env: cmuxEnv(),
			isTty: true,
			which: command => (command === "cmux" ? "/usr/local/bin/cmux" : null),
			spawn: (command, options) => {
				calls.push(command);
				seenEnv.push(options.env);
				return { exited: Promise.resolve(0), kill, unref };
			},
		});

		expect(calls).toEqual([
			["/usr/local/bin/cmux", "workspace", "rename", "workspace-123", "--title", "GJC: Investigate Resolver"],
		]);
		expect(seenEnv[0]?.CMUX_WORKSPACE_ID).toBe("workspace-123");
		expect(unref).toHaveBeenCalledTimes(1);
		expect(kill).not.toHaveBeenCalled();
	});
});
