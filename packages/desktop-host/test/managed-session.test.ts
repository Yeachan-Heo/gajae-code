import { afterEach, expect, test, vi } from "bun:test";
import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { ThinkingLevel } from "@gajae-code/agent-core";
import { Effort } from "@gajae-code/ai/core";
import {
	type Q10Model,
	type Q10SettableThinkingLevel,
	lifecycle as sdkLifecycle,
	router as sdkRouter,
} from "@gajae-code/coding-agent/sdk";
import {
	createDesktopManagedEndpointAuthority,
	createDesktopManagedModelQueries,
} from "./fixtures/desktop-managed-endpoint";
import { createSdkWebSocketTransport } from "@gajae-code/coding-agent/sdk/host/websocket-transport";
import { SessionManager } from "@gajae-code/coding-agent/session/session-manager";
import { ManagedSession } from "../src/managed-session";
import { DeliveryJournal } from "../src/delivery-journal";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
	try {
		while (cleanups.length) await cleanups.pop()?.();
	} finally {
		vi.restoreAllMocks();
	}
});

async function fixture(
	options: {
		open?: boolean;
		wrongAuthority?: boolean;
		missingSavedSession?: boolean;
		idle?: boolean;
		pagedModels?: boolean;
	} = {},
) {
	const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "gjc-managed-desktop-")));
	const cwd = path.join(directory, "project");
	const agentDir = path.join(directory, "agent");
	await fs.mkdir(cwd);
	await fs.mkdir(agentDir, { mode: 0o700 });
	const manager = SessionManager.create(cwd, SessionManager.managedDestination(cwd, agentDir));
	await manager.setSessionName("Original terminal title", "user");
	await manager.ensureOnDisk();
	await manager.flush();
	const id = manager.getSessionId();
	const file = manager.getSessionFile()!;
	const inspection = await SessionManager.inspectSessionTailReadOnly(file);
	if (inspection.kind === "error") throw new Error("Fixture transcript inspection failed");
	const identity = inspection.identity;
	const transcript = await Bun.file(file).text();
	await manager.close();
	const stateRoot = path.join(cwd, ".gjc", "state");
	const transport = await createSdkWebSocketTransport({ sessionId: id, stateRoot, token: "fixture-secret" });
	await transport.start();
	const generation = 7;
	let seq = 0;
	let idle = options.idle ?? true;
	let pendingGate = false;
	let thinking: Q10SettableThinkingLevel = ThinkingLevel.Off;
	const modelName = options.pagedModels ? "false".repeat(60_000) : "Fixture model";
	const models = (): Q10Model[] => [
		...(options.pagedModels
			? [
					{
						provider: "fixture",
						id: "unused",
						name: modelName,
						contextWindow: 48000,
						maxTokens: 512,
						reasoning: false,
						thinking: { validLevels: [] },
						current: false,
					},
				]
			: []),
		{
			provider: "fixture",
			id: "model",
			name: modelName,
			contextWindow: 10000,
			maxTokens: 1000,
			reasoning: true,
			thinking: { validLevels: [ThinkingLevel.Off, Effort.Low, Effort.High], mode: "effort" },
			current: true,
			currentThinkingLevel: thinking,
		},
	];
	const modelQueries = options.pagedModels ? createDesktopManagedModelQueries(id, models) : undefined;
	const entries: unknown[] = [{ id: "original", role: "user", body: "Existing terminal transcript" }];
	const controls: Array<{ operation: unknown; input: Record<string, unknown> }> = [];
	const queries: unknown[] = [];
	const receipts = new Map<string, Record<string, unknown>>();
	const connections = new Set<string>();
	const disposeFrames = transport.onFrame((connectionId, frame) => {
		connections.add(connectionId);
		void (async () => {
			if (frame.type === "event_replay") {
				await transport.sendFrame(connectionId, {
					type: "event_replay_result",
					id: frame.id,
					ok: true,
					generation,
					lastSeq: seq,
					events: [],
				});
				return;
			}
			if (frame.type === "query_request") {
				queries.push(frame.query);
				const input = frame.input as Record<string, unknown>;
				if (modelQueries && (frame.query === "models.list/current" || frame.query === "resource.body")) {
					const response = await modelQueries.dispatch({
						id: typeof frame.id === "string" ? frame.id : undefined,
						query: frame.query,
						input,
						connectionId,
						...(typeof frame.cursor === "string" ? { cursor: frame.cursor } : {}),
					});
					await transport.sendFrame(connectionId, { ...response });
					return;
				}
				let response: Record<string, unknown>;
				switch (frame.query) {
					case "session.checkpoint":
						response = {
							result: {
								checkpointToken: "owned-checkpoint",
								checkpoint: { revision: entries.length, generation, seq, idle },
							},
						};
						break;
					case "transcript.list":
						expect(input.checkpointToken).toBe("owned-checkpoint");
						response = { page: { items: [...entries], complete: true, revision: String(entries.length) } };
						break;
					case "session.metadata":
						response = {
							page: {
								items: [{ sessionId: id, name: "Original terminal title", cwd }],
								complete: true,
								revision: "1",
							},
						};
						break;
					case "models.list/current":
						response = { page: { items: models(), complete: true, revision: "1" } };
						break;
					case "workflow.gates.list":
						response = {
							page: { items: pendingGate ? [{ tag: "pending" }] : [], complete: true, revision: "1" },
						};
						break;
					case "turn.result":
						response = {
							result: receipts.get(String(input.clientRef ?? input.commandId)) ?? { status: "unknown" },
						};
						break;
					case "turn.steer_status":
						response = {
							result: {
								status: receipts.has(String(input.clientRef ?? input.commandId)) ? "accepted" : "unknown",
							},
						};
						break;
					default:
						throw new Error(`Unexpected query ${String(frame.query)}`);
				}
				await transport.sendFrame(connectionId, { type: "query_response", id: frame.id, ok: true, ...response });
			}
			if (frame.type === "control_request") {
				const input = frame.input as Record<string, unknown>;
				controls.push({ operation: frame.operation, input });
				let result: unknown = null;
				if (["turn.prompt", "turn.follow_up", "turn.steer"].includes(String(frame.operation))) {
					idle = false;
					const commandId = crypto.randomUUID();
					const turnId = crypto.randomUUID();
					result = { accepted: true, commandId, turnId };
					receipts.set(String(input.clientRef), { status: "in_flight", commandId, turnId });
					receipts.set(commandId, { status: "in_flight", commandId, turnId });
				}
				if (frame.operation === "turn.abort") {
					idle = true;
					result = { aborted: true };
				}
				if (frame.operation === "thinking.set") {
					if (input.level !== ThinkingLevel.Off && input.level !== Effort.Low && input.level !== Effort.High)
						throw new Error("Unsupported fixture thinking level");
					thinking = input.level;
				}
				await transport.sendFrame(connectionId, { type: "control_response", id: frame.id, ok: true, result });
			}
		})().catch(error => {
			void transport.sendFrame(connectionId, {
				type: "query_response",
				id: frame.id,
				ok: false,
				error: { code: "fixture_error", message: String(error) },
			});
		});
	});
	const authority = await createDesktopManagedEndpointAuthority({ agentDir, cwd, sessionId: id, generation });
	const { binding } = authority;
	const lifecycleCalls: Array<{ operation: string; input: Record<string, unknown>; key?: string }> = [];
	const lifecycle = new sdkLifecycle.SessionLifecycleService({
		global: async (operation, input, requestOptions) => {
			lifecycleCalls.push({ operation, input, key: requestOptions.idempotencyKey });
			if (operation === "session.list" && options.missingSavedSession)
				return { ok: true, result: { indexSeq: 1, sessions: [], warnings: [] } };
			if (operation === "session.list")
				return {
					ok: true,
					result: {
						indexSeq: 1,
						sessions: [],
						warnings: [],
						savedSession: {
							id,
							path: file,
							identity: {
								dev: identity.dev.toString(),
								ino: identity.ino.toString(),
								nlink: (identity.nlink ?? 1n).toString(),
								size: identity.size,
								mtimeMs: identity.mtimeMs,
								mtimeNs: identity.mtimeNs.toString(),
								ctimeNs: (identity.ctimeNs ?? 1n).toString(),
								sha256: identity.sha256,
							},
						},
					},
				};
			if (operation === "session.resume")
				return {
					ok: true,
					result: {
						sessionId: id,
						cwd,
						endpointGeneration: generation,
						endpointIncarnation: options.wrongAuthority ? "f".repeat(64) : binding,
						reused: true,
					},
				};
			throw new Error(`Unexpected lifecycle ${operation}`);
		},
	});
	const journal = new DeliveryJournal(directory);
	await journal.initialize();
	let router!: sdkRouter.SessionRouter;
	let controlEpoch = generation - 1;
	const projectId = crypto.randomUUID();
	const adapters: ManagedSession[] = [];
	const completions: Array<{ turnId: string; desktopEpoch: number }> = [];
	const createAdapter = () => {
		const value = new ManagedSession({
			agentDir,
			cwd,
			id,
			projectId,
			title: "Cached title",
			starred: false,
			nextControlGeneration: () => ++controlEpoch,
			onTaskCompleted: (turnId, desktopEpoch) => {
				completions.push({ turnId, desktopEpoch });
			},
			lifecycle,
			redact: text => text,
			onChange: () => {},
			delivery: (deliveryId, change) => journal.update(deliveryId, change),
			createRouter: onFrame => {
				router = authority.createRouter(onFrame);
				return router;
			},
		});
		adapters.push(value);
		return value;
	};
	const adapter = createAdapter();
	cleanups.push(async () => {
		for (const value of adapters) await value.close();
		await modelQueries?.close();
		disposeFrames?.();
		await transport.stop();
		await fs.rm(directory, { recursive: true, force: true });
	});
	if (options.open !== false) await adapter.open();
	return {
		adapter,
		createAdapter,
		journal,
		id,
		controls,
		queries,
		lifecycleCalls,
		get router() {
			return router;
		},
		file,
		transcript,
		transport,
		completions,
		receipts,
		entries,
		setGate: (value: boolean) => {
			pendingGate = value;
		},
		complete: () => {
			for (const [key, value] of receipts)
				receipts.set(key, {
					...value,
					kind: "prompt",
					status: "terminal_ok",
					receiptState: "present",
					outcome: { kind: "stopped", reason: "end_turn", provenance: "agent" },
					content: { version: 1, type: "text", text: "done", byteLength: 4, truncated: false },
				});
			idle = true;
		},
		emit: async () => {
			seq++;
			await Promise.all(
				[...connections].map(connectionId =>
					transport.sendFrame(connectionId, {
						type: "event",
						generation,
						seq,
						payload: { type: "agent_end", sessionId: id },
					}),
				),
			);
		},
	};
}

