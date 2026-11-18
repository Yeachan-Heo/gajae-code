import { afterEach, describe, expect, it, vi } from "bun:test";
import * as os from "node:os";
import * as path from "node:path";
import * as ai from "@gajae-code/ai";
import { type Api, getBundledModel, type Model } from "@gajae-code/ai";
import { isValidSessionRecapText, SESSION_RECAP_MAX_BYTES } from "../src/sdk/session-recap";
import {
	generateSessionRecap,
	RECAP_MAX_INPUT_BYTES,
	RECAP_MAX_OUTPUT_CODEPOINTS,
	RECAP_TIMEOUT_MS,
	type SessionRecapGenerationInput,
	selectRecapModel,
} from "../src/utils/recap-generator";

const EMPTY_DIR = path.join(os.tmpdir(), "recap-generator-empty");
const TOKEN_NAME = "RECAP_OBFUSCATION_TOKEN";
const TOKEN = "gjc-recap-secret-alpha-9931";

function model(id = "claude-sonnet-4-5"): Model<Api> {
	const found = getBundledModel("anthropic", id);
	if (!found) throw new Error("missing recap model");
	return found;
}

function settings(secrets: boolean, role?: Model<Api>) {
	return {
		get(key: string) {
			return key === "secrets.enabled" ? secrets : undefined;
		},
		getModelRole(r: string) {
			return r === "default" && role ? `${role.provider}/${role.id}` : undefined;
		},
		getStorage() {
			return undefined;
		},
		getCwd() {
			return EMPTY_DIR;
		},
		getAgentDir() {
			return path.join(EMPTY_DIR, "agent");
		},
	} as never;
}

function registry(available: Model<Api>[], getApiKey: (m: Model<Api>, s?: string) => Promise<string | undefined>) {
	return { getAvailable: () => available, getApiKey } as never;
}

function input(overrides: Partial<SessionRecapGenerationInput> = {}): SessionRecapGenerationInput {
	const selected = model();
	return {
		userText: "fix the login bug",
		assistantText: "fixed it",
		model: selected,
		registry: registry([selected], async () => "test-key"),
		settings: settings(false, selected),
		sessionId: "session-1",
		signal: new AbortController().signal,
		activeCwd: EMPTY_DIR,
		...overrides,
	};
}

function reply(text: string, overrides: Record<string, unknown> = {}) {
	const selected = model();
	return {
		stopReason: "stop",
		provider: selected.provider,
		model: selected.id,
		content: [{ type: "text", text }],
		...overrides,
	} as never;
}

function sentUser(call: unknown): string {
	const context = (call as { mock: { calls: unknown[][] } }).mock.calls[0]?.[1] as
		| { messages?: Array<{ content?: string }> }
		| undefined;
	const content = context?.messages?.[0]?.content;
	if (typeof content !== "string") throw new Error("no user text sent");
	return content;
}

afterEach(() => {
	vi.restoreAllMocks();
	delete process.env[TOKEN_NAME];
});

describe("selectRecapModel", () => {
	it("prefers the default role and falls back to the current model", () => {
		const role = model("claude-haiku-4-5");
		const current = model();
		const reg = registry([role, current], async () => "k");
		expect(selectRecapModel(reg, settings(false, role), current, "s")).toBe(role);
		expect(selectRecapModel(reg, settings(false), current, "s")).toBe(current);
		expect(
			selectRecapModel(
				registry([], async () => "k"),
				settings(false, role),
				current,
				"s",
			),
		).toBeUndefined();
	});
});

