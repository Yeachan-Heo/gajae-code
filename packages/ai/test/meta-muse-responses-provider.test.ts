import { afterEach, expect, type Mock, spyOn, test } from "bun:test";
import { logger } from "@gajae-code/utils";
import type { Context, Model } from "../src/types";
import {
  buildFingerprintHeaders, buildFingerprintBody, buildFlatAliasBody, createRestorer,
  sessionKeyFor, mintSessionId, resolveMuseSessionId, streamMetaMuseResponses, buildMetaMuseRequest,
} from "../src/providers/meta-muse-responses";
import * as registry from "../src/providers/register-builtins";
import * as dispatch from "../src/stream";

const rng = (size: number) => Buffer.alloc(size, 0xab);
const message = (content: unknown, role = "user") => ({ type: "message", role, content });
const request = (content: unknown) => ({ input: [message(content)] });
const model = {
  id: "muse-spark-1.3", name: "Muse", api: "meta-muse-responses", provider: "meta-muse",
  baseUrl: "https://api.meta.ai/v1", reasoning: true, input: ["text", "image"],
  contextWindow: 100000, maxTokens: 1000,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
} as const satisfies Model<"meta-muse-responses">;
const context = { systemPrompt: "fixture instructions", messages: [{ role: "user", content: "fixture prompt", timestamp: 0 }] } as unknown as Context;
const fn = (name: string) => ({ type: "function", name, parameters: { type: "object" }, strict: true });
const original = { model: model.id, input: [message("fixture"),
  { type: "function_call", name: "bash", call_id: "c", arguments: "{}" }],
  tools: [fn("bash"), fn("read"), { type: "web_search" }], stream: true,
};
let log: Mock<typeof logger.debug> | undefined;
afterEach(() => { log?.mockRestore(); log = undefined; });

for (const [platform, arch, label] of [
  ["darwin", "arm64", "macos-aarch64"], ["darwin", "x64", "macos-x86_64"],
  ["linux", "arm64", "linux-aarch64"], ["linux", "x64", "linux-x86_64"],
  ["win32", "x64", "windows-x86_64"], ["win32", "arm64", "windows-x86_64"],
]) test(`fingerprint platform ${platform}/${arch}`, () => {
  const headers = buildFingerprintHeaders("Bearer fixture", { model: "muse-contributor" }, "session", rng, platform, arch);
  expect(Object.fromEntries(headers.entries())).toEqual({
    "content-type": "application/json", accept: "text/event-stream", authorization: "Bearer fixture",
    "user-agent": `muse-build/1.4.14 (non-interactive; ${label}; build dec7d7497fecdad135ec5835a8161dbc92e55b58)`,
    "x-client-id": "tbh:exec", "x-tbh-session-id": "session", "x-meta-ai-gateway-session-id": "session",
    "x-tbh-thread-id": "session", "x-tbh-root-session-id": "session", "x-tbh-agent-role": "main",
    "x-tbh-contributor-mode": "1", traceparent: `00-${"ab".repeat(16)}-${"ab".repeat(8)}-01`,
  });
});
test("unsupported platforms fail; auth and contributor headers are conditional", () => {
  for (const [platform, arch] of [["darwin", "ia32"], ["linux", "riscv64"], ["freebsd", "x64"]])
    expect(() => buildFingerprintHeaders(null, {}, "s", rng, platform, arch)).toThrow("Unsupported Muse CLI platform");
  const headers = buildFingerprintHeaders(undefined, { model: "muse" }, "s", rng);
  expect(headers.has("authorization")).toBe(false);
  expect(headers.has("x-tbh-contributor-mode")).toBe(false);
});

