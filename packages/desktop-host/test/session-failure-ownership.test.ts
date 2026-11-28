import { afterEach, beforeEach, expect, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { setModelPresetRegistryDisabled } from "@gajae-code/coding-agent/config/model-preset-registry";
import { ModelRegistry } from "@gajae-code/coding-agent/config/model-registry";
import {
	AuthorizationControls,
	type CreateAgentSessionOptions,
	type CreateAgentSessionResult,
	createAgentSession,
	Settings,
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
		observeFrame?: (frame: DesktopFrame) => void;
		createSession?: (options: CreateAgentSessionOptions) => Promise<CreateAgentSessionResult>;
	} = {},
) {
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-desktop-failure-"));
	const dataDir = path.join(directory, "app");
	await setModelPresetRegistryDisabled({ agentDir: path.join(dataDir, "agent"), disabled: true });
	const frames: DesktopFrame[] = [];
	const captures: CreateAgentSessionOptions[] = [];
	const results: CreateAgentSessionResult[] = [];
	const createHost = () =>
		new DesktopHost({
			dataDir,
			emit: frame => {
				options.observeFrame?.(frame);
				frames.push(frame);
			},
			createSession: async createOptions => {
				captures.push(createOptions);
				const result = await (options.createSession ?? createAgentSession)(createOptions);
				results.push(result);
				return result;
			},
		});
	let host = createHost();
	let observedClose: Promise<void> | undefined;
	cleanups.push(async () => {
		const closing = host.close();
		try {
			await closing;
		} catch (error) {
			if (closing !== observedClose) throw error;
		} finally {
			await fs.rm(directory, { recursive: true, force: true });
		}
	});
	const call = async <T>(method: DesktopRequest["method"], params: Record<string, unknown> = {}): Promise<T> => {
		const id = crypto.randomUUID();
		await host.handle(parseRequest(JSON.stringify({ id, method, params })));
		const response = frames.find(frame => frame.type === "response" && frame.id === id);
		if (response?.type !== "response") throw new Error("Missing response");
		if (!response.ok) throw new Error(response.error);
		return response.result as T;
	};
	const reject = async (method: DesktopRequest["method"], params: Record<string, unknown> = {}): Promise<string> => {
		const id = crypto.randomUUID();
		await host.handle(parseRequest(JSON.stringify({ id, method, params })));
		const response = frames.find(frame => frame.type === "response" && frame.id === id);
		if (response?.type !== "response" || response.ok) throw new Error("Expected a rejected request");
		return response.error;
	};
	const open = async () => {
		const projectPath = path.join(directory, "project");
		await fs.mkdir(projectPath, { recursive: true });
		const project = await call<DesktopProject>("project.open", { path: projectPath });
		return call<DesktopSession>("session.create", { projectId: project.id });
	};
	const session = async (sessionId: string) => {
		const snapshot = await call<DesktopSnapshot>("bootstrap");
		return snapshot.sessions.find(item => item.id === sessionId);
	};
	return {
		call,
		reject,
		open,
		session,
		results,
		dataDir,
		close: () => {
			observedClose = host.close();
			return observedClose;
		},
		restart: async () => {
			await host.close();
			host = createHost();
			await call("bootstrap");
		},
	};
}