describe("generateSessionRecap request", () => {
	it("sends one tool-less, non-retried request with the pinned model and credential", async () => {
		const completeSimple = vi.spyOn(ai, "completeSimple").mockResolvedValue(reply("  로그인 버그를 고쳤습니다  "));
		const keySessions: Array<string | undefined> = [];
		const selected = model();
		const result = await generateSessionRecap(
			input({
				registry: registry([selected], async (_m, s) => {
					keySessions.push(s);
					return "key-xyz";
				}),
				metadataResolver: provider => ({ user_id: provider }),
			}),
		);
		expect(result).toEqual({ text: "로그인 버그를 고쳤습니다", model: `${selected.provider}/${selected.id}` });
		expect(completeSimple).toHaveBeenCalledTimes(1);
		const [calledModel, context, options] = completeSimple.mock.calls[0] ?? [];
		expect(calledModel).toBe(selected);
		expect((context as { tools?: unknown[] }).tools).toEqual([]);
		expect(options).toMatchObject({
			apiKey: "key-xyz",
			toolChoice: "none",
			requestMaxRetries: 0,
			streamMaxRetries: 0,
			disableReasoning: true,
			metadata: { user_id: selected.provider },
		});
		expect(keySessions).toEqual(["session-1"]);
		const user = sentUser(completeSimple);
		expect(user).toContain("fix the login bug");
		expect(user).toContain("fixed it");
	});

	it("reserves a 1024-token output budget for reasoning models", async () => {
		const reasoning = { ...model(), reasoning: true } as Model<Api>;
		const completeSimple = vi.spyOn(ai, "completeSimple").mockResolvedValue(reply("ok"));
		await generateSessionRecap(input({ model: reasoning }));
		const options = completeSimple.mock.calls[0]?.[2] as { maxTokens?: number } | undefined;
		expect(options?.maxTokens).toBeGreaterThanOrEqual(1024);
	});

	it("returns null without calling the model when no API key exists", async () => {
		const completeSimple = vi.spyOn(ai, "completeSimple").mockResolvedValue(reply("ok"));
		const result = await generateSessionRecap(input({ registry: registry([model()], async () => undefined) }));
		expect(result).toBeNull();
		expect(completeSimple).not.toHaveBeenCalled();
	});
});

describe("generateSessionRecap outbound budget", () => {
	it("obfuscates the full text before truncating and stays within 8192 UTF-8 bytes", async () => {
		process.env[TOKEN_NAME] = TOKEN;
		const completeSimple = vi.spyOn(ai, "completeSimple").mockResolvedValue(reply("ok"));
		// The user secret straddles the per-side cut; truncating first would leak a prefix.
		const userText = `${"가".repeat(1300)}${"a".repeat(180)}${TOKEN}${"b".repeat(5000)}`;
		const assistantText = `${"c".repeat(5000)}${TOKEN}`;
		await generateSessionRecap(input({ userText, assistantText, settings: settings(true) }));
		const user = sentUser(completeSimple);
		expect(Buffer.byteLength(user, "utf8")).toBeLessThanOrEqual(RECAP_MAX_INPUT_BYTES);
		expect(user).not.toContain(TOKEN.slice(0, 8));
		expect(user).toContain("<user-message>");
		expect(user).toContain("<assistant-message>");
		expect(user).toContain("가");
		expect(user).not.toContain("\uFFFD");
	});

	it("obfuscates before truncating when a secret straddles the user head cut and the assistant tail cut", async () => {
		process.env[TOKEN_NAME] = TOKEN;
		// Each side exceeds half of the 8192-byte budget, so the user keeps its first
		// (8192 - frame) / 2 bytes and the assistant its last (8192 - frame) / 2 bytes.
		const frameBytes = Buffer.byteLength(
			"<session-turn>\n<user-message>\n\n</user-message>\n<assistant-message>\n\n</assistant-message>\n</session-turn>",
			"utf8",
		);
		const half = Math.floor((RECAP_MAX_INPUT_BYTES - frameBytes) / 2);
		const inside = 10;
		const userText = `${"a".repeat(half - inside)}${TOKEN}${"b".repeat(half)}`;
		const assistantText = `${"c".repeat(half)}${TOKEN}${"d".repeat(half - TOKEN.length + inside)}`;
		const head = TOKEN.slice(0, 8);
		const tail = TOKEN.slice(-8);

		// Premise: without obfuscation these fixtures really do cut through the secret on both sides.
		const plain = vi.spyOn(ai, "completeSimple").mockResolvedValue(reply("ok"));
		await generateSessionRecap(input({ userText, assistantText, settings: settings(false) }));
		const unprotected = sentUser(plain);
		const unprotectedUser = unprotected.slice(
			unprotected.indexOf("<user-message>"),
			unprotected.indexOf("</user-message>"),
		);
		const unprotectedAssistant = unprotected.slice(unprotected.indexOf("<assistant-message>"));
		expect(unprotectedUser).toContain(head);
		expect(unprotectedUser).not.toContain(TOKEN);
		expect(unprotectedAssistant).toContain(tail);
		expect(unprotectedAssistant).not.toContain(TOKEN);

		plain.mockClear();
		await generateSessionRecap(input({ userText, assistantText, settings: settings(true) }));
		const user = sentUser(plain);
		expect(Buffer.byteLength(user, "utf8")).toBeLessThanOrEqual(RECAP_MAX_INPUT_BYTES);
		for (const fragment of [TOKEN, head, tail, TOKEN.slice(8, 16)]) expect(user).not.toContain(fragment);
		expect(user).toContain("<user-message>");
		expect(user).toContain("<assistant-message>");
	});

	it("keeps both inputs and hands unused budget to the longer side", async () => {
		const completeSimple = vi.spyOn(ai, "completeSimple").mockResolvedValue(reply("ok"));
		await generateSessionRecap(input({ userText: "SHORT_USER", assistantText: "z".repeat(20000) }));
		const user = sentUser(completeSimple);
		expect(Buffer.byteLength(user, "utf8")).toBe(RECAP_MAX_INPUT_BYTES);
		expect(user).toContain("SHORT_USER");

		completeSimple.mockClear();
		await generateSessionRecap(input({ userText: "u".repeat(20000), assistantText: "a".repeat(20000) }));
		const both = sentUser(completeSimple);
		expect(Buffer.byteLength(both, "utf8")).toBeLessThanOrEqual(RECAP_MAX_INPUT_BYTES);
		expect(both).toContain("uuuu");
		expect(both).toContain("aaaa");
	});

	it("obfuscates a secret the model echoes back", async () => {
		process.env[TOKEN_NAME] = TOKEN;
		vi.spyOn(ai, "completeSimple").mockResolvedValue(reply(`rotate ${TOKEN}`));
		const result = await generateSessionRecap(input({ settings: settings(true) }));
		expect(result?.text).not.toContain(TOKEN);
	});
});

