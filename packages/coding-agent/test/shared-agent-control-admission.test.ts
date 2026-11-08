import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { Agent, type AgentTool, ThinkingLevel } from "@gajae-code/agent-core";
import { getBundledModel } from "@gajae-code/ai/models";
import { createMockModel } from "@gajae-code/ai/providers/mock";
import * as z from "zod/v4";
import { ModelRegistry } from "../src/config/model-registry";
import { Settings } from "../src/config/settings";
import { initializeLocalRoot } from "../src/internal-urls/local-protocol";
import { AgentSession } from "../src/session/agent-session";
import { AuthStorage } from "../src/session/auth-storage";
import { SessionManager, SharedSessionMutationUnsupportedError } from "../src/session/session-manager";

const roots: string[] = [];
const sessions: AgentSession[] = [];
const managers: SessionManager[] = [];
const stores: AuthStorage[] = [];
const user = (text: string) => ({ role: "user" as const, content: text, timestamp: 1 });

afterEach(async () => {
	vi.restoreAllMocks();
	for (const session of sessions.splice(0)) await session.dispose();
	for (const manager of managers.splice(0)) await manager.closeStrict();
	for (const store of stores.splice(0)) store.close();
	for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});

async function fixture(durableSettings = false, rootInteractiveSharedAppend = false, streamFn?: Agent["streamFn"]) {
	const root = await fs.mkdtemp(path.join(import.meta.dirname, ".tmp-shared-controls-"));
	roots.push(root);
	const cwd = path.join(root, "workspace");
	const agentDir = path.join(root, "agent");
	await fs.mkdir(cwd, { recursive: true });
	await fs.mkdir(agentDir, { recursive: true, mode: 0o700 });
	const destination = SessionManager.managedDestination(cwd, agentDir);
	const manager = SessionManager.create(cwd, destination);
	managers.push(manager);
	const first = manager.appendMessage(user("first"));
	manager.appendMessage(user("second"));
	await manager.ensureOnDisk();
	await manager.flush();
	const file = manager.getSessionFile()!;
	const auth = await AuthStorage.create(path.join(root, "auth.db"));
	stores.push(auth);
	auth.setRuntimeApiKey("anthropic", "test-key");
	const registry = new ModelRegistry(auth);
	const model = getBundledModel("anthropic", "claude-sonnet-4-5");
	if (!model) throw new Error("Missing bundled model");
	const execute = vi.fn(async () => ({ content: [{ type: "text" as const, text: "executed" }] }));
	const tool: AgentTool = {
		name: "control_fixture",
		label: "Control fixture",
		description: "Control admission fixture",
		parameters: z.object({}),
		execute,
	};
	const settings = durableSettings
		? await Settings.loadForScope({ cwd, agentDir })
		: Settings.isolated({ "compaction.enabled": false, "todo.reminders": false });
	const agent = new Agent({
		initialState: { model, systemPrompt: ["Test"], tools: [tool], messages: [] },
		...(streamFn ? { streamFn, getApiKey: () => "test-key" } : {}),
	});
	const rebuild = vi.fn(async () => ({ systemPrompt: ["Rebuilt"] }));
	const session = new AgentSession({
		agent,
		sessionManager: manager,
		settings,
		modelRegistry: registry,
		toolRegistry: new Map([[tool.name, tool]]),
		rebuildSystemPrompt: rebuild,
		rootInteractiveSharedAppend,
	});
	sessions.push(session);
	await manager.flush();
	const admit = async () => {
		const sibling = await SessionManager.open(file, destination);
		managers.push(sibling);
		const peerResult = await sibling.appendMessageSharingSession(user("peer"));
		if (peerResult.kind !== "committed") throw new Error(peerResult.kind);
		const result = await manager.appendMessageSharingSession(user("local"));
		if (result.kind !== "committed") throw new Error(result.kind);
	};
	return {
		session,
		manager,
		agent,
		settings,
		registry,
		model,
		first,
		file,
		admit,
		execute,
		rebuild,
		cwd,
		agentDir,
		destination,
	};
}

function holdSnapshot(manager: SessionManager, onRead = 1) {
	const entered = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	const capture = manager.captureCommittedSnapshot.bind(manager);
	let reads = 0;
	vi.spyOn(manager, "captureCommittedSnapshot").mockImplementation(async () => {
		if (++reads === onRead) {
			entered.resolve();
			await release.promise;
		}
		return capture();
	});
	return { entered: entered.promise, release: () => release.resolve() };
}

async function withHeldCleanup(
	body: () => Promise<void>,
	release: () => void,
	pending: () => Array<Promise<unknown> | undefined>,
	phase: string,
): Promise<void> {
	let cleanupFailure: unknown;
	try {
		await body();
	} finally {
		release();
		try {
			await withinBarrier(Promise.allSettled(pending().filter(Boolean)), phase);
		} catch (error) {
			cleanupFailure = error;
		}
	}
	if (cleanupFailure !== undefined) throw cleanupFailure;
}

async function withinBarrier<T>(pending: Promise<T>, phase: string): Promise<T> {
	const deadline = Promise.withResolvers<never>();
	const timer = setTimeout(() => deadline.reject(new Error(`Timed out waiting for ${phase}`)), 1500);
	try {
		return await Promise.race([pending, deadline.promise]);
	} finally {
		clearTimeout(timer);
	}
}

function observeControl(pending: Promise<void>) {
	return pending.then(
		() => ({ kind: "fulfilled" as const }),
		error => ({ kind: "rejected" as const, error }),
	);
}

