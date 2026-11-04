import { describe, expect, it, spyOn } from "bun:test";
import { gzipSync } from "node:zlib";
import type { AgentMessage } from "@gajae-code/agent-core";
import type {
	Api,
	AssistantMessage,
	Context,
	Model,
	ProviderDispatch,
	SimpleStreamOptions,
	Usage,
} from "@gajae-code/ai/core";
import { Effort, toolWireSchema } from "@gajae-code/ai/core";
import {
	BTW_PREFIX_BUDGET_MARGIN_TOKENS,
	BTW_PREFIX_MAX_BODY_BYTES,
	BTW_PREFIX_TTL_SAFETY_MARGIN_MS,
	type BtwMainObservation,
	type BtwPrefixCandidate,
	BtwPrefixLedger,
} from "@gajae-code/coding-agent/session/btw-prefix-ledger";
import { z } from "zod";

const URL_OK = "https://api.anthropic.com/v1/messages?beta=true";
const KEY = "sk-ant-secret-key-1";
const MODEL_ID = "claude-opus-4-5";
const MAX_TOKENS = 1000;
const MARGIN = BTW_PREFIX_TTL_SAFETY_MARGIN_MS;

function model(overrides: Partial<Model<Api>> = {}): Model<Api> {
	return {
		id: MODEL_ID,
		name: MODEL_ID,
		api: "anthropic-messages",
		provider: "anthropic",
		baseUrl: "https://api.anthropic.com",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200_000,
		maxTokens: 32_000,
		...overrides,
	} as Model<Api>;
}

function usage(overrides: Partial<Usage> = {}): Usage {
	return {
		input: 10,
		output: 5,
		cacheRead: 100,
		cacheWrite: 0,
		totalTokens: 115,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		...overrides,
	} as Usage;
}

function assistant(overrides: Partial<AssistantMessage> = {}): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text: "final answer" }],
		api: "anthropic-messages",
		provider: "anthropic",
		model: MODEL_ID,
		usage: usage(),
		stopReason: "stop",
		timestamp: 2,
		...overrides,
	} as AssistantMessage;
}

const userMessage = { role: "user", content: "hello", timestamp: 1 } as const;
const wireUser = { role: "user", content: [{ type: "text", text: "hello" }] };
const wireFinal = { role: "assistant", content: [{ type: "text", text: "final answer" }] };
const wireQuestion = { role: "user", content: [{ type: "text", text: "btw?" }] };
const tool = { name: "read", description: "d", input_schema: { type: "object" } };

function bodyOf(messages: unknown[], overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		model: MODEL_ID,
		messages,
		system: [{ type: "text", text: "sys" }],
		tools: [tool],
		tool_choice: { type: "auto" },
		thinking: { type: "enabled", budget_tokens: 2000 },
		metadata: { user_id: "u" },
		max_tokens: MAX_TOKENS,
		cache_control: { type: "ephemeral" },
		stream: true,
		...overrides,
	};
}

interface DispatchInit {
	url?: string;
	key?: string | null;
	headers?: Record<string, string>;
	gzip?: boolean;
	text?: string;
	method?: string;
	api?: Api;
	body?: ProviderDispatch["body"];
}

function dispatchOf(body: unknown, init: DispatchInit = {}): ProviderDispatch {
	const headers = new Headers({ "anthropic-version": "2023-06-01", "anthropic-beta": "b1", ...init.headers });
	if (init.key !== null) headers.set("x-api-key", init.key ?? KEY);
	const text = init.text ?? JSON.stringify(body);
	let payload: ProviderDispatch["body"] = text;
	if (init.gzip) {
		headers.set("content-encoding", "gzip");
		payload = new Uint8Array(gzipSync(Buffer.from(text, "utf8")));
	}
	if ("body" in init) payload = init.body;
	return {
		api: init.api ?? "anthropic-messages",
		url: init.url ?? URL_OK,
		method: init.method ?? "POST",
		headers,
		body: payload,
	};
}

interface Fixture {
	ledger: BtwPrefixLedger;
	clock: { t: number; skew: number };
	history: AgentMessage[];
	m: Model<Api>;
	candidate: BtwPrefixCandidate | undefined;
}

function setup(
	opts: {
		mainBody?: Record<string, unknown>;
		mainDispatch?: DispatchInit;
		final?: AssistantMessage;
		m?: Model<Api>;
		context?: Context;
		bind?: boolean;
	} = {},
): Fixture {
	const clock = { t: 1000, skew: 0 };
	const ledger = new BtwPrefixLedger({ now: () => clock.t, wallNow: () => clock.t + clock.skew });
	const m = opts.m ?? model();
	const final = opts.final ?? assistant();
	const context: Context = opts.context ?? { messages: [userMessage as never], tools: [] };
	const obs = ledger.beginMain(m, context, { maxTokens: MAX_TOKENS, apiKey: KEY } as SimpleStreamOptions);
	obs?.onProviderDispatch(dispatchOf(opts.mainBody ?? bodyOf([wireUser]), opts.mainDispatch));
	obs?.complete(final);
	const history = [...context.messages, final] as AgentMessage[];
	if (opts.bind !== false) ledger.bindHistory(history);
	return { ledger, clock, history, m, candidate: ledger.getCandidate(m, history) };
}

function sideBody(extraMessages: unknown[] = [wireFinal, wireQuestion], overrides: Record<string, unknown> = {}) {
	return bodyOf([wireUser, ...extraMessages], overrides);
}

function reason(f: Fixture, dispatch: ProviderDispatch): string | undefined {
	const c = f.candidate;
	expect(c).toBeDefined();
	expect(() => c!.validateDispatch(dispatch)).toThrow();
	expect(c!.wasDispatchRejected()).toBe(true);
	return c!.rejectionReason();
}

