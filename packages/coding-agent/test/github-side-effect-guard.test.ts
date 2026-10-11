/**
 * Side-effect github ops (pr_create, pr_checkout, pr_push) must hit the same
 * approval gate and planning-phase mutation guard as the other mutation tools.
 * Read-only ops stay ungated. These tests drive the session wrapper and
 * GithubTool.execute, not only the classifier.
 */
import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import * as fs from "node:fs/promises";
import type { AgentTool } from "@gajae-code/agent-core";
import { Agent } from "@gajae-code/agent-core";
import { getBundledModel } from "@gajae-code/ai";
import { AssistantMessageEventStream } from "@gajae-code/ai/utils/event-stream";
import { Settings } from "@gajae-code/coding-agent/config/settings";
import {
	activeSnapshotPath,
	modeStatePath,
	sessionStateDir,
} from "@gajae-code/coding-agent/gjc-runtime/session-layout";
import { AgentSession } from "@gajae-code/coding-agent/session/agent-session";
import type {
	ClientBridge,
	ClientBridgePermissionOutcome,
	ClientBridgePermissionToolCall,
} from "@gajae-code/coding-agent/session/client-bridge";
import { convertToLlm } from "@gajae-code/coding-agent/session/messages";
import { SessionManager } from "@gajae-code/coding-agent/session/session-manager";
import {
	AUTORESEARCH_MUTATION_BLOCK_MESSAGE,
	DEEP_INTERVIEW_MUTATION_BLOCK_MESSAGE,
	getWorkflowMutationDecision,
	RALPLAN_MUTATION_BLOCK_MESSAGE,
	ULTRAGOAL_GOAL_PLANNING_MUTATION_BLOCK_MESSAGE,
} from "@gajae-code/coding-agent/skill-state/workflow-mutation-guard";
import type { ToolSession } from "@gajae-code/coding-agent/tools";
import { GithubTool } from "@gajae-code/coding-agent/tools/gh";
import * as git from "@gajae-code/coding-agent/utils/git";
import { TempDir } from "@gajae-code/utils";
import * as z from "zod/v4";

const SECRET_BODY = "ghp_SUPERSECRETTOKEN";
const READ_ONLY_OPS = [
	"repo_view",
	"search_issues",
	"search_prs",
	"search_code",
	"search_commits",
	"search_repos",
	"run_watch",
] as const;

let tempDir: TempDir;
let session: AgentSession | undefined;

function makeGithubTool(): AgentTool & { executeCalls: number; executedArgs: unknown[] } {
	const tool = {
		name: "github",
		label: "GitHub",
		description: "Fake github",
		parameters: z.object({ op: z.string().optional() }).passthrough(),
		executeCalls: 0,
		executedArgs: [] as unknown[],
		async execute(_id: string, args: unknown) {
			tool.executeCalls++;
			tool.executedArgs.push(args);
			return { content: [{ type: "text" as const, text: "ok" }] };
		},
	};
	return tool;
}

function makeBridge(outcome: ClientBridgePermissionOutcome): ClientBridge {
	return {
		capabilities: { requestPermission: true },
		async requestPermission() {
			return outcome;
		},
	};
}

async function createSession(
	tools: AgentTool[],
	bridge: ClientBridge | undefined,
	permissionMode: "allow" | "prompt" | "deny",
): Promise<AgentSession> {
	const model = getBundledModel("anthropic", "claude-sonnet-4-5");
	if (!model) throw new Error("Expected claude-sonnet-4-5 model to exist");
	const settings = Settings.isolated({ "compaction.enabled": false });
	const sessionManager = SessionManager.inMemory(tempDir.path());
	const agent = new Agent({
		getApiKey: () => "test-key",
		initialState: {
			model,
			systemPrompt: ["Test"],
			tools,
			messages: [],
		},
		convertToLlm,
		streamFn: () => new AssistantMessageEventStream(),
	});
	const sess = new AgentSession({
		agent,
		sessionManager,
		settings,
		modelRegistry: {} as never,
		toolRegistry: new Map(tools.map(entry => [entry.name, entry])),
	});
	sess.setSdkPermissionMode(permissionMode);
	if (bridge) sess.setClientBridge(bridge);
	await sess.setActiveToolsByName(tools.map(entry => entry.name));
	return sess;
}

function wrappedGithub(sess: AgentSession): AgentTool {
	const tool = sess.agent.state.tools.find(entry => entry.name === "github");
	if (!tool) throw new Error("github tool was not activated");
	return tool;
}