test("fingerprint whitelist, defaults, namespace and input names follow the CLI contract", () => {
  const source = { ...original, temperature: 0.2, top_p: 0.8, tool_choice: "required", metadata: { x: 1 },
    max_output_tokens: 12, instructions: "fixture", include: ["other"], reasoning: { effort: "high" } };
  const before = structuredClone(source);
  const result = buildFingerprintBody(source, "sid");
  expect(result.body).toEqual({ model: model.id, instructions: "fixture", stream: true, store: false,
    max_output_tokens: 12, reasoning: { summary: "auto", effort: "high" },
    include: ["other", "reasoning.encrypted_content"], prompt_cache_key: "tbh:main:sid",
    input: [message("fixture"), { type: "function_call", name: "client.bash", call_id: "c", arguments: "{}" }],
    tools: [{ type: "namespace", name: "client", description: "GJC tool set.",
      tools: [ { ...fn("bash"), strict: false }, { ...fn("read"), strict: false } ] }, { type: "web_search" }],
  });
  expect(result.adapted).toBe(2);
  expect(result.restoreName("client.bash")).toBe("bash");
  expect(result.restoreName("other.bash")).toBe("other.bash");
  expect(source).toEqual(before);
  const defaults = buildFingerprintBody({}, "sid").body;
  expect(defaults).toEqual({ store: false, reasoning: { summary: "auto" },
    include: ["reasoning.encrypted_content"], prompt_cache_key: "tbh:main:sid", tools: [] });
  const explicit = buildFingerprintBody({ store: true, reasoning: { summary: null },
    include: ["reasoning.encrypted_content"], input: [{ type: "function_call", name: "client.read" }] }, "sid").body;
  expect(explicit.store).toBe(true);
  expect(explicit.reasoning.summary).toBeNull();
  expect(explicit.include).toHaveLength(1);
  expect(explicit.input[0].name).toBe("client.read");
  expect(buildFingerprintBody({ tools: [null, { type: "web_search" }] }, "sid").body.tools)
    .toEqual([null, { type: "web_search" }]);
});

test("flat aliases avoid collisions, roundtrip names, and preserve explicit retention", () => {
  const source = { ...original, tools: [fn("bash"), fn("client_bash"), fn("client_bash_2"), fn("bash")], tool_choice: "required" };
  const before = structuredClone(source);
  const flat = buildFlatAliasBody(source);
  expect(flat.body.tools.map((tool: any) => tool.name)).toEqual([
    "client_bash_3", "client_client_bash", "client_client_bash_2", "client_bash_3",
  ]);
  expect(flat.adapted).toBe(3);
  expect(flat.body.input[1].name).toBe("client_bash_3");
  expect(flat.restoreName("client_bash_3")).toBe("bash");
  expect(flat.restoreName("unknown")).toBe("unknown");
  expect(flat.body.tool_choice).toBe("auto");
  expect(flat.body.prompt_cache_retention).toBe("24h");
  expect(buildFlatAliasBody({ prompt_cache_retention: "in-memory" }).body.prompt_cache_retention).toBe("in-memory");
  expect(source).toEqual(before);
});

for (const terminal of ["response.completed", "response.failed", "response.incomplete"]) {
  test(`restorer interleaved identities and ${terminal}`, () => {
    const restore = createRestorer(buildFingerprintBody(original, "s").restoreName, true);
    const item = { type: "function_call", id: "fc1", call_id: "c1", name: "client.bash", arguments: "" };
    const other = { ...item, id: "fc2", call_id: "c2", name: "client.read" };
    const events = [
      { type: "response.output_item.added", output_index: 0, item },
      { type: "response.output_item.added", output_index: 1, item: other },
      { type: "response.function_call_arguments.delta", item_id: "fc1", delta: '{"cmd":"한글' },
      { type: "response.function_call_arguments.delta", call_id: "c2", delta: '{"q":1}' },
      { type: "response.function_call_arguments.delta", output_index: 0, delta: '"}' },
      { type: "response.function_call_arguments.done", item_id: "fc1", name: "client.bash", arguments: "" },
      { type: "response.output_item.done", output_index: 0, item },
      { type: "response.output_item.done", output_index: 1, item: other },
      { type: terminal, response: { output: [item, other], tools: [
        { type: "namespace", name: "client", tools: [fn("client.bash")] },
        { type: "namespace", name: "other", tools: [fn("other.read")] }, { type: "web_search" },
      ] } },
    ].map(event => restore(structuredClone(event))) as any[];
    expect(events[0].item.name).toBe("bash");
    expect(events[0].item.arguments).toBe("");
    expect(events[5].arguments).toBe('{"cmd":"한글"}');
    expect(events[6].item.arguments).toBe('{"cmd":"한글"}');
    expect(events[7].item.arguments).toBe('{"q":1}');
    expect(events[8].response.output.map((i: any) => i.name)).toEqual(["bash", "read"]);
    expect(events[8].response.tools).toEqual([fn("bash"), { type: "namespace", name: "other", tools: [fn("other.read")] }, { type: "web_search" }]);
  });
}
test("restorer flat mode, JSON, explicit arguments, and primitive values", () => {
  const flat = buildFlatAliasBody(original);
  const restore = createRestorer(flat.restoreName, false);
  expect(restore(null)).toBeNull();
  expect(restore("unchanged")).toBe("unchanged");
  const value = restore({ output: [{ type: "function_call", name: "client_bash", arguments: '{"name":"client_bash"}' }],
    tools: [fn("client_read"), { type: "namespace", name: "client", tools: [fn("client_read")] }] }) as any;
  expect(value.output[0]).toEqual({ type: "function_call", name: "bash", arguments: '{"name":"client_bash"}' });
  expect(value.tools[0].name).toBe("read");
  expect(value.tools[1].type).toBe("namespace");
});

