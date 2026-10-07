import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { AuthStorage, getBundledModel } from "@gajae-code/ai";
import { ModelRegistry } from "../../src/config/model-registry";
import { Settings } from "../../src/config/settings";
import { createMCPFormInputHandler } from "../../src/runtime-mcp/elicitation";
import type { MCPInputRequestHandler } from "../../src/runtime-mcp/types";
import { createAgentSession } from "../../src/sdk/session";
import { SessionManager } from "../../src/session/session-manager";
import type { AskAnswerSource, AskRemoteReceipt, AskSettlement } from "../../src/tools";
import { registerAskAnswerSource } from "../../src/tools/ask-answer-registry";

const context = { serverName: "fixture", originMethod: "tools/call", correlationId: "exchange-1" };
function request(property: Record<string, unknown> = { type: "string" }) {
	return {
		method: "elicitation/create",
		params: {
			message: "Enter a value",
			requestedSchema: {
				type: "object",
				properties: { value: property },
				required: ["value"],
				additionalProperties: false,
			},
		},
	};
}
function handlerWithAnswers(answers: Array<string | undefined>): {
	handler: MCPInputRequestHandler;
	prompts: string[];
} {
	const prompts: string[] = [];
	return {
		prompts,
		handler: createMCPFormInputHandler({
			getUi: () => ({ hasUI: false }),
			getAskAnswerSource: () => ({
				awaitAnswer: async question => {
					prompts.push(question);
					return answers.shift();
				},
			}),
		}),
	};
}

