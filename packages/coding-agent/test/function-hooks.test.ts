import { afterEach, describe, expect, test } from "bun:test";
import {
	type FunctionHook,
	type FunctionHookEventType,
	type FunctionHookRegistration,
	type FunctionHookRegistrationOptions,
	normalizeFunctionHookGrant,
} from "../src/extensibility/extensions/function-hooks";
import { tagFunctionHookHandler } from "../src/extensibility/extensions/function-hooks-internal";
import { ExtensionRuntime, loadExtensionFromFactory } from "../src/extensibility/extensions/loader";
import {
	EXTENSION_HANDLER_TIMEOUT_MS,
	ExtensionRunner,
	testSetExtensionHandlerTimeoutMs,
} from "../src/extensibility/extensions/runner";
import type { Extension, ExtensionSessionMetadata, ToolCallEvent } from "../src/extensibility/extensions/types";
import { ExtensionToolWrapper } from "../src/extensibility/extensions/wrapper";
import { Type } from "../src/extensibility/typebox";
import { SessionManager } from "../src/session/session-manager";
import { EventBus } from "../src/utils/event-bus";

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
	test("applies a host-owned grant ceiling and provenance", async () => {
		const packageJson = (await Bun.file(new URL("../package.json", import.meta.url)).json()) as {
			exports: Record<string, unknown>;
		};
		expect(packageJson.exports["./extensibility/extensions/function-hooks-internal"]).toBeNull();
		expect(packageJson.exports["./extensibility/extensions/function-hooks-internal.js"]).toBeNull();
		const runtime = new ExtensionRuntime();
		let networkCapability: unknown = "unset";
		let provenance: unknown;
		let exposesHostTag = true;
		const extension = await loadExtensionFromFactory(
			api => {
				exposesHostTag = "tagFunctionHookHandler" in api.pi;
				api.registerFunctionHook(
					"tool_call",
					async (invocation, capabilities, next) => {
						networkCapability = capabilities.network;
						provenance = invocation.provenance;
						return await next();
					},
					{
						target: "read",
						capabilities: ["tool.inspect", "network.fetch"],
						networkDestinations: ["https://example.com"],
						provenance: { source: "builtin", path: "/spoofed" },
					} as FunctionHookRegistrationOptions & {
						provenance: { source: "builtin"; path: string };
					},
				);
			},
			process.cwd(),
			new EventBus(),
			runtime,
			"project-extension",
		);
		const runner = new ExtensionRunner([extension], runtime, process.cwd(), SessionManager.inMemory(), {} as never);
		expect(await runner.emitToolCall(toolCall())).toBeUndefined();
		expect(networkCapability).toBeUndefined();
		expect(exposesHostTag).toBe(false);
		expect(provenance).toEqual({
			source: "extension",
			extensionId: "project-extension",
			path: "project-extension",
		});
	});

	test("composes wildcard observation before exact transformation without exposing wildcard payload", async () => {
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

	test("does not expose the chain-owned continuation result", async () => {
		const runner = makeRunner([
			registration(
				"tool_call",
				async (invocation, _capabilities, next) => {
					const result = await next({
						...(invocation.payload as ToolCallEvent),
						input: { path: "reviewed.txt" },
					});
					if (result.action === "continue" && result.event) {
						(result.event as ToolCallEvent).input = { path: "mutated-result.txt" };
					}
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

	test("continues ordinary events with undefined optional fields", async () => {
		const runner = makeRunner([
			registration(
				"*",
				async (_invocation, _capabilities, next) => await next(),
				{ capabilities: ["ui.transform"] },
				0,
			),
		]);
		expect(await runner.emitInput("hello", undefined, "interactive")).toEqual({});
		expect(await runner.emitBeforeAgentStart("hello", undefined, [])).toBeUndefined();
	});

	test("returns before-agent prompt and image transformations without legacy handlers", async () => {
		const runner = makeRunner([
			registration(
				"before_agent_start",
				async invocation => ({
					action: "continue",
					event: {
						...invocation.payload,
						prompt: "redacted",
						images: undefined,
						systemPrompt: ["safe system"],
					},
				}),
				{ capabilities: ["ui.transform"] },
				0,
			),
		]);
		expect(
			await runner.emitBeforeAgentStart(
				"secret",
				[{ type: "image", data: "base64", mimeType: "image/png" }],
				["system"],
			),
		).toEqual({ prompt: "redacted", images: undefined, systemPrompt: ["safe system"] });
	});

	test("does not treat concurrent top-level dispatches as recursive re-entry", async () => {
		const runner = makeRunner([
			registration(
				"tool_call",
				async (_invocation, _capabilities, next) => {
					await Bun.sleep(10);
					return await next();
				},
				{ capabilities: ["tool.inspect"] },
				0,
				"read",
			),
		]);
		const results = await Promise.all(Array.from({ length: 20 }, () => runner.emitToolCall(toolCall())));
		expect(results.every(result => result === undefined)).toBe(true);
	});

	test("rejects transformed tool identity", async () => {
		const runner = makeRunner([
			registration(
				"tool_call",
				async invocation => ({
					action: "continue",
					event: { ...(invocation.payload as ToolCallEvent), toolName: "bash" },
				}),
				{ capabilities: ["tool.transform"] },
				0,
				"read",
			),
		]);
		expect((await runner.emitToolCall(toolCall()))?.block).toBe(true);
	});

	test("rejects transformations for unsupported lifecycle events", async () => {
		const runner = makeRunner([
			registration(
				"resources_discover",
				async () => ({
					action: "continue",
					event: { type: "resources_discover", cwd: 42 } as never,
				}),
				{ capabilities: ["ui.transform"] },
				0,
			),
		]);
		const original = { type: "resources_discover", cwd: process.cwd(), reason: "startup" } as const;
		const result = await runner.emitFunctionHooks(original);
		expect(result).toEqual({ action: "continue", event: original });
	});

	test("rejects malformed transformed tool-result content", async () => {
		const runner = makeRunner([
			registration(
				"tool_result",
				async invocation => ({
					action: "continue",
					event: { ...invocation.payload, content: [{ type: "text" }] } as never,
				}),
				{ capabilities: ["tool.transform"] },
				0,
				"read",
			),
		]);
		const result = await runner.emitToolResult({
			type: "tool_result",
			toolName: "read",
			toolCallId: "call-1",
			input: { path: "file.txt" },
			content: [{ type: "text", text: "safe" }],
			details: undefined,
			isError: false,
		});
		expect(result?.isError).toBe(true);
	});

	test("validates transformed tool calls against the active tool schema", async () => {
		let executed = false;
		const runner = makeRunner([
			registration(
				"tool_call",
				async invocation => ({
					action: "continue",
					event: { ...(invocation.payload as ToolCallEvent), input: {} },
				}),
				{ capabilities: ["tool.transform"] },
				0,
				"read",
			),
		]);
		const wrapped = new ExtensionToolWrapper(
			{
				name: "read",
				label: "Read",
				description: "Read a file",
				parameters: Type.Object({ path: Type.String() }, { additionalProperties: false }),
				execute: async () => {
					executed = true;
					return { content: [{ type: "text" as const, text: "ok" }] };
				},
			},
			runner,
		);
		await expect(wrapped.execute("call-1", { path: "safe.txt" })).rejects.toThrow();
		expect(executed).toBe(false);
	});

	test("snapshots a returned transformation before downstream dispatch", async () => {
		const runner = makeRunner([
			registration(
				"tool_call",
				async invocation => {
					const candidate = {
						...(invocation.payload as ToolCallEvent),
						input: { path: "reviewed.txt" },
					};
					void Bun.sleep(1).then(() => {
						candidate.input.path = "mutated-after-return.txt";
					});
					return { action: "continue", event: candidate };
				},
				{ capabilities: ["tool.transform"] },
				0,
				"read",
			),
			registration(
				"tool_call",
				async (invocation, _capabilities, next) => {
					await Bun.sleep(10);
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

	test("fails closed when a replacement cannot be snapshotted", async () => {
		const runner = makeRunner([
			registration(
				"tool_call",
				async invocation => {
					const candidate = {
						...(invocation.payload as ToolCallEvent),
						input: { path: "proxy.txt" },
					};
					return { action: "continue", event: new Proxy(candidate, {}) };
				},
				{ capabilities: ["tool.transform"] },
				0,
				"read",
			),
		]);
		const event = toolCall();
		expect((await runner.emitToolCall(event))?.block).toBe(true);
		expect(event.input).toEqual({ path: "secret.txt" });
		expect(runner.getFunctionHookAudit().at(-1)?.reason).toBe(
			"Function hook replacement event could not be snapshotted",
		);
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

	test("propagates provider-request cancellation and invalidates capabilities", async () => {
		let invocationAborted = false;
		let notify: (() => void) | undefined;
		const runner = makeRunner([
			registration(
				"before_provider_request",
				async (invocation, capabilities) => {
					notify = () => capabilities.ui?.notify("late");
					invocationAborted = invocation.signal.aborted;
					await new Promise<void>(resolve => {
						if (invocation.signal.aborted) {
							resolve();
							return;
						}
						invocation.signal.addEventListener(
							"abort",
							() => {
								invocationAborted = true;
								resolve();
							},
							{ once: true },
						);
					});
				},
				{ capabilities: ["ui.transform", "ui.notify"] },
				0,
			),
		]);
		const controller = new AbortController();
		const pending = runner.emitBeforeProviderRequest({ prompt: "secret" }, undefined, controller.signal);
		controller.abort(new Error("cancelled"));
		await expect(pending).rejects.toThrow("Function hook timed out");
		expect(invocationAborted).toBe(true);
		expect(() => notify?.()).toThrow("no longer active");
	});
});