test("UUIDv7 timestamp, version, variant and injected random bytes", () => {
  const now = Date.now();
  const session = mintSessionId(rng, now);
  expect(session).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  expect(parseInt(session.replaceAll("-", "").slice(0, 12), 16)).toBe(now);
  expect(Math.abs(parseInt(mintSessionId().replaceAll("-", "").slice(0, 12), 16) - Date.now())).toBeLessThan(1000);
});
test("session keys normalize first user content and use the first-message fallback", () => {
  expect(sessionKeyFor({ input: [message("first", "assistant"), message([{ b: 2, a: { z: 1, a: 0 } }]), message("later")] }))
    .toBe('[{"a":{"a":0,"z":1},"b":2}]');
  expect(sessionKeyFor({ input: [message("assistant", "assistant")] })).toBe("assistant");
  expect(sessionKeyFor({ input: [{ role: "user", content: "no type" }, null] })).toBe("");
  expect(sessionKeyFor({})).toBe("");
  const sessions = new Map();
  const first = resolveMuseSessionId(request([{ a: 1, b: 2 }]), sessions, rng, 1);
  expect(resolveMuseSessionId(request([{ b: 2, a: 1 }]), sessions, rng, 2)).toBe(first);
});
test("session LRU capacity 512 promotes reads and isolates instances", () => {
  const sessions = new Map();
  const ids = Array.from({ length: 512 }, (_, n) => resolveMuseSessionId(request(String(n)), sessions, rng, n + 1));
  expect(sessions.size).toBe(512);
  expect(resolveMuseSessionId(request("0"), sessions, rng, 999)).toBe(ids[0]);
  resolveMuseSessionId(request("512"), sessions, rng, 1000);
  expect(sessions.has("0")).toBe(true);
  expect(sessions.has("1")).toBe(false);
  expect(resolveMuseSessionId(request("1"), sessions, rng, 1001)).not.toBe(ids[1]);
  expect(sessions.size).toBe(512);
  expect(resolveMuseSessionId(request("0"), new Map(), rng, 1002)).not.toBe(ids[0]);
});