test("refuses a missing exact saved reference before resume and a replaced owner before any input", async () => {
	const missing = await fixture({ open: false, missingSavedSession: true });
	await expect(missing.adapter.open()).rejects.toThrow("SDK session is unavailable");
	expect(missing.lifecycleCalls.map(call => call.operation)).toEqual(["session.list"]);
	const replaced = await fixture({ open: false, wrongAuthority: true });
	await expect(replaced.adapter.open()).rejects.toThrow("SDK owner changed during resume");
	expect(replaced.controls).toEqual([]);
	expect(await Bun.file(replaced.file).text()).toBe(replaced.transcript);
});

test("resumes through SDK identity authority and reads an owned endpoint without touching its transcript", async () => {
	const h = await fixture();
	expect(h.lifecycleCalls.map(call => call.operation)).toEqual(["session.list", "session.resume"]);
	expect(h.lifecycleCalls[1]?.input).toMatchObject({ sessionId: h.id, sessionPath: h.file });
	expect(h.lifecycleCalls[1]?.key).toBeTruthy();
	expect(h.adapter.dto()).toMatchObject({ id: h.id, title: "Original terminal title", status: "done" });
	expect(h.adapter.history(0, 20).messages[0]?.text).toBe("Existing terminal transcript");
	expect(await Bun.file(h.file).text()).toBe(h.transcript);
	expect(JSON.stringify(h.adapter.dto())).not.toContain(h.file);
	await h.adapter.close();
	// Desktop teardown only detaches. The original owner's transport remains live.
	expect((await h.transport.start()).url).toMatch(/^ws:/);
	expect(h.controls).toEqual([]);
});