describe("MCP form input user decisions", () => {
	it("collects an actual string answer, including valid empty strings", async () => {
		for (const value of ["specific answer", ""]) {
			const { handler, prompts } = handlerWithAnswers(["Accept", value]);
			expect(await handler("input", request(), context)).toEqual({
				kind: "result",
				result: { action: "accept", content: { value } },
			});
			expect(prompts).toHaveLength(2);
		}
	});
	it("does not conflate a boolean No with cancellation", async () => {
		const { handler } = handlerWithAnswers(["Accept", "No"]);
		expect(await handler("input", request({ type: "boolean" }), context)).toEqual({
			kind: "result",
			result: { action: "accept", content: { value: false } },
		});
	});
	it("preserves the selected enum value", async () => {
		const { handler } = handlerWithAnswers(["Accept", "blue"]);
		expect(await handler("input", request({ type: "string", enum: ["red", "blue"] }), context)).toEqual({
			kind: "result",
			result: { action: "accept", content: { value: "blue" } },
		});
	});
	it("declines without requesting a value", async () => {
		const { handler, prompts } = handlerWithAnswers(["Decline"]);
		expect(await handler("input", request(), context)).toEqual({ kind: "result", result: { action: "decline" } });
		expect(prompts).toHaveLength(1);
	});
	it("maps dismissed action and value prompts to cancel", async () => {
		for (const answers of [[undefined], ["Accept", undefined]]) {
			const { handler } = handlerWithAnswers(answers);
			expect(await handler("input", request(), context)).toEqual({ kind: "result", result: { action: "cancel" } });
		}
	});
	it("rejects invalid actions and enum values instead of accepting them", async () => {
		for (const answers of [["anything"], ["Accept", "green"]]) {
			const { handler } = handlerWithAnswers(answers);
			expect(await handler("input", request({ type: "string", enum: ["blue"] }), context)).toMatchObject({
				kind: "failed",
				reason: "error",
			});
		}
	});
	it("rejects constraints it cannot enforce before asking the user", async () => {
		for (const property of [
			{ type: "array" },
			{ type: "string", pattern: "^allowed$" },
			{ type: "number" },
			{ type: "string", enum: ["same", "same"] },
		]) {
			const { handler, prompts } = handlerWithAnswers(["Accept", "unsafe"]);
			expect(await handler("input", request(property), context)).toMatchObject({
				kind: "failed",
				reason: "unavailable",
			});
			expect(prompts).toEqual([]);
		}
	});
	it("fails immediately headless and discovers a late-registered source", async () => {
		let source: AskAnswerSource | undefined;
		const handler = createMCPFormInputHandler({ getUi: () => ({ hasUI: false }), getAskAnswerSource: () => source });
		expect(await handler("input", request(), context)).toMatchObject({ kind: "failed", reason: "unavailable" });
		const answers = ["Accept", "late"];
		source = { awaitAnswer: async () => answers.shift() };
		expect(await handler("input", request(), context)).toEqual({
			kind: "result",
			result: { action: "accept", content: { value: "late" } },
		});
	});
	it("uses local UI only when it is actually active", async () => {
		const answers = ["Accept", "local"];
		const handler = createMCPFormInputHandler({
			getUi: () => ({
				hasUI: true,
				ui: { select: async () => answers.shift(), input: async () => answers.shift() },
			}),
			getAskAnswerSource: () => {
				throw new Error("remote must not compete with local input");
			},
		});
		expect(await handler("input", request(), context)).toEqual({
			kind: "result",
			result: { action: "accept", content: { value: "local" } },
		});
	});
	it("settles remote receipts with actual user values", async () => {
		const settlements: AskSettlement[] = [];
		const values = ["Accept", "remote"];
		const source: AskAnswerSource = {
			awaitAnswer: async () => {
				throw new Error("typed source required");
			},
			awaitAnswerRequest: async () => ({
				source: "remote",
				interaction: { kind: "value", value: values.shift()! },
				settle: async settlement => {
					settlements.push(settlement);
					return { kind: "committed", ack: { status: "delivered", messageId: 1 } };
				},
			}),
		};
		const handler = createMCPFormInputHandler({ getUi: () => ({ hasUI: false }), getAskAnswerSource: () => source });
		expect(await handler("input", request(), context)).toEqual({
			kind: "result",
			result: { action: "accept", content: { value: "remote" } },
		});
		expect(settlements).toEqual([{ kind: "commit" }, { kind: "commit" }]);
	});
	it("attributes both prompts and strips bidi/format controls", async () => {
		const { handler, prompts } = handlerWithAnswers(["Accept", "safe"]);
		const form = request({ type: "string", title: "value\u202e\u200b\u2028" });
		form.params.message = "request\u202e\u200b\u2029";
		expect(await handler("input", form, context)).toMatchObject({ kind: "result" });
		for (const prompt of prompts) {
			expect(prompt).toContain("MCP server fixture");
			expect(prompt).toContain("untrusted server text");
			expect(prompt).not.toMatch(/[\p{Cc}\p{Cf}\u2028\u2029]/u);
		}
		const rejected = handlerWithAnswers(["Accept", "unsafe"]);
		expect(
			await rejected.handler("input", request({ type: "string", enum: ["value\u202e"] }), context),
		).toMatchObject({ kind: "failed", reason: "unavailable" });
		expect(rejected.prompts).toEqual([]);
	});
	it("does not accept a remote answer that was never committed", async () => {
		for (const kind of ["resolved_without_commit", "invalid_closed"] as const) {
			const source: AskAnswerSource = {
				awaitAnswer: async () => undefined,
				awaitAnswerRequest: async () => ({
					source: "remote",
					interaction: { kind: "value", value: "Accept" },
					settle: async () => ({ kind }),
				}),
			};
			const handler = createMCPFormInputHandler({
				getUi: () => ({ hasUI: false }),
				getAskAnswerSource: () => source,
			});
			expect(await handler("input", request(), context)).toEqual({ kind: "result", result: { action: "cancel" } });
		}
	});
	it("closes invalid remote options and controls without accepting", async () => {
		for (const interaction of [
			{ kind: "value", value: "not offered" },
			{ kind: "control", controlId: "navigation_forward" },
		] as const) {
			const settlements: AskSettlement[] = [];
			const source: AskAnswerSource = {
				awaitAnswer: async () => undefined,
				awaitAnswerRequest: async () => ({
					source: "remote",
					interaction,
					settle: async value => {
						settlements.push(value);
						return { kind: "invalid_closed" };
					},
				}),
			};
			const handler = createMCPFormInputHandler({
				getUi: () => ({ hasUI: false }),
				getAskAnswerSource: () => source,
			});
			expect(await handler("input", request(), context)).toEqual({ kind: "failed", reason: "error" });
			expect(settlements).toEqual([
				{ kind: "invalid", reason: interaction.kind === "value" ? "invalid_option" : "invalid_control" },
			]);
		}
	});
	it("settles a remote receipt arriving after abort without committing", async () => {
		const controller = new AbortController();
		const started = Promise.withResolvers<void>();
		const pending = Promise.withResolvers<AskRemoteReceipt>();
		const settled = Promise.withResolvers<AskSettlement>();
		const source: AskAnswerSource = {
			awaitAnswer: async () => undefined,
			awaitAnswerRequest: async () => {
				started.resolve();
				return pending.promise;
			},
		};
		const handler = createMCPFormInputHandler({ getUi: () => ({ hasUI: false }), getAskAnswerSource: () => source });
		const running = handler("input", request(), { ...context, signal: controller.signal });
		await started.promise;
		controller.abort();
		expect(await running).toEqual({ kind: "failed", reason: "cancelled" });
		pending.resolve({
			source: "remote",
			interaction: { kind: "value", value: "Accept" },
			settle: async value => {
				settled.resolve(value);
				return { kind: "resolved_without_commit" };
			},
		});
		expect(await settled.promise).toEqual({ kind: "resolve_without_commit", reason: "aborted" });
	});
	it("aborts even if an input surface ignores its signal", async () => {
		const controller = new AbortController();
		const pending = Promise.withResolvers<string | undefined>();
		const handler = createMCPFormInputHandler({
			getUi: () => ({ hasUI: false }),
			getAskAnswerSource: () => ({
				awaitAnswer: async () => {
					controller.abort();
					return pending.promise;
				},
			}),
		});
		expect(await handler("input", request(), { ...context, signal: controller.signal })).toEqual({
			kind: "failed",
			reason: "cancelled",
		});
		pending.resolve(undefined);
	});
	it("refuses sampling and malformed form requests", async () => {
		const { handler, prompts } = handlerWithAnswers(["Accept"]);
		for (const value of [
			{ method: "sampling/createMessage" },
			{ method: "elicitation/create", params: { mode: "url", message: "redirect" } },
			{ method: "elicitation/create", params: { requestedSchema: {} } },
		]) {
			expect(await handler("input", value, context)).toMatchObject({ kind: "failed", reason: "unavailable" });
		}
		expect(prompts).toEqual([]);
	});
});