describe("BtwPrefixLedger main lifecycle", () => {
	it("accepts a valid prefix-extending dispatch", () => {
		const f = setup();
		expect(f.candidate).toBeDefined();
		expect(() => f.candidate!.validateDispatch(dispatchOf(sideBody()))).not.toThrow();
		expect(f.candidate!.wasDispatchRejected()).toBe(false);
		expect(f.candidate!.context.messages.at(-1)).toMatchObject({ role: "assistant" });
		expect(f.candidate!.context.messages).toHaveLength(2);
	});

	it("accepts gzip bodies and the same body after a retry dispatch updates the last request", () => {
		const f = setup({ mainDispatch: { gzip: true } });
		expect(() => f.candidate!.validateDispatch(dispatchOf(sideBody(), { gzip: true }))).not.toThrow();
	});

	it("uses the last dispatch of the main run", () => {
		const clock = { t: 0 };
		const ledger = new BtwPrefixLedger({ now: () => clock.t, wallNow: () => clock.t });
		const m = model();
		const obs = ledger.beginMain(m, { messages: [userMessage as never] }, {})!;
		obs.onProviderDispatch(dispatchOf(bodyOf([wireUser]), { key: "other-key" }));
		clock.t = 100;
		obs.onProviderDispatch(dispatchOf(bodyOf([wireUser])));
		obs.complete(assistant());
		const history = [userMessage, assistant()] as AgentMessage[];
		ledger.bindHistory(history);
		const c = ledger.getCandidate(m, history)!;
		clock.t = 100 + 5 * 60_000 - MARGIN - 1;
		expect(() => c.validateDispatch(dispatchOf(sideBody()))).not.toThrow();
		clock.t = 100 + 5 * 60_000 - MARGIN;
		expect(() => c.validateDispatch(dispatchOf(sideBody()))).toThrow();
	});

	it("produces no snapshot when failed, aborted, errored, or with tool calls", () => {
		const ledger = new BtwPrefixLedger();
		const m = model();
		const ctx = { messages: [userMessage as never] };
		const o1 = ledger.beginMain(m, ctx, {})!;
		o1.onProviderDispatch(dispatchOf(bodyOf([wireUser])));
		o1.failed();
		o1.complete(assistant());
		const h = [userMessage, assistant()] as AgentMessage[];
		ledger.bindHistory(h);
		expect(ledger.getCandidate(m, h)).toBeUndefined();

		for (const stopReason of ["aborted", "error", "length", "toolUse"] as const) {
			const f = setup({ final: assistant({ stopReason }) });
			expect(f.candidate).toBeUndefined();
		}
		const withTool = assistant({
			content: [{ type: "toolCall", id: "t1", name: "read", arguments: {} }],
		});
		expect(setup({ final: withTool }).candidate).toBeUndefined();
	});

	it("requires cache read or write usage", () => {
		expect(setup({ final: assistant({ usage: usage({ cacheRead: 0, cacheWrite: 0 }) }) }).candidate).toBeUndefined();
		expect(setup({ final: assistant({ usage: usage({ cacheRead: 0, cacheWrite: 50 }) }) }).candidate).toBeDefined();
	});

	it("a late complete after a new beginMain or clear cannot revive a snapshot", () => {
		const ledger = new BtwPrefixLedger();
		const m = model();
		const ctx = { messages: [userMessage as never] };
		const old = ledger.beginMain(m, ctx, {})!;
		old.onProviderDispatch(dispatchOf(bodyOf([wireUser])));
		ledger.beginMain(m, ctx, {});
		old.complete(assistant());
		const h = [userMessage, assistant()] as AgentMessage[];
		ledger.bindHistory(h);
		expect(ledger.getCandidate(m, h)).toBeUndefined();

		const o2 = ledger.beginMain(m, ctx, {})!;
		o2.onProviderDispatch(dispatchOf(bodyOf([wireUser])));
		ledger.clear();
		o2.complete(assistant());
		ledger.bindHistory(h);
		expect(ledger.getCandidate(m, h)).toBeUndefined();
	});

	it("beginMain discards the previous snapshot", () => {
		const f = setup();
		expect(f.candidate).toBeDefined();
		f.ledger.beginMain(f.m, { messages: [] }, {});
		expect(f.ledger.getCandidate(f.m, f.history)).toBeUndefined();
	});

	it("observer failures never throw into main and leave no snapshot", () => {
		const ledger = new BtwPrefixLedger({
			now: () => {
				throw new Error("clock broke");
			},
		});
		const m = model();
		const obs = ledger.beginMain(m, { messages: [userMessage as never] }, {})!;
		expect(() => obs.onProviderDispatch(dispatchOf(bodyOf([wireUser])))).not.toThrow();
		expect(() => obs.complete(assistant())).not.toThrow();
		expect(() => obs.failed()).not.toThrow();
		expect(() => obs.onProviderDispatch(null as never)).not.toThrow();
		const cyclic: Record<string, unknown> = {};
		cyclic.self = cyclic;
		const o2 = new BtwPrefixLedger().beginMain(m, { messages: [cyclic as never] }, {})!;
		expect(() => o2.complete(assistant())).not.toThrow();
	});

	it("is unsupported for non-Anthropic APIs", () => {
		const ledger = new BtwPrefixLedger();
		for (const api of ["openai-responses", "openai-codex-responses", "openai-completions"]) {
			expect(ledger.beginMain(model({ api }), { messages: [] }, {})).toBeUndefined();
		}
	});
});

