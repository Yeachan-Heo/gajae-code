import { afterEach, beforeEach, describe, expect, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { setModelPresetRegistryDisabled } from "@gajae-code/coding-agent/config/model-preset-registry";
import { ModelRegistry } from "@gajae-code/coding-agent/config/model-registry";
import { type CreateAgentSessionOptions, createAgentSession } from "@gajae-code/coding-agent/sdk";
import { getAgentDir, setAgentDir } from "@gajae-code/utils";
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

async function launch(options: { beforeCreate?: () => Promise<void> } = {}) {
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-desktop-layout-"));
	const dataDir = path.join(directory, "app");
	await setModelPresetRegistryDisabled({ agentDir: path.join(dataDir, "agent"), disabled: true });
	const frames: DesktopFrame[] = [];
	const host = new DesktopHost({
		dataDir,
		emit: frame => frames.push(frame),
		createSession: async (createOptions: CreateAgentSessionOptions) => {
			await options.beforeCreate?.();
			return createAgentSession(createOptions);
		},
	});
	cleanups.push(async () => {
		await host.close();
		await fs.rm(directory, { recursive: true, force: true });
	});
	const call = async <T>(method: DesktopRequest["method"], params: Record<string, unknown> = {}): Promise<T> => {
		const id = crypto.randomUUID();
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

	test("workspaces and conversations keep an explicit order across restarts", async () => {
		const { call, snapshot, open, dataDir, createHost } = await launch();
		const first = await open("first");
		const second = await open("second");
		const third = await open("third");
		await call("project.reorder", { ids: [third.id, first.id, second.id] });
		expect(snapshot().projects.map(project => project.id)).toEqual([third.id, first.id, second.id]);

		const a = await call<DesktopSession>("session.create", { projectId: first.id });
		const b = await call<DesktopSession>("session.create", { projectId: first.id });
		await call("session.reorder", { projectId: first.id, ids: [b.id, a.id] });
		const ordered = snapshot().sessions.filter(session => session.projectId === first.id);
		expect(ordered.map(session => session.id)).toEqual([b.id, a.id]);
		// Other workspaces are untouched by a per-workspace reorder.
		expect(snapshot().sessions.filter(session => session.projectId === second.id)).toHaveLength(0);
		// The per-conversation order is durable, not a renderer-only arrangement.
		const restarted = await createHost(dataDir);
		expect(restarted.snapshot().projects.map(project => project.id)).toEqual([third.id, first.id, second.id]);
		expect(
			restarted
				.snapshot()
				.sessions.filter(session => session.projectId === first.id)
				.map(session => session.id),
		).toEqual([b.id, a.id]);
	});

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