test("routes prompt, steer, follow-up and abort with correlated durable delivery receipts", async () => {
	const h = await fixture();
	for (const [id, deliverAs] of [
		["prompt-ref", undefined],
		["steer-ref", "steer"],
		["follow-ref", "followUp"],
	] as const) {
		await h.journal.begin(id, h.id);
		await h.adapter.prompt(id, id, deliverAs);
	}
	expect(h.controls.map(control => control.operation)).toEqual(["turn.prompt", "turn.steer", "turn.follow_up"]);
	expect(h.controls[0]?.input.clientRef).toBe("prompt-ref");
	expect(h.journal.list().find(receipt => receipt.id === "steer-ref")?.disposition).toBe("accepted");
	h.complete();
	await h.emit();
	const deadline = Date.now() + 5_000;
	while (h.journal.list().some(receipt => receipt.id !== "steer-ref" && receipt.disposition !== "completed")) {
		if (Date.now() >= deadline) throw new Error("Owned event did not reconcile desktop receipts");
		await Bun.sleep(10);
	}
	expect(h.controls).toHaveLength(3);
	expect(h.journal.list().map(receipt => receipt.disposition)).toEqual(["completed", "accepted", "completed"]);
	await h.adapter.control("turn.abort");
	expect(h.controls.at(-1)?.operation).toBe("turn.abort");
	await h.journal.ack("prompt-ref");
	expect(h.journal.hasAcknowledged("prompt-ref")).toBe(true);
});

