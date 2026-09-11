import { expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { PublicCommandFailure, renderPublicCommandFailure } from "../src/cli/public-command-errors";
import { type SdkSearchResultV1, sdkSearchResultV1 } from "../src/sdk/broker/session-scope";
import { mergeProbedSearchRows, renderSdkSearchTable, runSdkSearch } from "../src/sdk/cli/session-cli";
import { type SessionLifecycleClient, SessionLifecycleService } from "../src/sdk/lifecycle/service";

const temp = () => fs.mkdtemp(path.join(process.env.TMPDIR ?? "/tmp", "gjc-sdk-search-"));

function envelope(
	root: string,
	status: SdkSearchResultV1["status"],
	rows: SdkSearchResultV1["rows"] = [],
): SdkSearchResultV1 {
	return {
		version: 1,
		scope: {
			version: 1,
			requested: "repo",
			requestAnchor: { cwd: root, worktreeRoot: root },
			resolved: { kind: "repo", worktreeRoot: root },
			resolution: "resolved",
		},
		status,
		observedAt: "2026-08-23T12:00:00.000Z",
		rows,
		warnings: [],
		...(status === "unavailable" ? { error: { code: "unavailable", message: "broker search is unavailable" } } : {}),
	};
}

class Client implements SessionLifecycleClient {
	response: unknown;
	constructor(response: unknown) {
		this.response = response;
	}
	async global(): Promise<unknown> {
		return this.response;
	}
}

test("search renders populated and empty envelopes with a preamble and no endpoint credential", async () => {
	const root = await temp();
	try {
		const row = { id: "session-1", locator: { cwd: root, worktreeRoot: root, stateRoot: "/state" }, live: true };
		const populated = envelope(root, "populated", [row]);
		const output = renderSdkSearchTable({ ...populated, rows: [{ ...row, probe: "reachable" }] });
		expect(output).toStartWith("Scope requested: repo\nScope resolved:");
		expect(output).toContain("Status: populated");
		expect(output).toContain("reachable");
		expect(output).not.toContain("fixture-endpoint-token");
		expect(renderSdkSearchTable(envelope(root, "empty"))).toContain("Status: empty");
	} finally {
		await fs.rm(root, { recursive: true, force: true });
	}
});

test("search text strips terminal controls and Unicode line separators", () => {
	const result = envelope("/repo", "populated", [
		{
			id: "session-\u001b[31m\u2028one",
			locator: { cwd: "/repo/\u0007cwd", worktreeRoot: "/repo", stateRoot: "/state" },
			live: true,
			probe: "reachable",
		},
	]);
	const output = renderSdkSearchTable({
		...result,
		observedAt: "2026-08-23T12:00:00.000Z\u2029later",
		cursor: "cursor\u001b[0m\u2028next",
	});
	expect(output).not.toContain("\u001b");
	expect(output).not.toContain("\u2028");
	expect(output).not.toContain("\u2029");
	expect(output).not.toContain("\u0007");
});

test("search returns exactly the scoped envelope and probes only populated filtered rows", async () => {
	const root = await temp();
	const git = Bun.spawn(["git", "init", "-q", root]);
	await git.exited;
	try {
		const row = { id: "filtered", locator: { cwd: root, worktreeRoot: root, stateRoot: "/state" }, live: true };
		const result = envelope(root, "populated", [row]);
		let probes = 0;
		const search = await runSdkSearch(
			{ repo: root },
			() => {
				const service = new SessionLifecycleService(new Client({ ok: true, result: {} }));
				return Object.assign(service, {
					scopedList: async () => ({ ok: true as const, operation: "session.list" as const, result }),
				});
			},
			async (_agentDir, value) => {
				probes++;
				return { ...value, rows: value.rows.map(candidate => ({ ...candidate, probe: "reachable" })) };
			},
		);
		expect(search.exitCode).toBe(0);
		expect(search.result).toEqual({ ...result, rows: [{ ...row, probe: "reachable" }] });
		expect(probes).toBe(1);
	} finally {
		await fs.rm(root, { recursive: true, force: true });
	}
});

test("preserves scoped rows beyond the bounded probe budget", () => {
	const rows = Array.from({ length: 125 }, (_, index) => ({
		id: `session-${index}`,
		locator: { cwd: "/repo", worktreeRoot: "/repo", stateRoot: "/state" },
		live: index < 100,
	}));
	const probed = rows.slice(0, 100).map(row => ({ ...row, probe: "reachable" as const }));

	const merged = mergeProbedSearchRows(rows, probed);

	expect(merged).toHaveLength(125);
	expect(merged.slice(0, 100).every(row => row.probe === "reachable")).toBe(true);
	expect(merged.slice(100)).toEqual(rows.slice(100));
});

test("returns one bounded scoped broker page with a resumable cursor", async () => {
	const root = await temp();
	const git = Bun.spawn(["git", "init", "-q", root]);
	await git.exited;
	try {
		const rows = Array.from({ length: 5 }, (_, index) => ({
			sessionId: `session-${index}`,
			live: false,
			locator: { cwd: root, worktreeRoot: root, stateRoot: "/state" },
		}));
		const scope = envelope(root, "empty").scope;
		const inputs: Record<string, unknown>[] = [];
		class PagedClient implements SessionLifecycleClient {
			async global(_operation: string, input: Record<string, unknown>): Promise<unknown> {
				inputs.push({ ...input });
				const offset = input.cursor === "cursor-1" ? 2 : 0;
				return {
					ok: true,
					result: {
						indexSeq: 7,
						sessions: rows.slice(offset, offset + 2),
						warnings: [],
						scope,
						observedAt: "2026-08-23T12:00:00.000Z",
						continuationCursor: offset === 0 ? "cursor-1" : "cursor-2",
					},
				};
			}
		}
		const createService = () => new SessionLifecycleService(new PagedClient());
		const first = await runSdkSearch({ repo: root, limit: 2 }, createService, async (_agentDir, value) => value);
		const resumed = await runSdkSearch(
			{ repo: root, limit: 2, cursor: "cursor-1" },
			createService,
			async (_agentDir, value) => value,
		);

		expect(first.exitCode).toBe(0);
		expect(first.result.rows.map(row => row.id)).toEqual(["session-0", "session-1"]);
		expect(first.result.rows).toHaveLength(2);
		expect(first.result.cursor).toBe("cursor-1");
		expect(sdkSearchResultV1(first.result)).toMatchObject({ cursor: "cursor-1" });
		expect(renderSdkSearchTable(first.result)).toContain("Continuation cursor: cursor-1");
		expect(resumed.exitCode).toBe(0);
		expect(resumed.result.rows.map(row => row.id)).toEqual(["session-2", "session-3"]);
		expect(resumed.result.rows).toHaveLength(2);
		expect(resumed.result.cursor).toBe("cursor-2");
		expect(inputs).toHaveLength(2);
		expect(inputs[0]).toMatchObject({ limit: 2, scope: { requested: "repo" } });
		expect(inputs[0]).not.toHaveProperty("cursor");
		expect(inputs[1]).toMatchObject({ limit: 2, cursor: "cursor-1", scope: { requested: "repo" } });
	} finally {
		await fs.rm(root, { recursive: true, force: true });
	}
});

test("non-Git repo is successful and makes zero probes", async () => {
	const root = await temp();
	try {
		let probes = 0;
		const search = await runSdkSearch(
			{ repo: root },
			() => {
				const result: SdkSearchResultV1 = {
					version: 1,
					scope: {
						version: 1,
						requested: "repo",
						requestAnchor: { cwd: root, worktreeRoot: null },
						resolved: null,
						resolution: "not-in-git-worktree",
					},
					status: "not-in-git-worktree",
					observedAt: "2026-08-23T12:00:00.000Z",
					rows: [],
					warnings: [],
				};
				const service = new SessionLifecycleService(new Client({ ok: true, result: {} }));
				return Object.assign(service, {
					scopedList: async () => ({ ok: true as const, operation: "session.list" as const, result }),
				});
			},
			async (_agentDir, value) => {
				probes++;
				return value;
			},
		);
		expect(search.exitCode).toBe(0);
		expect(search.result.status).toBe("not-in-git-worktree");
		expect(search.result.rows).toEqual([]);
		expect(probes).toBe(0);
		expect(renderSdkSearchTable(search.result)).toContain("Scope resolved: not-in-git-worktree");
	} finally {
		await fs.rm(root, { recursive: true, force: true });
	}
});

test("unavailable search renders a redacted public envelope and exits nonzero without probes", async () => {
	const root = await temp();
	const git = Bun.spawn(["git", "init", "-q", root]);
	await git.exited;
	try {
		let probes = 0;
		let failure: unknown;
		try {
			await runSdkSearch(
				{ repo: root },
				() =>
					new SessionLifecycleService(
						new Client({ ok: false, error: { code: "unavailable", message: "fixture-endpoint-token" } }),
					),
				async (_agentDir, value) => {
					probes++;
					return value;
				},
			);
		} catch (error) {
			failure = error;
		}
		expect(failure).toBeInstanceOf(PublicCommandFailure);
		const rendered = await renderPublicCommandFailure(failure, { command: ["sdk", "search"], json: true });
		expect(rendered.exitCode).toBe(1);
		expect(JSON.parse(rendered.stdout)).toEqual(rendered.envelope);
		expect(rendered.envelope).toMatchObject({
			schema: "gjc.command-error",
			version: 1,
			ok: false,
			command: ["sdk", "search"],
			error: { code: "unavailable", category: "unavailable" },
		});
		expect(probes).toBe(0);
		expect(rendered.stdout).not.toContain("fixture-endpoint-token");
		expect(rendered.stderr).toBe("");
	} finally {
		await fs.rm(root, { recursive: true, force: true });
	}
});
