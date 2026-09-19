import { afterEach, describe, expect, it, spyOn } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Agent } from "@gajae-code/agent-core";
import { getBundledModel } from "@gajae-code/ai";
import { createMockModel } from "@gajae-code/ai/providers/mock";
import { Settings } from "@gajae-code/coding-agent/config/settings";
import {
	DEFAULT_SDK_PROMPT_DEADLINE_MS,
	DEFAULT_SDK_PROMPT_MAX_RUNTIME_MS,
	getDefault,
	hasUi,
	reconcileSettingsSchema,
	resolveSdkPromptDeadlineMs,
	resolveSdkPromptMaxRuntimeMs,
	SETTINGS_SCHEMA,
} from "@gajae-code/coding-agent/config/settings-schema";
import type { ExtensionAPI, ExtensionContext, ExtensionEvent } from "../src/extensibility/extensions";
import type { ExtensionActions } from "../src/extensibility/extensions/types";
import { createNotificationsExtension } from "../src/sdk/bus";
import { createSdkSessionRuntimeExtension } from "../src/sdk/host/session-runtime";
import type { SdkFrame } from "../src/sdk/host/types";
import { AgentSession, type AgentSessionEvent } from "../src/session/agent-session";
import { SessionManager } from "../src/session/session-manager";

const SETTING_PATH = "sdk.promptDeadlineMs";

function schemaReportFor(value: unknown) {
	return reconcileSettingsSchema({ sdk: { promptDeadlineMs: value } }).report;
}

describe("sdk.promptDeadlineMs", () => {
	it("defaults to 3,600,000 milliseconds", () => {
		expect(Settings.isolated().get(SETTING_PATH)).toBe(3_600_000);
	});

	it("accepts its inclusive safe-integer bounds", () => {
		for (const value of [60_000, 86_400_000]) {
			expect(schemaReportFor(value)).toEqual({ issues: [], valid: true });
		}
	});

	it("rejects values outside its safe-integer bounds", () => {
		for (const value of [59_999, 86_400_001, 0, -1, 60_000.5, Number.NaN, Number.POSITIVE_INFINITY]) {
			const report = schemaReportFor(value);
			expect(report.valid).toBe(false);
			expect(report.issues).toContainEqual(expect.objectContaining({ path: SETTING_PATH, kind: "invalid" }));
		}
	});

	it("is hidden from normal settings UI listings", () => {
		expect(hasUi(SETTING_PATH)).toBe(false);
	});

	it("publishes its inclusive bounds in the generated JSON schema", async () => {
		const schema = JSON.parse(
			await Bun.file(new URL("../../../schemas/config.schema.json", import.meta.url)).text(),
		) as {
			properties: {
				sdk: { properties: { promptDeadlineMs: { type: string; minimum: number; maximum: number } } };
			};
		};

		expect(schema.properties.sdk.properties.promptDeadlineMs).toMatchObject({
			type: "integer",
			minimum: 60_000,
			maximum: 86_400_000,
		});
	});
});

describe("sdk prompt deadline resolvers", () => {
	// A Settings lookup misses in several shapes: no settings object at all, an
	// unwritten key, or a stored value that is not a finite number.
	const MISSES = [
		undefined,
		null,
		Number.NaN,
		Number.POSITIVE_INFINITY,
		Number.NEGATIVE_INFINITY,
		"3600000",
		{},
		[],
		true,
	];

	it("falls back to the declared default for every non-finite lookup", () => {
		for (const miss of MISSES) {
			expect(resolveSdkPromptDeadlineMs(miss)).toBe(DEFAULT_SDK_PROMPT_DEADLINE_MS);
			expect(resolveSdkPromptMaxRuntimeMs(miss)).toBe(DEFAULT_SDK_PROMPT_MAX_RUNTIME_MS);
		}
	});

	it("passes finite numbers through unchanged", () => {
		// Finiteness fallback only — range enforcement stays with the schema's
		// `validate:` and must not migrate into the resolvers.
		for (const value of [120_000, 0, -1, 60_000, 86_400_000]) {
			expect(resolveSdkPromptDeadlineMs(value)).toBe(value);
			expect(resolveSdkPromptMaxRuntimeMs(value)).toBe(value);
		}
	});

	it("falls back to the same value a real Settings instance hands back (#5583)", () => {
		expect(resolveSdkPromptDeadlineMs(undefined)).toBe(Settings.isolated().get("sdk.promptDeadlineMs"));
		expect(resolveSdkPromptMaxRuntimeMs(undefined)).toBe(Settings.isolated().get("sdk.promptMaxRuntimeMs"));
	});

	it("exports constants equal to the schema entries' declared defaults", () => {
		expect(DEFAULT_SDK_PROMPT_DEADLINE_MS).toBe(getDefault("sdk.promptDeadlineMs"));
		expect(DEFAULT_SDK_PROMPT_MAX_RUNTIME_MS).toBe(getDefault("sdk.promptMaxRuntimeMs"));
		expect(SETTINGS_SCHEMA["sdk.promptDeadlineMs"].default).toBe(DEFAULT_SDK_PROMPT_DEADLINE_MS);
		expect(SETTINGS_SCHEMA["sdk.promptMaxRuntimeMs"].default).toBe(DEFAULT_SDK_PROMPT_MAX_RUNTIME_MS);
	});
});

