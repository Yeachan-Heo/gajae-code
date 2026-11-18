/**
 * Issue #7565: ACP `session/list` is the saved-conversation-history surface. Saved
 * transcripts older than the broker index retention window must be listed, every
 * listed row must open through the real ACP `session/load` / `session/resume` path,
 * and pagination must stay consistent across index and transcript rows.
 */
import { afterEach, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import type { AgentSideConnection, SessionNotification } from "@agentclientprotocol/sdk";
import packageJson from "../package.json" with { type: "json" };
import { AcpAgent } from "../src/modes/acp/acp-agent";
import { writeBrokerDiscovery } from "../src/sdk/broker/discovery";
import { brokerOwnerForTest } from "../src/sdk/broker/ensure";
import { canonicalSessionCwd, DEFAULT_SESSION_RETENTION_MAX_AGE_MS } from "../src/sdk/broker/session-index";
import { SessionManager } from "../src/session/session-manager";

const DAY_MS = 24 * 60 * 60 * 1_000;
const directories: string[] = [];
const brokerDirs: string[] = [];
const servers: Array<{ stop(closeActiveConnections?: boolean): void }> = [];
const restoreEnv: Array<() => void> = [];

afterEach(async () => {
	for (const restore of restoreEnv.splice(0)) restore();
	for (const agentDir of brokerDirs.splice(0)) await brokerOwnerForTest(agentDir)?.stop();
	for (const server of servers.splice(0)) server.stop(true);
	for (const directory of directories.splice(0)) await fs.rm(directory, { recursive: true, force: true });
});

async function tempRoot(prefix: string): Promise<{ root: string; agentDir: string; cwd: string }> {
	const root = await fs.mkdtemp(path.join(tmpdir(), prefix));
	directories.push(root);
	const cwd = path.join(root, "repo");
	await fs.mkdir(cwd, { recursive: true });
	return { root, agentDir: path.join(root, "agent"), cwd };
}

/** Write a real managed transcript for `cwd` and backdate its last activity. */
async function saveTranscript(
	cwd: string,
	agentDir: string,
	options: { prompt: string; mtimeMs: number; title?: string },
): Promise<{ sessionId: string; file: string }> {
	const manager = SessionManager.create(cwd, SessionManager.managedDestination(cwd, agentDir));
	manager.appendMessage({ role: "user", content: options.prompt, timestamp: options.mtimeMs });
	await manager.ensureOnDisk();
	if (options.title) await manager.setSessionName(options.title, "user");
	await manager.flush();
	await manager.close();
	const file = manager.getSessionFile();
	if (!file) throw new Error("Expected a persisted transcript");
	const when = new Date(options.mtimeMs);
	await fs.utimes(file, when, when);
	return { sessionId: manager.getSessionId(), file };
}

function connection(updates: SessionNotification[]): AgentSideConnection {
	return {
		sessionUpdate: async (notification: SessionNotification) => {
			updates.push(notification);
		},
		signal: new AbortController().signal,
		closed: Promise.withResolvers<void>().promise,
	} as unknown as AgentSideConnection;
}

test("session/list lists a transcript older than index retention and session/load + session/resume open it", async () => {
	const { agentDir, cwd } = await tempRoot("gjc-acp-history-load-");
	brokerDirs.push(agentDir);
	// The real ACP path starts its own broker for this agent dir; an inherited
	// attach-only setting from an enclosing gjc session must not forbid that.
	const previousAutostart = process.env.GJC_SDK_BROKER_AUTOSTART;
	delete process.env.GJC_SDK_BROKER_AUTOSTART;
	restoreEnv.push(() => {
		if (previousAutostart === undefined) delete process.env.GJC_SDK_BROKER_AUTOSTART;
		else process.env.GJC_SDK_BROKER_AUTOSTART = previousAutostart;
	});
	const canonicalCwd = await canonicalSessionCwd(cwd);
	const now = Date.now();
	const titled = await saveTranscript(cwd, agentDir, {
		prompt: "first saved prompt",
		title: "Old titled conversation",
		mtimeMs: now - DEFAULT_SESSION_RETENTION_MAX_AGE_MS - 5 * DAY_MS,
	});
	const untitled = await saveTranscript(cwd, agentDir, {
		prompt: "untitled   saved\nprompt",
		mtimeMs: now - DEFAULT_SESSION_RETENTION_MAX_AGE_MS - 40 * DAY_MS,
	});

	const updates: SessionNotification[] = [];
	const acp = new AcpAgent(connection(updates), { agentDir });
	const live = await acp.newSession({ cwd, mcpServers: [] });

	const listed = await acp.listSessions({ cwd });
	expect(listed.nextCursor).toBeUndefined();
	// Live index row first, then the saved transcripts by last activity (newest first).
	expect(listed.sessions.map(session => session.sessionId)).toEqual([
		live.sessionId,
		titled.sessionId,
		untitled.sessionId,
	]);
	expect(listed.sessions.slice(1)).toEqual([
		{
			sessionId: titled.sessionId,
			cwd: canonicalCwd,
			title: "Old titled conversation",
			updatedAt: new Date((await fs.stat(titled.file)).mtimeMs).toISOString(),
		},
		{
			sessionId: untitled.sessionId,
			cwd: canonicalCwd,
			title: "untitled saved prompt",
			updatedAt: new Date((await fs.stat(untitled.file)).mtimeMs).toISOString(),
		},
	]);
	// Without a cwd, every workspace's saved transcripts are part of the history.
	const global = await acp.listSessions({});
	expect(global.sessions.filter(session => session.sessionId !== live.sessionId)).toEqual(listed.sessions.slice(1));

	// The listed rows open through the real ACP load/resume path on the real broker.
	const row = listed.sessions[1]!;
	await acp.loadSession({ sessionId: row.sessionId, cwd: row.cwd, mcpServers: [] });
	const replayed = updates
		.filter(update => update.sessionId === titled.sessionId)
		.map(update => update.update as { sessionUpdate?: string; content?: { type?: string; text?: string } });
	expect(replayed).toContainEqual(
		expect.objectContaining({
			sessionUpdate: "user_message_chunk",
			content: expect.objectContaining({ type: "text", text: "first saved prompt" }),
		}),
	);
	const resumed = await acp.resumeSession({ sessionId: untitled.sessionId, cwd: canonicalCwd, mcpServers: [] });
	expect(resumed.modes?.currentModeId).toBeString();

	// Once opened, each session is indexed and still listed exactly once.
	const relisted = await acp.listSessions({ cwd });
	const ids = relisted.sessions.map(session => session.sessionId);
	expect(new Set(ids).size).toBe(ids.length);
	expect(ids).toEqual(expect.arrayContaining([live.sessionId, titled.sessionId, untitled.sessionId]));
	expect(ids).toHaveLength(3);

	for (const sessionId of [titled.sessionId, untitled.sessionId, live.sessionId])
		await acp.closeSession({ sessionId });
}, 90_000);

type FakeBroker = { agentDir: string; requests: Array<Record<string, unknown>>; sessions: unknown[] };

/** A broker that serves a fixed index; transcripts stay real files under `agentDir`. */
async function fakeIndexBroker(agentDir: string, sessions: unknown[]): Promise<FakeBroker> {
	const token = "acp-history-token";
	const fixture: FakeBroker = { agentDir, requests: [], sessions };
	let server!: { port: number | undefined; upgrade(request: Request): boolean; stop(closeActive?: boolean): void };
	server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		fetch(request) {
			if (new URL(request.url).searchParams.get("token") !== token)
				return new Response("Unauthorized", { status: 401 });
			if (!server.upgrade(request)) return new Response("Upgrade failed", { status: 400 });
		},
		websocket: {
			open(socket) {
				socket.send(JSON.stringify({ type: "broker_hello", protocolVersion: 3, connectionId: "history" }));
			},
			message(socket, raw) {
				const frame = JSON.parse(String(raw)) as Record<string, unknown>;
				fixture.requests.push(frame);
				socket.send(
					JSON.stringify({
						type: "broker_response",
						id: frame.id,
						ok: true,
						result: { sessions: [...fixture.sessions] },
					}),
				);
			},
		},
	});
	servers.push(server);
	await writeBrokerDiscovery(agentDir, {
		version: 1,
		protocolVersion: 3,
		packageGeneration: packageJson.version,
		ownerId: "test-owner",
		pid: process.pid,
		host: "127.0.0.1",
		port: server.port!,
		url: `ws://127.0.0.1:${server.port!}`,
		token,
		startedAt: Date.now(),
		heartbeatAt: Date.now(),
	});
	return fixture;
}