test("distinguishes pre-send refusal and uncertain handoff without resubmitting", async () => {
	const h = await fixture();
	const original = h.router.request.bind(h.router);
	let sends = 0;
	const request = vi
		.spyOn(h.router, "request")
		.mockImplementation(async (id, frame, generation, attachment, options) => {
			if (frame.type !== "control_request") return original(id, frame, generation, attachment, options);
			sends++;
			if (sends === 1) throw new sdkRouter.SessionRouterError("pre_send");
			options?.onDispatch?.({ frame, generation: generation ?? 7, connectionId: attachment?.connectionId });
			throw new Error("Fixture disconnected after SDK handoff");
		});
	await h.journal.begin("not-sent", h.id);
	await expect(h.adapter.prompt("not-sent", "First", undefined)).rejects.toThrow();
	await h.journal.begin("uncertain", h.id);
	await expect(h.adapter.prompt("uncertain", "Second", undefined)).rejects.toThrow();
	request.mockRestore();
	await h.adapter.refresh();
	expect(sends).toBe(2);
	expect(h.controls).toEqual([]);
	expect(h.journal.list().map(receipt => receipt.disposition)).toEqual(["refused", "unknown"]);
});

for (const mode of ["missing", "malformed", "error", "refused", "missing-correlation", "empty-correlation"] as const) {
	for (const delivery of ["prompt", "steer", "followUp"] as const) {
		test(`${delivery} ${mode} acknowledgement never invents refusal or resubmits`, async () => {
			const h = await fixture({ idle: delivery === "prompt" });
			const original = h.router.request.bind(h.router);
			const request = vi
				.spyOn(h.router, "request")
				.mockImplementation(async (id, frame, generation, attachment, options) => {
					if (frame.type !== "control_request") return original(id, frame, generation, attachment, options);
					if (mode === "refused") {
						options?.onDispatch?.({ frame, generation: generation ?? 7, connectionId: attachment?.connectionId });
						return { ok: true, result: { accepted: false } };
					}
					const response = await original(id, frame, generation, attachment, options);
					if (mode === "error") return { ...response, ok: false, error: { code: "persistence_failed" } };
					if (mode === "missing-correlation") return { ...response, result: { accepted: true } };
					if (mode === "empty-correlation")
						return { ...response, result: { accepted: true, commandId: " ", turnId: "" } };
					return { ...response, result: mode === "missing" ? undefined : { accepted: "yes" } };
				});
			try {
				await h.journal.begin("ack-case", h.id);
				const sending = h.adapter.prompt(
					"ack-case",
					"Do not duplicate",
					delivery === "prompt" ? undefined : delivery,
				);
				if (mode === "refused" || delivery === "followUp")
					await expect(sending).rejects.toThrow(
						mode === "refused"
							? "SDK input refused"
							: mode === "error"
								? "persistence_failed"
								: mode === "missing-correlation" || mode === "empty-correlation"
									? "receipt identity was not confirmed"
									: "admission was not confirmed",
					);
				else await sending;
				const disposition = mode === "refused" ? "refused" : delivery === "followUp" ? "unknown" : "accepted";
				expect(h.journal.list().find(receipt => receipt.id === "ack-case")?.disposition).toBe(disposition);
				expect(h.controls).toHaveLength(mode === "refused" ? 0 : 1);
				await h.adapter.refresh();
				expect(h.controls).toHaveLength(mode === "refused" ? 0 : 1);
				expect(h.journal.list().find(receipt => receipt.id === "ack-case")?.disposition).toBe(disposition);
			} finally {
				request.mockRestore();
			}
		});
	}
}

test("pins controls across router reconciliation and only rebinds them after a new snapshot", async () => {
	const h = await fixture();
	const attachment = h.router.attachment(h.id);
	if (!attachment?.retire) throw new Error("Fixture SDK attachment cannot retire");
	const retire = attachment.retire;
	const original = h.router.request.bind(h.router);
	// Keep automatic display refresh from rebinding during the stale-control
	// assertions; an explicit successful query below is the rebind boundary.
	const refresh = vi.spyOn(h.adapter, "refresh").mockResolvedValue(undefined);
	let retireBeforeDispatch = true;
	const request = vi.spyOn(h.router, "request").mockImplementation(async (id, frame, generation, pinned, options) => {
		if (frame.type === "control_request" && retireBeforeDispatch) {
			retireBeforeDispatch = false;
			await retire();
		}
		return original(id, frame, generation, pinned, options);
	});
	try {
		// Router reconciliation may find a same-generation, same-authority new
		// connection. The captured lease must still fail its beforeDispatch fence.
		await expect(h.adapter.setModel("fixture/model", "low")).rejects.toThrow();
		expect(attachment.isCurrent()).toBe(false);
		const replacement = h.router.attachment(h.id);
		expect(replacement?.isCurrent()).toBe(true);
		expect(replacement).not.toBe(attachment);
		expect(replacement?.generation).toBe(attachment.generation);
		await expect(h.adapter.setThinking("high")).rejects.toThrow("SDK owner changed");
		await expect(h.adapter.control("turn.abort")).rejects.toThrow("SDK owner changed");
		await h.journal.begin("retired-owner", h.id);
		await expect(h.adapter.prompt("retired-owner", "Do not replay", undefined)).rejects.toThrow("SDK owner changed");
		expect(h.controls).toEqual([]);
		expect(h.journal.list().find(receipt => receipt.id === "retired-owner")?.disposition).toBe("refused");
		expect(h.adapter.dto().controlGeneration).toBeNull();
	} finally {
		request.mockRestore();
		refresh.mockRestore();
	}
	await h.adapter.refresh();
	// The SDK's counter did not change, but an old rendered token must no longer match.
	expect(h.router.attachment(h.id)?.generation).toBe(attachment.generation);
	expect(h.adapter.dto().controlGeneration).toBe(attachment.generation + 1);
	const reboundGeneration = h.adapter.controlGeneration;
	await h.adapter.refresh();
	expect(h.adapter.controlGeneration).toBe(reboundGeneration);
	await h.adapter.setModel("fixture/model", "low");
	await h.adapter.setThinking("high");
	await h.journal.begin("current-owner", h.id);
	await h.adapter.prompt("current-owner", "Current owner input", undefined);
	await h.adapter.control("turn.abort");
	expect(h.controls.map(control => control.operation)).toEqual([
		"model.set",
		"thinking.set",
		"turn.prompt",
		"turn.abort",
	]);
	expect(h.journal.list().find(receipt => receipt.id === "current-owner")?.disposition).toBe("accepted");
	expect(await Bun.file(h.file).text()).toBe(h.transcript);
});