describe("BtwPrefixLedger history binding", () => {
	it("requires bindHistory and a matching last assistant", () => {
		expect(setup({ bind: false }).candidate).toBeUndefined();
		const f = setup({ bind: false });
		f.ledger.bindHistory([userMessage, assistant({ content: [{ type: "text", text: "other" }] })] as AgentMessage[]);
		expect(f.ledger.getCandidate(f.m, f.history)).toBeUndefined();
	});

	it("tolerates cost/usage updates but rejects semantic and earlier-history changes", () => {
		const f = setup();
		const costUpdated = [
			userMessage,
			assistant({
				usage: usage({ cost: { input: 9, output: 9, cacheRead: 9, cacheWrite: 9, total: 36 } }),
				duration: 99,
			}),
		] as AgentMessage[];
		expect(f.ledger.getCandidate(f.m, costUpdated)).toBeDefined();

		expect(f.ledger.getCandidate(f.m, [userMessage, assistant({ timestamp: 3 })] as AgentMessage[])).toBeUndefined();
		expect(
			f.ledger.getCandidate(f.m, [{ ...userMessage, content: "edited" }, assistant()] as AgentMessage[]),
		).toBeUndefined();
		expect(f.ledger.getCandidate(f.m, [assistant()] as AgentMessage[])).toBeUndefined();
		expect(f.ledger.getCandidate(f.m, [...f.history, userMessage] as AgentMessage[])).toBeUndefined();
	});

	it("rejects a different model identity", () => {
		const f = setup();
		expect(f.ledger.getCandidate(model({ id: "claude-opus-4-6" }), f.history)).toBeUndefined();
		expect(f.ledger.getCandidate(model({ baseUrl: "https://gw.example" }), f.history)).toBeUndefined();
	});

	it("candidate copies are independent", () => {
		const f = setup();
		f.candidate!.context.messages.push(userMessage as never);
		(f.candidate!.context.messages[0] as { content: string }).content = "mutated";
		const again = f.ledger.getCandidate(f.m, f.history)!;
		expect(again.context.messages).toHaveLength(2);
		expect((again.context.messages[0] as { content: string }).content).toBe("hello");
	});
});

describe("BtwPrefixLedger options and secrets", () => {
	it("copies only allowlisted options", () => {
		const clock = { t: 0 };
		const ledger = new BtwPrefixLedger({ now: () => clock.t, wallNow: () => clock.t });
		const m = model();
		const controller = new AbortController();
		const obs = ledger.beginMain(
			m,
			{ messages: [userMessage as never] },
			{
				apiKey: KEY,
				signal: controller.signal,
				headers: { authorization: "Bearer zzz" },
				onAuthError: async () => undefined,
				providerSessionState: new Map(),
				maxTokens: MAX_TOKENS,
				temperature: 0.5,
				cacheRetention: "long",
				reasoning: Effort.High,
				toolChoice: { type: "tool", name: "read" },
			},
		)!;
		obs.onProviderDispatch(dispatchOf(bodyOf([wireUser])));
		obs.complete(assistant());
		const h = [userMessage, assistant()] as AgentMessage[];
		ledger.bindHistory(h);
		const c = ledger.getCandidate(m, h)!;
		expect(c.options).toEqual({
			maxTokens: MAX_TOKENS,
			temperature: 0.5,
			cacheRetention: "long",
			reasoning: Effort.High,
			toolChoice: { type: "tool", name: "read" },
		});
		const serialized = JSON.stringify(c);
		expect(serialized).not.toContain(KEY);
		expect(serialized).not.toContain("zzz");
	});

	it("keeps no plaintext credential, header, or query in snapshot, candidate, or errors", () => {
		const f = setup({ mainDispatch: { headers: { "x-extra-routing": "route-secret-77" } } });
		const probe = JSON.stringify(f.candidate!.options) + JSON.stringify(f.candidate!.context);
		expect(probe).not.toContain(KEY);
		let message = "";
		try {
			f.candidate!.validateDispatch(
				dispatchOf(sideBody(), { key: "sk-ant-other-key", headers: { "x-extra-routing": "route-secret-77" } }),
			);
		} catch (error) {
			message = String((error as Error).message);
		}
		expect(message).not.toBe("");
		for (const secret of ["sk-ant-other-key", KEY, "route-secret-77", "beta=true", "api.anthropic.com"]) {
			expect(message).not.toContain(secret);
		}
		const state = JSON.stringify(f.ledger, (_k, v) => v);
		expect(state).not.toContain(KEY);
		expect(f.candidate!.rejectionReason()).toBe("route_mismatch");
	});

	it("same key passes; different key, query, beta, or version are rejected", () => {
		expect(() => setup().candidate!.validateDispatch(dispatchOf(sideBody()))).not.toThrow();
		const cases: DispatchInit[] = [
			{ key: "sk-ant-secret-key-2" },
			{ url: "https://api.anthropic.com/v1/messages" },
			{ url: "https://api.anthropic.com/v1/messages?beta=false" },
			{ headers: { "anthropic-beta": "b2" } },
			{ headers: { "anthropic-version": "2024-01-01" } },
			{ headers: { "x-extra-routing": "x" } },
		];
		for (const init of cases) {
			const f = setup();
			expect(reason(f, dispatchOf(sideBody(), init))).toBe("route_mismatch");
		}
	});

	it("ignores volatile transport headers", () => {
		const f = setup({ mainDispatch: { headers: { "x-stainless-retry-count": "0", "x-stainless-timeout": "600" } } });
		expect(() =>
			f.candidate!.validateDispatch(
				dispatchOf(sideBody(), {
					headers: { "x-stainless-retry-count": "2", "x-stainless-timeout": "60" },
					gzip: true,
				}),
			),
		).not.toThrow();
	});

	it("refuses unsupported auth, endpoint, and transport", () => {
		expect(
			setup({ mainDispatch: { key: null, headers: { authorization: "Bearer oauth" } } }).candidate,
		).toBeUndefined();
		expect(setup({ mainDispatch: { headers: { authorization: "Bearer x" } } }).candidate).toBeUndefined();
		for (const url of [
			"https://gateway.example/v1/messages",
			"http://api.anthropic.com/v1/messages",
			"https://api.anthropic.com:8443/v1/messages",
			"https://api.anthropic.com/v1/messages/count_tokens",
			"https://user:pw@api.anthropic.com/v1/messages",
		]) {
			expect(setup({ mainDispatch: { url } }).candidate).toBeUndefined();
		}
		expect(setup({ mainDispatch: { api: "openai-responses" } }).candidate).toBeUndefined();
		expect(setup({ mainDispatch: { method: "GET" } }).candidate).toBeUndefined();
		const f = setup();
		expect(reason(f, dispatchOf(sideBody(), { api: "openai-responses" }))).toBe("unsupported_dispatch");
	});
});

