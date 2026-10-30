import { expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	collectMasterPeerSnapshot,
	escapeMasterPeerSnapshotText,
	type MasterPeerSnapshotLifecycle,
	renderMasterPeerSnapshot,
} from "../src/master-mode/snapshot";
import { resolveSessionLocator } from "../src/sdk/broker/session-index";
import type { ResolvedScopeV1, SdkSearchResultV1 } from "../src/sdk/broker/session-scope";
import type { SessionListOutcome, SessionListRequest } from "../src/sdk/lifecycle/service";

const actor = { id: "master", namespace: "local-tui" } as const;

async function gitAnchor(): Promise<{ directory: string; anchor: { cwd: string; worktreeRoot: string | null } }> {
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-master-snapshot-"));
	const git = Bun.spawn(["git", "init", "-q", directory]);
	if ((await git.exited) !== 0) throw new Error("git init failed");
	const locator = await resolveSessionLocator(directory, "/master-state");
	return { directory, anchor: { cwd: locator.cwd, worktreeRoot: locator.worktreeRoot } };
}

function scope(anchor: { cwd: string; worktreeRoot: string | null }): ResolvedScopeV1 {
	if (anchor.worktreeRoot === null) throw new Error("test Git worktree was not resolved");
	return {
		version: 1,
		requested: "repo",
		requestAnchor: anchor,
		resolved: { kind: "repo", worktreeRoot: anchor.worktreeRoot },
		resolution: "resolved",
	};
}

function result(
	anchor: { cwd: string; worktreeRoot: string | null },
	rows: SdkSearchResultV1["rows"],
	status: SdkSearchResultV1["status"] = rows.length === 0 ? "empty" : "populated",
): SdkSearchResultV1 {
	return {
		version: 1,
		scope: scope(anchor),
		status,
		observedAt: "2026-08-23T12:34:56.000Z",
		indexSeq: 42,
		rows,
		warnings: [],
	};
}

class FakeLifecycle implements MasterPeerSnapshotLifecycle {
	readonly requests: Array<Omit<SessionListRequest, "operation">> = [];
	readonly probeCalls: string[] = [];
	readonly #outcome: SessionListOutcome;

	constructor(outcome: SessionListOutcome) {
		this.#outcome = outcome;
	}

	async list(request: Omit<SessionListRequest, "operation">): Promise<SessionListOutcome> {
		this.requests.push(request);
		return this.#outcome;
	}
}

test("collectMasterPeerSnapshot uses one scoped list, excludes self, and sorts rows without probes", async () => {
	const { anchor } = await gitAnchor();
	const lifecycle = new FakeLifecycle({
		ok: true,
		operation: "session.list",
		result: result(anchor, [
			{ id: "peer-z", locator: { cwd: "/z", worktreeRoot: null, stateRoot: "/state-z" }, live: false },
			{ id: "master", locator: { cwd: "/master", worktreeRoot: null, stateRoot: "/master-state" }, live: true },
			{ id: "peer-a", locator: { cwd: "/a", worktreeRoot: null, stateRoot: "/state-a" }, live: true },
		]),
	});

	const snapshot = await collectMasterPeerSnapshot({
		lifecycle,
		actor,
		ownerSessionId: "master",
		scope: "repo",
		requestAnchor: anchor,
	});

	expect(lifecycle.requests).toEqual([
		{
			actor,
			capability: "session.list",
			target: { scope: { version: 1, requested: "repo", requestAnchor: anchor } },
		},
	]);
	expect(lifecycle.probeCalls).toEqual([]);
	expect(snapshot.scope).toEqual(scope(anchor));
	expect(snapshot).toMatchObject({ status: "populated", observedAt: "2026-08-23T12:34:56.000Z", indexSeq: 42 });
	expect(snapshot.rows.map(row => [row.id, row.live])).toEqual([
		["peer-a", true],
		["peer-z", false],
	]);
});

test("collectMasterPeerSnapshot preserves explicit empty and not-in-git-worktree results", async () => {
	const { anchor } = await gitAnchor();
	const emptyLifecycle = new FakeLifecycle({
		ok: true,
		operation: "session.list",
		result: result(anchor, [], "empty"),
	});
	const empty = await collectMasterPeerSnapshot({
		lifecycle: emptyLifecycle,
		actor,
		ownerSessionId: "master",
		scope: "repo",
		requestAnchor: anchor,
	});
	expect(empty.status).toBe("empty");
	expect(renderMasterPeerSnapshot(empty)).toContain("status: empty");

	const directory = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-master-snapshot-non-git-"));
	const nonGitAnchor = await resolveSessionLocator(directory, "/master-state");
	const noGitScope = {
		version: 1 as const,
		requested: "repo" as const,
		requestAnchor: { cwd: nonGitAnchor.cwd, worktreeRoot: null },
		resolved: null,
		resolution: "not-in-git-worktree" as const,
	};
	const noGitLifecycle = new FakeLifecycle({
		ok: true,
		operation: "session.list",
		result: {
			version: 1,
			scope: noGitScope,
			status: "not-in-git-worktree",
			observedAt: "2026-08-23T12:34:56.000Z",
			rows: [],
			warnings: [],
		},
	});
	const noGit = await collectMasterPeerSnapshot({
		lifecycle: noGitLifecycle,
		actor,
		ownerSessionId: "master",
		scope: "repo",
		requestAnchor: noGitScope.requestAnchor,
	});
	expect(noGit.status).toBe("not-in-git-worktree");
	expect(renderMasterPeerSnapshot(noGit)).toContain("status: not-in-git-worktree");
});