test("reopening rotates the desktop epoch even when the SDK endpoint generation is unchanged", async () => {
	const h = await fixture();
	const before = h.adapter.controlGeneration;
	if (before === null) throw new Error("Missing rendered control generation");
	await h.adapter.close();
	const reopened = h.createAdapter();
	await reopened.open();
	expect(reopened.controlGeneration).toBe(before + 1);
	expect(reopened.dto().id).toBe(h.id);
	await reopened.setModel("fixture/model", "low");
	expect(h.controls.map(control => control.operation)).toEqual(["model.set"]);
	expect(await Bun.file(h.file).text()).toBe(h.transcript);
});

test("decodes oversized model fields from real SDK Q10/Q23 pages without stringifying booleans or thinking metadata", async () => {
	const h = await fixture({ pagedModels: true });
	const catalog = h.adapter.models();
	expect(h.queries).toContain("resource.body");
	expect(catalog).toHaveLength(2);
	expect(catalog[0]).toMatchObject({
		id: "fixture/unused",
		contextWindow: 48000,
		reasoning: false,
		thinking: { options: [] },
	});
	expect(catalog[1]).toMatchObject({ id: "fixture/model", contextWindow: 10000, reasoning: true });
	expect(catalog[0]?.name).toBe("false".repeat(60_000));
	expect(h.adapter.dto().model).toBe("fixture/model");
	await h.adapter.setThinking("high");
	expect(h.adapter.dto().thinking?.level).toBe("high");
	expect(h.controls.map(control => control.operation)).toEqual(["thinking.set"]);
});

test("notifies prompt and follow-up terminal success once, never admission or steer acknowledgement", async () => {
	const h = await fixture();
	const epoch = h.adapter.controlGeneration;
	if (epoch === null) throw new Error("Missing captured Desktop epoch");
	for (const [id, mode] of [
		["prompt", undefined],
		["steer", "steer"],
		["follow-up", "followUp"],
	] as const) {
		await h.journal.begin(id, h.id);
		await h.adapter.prompt(id, "private user text", mode);
	}
	expect(h.completions).toEqual([]);
	h.complete();
	await h.adapter.refresh();
	const promptTurnId = h.receipts.get("prompt")?.turnId;
	const followUpTurnId = h.receipts.get(
		h.journal.list().find(item => item.id === "follow-up")!.sdkSubmissionId!,
	)?.turnId;
	if (typeof promptTurnId !== "string" || typeof followUpTurnId !== "string")
		throw new Error("Missing fixture turn identity");
	expect(h.completions).toEqual([
		{ turnId: promptTurnId, desktopEpoch: epoch },
		{ turnId: followUpTurnId, desktopEpoch: epoch },
	]);
	await h.adapter.refresh();
	await h.emit();
	await h.adapter.refresh();
	expect(h.completions).toHaveLength(2);
	expect(JSON.stringify(h.completions)).not.toContain("private user text");
	expect(h.journal.list().find(item => item.id === "steer")?.disposition).toBe("accepted");
});

for (const status of ["accepted", "rejected", "uncertain", "unknown"] as const) {
	test(`Q31 steer ${status} is never actual-turn completion`, async () => {
		const h = await fixture({ idle: false });
		const original = h.router.request.bind(h.router);
		const request = vi.spyOn(h.router, "request").mockImplementation((id, frame, generation, attachment, options) => {
			if (frame.type === "query_request" && frame.query === "turn.steer_status")
				return Promise.resolve({ type: "query_response", id: frame.id, ok: true, result: { status } });
			return original(id, frame, generation, attachment, options);
		});
		try {
			await h.journal.begin("steer-status", h.id);
			await h.adapter.prompt("steer-status", "steer only", "steer");
			await h.adapter.refresh();
			expect(h.completions).toEqual([]);
			expect(h.journal.list().find(item => item.id === "steer-status")?.disposition).toBe(
				status === "rejected" ? "failed" : "accepted",
			);
			expect(h.controls.map(control => control.operation)).toEqual(["turn.steer"]);
		} finally {
			request.mockRestore();
		}
	});
}