function snapshot(session: AgentSession) {
	return structuredClone({
		model: session.model,
		thinking: session.thinkingLevel,
		agentThinking: session.agent.state.thinkingLevel,
		tier: session.serviceTier,
		tools: session.getActiveToolNames(),
		prompt: session.agent.state.systemPrompt,
		messages: session.agent.state.messages,
		profile: session.getActiveModelProfile(),
		selectionRevision: session.getUserModelSelectionRevision(),
		modelRoles: session.settings.get("modelRoles"),
		defaultThinking: session.settings.get("defaultThinkingLevel"),
		manager: {
			revisions: session.sessionManager.revisionSnapshot(),
			entries: session.sessionManager.getEntries(),
			leaf: session.sessionManager.getLeafId(),
		},
	});
}

describe("shared AgentSession control admission", () => {
	it("keeps root interactive local thinking control working after its own first shared append", async () => {
		const f = await fixture(false, true);
		{
			const firstControlPublication = vi.spyOn(f.manager, "appendThinkingLevelChangeSharingSession");
			await withinBarrier(
				f.session.setThinkingLevelForControl(ThinkingLevel.Low, false),
				"first root thinking control",
			);
			expect(firstControlPublication).toHaveBeenCalledTimes(1);
			expect(f.session.thinkingLevel).toBe(ThinkingLevel.Low);
			await f.manager.flush();
			const before = f.manager.getEntries().filter(entry => entry.type === "thinking_level_change").length;
			expect(before).toBe(1);
			expect(
				(await Bun.file(f.file).text()).split("\n").filter(line => line.includes('"type":"thinking_level_change"')),
			).toHaveLength(1);
			const publication = await f.manager.appendMessageSharingSession(user("root first shared append"));
			expect(publication.kind).toBe("committed");
			if (publication.kind !== "committed") throw new Error(`Unexpected shared outcome: ${publication.kind}`);
			await withinBarrier(f.session.setThinkingLevelForControl(ThinkingLevel.High, false), "root thinking control");
			expect(f.session.thinkingLevel).toBe(ThinkingLevel.High);
			expect(f.agent.state.thinkingLevel).toBe(ThinkingLevel.High);
			await f.manager.flush();
			const entries = (await Bun.file(f.file).text())
				.trim()
				.split("\n")
				.map(
					line =>
						JSON.parse(line) as {
							type?: string;
							id?: string;
							parentId?: string | null;
							thinkingLevel?: string;
							operatorIntent?: boolean;
						},
				);
			const thinking = entries.filter(entry => entry.type === "thinking_level_change");
			expect(f.session.getThinkingScopeForControl()).toBe("session");
			expect(thinking).toHaveLength(before + 1);
			expect(thinking.at(-1)).toMatchObject({
				thinkingLevel: ThinkingLevel.High,
				operatorIntent: true,
				parentId: publication.id,
			});
		}
	});

	it("cycles root thinking after shared admission with one committed local intent", async () => {
		const f = await fixture(false, true);
		const anchor = await f.manager.appendMessageSharingSession(user("shared"));
		expect(anchor.kind).toBe("committed");
		const levels = [ThinkingLevel.Off, ...f.session.getAvailableThinkingLevels()];
		const current = f.session.thinkingLevel === ThinkingLevel.Inherit ? ThinkingLevel.Off : f.session.thinkingLevel;
		const expected = levels[((current ? levels.indexOf(current) : -1) + 1) % levels.length];
		const next = await f.session.cycleThinkingLevel();
		expect(next).toBe(expected);
		expect(f.session.thinkingLevel).toBe(expected);
		expect(f.agent.state.thinkingLevel ?? ThinkingLevel.Off).toBe(expected);
		await f.manager.flush();
		const entries = f.manager.getBranch().filter(entry => entry.type === "thinking_level_change");
		expect(entries).toEqual([
			expect.objectContaining({
				thinkingLevel: expected,
				operatorIntent: true,
				parentId: anchor.kind === "committed" ? anchor.id : undefined,
			}),
		]);
		expect(
			(await Bun.file(f.file).text()).split("\n").filter(line => line.includes('"type":"thinking_level_change"')),
		).toHaveLength(1);
	});

	it("does not apply a cycle before owned publication settles", async () => {
		const f = await fixture(false, true);
		expect((await f.manager.appendMessageSharingSession(user("shared"))).kind).toBe("committed");
		const held = holdSnapshot(f.manager);
		const before = f.session.thinkingLevel;
		const beforeAgent = f.agent.state.thinkingLevel;
		const cycle = Promise.resolve().then(() => f.session.cycleThinkingLevel());
		const settled = cycle.then(
			value => ({ kind: "fulfilled" as const, value }),
			error => ({ kind: "rejected" as const, error }),
		);
		await withHeldCleanup(
			async () => {
				await withinBarrier(
					Promise.race([
						held.entered,
						settled.then(result => {
							throw new Error(`Cycle settled before publication: ${result.kind}`);
						}),
					]),
					"held cycle publication",
				);
				expect(f.session.thinkingLevel).toBe(before);
				expect(f.agent.state.thinkingLevel).toBe(beforeAgent);
				held.release();
				const result = await withinBarrier(settled, "cycle completion");
				expect(result.kind).toBe("fulfilled");
				if (result.kind === "fulfilled") expect(f.session.thinkingLevel).toBe(result.value);
			},
			held.release,
			() => [settled],
			"cycle cleanup",
		);
	});

	it("propagates a failed shared cycle without changing live thinking or retrying publication", async () => {
		const f = await fixture(false, true);
		expect((await f.manager.appendMessageSharingSession(user("shared"))).kind).toBe("committed");
		const before = f.session.thinkingLevel;
		const bytes = await Bun.file(f.file).text();
		const error = new Error("cycle publication refused");
		const outcome = { kind: "rejected" as const, error };
		const append = vi.spyOn(f.manager, "appendThinkingLevelChangeSharingSession").mockResolvedValue(outcome);
		await expect(Promise.resolve().then(() => f.session.cycleThinkingLevel())).rejects.toMatchObject({
			cause: outcome,
		});
		expect(append).toHaveBeenCalledTimes(1);
		expect(f.session.thinkingLevel).toBe(before);
		expect(await Bun.file(f.file).text()).toBe(bytes);
	});

	it("leaves root persisted thinking on the legacy fail-closed path after shared admission", async () => {
		const f = await fixture(true, true);
		try {
			expect((await f.manager.appendMessageSharingSession(user("shared"))).kind).toBe("committed");
			const before = snapshot(f.session);
			const bytes = await Bun.file(f.file).text();
			const append = vi.spyOn(f.manager, "appendThinkingLevelChangeSharingSession");
			await expect(f.session.setThinkingLevelForControl(ThinkingLevel.High, true)).rejects.toBeInstanceOf(
				SharedSessionMutationUnsupportedError,
			);
			expect(append).not.toHaveBeenCalled();
			expect(snapshot(f.session)).toEqual(before);
			expect(await Bun.file(f.file).text()).toBe(bytes);
			expect((await Settings.loadReadonly({ cwd: f.cwd, agentDir: f.agentDir })).get("defaultThinkingLevel")).toBe(
				before.defaultThinking,
			);
		} finally {
			await f.settings.close();
		}
	});

	it("records same-level intent and inherited scope once each after shared admission", async () => {
		const f = await fixture(false, true);
		await f.session.setThinkingLevelForControl(ThinkingLevel.Low, false);
		const admitted = await f.manager.appendMessageSharingSession(user("shared"));
		expect(admitted.kind).toBe("committed");
		await f.session.setThinkingLevelForControl(ThinkingLevel.Low, false);
		expect(f.session.getThinkingScopeForControl()).toBe("session");
		await f.session.setThinkingLevelForControl(ThinkingLevel.Inherit, false);
		await f.manager.flush();
		const entries = f.manager.getBranch().filter(entry => entry.type === "thinking_level_change");
		expect(entries).toHaveLength(3);
		expect(entries[1]).toMatchObject({
			thinkingLevel: ThinkingLevel.Low,
			operatorIntent: true,
			parentId: admitted.kind === "committed" ? admitted.id : undefined,
		});
		expect(entries[2]).toMatchObject({ thinkingLevel: ThinkingLevel.Inherit });
		expect(f.session.getThinkingScopeForControl()).toBe("global config");
	});

	it("holds live thinking behind owned publication while excluding unrelated shared writes", async () => {
		const f = await fixture(false, true);
		const admitted = await f.manager.appendMessageSharingSession(user("shared"));
		expect(admitted.kind).toBe("committed");
		const sibling = await SessionManager.open(f.file, f.destination);
		managers.push(sibling);
		const held = holdSnapshot(f.manager);
		const before = f.session.thinkingLevel;
		const control = f.session.setThinkingLevelForControl(ThinkingLevel.High, false);
		const result = observeControl(control);
		try {
			await withinBarrier(held.entered, "owned thinking publication");
			expect(f.session.thinkingLevel).toBe(before);
			expect(f.agent.state.thinkingLevel).not.toBe(ThinkingLevel.High);
			for (const manager of [f.manager, sibling]) {
				const blocked = await manager.appendMessageSharingSession(user("not owned"));
				expect(blocked).toMatchObject({ kind: "rejected" });
			}
			held.release();
			await withinBarrier(control, "owned thinking completion");
			expect(f.session.thinkingLevel).toBe(ThinkingLevel.High);
			const later = await sibling.appendMessageSharingSession(user("after release"));
			expect(later.kind).toBe("committed");
		} finally {
			held.release();
			await withinBarrier(result, "owned thinking cleanup");
		}
	});

	for (const failure of ["stale", "rejected", "unknown", "acquisition"] as const) {
		it(`reports ${failure} local thinking publication without live update`, async () => {
			const f = await fixture(false, true);
			const admitted = await f.manager.appendMessageSharingSession(user("shared"));
			expect(admitted.kind).toBe("committed");
			const before = f.session.thinkingLevel;
			const bytes = await Bun.file(f.file).text();
			const original = new Error("original thinking publication failure");
			const result =
				failure === "stale"
					? { kind: "stale" as const, reason: "cursor_not_committed" as const }
					: failure === "unknown"
						? { kind: "unknown" as const, id: "thinking-attempt", error: original }
						: { kind: "rejected" as const, error: original };
			const append = vi.spyOn(f.manager, "appendThinkingLevelChangeSharingSession");
			if (failure === "acquisition") append.mockRejectedValue(original);
			else append.mockResolvedValue(result);
			await expect(f.session.setThinkingLevelForControl(ThinkingLevel.High, false)).rejects.toMatchObject({
				message: expect.stringContaining(failure === "unknown" ? "thinking-attempt" : "publication"),
				cause: failure === "acquisition" ? original : result,
			});
			expect(append).toHaveBeenCalledTimes(1);
			expect(f.session.thinkingLevel).toBe(before);
			expect(await Bun.file(f.file).text()).toBe(bytes);
		});
	}

	it("commits a canonical AgentSession message after an owned thinking control releases", async () => {
		const f = await fixture(false, true);
		{
			const initial = await f.manager.appendMessageSharingSession(user("shared"));
			expect(initial.kind).toBe("committed");
			const held = holdSnapshot(f.manager);
			const abort = vi.spyOn(f.agent, "abort");
			const control = f.session.setThinkingLevelForControl(ThinkingLevel.High, false);
			const controlResult = observeControl(control);
			let settlement: Promise<void> | undefined;
			await withHeldCleanup(
				async () => {
					await withinBarrier(held.entered, "owned local thinking publication");
					f.agent.emitExternalEvent({ type: "message_end", message: user("canonical during thinking") });
					settlement = f.session.awaitSessionSettlement();
					void settlement.catch(() => {});
					held.release();
					await withinBarrier(control, "owned thinking control release");
					await withinBarrier(settlement, "canonical message admission after thinking");
					expect(abort).not.toHaveBeenCalled();
					const branch = f.manager.getBranch();
					const thinking = branch.filter(entry => entry.type === "thinking_level_change");
					const canonical = branch.filter(
						entry =>
							entry.type === "message" &&
							entry.message.role === "user" &&
							entry.message.content === "canonical during thinking",
					);
					expect(thinking).toHaveLength(1);
					expect(canonical).toHaveLength(1);
					expect((await Bun.file(f.file).text()).includes('"canonical during thinking"')).toBe(true);
				},
				held.release,
				() => [controlResult, settlement],
				"canonical/control cleanup",
			);
		}
	});

	it("waits for an earlier canonical publication before owning a thinking control", async () => {
		const f = await fixture(false, true);
		expect((await f.manager.appendMessageSharingSession(user("shared"))).kind).toBe("committed");
		const held = holdSnapshot(f.manager);
		f.agent.emitExternalEvent({ type: "message_end", message: user("earlier canonical") });
		const settlement = f.session.awaitSessionSettlement();
		void settlement.catch(() => {});
		let control: Promise<void> | undefined;
		await withHeldCleanup(
			async () => {
				await withinBarrier(held.entered, "earlier canonical publication");
				control = f.session.setThinkingLevelForControl(ThinkingLevel.High, false);
				expect(f.session.thinkingLevel).not.toBe(ThinkingLevel.High);
				held.release();
				await withinBarrier(settlement, "earlier canonical completion");
				await withinBarrier(control, "subsequent thinking control");
				expect(f.session.thinkingLevel).toBe(ThinkingLevel.High);
				const branch = f.manager.getBranch();
				const canonical = branch.find(
					entry =>
						entry.type === "message" &&
						entry.message.role === "user" &&
						entry.message.content === "earlier canonical",
				);
				const thinking = branch.find(entry => entry.type === "thinking_level_change");
				expect(canonical?.type).toBe("message");
				expect(thinking?.parentId).toBe(canonical?.id);
			},
			held.release,
			() => [settlement, control],
			"canonical predecessor cleanup",
		);
	});

	it("discards a thinking invocation whose model changes while an earlier canonical entry holds the lane", async () => {
		const f = await fixture(false, true);
		const replacementModel = getBundledModel("anthropic", "claude-sonnet-4-6");
		if (!replacementModel) throw new Error("Missing replacement model");
		const admission = vi.spyOn(f.manager, "withSharedThinkingControl");
		expect((await f.manager.appendMessageSharingSession(user("shared"))).kind).toBe("committed");
		const held = holdSnapshot(f.manager);
		f.agent.emitExternalEvent({ type: "message_end", message: user("predecessor") });
		const settlement = f.session.awaitSessionSettlement();
		void settlement.catch(() => {});
		let control: Promise<void> | undefined;
		await withHeldCleanup(
			async () => {
				await withinBarrier(held.entered, "predecessor before model change");
				control = f.session.setThinkingLevelForControl(ThinkingLevel.High, false);
				f.agent.setModel(replacementModel);
				held.release();
				await withinBarrier(settlement, "predecessor after model change");
				await withinBarrier(control, "superseded model control");
				expect(admission).not.toHaveBeenCalled();
				expect(f.session.thinkingLevel).not.toBe(ThinkingLevel.High);
				expect(f.manager.getBranch().filter(entry => entry.type === "thinking_level_change")).toHaveLength(0);
			},
			held.release,
			() => [settlement, control],
			"model change cleanup",
		);
	});

	for (const cancelled of [false, true]) {
		it(`defers workflow acceptance metadata while local thinking publication is held (cancelled=${cancelled})`, async () => {
			const mock = createMockModel({ handler: { content: ["workflow complete"] } });
			const f = await fixture(false, true, mock.stream);
			{
				await initializeLocalRoot({
					getSessionId: () => f.manager.getSessionId(),
					getArtifactsDir: () => f.manager.getArtifactsDir(),
					isManagedDestination: () => f.manager.isManagedDestination(),
					getManagedLegacyLocalMigrationSource: () => f.manager.getManagedLegacyLocalMigrationSource(),
				});
				const held = holdSnapshot(f.manager);
				const accepted = Promise.withResolvers<void>();
				const cancellation = new AbortController();
				const control = f.session.setThinkingLevelForControl(ThinkingLevel.High, false);
				const controlResult = observeControl(control);
				let prompt: Promise<void> | undefined;
				await withHeldCleanup(
					async () => {
						await withinBarrier(held.entered, "thinking owner before workflow prompt");
						prompt = f.session.prompt("workflow acceptance during thinking", {
							onPreflightAccepted: () => accepted.resolve(),
							preflightSignal: cancellation.signal,
						});
						void prompt.catch(() => {});
						await withinBarrier(accepted.promise, "workflow acceptance preflight");
						expect(mock.calls).toHaveLength(0);
						if (cancelled) cancellation.abort();
						held.release();
						await withinBarrier(control, "thinking control before workflow");
						if (cancelled) await expect(withinBarrier(prompt, "cancelled workflow prompt")).rejects.toThrow();
						else await withinBarrier(prompt, "workflow prompt completion");
						expect(mock.calls).toHaveLength(cancelled ? 0 : 1);
						const branch = f.manager.getBranch();
						expect(
							branch.filter(entry => entry.type === "custom" && entry.customType === "workflow-intent-diff"),
						).toHaveLength(cancelled ? 0 : 1);
						expect(
							branch.some(
								entry =>
									entry.type === "message" &&
									entry.message.role === "user" &&
									JSON.stringify(entry.message.content).includes("workflow acceptance during thinking"),
							),
						).toBe(!cancelled);
					},
					held.release,
					() => [controlResult, prompt],
					"workflow overlap cleanup",
				);
			}
		});
	}

	it("rechecks a replacement thinking group before publishing waiting workflow metadata", async () => {
		const mock = createMockModel({ handler: { content: ["done"] } });
		const f = await fixture(false, true, mock.stream);
		await initializeLocalRoot({
			getSessionId: () => f.manager.getSessionId(),
			getArtifactsDir: () => f.manager.getArtifactsDir(),
			isManagedDestination: () => f.manager.isManagedDestination(),
			getManagedLegacyLocalMigrationSource: () => f.manager.getManagedLegacyLocalMigrationSource(),
		});
		const firstHeld = holdSnapshot(f.manager);
		const secondRequested = Promise.withResolvers<{ completion: Promise<void> }>();
		const secondEntered = Promise.withResolvers<void>();
		const secondRelease = Promise.withResolvers<void>();
		const appendThinking = f.manager.appendThinkingLevelChangeSharingSession.bind(f.manager);
		vi.spyOn(f.manager, "appendThinkingLevelChangeSharingSession").mockImplementation(async (...args) => {
			if (args[0] === ThinkingLevel.High) {
				secondEntered.resolve();
				await secondRelease.promise;
			}
			return appendThinking(...args);
		});
		let second: Promise<void> | undefined;
		const appendMessage = f.manager.appendMessageSharingSession.bind(f.manager);
		vi.spyOn(f.manager, "appendMessageSharingSession").mockImplementation(message => {
			if (message.role === "user" && message.content === "between groups") {
				second = f.session.setThinkingLevelForControl(ThinkingLevel.High, false);
				void second.catch(() => {});
				secondRequested.resolve({ completion: second });
			}
			return appendMessage(message);
		});
		const first = f.session.setThinkingLevelForControl(ThinkingLevel.Low, false);
		void first.catch(() => {});
		let prompt: Promise<void> | undefined;
		let settlement: Promise<void> | undefined;
		await withHeldCleanup(
			async () => {
				await withinBarrier(firstHeld.entered, "first thinking group");
				f.agent.emitExternalEvent({ type: "message_end", message: user("between groups") });
				settlement = f.session.awaitSessionSettlement();
				void settlement.catch(() => {});
				const accepted = Promise.withResolvers<void>();
				prompt = f.session.prompt("workflow waits for replacement group", {
					onPreflightAccepted: () => accepted.resolve(),
				});
				void prompt.catch(() => {});
				await withinBarrier(accepted.promise, "waiting workflow acceptance");
				firstHeld.release();
				const replacement = await withinBarrier(secondRequested.promise, "replacement control requested");
				await withinBarrier(
					Promise.race([secondEntered.promise, replacement.completion]),
					"replacement thinking group",
				);
				expect(
					f.manager
						.getBranch()
						.filter(entry => entry.type === "custom" && entry.customType === "workflow-intent-diff"),
				).toHaveLength(0);
				secondRelease.resolve();
				await withinBarrier(
					Promise.all([first, replacement.completion, settlement, prompt]),
					"replacement and waiting workflow",
				);
				const branch = f.manager.getBranch();
				const thinking = branch.findLast(entry => entry.type === "thinking_level_change");
				expect(thinking).toMatchObject({ thinkingLevel: ThinkingLevel.High });
				const workflow = branch.filter(
					entry => entry.type === "custom" && entry.customType === "workflow-intent-diff",
				);
				expect(workflow).toHaveLength(1);
				expect(workflow[0].parentId).toBe(thinking!.id);
				expect(mock.calls).toHaveLength(1);
			},
			() => {
				firstHeld.release();
				secondRelease.resolve();
			},
			() => [first, second, settlement, prompt],
			"replacement cleanup",
		);
	});

	it("waits for a started workflow publication before admitting a thinking control", async () => {
		const mock = createMockModel({ handler: { content: ["done"] } });
		const f = await fixture(false, true, mock.stream);
		await initializeLocalRoot({
			getSessionId: () => f.manager.getSessionId(),
			getArtifactsDir: () => f.manager.getArtifactsDir(),
			isManagedDestination: () => f.manager.isManagedDestination(),
			getManagedLegacyLocalMigrationSource: () => f.manager.getManagedLegacyLocalMigrationSource(),
		});
		const held = holdSnapshot(f.manager);
		const prompt = f.session.prompt("earlier workflow prompt");
		void prompt.catch(() => {});
		let control: Promise<void> | undefined;
		await withHeldCleanup(
			async () => {
				await withinBarrier(held.entered, "started workflow publication");
				control = f.session.setThinkingLevelForControl(ThinkingLevel.High, false);
				expect(f.session.thinkingLevel).not.toBe(ThinkingLevel.High);
				held.release();
				await withinBarrier(prompt, "earlier workflow completion");
				await withinBarrier(control, "thinking after workflow");
				const entries = f.manager.getBranch();
				const workflow = entries.find(
					entry => entry.type === "custom" && entry.customType === "workflow-intent-diff",
				);
				const thinking = entries.find(entry => entry.type === "thinking_level_change");
				expect(workflow?.id).toBeTruthy();
				expect(thinking?.id).toBeTruthy();
				expect(f.session.thinkingLevel).toBe(ThinkingLevel.High);
			},
			held.release,
			() => [prompt, control],
			"workflow predecessor cleanup",
		);
	});

	it("does not stage a superseded local control while its shared lease awaits", async () => {
		const f = await fixture(false, true);
		const admitted = await f.manager.appendMessageSharingSession(user("shared"));
		expect(admitted.kind).toBe("committed");
		const held = holdSnapshot(f.manager);
		const older = f.session.setThinkingLevelForControl(ThinkingLevel.Low, false);
		const olderResult = observeControl(older);
		let newer: Promise<void> | undefined;
		try {
			await withinBarrier(held.entered, "older thinking lease");
			f.agent.emitExternalEvent({ type: "message_end", message: user("behind overlapping thinking") });
			newer = f.session.setThinkingLevelForControl(ThinkingLevel.High, false);
			held.release();
			await withinBarrier(older, "superseded thinking control");
			await withinBarrier(newer, "newer thinking control");
			await withinBarrier(f.session.awaitSessionSettlement(), "canonical behind overlapping thinking");
			expect(
				f.manager
					.getBranch()
					.some(
						entry =>
							entry.type === "message" &&
							entry.message.role === "user" &&
							entry.message.content === "behind overlapping thinking",
					),
			).toBe(true);
			expect(f.session.thinkingLevel).toBe(ThinkingLevel.High);
			const entries = f.manager.getBranch().filter(entry => entry.type === "thinking_level_change");
			expect(entries).toHaveLength(1);
			expect(entries[0]).toMatchObject({ thinkingLevel: ThinkingLevel.High, operatorIntent: true });
		} finally {
			held.release();
			await withinBarrier(Promise.allSettled([olderResult, newer].filter(Boolean)), "thinking overlap cleanup");
		}
	});

	it("retains a committed older entry without applying it after a newer control arrives", async () => {
		const f = await fixture(false, true);
		expect((await f.manager.appendMessageSharingSession(user("shared"))).kind).toBe("committed");
		const held = holdSnapshot(f.manager, 2);
		const older = f.session.setThinkingLevelForControl(ThinkingLevel.Low, false);
		const olderResult = observeControl(older);
		let newer: Promise<void> | undefined;
		try {
			await withinBarrier(held.entered, "older committed thinking entry");
			newer = f.session.setThinkingLevelForControl(ThinkingLevel.High, false);
			held.release();
			await withinBarrier(older, "older published thinking completion");
			await withinBarrier(newer, "newer published thinking completion");
			expect(f.session.thinkingLevel).toBe(ThinkingLevel.High);
			expect(
				f.manager
					.getBranch()
					.filter(entry => entry.type === "thinking_level_change")
					.map(entry => entry.thinkingLevel),
			).toEqual([ThinkingLevel.Low, ThinkingLevel.High]);
		} finally {
			held.release();
			await withinBarrier(Promise.allSettled([olderResult, newer].filter(Boolean)), "committed overlap cleanup");
		}
	});

	it("rejects controls before Agent, settings, UI, credentials, tools, or disk change", async () => {
		const f = await fixture();
		await f.admit();
		const before = snapshot(f.session);
		const bytes = await Bun.file(f.file).text();
		const events = vi.fn();
		const unsubscribe = f.session.subscribe(events);
		const credentials = vi.spyOn(f.registry, "getApiKey");
		const persist = vi.spyOn(f.settings, "commitAtomicBatch");
		const mutationStarted = vi.fn();
		const operations: Array<() => unknown> = [
			() => f.session.setServiceTier("priority"),
			() => f.session.setFastMode(true),
			() => f.session.setThinkingLevel(ThinkingLevel.High, true),
			() => f.session.setThinkingLevelForControl(ThinkingLevel.High, false),
			() => f.session.setThinkingLevelForControl(ThinkingLevel.High, true),
			() => f.session.setModel(f.model, "smol", { onMutationStarted: mutationStarted }),
			() => f.session.setDefaultModelSelection(f.model, ThinkingLevel.High, { onBeforeMutation: mutationStarted }),
			() => f.session.setModelTemporary(f.model),
			() => f.session.setDefaultModelProfileForControl("unavailable", { onBeforeActivation: mutationStarted }),
			() => f.session.setConfiguredModelChain("default", ["anthropic/claude-sonnet-4-5"], "test"),
			() => f.session.setActiveToolsByName([]),
			() => f.session.compact(),
			() => f.session.navigateTree(f.first, { summarize: true }),
		];
		try {
			for (const operation of operations) {
				await expect(Promise.resolve().then(operation)).rejects.toBeInstanceOf(
					SharedSessionMutationUnsupportedError,
				);
				expect(snapshot(f.session)).toEqual(before);
				expect(await Bun.file(f.file).text()).toBe(bytes);
				expect(events).not.toHaveBeenCalled();
				expect(credentials).not.toHaveBeenCalled();
				expect(persist).not.toHaveBeenCalled();
				expect(mutationStarted).not.toHaveBeenCalled();
				expect(f.execute).not.toHaveBeenCalled();
				expect(f.rebuild).not.toHaveBeenCalled();
			}
		} finally {
			unsubscribe();
		}
	});

	it("rechecks admission after model credentials resolve", async () => {
		const f = await fixture();
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<string>();
		vi.spyOn(f.registry, "getApiKey").mockImplementation(async () => {
			entered.resolve();
			return release.promise;
		});
		const mutationStarted = vi.fn();
		const pending = f.session.setModel(f.model, "smol", { onMutationStarted: mutationStarted });
		const outcome = observeControl(pending);
		try {
			await withinBarrier(
				Promise.race([
					entered.promise,
					outcome.then(result => {
						if (result.kind === "rejected") throw result.error;
						throw new Error("Model selection settled before credential hook");
					}),
				]),
				"credential hook",
			);
			await withinBarrier(f.admit(), "shared admission during credential hook");
			const before = snapshot(f.session);
			const bytes = await Bun.file(f.file).text();
			release.resolve("test-key");
			const result = await withinBarrier(outcome, "model selection refusal");
			expect(result.kind).toBe("rejected");
			if (result.kind === "rejected") expect(result.error).toBeInstanceOf(SharedSessionMutationUnsupportedError);
			expect(snapshot(f.session)).toEqual(before);
			expect(await Bun.file(f.file).text()).toBe(bytes);
			expect(mutationStarted).not.toHaveBeenCalled();
		} finally {
			release.resolve("test-key");
			await withinBarrier(outcome, "model selection cleanup");
		}
	});

	it("rechecks tool selection after prompt preparation without publishing it", async () => {
		const f = await fixture();
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		f.rebuild.mockImplementation(async () => {
			entered.resolve();
			await release.promise;
			return { systemPrompt: ["Must not publish"] };
		});
		const pending = f.session.setActiveToolsByName([]);
		const outcome = observeControl(pending);
		try {
			await withinBarrier(
				Promise.race([
					entered.promise,
					outcome.then(result => {
						if (result.kind === "rejected") throw result.error;
						throw new Error("Tool selection settled before prompt rebuild hook");
					}),
				]),
				"prompt rebuild hook",
			);
			await withinBarrier(f.admit(), "shared admission during prompt rebuild hook");
			const before = snapshot(f.session);
			release.resolve();
			const result = await withinBarrier(outcome, "tool selection refusal");
			expect(result.kind).toBe("rejected");
			if (result.kind === "rejected") expect(result.error).toBeInstanceOf(SharedSessionMutationUnsupportedError);
			expect(snapshot(f.session)).toEqual(before);
		} finally {
			release.resolve();
			await withinBarrier(outcome, "tool selection cleanup");
		}
	});

	it("retains shared read-only and genuine no-op controls", async () => {
		const f = await fixture();
		await f.admit();
		const before = snapshot(f.session);
		const bytes = await Bun.file(f.file).text();
		f.session.setServiceTier(f.session.serviceTier);
		f.session.setThinkingLevel(f.session.thinkingLevel);
		expect(f.session.getAvailableThinkingLevels().length).toBeGreaterThan(0);
		expect(await f.session.cycleRoleModels([])).toBeUndefined();
		expect(await f.session.activateDiscoveredTools([])).toEqual([]);
		expect(await f.session.navigateTree(f.manager.getLeafId()!, { summarize: true })).toEqual({ cancelled: false });
		expect(snapshot(f.session)).toEqual(before);
		expect(await Bun.file(f.file).text()).toBe(bytes);
	});

	for (const failPublication of [false, true]) {
		it(`refuses durable thinking after sibling shared admission (failure=${failPublication})`, async () => {
			const f = await fixture(true);
			const sibling = await SessionManager.open(f.file, f.destination);
			managers.push(sibling);
			const entered = Promise.withResolvers<void>();
			const release = Promise.withResolvers<void>();
			const capture = sibling.captureCommittedSnapshot.bind(sibling);
			let paused = false;
			vi.spyOn(sibling, "captureCommittedSnapshot").mockImplementation(async () => {
				if (!paused) {
					paused = true;
					entered.resolve();
					await release.promise;
					if (failPublication) throw new Error("injected shared publication failure");
				}
				return capture();
			});
			const publication = sibling.appendMessageSharingSession(user("sibling first")).then(
				result => ({ kind: "outcome" as const, result }),
				error => ({ kind: "error" as const, error }),
			);
			try {
				await withinBarrier(
					Promise.race([
						entered.promise,
						publication.then(result => {
							if (result.kind === "error") throw result.error;
							throw new Error(`Shared publication settled before snapshot barrier: ${result.result.kind}`);
						}),
					]),
					"sibling shared snapshot barrier",
				);
				const before = snapshot(f.session);
				const bytes = await Bun.file(f.file).text();
				const durableBefore = (await Settings.loadReadonly({ cwd: f.cwd, agentDir: f.agentDir })).get(
					"defaultThinkingLevel",
				);
				const commit = vi.spyOn(f.settings, "commitAtomicBatch");
				const control = await observeControl(f.session.setThinkingLevelForControl(ThinkingLevel.High, true));
				expect(control.kind).toBe("rejected");
				if (control.kind === "rejected")
					expect(control.error).toBeInstanceOf(SharedSessionMutationUnsupportedError);
				expect(commit).not.toHaveBeenCalled();
				expect(snapshot(f.session)).toEqual(before);
				expect(await Bun.file(f.file).text()).toBe(bytes);
				expect(
					(await Settings.loadReadonly({ cwd: f.cwd, agentDir: f.agentDir })).get("defaultThinkingLevel"),
				).toBe(durableBefore);
				release.resolve();
				const result = await withinBarrier(publication, "sibling publication completion");
				if (failPublication) {
					expect(result.kind).toBe("error");
					if (result.kind === "error")
						expect(String(result.error)).toContain("injected shared publication failure");
				} else {
					if (result.kind === "error") throw result.error;
					expect(result.result.kind).toBe("committed");
				}
				// No durable write is needed to prove the short-lived count was released.
				expect(await f.manager.withDurableThinkingControl(async () => "released")).toBe("released");
			} finally {
				release.resolve();
				await withinBarrier(publication, "sibling publication cleanup");
				await f.settings.close();
			}
		});
	}

	for (const fail of [false, true]) {
		it(`holds shared admission through durable thinking commit (failure=${fail})`, async () => {
			const f = await fixture(true);
			const sibling = await SessionManager.open(f.file, f.destination);
			managers.push(sibling);
			const entered = Promise.withResolvers<void>();
			const release = Promise.withResolvers<void>();
			const commit = f.settings.commitAtomicBatch.bind(f.settings);
			vi.spyOn(f.settings, "commitAtomicBatch").mockImplementation(async patches => {
				entered.resolve();
				await release.promise;
				if (fail) throw new Error("injected settings commit failure");
				return commit(patches);
			});
			const before = snapshot(f.session);
			const bytes = await Bun.file(f.file).text();
			const outcome = observeControl(f.session.setThinkingLevelForControl(ThinkingLevel.High, true));
			try {
				await withinBarrier(
					Promise.race([
						entered.promise,
						outcome.then(result => {
							if (result.kind === "rejected") throw result.error;
							throw new Error("Thinking control completed before settings barrier");
						}),
					]),
					"durable thinking commit barrier",
				);
				for (const manager of [f.manager, sibling]) {
					const revisions = manager.revisionSnapshot();
					const result = await manager.appendMessageSharingSession(user("blocked"));
					expect(result.kind).toBe("rejected");
					if (result.kind === "rejected")
						expect(String(result.error)).toContain("durable_thinking_control_in_flight");
					expect(manager.revisionSnapshot()).toEqual(revisions);
				}
				expect(snapshot(f.session)).toEqual(before);
				expect(await Bun.file(f.file).text()).toBe(bytes);
				const unrelated = SessionManager.create(f.cwd, f.destination);
				managers.push(unrelated);
				const independent = await unrelated.appendMessageSharingSession(user("unrelated session"));
				expect(independent.kind).toBe("committed");
				release.resolve();
				const result = await withinBarrier(outcome, "durable thinking completion");
				if (fail) {
					expect(result.kind).toBe("rejected");
					if (result.kind === "rejected")
						expect(String(result.error)).toContain("Unable to persist reasoning settings");
					expect(snapshot(f.session)).toEqual(before);
				} else {
					if (result.kind === "rejected") throw result.error;
					expect(f.session.thinkingLevel).toBe(ThinkingLevel.High);
					expect(f.settings.get("defaultThinkingLevel")).toBe(ThinkingLevel.High);
					expect(
						(await Settings.loadReadonly({ cwd: f.cwd, agentDir: f.agentDir })).get("defaultThinkingLevel"),
					).toBe(ThinkingLevel.High);
					expect(f.manager.getBranch().some(entry => entry.type === "thinking_level_change")).toBe(true);
				}
				await f.manager.flush();
				const later = await f.manager.appendMessageSharingSession(user("after control"));
				expect(later.kind).toBe("committed");
			} finally {
				release.resolve();
				await withinBarrier(outcome, "durable thinking cleanup");
				await f.settings.close();
			}
		});
	}

	it("keeps ordinary control mutations working", async () => {
		const f = await fixture();
		f.session.setServiceTier("priority");
		expect(f.agent.serviceTier).toBe("priority");
		await f.session.setThinkingLevelForControl(ThinkingLevel.High, false);
		expect(f.session.thinkingLevel).toBe(ThinkingLevel.High);
		f.session.setConfiguredModelChain("default", ["anthropic/claude-sonnet-4-5"], "test");
		expect(f.session.getConfiguredModelChain("default")).toEqual(["anthropic/claude-sonnet-4-5"]);
		await f.session.setActiveToolsByName([]);
		expect(f.session.getActiveToolNames()).toEqual([]);
		expect(f.agent.state.systemPrompt).toEqual(["Rebuilt"]);
		expect(f.rebuild).toHaveBeenCalledTimes(1);
		expect(f.execute).not.toHaveBeenCalled();
		await f.manager.flush();
		expect(await Bun.file(f.file).text()).toContain("service_tier_change");
	});
});
