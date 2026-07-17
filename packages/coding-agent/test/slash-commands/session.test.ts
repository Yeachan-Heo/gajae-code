import { describe, expect, it, vi } from "bun:test";
import type { InteractiveModeContext } from "@gajae-code/coding-agent/modes/types";
import {
	executeBuiltinSlashCommand,
	lookupBuiltinSlashCommand,
} from "@gajae-code/coding-agent/slash-commands/builtin-registry";

function createRuntimeHarness(options?: {
	handleSessionCommand?: InteractiveModeContext["handleSessionCommand"];
	handleSessionDeleteCommand?: InteractiveModeContext["handleSessionDeleteCommand"];
}) {
	const setText = vi.fn();
	const handleSessionCommand =
		options?.handleSessionCommand ??
		vi.fn(async () => {
			return;
		});
	const handleSessionDeleteCommand =
		options?.handleSessionDeleteCommand ??
		vi.fn(async () => {
			return;
		});

	return {
		setText,
		handleSessionCommand,
		handleSessionDeleteCommand,
		runtime: {
			ctx: {
				editor: { setText } as unknown as InteractiveModeContext["editor"],
				handleSessionCommand,
				handleSessionDeleteCommand,
			} as InteractiveModeContext,
			handleBackgroundCommand: () => {},
		},
	};
}

describe("/session slash command", () => {
	it("awaits session info before resolving the default command", async () => {
		const deferred = Promise.withResolvers<void>();
		const handleSessionCommand = vi.fn(() => deferred.promise);
		const harness = createRuntimeHarness({ handleSessionCommand });

		let settled = false;
		const execution = executeBuiltinSlashCommand("/session", harness.runtime).then(result => {
			settled = true;
			return result;
		});

		await Promise.resolve();

		expect(handleSessionCommand).toHaveBeenCalledTimes(1);
		expect(harness.handleSessionDeleteCommand).not.toHaveBeenCalled();
		expect(harness.setText).not.toHaveBeenCalled();
		expect(settled).toBe(false);

		deferred.resolve();

		expect(await execution).toBe(true);
		expect(settled).toBe(true);
		expect(harness.setText).toHaveBeenCalledWith("");
	});

	it("propagates session info failures through executeBuiltinSlashCommand", async () => {
		const infoError = new Error("info failed");
		const handleSessionCommand = vi.fn(async () => {
			throw infoError;
		});
		const harness = createRuntimeHarness({ handleSessionCommand });

		await expect(executeBuiltinSlashCommand("/session info", harness.runtime)).rejects.toBe(infoError);
		expect(handleSessionCommand).toHaveBeenCalledTimes(1);
		expect(harness.handleSessionDeleteCommand).not.toHaveBeenCalled();
		expect(harness.setText).not.toHaveBeenCalled();
	});

	it("awaits session deletion before resolving the builtin command", async () => {
		const deferred = Promise.withResolvers<void>();
		const handleSessionDeleteCommand = vi.fn(() => deferred.promise);
		const harness = createRuntimeHarness({ handleSessionDeleteCommand });

		let settled = false;
		const execution = executeBuiltinSlashCommand("/session delete", harness.runtime).then(result => {
			settled = true;
			return result;
		});

		await Promise.resolve();

		expect(handleSessionDeleteCommand).toHaveBeenCalledTimes(1);
		expect(harness.setText).toHaveBeenCalledWith("");
		expect(settled).toBe(false);

		deferred.resolve();

		expect(await execution).toBe(true);
		expect(settled).toBe(true);
	});

	it("propagates session deletion failures through executeBuiltinSlashCommand", async () => {
		const deleteError = new Error("delete failed");
		const handleSessionDeleteCommand = vi.fn(async () => {
			throw deleteError;
		});
		const harness = createRuntimeHarness({ handleSessionDeleteCommand });

		await expect(executeBuiltinSlashCommand("/session delete", harness.runtime)).rejects.toBe(deleteError);
		expect(handleSessionDeleteCommand).toHaveBeenCalledTimes(1);
		expect(harness.setText).toHaveBeenCalledWith("");
	});

	it("reports the exact ACP delete target and retained metadata", async () => {
		const command = lookupBuiltinSlashCommand("session");
		const output = vi.fn();
		const dropSession = vi.fn(async () => undefined);
		const runtime = {
			cwd: "/tmp/project",
			output,
			refreshCommands: vi.fn(),
			reloadPlugins: vi.fn(),
			session: { isStreaming: false, sessionId: "session-a", sessionName: "Session A" },
			sessionManager: {
				getSessionFile: () => "/tmp/project/sessions/session-a.jsonl",
				dropSession,
			},
			settings: {},
		};

		const result = await command?.handle?.(
			{ name: "session", args: "delete", text: "/session delete" },
			runtime as never,
		);

		expect(result).toEqual({ consumed: true });
		expect(dropSession).toHaveBeenCalledWith("/tmp/project/sessions/session-a.jsonl");
		expect(output).toHaveBeenCalledWith(
			[
				"Deleted current session transcript and artifacts: /tmp/project/sessions/session-a.jsonl",
				"Other sessions and topic/history metadata were not deleted.",
			].join("\n"),
		);
	});
});