test("rearms pending prompt reconciliation without another SDK event and stops at terminal", async () => {
	const h = await fixture();
	await h.journal.begin("poll", h.id);
	await h.adapter.prompt("poll", "poll without replay", undefined);
	expect(h.completions).toEqual([]);
	h.complete();
	const deadline = Date.now() + 3_000;
	while (!h.completions.length) {
		if (Date.now() >= deadline) throw new Error("Pending completion was not polled");
		await Bun.sleep(10);
	}
	expect(h.completions).toHaveLength(1);
	const queries = h.queries.filter(query => query === "turn.result").length;
	expect(queries).toBeLessThan(6);
	await Bun.sleep(600);
	expect(h.queries.filter(query => query === "turn.result")).toHaveLength(queries);
	expect(h.controls).toHaveLength(1);
});

test("retains notification intent after terminal clientRef recovery loses its exact-ID query", async () => {
	const h = await fixture();
	const original = h.router.request.bind(h.router);
	let failedExactQuery = false;
	const update = vi.spyOn(h.journal, "update");
	const request = vi
		.spyOn(h.router, "request")
		.mockImplementation(async (id, frame, generation, attachment, options) => {
			const response = await original(id, frame, generation, attachment, options);
			if (frame.type === "control_request" && frame.operation === "turn.prompt") {
				h.complete();
				return { ...response, result: { accepted: true } };
			}
			if (
				frame.type === "query_request" &&
				frame.query === "turn.result" &&
				typeof (frame.input as Record<string, unknown>).commandId === "string" &&
				!failedExactQuery
			) {
				failedExactQuery = true;
				throw new Error("Transient exact-ID read failure");
			}
			return response;
		});
	try {
		await h.journal.begin("retry-proof", h.id);
		await h.adapter.prompt("retry-proof", "never replay this prompt", undefined);
		expect(failedExactQuery).toBe(true);
		expect(h.completions).toEqual([]);
		expect(h.journal.list().find(item => item.id === "retry-proof")?.disposition).toBe("completed");
		await h.adapter.refresh();
		expect(h.completions).toHaveLength(1);
		expect(update.mock.calls.filter(([, change]) => change.disposition === "completed")).toHaveLength(1);
		expect(h.controls).toHaveLength(1);
	} finally {
		request.mockRestore();
		update.mockRestore();
	}
});

for (const missing of ["content", "outcome", "both"] as const) {
	test(`polls terminal delivery for late ${missing} enrichment without rewriting its receipt`, async () => {
		const h = await fixture();
		const original = h.router.request.bind(h.router);
		let enriched = false;
		const update = vi.spyOn(h.journal, "update");
		const request = vi
			.spyOn(h.router, "request")
			.mockImplementation(async (id, frame, generation, attachment, options) => {
				const response = await original(id, frame, generation, attachment, options);
				if (frame.type === "query_request" && frame.query === "turn.result" && !enriched) {
					const result = { ...(response.result as Record<string, unknown>) };
					if (result.status === "terminal_ok") {
						if (missing !== "outcome") {
							delete result.content;
							result.receiptState = "absent";
						}
						if (missing !== "content") delete result.outcome;
						return { ...response, result };
					}
				}
				return response;
			});
		try {
			await h.journal.begin("late-proof", h.id);
			await h.adapter.prompt("late-proof", "await SDK proof", undefined);
			h.complete();
			await h.adapter.refresh();
			expect(h.completions).toEqual([]);
			expect(h.journal.list().find(item => item.id === "late-proof")?.disposition).toBe("completed");
			enriched = true;
			const deadline = Date.now() + 3_000;
			while (!h.completions.length) {
				if (Date.now() >= deadline) throw new Error("Late completion evidence was not polled");
				await Bun.sleep(10);
			}
			expect(h.completions).toHaveLength(1);
			await h.adapter.refresh();
			expect(update.mock.calls.filter(([, change]) => change.disposition === "completed")).toHaveLength(1);
			expect(h.controls).toHaveLength(1);
		} finally {
			request.mockRestore();
			update.mockRestore();
		}
	});
}