async function writeActiveSkill(
	cwd: string,
	skill: "deep-interview" | "ralplan" | "ultragoal" | "autoresearch",
	phase: string,
	sessionId: string,
): Promise<void> {
	const now = new Date().toISOString();
	await fs.mkdir(sessionStateDir(cwd, sessionId), { recursive: true });
	const activeState = {
		version: 1,
		active: true,
		skill,
		phase,
		updated_at: now,
		active_skills: [{ skill, phase, active: true, updated_at: now, session_id: sessionId }],
	};
	await Bun.write(activeSnapshotPath(cwd, sessionId), `${JSON.stringify(activeState, null, 2)}\n`);
	await Bun.write(
		modeStatePath(cwd, sessionId, skill),
		`${JSON.stringify({ active: true, current_phase: phase, session_id: sessionId }, null, 2)}\n`,
	);
}

function decisionTool(name: string): AgentTool {
	return {
		name,
		label: name,
		description: name,
		parameters: {} as never,
		execute: async () => ({ content: [{ type: "text" as const, text: "ok" }] }),
	} as AgentTool;
}

beforeEach(() => {
	tempDir = TempDir.createSync("@gjc-github-gate-");
});

afterEach(async () => {
	await session?.dispose();
	session = undefined;
	await tempDir.remove();
});

