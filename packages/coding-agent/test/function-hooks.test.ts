import { afterEach, describe, expect, test } from "bun:test";
import {
	type FunctionHook,
	type FunctionHookEventType,
	type FunctionHookRegistration,
	normalizeFunctionHookGrant,
	tagFunctionHookHandler,
} from "../src/extensibility/extensions/function-hooks";
import { ExtensionRuntime } from "../src/extensibility/extensions/loader";
import {
	EXTENSION_HANDLER_TIMEOUT_MS,
	ExtensionRunner,
	testSetExtensionHandlerTimeoutMs,
} from "../src/extensibility/extensions/runner";
import type { Extension, ExtensionSessionMetadata, ToolCallEvent } from "../src/extensibility/extensions/types";
import { SessionManager } from "../src/session/session-manager";

type HookRegistration = Omit<FunctionHookRegistration, "grant"> & {
	grant?: Parameters<typeof normalizeFunctionHookGrant>[0];
};

function makeExtension(registrations: HookRegistration[]): Extension {
	const handlers = new Map<string, Array<(...args: unknown[]) => Promise<unknown>>>();
	for (const registration of registrations) {
		const normalized = {
			...registration,
			grant: normalizeFunctionHookGrant(registration.grant),
		};
		const tagged = tagFunctionHookHandler(normalized);
		const list = handlers.get(registration.event) ?? [];
		list.push(tagged);
		handlers.set(registration.event, list);
	}
	return {
		path: "/tmp/function-hook-extension.ts",
		resolvedPath: "/tmp/function-hook-extension.ts",
		handlers,
		tools: new Map(),
		messageRenderers: new Map(),
		commands: new Map(),
		flags: new Map(),
		shortcuts: new Map(),
	};
}

function makeRunner(registrations: HookRegistration[], sessionMetadata?: ExtensionSessionMetadata): ExtensionRunner {
	return new ExtensionRunner(
		[makeExtension(registrations)],
		new ExtensionRuntime(),
		process.cwd(),
		SessionManager.inMemory(),
		{} as never,
		sessionMetadata,
	);
}

function toolCall(input: Record<string, unknown> = { path: "secret.txt" }): ToolCallEvent {
	return {
		type: "tool_call",
		toolName: "read",
		toolCallId: "call-1",
		input,
	};
}

function registration(
	event: FunctionHookEventType,
	handler: FunctionHook,
	grant: HookRegistration["grant"],
	registrationOrder: number,
	target?: string,
): HookRegistration {
	return {
		event,
		handler,
		grant,
		registrationOrder,
		...(target === undefined ? {} : { target }),
		provenance: {
			source: "extension",
			path: "/tmp/function-hook-extension.ts",
			extensionId: "test-extension",
		},
	};
}

afterEach(() => {
	testSetExtensionHandlerTimeoutMs(EXTENSION_HANDLER_TIMEOUT_MS);
});