test("workspace close retires both question owners despite persistent publication failures", async () => {
	let failPublication = false;
	const failedSessions: string[] = [];
	let failedSnapshots = 0;
	const answers: boolean[] = [];
	const { call, reject, open, results, dataDir } = await launch({
		observeFrame: frame => {
			if (!failPublication) return;
			if (frame.type === "session") {
				failedSessions.push(frame.session.id);
				throw new Error("persistent session publisher failure");
			}
			if (frame.type === "snapshot") {
				failedSnapshots++;
				throw new Error("persistent snapshot publisher failure");
			}
		},
		createSession: options =>
			createAgentSession({
				...options,
				extensions: [
					extension => {
						extension.on("session_start", async (_event, context) => {
							answers.push(await context.ui.confirm("Pending close question", "Continue?"));
						});
					},
				],
			}),
	});
	const first = await open();
	const second = await call<DesktopSession>("session.create", { projectId: first.projectId });
	for (const owner of [first, second]) {
		const selected = await call<DesktopSession>("session.select", { sessionId: owner.id });
		expect(selected.question?.title).toBe("Pending close question");
	}
	expect(results).toHaveLength(2);
	const aborts = results.map(result => vi.spyOn(result.session, "abort"));
	const disposals = results.map(result => vi.spyOn(result.session, "dispose"));
	failPublication = true;
	try {
		expect(await reject("project.close", { projectId: first.projectId })).toContain(
			"Workspace close publication and teardown failed",
		);
		expect(failedSessions).toEqual([first.id, second.id]);
		expect(failedSnapshots).toBe(2);
		expect(answers).toEqual([false, false]);
		for (const [index, result] of results.entries()) {
			expect(aborts[index]).toHaveBeenCalledWith({ cause: "session_switch", timeoutMs: 5_000 });
			expect(disposals[index]).toHaveBeenCalled();
			expect(result.session.sessionLifecycle.disposed).toBe(true);
		}
		const catalog: { projects: DesktopProject[] } = await Bun.file(path.join(dataDir, "catalog.json")).json();
		expect(catalog.projects.find(project => project.id === first.projectId)?.closed).toBe(true);
	} finally {
		failPublication = false;
	}
	const snapshot = await call<DesktopSnapshot>("bootstrap");
	expect(snapshot.projects).toEqual([]);
	expect(snapshot.sessions).toEqual([]);
});

test("mandatory shutdown settles both question owners before rejecting persistent publication failures", async () => {
	let failPublication = false;
	const failedSessions: string[] = [];
	const answers: boolean[] = [];
	const { call, open, results, close } = await launch({
		observeFrame: frame => {
			if (failPublication && frame.type === "session") {
				failedSessions.push(frame.session.id);
				throw new Error("persistent shutdown question publisher failure");
			}
		},
		createSession: options =>
			createAgentSession({
				...options,
				extensions: [
					extension => {
						extension.on("session_start", async (_event, context) => {
							answers.push(await context.ui.confirm("Pending shutdown question", "Continue?"));
						});
					},
				],
			}),
	});
	const first = await open();
	const second = await call<DesktopSession>("session.create", { projectId: first.projectId });
	for (const owner of [first, second]) {
		const selected = await call<DesktopSession>("session.select", { sessionId: owner.id });
		expect(selected.question?.title).toBe("Pending shutdown question");
	}
	expect(results).toHaveLength(2);
	const aborts = results.map(result => vi.spyOn(result.session, "abort"));
	const disposals = results.map(result => vi.spyOn(result.session, "dispose"));
	const registryDisposals = vi.spyOn(ModelRegistry.prototype, "dispose");
	const settingsCloses = vi.spyOn(Settings.prototype, "close");
	const authorizationClose = vi.spyOn(AuthorizationControls.prototype, "close");
	const authClose = vi.spyOn(results[0]!.session.modelRegistry.authStorage, "close");
	failPublication = true;
	const closing = close();
	expect(close()).toBe(closing);
	const error: unknown = await closing.catch(error => error);
	expect(error).toBeInstanceOf(AggregateError);
	expect((error as AggregateError).message).toContain("Desktop shutdown failed");
	expect((error as AggregateError).errors).toContainEqual(
		expect.objectContaining({
			errors: [
				expect.objectContaining({ message: "persistent shutdown question publisher failure" }),
				expect.objectContaining({ message: "persistent shutdown question publisher failure" }),
			],
		}),
	);
	expect(failedSessions).toEqual([first.id, second.id]);
	expect(answers).toEqual([false, false]);
	for (const [index, result] of results.entries()) {
		expect(aborts[index]).toHaveBeenCalledWith();
		expect(disposals[index]).toHaveBeenCalled();
		await result.session.awaitDisposeCompletion();
		expect(result.session.sessionLifecycle.disposed).toBe(true);
		expect(registryDisposals.mock.contexts).toContain(result.session.modelRegistry);
		expect(settingsCloses.mock.contexts).toContain(result.session.settings);
	}
	// Include the hidden control owner's dependencies, not just the two SDK borrowers.
	expect(new Set(registryDisposals.mock.contexts).size).toBe(3);
	expect(new Set(settingsCloses.mock.contexts).size).toBe(3);
	expect(authorizationClose).toHaveBeenCalledTimes(1);
	expect(authClose).toHaveBeenCalledTimes(1);
	expect(close()).toBe(closing);
	await expect(close()).rejects.toBe(error);
	expect(failedSessions).toEqual([first.id, second.id]);
	expect(authorizationClose).toHaveBeenCalledTimes(1);
	expect(authClose).toHaveBeenCalledTimes(1);
});