function sse(events: any[], bytewise = false): Response {
  const bytes = new TextEncoder().encode(": keepalive\r\n\r\n" + events.map(event => `data: ${JSON.stringify(event)}\r\n\r\n`).join("") + "data: [DONE]\n\n");
  return new Response(new ReadableStream({ start(controller) {
    if (bytewise) for (const byte of bytes) controller.enqueue(new Uint8Array([byte]));
    else controller.enqueue(bytes);
    controller.close();
  } }), { headers: { "content-type": "text/event-stream" } });
}
function toolEvents(name = "client.bash") {
  const item = { type: "function_call", id: "fc", call_id: "c", name, arguments: "" };
  return [
    { type: "response.output_item.added", output_index: 0, item },
    { type: "response.function_call_arguments.delta", item_id: "fc", output_index: 0, delta: '{"cmd":"한글"}' },
    { type: "response.function_call_arguments.done", item_id: "fc", name, arguments: "" },
    { type: "response.output_item.done", output_index: 0, item },
    { type: "response.completed", response: { status: "completed", output: [item], usage: { input_tokens: 2, output_tokens: 3, total_tokens: 5 } } },
  ];
}
function harness(replies: Response[]) {
  log = spyOn(logger, "debug").mockImplementation(() => {});
  const calls: { url: string; headers: Headers; body: any; signal?: AbortSignal | null; redirect?: string }[] = [];
  const fetchOverride = async (url: any, init: RequestInit) => {
    calls.push({ url: String(url), headers: new Headers(init.headers), body: JSON.parse(init.body as string), signal: init.signal, redirect: init.redirect });
    const reply = replies.shift();
    if (!reply) throw new Error("Unexpected extra request");
    return reply;
  };
  return { calls, fetchOverride };
}
async function consume(options: any, currentContext = context, currentModel = model) {
  const stream = streamMetaMuseResponses(currentModel, currentContext, options);
  const events = [];
  for await (const event of stream) events.push(event);
  return { events, result: await stream.result() };
}
test("native fetch pipeline encodes, restores byte-split SSE, decodes events and logs safely", async () => {
  const h = harness([sse(toolEvents(), true)]);
  const responseStatuses: number[] = [];
  let rawEvents = 0;
  const result = await consume({ fetchOverride: h.fetchOverride, apiKey: "fixture-secret", maxTokens: 42,
    onResponse: (response: any) => responseStatuses.push(response.status),
    onSseEvent: () => { rawEvents++; throw new Error("diagnostic observer"); },
  }, { ...context, tools: [{ name: "bash", description: "fixture", parameters: { type: "object", properties: {} } }] } as any);
  expect(h.calls).toHaveLength(1);
  expect(h.calls[0].url).toBe("https://api.meta.ai/v1/responses");
  expect(h.calls[0].headers.get("authorization")).toBe("Bearer fixture-secret");
  expect(h.calls[0].redirect).toBe("manual");
  expect(h.calls[0].body.max_output_tokens).toBe(42);
  expect(h.calls[0].body.instructions).toBe(context.systemPrompt);
  expect(h.calls[0].body.tools[0].tools[0].strict).toBe(false);
  expect(h.calls[0].body.input[0].type).toBe("message");
  expect(result.result.content).toContainEqual(expect.objectContaining({ type: "toolCall", name: "bash", arguments: { cmd: "한글" } }));
  expect(result.result.usage.totalTokens).toBe(5);
  expect(result.events.map(e => e.type)).toContain("toolcall_end");
  expect(result.events.at(-1)?.type).toBe("done");
  expect(responseStatuses).toEqual([200]);
  expect(rawEvents).toBe(6); // Shared reader also observes the terminal [DONE] frame.
  expect(log!.mock.calls).toEqual([["meta-muse-responses: request finished", { path: "/v1/responses", adapted: 1, mode: "fingerprint", retried: false }]]);
});

