import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentSession } from "../../../session/agent-session";
import { stableValidators } from "../../protocol-source/schema-validators.generated";
import type { LoadedThreadRuntime } from "../../thread-runtime/child-bridge";
import { loadThread } from "../../thread-runtime/child-bridge";
import { createProductionThreadStartAdapter } from "../../thread-runtime/production-child";
import { ThreadRuntimeManager } from "../../thread-runtime/thread-runtime-manager";

// The first test creates a REAL broker-owned GJC session. The correlation test uses the adapter's
// injected session seam so the event invariant remains deterministic when no model provider is configured.
const temporary = () => mkdtempSync(join(tmpdir(), "gjc-production-child-"));

test("the production adapter loads a real session and answers thread/start for both profiles", async () => {
	const agentDir = temporary();
	const cwd = temporary();
	const manager = new ThreadRuntimeManager({ maxLoadedThreads: 4 });
	const adapter = { manager, ...createProductionThreadStartAdapter({ agentDir }) };
	try {
		for (const experimentalApi of [false, true]) {
			const runtime = await loadThread(adapter, { connectionId: "conn-a", params: { cwd }, experimentalApi });
			expect(runtime.threadId.length).toBeGreaterThan(0);
			const validate = stableValidators.clientRequestResults["thread/start"];
			// The stable validator is the strict subset both profiles must satisfy.
			if (!experimentalApi) expect(validate?.(runtime.response)).toBe(true);
			const thread = (runtime.response as { thread: Record<string, unknown> }).thread;
			expect(thread.cwd).toBe(cwd);
			expect(thread.sessionId).toBe(runtime.threadId);
			// Production sessions are separate broker-owned processes with an endpoint authority tuple.
			expect(manager.get(runtime.threadId)?.ownership).toBe("spawned");
			expect(manager.get(runtime.threadId)?.authority).toMatchObject({
				endpointGeneration: expect.any(Number),
				endpointIncarnation: expect.any(String),
				endpointMtimeMs: expect.any(Number),
				pid: expect.any(Number),
			});
			expect(manager.get(runtime.threadId)?.client).toBeDefined();
			if (!experimentalApi) {
				const envelope = {
					schemaVersion: 1,
					recordKind: "production-child.test",
					sourceKey: `production-child:${runtime.threadId}`,
					payload: { value: "first" },
				};
				const first = (await runtime.client.control(
					"projection.append",
					{ envelope },
					{ confirm: true, idempotencyKey: envelope.sourceKey },
				)) as Record<string, unknown>;
				const retry = (await runtime.client.control(
					"projection.append",
					{ envelope },
					{ confirm: true, idempotencyKey: envelope.sourceKey },
				)) as Record<string, unknown>;
				expect(retry.reused).toBe(true);
				expect(retry.revision).toBe(first.revision);
				await expect(
					runtime.client.control(
						"projection.append",
						{ envelope: { ...envelope, payload: { value: "conflict" } } },
						{ confirm: true, idempotencyKey: envelope.sourceKey },
					),
				).rejects.toMatchObject({ code: "idempotency_conflict" });
			}
			expect(manager.remove(runtime.threadId)).toBe(true);
		}
		expect(manager.loaded()).toEqual([]);
	} finally {
		rmSync(agentDir, { recursive: true, force: true });
		rmSync(cwd, { recursive: true, force: true });
	}
}, 120_000);

test("the production child reuses one commandId/turnId pair for prompt acknowledgement, status, and lifecycle frames", async () => {
	const agentDir = temporary();
	const cwd = temporary();
	const manager = new ThreadRuntimeManager({ maxLoadedThreads: 4 });
	const adapter = {
		manager,
		...createProductionThreadStartAdapter({
			createSession: async () => {
				let subscriber: ((event: { type: string }) => void) | undefined;
				const session = {
					sessionId: "correlation-session",
					sessionManager: {
						getCwd: () => cwd,
						getSessionFile: () => null,
					},
					model: { id: "correlation-model", provider: "correlation-provider", reasoning: false },
					serviceTier: undefined,
					sdkPermissionMode: "prompt",
					thinkingLevel: undefined,
					getAvailableThinkingLevels: () => [],
					setThinkingLevelForControl: async () => {},
					setThinkingLevel: () => {},
					setSdkPermissionMode: () => {},
					workflowGateToolRestoration: Promise.resolve(),
					subscribe: (handler: (event: { type: string }) => void) => {
						subscriber = handler;
						return () => {
							subscriber = undefined;
						};
					},
					prompt: async () => {
						subscriber?.({ type: "agent_start" });
						subscriber?.({ type: "agent_end" });
					},
					steer: () => undefined,
					abort: () => undefined,
					compact: () => undefined,
					dispose: async () => {},
				} as unknown as AgentSession;
				return { session } as never;
			},
		}),
	};
	let runtime: LoadedThreadRuntime | undefined;
	try {
		const loaded = await loadThread(adapter, { connectionId: "conn-correlation", params: { cwd } });
		if (!loaded) throw new Error("Production child load unexpectedly returned no runtime.");
		runtime = loaded;
		const active = loaded;
		const frames: Record<string, unknown>[] = [];
		const unsubscribe = active.client.onFrame((frame: Record<string, unknown>) => {
			if (frame.type === "event" && (frame.kind === "agent_start" || frame.kind === "agent_end")) frames.push(frame);
		});
		try {
			const rawAcknowledgement = await active.client.control("turn.prompt", {
				text: "correlation invariant",
				clientRef: "correlation-client-ref",
			});
			const acknowledgement = rawAcknowledgement as Record<string, unknown>;
			expect(acknowledgement.accepted).toBe(true);
			expect(typeof acknowledgement.commandId).toBe("string");
			expect(typeof acknowledgement.turnId).toBe("string");
			await Bun.sleep(1_000);
			expect(frames.length).toBeGreaterThan(0);
			for (const frame of frames) {
				expect(frame.commandId).toBe(acknowledgement.commandId);
				expect(frame.turnId).toBe(acknowledgement.turnId);
			}
			const status = (await active.client.query("turn.prompt_status", {
				clientRef: "correlation-client-ref",
			})) as Record<string, unknown>;
			expect(status.commandId).toBe(acknowledgement.commandId);
			expect(status.turnId).toBe(acknowledgement.turnId);
			await expect(active.client.setTurnPolicyForTurn?.({ reasoningEffort: "medium" })).rejects.toThrow(
				/Reasoning effort "medium" is not supported by the child model "correlation-provider\/correlation-model"\./,
			);
			await expect(active.client.setTurnPolicyForTurn?.({ reasoningEffort: "high" })).rejects.toThrow(
				/Reasoning effort "high" is not supported by the child model "correlation-provider\/correlation-model"\./,
			);
		} finally {
			unsubscribe();
		}
	} finally {
		if (runtime) manager.remove(runtime.threadId);
		rmSync(agentDir, { recursive: true, force: true });
		rmSync(cwd, { recursive: true, force: true });
	}
}, 120_000);

test("the production adapter fails closed when the session cannot be created", async () => {
	const manager = new ThreadRuntimeManager({ maxLoadedThreads: 4 });
	const adapter = {
		manager,
		...createProductionThreadStartAdapter({
			createSession: async () => {
				throw new Error("session startup failed");
			},
		}),
	};
	await expect(loadThread(adapter, { connectionId: "conn-a", params: { cwd: temporary() } })).rejects.toThrow();
	// Nothing may be published when creation fails.
	expect(manager.loaded()).toEqual([]);
});
