import { afterEach, beforeEach, describe, expect, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { AssistantMessage, Model } from "@gajae-code/ai/core";
import { AssistantMessageEventStream } from "@gajae-code/ai/utils/event-stream";
import { setModelPresetRegistryDisabled } from "@gajae-code/coding-agent/config/model-preset-registry";
import { ModelRegistry } from "@gajae-code/coding-agent/config/model-registry";
import {
	type CreateAgentSessionOptions,
	type CreateAgentSessionResult,
	createAgentSession,
} from "@gajae-code/coding-agent/sdk";
import { getAgentDir, setAgentDir } from "@gajae-code/utils";
import { DeliveryJournal } from "../src/delivery-journal";
import { DesktopHost } from "../src/host";
import {
	type DesktopFrame,
	type DesktopProject,
	type DesktopRequest,
	type DesktopSession,
	type DesktopSnapshot,
	parseRequest,
} from "../src/protocol";

let environment: NodeJS.ProcessEnv;
let agentDir: string;
const cleanups: Array<() => Promise<void>> = [];

beforeEach(() => {
	environment = { ...process.env };
	agentDir = getAgentDir();
	process.env.GJC_DESKTOP_ISOLATED = "1";
	vi.spyOn(ModelRegistry.prototype, "refresh").mockResolvedValue(undefined);
});

afterEach(async () => {
	try {
		while (cleanups.length) await cleanups.pop()?.();
	} finally {
		vi.restoreAllMocks();
		for (const key of Object.keys(process.env)) if (!(key in environment)) delete process.env[key];
		Object.assign(process.env, environment);
		setAgentDir(agentDir);
	}
});

async function launch(
	options: {
		beforeCreate?: () => Promise<void>;
		observeFrame?: (frame: DesktopFrame) => void;
		createSession?: (options: CreateAgentSessionOptions) => Promise<CreateAgentSessionResult>;
	} = {},
) {
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-desktop-layout-"));
	const dataDir = path.join(directory, "app");
	await setModelPresetRegistryDisabled({ agentDir: path.join(dataDir, "agent"), disabled: true });
	const frames: DesktopFrame[] = [];
	const host = new DesktopHost({
		dataDir,
		emit: frame => {
			options.observeFrame?.(frame);
			frames.push(frame);
		},
		createSession: async (createOptions: CreateAgentSessionOptions) => {
			await options.beforeCreate?.();
			return (options.createSession ?? createAgentSession)(createOptions);
		},
	});
	cleanups.push(async () => {
		await host.close();
		await fs.rm(directory, { recursive: true, force: true });
	});
	const call = async <T>(
		method: DesktopRequest["method"],
		params: Record<string, unknown> = {},
		id: string = crypto.randomUUID(),
	): Promise<T> => {
		await host.handle(parseRequest(JSON.stringify({ id, method, params })));
		const response = frames.find(frame => frame.type === "response" && frame.id === id);
		if (response?.type !== "response") throw new Error("Missing response");
		if (!response.ok) throw new Error(response.error);
		return response.result as T;
	};
	const snapshot = () => {
		const frame = [...frames].reverse().find(item => item.type === "snapshot");
		if (frame?.type !== "snapshot") throw new Error("Missing snapshot");
		return frame.snapshot as DesktopSnapshot;
	};
	const open = async (name: string) => {
		const projectPath = path.join(directory, name);
		await fs.mkdir(projectPath, { recursive: true });
		return call<DesktopProject>("project.open", { path: projectPath });
	};
	return {
		call,
		snapshot,
		open,
		close: () => host.close(),
		directory,
		dataDir,
		// A second host on the same data directory is the restart boundary: nothing is shared
		// except what the first host persisted.
		createHost: async (targetDataDir: string) => {
			const frames: DesktopFrame[] = [];
			const host = new DesktopHost({
				dataDir: targetDataDir,
				emit: frame => frames.push(frame),
				createSession: async (options: CreateAgentSessionOptions) => createAgentSession(options),
			});
			cleanups.push(() => host.close());
			const callRestarted = async <T>(
				method: DesktopRequest["method"],
				params: Record<string, unknown> = {},
			): Promise<T> => {
				const id = crypto.randomUUID();
				await host.handle(parseRequest(JSON.stringify({ id, method, params })));
				const response = frames.find(frame => frame.type === "response" && frame.id === id);
				if (response?.type !== "response") throw new Error("Missing response");
				if (!response.ok) throw new Error(response.error);
				return response.result as T;
			};
			await callRestarted("bootstrap");
			return {
				call: callRestarted,
				snapshot: () => {
					const frame = [...frames].reverse().find(item => item.type === "snapshot");
					if (frame?.type !== "snapshot") throw new Error("Missing snapshot");
					return frame.snapshot as DesktopSnapshot;
				},
			};
		},
	};
}

describe("desktop workspace layout", () => {
	test("closing a workspace hides it and every conversation, and keeps their files", async () => {
		const { call, snapshot, open, directory } = await launch();
		const first = await open("first");
		const second = await open("second");
		const kept = await call<DesktopSession>("session.create", { projectId: first.id });
		await call<DesktopSession>("session.create", { projectId: second.id });
		expect(snapshot().projects.map(project => project.id)).toEqual([first.id, second.id]);
		expect(snapshot().sessions).toHaveLength(2);

		await call("project.close", { projectId: first.id });

		// The closed workspace and its conversation leave the view, but nothing is deleted.
		expect(snapshot().projects.map(project => project.id)).toEqual([second.id]);
		expect(snapshot().sessions.map(session => session.projectId)).toEqual([second.id]);
		await expect(fs.stat(path.join(directory, "first"))).resolves.toBeTruthy();
		const reopened = await open("first");
		expect(reopened.id).toBe(first.id);
		// The closed workspace keeps its slot in the order, so reopening restores both.
		expect(snapshot().projects.map(project => project.id)).toEqual([first.id, second.id]);
		// Reopening restores the retained conversation rather than creating a new one.
		expect(snapshot().sessions.map(session => session.id)).toContain(kept.id);
	});

	test("workspaces and conversations retain explicit order across restarts", async () => {
		const { call, snapshot, open, dataDir, createHost } = await launch();
		const first = await open("first");
		const second = await open("second");
		const third = await open("third");
		await call("project.reorder", { ids: [third.id, first.id, second.id] });
		expect(snapshot().projects.map(project => project.id)).toEqual([third.id, first.id, second.id]);

		const a = await call<DesktopSession>("session.create", { projectId: first.id });
		const b = await call<DesktopSession>("session.create", { projectId: first.id });
		expect(snapshot().sessions.map(session => session.id)).toEqual([a.id, b.id]);
		await call("session.reorder", { projectId: first.id, ids: [b.id, a.id] });
		const ordered = snapshot().sessions.filter(session => session.projectId === first.id);
		expect(ordered.map(session => session.id)).toEqual([b.id, a.id]);
		await open("first");
		expect(
			snapshot()
				.sessions.filter(session => session.projectId === first.id)
				.map(session => session.id),
		).toEqual([b.id, a.id]);
		// Conversations remain scoped to the project that created them.
		expect(snapshot().sessions.filter(session => session.projectId === second.id)).toHaveLength(0);
		// The explicit order is durable, not just incidental in-memory array order.
		const restarted = await createHost(dataDir);
		expect(restarted.snapshot().projects.map(project => project.id)).toEqual([third.id, first.id, second.id]);
		expect(
			restarted
				.snapshot()
				.sessions.filter(session => session.projectId === first.id)
				.map(session => session.id),
		).toEqual([b.id, a.id]);
	});

	test.each([
		"journal",
		"publication",
		"shutdown-observer",
	] as const)("workspace teardown retains every owner during %s", async failure => {
		const model: Model = {
			id: "controlled-close",
			name: "Controlled workspace close",
			provider: "desktop-close-fixture",
			api: "openai-completions",
			baseUrl: "https://example.invalid",
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 200_000,
			maxTokens: 1024,
		};
		const captures: Array<{
			result: CreateAgentSessionResult;
			started: Promise<void>;
			runs: number;
			aborts: number;
		}> = [];
		let publicationFailed = false;
		const { call, snapshot, open, close, dataDir, createHost } = await launch({
			observeFrame: frame => {
				if (
					failure === "publication" &&
					!publicationFailed &&
					frame.type === "snapshot" &&
					frame.snapshot.projects.length === 0
				) {
					publicationFailed = true;
					throw new Error("closed workspace publication failed");
				}
			},
			createSession: async options => {
				if (!options.authStorage || !options.settings) throw new Error("Missing host-owned session services");
				options.authStorage.setRuntimeApiKey(model.provider, "local-close-only");
				options.settings.override("compaction.enabled", false);
				options.settings.override("retry.enabled", false);
				const result = await createAgentSession({ ...options, model, extensions: [] });
				vi.spyOn(result.session, "generateAutoSessionTitle").mockResolvedValue({
					kind: "skipped",
					reason: "disabled",
				});
				const started = Promise.withResolvers<void>();
				const capture = { result, started: started.promise, runs: 0, aborts: 0 };
				result.session.agent.streamFn = (_model, _context, streamOptions) => {
					capture.runs++;
					const stream = new AssistantMessageEventStream();
					const message: AssistantMessage = {
						role: "assistant",
						content: [{ type: "text", text: "working" }],
						api: model.api,
						provider: model.provider,
						model: model.id,
						stopReason: "stop",
						timestamp: Date.now(),
						usage: {
							input: 0,
							output: 0,
							cacheRead: 0,
							cacheWrite: 0,
							totalTokens: 0,
							cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
						},
					};
					const abort = () => {
						capture.aborts++;
						message.stopReason = "aborted";
						stream.push({ type: "error", reason: "aborted", error: message });
					};
					streamOptions?.signal?.addEventListener("abort", abort, { once: true });
					queueMicrotask(() => {
						stream.push({ type: "start", partial: message });
						stream.push({ type: "text_delta", contentIndex: 0, delta: "working", partial: message });
						started.resolve();
						if (streamOptions?.signal?.aborted) abort();
					});
					return stream;
				};
				captures.push(capture);
				return result;
			},
		});
		const project = await open("first");
		const sessions = [
			await call<DesktopSession>("session.create", { projectId: project.id }),
			await call<DesktopSession>("session.create", { projectId: project.id }),
		];
		const owners = captures.slice();
		expect(owners).toHaveLength(2);
		const teardownComplete = owners.map(() => Promise.withResolvers<void>());
		const disposed = owners.map((owner, index) => {
			const dispose = owner.result.session.dispose.bind(owner.result.session);
			return vi.spyOn(owner.result.session, "dispose").mockImplementation(async options => {
				await dispose(options);
				teardownComplete[index]!.resolve();
			});
		});
		const running = sessions.map((session, index) =>
			call("prompt", { sessionId: session.id, text: "keep running" }, `close-running-${index}`).catch(
				error => error,
			),
		);
		await Promise.race([
			Promise.all(owners.map(owner => owner.started)),
			Promise.race(running).then(() => {
				throw new Error("Prompt settled before its controlled stream started");
			}),
		]);
		for (const [index, session] of sessions.entries()) {
			await call(
				"prompt",
				{ sessionId: session.id, text: "must never run", deliverAs: "followUp" },
				`close-queued-${index}`,
			);
		}
		expect(owners.map(owner => owner.result.session.getQueuedMessages().followUp)).toEqual([
			["must never run"],
			["must never run"],
		]);

		if (failure === "shutdown-observer") {
			const entered = Promise.withResolvers<void>();
			const release = Promise.withResolvers<void>();
			const update = DeliveryJournal.prototype.update;
			let terminalWrites = 0;
			let committedWrites = 0;
			let terminalDisposition: string | undefined;
			const journal = vi.spyOn(DeliveryJournal.prototype, "update").mockImplementation(async function (
				this: DeliveryJournal,
				id,
				changes,
			) {
				const terminal =
					id === "close-queued-0" && changes.disposition !== "queued" && changes.disposition !== "accepted";
				if (terminal) {
					terminalWrites++;
					terminalDisposition = changes.disposition;
					entered.resolve();
					await release.promise;
				}
				await update.call(this, id, changes);
				if (terminal) committedWrites++;
			});
			let closed = false;
			const closing = close().then(() => {
				closed = true;
			});
			try {
				await entered.promise;
				await Promise.all(teardownComplete.map(completion => completion.promise));
				await Bun.sleep(25);
				expect(closed).toBe(false);
				expect(terminalWrites).toBe(2);
				for (const [index, owner] of owners.entries()) {
					expect(disposed[index]).toHaveBeenCalled();
					expect(owner.result.session.sessionLifecycle.disposed).toBe(true);
				}
			} finally {
				release.resolve();
				try {
					await closing;
				} finally {
					journal.mockRestore();
				}
			}
			await Promise.all(running);
			expect(closed).toBe(true);
			expect(terminalDisposition).toBe("removed");
			const persisted: { receipts: Array<{ id: string; disposition: string }> } = await Bun.file(
				path.join(dataDir, "deliveries.json"),
			).json();
			expect(persisted.receipts).toContainEqual(
				expect.objectContaining({ id: "close-queued-0", disposition: terminalDisposition }),
			);
			expect(committedWrites).toBe(2);
			return;
		}

		// Discover the host's journal through a public method, not private host state.
		let ownedJournal: DeliveryJournal | undefined;
		const list = DeliveryJournal.prototype.list;
		const probe = vi.spyOn(DeliveryJournal.prototype, "list").mockImplementation(function (this: DeliveryJournal) {
			const receipts = list.call(this);
			if (receipts.some(receipt => receipt.id === "close-queued-0" && receipt.sessionId === sessions[0]!.id))
				ownedJournal = this;
			return receipts;
		});
		try {
			await call("bootstrap");
		} finally {
			probe.mockRestore();
		}
		if (!ownedJournal) throw new Error("Missing host-owned delivery journal");
		const journalOwner = ownedJournal;

		// Obstruct the actual rename only for this owner's cancellation. The native execution
		// observer also writes a terminal receipt; park it until the failed save restores the file.
		const journalPath = path.join(dataDir, "deliveries.json");
		const savedJournalPath = path.join(dataDir, "deliveries-before-cancel.json");
		const update = ownedJournal.update;
		let attempted = false;
		let injected = false;
		let failedUpdates = 0;
		let renameFailure: unknown;
		let restoration: Promise<void> | undefined;
		const errors = vi.spyOn(console, "error");
		try {
			const journal = vi.spyOn(journalOwner, "update").mockImplementation(async function (
				this: DeliveryJournal,
				id,
				changes,
			) {
				if (failure === "journal" && id === "close-queued-0" && changes.disposition === "cancelled" && !attempted) {
					attempted = true;
					const restored = Promise.withResolvers<void>();
					restoration = restored.promise;
					let moved = false;
					let blocked = false;
					try {
						expect(this).toBe(journalOwner);
						expect(this.list()).toContainEqual(
							expect.objectContaining({ id, sessionId: sessions[0]!.id, disposition: "queued" }),
						);
						await fs.rename(journalPath, savedJournalPath);
						moved = true;
						await fs.mkdir(journalPath);
						blocked = true;
						try {
							// Run the real save and its unknown-on-failure transition.
							await update.call(this, id, changes);
						} catch (error) {
							injected = true;
							failedUpdates++;
							renameFailure = error;
							throw error;
						}
					} finally {
						try {
							if (blocked) await fs.rm(journalPath, { recursive: true });
							if (moved) await fs.rename(savedJournalPath, journalPath);
						} finally {
							restored.resolve();
						}
					}
					return;
				}
				if (restoration) await restoration;
				try {
					await update.call(this, id, changes);
				} catch (error) {
					if (id === "close-queued-0") failedUpdates++;
					throw error;
				}
			});
			try {
				if (failure === "publication") {
					await expect(call("project.close", { projectId: project.id })).rejects.toThrow(
						"closed workspace publication failed",
					);
				} else {
					await call("project.close", { projectId: project.id });
				}
				await Promise.all(running);
				expect(attempted).toBe(failure === "journal");
				expect(injected).toBe(failure === "journal");
				expect(publicationFailed).toBe(failure === "publication");
				expect(failedUpdates).toBe(failure === "journal" ? 1 : 0);
				if (failure === "journal") {
					expect(renameFailure).toMatchObject({ syscall: "rename" });
					expect(errors).toHaveBeenCalledWith(expect.stringContaining("could not cancel delivery close-queued-0"));
				}
			} finally {
				journal.mockRestore();
			}
		} finally {
			errors.mockRestore();
		}
		const disposition = failure === "journal" ? "unknown" : "cancelled";
		const catalog: { projects: DesktopProject[] } = await Bun.file(path.join(dataDir, "catalog.json")).json();
		expect(catalog.projects.find(item => item.id === project.id)?.closed).toBe(true);
		expect(snapshot().projects).toEqual([]);
		for (const [index, owner] of owners.entries()) {
			expect(owner.aborts).toBe(1);
			expect(owner.runs).toBe(1);
			expect(disposed[index]).toHaveBeenCalled();
			expect(owner.result.session.sessionLifecycle.disposed).toBe(true);
			expect(owner.result.session.getQueuedMessages()).toEqual({ steering: [], followUp: [] });
		}
		expect(snapshot().deliveries).toContainEqual(expect.objectContaining({ id: "close-queued-0", disposition }));
		expect(snapshot().deliveries).toContainEqual(
			expect.objectContaining({ id: "close-queued-1", disposition: "cancelled" }),
		);

		await open("first");
		for (const session of sessions) await call("session.select", { sessionId: session.id });
		expect(captures).toHaveLength(4);
		expect(captures.slice(2).map(owner => owner.runs)).toEqual([0, 0]);
		const reopened = await call<DesktopSnapshot>("bootstrap");
		expect(reopened.sessions).toHaveLength(2);
		expect(reopened.sessions.some(session => session.status === "running")).toBe(false);
		expect(reopened.sessions.flatMap(session => session.queued ?? [])).toEqual([]);
		expect(captures.slice(2).map(owner => owner.result.session.isStreaming)).toEqual([false, false]);
		expect(owners.map(owner => owner.runs)).toEqual([1, 1]);
		const restarted = await createHost(dataDir);
		expect(restarted.snapshot().deliveries).toContainEqual(
			expect.objectContaining({ id: "close-queued-0", disposition }),
		);
		const persisted: { receipts: Array<{ id: string; disposition: string }> } = await Bun.file(
			path.join(dataDir, "deliveries.json"),
		).json();
		expect(persisted.receipts).toContainEqual(expect.objectContaining({ id: "close-queued-0", disposition }));
	}, 30000);

	test("a closed workspace stays closed across a restart, and open ones still reorder", async () => {
		const { call, snapshot, open, dataDir, directory, createHost } = await launch();
		const first = await open("first");
		const second = await open("second");
		const third = await open("third");
		const keptInSecond = await call<DesktopSession>("session.create", { projectId: second.id });
		await call("project.close", { projectId: second.id });
		expect(snapshot().projects.map(project => project.id)).toEqual([first.id, third.id]);
		// A conversation of the closed workspace is not addressable until it reopens.
		await expect(call("session.create", { projectId: second.id })).rejects.toThrow("Workspace is closed");
		await expect(call("session.select", { sessionId: keptInSecond.id })).rejects.toThrow("Workspace is closed");
		await expect(call("history.get", { sessionId: keptInSecond.id })).rejects.toThrow("Workspace is closed");
		// The visible order reorders while the closed slot keeps its place.
		await call("project.reorder", { ids: [third.id, first.id] });
		expect(snapshot().projects.map(project => project.id)).toEqual([third.id, first.id]);

		const restarted = await createHost(dataDir);
		expect(restarted.snapshot().projects.map(project => project.id)).toEqual([third.id, first.id]);
		const reopened = await restarted.call<{ id: string }>("project.open", { path: path.join(directory, "second") });
		expect(reopened.id).toBe(second.id);
		// The retained conversation becomes addressable again with the workspace.
		await restarted.call("session.select", { sessionId: keptInSecond.id });
		expect(restarted.snapshot().projects.map(project => project.id)).toEqual([third.id, reopened.id, first.id]);
	});

	test("a close that lands while a conversation is opening leaves it refused and unlisted", async () => {
		const release = Promise.withResolvers<void>();
		const { call, snapshot, open, directory } = await launch({ beforeCreate: () => release.promise });
		const project = await open("first");
		const pending = call<DesktopSession>("session.create", { projectId: project.id });
		// The construction is parked inside createSession, exactly as a slow SDK load would be.
		await Bun.sleep(50);
		const settled: string[] = [];
		const closing = call("project.close", { projectId: project.id }).then(
			value => {
				settled.push("close");
				return value;
			},
			error => {
				settled.push(`close-failed:${String(error)}`);
				throw error;
			},
		);
		release.resolve();
		// The publication is refused because the workspace is closed by the time it finishes.
		await expect(pending).rejects.toThrow("Workspace is closed");
		await closing;
		expect(snapshot().projects).toHaveLength(0);
		expect(snapshot().sessions).toHaveLength(0);
		// Reopening the same path restores the workspace identity and accepts a new conversation.
		const reopened = await open("first");
		expect(reopened.id).toBe(project.id);
		const fresh = await call<DesktopSession>("session.create", { projectId: reopened.id });
		expect(snapshot().sessions.map(session => session.id)).toEqual([fresh.id]);
		// Nothing was deleted on disk while the close raced the open.
		await expect(fs.stat(path.join(directory, "first"))).resolves.toBeTruthy();
	}, 30000);

	test("a reopen issued with a close still resolves into one usable workspace", async () => {
		const { call, snapshot, open } = await launch();
		const project = await open("first");
		const kept = await call<DesktopSession>("session.create", { projectId: project.id });
		// Both requests touch the same catalog entry and are dispatched concurrently, so only
		// serializing them per workspace keeps the reopen from being undone by the close.
		const settled: string[] = [];
		const closing = call("project.close", { projectId: project.id }).then(value => {
			settled.push("close");
			return value;
		});
		const reopening = call<DesktopProject>("project.open", { path: project.path }).then(value => {
			settled.push("open");
			return value;
		});
		await closing;
		const reopened = await reopening;
		expect(settled).toEqual(["close", "open"]);
		// The reopen wins: one listed workspace, nothing closed behind it, nothing duplicated.
		expect(reopened.id).toBe(project.id);
		expect(snapshot().projects.map(item => item.id)).toEqual([project.id]);
		expect(snapshot().sessions.map(session => session.id)).toEqual([kept.id]);
		// The restored workspace is usable, which it would not be if the close's flag survived.
		await call("session.select", { sessionId: kept.id });
		await call<DesktopSession>("session.create", { projectId: reopened.id });
		expect(snapshot().sessions).toHaveLength(2);
	}, 30000);

	test("rejects an order that is not a full permutation of the current items", async () => {
		const { call, open } = await launch();
		const first = await open("first");
		const second = await open("second");
		await expect(call("project.reorder", { ids: [first.id] })).rejects.toThrow("Invalid project order");
		await expect(call("project.reorder", { ids: [first.id, first.id] })).rejects.toThrow("Invalid project order");
		const session = await call<DesktopSession>("session.create", { projectId: first.id });
		await expect(call("session.reorder", { projectId: first.id, ids: [session.id, "missing"] })).rejects.toThrow(
			"Invalid session order",
		);
		await expect(call("project.close", { projectId: crypto.randomUUID() })).rejects.toThrow("Project not found");
		expect(second.id).toBeTruthy();
	});
});