/**
 * Route-level falsifiers for the arming call sites (#5583).
 *
 * Everything above exercises the exported resolver and schema APIs only, so all
 * of it stays green if a CALL SITE puts the old 30-minute literal back — the
 * exact defect this change fixes would regress undetected. The two cases below
 * construct the real extensions and assert the delay that actually reaches
 * `setTimeout` at acceptance.
 *
 * WHY A ROUTE UNDER TEST IS NEVER HANDED A REAL `Settings`: both call sites read
 * `finite(lookup) ? lookup : FALLBACK`, and the fix changed only FALLBACK
 * (1_800_000 -> DEFAULT_SDK_PROMPT_DEADLINE_MS). Measured in this worktree under
 * the test preload:
 *
 *     Settings.instance                               -> throws (uninitialised)
 *     Settings.isolated().get("sdk.promptDeadlineMs") -> 3_600_000   (finite!)
 *     stub get() -> undefined | null                  -> non-finite
 *
 * A real instance answers the lookup with a finite 3_600_000 out of its own
 * schema default, so the fallback is never reached and the PRE-FIX literal
 * produces the same 3_600_000 the fix does. Feeding a route a real `Settings`
 * therefore reintroduces the vacuousness one level down. The only input that
 * separates the two is a MISSING lookup — do not "simplify" these stubs away.
 */

/** Deadline lookups whose miss is the falsifier; every other key stays untouched. */
const DEADLINE_LOOKUP_KEYS = new Set(["sdk.promptDeadlineMs", "sdk.promptMaxRuntimeMs"]);

/**
 * Floor separating a prompt-deadline arm from ordinary session-start timers.
 * Derived from the constant so it cannot go stale, and deliberately BELOW the
 * pre-fix 30-minute literal so a reverted call site is still CAPTURED: the
 * falsification then fails on an assertion diff naming the wrong lease, not on
 * a capture timeout — which could not tell a wrong lease from an unreached call
 * site. Nothing in session start schedules within an order of magnitude of this.
 */
const DEADLINE_ARM_FLOOR_MS = DEFAULT_SDK_PROMPT_DEADLINE_MS / 4;

/**
 * Arming happens after an awaited durable accept, so the delay handed to
 * `setTimeout` is the lease minus that write's duration: at most the lease, and
 * only milliseconds under it. A fixed numeric window like the bus suite's
 * `delay > leaseMs / 2` is meaningless at the hour-long default, so recover the
 * lease instead and let the assertion compare exact numbers.
 */
const ARM_SLACK_MS = 60_000;

/** The lease a route armed from, recovered from the delay it scheduled. */
function armedLeaseMs(delayMs: number): number {
	const drift = DEFAULT_SDK_PROMPT_DEADLINE_MS - delayMs;
	return drift >= 0 && drift <= ARM_SLACK_MS ? DEFAULT_SDK_PROMPT_DEADLINE_MS : delayMs;
}

/** Captured before any spy so re-entry always reaches the real timer. */
const realSetTimeout = globalThis.setTimeout;

async function waitFor(predicate: () => boolean, label: string, timeoutMs = 20_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!predicate()) {
		if (Date.now() > deadline) throw new Error(`Timed out waiting for ${label}`);
		await Bun.sleep(10);
	}
}

/**
 * Record every deadline-sized arm scheduled while `body` runs, then restore the
 * spy. The spy ALWAYS delegates to the real timer: unrelated timers are
 * scheduled during session start and swallowing them hangs the suite. The window
 * is held open only across the single acceptance, so "exactly one arm" is a
 * statement about that acceptance rather than about total timer traffic.
 */
