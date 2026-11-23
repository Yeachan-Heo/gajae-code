import { afterEach, beforeEach, expect, test, vi } from "bun:test";
import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { setModelPresetRegistryDisabled } from "@gajae-code/coding-agent/config/model-preset-registry";
import { ModelRegistry } from "@gajae-code/coding-agent/config/model-registry";
import * as sdk from "@gajae-code/coding-agent/sdk";
import { type CreateAgentSessionResult, createAgentSession } from "@gajae-code/coding-agent/sdk";
import { SessionManager } from "@gajae-code/coding-agent/session/session-manager";
import { getAgentDir, getSessionsDir, setAgentDir } from "@gajae-code/utils";
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
let previousAgentDir: string;
const cleanups: Array<() => Promise<void>> = [];
beforeEach(() => {
	environment = { ...process.env };
	previousAgentDir = getAgentDir();
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
		setAgentDir(previousAgentDir);
	}
});

async function waitForEntry(entered: Promise<void>, operation: Promise<unknown>): Promise<void> {
	const expired = Promise.withResolvers<never>();
	const timer = setTimeout(() => expired.reject(new Error("Deferred SDK operation did not enter")), 2_000);
	try {
		await Promise.race([
			entered,
			operation.then(() => {
				throw new Error("SDK operation settled before entering the deferred attachment");
			}),
			expired.promise,
		]);
	} finally {
		clearTimeout(timer);
	}
}

