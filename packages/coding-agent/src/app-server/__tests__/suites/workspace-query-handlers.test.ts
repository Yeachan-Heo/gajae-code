import { afterAll, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { fuzzyFind } from "@gajae-code/natives";
import { workspaceQueryHandlers, getWorkspaceSearchSessionCount } from "../../suites/workspace-query-handlers";
import type { HandlerContext } from "../../suites/handlers";

const root = mkdtempSync(join(tmpdir(), "gjc-workspace-query-suite-"));
const workspace = join(root, "workspace");
const repo = join(root, "repo");
mkdirSync(workspace);
mkdirSync(repo);
writeFileSync(join(workspace, "history-search.ts"), "export const historySearch = true;\n");
writeFileSync(join(workspace, "history.ts"), "export const history = true;\n");
writeFileSync(join(workspace, "readme.md"), "history search notes\n");

const context: HandlerContext = { connectionId: "workspace-query-test", emitTo: () => {} };
const resultOf = (result: { ok: true; result: unknown } | { ok: false; errorKey: string }): unknown => {
	if (!result.ok) throw new Error(result.errorKey);
	return result.result;
};

beforeEach(() => {
	expect(getWorkspaceSearchSessionCount()).toBe(0);
});

afterAll(() => rmSync(root, { recursive: true, force: true }));

test("fuzzyFileSearch uses native fuzzy ranking over real workspace files", async () => {
	const native = await fuzzyFind({ query: "history srch", path: workspace, maxResults: 20 });
	expect(native.matches[0]?.path).toBe("history-search.ts");
	const response = resultOf(await workspaceQueryHandlers.fuzzyFileSearch({ query: "history srch", root: workspace }, context)) as { files: Array<{ path: string }> };
	expect(response.files[0]?.path).toBe("history-search.ts");
});

test("fuzzy search sessions retain roots and emit real incremental updates", async () => {
	const notifications: unknown[] = [];
	const sessionContext: HandlerContext = { connectionId: "session", emitTo: (_id, _method, params) => notifications.push(params) };
	resultOf(workspaceQueryHandlers["fuzzyFileSearch/sessionStart"]({ sessionId: "s1", roots: [workspace] }, sessionContext));
	expect(getWorkspaceSearchSessionCount()).toBe(1);
	resultOf(await workspaceQueryHandlers["fuzzyFileSearch/sessionUpdate"]({ sessionId: "s1", query: "history srch" }, sessionContext));
	expect((notifications[0] as { files: Array<{ path: string }> }).files[0]?.path).toBe("history-search.ts");
	resultOf(workspaceQueryHandlers["fuzzyFileSearch/sessionStop"]({ sessionId: "s1" }, sessionContext));
	expect(getWorkspaceSearchSessionCount()).toBe(0);
});

test("gitDiffToRemote returns a real tracking-branch diff and notFound for non-git cwd", async () => {
	execFileSync("git", ["init", "-b", "main"], { cwd: repo });
	execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: repo });
	execFileSync("git", ["config", "user.name", "Test"], { cwd: repo });
	writeFileSync(join(repo, "tracked.txt"), "before\n");
	execFileSync("git", ["add", "."], { cwd: repo });
	execFileSync("git", ["commit", "-m", "initial"], { cwd: repo });
	execFileSync("git", ["config", "branch.main.remote", "origin"], { cwd: repo });
	execFileSync("git", ["config", "branch.main.merge", "refs/heads/main"], { cwd: repo });
	execFileSync("git", ["update-ref", "refs/remotes/origin/main", "HEAD"], { cwd: repo });
	writeFileSync(join(repo, "tracked.txt"), "after\n");
	const response = resultOf(await workspaceQueryHandlers.gitDiffToRemote({ cwd: repo }, context)) as { sha: string; diff: string };
	expect(response.sha).toMatch(/^[0-9a-f]{40}$/);
	expect(response.diff).toContain("-before");
	expect(response.diff).toContain("+after");
	expect(await workspaceQueryHandlers.gitDiffToRemote({ cwd: workspace }, context)).toEqual({ ok: false, errorKey: "notFound" });
});

test("workspaceQueryHandlers omits getConversationSummary because no session identity is pinned", () => {
	expect(workspaceQueryHandlers.getConversationSummary).toBeUndefined();
});