describe("BtwPrefixLedger body handling", () => {
	it("rejects noncanonical JSON, unknown encodings, bad gzip, streams, and missing bodies", () => {
		const canonical = JSON.stringify(bodyOf([wireUser]));
		expect(setup({ mainDispatch: { text: ` ${canonical}` } }).candidate).toBeUndefined();
		expect(
			setup({ mainDispatch: { text: canonical.replace('"stream":true', '"stream": true') } }).candidate,
		).toBeUndefined();
		expect(setup({ mainDispatch: { headers: { "content-encoding": "br" } } }).candidate).toBeUndefined();
		expect(
			setup({ mainDispatch: { headers: { "content-encoding": "gzip" }, body: new Uint8Array([1, 2, 3]) } })
				.candidate,
		).toBeUndefined();
		expect(setup({ mainDispatch: { body: undefined } }).candidate).toBeUndefined();
		const f = setup();
		expect(reason(f, dispatchOf(sideBody(), { text: ` ${JSON.stringify(sideBody())}` }))).toBe("unsupported_body");
	});

	it("rejects a side body that reorders or renormalizes", () => {
		const f = setup();
		const reordered = JSON.stringify(sideBody()).replace('"stream":true', '"stream":true,"x":1');
		expect(reason(f, dispatchOf(null, { text: reordered }))).toBe("root_mismatch");
	});

	it("enforces the decompressed size limit at the boundary", () => {
		const build = (total: number) => {
			const skeleton = JSON.stringify(bodyOf([{ role: "user", content: [{ type: "text", text: "" }] }]));
			const pad = total - Buffer.byteLength(skeleton, "utf8");
			return JSON.stringify(bodyOf([{ role: "user", content: [{ type: "text", text: "a".repeat(pad) }] }]));
		};
		const exact = build(BTW_PREFIX_MAX_BODY_BYTES);
		expect(Buffer.byteLength(exact)).toBe(BTW_PREFIX_MAX_BODY_BYTES);
		const big = { m: model({ contextWindow: 100_000_000 }) };
		expect(setup({ ...big, mainDispatch: { text: exact, gzip: true } }).candidate).toBeDefined();
		const over = build(BTW_PREFIX_MAX_BODY_BYTES + 1);
		expect(setup({ ...big, mainDispatch: { text: over, gzip: true } }).candidate).toBeUndefined();
		expect(setup({ ...big, mainDispatch: { text: over } }).candidate).toBeUndefined();
	});
});

describe("BtwPrefixLedger prefix and suffix rules", () => {
	it("rejects main prefix changes", () => {
		const f = setup();
		const changed = bodyOf([{ role: "user", content: [{ type: "text", text: "HELLO" }] }, wireFinal, wireQuestion]);
		expect(reason(f, dispatchOf(changed))).toBe("prefix_mismatch");
		const f2 = setup();
		expect(reason(f2, dispatchOf(bodyOf([wireFinal, wireQuestion])))).toBe("suffix_shape");
	});

	it("requires final assistant first and a user last", () => {
		const missingFinal = setup();
		expect(reason(missingFinal, dispatchOf(sideBody([wireQuestion, wireQuestion])))).toBe("suffix_shape");
		const alteredFinal = setup();
		const altered = { role: "assistant", content: [{ type: "text", text: "tampered" }] };
		expect(reason(alteredFinal, dispatchOf(sideBody([altered, wireQuestion])))).toBe("suffix_shape");
		const endsAssistant = setup();
		expect(reason(endsAssistant, dispatchOf(sideBody([wireFinal])))).toBe("suffix_shape");
		const toolUse = setup();
		const withToolUse = { role: "assistant", content: [{ type: "tool_use", id: "x", name: "read", input: {} }] };
		expect(reason(toolUse, dispatchOf(sideBody([wireFinal, withToolUse, wireQuestion])))).toBe("suffix_shape");
	});

	it("rejects changes to any non-messages root field and root key order", () => {
		const changes: Record<string, unknown>[] = [
			{ tool_choice: { type: "any" } },
			{ thinking: { type: "disabled" } },
			{ metadata: { user_id: "other" } },
			{ max_tokens: 999 },
			{ cache_control: { type: "ephemeral", ttl: "1h" } },
			{ system: [{ type: "text", text: "sys2" }] },
			{ tools: [{ ...tool, description: "changed" }] },
			{ output_config: { effort: "high" } },
			{ model: "claude-opus-4-6" },
		];
		for (const overrides of changes) {
			const f = setup();
			expect(reason(f, dispatchOf(sideBody(undefined, overrides)))).toBe("root_mismatch");
		}
		const f = setup();
		const { thinking, ...rest } = sideBody() as Record<string, unknown>;
		expect(reason(f, dispatchOf({ ...rest, thinking }))).toBe("root_mismatch");
	});

	it("does not strip or normalize cache markers or billing text before comparing", () => {
		const f = setup();
		const marked = { role: "user", content: [{ type: "text", text: "hello", cache_control: { type: "ephemeral" } }] };
		expect(reason(f, dispatchOf(bodyOf([marked, wireFinal, wireQuestion])))).toBe("prefix_mismatch");
		const billing = setup({
			mainBody: bodyOf([wireUser], { system: [{ type: "text", text: "x-anthropic-billing-header: cch=aaaaa;" }] }),
		});
		const side = sideBody(undefined, { system: [{ type: "text", text: "x-anthropic-billing-header: cch=bbbbb;" }] });
		expect(reason(billing, dispatchOf(side))).toBe("root_mismatch");
	});

	it("allows 19 appended blocks and rejects 20", () => {
		const blocks = (n: number) => Array.from({ length: n }, (_, i) => ({ type: "text", text: `q${i}` }));
		const finalMsg = wireFinal; // 1 block
		const ok = setup();
		const q18 = { role: "user", content: blocks(18) };
		expect(() => ok.candidate!.validateDispatch(dispatchOf(sideBody([finalMsg, q18])))).not.toThrow();
		const over = setup();
		const q19 = { role: "user", content: blocks(19) };
		expect(reason(over, dispatchOf(sideBody([finalMsg, q19])))).toBe("lookback_exceeded");
	});

	it("enforces the TTL at the request-start boundary for 5m and 1h", () => {
		const f = setup();
		f.clock.t = 1000 + 5 * 60_000 - MARGIN - 1;
		expect(() => f.candidate!.validateDispatch(dispatchOf(sideBody()))).not.toThrow();
		f.clock.t = 1000 + 5 * 60_000 - MARGIN;
		expect(() => f.candidate!.validateDispatch(dispatchOf(sideBody()))).toThrow();
		expect(f.candidate!.rejectionReason()).toBe("ttl_expired");
		expect(f.ledger.getCandidate(f.m, f.history)).toBeUndefined();

		const hour = { cache_control: { type: "ephemeral", ttl: "1h" } };
		const h = setup({ mainBody: bodyOf([wireUser], hour) });
		h.clock.t = 1000 + 60 * 60_000 - MARGIN - 1;
		expect(() => h.candidate!.validateDispatch(dispatchOf(sideBody(undefined, hour)))).not.toThrow();
		h.clock.t = 1000 + 60 * 60_000 - MARGIN;
		expect(() => h.candidate!.validateDispatch(dispatchOf(sideBody(undefined, hour)))).toThrow();
	});

	it("rejects missing or non-ephemeral automatic cache_control", () => {
		const { cache_control: _omit, ...noCache } = bodyOf([wireUser]);
		expect(setup({ mainBody: noCache }).candidate).toBeUndefined();
		expect(
			setup({ mainBody: bodyOf([wireUser], { cache_control: { type: "ephemeral", ttl: "2h" } }) }).candidate,
		).toBeUndefined();
	});
});

