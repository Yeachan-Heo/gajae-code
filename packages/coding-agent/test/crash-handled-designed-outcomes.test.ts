import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { finishExecuteToolSpan } from "@gajae-code/agent-core/telemetry";
import { validateToolArguments } from "@gajae-code/ai/core";
import {
	getHandledErrorEventsPath,
	getHandledErrorLogPath,
	resetAgentDirFromEnvironment,
	setAgentDir,
} from "@gajae-code/utils/dirs";
import { resetHandledErrorDedupeForTest } from "@gajae-code/utils/postmortem";
import { ApplyPatchError, replaceText } from "../src/edit/diff";
import { EditMatchError } from "../src/edit/modes/replace";
import { ExtensionRuntime } from "../src/extensibility/extensions/loader";
import { ExtensionRunner } from "../src/extensibility/extensions/runner";
import type { Extension } from "../src/extensibility/extensions/types";
import { ExtensionToolWrapper } from "../src/extensibility/extensions/wrapper";
import type { HookRunner } from "../src/extensibility/hooks/runner";
import { HookToolWrapper } from "../src/extensibility/hooks/tool-wrapper";
import { Type } from "../src/extensibility/typebox";
import { InternalUrlRouter } from "../src/internal-urls";
import { SessionManager } from "../src/session/session-manager";

// Issue #5938: designed refusals and model-input errors must not land in the
// handled-error crash store (gjc-error.log / gjc-error-events.jsonl), while a
// genuine tool fault still must.

function finishWithError(errorObject: unknown, toolName: string): void {
	finishExecuteToolSpan(undefined, undefined, {
		isError: true,
		status: "error",
		errorObject,
		toolCallId: `${toolName}-call`,
		toolName,
	});
}

async function crashStoreExists(): Promise<boolean> {
	return (await Bun.file(getHandledErrorLogPath()).exists()) || (await Bun.file(getHandledErrorEventsPath()).exists());
}

async function captureRejection(promise: Promise<unknown>): Promise<unknown> {
	try {
		await promise;
	} catch (error) {
		return error;
	}
	throw new Error("expected rejection");
}

const readTool = {
	name: "read",
	label: "Read",
	description: "Read a file",
	parameters: Type.Object({ path: Type.String() }),
	execute: async () => ({ content: [{ type: "text" as const, text: "ok" }] }),
};

function runnerFor(extension: Extension): ExtensionRunner {
	return new ExtensionRunner(
		[extension],
		new ExtensionRuntime(),
		process.cwd(),
		SessionManager.inMemory(),
		{} as never,
	);
}

function extensionWithHandler(event: string, handler: () => Promise<unknown>): Extension {
	return {
		path: "/tmp/allowlist-extension.ts",
		resolvedPath: "/tmp/allowlist-extension.ts",
		handlers: new Map([[event, [handler]]]),
		tools: new Map(),
		messageRenderers: new Map(),
		commands: new Map(),
		flags: new Map(),
		shortcuts: new Map(),
	};
}