test("session/list pages one consistent snapshot of mixed index and transcript rows", async () => {
	const { agentDir, cwd } = await tempRoot("gjc-acp-history-pages-");
	const canonicalCwd = await canonicalSessionCwd(cwd);
	const base = Date.now() - DEFAULT_SESSION_RETENTION_MAX_AGE_MS - DAY_MS;
	const minute = 60_000;

	// 30 saved transcripts at even minutes, all outside the index retention window.
	const transcripts: Array<{ sessionId: string; file: string; mtimeMs: number }> = [];
	for (let index = 0; index < 30; index++) {
		const mtimeMs = base - index * 2 * minute;
		transcripts.push({ ...(await saveTranscript(cwd, agentDir, { prompt: `saved ${index}`, mtimeMs })), mtimeMs });
	}
	const locator = (at: string) => ({ cwd: at, worktreeRoot: null, stateRoot: path.join(at, ".gjc", "state") });
	// 30 index rows at odd minutes, so index and transcript rows interleave across pages.
	const indexRows: Array<{ sessionId: string; locator: unknown; live: boolean; endpointMtimeMs: number }> = [];
	for (let index = 0; index < 30; index++)
		indexRows.push({
			sessionId: `indexed-${String(index).padStart(2, "0")}`,
			locator: locator(canonicalCwd),
			live: false,
			endpointMtimeMs: base - (index * 2 + 1) * minute,
		});
	// The index also holds transcript #5 (older endpoint): one row, transcript activity wins.
	const shared = transcripts[5]!;
	indexRows.push({
		sessionId: shared.sessionId,
		locator: locator(canonicalCwd),
		live: false,
		endpointMtimeMs: shared.mtimeMs - 90 * DAY_MS,
	});
	// Transcript #7 is indexed under another workspace: the index owns its cwd.
	const elsewhere = transcripts[7]!;
	const foreign = [
		{ sessionId: elsewhere.sessionId, locator: locator("/elsewhere"), live: false, endpointMtimeMs: base },
		{ sessionId: "foreign-0", locator: locator("/elsewhere"), live: true, endpointMtimeMs: base + minute },
	];
	const broker = await fakeIndexBroker(agentDir, [...foreign, ...indexRows]);
	const acp = new AcpAgent(connection([]), { agentDir });
	const first = await acp.listSessions({ cwd });
	expect(first.sessions).toHaveLength(50);
	expect(first.nextCursor).toBeString();
	const brokerReadsAfterFirstPage = broker.requests.length;

	// Rows written after the traversal started never shift the remaining pages.
	const late = await saveTranscript(cwd, agentDir, { prompt: "late", mtimeMs: Date.now() });
	broker.sessions.push({
		sessionId: "late-indexed",
		locator: locator(canonicalCwd),
		live: true,
		endpointMtimeMs: Date.now(),
	});

	const second = await acp.listSessions({ cwd, cursor: first.nextCursor });
	expect(second.nextCursor).toBeUndefined();
	// Continuation pages are served from the snapshot: no broker or transcript rescan.
	expect(broker.requests.length).toBe(brokerReadsAfterFirstPage);
	// Retrying a page cursor returns the same page.
	expect(await acp.listSessions({ cwd, cursor: first.nextCursor })).toEqual(second);

	const rows = [...first.sessions, ...second.sessions];
	const expected = [
		...indexRows
			.filter(row => row.sessionId !== shared.sessionId)
			.map(row => ({ sessionId: row.sessionId, at: row.endpointMtimeMs })),
		...transcripts
			.filter(row => row.sessionId !== elsewhere.sessionId)
			.map(row => ({ sessionId: row.sessionId, at: row.mtimeMs })),
	].sort((left, right) => right.at - left.at);
	// 30 index rows + 30 transcripts, minus the shared id (deduped) and the one indexed elsewhere.
	expect(second.sessions).toHaveLength(9);
	expect(new Set(rows.map(row => row.sessionId)).size).toBe(59);
	expect(rows.map(row => row.sessionId)).toEqual(expected.map(row => row.sessionId));
	expect(rows.map(row => row.updatedAt)).toEqual(expected.map(row => new Date(row.at).toISOString()));
	expect(rows.every(row => row.cwd === canonicalCwd)).toBe(true);
	expect(rows.find(row => row.sessionId === transcripts[3]!.sessionId)?.title).toBe("saved 3");
	expect(rows.find(row => row.sessionId === "indexed-03")?.title).toBe("indexed-03");

	// A new traversal sees the late rows first.
	const fresh = await acp.listSessions({ cwd });
	expect(fresh.sessions.slice(0, 2).map(row => row.sessionId)).toEqual(
		expect.arrayContaining(["late-indexed", late.sessionId]),
	);

	await expect(acp.listSessions({ cursor: first.nextCursor })).rejects.toMatchObject({ code: "invalid_input" });
	await expect(acp.listSessions({ cwd, cursor: "50" })).rejects.toMatchObject({ code: "invalid_input" });
});