async function captureDeadlineArms(body: (arms: number[]) => Promise<void>): Promise<number[]> {
	const arms: number[] = [];
	const scheduleSpy = spyOn(globalThis, "setTimeout").mockImplementation(((
		callback: () => void,
		delayMs?: number,
		...rest: unknown[]
	) => {
		if (delayMs !== undefined && delayMs >= DEADLINE_ARM_FLOOR_MS) arms.push(delayMs);
		return realSetTimeout(callback, delayMs, ...rest);
	}) as never);
	try {
		await body(arms);
	} finally {
		scheduleSpy.mockRestore();
	}
	return arms;
}

/** The three shapes a `sdk.promptDeadlineMs` lookup misses in. */
const MISS_SHAPES = [
	{ label: "omitted", name: "no settings object at all", stored: undefined, omitSettings: true },
	{ label: "unwritten", name: "an unwritten key", stored: undefined, omitSettings: false },
	{ label: "null", name: "an explicitly null stored value", stored: null, omitSettings: false },
] as const;

describe("sdk prompt deadline arming — bus route (#5583)", () => {
	const dirs: string[] = [];
	const sockets: WebSocket[] = [];

	afterEach(async () => {
		await Promise.all(
			sockets.splice(0).map(async socket => {
				if (socket.readyState === WebSocket.CLOSED) return;
				const { promise, resolve } = Promise.withResolvers<void>();
				socket.addEventListener("close", () => resolve(), { once: true });
				socket.close();
				await Promise.race([promise, Bun.sleep(500)]);
			}),
		);
		for (const dir of dirs.splice(0)) await fs.promises.rm(dir, { recursive: true, force: true });
	});

	/**
	 * Same shape as the bus deadline suite's `deadlineSettings`, but its deadline
	 * lookups MISS instead of injecting explicit finite values. `getAgentDir` is
	 * retained so nothing else in session start changes behaviour.
	 */
	function missingDeadlineSettings(cwd: string, stored: null | undefined): Settings {
		return {
			get: (key: string) => (DEADLINE_LOOKUP_KEYS.has(key) ? stored : undefined),
			getAgentDir: () => cwd,
		} as unknown as Settings;
	}

	function context(cwd: string, sessionId: string): Record<string, unknown> {
		return {
			cwd,
			sessionMetadata: { kind: "main", taskDepth: 0 },
			sessionManager: {
				getSessionId: () => sessionId,
				getCwd: () => cwd,
				getSessionName: () => "bus prompt deadline default",
				getUsageStatistics: () => ({
					input: 1,
					output: 2,
					cacheRead: 0,
					cacheWrite: 0,
					premiumRequests: 0,
					cost: 0,
				}),
				getBranch: () => [],
			},
			getContextUsage: () => ({ tokens: 3, contextWindow: 100, percent: 3 }),
			model: { provider: "fixture-provider", id: "fixture-model" },
			getThinkingLevel: () => "low",
			getActivePromptHandle: () => "bus-default-run-handle",
			abortPromptAndWait: async () => ({ status: "settled", terminalScope: {} }),
			getSystemPrompt: () => ["test"],
			isIdle: () => true,
			hasPendingMessages: () => false,
			getPendingMessageCounts: () => ({ steering: 0, followUp: 0, nextTurn: 0 }),
			resolveTool: () => undefined,
		};
	}

	function start(
		ctx: Record<string, unknown>,
		settings: Settings | undefined,
	): Map<string, (event: unknown, context: unknown) => unknown> {
		const handlers = new Map<string, (event: unknown, context: unknown) => unknown>();
		const api = {
			on: (event: string, handler: (event: unknown, context: unknown) => unknown) => handlers.set(event, handler),
			registerCommand: () => {},
			getThinkingLevel: () => undefined,
			sendUserMessage: (
				_content: Parameters<ExtensionActions["sendUserMessage"]>[0],
				options?: Parameters<ExtensionActions["sendUserMessage"]>[1],
			) => {
				const commit = options?.onPreflightAcceptCommit;
				const accepted = options?.onPreflightAccepted;
				// The prompt never settles on its own: the deadline is the only terminal.
				const deliver = () => new Promise<never>(() => {}) as never;
				if (commit)
					return Promise.resolve(commit()).then(() => {
						accepted?.();
						return deliver();
					});
				accepted?.();
				return deliver();
			},
		} as unknown as ExtensionAPI;
		createNotificationsExtension(api, {
			// `settings` is OMITTED, not passed as undefined, for the omitted shape:
			// `resolveSettings` then falls through to `Settings.instance`, which
			// throws while uninitialised, leaving the call site's `settings?.get`
			// undefined — the embedder-omits-settings case the reviewer asked for.
			...(settings ? { settings } : {}),
			terminalAbortSeams: {
				getTerminalTurnEpoch: () => undefined,
				cancelPendingPreflightForTerminalAbort: () => {},
				abortPromptAndWaitWithTerminal: (handle, seamOptions) =>
					(
						ctx as {
							abortPromptAndWait: (handle: string, options: { graceMs: number }) => Promise<unknown>;
						}
					).abortPromptAndWait(handle, seamOptions) as never,
			},
		});
		void handlers.get("session_start")?.({ type: "session_start" }, ctx);
		return handlers;
	}

	for (const shape of MISS_SHAPES) {
		it(`arms the accepted prompt at the declared default when the lookup misses with ${shape.name}`, async () => {
			const cwd = fs.mkdtempSync(path.join(os.tmpdir(), `gjc-sdk-bus-default-${shape.label}-`));
			dirs.push(cwd);
			const sessionId = `sdk-bus-default-${shape.label}-${Date.now()}`;
			const ctx = context(cwd, sessionId);
			const handlers = start(ctx, shape.omitSettings ? undefined : missingDeadlineSettings(cwd, shape.stored));

			const endpointFile = path.join(cwd, ".gjc", "state", "sdk", `${sessionId}.json`);
			await waitFor(() => fs.existsSync(endpointFile), "SDK endpoint");
			const endpoint = JSON.parse(fs.readFileSync(endpointFile, "utf8")) as { url: string; token: string };
			const frames: Record<string, unknown>[] = [];
			const socket = new WebSocket(`${endpoint.url}/?token=${encodeURIComponent(endpoint.token)}`);
			sockets.push(socket);
			socket.addEventListener("message", event => frames.push(JSON.parse(String(event.data))));
			await new Promise<void>((resolve, reject) => {
				socket.addEventListener("open", () => resolve(), { once: true });
				socket.addEventListener("error", () => reject(new Error("WS error")), { once: true });
			});

			const promptId = `${shape.label}-prompt`;
			const acknowledged = () => frames.some(frame => frame.type === "control_response" && frame.id === promptId);
			const arms = await captureDeadlineArms(async armed => {
				socket.send(
					JSON.stringify({
						type: "control_request",
						id: promptId,
						operation: "turn.prompt",
						input: { text: `deadline ${shape.label}` },
					}),
				);
				await waitFor(acknowledged, "prompt acknowledgement");
				// The deadline is armed after the durable accept, which can settle
				// after the acknowledgement frame: hold the window until it is armed.
				await waitFor(() => armed.length > 0, "captured deadline arm");
			});

			const acknowledgement = frames.find(frame => frame.type === "control_response" && frame.id === promptId) as {
				ok?: boolean;
			};
			// CONTROL: holds in both the reverted and the restored state. Without it
			// "the test failed" could not be told apart from "the harness never
			// reached the call site".
			expect(acknowledgement.ok).toBe(true);
			expect(arms).toHaveLength(1);
			expect(armedLeaseMs(arms[0]!)).toBe(DEFAULT_SDK_PROMPT_DEADLINE_MS);

			// Release the hour-long timer: the bus does not unref its deadline, so
			// leaving it armed keeps the suite's event loop busy after the test.
			await handlers.get("agent_start")?.({ type: "agent_start", runId: "bus-default-run-handle" }, ctx);
			await handlers.get("agent_end")?.({ type: "agent_end", stopReason: "completed", messages: [] }, ctx);
			try {
				await handlers.get("session_shutdown")?.({ type: "session_shutdown" }, ctx);
			} catch (error) {
				// The harness prompt deliberately never settles, so reconciliation
				// cannot go quiescent and teardown reports a drain timeout. That is
				// harness shape, not a deadline assertion.
				if ((error as { code?: string }).code !== "sdk_reconciliation_teardown_failed") throw error;
			}
		}, 30_000);
	}
});