test("deduplicates repeated confirmations of one public managed SDK turn", async () => {
	const h = await fixture({ idle: false });
	const epoch = h.adapter.controlGeneration;
	if (epoch === null) throw new Error("Missing captured Desktop epoch");
	const original = h.router.request.bind(h.router);
	const turnId = crypto.randomUUID();
	const request = vi
		.spyOn(h.router, "request")
		.mockImplementation(async (id, frame, generation, attachment, options) => {
			const response = await original(id, frame, generation, attachment, options);
			if (frame.type === "control_request" && frame.operation === "turn.follow_up") {
				const result = response.result as Record<string, unknown>;
				const commandId = String(result.commandId);
				const receipt = { status: "in_flight", commandId, turnId };
				h.receipts.set(commandId, receipt);
				return { ...response, result: { ...result, turnId } };
			}
			return response;
		});
	try {
		for (const id of ["first", "second"]) {
			await h.journal.begin(id, h.id);
			await h.adapter.prompt(id, id, "followUp");
		}
		h.complete();
		await h.adapter.refresh();
		expect(h.completions).toEqual([{ turnId, desktopEpoch: epoch }]);
		expect(h.journal.list().map(item => item.disposition)).toEqual(["completed", "completed"]);
	} finally {
		request.mockRestore();
	}
});

for (const mode of [
	"unknown",
	"accepted",
	"in_flight",
	"failed",
	"rejected",
	"missing-command",
	"missing-turn",
	"empty-command",
	"empty-turn",
	"wrong-command",
	"wrong-turn",
	"wrong-kind",
	"malformed",
	"cancelled",
	"max_tokens",
	"max_turn_requests",
	"refusal",
	"client-cancel",
	"missing-receipt",
	"unknown-receipt",
	"missing-outcome",
	"failed-outcome",
	"late-error",
	"no-content",
	"blank-content",
	"legacy-content",
	"wrong-content-type",
] as const) {
	test(`does not notify an unproven managed result: ${mode}`, async () => {
		const h = await fixture();
		await h.journal.begin("result", h.id);
		await h.adapter.prompt("result", "input", undefined);
		h.complete();
		for (const [key, receipt] of h.receipts) {
			const result: Record<string, unknown> = { ...receipt, status: "terminal_ok" };
			if (["unknown", "accepted", "in_flight", "failed", "rejected"].includes(mode)) result.status = mode;
			if (mode === "missing-command") delete result.commandId;
			if (mode === "missing-turn") delete result.turnId;
			if (mode === "empty-command") result.commandId = " ";
			if (mode === "empty-turn") result.turnId = " ";
			if (mode === "wrong-command") result.commandId = crypto.randomUUID();
			if (mode === "wrong-turn") result.turnId = crypto.randomUUID();
			if (mode === "wrong-kind") result.kind = "skill";
			if (mode === "malformed") result.status = "completed";
			if (["cancelled", "max_tokens", "max_turn_requests", "refusal"].includes(mode))
				result.outcome = { kind: "stopped", reason: mode, provenance: "agent" };
			if (mode === "client-cancel")
				result.outcome = { kind: "stopped", reason: "end_turn", provenance: "client_cancel" };
			if (mode === "missing-receipt") result.receiptState = "missing";
			if (mode === "unknown-receipt") result.receiptState = "unknown";
			if (mode === "missing-outcome") delete result.outcome;
			if (mode === "failed-outcome")
				result.outcome = { kind: "failed", code: "prompt_failed", provenance: "agent_failed" };
			if (mode === "late-error") result.error = { code: "prompt_failed", message: "Late failure" };
			if (mode === "no-content") delete result.content;
			if (mode === "blank-content") result.content = { version: 1, type: "text", text: "  \n" };
			if (mode === "legacy-content") result.content = { type: "text", text: "legacy answer" };
			if (mode === "wrong-content-type") result.content = { version: 1, type: "image", text: "not text proof" };
			h.receipts.set(key, result);
		}
		await h.adapter.refresh();
		expect(h.completions).toEqual([]);
		expect(h.controls).toHaveLength(1);
	});
}

test("does not infer completion from history, idle snapshots, events, or steer terminal-shaped data", async () => {
	const h = await fixture();
	h.entries.push({ id: "historical-success", role: "assistant", body: "historical answer", stopReason: "stop" });
	await h.emit();
	await h.adapter.refresh();
	expect(h.adapter.dto().status).toBe("done");
	expect(h.completions).toEqual([]);
	await h.adapter.close();
	const reopened = h.createAdapter();
	await reopened.open();
	expect(h.completions).toEqual([]);
	// Q31 acknowledges steering; even terminal-looking malformed data cannot prove its turn ended.
	await h.journal.begin("start", h.id);
	await reopened.prompt("start", "start", undefined);
	await h.journal.begin("steer-only", h.id);
	await reopened.prompt("steer-only", "steer", "steer");
	const original = h.router.request.bind(h.router);
	const request = vi
		.spyOn(h.router, "request")
		.mockImplementation(async (id, frame, generation, attachment, options) => {
			if (frame.type === "query_request" && frame.query === "turn.steer_status")
				return {
					type: "query_response",
					id: frame.id,
					ok: true,
					result: { status: "terminal_ok", commandId: "steer-command", turnId: "steer-turn" },
				};
			return original(id, frame, generation, attachment, options);
		});
	try {
		await reopened.refresh();
		expect(h.completions).toEqual([]);
		expect(h.journal.list().find(item => item.id === "steer-only")?.disposition).toBe("accepted");
	} finally {
		request.mockRestore();
	}
});

