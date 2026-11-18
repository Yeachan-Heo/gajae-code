// HTTP/SSE provider only. The packaged host retains its real serializer, tools,
// persistence, extension loader and worker implementations.
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as util from "node:util";

export const FIXTURE_KEY = "standalone-fixture-not-a-provider-secret";
export const FIXTURE_MODEL = "standalone-fixture/offline";
export const FIXTURE_IMAGE =
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC";
export const QUESTION_PROMPT = "standalone reverse UI";
export const QUESTION_TITLE = "Standalone packaged reverse UI";
export const QUESTION_ANSWER = "standalone answer accepted";

export interface FixtureTool {
	name: string;
	arguments: Record<string, unknown>;
	/** Required observable text in the actual tool result sent back to the provider. */
	result: string;
}
export interface FixtureTurn {
	prompt: string;
	answer: string;
	tools?: FixtureTool[];
	image?: boolean;
}
interface WireMessage {
	role: string;
	content?: unknown;
	tool_call_id?: string;
	tool_calls?: Array<{ id: string; function: { name: string; arguments: string } }>;
}
export interface FixtureEvidence {
	turn: string;
	phase: number;
	tool?: string;
	callId?: string;
	arguments?: Record<string, unknown>;
	observedResult?: string;
	image: boolean;
}

function assert(condition: unknown, message: string): asserts condition {
	if (!condition) throw new Error(`Fixture protocol: ${message}`);
}
function text(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	const parts: unknown[] = content;
	return parts
		.flatMap(part => {
			if (!part || typeof part !== "object" || !("type" in part) || part.type !== "text") return [];
			assert("text" in part && typeof part.text === "string", "invalid text content part");
			return [part.text];
		})
		.join("");
}

export interface StandaloneFixture {
	baseUrl: string;
	token: string;
	arm(turn: FixtureTurn): void;
	assertComplete(): void;
	snapshot(): { evidence: FixtureEvidence[]; titleRequests: string[]; failure: string | undefined };
	close(): Promise<void>;
}

