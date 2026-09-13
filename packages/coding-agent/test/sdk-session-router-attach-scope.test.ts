import { afterEach, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { SessionIndex } from "../src/sdk/broker/session-index";
import { SessionRouter, type SessionRouterClient } from "../src/sdk/router";

const tempDirs: string[] = [];

afterEach(() => {
	for (const directory of tempDirs.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

const SESSION_IDS = ["scoped-session", "unrelated-session"] as const;

/**
 * A Router over two live, indexed sessions whose only observable difference is
 * which of them the caller scoped to. `attached` records the sessions the
 * Router actually opened a transport for: attaching is what registers this
 * process as a live client on that host, so it is the behaviour under test.
 */
async function scopedRouterFixture(sessionIds?: readonly string[]): Promise<{
	attached: string[];
	stop: () => Promise<void>;
}> {
	const repo = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-router-attach-scope-"));
	tempDirs.push(repo);
	const agentDir = path.join(repo, ".gjc", "agent");
	const stateRoot = path.join(repo, ".gjc", "state");
	const endpointDir = path.join(stateRoot, "sdk");
	fs.mkdirSync(endpointDir, { recursive: true });

	const endpointMtimeMs = new Map<string, number>();
	for (const sessionId of SESSION_IDS) {
		const endpointFile = path.join(endpointDir, `${sessionId}.json`);
		fs.writeFileSync(
			endpointFile,
			JSON.stringify({ sessionId, url: `ws://${sessionId}.test`, token: "secret", pid: 42 }),
		);
		endpointMtimeMs.set(sessionId, fs.statSync(endpointFile).mtimeMs);
	}

	const index = {
		open: async () => {},
		refresh: async () => {},
		refreshIfChanged: async () => true,
		listSessions: () => ({
			indexSeq: 1,
			sessions: SESSION_IDS.map(sessionId => ({
				sessionId,
				locator: { cwd: repo, worktreeRoot: null, stateRoot },
				endpointGeneration: 1,
				pid: 42,
				endpointMtimeMs: endpointMtimeMs.get(sessionId),
				live: true,
				indexSeq: 1,
				ambiguous: false,
				terminal: false,
			})),
			warnings: [],
		}),
	} as unknown as SessionIndex;

	const attached: string[] = [];
	const router = new SessionRouter({
		agentDir,
		...(sessionIds === undefined ? {} : { sessionIds }),
		deps: {
			createIndex: () => index,
			createClient: async authority => {
				attached.push(authority.sessionId);
				const client: SessionRouterClient = {
					onFrame: () => () => {},
					onReconnect: () => () => {},
					request: async () => ({ ok: true, generation: 1, lastSeq: 0, events: [] }),
					close: () => {},
				};
				return client;
			},
		},
	});
	await router.start();
	return { attached, stop: async () => await router.stop() };
}

test("an unscoped Router attaches to every live indexed session", async () => {
	const { attached, stop } = await scopedRouterFixture();
	try {
		expect([...attached].sort()).toEqual([...SESSION_IDS].sort());
	} finally {
		await stop();
	}
});

test("a Router scoped to one session never attaches to an unrelated live session", async () => {
	// Every attachment registers this process as a live client on that host,
	// which resets the host's abandonment window. A single-session operation
	// that attached fleet-wide would keep every unrelated host alive for as
	// long as tooling kept polling, so the scope has to be honoured before any
	// transport is opened — not filtered afterwards.
	const { attached, stop } = await scopedRouterFixture(["scoped-session"]);
	try {
		expect(attached).toEqual(["scoped-session"]);
	} finally {
		await stop();
	}
});