describe("BtwPrefixLedger budget", () => {
	it("allows the exact context-window boundary and rejects one token more", () => {
		const mainInput = 10 + 100;
		const q = { role: "user", content: [{ type: "text", text: "btw?" }] };
		const appended = [wireFinal, q].reduce((n, msg) => n + Buffer.byteLength(JSON.stringify(msg)), 0);
		const exact = mainInput + appended + MAX_TOKENS + BTW_PREFIX_BUDGET_MARGIN_TOKENS;
		const ok = setup({ m: model({ contextWindow: exact }) });
		expect(() => ok.candidate!.validateDispatch(dispatchOf(sideBody()))).not.toThrow();
		const over = setup({ m: model({ contextWindow: exact - 1 }) });
		expect(reason(over, dispatchOf(sideBody()))).toBe("budget_exceeded");
	});

	it("does not double count uncached and cache usage and refuses a main already too large", () => {
		const f = setup({ m: model({ contextWindow: 1000 + BTW_PREFIX_BUDGET_MARGIN_TOKENS + 109 }) });
		expect(f.candidate).toBeUndefined();
		const g = setup({ m: model({ contextWindow: 1000 + BTW_PREFIX_BUDGET_MARGIN_TOKENS + 110 }) });
		expect(g.candidate).toBeDefined();
	});
});

describe("BtwPrefixLedger server tools and thinking", () => {
	it("refuses hosted/server tools, MCP, and containers on the main request", () => {
		const bad: Record<string, unknown>[] = [
			{ tools: [{ type: "web_search_20250305", name: "web_search" }] },
			{ tools: [{ type: "code_execution_20250522", name: "code_execution" }] },
			{ tools: [{ type: "mcp_toolset", mcp_server_name: "s" }] },
			{ tools: [{ type: "bash_20250124", name: "bash" }] },
			{ tools: [{ name: "no_schema" }] },
			{ mcp_servers: [{ type: "url", url: "https://x", name: "s" }] },
			{ container: "container_1" },
		];
		for (const overrides of bad) {
			expect(setup({ mainBody: bodyOf([wireUser], overrides) }).candidate).toBeUndefined();
		}
		const serverBlock = {
			role: "assistant",
			content: [{ type: "server_tool_use", id: "s", name: "web_search", input: {} }],
		};
		expect(setup({ mainBody: bodyOf([serverBlock, wireUser]) }).candidate).toBeUndefined();
		const result = { role: "user", content: [{ type: "web_search_tool_result", tool_use_id: "s", content: [] }] };
		expect(setup({ mainBody: bodyOf([result, wireUser]) }).candidate).toBeUndefined();
	});

	it("allows an explicit custom tool and refuses a server tool added on the side request", () => {
		const custom = { type: "custom", name: "c", description: "d", input_schema: { type: "object" } };
		const f = setup({ mainBody: bodyOf([wireUser], { tools: [custom] }) });
		expect(() => f.candidate!.validateDispatch(dispatchOf(sideBody(undefined, { tools: [custom] })))).not.toThrow();
		const g = setup();
		const withServer = sideBody(undefined, { tools: [tool, { type: "web_search_20250305", name: "web_search" }] });
		expect(reason(g, dispatchOf(withServer))).toBe("server_tool");
		const h = setup();
		expect(reason(h, dispatchOf(sideBody(undefined, { mcp_servers: [] })))).toBe("server_tool");
	});

	it("refuses prefix thinking on models that may drop it or are unknown", () => {
		const thinking = { type: "thinking", thinking: "t", thinkingSignature: "s" };
		const withThinking = assistant({ content: [thinking as never, { type: "text", text: "final answer" }] });
		const wireThinkingAssistant = {
			role: "assistant",
			content: [
				{ type: "thinking", thinking: "t", signature: "s" },
				{ type: "text", text: "final answer" },
			],
		};
		const mainBody = bodyOf([wireUser, wireThinkingAssistant, wireUser]);
		const ctx: Context = {
			messages: [userMessage as never, { ...withThinking, timestamp: 1.5 } as never, userMessage as never],
		};
		for (const id of [
			"claude-opus-4-1",
			"claude-sonnet-4-5",
			"claude-haiku-4-5",
			"claude-3-7-sonnet",
			"mystery-model",
		]) {
			expect(
				setup({ mainBody, context: ctx, m: model({ id }), final: assistant({ model: id }) }).candidate,
			).toBeUndefined();
		}
		for (const id of ["claude-opus-4-5", "claude-opus-4-6", "claude-sonnet-4-6", "claude-haiku-5-5"]) {
			expect(
				setup({ mainBody, context: ctx, m: model({ id }), final: assistant({ model: id }) }).candidate,
			).toBeDefined();
		}
	});
});