/** Each armed turn has exactly N tool calls followed by one final answer. */
export function startStandaloneFixture(): StandaloneFixture {
	let turn: FixtureTurn | undefined;
	let phase = 0;
	let requests = 0;
	const calls: string[] = [];
	let failure: Error | undefined;
	const evidence: FixtureEvidence[] = [];
	const titleRequests: string[] = [];
	const token = crypto.randomUUID();
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		maxRequestBodySize: 8 * 1024 * 1024,
		async fetch(request) {
			try {
				const requestId = ++requests;
				assert(requestId <= 128, "request budget exceeded");
				const url = new URL(request.url);
				assert(
					url.origin === `http://127.0.0.1:${server.port}` &&
						!url.search &&
						((request.method === "POST" && url.pathname === "/v1/chat/completions") ||
							(request.method === "GET" && url.pathname === "/v1/models")),
					`unexpected endpoint (${request.method} ${url.pathname})`,
				);
				assert(
					request.headers.get("Authorization") === `Bearer ${FIXTURE_KEY}` &&
						request.headers.get("X-Standalone-Fixture") === token &&
						!request.headers.has("Origin"),
					"unexpected client",
				);
				if (request.method === "GET") {
					return Response.json({ object: "list", data: [{ id: "offline", object: "model" }] });
				}
				const body = (await request.json()) as {
					model?: string;
					stream?: boolean;
					messages?: WireMessage[];
					tool_choice?: { type?: string; function?: { name?: string } };
					tools?: Array<{ type: string; function: { name: string } }>;
				};
				assert(
					body.model === "offline" && body.stream === true && Array.isArray(body.messages),
					"model/stream/messages",
				);
				const messages = body.messages;
				let delta: Record<string, unknown>;
				let finish = "stop";
				if (body.tool_choice?.function?.name === "set_title") {
					assert(
						body.tool_choice.type === "function" &&
							body.tools?.length === 1 &&
							body.tools[0]?.function.name === "set_title" &&
							messages.length === 2 &&
							messages[0]?.role === "system" &&
							text(messages[0].content).startsWith("Generate a 3-6 word title for a coding session") &&
							messages[1]?.role === "user",
						"unexpected title request",
					);
					titleRequests.push(text(messages[1].content));
					delta = {
						tool_calls: [
							{
								index: 0,
								id: `title-${titleRequests.length}`,
								type: "function",
								function: {
									name: "set_title",
									arguments: JSON.stringify({ title: "Standalone Packaged Fixture Session" }),
								},
							},
						],
					};
					finish = "tool_calls";
				} else {
					assert(turn, "unarmed model request");
					const userIndex = messages.findLastIndex(message => message.role === "user");
					const user = messages[userIndex];
					assert(
						user && text(user.content) === turn.prompt,
						`expected prompt ${JSON.stringify(turn.prompt)}, got ${JSON.stringify(user?.content)}`,
					);
					const imageParts = Array.isArray(user.content)
						? user.content.filter(part => part && typeof part === "object" && part.type === "image_url")
						: [];
					assert(Boolean(imageParts.length) === Boolean(turn.image), "image envelope does not match turn");
					if (turn.image)
						assert(
							imageParts.length === 1 &&
								imageParts[0].image_url?.url === `data:image/png;base64,${FIXTURE_IMAGE}`,
							"image bytes changed in provider serialization",
						);
					const results = messages.slice(userIndex + 1).filter(message => message.role === "tool");
					assert(results.length === phase, `expected ${phase} tool results, got ${results.length}`);
					const tools = turn.tools ?? [];
					const serializedCalls = messages.slice(userIndex + 1).flatMap(message => message.tool_calls ?? []);
					assert(serializedCalls.length === phase, "unexpected assistant tool-call count");
					let observedResult: string | undefined;
					for (let index = 0; index < phase; index++) {
						const result = results[index]!;
						// Validate call/result linkage from actual serialized history, not model claims.
						const call = serializedCalls[index];
						assert(
							call &&
								call.id === calls[index] &&
								result.tool_call_id === call.id &&
								call.function.name === tools[index]!.name &&
								util.isDeepStrictEqual(JSON.parse(call.function.arguments), tools[index]!.arguments),
							`tool ${index} call/result linkage or arguments changed`,
						);
						observedResult = text(result.content);
						assert(
							observedResult.includes(tools[index]!.result),
							`tool ${tools[index]!.name} missing result ${JSON.stringify(tools[index]!.result)}: ${observedResult}`,
						);
					}
					const tool = tools[phase];
					const callId = `standalone-tool-${evidence.length + 1}`;
					evidence.push({
						turn: turn.prompt,
						phase,
						image: Boolean(turn.image),
						...(tool ? { tool: tool.name, callId, arguments: tool.arguments } : {}),
						...(observedResult ? { observedResult } : {}),
					});
					if (tool) {
						assert(
							body.tools?.some(candidate => candidate.function.name === tool.name),
							`tool ${tool.name} was not advertised`,
						);
						calls.push(callId);
						delta = {
							tool_calls: [
								{
									index: 0,
									id: callId,
									type: "function",
									function: { name: tool.name, arguments: JSON.stringify(tool.arguments) },
								},
							],
						};
						finish = "tool_calls";
						phase++;
					} else {
						delta = { content: turn.answer };
						turn = undefined;
					}
				}
				const responseId = `standalone-${requestId}`;
				const chunk = (value: Record<string, unknown>, stop: string | null = null) =>
					JSON.stringify({
						id: responseId,
						object: "chat.completion.chunk",
						created: 1700000000,
						model: "offline",
						choices: [{ index: 0, delta: value, finish_reason: stop }],
					});
				return new Response(
					[
						chunk({ role: "assistant", content: "" }),
						chunk(delta),
						chunk({}, finish),
						JSON.stringify({
							id: responseId,
							object: "chat.completion.chunk",
							created: 1700000000,
							model: "offline",
							choices: [],
							usage: { prompt_tokens: 32, completion_tokens: 16, total_tokens: 48 },
						}),
						"[DONE]",
					]
						.map(value => `data: ${value}\n\n`)
						.join(""),
					{
						headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-store" },
					},
				);
			} catch (error) {
				failure ??= error instanceof Error ? error : new Error(String(error));
				return new Response(failure.message, { status: 400 });
			}
		},
	});
	return {
		baseUrl: `http://127.0.0.1:${server.port}/v1`,
		token,
		arm(next: FixtureTurn) {
			if (failure) throw failure;
			assert(!turn, "previous turn did not complete");
			turn = next;
			phase = 0;
			calls.length = 0;
		},
		assertComplete() {
			if (failure) throw failure;
			assert(!turn, `unfinished turn ${turn?.prompt}`);
		},
		snapshot: () => ({
			evidence: structuredClone(evidence),
			titleRequests: [...titleRequests],
			failure: failure?.message,
		}),
		close: () => server.stop(true),
	};
}

export async function seedStandaloneFixture(root: string, baseUrl: string, token: string): Promise<void> {
	const agent = path.join(root, "data/agent");
	for (const directory of [path.join(agent, "extensions"), path.join(root, "project"), path.join(root, "home")])
		await fs.mkdir(directory, { recursive: true, mode: 0o700 });
	await Bun.write(
		path.join(agent, "models.yml"),
		JSON.stringify({
			providers: {
				"standalone-fixture": {
					api: "openai-completions",
					baseUrl,
					apiKey: FIXTURE_KEY,
					headers: { "X-Standalone-Fixture": token },
					models: [
						{
							id: "offline",
							name: "Standalone loopback fixture",
							reasoning: false,
							input: ["text", "image"],
							contextWindow: 131072,
							maxTokens: 2048,
							cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
						},
					],
				},
			},
		}),
	);
	await Bun.write(
		path.join(agent, "config.yml"),
		JSON.stringify({
			modelRoles: { default: FIXTURE_MODEL },
			compaction: { enabled: false },
			retry: { enabled: false },
			async: { enabled: true, pollWaitDuration: "5s" },
			shellPath: "/bin/bash",
		}),
	);
	// Ordinary user-extension API, loaded by the real packaged extension loader.
	// No host fixture controls, private SDK mutation or pre-computed success frame.
	await Bun.write(
		path.join(agent, "extensions/standalone-ui.ts"),
		`
export default function(pi) {
  pi.on("input", async (event, ctx) => {
    if (event.text !== ${JSON.stringify(QUESTION_PROMPT)}) return;
    const answer = await ctx.ui.input(${JSON.stringify(QUESTION_TITLE)});
    await Bun.write(${JSON.stringify(path.join(root, "reverse-ui-answer.txt"))}, String(answer));
    if (answer !== ${JSON.stringify(QUESTION_ANSWER)}) throw new Error("Standalone reverse UI answer mismatch");
    return { action: "continue" };
  });
}
`,
	);
}