async function fixture() {
	const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "gjc-desktop-discovery-")));
	const dataDir = path.join(directory, "app");
	const agentDir = path.join(dataDir, "agent");
	const projectDir = path.join(directory, "project");
	await fs.mkdir(projectDir);
	await fs.mkdir(agentDir, { recursive: true, mode: 0o700 });
	process.env.GJC_CODING_AGENT_DIR = agentDir;
	setAgentDir(agentDir);
	await setModelPresetRegistryDisabled({ agentDir, disabled: true });
	const frames: DesktopFrame[] = [];
	const created: CreateAgentSessionResult[] = [];
	const managers: SessionManager[] = [];
	// The broker's answers: transcript ids a live process holds open, and how an idle-only close
	// of one is answered. The app must never ask for any other kind of close.
	const liveOwners = new Set<string>();
	const closeRequests: string[] = [];
	const broker = {
		closeAnswer: "closed" as "closed" | "busy" | "close_refused" | "invalid_input" | "not_found" | "unreachable",
	};
	const liveOwnerClient = {
		global: async (operation: string, input: Record<string, unknown>) => {
			if (operation === "session.close") {
				const sessionId = String(input.sessionId);
				closeRequests.push(sessionId);
				if (input.ifIdle !== true) throw new Error("The app asked for a close that is not idle-only");
				if (broker.closeAnswer === "unreachable") throw new Error("broker connection reset");
				if (broker.closeAnswer !== "closed")
					return { ok: false, error: { code: broker.closeAnswer, message: "The owner was not closed." } };
				liveOwners.delete(sessionId);
				return { ok: true, result: { sessionId } };
			}
			return {
				ok: true,
				result: {
					indexSeq: 1,
					sessions: [...liveOwners].map(sessionId => ({ sessionId, live: true })),
					warnings: [],
				},
			};
		},
	};
	const createHost = () =>
		new DesktopHost({
			dataDir,
			emit: frame => frames.push(frame),
			createSession: async options => {
				const result = await createAgentSession({ ...options, extensions: [] });
				created.push(result);
				return result;
			},
			liveOwnerClient,
		});
	let host = createHost();
	cleanups.push(async () => {
		await host.close();
		await Promise.all(created.map(result => result.session.awaitDisposeCompletion()));
		for (const manager of managers) await manager.close();
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
	const persist = async (title: string, cwd = projectDir, keepOpen = false, turns = 1, turnSize = 0) => {
		await fs.mkdir(cwd, { recursive: true });
		const manager = SessionManager.create(cwd, SessionManager.managedDestination(cwd, agentDir));
		managers.push(manager);
		for (let turn = 0; turn < turns; turn++)
			manager.appendMessage({
				role: "user",
				content: [
					{ type: "text", text: `Message${turns > 1 ? ` ${turn}` : ""} for ${title}${"x".repeat(turnSize)}` },
				],
				timestamp: Date.now(),
			});
		await manager.setSessionName(title, "user");
		await manager.ensureOnDisk();
		await manager.flush();
		const file = manager.getSessionFile();
		if (!file) throw new Error("Missing persisted session");
		const id = manager.getSessionId();
		const bytes = await Bun.file(file).text();
		if (!keepOpen) await manager.close();
		return { id, file, bytes };
	};
	const catalogFile = path.join(dataDir, "catalog.json");
	const restart = async () => {
		await host.close();
		await Promise.all(created.map(result => result.session.awaitDisposeCompletion()));
		host = createHost();
		await host.initialize();
	};
	return {
		call,
		persist,
		created,
		dataDir,
		projectDir,
		agentDir,
		snapshot: () => host.snapshot(),
		frames,
		/** Waits for the workspace refresh a bootstrap started in the background. */
		refreshed: () => host.workspacesRefreshed(),
		restart,
		liveOwners,
		closeRequests,
		broker,
		/** The saved catalog's rows, as written. */
		savedRows: async (): Promise<Array<Record<string, unknown>>> =>
			((await Bun.file(catalogFile).json()) as { sessions: Array<Record<string, unknown>> }).sessions,
		/** Waits until the saved catalog's first row carries this leftover-owner note (or none). */
		noteSaved: async (expected: number | undefined) => {
			for (let attempt = 0; attempt < 200; attempt++) {
				const rows = ((await Bun.file(catalogFile).json()) as { sessions: Array<Record<string, unknown>> })
					.sessions;
				if (rows[0]?.leftoverOwner === expected) return;
				await Bun.sleep(10);
			}
			throw new Error(`The saved owner note never became ${String(expected)}`);
		},
		/** Restarts the Host on exactly this catalog. */
		restartWithCatalog: async (catalog: unknown) => {
			await host.close();
			await Promise.all(created.map(result => result.session.awaitDisposeCompletion()));
			await Bun.write(catalogFile, JSON.stringify(catalog));
			host = createHost();
			await host.initialize();
		},
		/**
		 * Restarts the Host on a catalog whose terminal conversations are saved the way an earlier
		 * build saved them: a bare reference with `managed: true` and no transcript path.
		 */
		restartOnEarlierCatalog: async (ids: string[]) => {
			await host.close();
			await Promise.all(created.map(result => result.session.awaitDisposeCompletion()));
			const catalog = (await Bun.file(catalogFile).json()) as { sessions: Array<Record<string, unknown>> };
			catalog.sessions = catalog.sessions.map(row =>
				ids.includes(String(row.id))
					? {
							id: row.id,
							projectId: row.projectId,
							title: row.title,
							starred: row.starred,
							managed: true,
							...(row.createdAt === undefined ? {} : { createdAt: row.createdAt }),
						}
					: row,
			);
			await Bun.write(catalogFile, JSON.stringify(catalog));
			host = createHost();
			await host.initialize();
		},
	};
}

test("discovers exact-project SDK sessions in creation order without opening or modifying them", async () => {
	const h = await fixture();
	const first = await h.persist("First terminal conversation");
	const second = await h.persist("Second terminal conversation");
	await h.persist("Nested project", path.join(h.projectDir, "nested"));
	await h.persist("Sibling project", path.join(h.projectDir, "..", "sibling"));
	// A transcript under the project's own `.gjc` is listed by the SDK, but it lies outside the
	// shared store the app reads and writes rows through, so it is not offered as a row.
	const local = SessionManager.create(
		h.projectDir,
		SessionManager.explicitDestination(path.join(h.projectDir, ".gjc", "sessions")),
	);
	local.appendMessage({ role: "user", content: [{ type: "text", text: "project-local" }], timestamp: Date.now() });
	await local.ensureOnDisk();
	await local.flush();
	const localId = local.getSessionId();
	await local.close();
	// A project-local candidate with a foreign header is not authority for this project.
	await Bun.write(
		path.join(h.projectDir, ".gjc", "sessions", "foreign.jsonl"),
		`${JSON.stringify({
			type: "session",
			version: 3,
			id: crypto.randomUUID(),
			cwd: path.dirname(h.projectDir),
			timestamp: new Date().toISOString(),
		})}\n`,
	);
	const project = await h.call<DesktopProject>("project.open", { path: h.projectDir });
	expect(h.snapshot().sessions.map(session => [session.id, session.projectId, session.title])).toEqual([
		[first.id, project.id, "First terminal conversation"],
		[second.id, project.id, "Second terminal conversation"],
	]);
	const listed = await sdk.listEmbeddedProjectSessions({
		cwd: project.path,
		agentDir: h.agentDir,
		directory: path.join(h.dataDir, "sessions", project.id),
	});
	expect(listed.managed.map(session => session.id)).toContain(localId);
	expect(h.created).toHaveLength(0);
	// The same kind of row the app creates: the app writes it once it is used, so it offers
	// Disconnect and Connect for it like any other.
	expect(h.snapshot().sessions.map(session => session.connection)).toEqual([
		{ state: "connected" },
		{ state: "connected" },
	]);
	expect(await Bun.file(first.file).text()).toBe(first.bytes);
	expect(await Bun.file(second.file).text()).toBe(second.bytes);
	// The catalog names each transcript relative to the shared store, never by an absolute path.
	const rows = await h.savedRows();
	expect(rows.map(row => [row.id, row.sessionId, row.scope, row.managed])).toEqual([
		[first.id, first.id, "managed", undefined],
		[second.id, second.id, "managed", undefined],
	]);
	const sessionsRoot = await fs.realpath(getSessionsDir(h.agentDir));
	expect(rows.map(row => path.join(sessionsRoot, String(row.file)))).toEqual([
		await fs.realpath(first.file),
		await fs.realpath(second.file),
	]);
	const catalog = await Bun.file(path.join(h.dataDir, "catalog.json")).text();
	expect(catalog).not.toContain(first.file);
	expect(JSON.stringify(h.snapshot().sessions)).not.toContain(h.agentDir);
});

test("refreshes an existing registration idempotently and preserves desktop-owned sessions", async () => {
	const h = await fixture();
	const first = await h.persist("Terminal conversation");
	const project = await h.call<DesktopProject>("project.open", { path: h.projectDir });
	const desktop = await h.call<DesktopSession>("session.create", { projectId: project.id });
	const second = await h.persist("New terminal conversation");
	const reopened = await h.call<DesktopProject>("project.open", { path: h.projectDir });
	await h.call("project.open", { path: h.projectDir });
	expect(reopened.id).toBe(project.id);
	expect(h.snapshot().sessions.map(session => session.id)).toEqual([first.id, desktop.id, second.id]);
	expect(h.created).toHaveLength(1);
	const selected = await h.call<DesktopSession>("session.select", { sessionId: desktop.id });
	expect(selected.id).toBe(desktop.id);
});

test("bootstrap discovers a conversation the terminal created after the project was opened", async () => {
	const h = await fixture();
	const first = await h.persist("Before the project was opened");
	await h.call<DesktopProject>("project.open", { path: h.projectDir });
	const second = await h.persist("Created in the terminal later");
	await h.call<DesktopSnapshot>("bootstrap");
	// The refresh runs after bootstrap answers; its snapshot frame carries the new row.
	await h.refreshed();
	expect(h.snapshot().sessions.map(session => [session.id, session.title])).toEqual([
		[first.id, "Before the project was opened"],
		[second.id, "Created in the terminal later"],
	]);
	expect(h.created).toHaveLength(0);
	expect(await Bun.file(second.file).text()).toBe(second.bytes);
	// Nothing new to add: bootstrap leaves the catalog file untouched.
	const catalog = path.join(h.dataDir, "catalog.json");
	const before = await fs.stat(catalog);
	await h.call("bootstrap");
	await h.refreshed();
	const after = await fs.stat(catalog);
	expect([after.ino, after.mtimeMs]).toEqual([before.ino, before.mtimeMs]);
	await h.restart();
	expect(h.snapshot().sessions.map(session => session.id)).toEqual([first.id, second.id]);
});

test("bootstrap answers at once; a conversation found by the slower workspace listing follows in a snapshot", async () => {
	const h = await fixture();
	const first = await h.persist("Before the project was opened");
	await h.call<DesktopProject>("project.open", { path: h.projectDir });
	const second = await h.persist("Created in the terminal later");
	const listed = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	const list = sdk.listEmbeddedProjectSessions;
	vi.spyOn(sdk, "listEmbeddedProjectSessions").mockImplementation(async options => {
		listed.resolve();
		await release.promise;
		return list(options);
	});
	const from = h.frames.length;
	const answered = h.call<DesktopSnapshot>("bootstrap");
	// The listing is still running, and bootstrap has already answered with what the app knows.
	await listed.promise;
	const snapshot = await Promise.race([answered, Bun.sleep(1_000).then(() => undefined)]);
	expect(snapshot?.sessions.map(session => session.id)).toEqual([first.id]);
	release.resolve();
	await h.refreshed();
	// The new row arrives as a snapshot frame, which the app applies like any other.
	const later = h.frames.slice(from).findLast(frame => frame.type === "snapshot");
	expect(later?.type === "snapshot" && later.snapshot.sessions.map(session => session.id)).toEqual([
		first.id,
		second.id,
	]);
});

test("a diagnostic about a failed refresh names no home directory", async () => {
	const h = await fixture();
	await h.call("project.open", { path: h.projectDir });
	vi.spyOn(sdk, "listEmbeddedProjectSessions").mockRejectedValueOnce(
		new Error(`could not list ${path.join(os.homedir(), "work", "project")}`),
	);
	const logged = vi.spyOn(console, "error").mockImplementation(() => {});
	await h.call("bootstrap");
	await h.refreshed();
	const lines = logged.mock.calls.map(call => call.map(String).join(" "));
	expect(lines.some(line => line.includes("could not refresh a workspace"))).toBe(true);
	expect(lines.some(line => line.includes(os.homedir()))).toBe(false);
	expect(lines.some(line => line.includes(path.join("~", "work", "project")))).toBe(true);
});

test("bootstrap still answers when one workspace cannot be listed", async () => {
	const h = await fixture();
	const first = await h.persist("Listed before");
	await h.call("project.open", { path: h.projectDir });
	await h.persist("Not listed this time");
	const listing = vi
		.spyOn(sdk, "listEmbeddedProjectSessions")
		.mockRejectedValueOnce(new Error("Fixture inventory unavailable"));
	const snapshot = await h.call<DesktopSnapshot>("bootstrap");
	await h.refreshed();
	expect(listing).toHaveBeenCalledTimes(1);
	expect(snapshot.sessions.map(session => session.id)).toEqual([first.id]);
	expect(h.snapshot().sessions.map(session => session.id)).toEqual([first.id]);
});

test("keeps discovered references across close, reopen and host restart", async () => {
	const h = await fixture();
	const first = await h.persist("Before close");
	const project = await h.call<DesktopProject>("project.open", { path: h.projectDir });
	await h.call("project.close", { projectId: project.id });
	expect(h.snapshot().sessions).toEqual([]);
	await h.restart();
	expect(h.snapshot().projects).toEqual([]);
	const second = await h.persist("While closed");
	const reopened = await h.call<DesktopProject>("project.open", { path: h.projectDir });
	expect(reopened.id).toBe(project.id);
	expect(h.snapshot().sessions.map(session => session.id)).toEqual([first.id, second.id]);
	await h.restart();
	expect(h.snapshot().sessions.map(session => session.id)).toEqual([first.id, second.id]);
	expect(h.created).toHaveLength(0);
});

test("serializes discovery refresh with close and reopen of the same project", async () => {
	const h = await fixture();
	const first = await h.persist("Existing conversation");
	const project = await h.call<DesktopProject>("project.open", { path: h.projectDir });
	const second = await h.persist("Discovered during refresh");
	const entered = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	const list = sdk.listEmbeddedProjectSessions;
	const listing = vi.spyOn(sdk, "listEmbeddedProjectSessions").mockImplementation(async (...args) => {
		entered.resolve();
		await release.promise;
		return list(...args);
	});
	const refresh = h.call("project.open", { path: h.projectDir });
	const pending: Promise<unknown>[] = [refresh];
	try {
		await waitForEntry(entered.promise, refresh);
		expect(listing.mock.calls[0]?.[0]).toEqual({
			cwd: project.path,
			agentDir: h.agentDir,
			directory: path.join(h.dataDir, "sessions", project.id),
		});
		const close = h.call("project.close", { projectId: project.id });
		const reopen = h.call<DesktopProject>("project.open", { path: h.projectDir });
		pending.push(close, reopen);
		release.resolve();
		await refresh;
		await close;
		expect((await reopen).id).toBe(project.id);
		expect(h.snapshot().projects.map(item => item.id)).toEqual([project.id]);
		expect(h.snapshot().sessions.map(session => session.id)).toEqual([first.id, second.id]);
		expect(h.created).toHaveLength(0);
	} finally {
		release.resolve();
		await Promise.allSettled(pending);
		listing.mockRestore();
	}
});

test("a conversation created in the terminal opens in the app like one the app created", async () => {
	const h = await fixture();
	const terminal = await h.persist("Started in the terminal");
	await h.call("project.open", { path: h.projectDir });
	// Selecting it opens the app's own writer on the terminal's transcript: no broker, no owner process.
	const selected = await h.call<DesktopSession>("session.select", { sessionId: terminal.id });
	expect(h.created).toHaveLength(1);
	expect(h.created[0]?.session.sessionManager.getSessionFile()).toBe(await fs.realpath(terminal.file));
	expect(selected.messages.map(message => message.text)).toEqual(["Message for Started in the terminal"]);
	expect(selected.connection).toEqual({ state: "connected" });
	expect(selected.controlGeneration).not.toBeNull();
	expect(selected.promptEditing).toBe(true);
	expect(h.closeRequests).toEqual([]);
	// Everything an app-created conversation answers, this one answers too.
	await h.call("session.rename", { sessionId: terminal.id, title: "Renamed in the app" });
	await h.call("session.star", { sessionId: terminal.id, starred: true });
	expect(h.snapshot().sessions.map(session => [session.title, session.starred])).toEqual([
		["Renamed in the app", true],
	]);
	const activity = await h.call<{ activity: { available: boolean } }>("activity.get", { sessionId: terminal.id });
	expect(activity.activity.available).toBe(true);
	await h.call("preferences.get", { sessionId: terminal.id });
	// Disconnect releases it for the terminal, which continues the same transcript; Connect
	// takes it back and lands on what the terminal added.
	expect(await h.call("session.disconnect", { sessionId: terminal.id })).toMatchObject({ disconnected: true });
	const released = crypto.randomUUID();
	await expect(h.call("prompt", { sessionId: terminal.id, text: "while released" }, released)).rejects.toThrow(
		"not connected to the app",
	);
	expect(h.frames.find(frame => frame.type === "response" && frame.id === released)).toMatchObject({
		connectionRefusal: "disconnected",
	});
	// A failure that is not about the connection carries no such type.
	const failed = crypto.randomUUID();
	await expect(h.call("session.select", { sessionId: "not-a-conversation" }, failed)).rejects.toThrow();
	expect(h.frames.find(frame => frame.type === "response" && frame.id === failed)).not.toHaveProperty(
		"connectionRefusal",
	);
	const resumed = await SessionManager.open(
		terminal.file,
		SessionManager.managedDestination(h.projectDir, h.agentDir),
	);
	resumed.appendMessage({
		role: "user",
		content: [{ type: "text", text: "Continued in the terminal" }],
		timestamp: Date.now(),
	});
	await resumed.flush();
	await resumed.close();
	const connected = await h.call<DesktopSession>("session.connect", { sessionId: terminal.id });
	expect(connected.connection).toEqual({ state: "connected" });
	expect(connected.messages.map(message => message.text)).toEqual([
		"Message for Started in the terminal",
		"Continued in the terminal",
	]);
	// The row survives a restart as the same ordinary row, and the terminal sees the new title.
	await h.restart();
	expect(h.snapshot().sessions.map(session => [session.id, session.title, session.connection])).toEqual([
		[terminal.id, "Renamed in the app", { state: "connected" }],
	]);
	const project = h.snapshot().projects[0];
	if (!project) throw new Error("Missing project");
	const listed = await sdk.listEmbeddedProjectSessions({
		cwd: project.path,
		agentDir: h.agentDir,
		directory: path.join(h.dataDir, "sessions", project.id),
	});
	expect(listed.managed.map(session => [session.id, session.title])).toEqual([[terminal.id, "Renamed in the app"]]);
});

test("a terminal-created conversation a terminal has open is read-only in the app until the terminal lets go", async () => {
	const h = await fixture();
	const terminal = await h.persist("Open in a terminal");
	await h.call("project.open", { path: h.projectDir });
	h.liveOwners.add(terminal.id);
	const selected = await h.call<DesktopSession>("session.select", { sessionId: terminal.id });
	// Shown from the transcript; the app opens no writer beside the terminal's.
	expect(selected.connection).toEqual({ state: "elsewhere" });
	expect(selected.messages.map(message => message.text)).toEqual(["Message for Open in a terminal"]);
	expect(selected.controlGeneration).toBeNull();
	expect(h.created).toHaveLength(0);
	const refused = crypto.randomUUID();
	await expect(h.call("prompt", { sessionId: terminal.id, text: "from the app" }, refused)).rejects.toThrow(
		"A terminal (another gjc process) is using this conversation",
	);
	// The refusal is typed, so the app can tell it apart from a failure without matching its text.
	expect(h.frames.find(frame => frame.type === "response" && frame.id === refused)).toMatchObject({
		ok: false,
		deliveryDisposition: "refused",
		connectionRefusal: "elsewhere",
	});
	await expect(h.call("session.delete", { sessionId: terminal.id })).rejects.toThrow("has this conversation open");
	// Reads of panels that need a writer answer as unavailable, not with an error.
	const activity = await h.call<{ activity: { available: boolean } }>("activity.get", { sessionId: terminal.id });
	expect(activity.activity.available).toBe(false);
	expect(await Bun.file(terminal.file).text()).toBe(terminal.bytes);
	// A live terminal is never asked to close: only an owner left by an earlier build is.
	expect(h.closeRequests).toEqual([]);
	h.liveOwners.delete(terminal.id);
	const again = await h.call<DesktopSession>("session.select", { sessionId: terminal.id });
	expect(again.connection).toEqual({ state: "connected" });
	expect(again.controlGeneration).not.toBeNull();
	expect(h.created).toHaveLength(1);
});

test("sorts an older late discovery before newer desktop sessions across refresh and restart", async () => {
	const h = await fixture();
	const older = await h.persist("Older terminal conversation");
	const held = `${older.file}.held`;
	await fs.rename(older.file, held);
	const project = await h.call<DesktopProject>("project.open", { path: h.projectDir });
	const desktop = await h.call<DesktopSession>("session.create", { projectId: project.id });
	await fs.rename(held, older.file);
	await h.call("project.open", { path: h.projectDir });
	expect(h.snapshot().sessions.map(session => session.id)).toEqual([older.id, desktop.id]);
	await h.restart();
	expect(h.snapshot().sessions.map(session => session.id)).toEqual([older.id, desktop.id]);
	expect(await Bun.file(older.file).text()).toBe(older.bytes);
});

test("a workspace closed while a background refresh found its new conversation is not published again", async () => {
	const h = await fixture();
	const other = path.join(path.dirname(h.projectDir), "other-project");
	await fs.mkdir(other);
	const closing = await h.call<DesktopProject>("project.open", { path: h.projectDir });
	await h.call<DesktopProject>("project.open", { path: other });
	const found = await h.persist("Created in the terminal later");
	// The other workspace's listing is held, so the refresh pass outlives the first one's close.
	const release = Promise.withResolvers<void>();
	const list = sdk.listEmbeddedProjectSessions;
	vi.spyOn(sdk, "listEmbeddedProjectSessions").mockImplementation(async options => {
		if (options.cwd === other) await release.promise;
		return list(options);
	});
	await h.call<DesktopSnapshot>("bootstrap");
	for (let i = 0; i < 400 && !h.snapshot().sessions.some(session => session.id === found.id); i++) await Bun.sleep(5);
	expect(h.snapshot().sessions.map(session => session.id)).toContain(found.id);
	// The workspace whose pass changed the catalog closes; its close publishes the snapshot.
	await h.call("project.close", { projectId: closing.id });
	const published = h.frames.filter(frame => frame.type === "snapshot").length;
	release.resolve();
	await h.refreshed();
	// The pass that found the conversation ends after the close: it has nothing left to show.
	expect(h.frames.filter(frame => frame.type === "snapshot")).toHaveLength(published);
	expect(h.snapshot().sessions.map(session => session.id)).not.toContain(found.id);
});

test("late discovery preserves explicit desktop session order across refresh and restart", async () => {
	const h = await fixture();
	const older = await h.persist("Older terminal conversation");
	const held = `${older.file}.held`;
	await fs.rename(older.file, held);
	const project = await h.call<DesktopProject>("project.open", { path: h.projectDir });
	const first = await h.call<DesktopSession>("session.create", { projectId: project.id });
	const second = await h.call<DesktopSession>("session.create", { projectId: project.id });
	await h.call("session.reorder", { projectId: project.id, ids: [second.id, first.id] });
	expect(h.snapshot().sessions.map(session => session.id)).toEqual([second.id, first.id]);

	await fs.rename(held, older.file);
	await h.call("project.open", { path: h.projectDir });
	expect(h.snapshot().sessions.map(session => session.id)).toEqual([older.id, second.id, first.id]);
	// A repeated refresh must not sort the already persisted, explicitly reordered pair.
	await h.call("project.open", { path: h.projectDir });
	expect(h.snapshot().sessions.map(session => session.id)).toEqual([older.id, second.id, first.id]);
	await h.restart();
	expect(h.snapshot().sessions.map(session => session.id)).toEqual([older.id, second.id, first.id]);
	expect(await Bun.file(older.file).text()).toBe(older.bytes);
});

test("a conversation whose transcript the terminal deleted can be removed", async () => {
	const h = await fixture();
	const terminal = await h.persist("Deleted in the terminal");
	await h.call("project.open", { path: h.projectDir });
	expect(h.snapshot().sessions.map(session => session.id)).toEqual([terminal.id]);
	// The terminal removes its own transcript through the SDK.
	await sdk.deleteEmbeddedSession(terminal.file, { managed: true });
	await h.call("session.delete", { sessionId: terminal.id });
	expect(h.snapshot().sessions).toEqual([]);
	await h.call("bootstrap");
	await h.refreshed();
	expect(h.snapshot().sessions).toEqual([]);
	await h.restart();
	expect(h.snapshot().sessions).toEqual([]);
	expect(h.created).toHaveLength(0);
});

test("deleting a terminal-created conversation in the app removes its transcript, and it is never listed again", async () => {
	const h = await fixture();
	const terminal = await h.persist("Deleted in the app");
	const kept = await h.persist("Kept");
	await h.call("project.open", { path: h.projectDir });
	await h.call("session.delete", { sessionId: terminal.id });
	expect(await Bun.file(terminal.file).exists()).toBe(false);
	expect(await Bun.file(kept.file).text()).toBe(kept.bytes);
	expect(h.snapshot().sessions.map(session => session.id)).toEqual([kept.id]);
	// Two refreshes and a restart: neither the removed identity nor a second copy of the kept row.
	for (let pass = 0; pass < 2; pass++) {
		await h.call("bootstrap");
		await h.refreshed();
		expect(h.snapshot().sessions.map(session => session.id)).toEqual([kept.id]);
	}
	await h.restart();
	await h.call("bootstrap");
	await h.refreshed();
	expect(h.snapshot().sessions.map(session => session.id)).toEqual([kept.id]);
	expect((await h.savedRows()).map(row => row.id)).toEqual([kept.id]);
});

test("a window-focus refresh never shrinks a terminal-held conversation being read", async () => {
	const h = await fixture();
	// Long enough that the snapshot's per-row history budget cuts it short.
	const terminal = await h.persist("Owned by the terminal", h.projectDir, false, 100, 9_000);
	await h.call("project.open", { path: h.projectDir });
	h.liveOwners.add(terminal.id);
	const selected = await h.call<DesktopSession>("session.select", { sessionId: terminal.id });
	expect(selected.connection).toEqual({ state: "elsewhere" });
	expect(selected.messages).toHaveLength(100);
	expect(h.snapshot().sessions[0]?.messages.length).toBeLessThan(100);
	const from = h.frames.length;
	await h.call("bootstrap");
	await h.refreshed();
	// Apply the frames in order, as the app does: the snapshot replaces rows, session frames follow.
	let shown: DesktopSession | undefined;
	for (const frame of h.frames.slice(from)) {
		if (frame.type === "snapshot") shown = frame.snapshot.sessions.find(session => session.id === terminal.id);
		if (frame.type === "session" && frame.session.id === terminal.id) shown = frame.session;
	}
	expect(shown?.messages).toHaveLength(100);
	expect(h.created).toHaveLength(0);
});

test("a catalog saved by an earlier build keeps loading, and its terminal references become ordinary rows", async () => {
	const h = await fixture();
	const listed = await h.persist("Still in the store");
	const gone = await h.persist("Removed since");
	await h.call("project.open", { path: h.projectDir });
	await sdk.deleteEmbeddedSession(gone.file, { managed: true });
	await h.restartOnEarlierCatalog([listed.id, gone.id]);
	// Both rows load. Neither has a transcript path yet, so neither offers Disconnect or Connect.
	expect(h.snapshot().sessions.map(session => [session.id, session.connection])).toEqual([
		[listed.id, undefined],
		[gone.id, undefined],
	]);
	await h.call("bootstrap");
	await h.refreshed();
	// The listing places the one whose transcript exists; the other stays a bare reference.
	expect(h.snapshot().sessions.map(session => [session.id, session.connection])).toEqual([
		[listed.id, { state: "connected" }],
		[gone.id, undefined],
	]);
	const rows = await h.savedRows();
	expect(rows.map(row => [row.id, row.sessionId, row.scope, row.managed, row.leftoverOwner])).toEqual([
		[listed.id, listed.id, "managed", undefined, 0],
		[gone.id, undefined, undefined, true, undefined],
	]);
	expect(path.isAbsolute(String(rows[0]?.file))).toBe(false);
	// The placed row opens in the app, with its history.
	const selected = await h.call<DesktopSession>("session.select", { sessionId: listed.id });
	expect(selected.messages.map(message => message.text)).toEqual(["Message for Still in the store"]);
	expect(h.created).toHaveLength(1);
	// The other cannot open, says so in plain words, and can be removed for good.
	for (const method of ["session.select", "history.get", "activity.get", "preferences.get"] as const)
		await expect(h.call(method, { sessionId: gone.id })).rejects.toThrow(
			"its transcript is not in the shared conversation store",
		);
	await h.call("session.delete", { sessionId: gone.id });
	expect(h.snapshot().sessions.map(session => session.id)).toEqual([listed.id]);
	// Refreshing and restarting neither bring it back nor list the placed row twice.
	await h.call("bootstrap");
	await h.refreshed();
	await h.restart();
	await h.call("bootstrap");
	await h.refreshed();
	expect(h.snapshot().sessions.map(session => session.id)).toEqual([listed.id]);
});

test("selecting an earlier build's terminal reference places it at once, before any refresh", async () => {
	const h = await fixture();
	const terminal = await h.persist("Selected right after start");
	await h.call("project.open", { path: h.projectDir });
	await h.restartOnEarlierCatalog([terminal.id]);
	const selected = await h.call<DesktopSession>("session.select", { sessionId: terminal.id });
	expect(selected.connection).toEqual({ state: "connected" });
	expect(selected.messages.map(message => message.text)).toEqual(["Message for Selected right after start"]);
	expect(h.created).toHaveLength(1);
	expect((await h.savedRows()).map(row => [row.id, row.sessionId, row.managed])).toEqual([
		[terminal.id, terminal.id, undefined],
	]);
});

test("an earlier build's terminal reference is neither opened nor removed while the store cannot be listed", async () => {
	const h = await fixture();
	const terminal = await h.persist("Listing unavailable");
	await h.call("project.open", { path: h.projectDir });
	await h.restartOnEarlierCatalog([terminal.id]);
	const listing = vi
		.spyOn(sdk, "listEmbeddedProjectSessions")
		.mockRejectedValue(new Error("Fixture inventory unavailable"));
	for (const method of ["session.select", "session.delete"] as const)
		await expect(h.call(method, { sessionId: terminal.id })).rejects.toThrow(
			"could not look up this conversation's transcript",
		);
	expect(h.snapshot().sessions.map(session => session.id)).toEqual([terminal.id]);
	listing.mockRestore();
	// An inventory that comes back empty without failing proves nothing either: the reference can
	// be removed, but the identity is not released, so the existing transcript is listed again.
	vi.spyOn(sdk, "listEmbeddedProjectSessions").mockResolvedValueOnce({ managed: [], local: [] });
	await h.call("session.delete", { sessionId: terminal.id });
	expect(h.snapshot().sessions).toEqual([]);
	await h.call("bootstrap");
	await h.refreshed();
	expect(h.snapshot().sessions.map(session => [session.id, session.connection])).toEqual([
		[terminal.id, { state: "connected" }],
	]);
	expect(await Bun.file(terminal.file).text()).toBe(terminal.bytes);
	expect(h.created).toHaveLength(0);
});

test("an idle owner an earlier build left behind is closed, so its conversation opens in the app", async () => {
	const h = await fixture();
	const terminal = await h.persist("Attached to by an earlier build");
	await h.call("project.open", { path: h.projectDir });
	await h.restartOnEarlierCatalog([terminal.id]);
	await h.call("bootstrap");
	await h.refreshed();
	expect((await h.savedRows())[0]?.leftoverOwner).toBe(0);
	// That build's broker-started owner is still running, so the broker reports the transcript held.
	h.liveOwners.add(terminal.id);
	const selected = await h.call<DesktopSession>("session.select", { sessionId: terminal.id });
	expect(h.closeRequests).toEqual([terminal.id]);
	expect(selected.connection).toEqual({ state: "connected" });
	expect(h.created).toHaveLength(1);
	// Nobody holds it now: the note is gone, and no later check asks for a close again.
	await h.noteSaved(undefined);
	await h.call("session.disconnect", { sessionId: terminal.id });
	h.liveOwners.add(terminal.id);
	const held = await h.call<DesktopSession>("session.connect", { sessionId: terminal.id });
	expect(held.connection).toEqual({ state: "elsewhere" });
	expect(h.closeRequests).toEqual([terminal.id]);
});

/** An earlier build's reference, placed, with its leftover owner reported live by the broker. */
async function leftoverRow(title: string) {
	const h = await fixture();
	const terminal = await h.persist(title);
	await h.call("project.open", { path: h.projectDir });
	await h.restartOnEarlierCatalog([terminal.id]);
	await h.call("bootstrap");
	await h.refreshed();
	h.liveOwners.add(terminal.id);
	return { h, terminal };
}

test("a definite refusal of the idle close drops the note: whatever holds it is not a leftover owner", async () => {
	for (const answer of ["close_refused", "invalid_input", "not_found"] as const) {
		const { h, terminal } = await leftoverRow(`Owner answers ${answer}`);
		h.broker.closeAnswer = answer;
		const selected = await h.call<DesktopSession>("session.select", { sessionId: terminal.id });
		// A terminal (say) has it: read-only as a terminal's, and never asked to close again.
		expect({ answer, connection: selected.connection }).toEqual({ answer, connection: { state: "elsewhere" } });
		expect(h.closeRequests).toEqual([terminal.id]);
		await h.noteSaved(undefined);
		await h.restart();
		await h.call("session.select", { sessionId: terminal.id });
		expect(h.closeRequests).toEqual([terminal.id]);
		expect(h.created).toHaveLength(0);
	}
});

test("a busy leftover owner is asked again at later checks, at most three times, and named as the app's own", async () => {
	const { h, terminal } = await leftoverRow("Leftover owner still working");
	h.broker.closeAnswer = "busy";
	const selected = await h.call<DesktopSession>("session.select", { sessionId: terminal.id });
	// Not "in use in a terminal": the process is one an earlier app session left behind.
	expect(selected.connection).toEqual({ state: "elsewhere", holder: "earlier-app" });
	const refused = await h.call("prompt", { sessionId: terminal.id, text: "while it works" }).then(
		() => "",
		(error: Error) => error.message,
	);
	expect(refused).toContain("earlier version of the app");
	expect(refused).not.toContain("terminal");
	await h.noteSaved(1);
	await h.call("session.select", { sessionId: terminal.id });
	await h.noteSaved(2);
	// The attempt count survives a restart, so the cap holds across app sessions.
	await h.restart();
	await h.call("session.select", { sessionId: terminal.id });
	expect(h.closeRequests).toEqual([terminal.id, terminal.id, terminal.id]);
	await h.noteSaved(undefined);
	// No fourth attempt, ever.
	await h.call("session.select", { sessionId: terminal.id });
	await h.restart();
	await h.call("session.select", { sessionId: terminal.id });
	expect(h.closeRequests).toHaveLength(3);
	// Once it finishes and lets go, the conversation opens like any other.
	h.liveOwners.delete(terminal.id);
	const free = await h.call<DesktopSession>("session.select", { sessionId: terminal.id });
	expect(free.connection).toEqual({ state: "connected" });
});

test("an idle close with no answer is retried within the same cap, without naming the holder", async () => {
	const { h, terminal } = await leftoverRow("Broker not answering the close");
	h.broker.closeAnswer = "unreachable";
	const selected = await h.call<DesktopSession>("session.select", { sessionId: terminal.id });
	expect(selected.connection).toEqual({ state: "elsewhere" });
	await h.noteSaved(1);
	h.broker.closeAnswer = "closed";
	const again = await h.call<DesktopSession>("session.select", { sessionId: terminal.id });
	expect(again.connection).toEqual({ state: "connected" });
	expect(h.closeRequests).toEqual([terminal.id, terminal.id]);
	await h.noteSaved(undefined);
});

test("a note saved before attempts were counted loads and is used", async () => {
	const { h, terminal } = await leftoverRow("Noted by the first version of the note");
	await h.restart();
	const catalogFile = path.join(h.dataDir, "catalog.json");
	const catalog = (await Bun.file(catalogFile).json()) as { sessions: Array<Record<string, unknown>> };
	catalog.sessions[0]!.leftoverOwner = true;
	await h.restartWithCatalog(catalog);
	const selected = await h.call<DesktopSession>("session.select", { sessionId: terminal.id });
	expect(h.closeRequests).toEqual([terminal.id]);
	expect(selected.connection).toEqual({ state: "connected" });
});

test("an earlier build's reference nobody holds needs no close, and the note is dropped", async () => {
	const h = await fixture();
	const terminal = await h.persist("No owner left");
	await h.call("project.open", { path: h.projectDir });
	await h.restartOnEarlierCatalog([terminal.id]);
	await h.call("bootstrap");
	await h.refreshed();
	const selected = await h.call<DesktopSession>("session.select", { sessionId: terminal.id });
	expect(selected.connection).toEqual({ state: "connected" });
	expect(h.closeRequests).toEqual([]);
	expect((await h.savedRows())[0]?.leftoverOwner).toBeUndefined();
});

test("a conversation in the store's older per-project directory opens in the app, which moves with it", async () => {
	const h = await fixture();
	const terminal = await h.persist("Saved by an older terminal");
	// Older terminals kept a project's transcripts in a directory named after its path.
	const sessionsRoot = await fs.realpath(getSessionsDir(h.agentDir));
	const older = path.join(sessionsRoot, `--${h.projectDir.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`);
	await fs.mkdir(older, { mode: 0o700 });
	const file = path.join(older, path.basename(terminal.file));
	await fs.rename(terminal.file, file);
	await h.call("project.open", { path: h.projectDir });
	expect((await h.savedRows()).map(row => [row.id, row.file])).toEqual([
		[terminal.id, path.relative(sessionsRoot, file)],
	]);
	const selected = await h.call<DesktopSession>("session.select", { sessionId: terminal.id });
	expect(selected.connection).toEqual({ state: "connected" });
	expect(selected.messages.map(message => message.text)).toEqual(["Message for Saved by an older terminal"]);
	// Opening migrates it into the current directory, as the terminal's own resume does; the row
	// follows the transcript, and a refresh lists neither location as a second conversation.
	const opened = h.created[0]?.session.sessionManager.getSessionFile();
	if (!opened) throw new Error("Missing opened transcript");
	expect(path.dirname(opened)).not.toBe(older);
	expect(h.created[0]?.session.sessionId).toBe(terminal.id);
	expect((await h.savedRows()).map(row => [row.id, row.sessionId, row.file])).toEqual([
		[terminal.id, terminal.id, path.relative(sessionsRoot, opened)],
	]);
	await h.call("bootstrap");
	await h.refreshed();
	expect(h.snapshot().sessions.map(session => session.id)).toEqual([terminal.id]);
});

test("a conversation the terminal recorded under a symlinked spelling of the workspace opens and works in the app", async () => {
	const h = await fixture();
	// The terminal was started from a symlink to the workspace (as macOS `/var` is to `/private/var`),
	// so its transcript records that spelling; the app's workspace is the real path.
	const linked = path.join(path.dirname(h.projectDir), "linked-project");
	await fs.symlink(h.projectDir, linked);
	const terminal = await h.persist("Started through a symlink", linked);
	const header = JSON.parse((await Bun.file(terminal.file).text()).split("\n")[0]!) as { cwd: string };
	expect(header.cwd).toBe(linked);
	const project = await h.call<DesktopProject>("project.open", { path: h.projectDir });
	expect(project.path).toBe(h.projectDir);
	expect(h.snapshot().sessions.map(session => session.id)).toEqual([terminal.id]);
	const selected = await h.call<DesktopSession>("session.select", { sessionId: terminal.id });
	expect(selected.connection).toEqual({ state: "connected" });
	expect(h.created).toHaveLength(1);
	expect(h.created[0]?.session.sessionManager.getCwd()).toBe(linked);
	// Every fence that asks whether the session still belongs to this workspace accepts it.
	const copy = selected.messages[0]?.copy;
	if (!copy) throw new Error("The terminal's message offers no copy");
	expect(await h.call<{ text: string }>("message.copyText", { sessionId: terminal.id, ...copy })).toEqual({
		text: "Message for Started through a symlink",
	});
	const completions = await h.call<{ items: unknown[] }>("composer.complete", {
		sessionId: terminal.id,
		sessionGeneration: copy.sessionGeneration,
		text: "/",
		cursor: 1,
	});
	expect(completions.items.length).toBeGreaterThan(0);
	await h.call("session.rename", { sessionId: terminal.id, title: "Renamed through the real path" });
	const fork = await h.call<{ session: DesktopSession }>("session.fork", { sessionId: terminal.id });
	expect(fork.session.messages.map(message => message.text)).toEqual(["Message for Started through a symlink"]);
	expect(await h.call("session.disconnect", { sessionId: terminal.id })).toMatchObject({ disconnected: true });
	expect((await h.call<DesktopSession>("session.connect", { sessionId: terminal.id })).connection).toEqual({
		state: "connected",
	});
	await h.call("session.delete", { sessionId: terminal.id });
	expect(await Bun.file(terminal.file).exists()).toBe(false);
	expect(h.snapshot().sessions.map(session => session.id)).toEqual([fork.session.id]);
});

test.skipIf(process.platform !== "darwin")(
	"a conversation the terminal recorded as /var/... opens, copies and deletes in the /private/... workspace",
	async () => {
		const h = await fixture();
		expect(h.projectDir.startsWith("/private/")).toBe(true);
		// The terminal strips `/private` from its project directory on macOS; the app keeps the real path.
		const terminalSpelling = h.projectDir.slice("/private".length);
		const terminal = await h.persist("Recorded without /private", terminalSpelling);
		const header = JSON.parse((await Bun.file(terminal.file).text()).split("\n")[0]!) as { cwd: string };
		expect(header.cwd).toBe(terminalSpelling);
		await h.call("project.open", { path: h.projectDir });
		const selected = await h.call<DesktopSession>("session.select", { sessionId: terminal.id });
		expect(selected.connection).toEqual({ state: "connected" });
		expect(selected.messages.map(message => message.text)).toEqual(["Message for Recorded without /private"]);
		const history = await h.call<{ messages: DesktopSession["messages"] }>("history.get", {
			sessionId: terminal.id,
		});
		expect(history.messages.map(message => message.text)).toEqual(["Message for Recorded without /private"]);
		const copy = selected.messages[0]?.copy;
		if (!copy) throw new Error("The terminal's message offers no copy");
		expect(await h.call<{ text: string }>("message.copyText", { sessionId: terminal.id, ...copy })).toEqual({
			text: "Message for Recorded without /private",
		});
		await h.call("session.delete", { sessionId: terminal.id });
		expect(await Bun.file(terminal.file).exists()).toBe(false);
		expect(h.snapshot().sessions).toEqual([]);
	},
);
