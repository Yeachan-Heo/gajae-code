/**
 * Muse Code subscription (Meta) Responses transport.
 * Presents the official CLI identity (headers/body fingerprint) required by the subscription gate.
 */
import { randomBytes } from "node:crypto";
import { logger, readSseJson } from "@gajae-code/utils";
import type { ResponseCreateParamsStreaming, ResponseInput, ResponseStreamEvent } from "openai/resources/responses/responses";
import { getEnvApiKey } from "../stream";
import type { Context, FetchImpl, Model, ProviderSessionState, StreamOptions, ToolChoice, ToolResultMessage } from "../types";
import { neutralizeReservedControlTokens, neutralizeResponsesInputControlTokens, normalizeSystemPrompts } from "../utils";
import { createAbortSourceTracker } from "../utils/abort";
import { AssistantMessageEventStream } from "../utils/event-stream";
import { getOpenAIStreamIdleTimeoutMs, getProviderFirstEventTimeoutFallbackMs, getStreamFirstEventTimeoutMs, iterateWithIdleTimeout } from "../utils/idle-iterator";
import { notifyProviderResponse } from "../utils/provider-response";
import { mapToOpenAIResponsesToolChoice } from "../utils/tool-choice";
import { transportFailureFacts } from "../utils/fallback-transport";
import { convertTools } from "./openai-responses";
import {
  appendResponsesToolResultMessages, applyCommonResponsesSamplingParams, applyResponsesReasoningParams,
  convertResponsesAssistantMessage, convertResponsesInputContent, createInitialResponsesAssistantMessage,
  isOpenAIResponsesProgressEvent, normalizeResponsesToolCallIdForTransform, processResponsesStream,
  repairOrphanResponsesToolOutputs, type ResponsesSamplingParamsExtras, unexpectedResponsesStreamEndError,
} from "./openai-responses-shared";
import { transformMessages } from "./transform-messages";

export interface MetaMuseResponsesOptions extends StreamOptions {
  reasoning?: "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
  reasoningSummary?: "auto" | "detailed" | "concise" | null;
  toolChoice?: ToolChoice;
  fetchOverride?: FetchImpl;
}

type Json = Record<string, any>;
const record = (value: unknown): value is Json =>
  value !== null && typeof value === "object" && !Array.isArray(value);

export type MuseRandomBytes = (size: number) => Buffer;

export function sessionKeyFor(original: Json): string {
  const messages: Json[] = Array.isArray(original.input)
    ? original.input.filter(item => record(item) && item.type === "message") : [];
  const first = messages.find(item => item.role === "user") ?? messages[0];
  const content = first?.content ?? "";
  return typeof content === "string" ? content : JSON.stringify(content, (_key, value) =>
    record(value) ? Object.fromEntries(Object.keys(value).sort().map(key => [key, value[key]])) : value);
}