test("attestation 403 retries once with original flat tools and identical headers", async () => {
  const h = harness([new Response("client_attestation_denied", { status: 403 }), sse(toolEvents("client_bash"))]);
  const result = await consume({ fetchOverride: h.fetchOverride, apiKey: "fixture" }, {
    ...context, tools: [{ name: "bash", parameters: { type: "object" } }],
  } as any);
  expect(h.calls).toHaveLength(2);
  expect([...h.calls[0].headers]).toEqual([...h.calls[1].headers]);
  expect(h.calls[0].body.tools[0].type).toBe("namespace");
  expect(h.calls[1].body.tools[0].name).toBe("client_bash");
  expect(h.calls[1].body.tool_choice).toBe("auto");
  expect(h.calls[1].body.prompt_cache_retention).toBe("24h");
  expect((result.result.content[0] as any).name).toBe("bash");
  expect(log!.mock.calls).toEqual([["meta-muse-responses: request finished", { path: "/v1/responses", adapted: 1, mode: "flat-alias", retried: true }]]);
});
for (const [status, body, attempts] of [[403, "other_denial", 1], [401, "client_attestation_denied", 1], [500, "error", 1], [403, "client_attestation_denied", 2]] as const) {
  test(`HTTP ${status}/${body} performs ${attempts} attempts`, async () => {
    const h = harness(Array.from({ length: attempts }, () => new Response(body, { status })));
    const result = await consume({ fetchOverride: h.fetchOverride });
    expect(h.calls).toHaveLength(attempts);
    expect(result.result.stopReason).toBe("error");
    expect(result.result.errorStatus).toBe(status);
    expect(log!.mock.calls).toHaveLength(1);
  });
}
test("provider session state reuses, isolates, closes, and distinguishes first users", async () => {
  const h = harness(Array.from({ length: 5 }, () => sse([toolEvents().at(-1)])));
  const state = new Map();
  const options = { fetchOverride: h.fetchOverride, providerSessionState: state };
  await consume(options);
  await consume(options, { ...context, messages: [...context.messages, { role: "user", content: "later", timestamp: 1 }] });
  await consume({ ...options, providerSessionState: new Map() });
  await consume(options, { ...context, messages: [{ role: "user", content: "different", timestamp: 1 }] });
  state.get("meta-muse-responses").close();
  await consume(options);
  const sessions = h.calls.map(call => call.headers.get("x-tbh-session-id"));
  expect(sessions[0]).toBe(sessions[1]);
  for (const index of [2, 3, 4]) expect(sessions[index]).not.toBe(sessions[0]);
});
test("JSON success is restored and decoded through shared events", async () => {
  const h = harness([Response.json({ status: "completed", output: [
    { type: "function_call", id: "fc", call_id: "c", name: "client.read", arguments: '{"x":1}' },
  ] })]);
  const result = await consume({ fetchOverride: h.fetchOverride });
  expect(result.result.content[0]).toEqual(expect.objectContaining({ name: "read", arguments: { x: 1 } }));
  expect(result.events.at(-1)?.type).toBe("done");
});
test("truncated stream fails; pre-aborted caller never fetches", async () => {
  const h = harness([sse(toolEvents().slice(0, 2))]);
  const result = await consume({ fetchOverride: h.fetchOverride });
  expect(result.result.stopReason).toBe("error");
  const controller = new AbortController(); controller.abort();
  const aborted = await consume({ fetchOverride: h.fetchOverride, signal: controller.signal });
  expect(aborted.result.stopReason).toBe("aborted");
  expect(h.calls).toHaveLength(1);
});
test("request builder handles assistant tool history and contiguous tool results", () => {
  const built = buildMetaMuseRequest(model, { ...context, messages: [context.messages[0],
    { role: "assistant", api: model.api, provider: model.provider, model: model.id, stopReason: "toolUse", timestamp: 1,
      content: [{ type: "toolCall", id: "c|fc", name: "read", arguments: { x: 1 } }] },
    { role: "toolResult", toolCallId: "c|fc", toolName: "read", content: [{ type: "text", text: "fixture result" }], isError: false, timestamp: 2 },
  ] } as unknown as Context);
  expect(built.input.some((item: any) => item.type === "function_call" && item.name === "read")).toBe(true);
  expect(built.input.some((item: any) => item.type === "function_call_output")).toBe(true);
});
test("registry and public stream dispatch load the native provider", async () => {
  const descriptor = registry.getProviderRuntimeDescriptor("meta-muse-responses");
  expect(descriptor).toBeDefined();
  expect(typeof registry.streamMetaMuseResponses).toBe("function");
  expect(typeof (await (descriptor as any).load()).stream).toBe("function");
  const h = harness([sse([toolEvents().at(-1)])]);
  const stream = dispatch.stream(model, context, { fetch: h.fetchOverride as any, apiKey: "fixture", providerSessionState: new Map() });
  for await (const _event of stream) { /* drain */ }
  expect((await stream.result()).stopReason).toBe("stop");
  expect(h.calls).toHaveLength(1);
});