describe("github approval gate", () => {
	it("asks before pr_push, pr_create, and pr_checkout and refuses a rejection", async () => {
		const github = makeGithubTool();
		const requests: ClientBridgePermissionToolCall[] = [];
		const bridge: ClientBridge = {
			capabilities: { requestPermission: true },
			async requestPermission(toolCall) {
				requests.push(toolCall);
				return { outcome: "selected", optionId: "reject_once", kind: "reject_once" };
			},
		};
		session = await createSession([github], bridge, "prompt");
		const wrapped = wrappedGithub(session);
		const viaExecution = session.getToolForExecution("github");
		expect(viaExecution).toBeDefined();

		const attacks = [
			{ op: "pr_push", branch: "pr-42", forceWithLease: true },
			{
				op: "pr_create",
				repo: "owner/repo",
				head: "feature",
				base: "dev",
				title: "ship it",
				body: SECRET_BODY,
			},
			{ op: "pr_checkout", pr: ["42", "https://github.com/owner/repo/pull/43"], force: true, body: SECRET_BODY },
		];

		for (const args of attacks) {
			await expect(
				wrapped.execute("call-reject", args, undefined, undefined as never, undefined as never),
			).rejects.toThrow(/rejected by user \(github\)/);
		}
		await expect(
			viaExecution!.execute(
				"call-exec-path",
				{ op: "pr_push", branch: "pr-99" },
				undefined,
				undefined as never,
				undefined as never,
			),
		).rejects.toThrow(/rejected by user \(github\)/);

		expect(github.executeCalls).toBe(0);
		expect(requests).toHaveLength(4);
		expect(requests[0]?.title).toContain("pr-42");
		expect(requests[0]?.title).toContain("force-with-lease");
		expect(requests[1]?.title).toContain("owner/repo");
		expect(requests[1]?.title).toContain("feature");
		expect(requests[2]?.title).toContain("42");
		expect(requests[2]?.title).toContain("~/.gjc/wt");
		expect(requests[2]?.title).toContain("git config");
		const rendered = JSON.stringify(requests.map(request => ({ title: request.title, content: request.content })));
		expect(rendered).not.toContain(SECRET_BODY);
		expect(requests.every(request => request.toolName === "github")).toBe(true);
	});

	it("executes a side-effect op only after allow_once, and scopes allow_always to that op", async () => {
		const github = makeGithubTool();
		let next: "allow_once" | "allow_always" = "allow_once";
		const requests: ClientBridgePermissionToolCall[] = [];
		const bridge: ClientBridge = {
			capabilities: { requestPermission: true },
			async requestPermission(toolCall) {
				requests.push(toolCall);
				const kind = next;
				return { outcome: "selected", optionId: kind, kind };
			},
		};
		session = await createSession([github], bridge, "prompt");
		const wrapped = wrappedGithub(session);

		await wrapped.execute(
			"call-allow",
			{ op: "pr_push", branch: "pr-1" },
			undefined,
			undefined as never,
			undefined as never,
		);
		expect(github.executeCalls).toBe(1);
		expect(requests).toHaveLength(1);

		next = "allow_always";
		await wrapped.execute(
			"call-always",
			{ op: "pr_push", branch: "pr-2" },
			undefined,
			undefined as never,
			undefined as never,
		);
		expect(requests).toHaveLength(2);
		await wrapped.execute(
			"call-cached",
			{ op: "pr_push", branch: "pr-3", forceWithLease: true },
			undefined,
			undefined as never,
			undefined as never,
		);
		expect(requests).toHaveLength(2);
		expect(github.executeCalls).toBe(3);

		await wrapped.execute(
			"call-other-op",
			{ op: "pr_create", repo: "owner/repo", head: "feature", base: "dev" },
			undefined,
			undefined as never,
			undefined as never,
		);
		expect(requests).toHaveLength(3);
		expect(requests[2]?.title).toContain("owner/repo");
		expect(github.executeCalls).toBe(4);
	});

	it("fails closed for deny mode, a missing provider, and an unrecognized op", async () => {
		const denied = makeGithubTool();
		session = await createSession(
			[denied],
			makeBridge({ outcome: "selected", optionId: "allow_once", kind: "allow_once" }),
			"deny",
		);
		await expect(
			wrappedGithub(session).execute(
				"call-deny",
				{ op: "pr_push" },
				undefined,
				undefined as never,
				undefined as never,
			),
		).rejects.toThrow(/rejected by session permission policy \(github\)/);
		expect(denied.executeCalls).toBe(0);
		await session.dispose();

		const unconnected = makeGithubTool();
		session = await createSession([unconnected], undefined, "prompt");
		await expect(
			wrappedGithub(session).execute(
				"call-unconnected",
				{ op: "pr_checkout", pr: "7" },
				undefined,
				undefined as never,
				undefined as never,
			),
		).rejects.toThrow(/no permission provider is connected \(github\)/);
		expect(unconnected.executeCalls).toBe(0);
		await session.dispose();

		const unknown = makeGithubTool();
		const requests: ClientBridgePermissionToolCall[] = [];
		const bridge: ClientBridge = {
			capabilities: { requestPermission: true },
			async requestPermission(toolCall) {
				requests.push(toolCall);
				return { outcome: "selected", optionId: "reject_once", kind: "reject_once" };
			},
		};
		session = await createSession([unknown], bridge, "prompt");
		const wrapped = wrappedGithub(session);
		for (const args of [{ op: "pr_merge" }, { op: "" }, {}]) {
			await expect(
				wrapped.execute("call-unknown", args, undefined, undefined as never, undefined as never),
			).rejects.toThrow(/rejected by user \(github\)/);
		}
		expect(unknown.executeCalls).toBe(0);
		expect(requests).toHaveLength(3);
		expect(requests.every(request => !JSON.stringify(request.content ?? "").includes(SECRET_BODY))).toBe(true);
	});

	it("does not prompt for read-only ops, and allow mode matches the other gated tools", async () => {
		const github = makeGithubTool();
		const bridge = makeBridge({ outcome: "selected", optionId: "reject_once", kind: "reject_once" });
		const permissionSpy = spyOn(bridge, "requestPermission");
		session = await createSession([github], bridge, "prompt");
		const wrapped = wrappedGithub(session);
		for (const op of READ_ONLY_OPS) {
			await wrapped.execute("call-read", { op, query: "q" }, undefined, undefined as never, undefined as never);
		}
		expect(permissionSpy).not.toHaveBeenCalled();
		expect(github.executeCalls).toBe(READ_ONLY_OPS.length);
		await session.dispose();

		const allowed = makeGithubTool();
		const allowBridge = makeBridge({ outcome: "selected", optionId: "reject_once", kind: "reject_once" });
		const allowSpy = spyOn(allowBridge, "requestPermission");
		session = await createSession([allowed], allowBridge, "allow");
		await wrappedGithub(session).execute(
			"call-allow-mode",
			{ op: "pr_push", branch: "pr-1", body: SECRET_BODY },
			undefined,
			undefined as never,
			undefined as never,
		);
		expect(allowSpy).not.toHaveBeenCalled();
		expect(allowed.executeCalls).toBe(1);
	});
});