it("registers a real input handler on an owned explicit-config session and resumes the same MCP exchange", async () => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-mcp-input-session-"));
	const received: Record<string, unknown>[] = [];
	const server = Bun.serve({
		port: 0,
		hostname: "127.0.0.1",
		async fetch(req) {
			const body = (await req.json()) as { id: string; method: string; params?: Record<string, unknown> };
			let result: Record<string, unknown> = {};
			if (body.method === "server/discover")
				result = { supportedVersions: ["2026-07-28"], capabilities: { tools: {} } };
			if (body.method === "tools/list") result = { tools: [{ name: "confirm", inputSchema: { type: "object" } }] };
			if (body.method === "tools/call") {
				received.push(body.params ?? {});
				result = body.params?.inputResponses
					? { resultType: "complete", content: [{ type: "text", text: "confirmed" }] }
					: {
							resultType: "input_required",
							requestState: "same-exchange",
							inputRequests: { confirmation: request({ type: "boolean" }) },
						};
			}
			return Response.json({ jsonrpc: "2.0", id: body.id, result });
		},
	});
	const authStorage = await AuthStorage.create(":memory:");
	let disposeSession: (() => Promise<void>) | undefined;
	let disposeSource: (() => void) | undefined;
	try {
		const configPath = path.join(root, "mcp.json");
		await Bun.write(
			configPath,
			JSON.stringify({
				mcpServers: { fixture: { type: "http", url: `http://127.0.0.1:${server.port}`, protocol: "2026-07-28" } },
			}),
		);
		const { session } = await createAgentSession({
			cwd: root,
			agentDir: path.join(root, "agent"),
			modelRegistry: new ModelRegistry(authStorage),
			settings: Settings.isolated({}),
			sessionManager: SessionManager.inMemory(),
			model: getBundledModel("openai", "gpt-4o-mini"),
			disableExtensionDiscovery: true,
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			enableLsp: false,
			toolNames: [],
			mcpConfigPath: configPath,
		});
		disposeSession = () => session.dispose();
		const answers = ["Accept", "Yes"];
		disposeSource = registerAskAnswerSource(
			session.sessionId,
			{ awaitAnswer: async () => answers.shift() },
			"protocol",
		);
		const tool = session.getToolByName("mcp__fixture_confirm");
		expect(tool).toBeDefined();
		const result = await tool!.execute("call-1", {});
		expect(result.content).toEqual([{ type: "text", text: "confirmed" }]);
		expect(received).toHaveLength(2);
		expect(received[1]?.requestState).toBe("same-exchange");
		expect(received[1]?.inputResponses).toEqual({ confirmation: { action: "accept", content: { value: true } } });
	} finally {
		disposeSource?.();
		await disposeSession?.();
		server.stop(true);
		await fs.rm(root, { recursive: true, force: true });
	}
}, 30_000);