describe("BtwPrefixLedger tool pair completeness", () => {
	it("accepts completed pairs and rejects orphaned or synthesized results", () => {
		const call = assistant({
			content: [{ type: "toolCall", id: "t1", name: "read", arguments: {} }],
			stopReason: "toolUse",
			timestamp: 1.2,
		});
		const result = {
			role: "toolResult",
			toolCallId: "t1",
			toolName: "read",
			content: [{ type: "text", text: "ok" }],
			isError: false,
			timestamp: 1.4,
		};
		const wireTool = { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "read", input: {} }] };
		const wireResult = { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "ok" }] };
		const mainBody = bodyOf([wireUser, wireTool, wireResult]);
		const good: Context = { messages: [userMessage as never, call as never, result as never] };
		expect(setup({ mainBody, context: good }).candidate).toBeDefined();

		const synthetic = { ...result, isError: true, content: [{ type: "text", text: "No result provided" }] };
		expect(
			setup({ mainBody, context: { messages: [userMessage as never, call as never, synthetic as never] } })
				.candidate,
		).toBeUndefined();
		expect(
			setup({ mainBody, context: { messages: [userMessage as never, call as never] } }).candidate,
		).toBeUndefined();
		expect(
			setup({ mainBody, context: { messages: [userMessage as never, result as never] } }).candidate,
		).toBeUndefined();
	});
});

describe("BtwPrefixLedger toolChoice absence and presence", () => {
	function optionsFor(toolChoice: unknown): SimpleStreamOptions {
		const ledger = new BtwPrefixLedger();
		const m = model();
		const opts = (toolChoice === undefined ? {} : { toolChoice }) as SimpleStreamOptions;
		const obs = ledger.beginMain(m, { messages: [userMessage as never] }, opts)!;
		obs.onProviderDispatch(dispatchOf(bodyOf([wireUser])));
		obs.complete(assistant());
		const h = [userMessage, assistant()] as AgentMessage[];
		ledger.bindHistory(h);
		return ledger.getCandidate(m, h)!.options;
	}

	it("preserves none/auto/forced tool choices and absence", () => {
		expect(optionsFor("none").toolChoice).toBe("none");
		expect(optionsFor("auto").toolChoice).toBe("auto");
		expect(optionsFor({ type: "tool", name: "read" }).toolChoice).toEqual({ type: "tool", name: "read" });
		expect("toolChoice" in optionsFor(undefined)).toBe(false);
	});
});

describe("BtwPrefixLedger full final answer guard", () => {
	const signedThinking = { type: "thinking", thinking: "deep", thinkingSignature: "sig-1" } as const;
	const redacted = { type: "redactedThinking", data: "opaque" } as const;
	const finalWithThinking = () =>
		assistant({ content: [signedThinking as never, { type: "text", text: "final answer" }, redacted as never] });
	const wireThinking = { type: "thinking", thinking: "deep", signature: "sig-1" };
	const wireRedacted = { type: "redacted_thinking", data: "opaque" };
	const wireText = { type: "text", text: "final answer" };

	function thinkingSetup() {
		return setup({ final: finalWithThinking() });
	}

	it("accepts the exact native wire form of F including signatures", () => {
		const f = thinkingSetup();
		const wireF = { role: "assistant", content: [wireThinking, wireText, wireRedacted] };
		expect(() => f.candidate!.validateDispatch(dispatchOf(sideBody([wireF, wireQuestion])))).not.toThrow();
	});

	it("rejects deleted, reordered, or altered thinking/redacted/signature/text blocks in F", () => {
		const variants: unknown[][] = [
			[wireText],
			[wireText, wireRedacted],
			[wireThinking, wireText],
			[wireRedacted, wireText],
			[wireText, wireThinking, wireRedacted],
			[wireRedacted, wireText, wireThinking],
			[{ ...wireThinking, signature: "sig-2" }, wireText, wireRedacted],
			[{ ...wireThinking, thinking: "other" }, wireText, wireRedacted],
			[wireThinking, wireText, { ...wireRedacted, data: "x" }],
			[wireThinking, { type: "text", text: "final answer!" }, wireRedacted],
			[wireThinking, wireText, wireRedacted, wireText],
		];
		for (const content of variants) {
			const f = thinkingSetup();
			const reasonCode = reason(f, dispatchOf(sideBody([{ role: "assistant", content }, wireQuestion])));
			expect(reasonCode).toBe("suffix_shape");
		}
	});

	it("refuses C when the serializer would collapse or drop blocks of the original F", () => {
		// Adjacent thinking + redacted: native serializer keeps only the first of the run.
		const adjacent = assistant({
			content: [signedThinking as never, redacted as never, { type: "text", text: "final answer" }],
		});
		expect(setup({ final: adjacent }).candidate).toBeUndefined();
		const unsigned = assistant({
			content: [{ type: "thinking", thinking: "x" } as never, { type: "text", text: "final answer" }],
		});
		expect(setup({ final: unsigned }).candidate).toBeUndefined();
	});

	it("rejects an unknown variant of F that the serializer drops", () => {
		const emptyFinal = setup({ final: assistant({ content: [{ type: "text", text: "  " }] }) });
		expect(emptyFinal.candidate).toBeUndefined();
	});
});