describe("github planning guard", () => {
	it("blocks side-effect ops during deep-interview and still runs read-only ops", async () => {
		const github = makeGithubTool();
		session = await createSession([github], undefined, "allow");
		const sessionId = session.sessionManager.getSessionId();
		await writeActiveSkill(tempDir.path(), "deep-interview", "interviewing", sessionId);
		const wrapped = wrappedGithub(session);

		await expect(
			wrapped.execute(
				"call-plan-push",
				{ op: "pr_push", branch: "pr-42", forceWithLease: true },
				undefined,
				undefined as never,
				undefined as never,
			),
		).rejects.toThrow(DEEP_INTERVIEW_MUTATION_BLOCK_MESSAGE);
		await expect(
			wrapped.execute(
				"call-plan-create",
				{ op: "pr_create", repo: "owner/repo", body: SECRET_BODY },
				undefined,
				undefined as never,
				undefined as never,
			),
		).rejects.toThrow(DEEP_INTERVIEW_MUTATION_BLOCK_MESSAGE);
		await expect(
			wrapped.execute(
				"call-plan-checkout",
				{ op: "pr_checkout", pr: ["1", "2"] },
				undefined,
				undefined as never,
				undefined as never,
			),
		).rejects.toThrow(DEEP_INTERVIEW_MUTATION_BLOCK_MESSAGE);
		expect(github.executeCalls).toBe(0);

		for (const op of READ_ONLY_OPS) {
			await wrapped.execute("call-plan-read", { op }, undefined, undefined as never, undefined as never);
		}
		expect(github.executeCalls).toBe(READ_ONLY_OPS.length);
	});

	it("refuses GithubTool side effects during ralplan before git or gh runs", async () => {
		const sessionId = "session-github-gate";
		await writeActiveSkill(tempDir.path(), "ralplan", "planning", sessionId);
		const toolSession = {
			cwd: tempDir.path(),
			hasUI: false,
			getSessionFile: () => null,
			getSessionId: () => sessionId,
		} as ToolSession;
		const tool = new GithubTool(toolSession);
		const jsonSpy = spyOn(git.github, "json").mockRejectedValue(new Error("github sink reached"));
		const pushSpy = spyOn(git, "push").mockRejectedValue(new Error("git push sink reached"));
		try {
			await expect(
				tool.execute("pr-push", { op: "pr_push", branch: "pr-42", forceWithLease: true }),
			).rejects.toThrow(RALPLAN_MUTATION_BLOCK_MESSAGE);
			await expect(
				tool.execute("pr-create", { op: "pr_create", repo: "owner/repo", title: "t", body: SECRET_BODY }),
			).rejects.toThrow(RALPLAN_MUTATION_BLOCK_MESSAGE);
			await expect(
				tool.execute("pr-checkout", { op: "pr_checkout", pr: ["42", "43"], force: true }),
			).rejects.toThrow(RALPLAN_MUTATION_BLOCK_MESSAGE);
			expect(jsonSpy).not.toHaveBeenCalled();
			expect(pushSpy).not.toHaveBeenCalled();

			let readOnlyBlocked = false;
			try {
				await tool.execute("repo-view", { op: "repo_view", repo: "owner/repo" });
			} catch (error) {
				readOnlyBlocked = error instanceof Error && error.message.includes(RALPLAN_MUTATION_BLOCK_MESSAGE);
			}
			expect(readOnlyBlocked).toBe(false);
		} finally {
			jsonSpy.mockRestore();
			pushSpy.mockRestore();
		}
	});

	it("blocks side effects for ultragoal goal-planning and autoresearch, and releases ultragoal after planning", async () => {
		const cwd = tempDir.path();
		const sessionId = "session-a";
		const github = decisionTool("github");

		await writeActiveSkill(cwd, "ultragoal", "goal-planning", sessionId);
		const planning = await getWorkflowMutationDecision({
			cwd,
			sessionId,
			tool: github,
			args: { op: "pr_push", branch: "pr-1" },
		});
		expect(planning.blocked).toBe(true);
		expect(planning.message).toBe(ULTRAGOAL_GOAL_PLANNING_MUTATION_BLOCK_MESSAGE);

		await writeActiveSkill(cwd, "ultragoal", "active", sessionId);
		const executing = await getWorkflowMutationDecision({
			cwd,
			sessionId,
			tool: github,
			args: { op: "pr_checkout", pr: "8" },
		});
		expect(executing.blocked).toBe(false);

		await writeActiveSkill(cwd, "autoresearch", "research", sessionId);
		const research = await getWorkflowMutationDecision({
			cwd,
			sessionId,
			tool: github,
			args: { op: "pr_create", repo: "owner/repo" },
		});
		expect(research.blocked).toBe(true);
		expect(research.message).toBe(AUTORESEARCH_MUTATION_BLOCK_MESSAGE);
		const researchRead = await getWorkflowMutationDecision({
			cwd,
			sessionId,
			tool: github,
			args: { op: "search_code", query: "token" },
		});
		expect(researchRead.blocked).toBe(false);

		const outside = await getWorkflowMutationDecision({
			cwd: tempDir.path(),
			sessionId: "no-such-session",
			tool: github,
			args: { op: "pr_push" },
		});
		expect(outside.blocked).toBe(false);
	});
});