describe("sdk prompt deadline arming — SDK-only host route (#5583)", () => {
	for (const shape of MISS_SHAPES) {
		it(`arms the accepted prompt at the declared default when the lookup misses with ${shape.name}`, async () => {
			const cwd = await fs.promises.mkdtemp(path.join(os.tmpdir(), `gjc-sdk-host-default-${shape.label}-`));
			const model = getBundledModel("anthropic", "claude-sonnet-4-5");
			if (!model) throw new Error("Expected bundled Anthropic test model");
			// The turn must still be in flight when the deadline is armed, so the
			// mock response is deliberately slower than the whole test.
			const mock = createMockModel({ responses: [{ content: ["armed"], delayMs: 60_000 }] });
			const agent = new Agent({
				getApiKey: () => "test-key",
				initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] },
				streamFn: mock.stream,
			});
			const settings = Settings.isolated({ "compaction.enabled": false });
			settings.setModelRole("default", `${model.provider}/${model.id}`);
			// The runtime touches many `Settings` members during startup, so a partial
			// stub fails in unrelated ways. Delegate everything to the real isolated
			// instance except the two deadline lookups, which must MISS — handing the
			// route the real instance would answer them with a finite 3_600_000 and
			// the assertion below would pass against the pre-fix literal too.
			// Functions are bound to the target: `Settings` holds `#private` fields,
			// which throw when a method runs with the proxy as `this`.
			const settingsWithMissingDeadlines = new Proxy(settings, {
				get(target, prop) {
					if (prop === "get")
						return (key: string) => (DEADLINE_LOOKUP_KEYS.has(key) ? shape.stored : target.get(key as never));
					const value = Reflect.get(target, prop, target);
					return typeof value === "function" ? (value as (...args: never[]) => unknown).bind(target) : value;
				},
			}) as Settings;

			const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => unknown>();
			const frames: Array<{ connectionId: string; frame: SdkFrame }> = [];
			let receive: ((connectionId: string, frame: SdkFrame) => void) | undefined;
			let ctx: ExtensionContext;
			const sessionManager = SessionManager.inMemory(cwd);
			const session = new AgentSession({
				agent,
				sessionManager,
				settings,
				modelRegistry: { getApiKey: async () => "test-key", getAuthStorageOwner: () => undefined } as never,
				extensionRunner: {
					hasHandlers: () => true,
					emitBeforeAgentStart: async () => undefined,
					emit: async (event: ExtensionEvent) => handlers.get(event.type)?.(event, ctx),
				} as never,
			});
			const api = {
				on: (event: string, handler: (event: unknown, context: ExtensionContext) => unknown) => {
					handlers.set(event, handler);
				},
				sendUserMessage: async (content: string, options: Parameters<AgentSession["sendUserMessage"]>[1]) =>
					session.sendUserMessage(content, options),
			} as unknown as ExtensionAPI;
			createSdkSessionRuntimeExtension(api, {
				agentDir: cwd,
				// The route reads `options.settings?.get(...)` with no fallback to
				// `Settings.instance`, so an omitted `settings` is a valid falsifier
				// here on its own.
				...(shape.omitSettings ? {} : { settings: settingsWithMissingDeadlines }),
				createTransport: async ({ sessionId, stateRoot, token }) => ({
					sessionId,
					stateRoot,
					token,
					onFrame: handler => {
						receive = handler;
						return () => {
							receive = undefined;
						};
					},
					sendFrame: (connectionId, frame) => {
						frames.push({ connectionId, frame });
						return "written" as const;
					},
					broadcastFrame: frame => {
						frames.push({ connectionId: "broadcast", frame });
					},
					start: async () => ({ url: "ws://127.0.0.1:1" }),
					stop: async () => {},
				}),
			});
			ctx = {
				cwd,
				sessionManager,
				isIdle: () => !agent.state.isStreaming,
				sdkBindings: () => [],
				onSessionEvent: (listener: (event: AgentSessionEvent) => void) => session.subscribe(listener),
			} as unknown as ExtensionContext;

			try {
				await handlers.get("session_start")?.({}, ctx);
				const promptId = `${shape.label}-host-prompt`;
				const acknowledged = () => frames.some(({ frame }) => "id" in frame && frame.id === promptId);
				const arms = await captureDeadlineArms(async armed => {
					receive?.(promptId, {
						type: "control_request",
						id: promptId,
						operation: "turn.prompt",
						input: { text: `deadline ${shape.label}` },
					});
					await waitFor(acknowledged, "prompt acknowledgement");
					await waitFor(() => armed.length > 0, "captured deadline arm");
				});

				const acknowledgement = frames.find(({ frame }) => "id" in frame && frame.id === promptId)?.frame;
				// CONTROL: holds in both the reverted and the restored state.
				expect(acknowledgement).toMatchObject({ ok: true });
				expect(arms).toHaveLength(1);
				expect(armedLeaseMs(arms[0]!)).toBe(DEFAULT_SDK_PROMPT_DEADLINE_MS);
			} finally {
				await session.abort({ cause: "user_interrupt" }).catch(() => {});
				await handlers.get("session_shutdown")?.({}, ctx);
				await session.dispose();
				await fs.promises.rm(cwd, { recursive: true, force: true });
			}
		}, 30_000);
	}
});