describe("capability-scoped function hooks", () => {
	test("composes wildcard observation before exact transformation without exposing tool input", async () => {
		const calls: string[] = [];
		const runner = makeRunner([
			registration(
				"*",
				async (invocation, _capabilities, next) => {
					calls.push("wildcard");
					expect((invocation.payload as ToolCallEvent).input as unknown).toBe("<redacted>");
					return await next();
				},
				undefined,
				0,
			),
			registration(
				"tool_call",
				async (invocation, _capabilities, next) => {
					calls.push("exact");
					expect((invocation.payload as ToolCallEvent).input).toEqual({ path: "secret.txt" });
					return await next({
						...(invocation.payload as ToolCallEvent),
						input: { path: "safe.txt" },
					});
				},
				{ capabilities: ["tool.inspect", "tool.transform"] },
				1,
				"read",
			),
		]);

		const event = toolCall();
		const result = await runner.emitToolCall(event);
		expect(result).toBeUndefined();
		expect(event.input).toEqual({ path: "safe.txt" });
		expect(calls).toEqual(["wildcard", "exact"]);
	});

	test("attenuates downstream denial authority while retaining transformation authority", async () => {
		let downstreamCanDeny = true;
		const runner = makeRunner([
			registration(
				"tool_call",
				async (_invocation, _capabilities, next) => await next(),
				{ capabilities: ["tool"], attenuateDownstream: ["tool.deny"] },
				0,
				"read",
			),
			registration(
				"tool_call",
				async (_invocation, capabilities, next) => {
					downstreamCanDeny = capabilities.tool?.canDeny ?? false;
					return await next();
				},
				{ capabilities: ["tool.deny", "tool.transform"] },
				1,
				"read",
			),
		]);

		expect(await runner.emitToolCall(toolCall())).toBeUndefined();
		expect(downstreamCanDeny).toBe(false);
	});

	test("blocks a tool when a granted hook denies it and leaves legacy handlers single-dispatched", async () => {
		let legacyCalls = 0;
		const extension = makeExtension([
			registration(
				"tool_call",
				async () => ({ action: "deny", reason: "policy" }),
				{ capabilities: ["tool.deny"] },
				0,
				"read",
			),
		]);
		extension.handlers.get("tool_call")!.push(async () => {
			legacyCalls += 1;
			return { block: true, reason: "legacy" };
		});
		const runner = new ExtensionRunner(
			[extension],
			new ExtensionRuntime(),
			process.cwd(),
			SessionManager.inMemory(),
			{} as never,
		);

		const result = await runner.emitToolCall(toolCall());
		expect(result).toEqual({ block: true, reason: "policy" });
		expect(legacyCalls).toBe(0);
	});

	test("does not let an observation-only wildcard block a tool", async () => {
		const runner = makeRunner([
			registration("*", async () => ({ action: "deny", reason: "ungranted" }), undefined, 0),
		]);
		expect(await runner.emitToolCall(toolCall())).toBeUndefined();
	});

	test("rejects malformed callback results and records provenance-aware audit evidence", async () => {
		const runner = makeRunner([
			registration(
				"tool_call",
				async () => ({ action: "continue", unexpected: true }) as never,
				{ capabilities: ["tool.inspect"] },
				0,
				"read",
			),
		]);

		const result = await runner.emitToolCall(toolCall());
		expect(result?.block).toBe(true);
		const audit = runner.getFunctionHookAudit();
		expect(audit.at(-1)?.action).toBe("error");
		expect(audit.at(-1)?.provenance.extensionId).toBe("test-extension");
		expect(audit.at(-1)?.requestedCapabilities).toEqual(["tool.inspect"]);
		expect(audit.at(-1)?.effectiveCapabilities).toEqual(["tool.inspect"]);
	});

	test("aborts timed-out hooks and prevents their late transformation from committing", async () => {
		testSetExtensionHandlerTimeoutMs(10);
		const runner = makeRunner([
			registration(
				"tool_call",
				async () => {
					await Bun.sleep(50);
					return {
						action: "continue",
						event: { ...toolCall(), input: { path: "late.txt" } },
					};
				},
				{ capabilities: ["tool.transform"] },
				0,
				"read",
			),
		]);
		const event = toolCall();
		const result = await runner.emitToolCall(event);
		expect(result?.block).toBe(true);
		expect(event.input).toEqual({ path: "secret.txt" });
	});

	test("rejects an inspect-only replacement passed through next", async () => {
		const runner = makeRunner([
			registration(
				"tool_call",
				async (invocation, _capabilities, next) =>
					await next({
						...(invocation.payload as ToolCallEvent),
						input: { path: "bypass.txt" },
					}),
				{ capabilities: ["tool.inspect"] },
				0,
				"read",
			),
		]);
		const event = toolCall();
		const result = await runner.emitToolCall(event);
		expect(result?.block).toBe(true);
		expect(event.input).toEqual({ path: "secret.txt" });
	});

	test("snapshots a replacement before downstream dispatch", async () => {
		const runner = makeRunner([
			registration(
				"tool_call",
				async (invocation, _capabilities, next) => {
					const candidate = {
						...(invocation.payload as ToolCallEvent),
						input: { path: "reviewed.txt" },
					};
					const result = await next(candidate);
					candidate.input.path = "mutated-after-review.txt";
					return result;
				},
				{ capabilities: ["tool.transform"] },
				0,
				"read",
			),
			registration(
				"tool_call",
				async (invocation, _capabilities, next) => {
					expect((invocation.payload as ToolCallEvent).input).toEqual({ path: "reviewed.txt" });
					return await next();
				},
				{ capabilities: ["tool.inspect", "tool.deny"] },
				1,
				"read",
			),
		]);
		const event = toolCall();
		expect(await runner.emitToolCall(event)).toBeUndefined();
		expect(event.input).toEqual({ path: "reviewed.txt" });
	});

	test("fails closed when an enforcement-capable wildcard times out", async () => {
		testSetExtensionHandlerTimeoutMs(10);
		const runner = makeRunner([
			registration(
				"*",
				async () => {
					await Bun.sleep(50);
				},
				{ capabilities: ["tool.deny"] },
				0,
			),
		]);
		expect((await runner.emitToolCall(toolCall()))?.block).toBe(true);
	});

	test("fails closed for timed-out wildcard UI enforcement", async () => {
		testSetExtensionHandlerTimeoutMs(10);
		const runner = makeRunner([
			registration(
				"*",
				async () => {
					await Bun.sleep(50);
				},
				{ capabilities: ["ui.transform"] },
				0,
			),
		]);
		const result = await runner.emitFunctionHooks({ type: "context", messages: [] });
		expect(result.action).toBe("deny");
		await expect(runner.emitContext([{ role: "user", content: "secret" }] as never)).rejects.toThrow(
			"Function hook timed out",
		);
		await expect(runner.emitBeforeProviderRequest({ prompt: "secret" })).rejects.toThrow("Function hook timed out");
	});

	test("does not expose session metadata without session.read", async () => {
		let metadata: unknown = "unset";
		const runner = makeRunner(
			[
				registration(
					"session_before_switch",
					async (_invocation, capabilities, next) => {
						metadata = capabilities.session?.metadata;
						return await next();
					},
					{ capabilities: ["session.message"] },
					0,
				),
			],
			{ kind: "main", taskDepth: 0, currentAgentType: "executor" },
		);
		await runner.emitFunctionHooks({ type: "session_before_switch", reason: "new" });
		expect(metadata).toBeUndefined();
	});

	test("redacts exact non-tool payloads without an inspection grant", async () => {
		let payload: unknown;
		const runner = makeRunner([
			registration(
				"context",
				async (invocation, _capabilities, next) => {
					payload = invocation.payload;
					return await next();
				},
				undefined,
				0,
			),
		]);
		await runner.emitFunctionHooks({ type: "context", messages: [{ token: "secret" }] } as never);
		expect(payload).toEqual({ type: "context" });
	});

	test("fails closed when a hook calls next twice", async () => {
		const runner = makeRunner([
			registration(
				"tool_call",
				async (_invocation, _capabilities, next) => {
					await next();
					return await next();
				},
				{ capabilities: ["tool.deny"] },
				0,
				"read",
			),
		]);
		expect((await runner.emitToolCall(toolCall()))?.block).toBe(true);
	});

	test("invalidates retained capability methods after invocation completion", async () => {
		let emitMessage: (() => void) | undefined;
		const runner = makeRunner([
			registration(
				"session_before_switch",
				async (_invocation, capabilities, next) => {
					emitMessage = () => capabilities.session?.emitMessage({ customType: "late", content: "late" });
					return await next();
				},
				{ capabilities: ["session.message"] },
				0,
			),
		]);
		await runner.emitFunctionHooks({ type: "session_before_switch", reason: "new" });
		expect(emitMessage).toBeDefined();
		expect(() => emitMessage?.()).toThrow("no longer active");
	});
});