describe("BtwPrefixLedger clocks", () => {
	it("expires when wall time passes TTL while the monotonic clock is frozen (suspend)", () => {
		const f = setup();
		f.clock.skew = 5 * 60_000 - MARGIN - 1;
		expect(() => f.candidate!.validateDispatch(dispatchOf(sideBody()))).not.toThrow();
		f.clock.skew = 5 * 60_000 - MARGIN;
		expect(() => f.candidate!.validateDispatch(dispatchOf(sideBody()))).toThrow();
		expect(f.candidate!.rejectionReason()).toBe("ttl_expired");
		expect(f.ledger.getCandidate(f.m, f.history)).toBeUndefined();
	});

	it("fails closed on wall rollback and invalid clock values", () => {
		const f = setup();
		f.clock.skew = -1;
		expect(reason(f, dispatchOf(sideBody()))).toBe("ttl_expired");
		for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, -5]) {
			const g = setup();
			g.clock.t = bad;
			expect(g.ledger.getCandidate(g.m, g.history)).toBeUndefined();
		}
	});

	it("samples clocks at main dispatch, not at completion", () => {
		const clock = { t: 0 };
		const ledger = new BtwPrefixLedger({ now: () => clock.t, wallNow: () => clock.t });
		const m = model();
		const obs = ledger.beginMain(m, { messages: [userMessage as never] }, {})!;
		obs.onProviderDispatch(dispatchOf(bodyOf([wireUser])));
		clock.t = 4 * 60_000;
		obs.complete(assistant());
		const h = [userMessage, assistant()] as AgentMessage[];
		ledger.bindHistory(h);
		const c = ledger.getCandidate(m, h)!;
		clock.t = 5 * 60_000 - MARGIN - 1;
		expect(() => c.validateDispatch(dispatchOf(sideBody()))).not.toThrow();
		clock.t = 5 * 60_000 - MARGIN;
		expect(() => c.validateDispatch(dispatchOf(sideBody()))).toThrow();
	});
});

describe("BtwPrefixLedger duplicate tool ids", () => {
	it("rejects duplicate tool-call ids within and across turns", () => {
		const call = (id: string[], ts: number) =>
			assistant({
				content: id.map(i => ({ type: "toolCall", id: i, name: "read", arguments: {} }) as never),
				stopReason: "toolUse",
				timestamp: ts,
			});
		const res = (id: string, ts: number) => ({
			role: "toolResult",
			toolCallId: id,
			toolName: "read",
			content: [{ type: "text", text: "ok" }],
			isError: false,
			timestamp: ts,
		});
		const wireTool = { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "read", input: {} }] };
		const wireResult = { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "ok" }] };
		const mainBody = bodyOf([wireUser, wireTool, wireResult]);
		const dupWithin = { messages: [userMessage as never, call(["t1", "t1"], 1.1) as never, res("t1", 1.2) as never] };
		expect(setup({ mainBody, context: dupWithin }).candidate).toBeUndefined();
		const dupAcross = {
			messages: [
				userMessage as never,
				call(["t1"], 1.1) as never,
				res("t1", 1.2) as never,
				call(["t1"], 1.3) as never,
				res("t1", 1.4) as never,
			],
		};
		expect(setup({ mainBody, context: dupAcross }).candidate).toBeUndefined();
	});
});

describe("BtwPrefixLedger P3 guards", () => {
	it("final answer output tokens can dominate the budget; invalid usage/window fail closed", () => {
		const mainInput = 10 + 100;
		const q = { role: "user", content: [{ type: "text", text: "btw?" }] };
		const qBytes = Buffer.byteLength(JSON.stringify(q));
		const big = 5000;
		const final = assistant({ usage: usage({ output: big }) });
		const exact = mainInput + big + qBytes + MAX_TOKENS + BTW_PREFIX_BUDGET_MARGIN_TOKENS;
		const ok = setup({ final, m: model({ contextWindow: exact }) });
		expect(() => ok.candidate!.validateDispatch(dispatchOf(sideBody()))).not.toThrow();
		const over = setup({ final, m: model({ contextWindow: exact - 1 }) });
		expect(reason(over, dispatchOf(sideBody()))).toBe("budget_exceeded");

		for (const bad of [Number.NaN, -1, Number.POSITIVE_INFINITY]) {
			expect(setup({ final: assistant({ usage: usage({ output: bad }) }) }).candidate).toBeUndefined();
			expect(setup({ final: assistant({ usage: usage({ input: bad }) }) }).candidate).toBeUndefined();
			expect(setup({ m: model({ contextWindow: bad }) }).candidate).toBeUndefined();
		}
	});

	it("refuses a caller-owned fetch or client on the main options", () => {
		const m = model();
		const ctx = { messages: [userMessage as never] };
		expect(new BtwPrefixLedger().beginMain(m, ctx, { fetch: (async () => new Response()) as never })).toBeUndefined();
		expect(new BtwPrefixLedger().beginMain(m, ctx, { client: {} } as never)).toBeUndefined();
		expect(new BtwPrefixLedger().beginMain(m, ctx, {})).toBeDefined();
	});
});