for (const mode of ["missing-identities", "lost-acknowledgement"] as const) {
	test(`clientRef ${mode} establishes exact identities before completion proof`, async () => {
		const h = await fixture();
		const original = h.router.request.bind(h.router);
		const selectors: Record<string, unknown>[] = [];
		const request = vi
			.spyOn(h.router, "request")
			.mockImplementation(async (id, frame, generation, attachment, options) => {
				const response = await original(id, frame, generation, attachment, options);
				if (frame.type === "control_request" && frame.operation === "turn.prompt") {
					if (mode === "lost-acknowledgement") throw new Error("Acknowledgement lost after handoff");
					return { ...response, result: { accepted: true } };
				}
				if (frame.type === "query_request" && frame.query === "turn.result")
					selectors.push(frame.input as Record<string, unknown>);
				return response;
			});
		try {
			await h.journal.begin("recover", h.id);
			await h.adapter.prompt("recover", "never replay", undefined);
			expect(h.completions).toEqual([]);
			h.complete();
			await h.adapter.refresh();
			const receipt = h.receipts.get("recover")!;
			const epoch = h.adapter.controlGeneration;
			if (epoch === null || typeof receipt.turnId !== "string")
				throw new Error("Missing confirmed completion identity");
			expect(selectors[0]).toEqual({ kind: "prompt", clientRef: "recover" });
			expect(selectors.at(-1)).toEqual({ kind: "prompt", commandId: receipt.commandId, turnId: receipt.turnId });
			expect(h.completions).toEqual([{ turnId: receipt.turnId, desktopEpoch: epoch }]);
			expect(h.controls).toHaveLength(1);
		} finally {
			request.mockRestore();
		}
	});
}

test("never transfers pending completion to a replacement attachment, including replacement during the result query", async () => {
	const h = await fixture();
	await h.journal.begin("retiring", h.id);
	await h.adapter.prompt("retiring", "old owner", undefined);
	const attachment = h.router.attachment(h.id);
	if (!attachment?.retire) throw new Error("Fixture attachment cannot retire");
	const before = h.adapter.controlGeneration;
	h.complete();
	const original = h.router.request.bind(h.router);
	let replaced = false;
	const request = vi.spyOn(h.router, "request").mockImplementation(async (id, frame, generation, pinned, options) => {
		const response = await original(id, frame, generation, pinned, options);
		if (!replaced && frame.type === "query_request" && frame.query === "turn.result") {
			replaced = true;
			await attachment.retire!();
			await h.router.reconcile();
		}
		return response;
	});
	try {
		await expect(h.adapter.refresh()).rejects.toThrow("completion owner changed");
	} finally {
		request.mockRestore();
	}
	expect(replaced).toBe(true);
	expect(h.completions).toEqual([]);
	await h.adapter.refresh();
	expect(h.adapter.controlGeneration).not.toBe(before);
	expect(h.completions).toEqual([]);
	expect(h.controls).toHaveLength(1);
});

test("closing during a terminal query suppresses its callback", async () => {
	const h = await fixture();
	await h.journal.begin("closing", h.id);
	await h.adapter.prompt("closing", "close while querying", undefined);
	h.complete();
	const original = h.router.request.bind(h.router);
	let closing: Promise<void> | undefined;
	const request = vi
		.spyOn(h.router, "request")
		.mockImplementation(async (id, frame, generation, attachment, options) => {
			const response = await original(id, frame, generation, attachment, options);
			if (frame.type === "query_request" && frame.query === "turn.result") closing = h.adapter.close();
			return response;
		});
	try {
		await expect(h.adapter.refresh()).rejects.toThrow("completion owner changed");
		await closing;
		expect(h.completions).toEqual([]);
	} finally {
		request.mockRestore();
	}
});

test("projects owner models and preserves waiting gates without pretending desktop interaction is supported", async () => {
	const h = await fixture();
	expect(h.adapter.models()[0]?.id).toBe("fixture/model");
	await h.adapter.setModel("fixture/model", "low");
	await h.adapter.setThinking("high");
	expect(h.adapter.dto().thinking?.level).toBe("high");
	await expect(h.adapter.setThinking("minimal")).rejects.toThrow("Unsupported thinking");
	h.setGate(true);
	await h.adapter.refresh();
	expect(h.adapter.dto().status).toBe("waiting");
	expect(h.adapter.dto().error).toContain("original control surface");
});