export function mintSessionId(rng: MuseRandomBytes = randomBytes, now = Date.now()): string {
  const bytes = Buffer.from(rng(16));
  bytes.writeUIntBE(now, 0, 6);
  bytes[6] = (bytes[6] & 0x0f) | 0x70;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-` +
    `${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function resolveMuseSessionId(
  original: Json, sessions: Map<string, string>, rng: MuseRandomBytes = randomBytes, now = Date.now(),
): string {
  const key = sessionKeyFor(original);
  const session = sessions.get(key) ?? mintSessionId(rng, now);
  // Map insertion order tracks recency, including reads of existing sessions.
  sessions.delete(key);
  sessions.set(key, session);
  if (sessions.size > 512) sessions.delete(sessions.keys().next().value!);
  return session;
}

export function buildFingerprintHeaders(
  authorization: string | null | undefined, body: Json, session: string,
  rng: MuseRandomBytes = randomBytes, platformName: string = process.platform, arch: string = process.arch,
) {
  const platform = platformName === "win32" ? "windows-x86_64" : ({
    "darwin/arm64": "macos-aarch64", "darwin/x64": "macos-x86_64",
    "linux/arm64": "linux-aarch64", "linux/x64": "linux-x86_64",
  } as Record<string, string>)[`${platformName}/${arch}`];
  if (!platform) throw new Error("Unsupported Muse CLI platform");
  // Rebuild the application headers; fetch owns host/length/transport headers.
  const headers = new Headers({
    "content-type": "application/json",
    "user-agent": `muse-build/1.4.14 (non-interactive; ${platform}; build dec7d7497fecdad135ec5835a8161dbc92e55b58)`,
    "x-client-id": "tbh:exec",
    "x-tbh-session-id": session,
    "x-meta-ai-gateway-session-id": session,
    "x-tbh-thread-id": session,
    "x-tbh-root-session-id": session,
    "x-tbh-agent-role": "main",
    traceparent: `00-${rng(16).toString("hex")}-${rng(8).toString("hex")}-01`,
  });
  if (authorization != null) headers.set("authorization", authorization);
  if (typeof body.model === "string" && body.model.includes("-contributor")) {
    headers.set("x-tbh-contributor-mode", "1");
  }
  // The CLI always streams Responses requests; never let fetch inject `*/*`.
  headers.set("accept", "text/event-stream");
  return headers;
}

export function buildFingerprintBody(original: Json, session: string) {
  const body: Json = {};
  for (const key of [
    "model", "instructions", "input", "stream", "store", "max_output_tokens", "reasoning", "include",
  ]) {
    if (key in original) body[key] = structuredClone(original[key]);
  }
  if (!("store" in body)) body.store = false;
  body.reasoning = { summary: "auto", ...body.reasoning };
  body.include = Array.isArray(body.include) ? body.include : [];
  if (!body.include.includes("reasoning.encrypted_content")) {
    body.include.push("reasoning.encrypted_content");
  }
  body.prompt_cache_key = `tbh:main:${session}`;
  const tools: unknown[] = Array.isArray(original.tools) ? structuredClone(original.tools) : [];
  const functions = tools.filter(tool => record(tool) && tool.type === "function") as Json[];
  body.tools = [
    ...(functions.length ? [{
      type: "namespace", name: "client", description: "GJC tool set.",
      tools: functions.map(tool => ({ ...tool, strict: false })),
    }] : []),
    ...tools.filter(tool => !record(tool) || tool.type !== "function"),
  ];
  if (Array.isArray(body.input)) {
    for (const item of body.input) {
      if (record(item) && item.type === "function_call" && typeof item.name === "string" &&
          !item.name.startsWith("client.")) item.name = `client.${item.name}`;
    }
  }
  return {
    body, adapted: functions.length,
    restoreName: (name: string) => name.startsWith("client.") ? name.slice(7) : name,
  };
}

export function buildFlatAliasBody(original: Json) {
  const body = structuredClone(original);
  const aliases = new Map<string, string>();
  const tools: Json[] = Array.isArray(body.tools) ? body.tools.filter(record) : [];
  const occupied = new Set(tools.map(tool => tool.name).filter(name => typeof name === "string"));
  for (const tool of tools) {
    if (tool.type !== "function" || typeof tool.name !== "string") continue;
    const name = tool.name;
    if (!aliases.has(name)) {
      const base = `client_${name}`;
      let alias = base;
      for (let suffix = 2; occupied.has(alias); suffix++) alias = `${base}_${suffix}`;
      occupied.add(alias);
      aliases.set(name, alias);
    }
    tool.name = aliases.get(name);
  }
  if (Array.isArray(body.input)) {
    for (const item of body.input) {
      if (record(item) && item.type === "function_call" && aliases.has(item.name)) {
        item.name = aliases.get(item.name);
      }
    }
  }
  if (body.tool_choice !== "auto") body.tool_choice = "auto";
  if (!("prompt_cache_retention" in body)) body.prompt_cache_retention = "24h";
  const reverse = new Map([...aliases].map(([name, alias]) => [alias, name]));
  return { body, adapted: aliases.size, restoreName: (name: string) => reverse.get(name) ?? name };
}

export function createRestorer(restoreName: (name: string) => string, namespace: boolean) {
  // Keep item, call and positional identities linked for interleaved tool calls.
  const argumentsByKey = new Map<string, { text: string }>();
  const keys = (item: Json, index?: number): string[] => [
    ...(typeof item.id === "string" ? [`id:${item.id}`] : []),
    ...(typeof item.item_id === "string" ? [`id:${item.item_id}`] : []),
    ...(typeof item.call_id === "string" ? [`call:${item.call_id}`] : []),
    ...(typeof index === "number" ? [`index:${index}`] : []),
  ];
  const state = (item: Json, index?: number) => {
    const identities = keys(item, index);
    const saved = identities.map(key => argumentsByKey.get(key)).find(Boolean) ?? { text: "" };
    for (const key of identities) argumentsByKey.set(key, saved);
    return saved;
  };
  const name = (item: Json) => {
    if (typeof item.name === "string") item.name = restoreName(item.name);
  };
  const call = (item: Json, index?: number, complete = true) => {
    if (item.type !== "function_call") return;
    name(item);
    const saved = state(item, index);
    if (complete && !item.arguments && saved.text) item.arguments = saved.text;
  };
  const response = (value: Json) => {
    if (Array.isArray(value.output)) {
      value.output.forEach((item: unknown, index: number) => {
        if (record(item)) call(item, index);
      });
    }
    if (Array.isArray(value.tools)) {
      if (namespace) {
        // GJC consumes flat function echoes, so unwrap only our own container.
        value.tools = value.tools.flatMap((tool: unknown) =>
          record(tool) && tool.type === "namespace" && tool.name === "client" && Array.isArray(tool.tools)
            ? tool.tools : [tool]);
      }
      for (const tool of value.tools) {
        if (record(tool) && tool.type === "function") name(tool);
      }
    }
  };
  return (value: unknown) => {
    if (!record(value)) return value;
    if (value.type === "response.function_call_arguments.delta" && typeof value.delta === "string") {
      state(value, value.output_index).text += value.delta;
    }
    if (value.type === "response.function_call_arguments.done") {
      name(value);
      const saved = state(value, value.output_index);
      if (!value.arguments && saved.text) value.arguments = saved.text;
    }
    if ((value.type === "response.output_item.added" || value.type === "response.output_item.done") &&
        record(value.item)) {
      call(value.item, value.output_index, value.type === "response.output_item.done");
    }
    response(value);
    if (record(value.response)) response(value.response);
    return value;
  };
}


interface MuseProviderSessionState extends ProviderSessionState {
  sessions: Map<string, string>;
}
const MUSE_PROVIDER_SESSION_STATE_KEY = "meta-muse-responses";
const processSessions = new Map<string, string>();

function getMuseSessions(owner?: Map<string, ProviderSessionState>): Map<string, string> {
  if (!owner) return processSessions;
  const existing = owner.get(MUSE_PROVIDER_SESSION_STATE_KEY) as MuseProviderSessionState | undefined;
  if (existing) return existing.sessions;
  const sessions = new Map<string, string>();
  owner.set(MUSE_PROVIDER_SESSION_STATE_KEY, { sessions, close() { sessions.clear(); } } as MuseProviderSessionState);
  return sessions;
}

/** Minimal Responses builder using the same conversation and schema helpers as openai-responses. */
export function buildMetaMuseRequest(model: Model<"meta-muse-responses">, context: Context, options?: MetaMuseResponsesOptions): Json {
  const messages: ResponseInput = [];
  const knownCallIds = new Set<string>();
  const customCallIds = new Set<string>();
  const transformed = transformMessages(context.messages, model, normalizeResponsesToolCallIdForTransform);
  let pending: ToolResultMessage[] = [];
  const flush = () => {
    appendResponsesToolResultMessages(messages, pending, model, false, knownCallIds, customCallIds);
    pending = [];
  };
  transformed.forEach((message, index) => {
    if (message.role === "toolResult") {
      pending.push(message);
      return;
    }
    flush();
    if (message.role === "user" || message.role === "developer") {
      const content = convertResponsesInputContent(message.content, model.input.includes("image"));
      if (content) messages.push({ type: "message", role: "user", content });
    } else if (message.role === "assistant") {
      messages.push(...convertResponsesAssistantMessage(message, model, index, knownCallIds, false, customCallIds));
    }
  });
  flush();
  const input = neutralizeResponsesInputControlTokens(repairOrphanResponsesToolOutputs(messages));
  const params: ResponseCreateParamsStreaming & ResponsesSamplingParamsExtras = {
    model: model.wireModelId ?? model.id,
    input,
    stream: true,
    store: false,
  };
  const instructions = normalizeSystemPrompts(context.systemPrompt).map(neutralizeReservedControlTokens);
  if (instructions.length) params.instructions = instructions.join("\n\n");
  applyCommonResponsesSamplingParams(params, options, model.provider);
  applyResponsesReasoningParams(params, model, options, input);
  if (context.tools) {
    params.tools = convertTools(context.tools, false, { ...model, api: "openai-responses" });
    if (options?.toolChoice) params.tool_choice = mapToOpenAIResponsesToolChoice(options.toolChoice);
  }
  return params;
}

function responsesUrl(baseUrl: string): URL {
  const url = new URL(baseUrl);
  url.pathname = `${url.pathname.replace(/\/+$/g, "")}/responses`;
  return url;
}
/** Typed upstream error facts (status + error.code/message) so the SDK auth
 * classifier and retry admission see the same evidence openai-responses
 * surfaces; downstream redaction still owns any secret-bearing messages. */
function museHttpError(status: number, bodyText: string | undefined): Error & { status: number; error?: { code?: string; message?: string } } {
  let code: string | undefined;
  let message: string | undefined;
  try {
    const value: unknown = bodyText ? JSON.parse(bodyText) : undefined;
    const error = record(value) ? value.error : undefined;
    if (record(error)) {
      if (typeof error.code === "string") code = error.code;
      if (typeof error.message === "string") message = error.message;
    }
  } catch {
    // Non-JSON error bodies keep the sanitized fallback message.
  }
  const typed: { code?: string; message?: string } | undefined =
    code !== undefined || message !== undefined
      ? { ...(code !== undefined ? { code } : {}), ...(message !== undefined ? { message } : {}) }
      : undefined;
  return Object.assign(new Error(message ?? `Muse request failed (HTTP ${status})`), {
    status, ...(typed !== undefined ? { error: typed } : {}),
  });
}

/** Restore before shared decoding; JSON responses use the same output-item event contract. */
export async function* decodeMetaMuseResponse(
  response: Response, restore: (value: unknown) => unknown, signal?: AbortSignal,
  onSseEvent?: MetaMuseResponsesOptions["onSseEvent"], model?: Model<"meta-muse-responses">,
  attemptScope?: MetaMuseResponsesOptions["attemptScope"],
): AsyncGenerator<ResponseStreamEvent> {
  if (!response.body) throw new Error("No Muse response body");
  if (response.headers.get("content-type")?.includes("application/json")) {
    const value = restore(await response.json()) as Json;
    if (!record(value) || !Array.isArray(value.output)) throw new Error("Invalid Muse JSON response");
    for (const [output_index, item] of value.output.entries()) {
      yield { type: "response.output_item.added", output_index, item } as ResponseStreamEvent;
      yield { type: "response.output_item.done", output_index, item } as ResponseStreamEvent;
    }
    const type = value.status === "failed" ? "response.failed" : value.status === "incomplete" ? "response.incomplete" : "response.completed";
    yield { type, response: value } as ResponseStreamEvent;
    return;
  }
  for await (const event of readSseJson<Json>(response.body, signal, raw => {
    // Diagnostic observers cannot change transport behavior.
    try { onSseEvent?.({ event: raw.event, data: raw.data, raw: [...raw.raw] }, model, attemptScope); } catch {}
  })) {
    yield restore(event) as ResponseStreamEvent;
  }
}

export function streamMetaMuseResponses(
  model: Model<"meta-muse-responses">, context: Context, options?: MetaMuseResponsesOptions,
): AssistantMessageEventStream {
  const stream = new AssistantMessageEventStream();
  void (async () => {
    const output = createInitialResponsesAssistantMessage("meta-muse-responses", model.provider, model.id);
    const started = Date.now();
    const abort = createAbortSourceTracker(options?.signal);
    let path = "/responses";
    let adapted = 0;
    let mode = "fingerprint";
    let retried = false;
    try {
      abort.requestSignal.throwIfAborted();
      const url = responsesUrl(model.baseUrl);
      path = url.pathname;
      let original = buildMetaMuseRequest(model, context, options);
      const replacement = await options?.onPayload?.(original, model, options.attemptScope, abort.requestSignal);
      if (replacement !== undefined) {
        if (!record(replacement)) throw new Error("Invalid Muse request payload");
        original = replacement;
      }
      const session = resolveMuseSessionId(original, getMuseSessions(options?.providerSessionState));
      const apiKey = options?.apiKey || getEnvApiKey(model.provider) || "";
      // The subscription transport uses Bearer authorization.
      const headers = buildFingerprintHeaders(apiKey ? `Bearer ${apiKey}` : undefined, original, session);
      let adaptation = buildFingerprintBody(original, session);
      adapted = adaptation.adapted;
      const send = async () => {
        abort.requestSignal.throwIfAborted();
        options?.onStreamCreated?.();
        const response = await (options?.fetchOverride ?? options?.fetch ?? globalThis.fetch)(url, {
          method: "POST", headers, body: JSON.stringify(adaptation.body), signal: abort.requestSignal, redirect: "manual",
        });
        await notifyProviderResponse(options, response, model);
        return response;
      };
      let response = await send();
      if (response.status === 403) {
        const denied = await response.text();
        if (denied.includes("client_attestation_denied")) {
          adaptation = buildFlatAliasBody(original);
          adapted = adaptation.adapted;
          mode = "flat-alias";
          retried = true;
          response = await send();
        } else if (!response.ok) {
          throw museHttpError(response.status, denied);
        }
      }
      if (!response.ok) {
        const bodyText = response.bodyUsed ? undefined : await response.text().catch(() => undefined);
        throw museHttpError(response.status, bodyText);
      }
      stream.push({ type: "start", partial: output });
      const idleTimeoutMs = options?.streamIdleTimeoutMs ?? getOpenAIStreamIdleTimeoutMs();
      const events = decodeMetaMuseResponse(response, createRestorer(adaptation.restoreName, mode === "fingerprint"),
        abort.requestSignal, options?.onSseEvent, model, options?.attemptScope);
      const terminal = await processResponsesStream(iterateWithIdleTimeout(events, {
        idleTimeoutMs,
        firstItemTimeoutMs: options?.streamFirstEventTimeoutMs ?? getStreamFirstEventTimeoutMs(idleTimeoutMs, getProviderFirstEventTimeoutFallbackMs(model.provider)),
        firstItemErrorMessage: "Muse stream timed out while waiting for the first event",
        errorMessage: "Muse stream stalled while waiting for the next event",
        onIdle: () => abort.requestAbortController.abort(),
        onFirstItemTimeout: () => abort.requestAbortController.abort(),
        abortSignal: options?.signal,
        isProgressItem: isOpenAIResponsesProgressEvent,
      }), output, stream, model, {
        onFirstToken: () => { output.ttft ??= Date.now() - started; },
      });
      abort.requestSignal.throwIfAborted();
      if (!terminal) throw unexpectedResponsesStreamEndError();
      if (output.stopReason === "error" || output.stopReason === "aborted") throw new Error(output.errorMessage ?? "Muse response failed");
      output.duration = Date.now() - started;
      stream.push({ type: "done", reason: output.stopReason, message: output });
    } catch (error) {
      output.stopReason = abort.wasCallerAbort() ? "aborted" : "error";
      output.errorMessage = error instanceof Error ? error.message : "Muse response failed";
      if (record(error) && typeof error.status === "number") output.errorStatus = error.status;
      // Carry typed transport facts so SDK auth classification and retry
      // admission read the same evidence openai-responses attaches.
      output.transportFailure = transportFailureFacts(error);
      output.duration = Date.now() - started;
      stream.push({ type: "error", reason: output.stopReason, error: output });
    } finally {
      logger.debug("meta-muse-responses: request finished", { path, adapted, mode, retried });
      stream.end();
    }
  })();
  return stream;
}