test("SSE output is observable before completion and caller cancellation aborts the request", async () => {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  let cancelled = false;
  const response = new Response(new ReadableStream({ start(value) { controller = value; }, cancel() { cancelled = true; } }), {
    headers: { "content-type": "text/event-stream" },
  });
  const h = harness([response]);
  const abort = new AbortController();
  const stream = streamMetaMuseResponses(model, context, { fetchOverride: h.fetchOverride as any, signal: abort.signal });
  const iterator = stream[Symbol.asyncIterator]();
  expect((await iterator.next()).value.type).toBe("start");
  controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(toolEvents()[0])}\n\n`));
  expect((await iterator.next()).value.type).toBe("toolcall_start");
  abort.abort();
  expect((await iterator.next()).value.type).toBe("error");
  expect((await stream.result()).stopReason).toBe("aborted");
  expect(h.calls[0].signal?.aborted).toBe(true);
  expect(cancelled).toBe(true);
});
test("first-event watchdog terminates a stalled stream and aborts fetch signal", async () => {
  let cancelled = false;
  const h = harness([new Response(new ReadableStream({ cancel() { cancelled = true; } }), {
    headers: { "content-type": "text/event-stream" },
  })]);
  const result = await consume({ fetchOverride: h.fetchOverride, streamFirstEventTimeoutMs: 10, streamIdleTimeoutMs: 100 });
  expect(result.result.stopReason).toBe("error");
  expect(result.result.errorMessage).toContain("first event");
  expect(h.calls[0].signal?.aborted).toBe(true);
  expect(cancelled).toBe(true);
});
for (const terminal of ["response.failed", "response.incomplete"]) {
  test(`shared decoding retains ${terminal} semantics`, async () => {
    const events = toolEvents().slice(0, 2);
    events.push({ type: terminal, response: { status: terminal.split(".")[1],
      error: { code: "fixture_failure", message: "fixture failure" }, output: [] } } as any);
    const h = harness([sse(events)]);
    const result = await consume({ fetchOverride: h.fetchOverride });
    if (terminal === "response.failed") {
      expect(result.result.stopReason).toBe("error");
      expect(result.events.at(-1)?.type).toBe("error");
    } else {
      expect(result.result.stopReason).toBe("length");
      expect((result.result.content[0] as any).incompleteArguments).toBe(true);
    }
  });
}
test("text streaming reaches shared text events and completed content", async () => {
  const item = { type: "message", id: "msg", role: "assistant", status: "in_progress", content: [] };
  const finished = { ...item, status: "completed", content: [{ type: "output_text", text: "hello", annotations: [] }] };
  const h = harness([sse([
    { type: "response.output_item.added", output_index: 0, item },
    { type: "response.content_part.added", item_id: "msg", output_index: 0, content_index: 0,
      part: { type: "output_text", text: "", annotations: [] } },
    { type: "response.output_text.delta", item_id: "msg", output_index: 0, content_index: 0, delta: "hello" },
    { type: "response.output_item.done", output_index: 0, item: finished },
    { type: "response.completed", response: { status: "completed", output: [finished] } },
  ])]);
  const result = await consume({ fetchOverride: h.fetchOverride });
  expect(result.events.map(e => e.type)).toContain("text_delta");
  expect(result.result.content[0]).toEqual(expect.objectContaining({ type: "text", text: "hello" }));
  expect(result.events.at(-1)?.type).toBe("done");
});
test("builder applies reasoning and sampling before whitelist and supports request hooks", async () => {
  const h = harness([sse([toolEvents().at(-1)])]);
  const result = await consume({ fetchOverride: h.fetchOverride, maxTokens: 123, temperature: 0.7, reasoning: "high",
    onPayload: (payload: any) => ({ ...payload, metadata: "drop", instructions: "replacement" }),
  }, context, { ...model, thinking: { minLevel: "low", maxLevel: "high", mode: "effort" } } as any);
  expect(h.calls[0].body.max_output_tokens).toBe(123);
  expect(h.calls[0].body.reasoning).toEqual({ summary: "auto", effort: "high" });
  expect(h.calls[0].body.instructions).toBe("replacement");
  expect(h.calls[0].body).not.toHaveProperty("temperature");
  expect(h.calls[0].body).not.toHaveProperty("metadata");
  expect(result.events.at(-1)?.type).toBe("done");
});