test("shutdown owns cold prompt admission and refuses construction after close begins", async () => {
	const { call, reject, open, restart, results, dataDir } = await launch();
	const created = await open();
	await restart();
	const constructed = results.length;
	const entered = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	const begin = DeliveryJournal.prototype.begin;
	let deliveryId: string | undefined;
	const admission = vi.spyOn(DeliveryJournal.prototype, "begin").mockImplementation(async function (
		this: DeliveryJournal,
		id,
		sessionId,
	) {
		deliveryId = id;
		entered.resolve();
		await release.promise;
		return begin.call(this, id, sessionId);
	});
	const prompting = reject("prompt", { sessionId: created.id, text: "must not construct a late owner" });
	await entered.promise;
	let closed = false;
	const closing = call("shutdown").then(() => {
		closed = true;
	});
	try {
		await Bun.sleep(25);
		expect(closed).toBe(false);
		expect(results).toHaveLength(constructed);
	} finally {
		release.resolve();
	}
	expect(await prompting).toContain("Host is closed");
	await closing;
	admission.mockRestore();
	expect(closed).toBe(true);
	expect(results).toHaveLength(constructed);
	const persisted: { receipts: Array<{ id: string; disposition: string }> } = await Bun.file(
		path.join(dataDir, "deliveries.json"),
	).json();
	expect(persisted.receipts).toContainEqual(expect.objectContaining({ id: deliveryId, disposition: "refused" }));
});

// A refused administrative operation is an operation error, not a failed
// conversation: the transcript and the session status must stay untouched.
test("a refused non-turn operation leaves the conversation idle", async () => {
	const { reject, open, session } = await launch();
	const created = await open();
	expect(created.status).toBe("idle");

	expect(await reject("session.rename", { sessionId: created.id, title: "   " })).toContain("Invalid title");

	const after = await session(created.id);
	expect(after?.status).toBe("idle");
	expect(after?.error).toBeUndefined();
	expect(after?.title).toBe(created.title);
});

// A refusal is not a failure: retry() answers false when it declines to start a
// turn, and that must leave the conversation exactly as it was.
test("a refused retry leaves the conversation idle", async () => {
	const { reject, open, session, results } = await launch();
	const created = await open();
	vi.spyOn(results[0]!.session, "retry").mockResolvedValue(false);

	expect(await reject("session.retry", { sessionId: created.id })).toContain("Session cannot be retried");

	const after = await session(created.id);
	expect(after?.status).toBe("idle");
	expect(after?.error).toBeUndefined();
});

// A forwarded prompt rejected before admission has not started a turn.
test("a pre-run forwarded prompt refusal leaves the conversation idle", async () => {
	const { reject, open, session, results } = await launch();
	const created = await open();
	vi.spyOn(results[0]!.session, "prompt").mockRejectedValue(new Error("forwarded prompt failed"));

	expect(await reject("command.run", { sessionId: created.id, text: "plain forwarded prompt" })).toContain(
		"forwarded prompt failed",
	);

	const after = await session(created.id);
	expect(after?.status).toBe("idle");
	expect(after?.error).toBeUndefined();
	expect(after?.errorOwner).toBeUndefined();
});

// An immediate rejection before the SDK accepts a run is a refusal, not a failed turn.
test("a pre-run prompt refusal leaves the conversation idle", async () => {
	const { reject, open, session, results } = await launch();
	const created = await open();
	vi.spyOn(results[0]!.session, "prompt").mockRejectedValue(new Error("provider unavailable"));

	expect(await reject("prompt", { sessionId: created.id, text: "hello" })).toContain("provider unavailable");

	const after = await session(created.id);
	expect(after?.status).toBe("idle");
	expect(after?.error).toBeUndefined();
	expect(after?.errorOwner).toBeUndefined();
});