describe("BtwPrefixLedger native-like tools", () => {
	it("captures Zod tools with executor functions as independent JSON schemas without running them", () => {
		let executed = 0;
		const zodTool = {
			name: "read",
			description: "d",
			parameters: z.object({ path: z.string() }),
			strict: true,
			execute: () => {
				executed += 1;
			},
			rawArgumentValidation: () => undefined,
			safeSummary: () => "s",
		};
		const context = { messages: [userMessage as never], systemPrompt: ["sys"], tools: [zodTool as never] } as Context;
		const ledger = new BtwPrefixLedger();
		const m = model();
		const obs = ledger.beginMain(m, context, {})!;
		const wireTool = { name: "read", description: "d", input_schema: { type: "object" } };
		obs.onProviderDispatch(dispatchOf(bodyOf([wireUser], { tools: [wireTool] })));
		obs.complete(assistant());
		const h = [userMessage, assistant()] as AgentMessage[];
		ledger.bindHistory(h);
		const c = ledger.getCandidate(m, h);
		expect(c).toBeDefined();

		const copied = c!.context.tools![0] as unknown as Record<string, unknown>;
		expect(Object.keys(copied).sort()).toEqual(["description", "name", "parameters", "strict"]);
		expect(typeof copied.execute).toBe("undefined");
		const expected = toolWireSchema(zodTool as never);
		expect(copied.parameters).toEqual(expected);
		expect(copied.parameters).not.toBe(expected);
		expect(c!.context.systemPrompt).toEqual(["sys"]);

		// Mutating the original afterwards cannot alter the snapshot.
		(zodTool as { description: string }).description = "changed";
		expect((ledger.getCandidate(m, h)!.context.tools![0] as { description: string }).description).toBe("d");
		expect(executed).toBe(0);
	});
});

describe("BtwPrefixLedger ineligible-path cost", () => {
	function probeTool() {
		const reads = { count: 0 };
		const tool = {
			name: "read",
			description: "d",
			get parameters() {
				reads.count += 1;
				return z.object({ path: z.string() });
			},
		};
		return { tool, reads };
	}

	it("does not convert tool schemas for OAuth, gateway, or caller transport", () => {
		const cases: Array<[Model<Api>, SimpleStreamOptions]> = [
			[model(), { authCredentialType: "oauth" } as SimpleStreamOptions],
			[model(), { isOAuth: true } as unknown as SimpleStreamOptions],
			[model({ baseUrl: "https://gateway.example" }), {}],
			[model({ baseUrl: "http://api.anthropic.com" }), {}],
			[model({ baseUrl: "not a url" }), {}],
			[model(), { fetch: (async () => new Response()) as never }],
			[model({ api: "openai-responses" }), {}],
		];
		for (const [m, options] of cases) {
			const { tool, reads } = probeTool();
			const obs = new BtwPrefixLedger().beginMain(m, { messages: [], tools: [tool as never] }, options);
			expect(obs).toBeUndefined();
			expect(reads.count).toBe(0);
		}
		const { tool, reads } = probeTool();
		expect(new BtwPrefixLedger().beginMain(model(), { messages: [], tools: [tool as never] }, {})).toBeDefined();
		expect(reads.count).toBeGreaterThan(0);
	});

	it("parses the body only for a completion that can become a snapshot", () => {
		const marker = "BODY_PARSE_PROBE_9f3a";
		const probed: string[] = [];
		const original = JSON.parse;
		const spy = spyOn(JSON, "parse").mockImplementation(((text: string, reviver?: never) => {
			if (typeof text === "string" && text.includes(marker)) probed.push(marker);
			return original(text, reviver);
		}) as typeof JSON.parse);
		try {
			const body = bodyOf([{ role: "user", content: [{ type: "text", text: marker }] }]);
			const run = (finish: (obs: BtwMainObservation) => void) => {
				const obs = new BtwPrefixLedger().beginMain(model(), { messages: [userMessage as never] }, {})!;
				obs.onProviderDispatch(dispatchOf(body));
				finish(obs);
			};
			run(obs => obs.failed());
			run(obs => obs.complete(assistant({ stopReason: "toolUse" })));
			run(obs => obs.complete(assistant({ content: [{ type: "toolCall", id: "t", name: "r", arguments: {} }] })));
			run(obs => obs.complete(assistant({ usage: usage({ cacheRead: 0, cacheWrite: 0 }) })));
			expect(probed).toHaveLength(0);
			run(obs => obs.complete(assistant()));
			expect(probed).toHaveLength(1);
		} finally {
			spy.mockRestore();
		}
	});

	it("still rejects bad route/auth at dispatch time and never defers that check", () => {
		const ledger = new BtwPrefixLedger();
		const obs = ledger.beginMain(model(), { messages: [userMessage as never] }, {})!;
		obs.onProviderDispatch(dispatchOf(bodyOf([wireUser]), { url: "https://gateway.example/v1/messages" }));
		obs.complete(assistant());
		const h = [userMessage, assistant()] as AgentMessage[];
		ledger.bindHistory(h);
		expect(ledger.getCandidate(model(), h)).toBeUndefined();
	});

	it("a superseded observation cannot complete after beginMain or clear", () => {
		const ledger = new BtwPrefixLedger();
		const first = ledger.beginMain(model(), { messages: [userMessage as never] }, {})!;
		first.onProviderDispatch(dispatchOf(bodyOf([wireUser])));
		ledger.clear();
		first.complete(assistant());
		const h = [userMessage, assistant()] as AgentMessage[];
		ledger.bindHistory(h);
		expect(ledger.getCandidate(model(), h)).toBeUndefined();
	});
});