describe("generateSessionRecap output acceptance", () => {
	it("accepts exactly 120 codepoints and rejects 121 without truncating", async () => {
		const spy = vi.spyOn(ai, "completeSimple").mockResolvedValue(reply("😀".repeat(120)));
		expect((await generateSessionRecap(input()))?.text).toBe("😀".repeat(120));
		spy.mockResolvedValue(reply("😀".repeat(121)));
		expect(await generateSessionRecap(input())).toBeNull();
	});

	it("rejects empty, control-character, and multi-line output", async () => {
		const spy = vi.spyOn(ai, "completeSimple");
		for (const text of ["", "   ", "line one\nline two", "bad\u001b[31mred", "tab\there", "nul\u0000x"]) {
			spy.mockResolvedValue(reply(text));
			expect(await generateSessionRecap(input())).toBeNull();
		}
	});

	it("rejects exactly what the session store rejects, never trimming interior characters to fit", async () => {
		const spy = vi.spyOn(ai, "completeSimple");
		const refused = [
			"line\u2028separator",
			"paragraph\u2029separator",
			"bidi \u202Eoverride",
			"isolate \u2066text",
			"zero\u200Bwidth",
			"word\uFEFFjoiner",
			"lone \uD800 surrogate",
			"next\u0085line",
		];
		for (const text of refused) {
			expect(isValidSessionRecapText(text)).toBe(false);
			spy.mockResolvedValue(reply(text));
			expect(await generateSessionRecap(input())).toBeNull();
		}
		// Joiners that real scripts need stay accepted, and so does every length the store accepts.
		for (const text of ["family \u{1F468}\u200D\u{1F469}", "한국어 요약", "𐐀".repeat(RECAP_MAX_OUTPUT_CODEPOINTS)]) {
			expect(isValidSessionRecapText(text)).toBe(true);
			spy.mockResolvedValue(reply(text));
			expect((await generateSessionRecap(input()))?.text).toBe(text);
		}
		spy.mockResolvedValue(reply("a".repeat(SESSION_RECAP_MAX_BYTES + 1)));
		expect(await generateSessionRecap(input())).toBeNull();
	});

	it("rejects error, aborted, length, refusal, and toolUse stop reasons", async () => {
		const spy = vi.spyOn(ai, "completeSimple");
		for (const stopReason of ["error", "aborted", "length", "refusal", "toolUse"]) {
			spy.mockResolvedValue(reply("fine", { stopReason }));
			expect(await generateSessionRecap(input())).toBeNull();
		}
	});

	it("rejects tool calls and returned-model mismatch", async () => {
		const spy = vi.spyOn(ai, "completeSimple").mockResolvedValue(
			reply("fine", {
				content: [
					{ type: "text", text: "fine" },
					{ type: "toolCall", id: "c", name: "bash", arguments: {} },
				],
			}),
		);
		expect(await generateSessionRecap(input())).toBeNull();
		spy.mockResolvedValue(reply("fine", { model: "some-other-model" }));
		expect(await generateSessionRecap(input())).toBeNull();
		spy.mockResolvedValue(reply("fine", { provider: "openai" }));
		expect(await generateSessionRecap(input())).toBeNull();
	});

	it("returns null when the provider throws", async () => {
		vi.spyOn(ai, "completeSimple").mockRejectedValue(new Error("boom"));
		expect(await generateSessionRecap(input())).toBeNull();
	});
});