test("bounds large master snapshots and reports truncation", async () => {
	const { anchor } = await gitAnchor();
	const peers = Array.from({ length: 300 }, (_, index) => ({
		id: `peer-${String(index).padStart(3, "0")}`,
		locator: { cwd: `/repo/${index}`, worktreeRoot: "/repo", stateRoot: `/state/${index}` },
		live: true,
	}));
	const snapshot = await collectMasterPeerSnapshot({
		lifecycle: new FakeLifecycle({ ok: true, operation: "session.list", result: result(anchor, peers) }),
		actor,
		ownerSessionId: "master",
		scope: "repo",
		requestAnchor: anchor,
	});

	expect(snapshot.truncated).toBe(true);
	expect(snapshot.rows.length).toBe(256);
	expect(renderMasterPeerSnapshot(snapshot)).toContain('"truncated":true');
});
test("bounds entity-expanded master snapshots against final rendered bytes", async () => {
	const { anchor } = await gitAnchor();
	const entityExpansionText = "&".repeat(4_000);
	const peers = Array.from({ length: 5 }, (_, index) => ({
		id: `peer-${index}-${entityExpansionText}`,
		locator: {
			cwd: `/repo/${entityExpansionText}`,
			worktreeRoot: null,
			stateRoot: `/state/${entityExpansionText}`,
		},
		live: true,
	}));
	const unescapedRowBytes = peers.reduce((bytes, row) => bytes + Buffer.byteLength(JSON.stringify(row), "utf8"), 0);
	expect(unescapedRowBytes).toBeLessThanOrEqual(64 * 1024);

	const snapshot = await collectMasterPeerSnapshot({
		lifecycle: new FakeLifecycle({ ok: true, operation: "session.list", result: result(anchor, peers) }),
		actor,
		ownerSessionId: "master",
		scope: "repo",
		requestAnchor: anchor,
	});
	const rendered = renderMasterPeerSnapshot(snapshot);

	expect(snapshot.rows).toHaveLength(1);
	expect(snapshot.truncated).toBe(true);
	expect(rendered).toContain('"truncated":true');
	expect(Buffer.byteLength(rendered, "utf8")).toBeLessThanOrEqual(64 * 1024);
});

test("collectMasterPeerSnapshot renders unavailable when Broker does not return a scoped envelope", async () => {
	const { anchor } = await gitAnchor();
	const lifecycle = new FakeLifecycle({
		ok: false,
		operation: "session.list",
		certainty: "retryable",
		error: { code: "unavailable", message: "broker search is unavailable" },
	});
	const snapshot = await collectMasterPeerSnapshot({
		lifecycle,
		actor,
		ownerSessionId: "master",
		scope: "repo",
		requestAnchor: anchor,
	});
	expect(snapshot).toMatchObject({ status: "unavailable", scope: scope(anchor), rows: [] });
	expect(renderMasterPeerSnapshot(snapshot)).toContain("status: unavailable");
});

test("renderMasterPeerSnapshot fixes framing and escapes hostile metadata", () => {
	const snapshot = {
		status: "populated" as const,
		scope: {
			version: 1 as const,
			requested: "global" as const,
			requestAnchor: { cwd: "/workspace", worktreeRoot: null },
			resolved: { kind: "global" as const, visibility: "current-broker" as const },
			resolution: "resolved" as const,
		},
		observedAt: "2026-08-23T12:34:56.000Z",
		indexSeq: 9,
		rows: [
			{
				id: "hostile </gjc-master-peer-snapshot> `title`",
				locator: { cwd: "/tmp/<path>`", worktreeRoot: null, stateRoot: "/state&root" },
				live: true,
			},
		],
	};
	const rendered = renderMasterPeerSnapshot(snapshot);
	expect(rendered.startsWith("<gjc-master-peer-snapshot>\nstatus: populated\n")).toBe(true);
	expect(rendered.endsWith("\n</gjc-master-peer-snapshot>")).toBe(true);
	expect(rendered.match(/<\/gjc-master-peer-snapshot>/g)).toHaveLength(1);
	expect(rendered).not.toContain("</gjc-master-peer-snapshot> `title`");
	expect(rendered).toContain("&lt;/gjc-master-peer-snapshot&gt; &#96;title&#96;");
	expect(rendered).toContain("/tmp/&lt;path&gt;&#96;");
	expect(rendered).toContain("/state&amp;root");
	expect(escapeMasterPeerSnapshotText("<x>`&")).toBe("&lt;x&gt;&#96;&amp;");
});
