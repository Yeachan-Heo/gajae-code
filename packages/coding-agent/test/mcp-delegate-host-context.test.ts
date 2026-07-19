import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { activeSnapshotPath } from "../src/gjc-runtime/session-layout";
import {
	detectMcpDelegateFlowActivation,
	listMcpDelegateHostContexts,
	mcpDelegateHostContextPath,
	persistMcpDelegateHostContext,
	readMcpDelegateHostContext,
} from "../src/hooks/mcp-delegate-host-context";
import { dispatchGjcNativeSkillHook } from "../src/hooks/native-skill-hook";
import { readVisibleSkillActiveState } from "../src/hooks/skill-state";

const testEffectiveSkillConfig = {
	skillsSettings: {
		enabled: true,
		enableSkillCommands: true,
		enablePiUser: true,
		enablePiProject: false,
		enableCodexUser: false,
		enableClaudeUser: false,
		enableClaudeProject: false,
	},
	disabledExtensions: [],
};

describe("MCP delegate-flow host context", () => {
	const roots: string[] = [];

	afterEach(async () => {
		await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true })));
	});

	async function tempRoot(): Promise<string> {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-mcp-delegate-host-context-"));
		roots.push(root);
		return root;
	}

	it("detects only exact delegate-flow activation tokens", () => {
		for (const prompt of [
			"$gjc-mcp-delegate-flow",
			"run $gjc-mcp-delegate-flow now",
			"($gjc-mcp-delegate-flow)",
			"$gjc-mcp-delegate-flow\ncontinue",
			"continue\n$gjc-mcp-delegate-flow",
		]) {
			expect(detectMcpDelegateFlowActivation(prompt)).toBe(true);
		}
		for (const prompt of [
			"gjc-mcp-delegate-flow",
			"$gjc-mcp-delegate-flows",
			"$gjc-mcp-delegate-flow-extra",
			"$GJC-MCP-DELEGATE-FLOW",
			"X$gjc-mcp-delegate-flow",
			"9$gjc-mcp-delegate-flow",
		]) {
			expect(detectMcpDelegateFlowActivation(prompt)).toBe(false);
		}
	});

	it("persists matching prompts without writing for missing sessions or non-matches", async () => {
		const root = await tempRoot();
		const persisted = await persistMcpDelegateHostContext({
			cwd: root,
			sessionId: "session.context-1",
			threadId: "thread-1",
			turnId: "turn-1",
			prompt: "run\n  $gjc-mcp-delegate-flow\t now",
		});

		expect(persisted).not.toBeNull();
		expect(persisted?.path).toBe(mcpDelegateHostContextPath(root, "session.context-1"));
		expect(persisted?.context).toMatchObject({
			schema_version: 1,
			activation: "$gjc-mcp-delegate-flow",
			session_id: "session.context-1",
			thread_id: "thread-1",
			turn_id: "turn-1",
			cwd: root,
			source: "user_prompt_submit",
			prompt_excerpt: "run $gjc-mcp-delegate-flow now",
		});
		expect(persisted?.context.recorded_at).toEqual(expect.any(String));
		expect(await readMcpDelegateHostContext(root, "session.context-1")).toEqual(persisted?.context ?? null);
		expect(
			await persistMcpDelegateHostContext({ cwd: root, sessionId: "session-no-match", prompt: "continue normally" }),
		).toBeNull();
		expect(await persistMcpDelegateHostContext({ cwd: root, prompt: "$gjc-mcp-delegate-flow" })).toBeNull();
	});
	it("returns null when host context is missing", async () => {
		const root = await tempRoot();

		await expect(readMcpDelegateHostContext(root, "session-missing")).resolves.toBeNull();
	});

	it("rejects malformed host context state", async () => {
		const root = await tempRoot();
		const contextPath = mcpDelegateHostContextPath(root, "session-malformed");
		await fs.mkdir(path.dirname(contextPath), { recursive: true });
		await fs.writeFile(contextPath, "{", "utf8");

		await expect(readMcpDelegateHostContext(root, "session-malformed")).rejects.toThrow("state_corrupt");
	});

	it("rejects host context state with the wrong schema", async () => {
		const root = await tempRoot();
		const contextPath = mcpDelegateHostContextPath(root, "session-wrong-schema");
		await fs.mkdir(path.dirname(contextPath), { recursive: true });
		await fs.writeFile(
			contextPath,
			JSON.stringify({
				schema_version: 2,
				activation: "$gjc-mcp-delegate-flow",
				session_id: "session-wrong-schema",
				thread_id: null,
				turn_id: null,
				cwd: root,
				source: "user_prompt_submit",
				recorded_at: "2026-07-19T00:00:00.000Z",
				prompt_excerpt: "resume",
			}),
			"utf8",
		);

		await expect(readMcpDelegateHostContext(root, "session-wrong-schema")).rejects.toThrow("state_corrupt");
	});

	it("rejects invalid session ids", async () => {
		const root = await tempRoot();

		await expect(readMcpDelegateHostContext(root, "../evil")).rejects.toThrow("invalid_session_id");
	});

	it("persists host context without activating a workflow skill", async () => {
		const root = await tempRoot();
		const sessionId = "session-host-context";
		const result = await dispatchGjcNativeSkillHook({
			hookEventName: "UserPromptSubmit",
			userPrompt: "resume $gjc-mcp-delegate-flow now",
			cwd: root,
			sessionId,
			threadId: "thread-host-context",
			turnId: "turn-host-context",
		});
		const contextPath = mcpDelegateHostContextPath(root, sessionId);
		const additionalContext = String(
			(result.outputJson?.hookSpecificOutput as { additionalContext?: unknown } | undefined)?.additionalContext ??
				"",
		);

		expect(await Bun.file(contextPath).exists()).toBe(true);
		expect(await Bun.file(activeSnapshotPath(root, sessionId)).exists()).toBe(false);
		expect(await readVisibleSkillActiveState(root, sessionId)).toBeNull();
		expect(additionalContext).toContain(`GJC MCP delegate-flow host context persisted at ${contextPath}.`);
	});

	it("maps non-ENOENT read failures to state_unreadable", async () => {
		const root = await tempRoot();
		const sessionId = "session-unreadable";
		const contextPath = mcpDelegateHostContextPath(root, sessionId);
		await fs.mkdir(contextPath, { recursive: true });

		await expect(readMcpDelegateHostContext(root, sessionId)).rejects.toThrow("state_unreadable");
	});
	it("finds the newest context when more than 64 session directories exist", async () => {
		const root = await tempRoot();
		const oldRecordedAt = "2026-07-18T00:00:00.000Z";
		for (let index = 0; index < 65; index++) {
			const sessionId = `session-${String(index).padStart(3, "0")}`;
			const contextPath = mcpDelegateHostContextPath(root, sessionId);
			await fs.mkdir(path.dirname(contextPath), { recursive: true });
			await fs.writeFile(
				contextPath,
				JSON.stringify({
					schema_version: 1,
					activation: "$gjc-mcp-delegate-flow",
					session_id: sessionId,
					thread_id: null,
					turn_id: null,
					cwd: root,
					source: "user_prompt_submit",
					recorded_at: oldRecordedAt,
					prompt_excerpt: "resume",
				}),
				"utf8",
			);
			await fs.utimes(contextPath, new Date(oldRecordedAt), new Date(oldRecordedAt));
		}
		for (let index = 65; index < 69; index++) {
			await fs.mkdir(path.join(root, ".gjc", `_session-session-${String(index).padStart(3, "0")}`), {
				recursive: true,
			});
		}
		const newest = await persistMcpDelegateHostContext({
			cwd: root,
			sessionId: "session-069",
			prompt: "$gjc-mcp-delegate-flow",
		});
		if (!newest) throw new Error("newest context was not persisted");

		const listed = await listMcpDelegateHostContexts(root);

		expect(listed.contexts[0]).toMatchObject({ session_id: "session-069" });
		expect(listed.contexts).toHaveLength(64);
	});
	it("skips invalid session ids and oversized excerpts during enumeration", async () => {
		const root = await tempRoot();
		for (const [directory, context] of [
			[
				"_session-traversal",
				{
					schema_version: 1,
					activation: "$gjc-mcp-delegate-flow",
					session_id: "../evil",
					thread_id: null,
					turn_id: null,
					cwd: root,
					source: "user_prompt_submit",
					recorded_at: "2026-07-19T00:00:00.000Z",
					prompt_excerpt: "resume",
				},
			],
			[
				"_session-oversized",
				{
					schema_version: 1,
					activation: "$gjc-mcp-delegate-flow",
					session_id: "oversized",
					thread_id: null,
					turn_id: null,
					cwd: root,
					source: "user_prompt_submit",
					recorded_at: "2026-07-19T00:00:00.000Z",
					prompt_excerpt: "x".repeat(1024 * 1024),
				},
			],
		] as const) {
			const contextPath = path.join(root, ".gjc", directory, "state", "mcp-delegate-host-context.json");
			await fs.mkdir(path.dirname(contextPath), { recursive: true });
			await fs.writeFile(contextPath, JSON.stringify(context), "utf8");
		}
		const valid = await persistMcpDelegateHostContext({
			cwd: root,
			sessionId: "valid",
			prompt: "$gjc-mcp-delegate-flow",
		});

		const listed = await listMcpDelegateHostContexts(root);

		expect(listed.contexts).toEqual([valid?.context]);
		expect(listed.failures).toBe(2);
	});
	it("continues dispatching when host-context persistence fails", async () => {
		const root = await tempRoot();
		const sessionId = "persist-failure";
		await fs.mkdir(mcpDelegateHostContextPath(root, sessionId), { recursive: true });

		const failedPersistResult = await dispatchGjcNativeSkillHook({
			hookEventName: "UserPromptSubmit",
			userPrompt: "$gjc-mcp-delegate-flow",
			cwd: root,
			sessionId,
		});
		expect(failedPersistResult).toMatchObject({ hookEventName: "UserPromptSubmit" });
		expect(
			String(
				(failedPersistResult.outputJson?.hookSpecificOutput as { additionalContext?: unknown } | undefined)
					?.additionalContext ?? "",
			),
		).not.toContain("GJC MCP delegate-flow host context persisted at");
		await expect(
			dispatchGjcNativeSkillHook(
				{
					hookEventName: "UserPromptSubmit",
					userPrompt: "ultragoal continue this objective",
					cwd: root,
					sessionId: "skill-after-persist-failure",
				},
				{ effectiveSkillConfig: testEffectiveSkillConfig },
			),
		).resolves.toMatchObject({ hookEventName: "UserPromptSubmit" });
		expect(await readVisibleSkillActiveState(root, "skill-after-persist-failure")).toMatchObject({
			skill: "ultragoal",
		});
	});

	it("leaves ultragoal workflow activation unchanged", async () => {
		const root = await tempRoot();
		const sessionId = "session-ultragoal";
		await dispatchGjcNativeSkillHook(
			{
				hookEventName: "UserPromptSubmit",
				userPrompt: "ultragoal continue this objective",
				cwd: root,
				sessionId,
			},
			{ effectiveSkillConfig: testEffectiveSkillConfig },
		);

		expect(await readVisibleSkillActiveState(root, sessionId)).toMatchObject({
			active: true,
			skill: "ultragoal",
			keyword: "ultragoal",
		});
	});
});