describe("handled-error crash store excludes designed tool outcomes (#5938)", () => {
	let agentDir: string;

	beforeEach(() => {
		resetHandledErrorDedupeForTest();
		agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-5938-"));
		setAgentDir(agentDir);
	});

	afterEach(() => {
		resetAgentDirFromEnvironment();
		fs.rmSync(agentDir, { recursive: true, force: true });
	});

	test("an extension tool_call block is a designed refusal", async () => {
		const runner = new ExtensionRunner(
			[
				extensionWithHandler("tool_call", async () => ({
					block: true,
					reason: "Tool is outside the parent delegation allowlist.",
				})),
			],
			new ExtensionRuntime(),
			process.cwd(),
			SessionManager.inMemory(),
			{} as never,
		);
		const wrapped = new ExtensionToolWrapper(readTool, runner);
		const error = await captureRejection(wrapped.execute("call-1", { path: "a.txt" }));
		expect((error as Error).message).toBe("Tool is outside the parent delegation allowlist.");

		finishWithError(error, "rogue");
		expect(await crashStoreExists()).toBe(false);
	});

	test("a hook tool_call block is a designed refusal", async () => {
		const hookRunner = {
			hasHandlers: (event: string) => event === "tool_call",
			emitToolCall: async () => ({ block: true, reason: "blocked by policy hook" }),
		} as unknown as HookRunner;
		const wrapped = new HookToolWrapper(readTool, hookRunner);
		const error = await captureRejection(wrapped.execute("call-1", { path: "a.txt" }));
		expect((error as Error).message).toBe("blocked by policy hook");

		finishWithError(error, "read");
		expect(await crashStoreExists()).toBe(false);
	});

	test("edit match failures answer the model's input and are not crashes", async () => {
		finishWithError(
			new EditMatchError("src/a.ts", "missing text", undefined, { allowFuzzy: true, threshold: 0.95 }),
			"edit",
		);
		finishWithError(new ApplyPatchError("Failed to find expected lines in src/a.ts:\nmissing"), "edit");
		expect(await crashStoreExists()).toBe(false);
	});

	test("ambiguous and empty replace refusals are not crashes", async () => {
		const ambiguous = (() => {
			try {
				replaceText("x\nx\n", "x", "y", { fuzzy: false, all: false });
			} catch (thrown) {
				return thrown;
			}
			throw new Error("expected ambiguous replace refusal");
		})();
		expect((ambiguous as Error).message).toContain("2 occurrences");
		finishWithError(ambiguous, "edit");

		const empty = (() => {
			try {
				replaceText("x\n", "", "y", { fuzzy: false, all: false });
			} catch (thrown) {
				return thrown;
			}
			throw new Error("expected empty old_text refusal");
		})();
		finishWithError(empty, "edit");
		expect(await crashStoreExists()).toBe(false);
	});

	test("tool_result mediation keeps a designed tool error designed", async () => {
		const failingEdit = {
			...readTool,
			name: "edit",
			execute: async () => {
				throw new EditMatchError("src/a.ts", "missing text", undefined, { allowFuzzy: true, threshold: 0.95 });
			},
		};
		const runner = runnerFor(
			extensionWithHandler("tool_result", async () => ({
				content: [{ type: "text", text: "rewritten by extension" }],
			})),
		);
		const error = await captureRejection(
			new ExtensionToolWrapper(failingEdit, runner).execute("call-1", { path: "a" }),
		);
		expect((error as Error).message).toBe("rewritten by extension");

		finishWithError(error, "edit");
		expect(await crashStoreExists()).toBe(false);
	});

	test("tool_result mediation still records a genuine tool fault", async () => {
		const faultingEdit = {
			...readTool,
			name: "edit",
			execute: async () => {
				throw new TypeError("Cannot read properties of undefined (reading 'length')");
			},
		};
		const runner = runnerFor(
			extensionWithHandler("tool_result", async () => ({
				content: [{ type: "text", text: "rewritten by extension" }],
			})),
		);
		const error = await captureRejection(
			new ExtensionToolWrapper(faultingEdit, runner).execute("call-1", { path: "a" }),
		);

		finishWithError(error, "edit");
		expect(await Bun.file(getHandledErrorLogPath()).exists()).toBe(true);
	});

	test("an extension marking a successful result as an error is a designed verdict", async () => {
		const runner = runnerFor(
			extensionWithHandler("tool_result", async () => ({
				content: [{ type: "text", text: "rejected by policy" }],
				isError: true,
			})),
		);
		const error = await captureRejection(new ExtensionToolWrapper(readTool, runner).execute("call-1", { path: "a" }));
		expect((error as Error).message).toBe("rejected by policy");

		finishWithError(error, "read");
		expect(await crashStoreExists()).toBe(false);
	});

	test("an unknown embedded: resource is a model input error, not a crash", async () => {
		const error = await captureRejection(InternalUrlRouter.instance().resolve("embedded:gjc/skills"));
		expect((error as Error).message).toContain("Unknown embedded resource: embedded:gjc/skills");

		finishWithError(error, "read");
		expect(await crashStoreExists()).toBe(false);
	});

	test("model argument validation failures are not crashes", async () => {
		const error = (() => {
			try {
				validateToolArguments(readTool, { type: "toolCall", id: "call-1", name: "read", arguments: {} });
			} catch (thrown) {
				return thrown;
			}
			throw new Error("expected validation failure");
		})();
		expect((error as Error).message).toContain('Validation failed for tool "read"');

		finishWithError(error, "read");
		expect(await crashStoreExists()).toBe(false);
	});

	test("a genuine tool fault is still recorded", async () => {
		finishWithError(new TypeError("Cannot read properties of undefined (reading 'length')"), "edit");
		expect(await Bun.file(getHandledErrorLogPath()).exists()).toBe(true);
		expect(await Bun.file(getHandledErrorEventsPath()).exists()).toBe(true);
	});
});