describe("generateSessionRecap abort and timeout", () => {
	it("returns null for an already aborted signal without calling the provider", async () => {
		const completeSimple = vi.spyOn(ai, "completeSimple").mockResolvedValue(reply("ok"));
		const controller = new AbortController();
		controller.abort();
		expect(await generateSessionRecap(input({ signal: controller.signal }))).toBeNull();
		expect(completeSimple).not.toHaveBeenCalled();
	});

	it("stops waiting on external abort even when the provider ignores the signal", async () => {
		const pending = Promise.withResolvers<never>();
		const completeSimple = vi.spyOn(ai, "completeSimple").mockReturnValue(pending.promise);
		const controller = new AbortController();
		const run = generateSessionRecap(input({ signal: controller.signal }));
		while (completeSimple.mock.calls.length === 0) await Bun.sleep(1);
		controller.abort();
		expect(await run).toBeNull();
		const options = completeSimple.mock.calls[0]?.[2] as { signal?: AbortSignal } | undefined;
		expect(options?.signal?.aborted).toBe(true);
	});

	it("times out after 30 seconds, aborts the request, and clears the timer", async () => {
		expect(RECAP_TIMEOUT_MS).toBe(30_000);
		const pending = Promise.withResolvers<never>();
		const completeSimple = vi.spyOn(ai, "completeSimple").mockReturnValue(pending.promise);
		const timeouts: Array<() => void> = [];
		const cleared: unknown[] = [];
		const realSet = globalThis.setTimeout;
		const realClear = globalThis.clearTimeout;
		const recapTimer = realSet(() => {}, RECAP_TIMEOUT_MS);
		realClear(recapTimer);
		vi.spyOn(globalThis, "setTimeout").mockImplementation(((fn: () => void, ms?: number) => {
			if (ms === RECAP_TIMEOUT_MS) {
				timeouts.push(fn);
				return recapTimer;
			}
			return realSet(fn, ms);
		}) as never);
		vi.spyOn(globalThis, "clearTimeout").mockImplementation(id => {
			cleared.push(id);
			if (id !== recapTimer) Reflect.apply(realClear, globalThis, [id]);
		});
		const run = generateSessionRecap(input());
		while (completeSimple.mock.calls.length === 0) await Bun.sleep(1);
		timeouts[0]?.();
		expect(await run).toBeNull();
		const options = completeSimple.mock.calls[0]?.[2] as { signal?: AbortSignal } | undefined;
		expect(options?.signal?.aborted).toBe(true);
		expect(cleared).toContain(recapTimer);
	});
});
