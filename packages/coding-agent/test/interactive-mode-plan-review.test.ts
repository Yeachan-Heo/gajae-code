import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { Agent, type AgentTool } from "@gajae-code/agent-core";
import type { AssistantMessage } from "@gajae-code/ai";
import { resetSettingsForTest, Settings } from "@gajae-code/coding-agent/config/settings";
import { resolveLocalUrlToPath } from "@gajae-code/coding-agent/internal-urls";
import { AssistantMessageComponent } from "@gajae-code/coding-agent/modes/components/assistant-message";
import { initTheme } from "@gajae-code/coding-agent/modes/theme/theme";
import { SILENT_ABORT_MARKER } from "@gajae-code/coding-agent/session/messages";
import { Text } from "@gajae-code/tui";
import { TempDir } from "@gajae-code/utils";
import * as z from "zod/v4";
import { ModelRegistry } from "../src/config/model-registry";
import { planSnapshotHash } from "../src/modes/components/plan-preview-overlay";
import { SelectorController } from "../src/modes/controllers/selector-controller";
import { InteractiveMode } from "../src/modes/interactive-mode";

import { AgentSession } from "../src/session/agent-session";
import { AuthStorage } from "../src/session/auth-storage";
import { SessionManager } from "../src/session/session-manager";

/**
 * Matches the plan-approved synthetic-prompt dispatch. `#approvePlan` calls
 * `session.prompt(rendered, { synthetic: true })` exclusively for that case,
 * so the `synthetic: true` option flag is the unique discriminator.
 */
const isPlanApprovedCall = (args: unknown[]): boolean =>
	args.length >= 2 &&
	typeof args[0] === "string" &&
	typeof args[1] === "object" &&
	args[1] !== null &&
	(args[1] as { synthetic?: boolean }).synthetic === true;

function createTestTool(name: string): AgentTool {
	return {
		name,
		label: name,
		description: `${name} test tool`,
		parameters: z.object({}),
		strict: true,
		async execute() {
			return { content: [{ type: "text", text: `${name} executed` }] };
		},
	};
}

describe("InteractiveMode plan review rendering", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let session: AgentSession;
	let mode: InteractiveMode;

	beforeAll(() => {
		initTheme();
	});

	beforeEach(async () => {
		resetSettingsForTest();
		tempDir = TempDir.createSync("@pi-plan-review-");
		await Settings.init({ inMemory: true, cwd: tempDir.path() });
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth.db"));
		const modelRegistry = new ModelRegistry(authStorage);
		const model = modelRegistry.find("anthropic", "claude-sonnet-4-5");
		if (!model) {
			throw new Error("Expected claude-sonnet-4-5 to exist in registry");
		}

		const readTool = createTestTool("test_read");
		const writeTool = createTestTool("test_write");
		const resolveTool = createTestTool("resolve");
		const initialTools = [readTool, writeTool];
		session = new AgentSession({
			agent: new Agent({
				initialState: {
					model,
					systemPrompt: ["Test"],
					tools: initialTools,
					messages: [],
				},
			}),
			sessionManager: SessionManager.create(tempDir.path(), tempDir.path()),
			settings: Settings.isolated(),
			modelRegistry,
			toolRegistry: new Map([
				[readTool.name, readTool],
				[writeTool.name, writeTool],
				[resolveTool.name, resolveTool],
			]),
		});
		mode = new InteractiveMode(session, "test");
	});

	it("routes SDK plan toggles through the complete interactive lifecycle", async () => {
		const enabled = await session.setSdkPlanMode(true);
		expect(enabled).toMatchObject({ enabled: true, planFilePath: "local://PLAN.md" });
		expect(mode.planModeEnabled).toBe(true);
		expect(session.getActiveToolNames()).toEqual(["test_read", "test_write", "resolve"]);
		expect(session.peekStandingResolveHandler()).toBeDefined();

		expect(await session.setSdkPlanMode(false)).toBeUndefined();
		expect(mode.planModeEnabled).toBe(false);
		expect(session.getActiveToolNames()).toEqual(["test_read", "test_write"]);
		expect(session.peekStandingResolveHandler()).toBeUndefined();
	});

	it("fails SDK plan toggles closed when the interactive lifecycle refuses them", async () => {
		mode.goalModeEnabled = true;
		await expect(session.setSdkPlanMode(true)).rejects.toMatchObject({ code: "conflict" });
		expect(session.getPlanModeState()).toBeUndefined();
		mode.goalModeEnabled = false;

		mode.planModePaused = true;
		await expect(session.setSdkPlanMode(false)).rejects.toMatchObject({ code: "conflict" });
		mode.planModePaused = false;
	});
	afterEach(async () => {
		vi.restoreAllMocks();
		mode?.stop();
		await session?.dispose();
		authStorage?.close();
		tempDir?.removeSync();
		resetSettingsForTest();
	});

	it("appends each submitted plan review preview to preserve scrollback", async () => {
		const planFilePath = "local://PLAN.md";
		const resolvedPlanPath = resolveLocalUrlToPath(planFilePath, {
			getArtifactsDir: () => session.sessionManager.getArtifactsDir(),
			getSessionId: () => session.sessionManager.getSessionId(),
		});
		await Bun.write(resolvedPlanPath, "# First plan\n\nalpha");

		mode.planModeEnabled = true;
		mode.planModePlanFilePath = planFilePath;
		vi.spyOn(SelectorController.prototype, "showPlanPreview")
			.mockResolvedValueOnce({
				action: "Refine plan",
				comments: [],
				notes: "",
				snapshotHash: planSnapshotHash("# First plan\n\nalpha"),
			})
			.mockResolvedValue({
				action: "Refine plan",
				comments: [],
				notes: "",
				snapshotHash: planSnapshotHash("# Second plan\n\nbeta"),
			});
		vi.spyOn(session, "prompt").mockResolvedValue(undefined as never);

		await mode.handlePlanApproval({
			planFilePath,
			planExists: true,
			title: "PLAN",
			finalPlanFilePath: "local://PLAN.md",
		});

		const firstPreview = mode.chatContainer.children.at(-1);
		expect(firstPreview).toBeDefined();
		expect(firstPreview!.render(120).join("\n")).toContain("First plan");

		const marker = new Text("MARKER", 0, 0);
		mode.chatContainer.addChild(marker);
		await Bun.write(resolvedPlanPath, "# Second plan\n\nbeta");

		await mode.handlePlanApproval({
			planFilePath,
			planExists: true,
			title: "PLAN",
			finalPlanFilePath: "local://PLAN.md",
		});

		const secondPreview = mode.chatContainer.children.at(-1);
		expect(secondPreview).toBeDefined();
		expect(secondPreview).not.toBe(firstPreview);
		expect(mode.chatContainer.children.at(-2)).toBe(marker);
		expect(mode.chatContainer.children.at(-3)).toBe(firstPreview);
		expect(firstPreview!.render(120).join("\n")).toContain("First plan");
		expect(firstPreview!.render(120).join("\n")).not.toContain("Second plan");
		expect(secondPreview!.render(120).join("\n")).toContain("Second plan");
	});

	it("offers approve-and-keep-context as a distinct plan approval path", async () => {
		const planFilePath = "local://PLAN.md";
		const resolvedPlanPath = resolveLocalUrlToPath(planFilePath, {
			getArtifactsDir: () => session.sessionManager.getArtifactsDir(),
			getSessionId: () => session.sessionManager.getSessionId(),
		});
		await Bun.write(resolvedPlanPath, "# Plan\n\nDo the thing.");

		mode.planModeEnabled = true;
		mode.planModePlanFilePath = planFilePath;
		const selector = vi.spyOn(SelectorController.prototype, "showPlanPreview").mockResolvedValue({
			action: "Refine plan",
			comments: [],
			notes: "",
			snapshotHash: planSnapshotHash("# Plan\n\nDo the thing."),
		});
		const prompt = vi.spyOn(session, "prompt").mockResolvedValue(undefined as never);

		await mode.handlePlanApproval({
			planFilePath,
			planExists: true,
			title: "PLAN",
			finalPlanFilePath: "local://APPROVED.md",
		});

		expect(selector).toHaveBeenCalledWith(
			"# Plan\n\nDo the thing.",
			expect.objectContaining({
				externalEditorKey: "Ctrl+G",
				externalEditorKeys: ["ctrl+g"],
				onExternalEditor: expect.any(Function),
			}),
		);

		expect(prompt).not.toHaveBeenCalled();
	});
	it("sends reviewed refine feedback as a plain prompt", async () => {
		const planFilePath = "local://PLAN.md";
		const plan = "# Plan\n\nRevise this.";
		const resolvedPlanPath = resolveLocalUrlToPath(planFilePath, {
			getArtifactsDir: () => session.sessionManager.getArtifactsDir(),
			getSessionId: () => session.sessionManager.getSessionId(),
		});
		await Bun.write(resolvedPlanPath, plan);
		const snapshotHash = planSnapshotHash(plan);
		mode.planModeEnabled = true;
		mode.planModePlanFilePath = planFilePath;
		vi.spyOn(SelectorController.prototype, "showPlanPreview").mockResolvedValue({
			action: "Refine plan",
			comments: [{ id: "review", startLine: 3, endLine: 3, text: "Clarify scope", snapshotHash, createdAt: 1 }],
			notes: "Keep it small.",
			snapshotHash,
		});
		const prompt = vi.spyOn(session, "prompt").mockResolvedValue(undefined as never);
		await mode.handlePlanApproval({ planFilePath, planExists: true, title: "PLAN", finalPlanFilePath: planFilePath });
		const block = `Plan review comments (snapshot ${snapshotHash.slice(0, 8)}):\n- L3: Clarify scope\n> Revise this.\nKeep it small.`;
		expect(prompt).toHaveBeenCalledWith(`${block}\n\nPlease refine the plan using these review comments.`);
		const audit = mode.chatContainer.children.at(-1)?.render(120).join("\n");
		expect(audit).toContain("Decision: Refine plan");
	});

	it("discards stale review material and reopens every decision variant", async () => {
		const planFilePath = "local://PLAN.md";
		const reviewedPlan = "# Reviewed plan\n\nOriginal scope.";
		const changedPlan = "# Changed plan\n\nReplacement scope.";
		const resolvedPlanPath = resolveLocalUrlToPath(planFilePath, {
			getArtifactsDir: () => session.sessionManager.getArtifactsDir(),
			getSessionId: () => session.sessionManager.getSessionId(),
		});
		const selector = vi.spyOn(SelectorController.prototype, "showPlanPreview");
		const prompt = vi.spyOn(session, "prompt").mockResolvedValue(undefined as never);
		const warning = vi.spyOn(mode, "showWarning");
		const decisions = [
			{ action: "Approve and execute" as const, comments: true, notes: "Approve note." },
			{ action: "Refine plan" as const, comments: true, notes: "Refine note." },
			{ action: "Approve and keep context" as const, comments: false, notes: "Notes only." },
		];

		for (const decision of decisions) {
			await Bun.write(resolvedPlanPath, reviewedPlan);
			const snapshotHash = planSnapshotHash(reviewedPlan);
			mode.planModeEnabled = true;
			mode.planModePlanFilePath = planFilePath;
			selector
				.mockReset()
				.mockImplementationOnce(async () => {
					await Bun.write(resolvedPlanPath, changedPlan);
					return {
						action: decision.action,
						comments: decision.comments
							? [
									{
										id: decision.action,
										startLine: 3,
										endLine: 3,
										text: "Discard me.",
										snapshotHash,
										createdAt: 1,
									},
								]
							: [],
						notes: decision.notes,
						snapshotHash,
					};
				})
				.mockResolvedValueOnce({
					action: undefined,
					comments: [],
					notes: "",
					snapshotHash: planSnapshotHash(changedPlan),
				});
			const auditCount = mode.chatContainer.children.filter(child =>
				Bun.stripANSI(child.render(200).join("\n")).includes("Plan approval audit"),
			).length;
			const promptCount = prompt.mock.calls.length;

			await mode.handlePlanApproval({
				planFilePath,
				planExists: true,
				title: "PLAN",
				finalPlanFilePath: planFilePath,
			});

			expect(selector).toHaveBeenCalledTimes(2);
			expect(selector.mock.calls[0]).toMatchObject([reviewedPlan, expect.any(Object)]);

			expect(selector.mock.calls[1]).toMatchObject([changedPlan, expect.any(Object)]);
			expect(warning).toHaveBeenLastCalledWith(
				"Plan changed while reviewing; comments and notes were discarded. Confirm the decision again.",
			);
			expect(prompt.mock.calls).toHaveLength(promptCount);
			expect(
				mode.chatContainer.children.filter(child =>
					Bun.stripANSI(child.render(200).join("\n")).includes("Plan approval audit"),
				),
			).toHaveLength(auditCount);
		}
	});

	it("dispatches reviewed refine feedback exactly once as a non-synthetic prompt", async () => {
		const planFilePath = "local://PLAN.md";
		const plan = "# Plan\n\nRefine this.";
		const resolvedPlanPath = resolveLocalUrlToPath(planFilePath, {
			getArtifactsDir: () => session.sessionManager.getArtifactsDir(),
			getSessionId: () => session.sessionManager.getSessionId(),
		});
		await Bun.write(resolvedPlanPath, plan);
		const snapshotHash = planSnapshotHash(plan);
		mode.planModeEnabled = true;
		mode.planModePlanFilePath = planFilePath;
		vi.spyOn(SelectorController.prototype, "showPlanPreview").mockResolvedValue({
			action: "Refine plan",
			comments: [{ id: "review", startLine: 3, endLine: 3, text: "Clarify scope", snapshotHash, createdAt: 1 }],
			notes: "Keep it small.",
			snapshotHash,
		});
		const prompt = vi.spyOn(session, "prompt").mockResolvedValue(undefined as never);

		await mode.handlePlanApproval({ planFilePath, planExists: true, title: "PLAN", finalPlanFilePath: planFilePath });

		expect(prompt).toHaveBeenCalledTimes(1);
		expect(prompt.mock.calls[0]).toHaveLength(1);
		expect(prompt.mock.calls[0]?.[0]).toBe(
			`Plan review comments (snapshot ${snapshotHash.slice(0, 8)}):\n- L3: Clarify scope\n> Refine this.\nKeep it small.\n\nPlease refine the plan using these review comments.`,
		);
	});

	it("keeps approval transitions identical when review comments are present", async () => {
		const planFilePath = "local://PLAN.md";
		const plan = "# Plan\n\nExecute this.";
		const resolvedPlanPath = resolveLocalUrlToPath(planFilePath, {
			getArtifactsDir: () => session.sessionManager.getArtifactsDir(),
			getSessionId: () => session.sessionManager.getSessionId(),
		});
		const selector = vi.spyOn(SelectorController.prototype, "showPlanPreview");
		const prompt = vi.spyOn(session, "prompt").mockResolvedValue(undefined as never);
		const clear = vi.spyOn(mode, "handleClearCommand").mockResolvedValue(true);
		const compact = vi.spyOn(mode, "handleCompactCommand").mockResolvedValue("ok");

		for (const action of [
			"Approve and execute",
			"Approve and keep context",
			"Approve and compact context",
		] as const) {
			const transitions: Array<{
				mode: object;
				tools: string[];
				sessionPlanState: unknown;
				clearCalls: number;
				compactCalls: number;
				promptOptions: unknown;
			}> = [];
			for (const withComments of [false, true]) {
				await Bun.write(resolvedPlanPath, plan);
				const snapshotHash = planSnapshotHash(plan);
				await mode.handlePlanModeCommand();
				expect(mode.planModeEnabled).toBe(true);
				expect(session.getActiveToolNames()).toEqual(["test_read", "test_write", "resolve"]);
				const clearCalls = clear.mock.calls.length;
				const compactCalls = compact.mock.calls.length;
				selector.mockResolvedValueOnce({
					action,
					comments: withComments
						? [
								{
									id: action,
									startLine: 3,
									endLine: 3,
									text: "Preserve this feedback.",
									snapshotHash,
									createdAt: 1,
								},
							]
						: [],
					notes: "",
					snapshotHash,
				});

				await mode.handlePlanApproval({
					planFilePath,
					planExists: true,
					title: "PLAN",
					finalPlanFilePath: planFilePath,
				});
				const promptCall = prompt.mock.calls.at(-1);
				transitions.push({
					mode: {
						enabled: mode.planModeEnabled,
						paused: mode.planModePaused,
						planFilePath: mode.planModePlanFilePath,
					},
					tools: [...session.getActiveToolNames()],
					sessionPlanState: session.getPlanModeState(),
					clearCalls: clear.mock.calls.length - clearCalls,
					compactCalls: compact.mock.calls.length - compactCalls,
					promptOptions: promptCall?.[1],
				});
			}
			expect(transitions[1]).toEqual(transitions[0]);
			expect(transitions.map(transition => transition.tools)).toEqual([
				["test_read", "test_write"],
				["test_read", "test_write"],
			]);
			expect(transitions[0]?.mode).toEqual({ enabled: false, paused: false, planFilePath: undefined });
			expect(transitions[0]?.sessionPlanState).toBeUndefined();
		}
		expect(prompt).toHaveBeenCalledTimes(6);
	});

	it("renders the complete approve-with-comments audit block byte-for-byte", async () => {
		const planFilePath = "local://PLAN.md";
		const plan = "# Plan\n\nShip it.";
		const resolvedPlanPath = resolveLocalUrlToPath(planFilePath, {
			getArtifactsDir: () => session.sessionManager.getArtifactsDir(),
			getSessionId: () => session.sessionManager.getSessionId(),
		});
		await Bun.write(resolvedPlanPath, plan);
		const snapshotHash = planSnapshotHash(plan);
		mode.planModeEnabled = true;
		mode.planModePlanFilePath = planFilePath;
		vi.spyOn(SelectorController.prototype, "showPlanPreview").mockResolvedValue({
			action: "Approve and keep context",
			comments: [{ id: "review", startLine: 3, endLine: 3, text: "Confirm rollout.", snapshotHash, createdAt: 1 }],
			notes: "No unrelated changes.",
			snapshotHash,
		});
		vi.spyOn(session, "prompt").mockResolvedValue(undefined as never);

		await mode.handlePlanApproval({ planFilePath, planExists: true, title: "PLAN", finalPlanFilePath: planFilePath });

		const audit =
			mode.chatContainer.children
				.at(-1)
				?.render(40)
				.map(line => Bun.stripANSI(line).trimEnd())
				.join("\n") ?? "";
		expect(audit).toBe(`
────────────────────────────────────────

 Plan Review



 Plan approval audit

 Decision: Approve and keep context

 Path: local://PLAN.md

 Snapshot SHA-256:
 ${snapshotHash.slice(0, 38)}
 ${snapshotHash.slice(38)}

 Plan

 Ship it.

 Plan review comments (snapshot
 ${snapshotHash.slice(0, 8)}):
 - L3: Confirm rollout.
 ▏ Ship it.
 ▏ No unrelated changes.

────────────────────────────────────────`);
	});

	it("approves a plan without clearing the session when keeping context", async () => {
		const planFilePath = "local://PLAN.md";
		const finalPlanFilePath = "local://APPROVED.md";
		const resolvedPlanPath = resolveLocalUrlToPath(planFilePath, {
			getArtifactsDir: () => session.sessionManager.getArtifactsDir(),
			getSessionId: () => session.sessionManager.getSessionId(),
		});
		const resolvedFinalPlanPath = resolveLocalUrlToPath(finalPlanFilePath, {
			getArtifactsDir: () => session.sessionManager.getArtifactsDir(),
			getSessionId: () => session.sessionManager.getSessionId(),
		});
		await Bun.write(resolvedPlanPath, "# Plan\n\nKeep context.");

		mode.planModeEnabled = true;
		mode.planModePlanFilePath = planFilePath;
		vi.spyOn(SelectorController.prototype, "showPlanPreview").mockResolvedValue({
			action: "Approve and keep context",
			comments: [],
			notes: "",
			snapshotHash: planSnapshotHash("# Plan\n\nKeep context."),
		});
		const clear = vi.spyOn(mode, "handleClearCommand").mockResolvedValue(true);
		const prompt = vi.spyOn(session, "prompt").mockResolvedValue(undefined as never);

		await mode.handlePlanApproval({
			planFilePath,
			planExists: true,
			title: "PLAN",
			finalPlanFilePath,
		});

		expect(clear).not.toHaveBeenCalled();
		expect(await Bun.file(resolvedFinalPlanPath).text()).toBe("# Plan\n\nKeep context.");
		expect(prompt).toHaveBeenCalledWith(expect.any(String), {
			synthetic: true,
		});
	});

	it("keeps the existing approve-and-execute path clearing the session", async () => {
		const planFilePath = "local://PLAN.md";
		const finalPlanFilePath = "local://APPROVED.md";
		const resolvedPlanPath = resolveLocalUrlToPath(planFilePath, {
			getArtifactsDir: () => session.sessionManager.getArtifactsDir(),
			getSessionId: () => session.sessionManager.getSessionId(),
		});
		await Bun.write(resolvedPlanPath, "# Plan\n\nClear context.");

		mode.planModeEnabled = true;
		mode.planModePlanFilePath = planFilePath;
		vi.spyOn(SelectorController.prototype, "showPlanPreview").mockResolvedValue({
			action: "Approve and execute",
			comments: [],
			notes: "",
			snapshotHash: planSnapshotHash("# Plan\n\nClear context."),
		});
		const clear = vi.spyOn(mode, "handleClearCommand").mockResolvedValue(true);
		const prompt = vi.spyOn(session, "prompt").mockResolvedValue(undefined as never);

		await mode.handlePlanApproval({
			planFilePath,
			planExists: true,
			title: "PLAN",
			finalPlanFilePath,
		});

		expect(clear).toHaveBeenCalledTimes(1);
		expect(prompt).toHaveBeenCalledWith(expect.any(String), {
			synthetic: true,
		});
	});

	it("does not dispatch an approved plan when fresh-session creation is refused", async () => {
		const planFilePath = "local://PLAN.md";
		const finalPlanFilePath = "local://APPROVED.md";
		const resolvedPlanPath = resolveLocalUrlToPath(planFilePath, {
			getArtifactsDir: () => session.sessionManager.getArtifactsDir(),
			getSessionId: () => session.sessionManager.getSessionId(),
		});
		await Bun.write(resolvedPlanPath, "# Plan\n\nDo not dispatch in the retained session.");
		mode.planModeEnabled = true;
		mode.planModePlanFilePath = planFilePath;
		vi.spyOn(SelectorController.prototype, "showPlanPreview").mockResolvedValue({
			action: "Approve and execute",
			comments: [],
			notes: "",
			snapshotHash: planSnapshotHash("# Plan\n\nDo not dispatch in the retained session."),
		});
		const clear = vi.spyOn(mode, "handleClearCommand").mockResolvedValue(false);
		const prompt = vi.spyOn(session, "prompt").mockResolvedValue(undefined as never);
		const warning = vi.spyOn(mode, "showWarning");

		await mode.handlePlanApproval({
			planFilePath,
			planExists: true,
			title: "PLAN",
			finalPlanFilePath,
		});

		expect(clear).toHaveBeenCalledTimes(1);
		expect(prompt).not.toHaveBeenCalledWith(expect.any(String), { synthetic: true });
		expect(warning).toHaveBeenCalledWith(
			"Plan approved, but the new session could not be created — execution was not dispatched.",
		);
	});

	it("Approve and compact context: ok outcome dispatches plan-approved after compaction", async () => {
		const planFilePath = "local://PLAN.md";
		const finalPlanFilePath = "local://APPROVED.md";
		const resolvedPlanPath = resolveLocalUrlToPath(planFilePath, {
			getArtifactsDir: () => session.sessionManager.getArtifactsDir(),
			getSessionId: () => session.sessionManager.getSessionId(),
		});
		await Bun.write(resolvedPlanPath, "# Plan\n\nCompact and execute.");

		mode.planModeEnabled = true;
		mode.planModePlanFilePath = planFilePath;
		vi.spyOn(SelectorController.prototype, "showPlanPreview").mockResolvedValue({
			action: "Approve and compact context",
			comments: [],
			notes: "",
			snapshotHash: planSnapshotHash("# Plan\n\nCompact and execute."),
		});
		const compactSpy = vi.spyOn(mode, "handleCompactCommand").mockResolvedValue("ok");
		const markSentSpy = vi.spyOn(session, "markPlanReferenceSent");
		const promptSpy = vi.spyOn(session, "prompt").mockResolvedValue(undefined as never);

		await mode.handlePlanApproval({
			planFilePath,
			planExists: true,
			title: "PLAN",
			finalPlanFilePath,
		});

		// Compaction was run with the rendered planning-specific custom instruction.
		expect(compactSpy).toHaveBeenCalledTimes(1);
		const [compactInstruction] = compactSpy.mock.calls[0]!;
		expect(typeof compactInstruction).toBe("string");
		expect(compactInstruction as string).toContain("Preparing to execute the approved plan");
		expect(compactInstruction as string).toContain(finalPlanFilePath);

		// Plan-approved synthetic prompt was dispatched.
		const planApprovedIdx = promptSpy.mock.calls.findIndex(isPlanApprovedCall);
		expect(planApprovedIdx).toBeGreaterThanOrEqual(0);

		// markPlanReferenceSent fires on the dispatch path so the executor's first
		// turn doesn't double-inject the plan reference (it was just dispatched
		// inside the synthetic prompt).
		expect(markSentSpy).toHaveBeenCalledTimes(1);
	});
	it("finalizes the reviewed bytes when the draft changes during destination publication", async () => {
		const planFilePath = "local://PLAN.md";
		const finalPlanFilePath = "local://APPROVED.md";
		const resolvedPlanPath = resolveLocalUrlToPath(planFilePath, {
			getArtifactsDir: () => session.sessionManager.getArtifactsDir(),
			getSessionId: () => session.sessionManager.getSessionId(),
		});
		const resolvedFinalPath = resolveLocalUrlToPath(finalPlanFilePath, {
			getArtifactsDir: () => session.sessionManager.getArtifactsDir(),
			getSessionId: () => session.sessionManager.getSessionId(),
		});
		const reviewed = "# Plan\n\nReviewed bytes.";
		await Bun.write(resolvedPlanPath, reviewed);
		mode.planModeEnabled = true;
		mode.planModePlanFilePath = planFilePath;
		vi.spyOn(SelectorController.prototype, "showPlanPreview").mockResolvedValue({
			action: "Approve and keep context",
			comments: [],
			notes: "",
			snapshotHash: planSnapshotHash(reviewed),
		});
		const originalLink = fs.link;
		vi.spyOn(fs, "link").mockImplementation(async (existingPath, newPath) => {
			await Bun.write(resolvedPlanPath, "# Plan\n\nChanged after review.");
			return originalLink(existingPath, newPath);
		});
		vi.spyOn(session, "prompt").mockResolvedValue(undefined as never);

		await mode.handlePlanApproval({ planFilePath, planExists: true, title: "PLAN", finalPlanFilePath });

		expect(await Bun.file(resolvedFinalPath).text()).toBe(reviewed);
	});

	it("marks the plan reference only after the approval prompt is accepted", async () => {
		const planFilePath = "local://PLAN.md";
		const finalPlanFilePath = "local://APPROVED.md";
		const resolvedPlanPath = resolveLocalUrlToPath(planFilePath, {
			getArtifactsDir: () => session.sessionManager.getArtifactsDir(),
			getSessionId: () => session.sessionManager.getSessionId(),
		});
		const reviewed = "# Plan\n\nDispatch ordering.";
		await Bun.write(resolvedPlanPath, reviewed);
		mode.planModeEnabled = true;
		mode.planModePlanFilePath = planFilePath;
		vi.spyOn(SelectorController.prototype, "showPlanPreview").mockResolvedValue({
			action: "Approve and keep context",
			comments: [],
			notes: "",
			snapshotHash: planSnapshotHash(reviewed),
		});
		const markSent = vi.spyOn(session, "markPlanReferenceSent");
		vi.spyOn(session, "prompt").mockImplementation(async () => {
			expect(markSent).not.toHaveBeenCalled();
		});

		await mode.handlePlanApproval({ planFilePath, planExists: true, title: "PLAN", finalPlanFilePath });

		expect(markSent).toHaveBeenCalledTimes(1);
	});

	it("Approve and compact context: cancelled outcome skips plan-approved dispatch", async () => {
		// Mock `handleCompactCommand` to surface the "cancelled" outcome directly.
		// (Testing the consumer — `#approvePlan`'s outcome handling — at the
		// CompactionOutcome boundary; the underlying executeCompaction → sentinel
		// classification path is producer-layer and not under T3's contract.)
		const planFilePath = "local://PLAN.md";
		const finalPlanFilePath = "local://APPROVED.md";
		const resolvedPlanPath = resolveLocalUrlToPath(planFilePath, {
			getArtifactsDir: () => session.sessionManager.getArtifactsDir(),
			getSessionId: () => session.sessionManager.getSessionId(),
		});
		await Bun.write(resolvedPlanPath, "# Plan\n\nCancel mid-compact.");

		mode.planModeEnabled = true;
		mode.planModePlanFilePath = planFilePath;
		vi.spyOn(SelectorController.prototype, "showPlanPreview").mockResolvedValue({
			action: "Approve and compact context",
			comments: [],
			notes: "",
			snapshotHash: planSnapshotHash("# Plan\n\nCancel mid-compact."),
		});
		vi.spyOn(mode, "handleCompactCommand").mockResolvedValue("cancelled");
		const showWarningSpy = vi.spyOn(mode, "showWarning");
		const setPlanRefSpy = vi.spyOn(session, "setPlanReferencePath");
		const markSentSpy = vi.spyOn(session, "markPlanReferenceSent");
		const promptSpy = vi.spyOn(session, "prompt").mockResolvedValue(undefined as never);

		await mode.handlePlanApproval({
			planFilePath,
			planExists: true,
			title: "PLAN",
			finalPlanFilePath,
		});

		// Operator was told the dispatch was deferred.
		expect(showWarningSpy).toHaveBeenCalledWith(
			expect.stringContaining("Plan approved, but compaction was cancelled"),
		);
		// Plan reference path was recorded so the session knows about the approved
		// plan at its final destination …
		expect(setPlanRefSpy).toHaveBeenCalledWith(finalPlanFilePath);
		// … but markPlanReferenceSent was NOT called, so the next operator turn
		// will inject the reference fresh via #buildPlanReferenceMessage. This is
		// the load-bearing assertion that the cancel path leaves the executor
		// with the plan in its first turn.
		expect(markSentSpy).not.toHaveBeenCalled();
		// And — the contract — the plan-approved synthetic prompt was NOT dispatched.
		expect(promptSpy.mock.calls.some(isPlanApprovedCall)).toBe(false);
	});

	it("Approve and compact context: failed outcome still dispatches plan-approved (best-effort)", async () => {
		// Mock `handleCompactCommand` to surface the "failed" outcome directly.
		// Failure → approval intent stands → synthetic dispatch fires.
		const planFilePath = "local://PLAN.md";
		const finalPlanFilePath = "local://APPROVED.md";
		const resolvedPlanPath = resolveLocalUrlToPath(planFilePath, {
			getArtifactsDir: () => session.sessionManager.getArtifactsDir(),
			getSessionId: () => session.sessionManager.getSessionId(),
		});
		await Bun.write(resolvedPlanPath, "# Plan\n\nFail mid-compact.");

		mode.planModeEnabled = true;
		mode.planModePlanFilePath = planFilePath;
		vi.spyOn(SelectorController.prototype, "showPlanPreview").mockResolvedValue({
			action: "Approve and compact context",
			comments: [],
			notes: "",
			snapshotHash: planSnapshotHash("# Plan\n\nFail mid-compact."),
		});
		vi.spyOn(mode, "handleCompactCommand").mockResolvedValue("failed");
		const markSentSpy = vi.spyOn(session, "markPlanReferenceSent");
		const promptSpy = vi.spyOn(session, "prompt").mockResolvedValue(undefined as never);

		await mode.handlePlanApproval({
			planFilePath,
			planExists: true,
			title: "PLAN",
			finalPlanFilePath,
		});

		// Plan-approved synthetic prompt WAS dispatched despite the failure.
		expect(promptSpy.mock.calls.some(isPlanApprovedCall)).toBe(true);
		// markPlanReferenceSent fires on this dispatch path.
		expect(markSentSpy).toHaveBeenCalledTimes(1);
	});
	it("Approve and compact context: setPlanReferencePath is pinned BEFORE compaction flushes the queue", async () => {
		// Regression: handleCompactCommand internally awaits flushCompactionQueue,
		// which can deliver a user-queued message back to the session. If
		// setPlanReferencePath had not been called yet, that queued turn would
		// hit #buildPlanReferenceMessage with the stale plan-mode path. Pin it
		// before the compaction await.
		const planFilePath = "local://PLAN.md";
		const finalPlanFilePath = "local://APPROVED.md";
		const resolvedPlanPath = resolveLocalUrlToPath(planFilePath, {
			getArtifactsDir: () => session.sessionManager.getArtifactsDir(),
			getSessionId: () => session.sessionManager.getSessionId(),
		});
		await Bun.write(resolvedPlanPath, "# Plan\n\nQueue race.");

		mode.planModeEnabled = true;
		mode.planModePlanFilePath = planFilePath;
		vi.spyOn(SelectorController.prototype, "showPlanPreview").mockResolvedValue({
			action: "Approve and compact context",
			comments: [],
			notes: "",
			snapshotHash: planSnapshotHash("# Plan\n\nQueue race."),
		});
		vi.spyOn(session, "prompt").mockResolvedValue(undefined as never);

		const setPlanRefSpy = vi.spyOn(session, "setPlanReferencePath");
		let planRefSetWhenCompactionRan = false;
		vi.spyOn(mode, "handleCompactCommand").mockImplementation(async () => {
			planRefSetWhenCompactionRan = setPlanRefSpy.mock.calls.some(call => call[0] === finalPlanFilePath);
			return "ok";
		});

		await mode.handlePlanApproval({
			planFilePath,
			planExists: true,
			title: "PLAN",
			finalPlanFilePath,
		});

		// The contract: by the time handleCompactCommand runs (and flushes the
		// compaction queue inside), setPlanReferencePath has already pinned the
		// approved plan path, so any user message queued during compaction is
		// dispatched against the approved plan, not the plan-mode draft.
		expect(planRefSetWhenCompactionRan).toBe(true);
	});

	// ==========================================================================
	// Phase 6 — B layer: #approvePlan flag lifecycle via try/finally.
	//
	// Drives `handlePlanApproval` with each CompactionOutcome variant and
	// asserts `session.isPlanCompactAbortPending === false` after `#approvePlan`
	// resolves/rejects. The flag is the only state that can leak into later
	// unrelated aborts; the `try/finally` in `#approvePlan` is what protects it.
	// ==========================================================================

	/**
	 * Drives `handlePlanApproval` with the "Approve and compact context"
	 * picker outcome and the given compaction-outcome mock. Returns the promise
	 * the harness produces so the caller decides between `await` (B1-B3 happy
	 * paths) and `expect(...).rejects` (B4 throw path). Does NOT swallow errors.
	 */
	async function approveWithCompact(
		compactOutcome: "ok" | "cancelled" | "failed" | "throw",
		throwError?: Error,
	): Promise<void> {
		const planFilePath = "local://PLAN.md";
		const finalPlanFilePath = "local://APPROVED.md";
		const resolvedPlanPath = resolveLocalUrlToPath(planFilePath, {
			getArtifactsDir: () => session.sessionManager.getArtifactsDir(),
			getSessionId: () => session.sessionManager.getSessionId(),
		});
		await Bun.write(resolvedPlanPath, "# Plan\n\nBody.");

		mode.planModeEnabled = true;
		mode.planModePlanFilePath = planFilePath;
		vi.spyOn(SelectorController.prototype, "showPlanPreview").mockResolvedValue({
			action: "Approve and compact context",
			comments: [],
			notes: "",
			snapshotHash: planSnapshotHash("# Plan\n\nBody."),
		});
		if (compactOutcome === "throw") {
			vi.spyOn(mode, "handleCompactCommand").mockRejectedValue(throwError ?? new Error("compact boom"));
		} else {
			vi.spyOn(mode, "handleCompactCommand").mockResolvedValue(compactOutcome);
		}
		vi.spyOn(session, "prompt").mockResolvedValue(undefined as never);

		await mode.handlePlanApproval({
			planFilePath,
			planExists: true,
			title: "PLAN",
			finalPlanFilePath,
		});
	}

	it("B1: Approve and compact context + ok outcome → flag cleared by finally", async () => {
		await approveWithCompact("ok");
		expect(session.isPlanCompactAbortPending).toBe(false);
	});

	it("B2: Approve and compact context + cancelled outcome → flag cleared by finally even without aborted message_end", async () => {
		await approveWithCompact("cancelled");
		// The leak-guard contract: no aborted message_end consumed the flag,
		// but `finally` still cleared it so the next real abort cannot be
		// silenced.
		expect(session.isPlanCompactAbortPending).toBe(false);
	});

	it("B3: Approve and compact context + failed outcome → flag cleared by finally", async () => {
		await approveWithCompact("failed");
		expect(session.isPlanCompactAbortPending).toBe(false);
	});

	it("B4: Approve and compact context + handleCompactCommand throws → showError surfaces the failure AND flag cleared by finally before the outer catch", async () => {
		// `handlePlanApproval` wraps `#approvePlan` in a try/catch
		// in `InteractiveMode` that consumes the throw and reports via
		// `showError`. The contract under test is:
		//   1. `#approvePlan`'s own `try/finally` clears the flag BEFORE the
		//      throw bubbles up to that outer catch.
		//   2. The outer catch surfaces the failure via `showError` (not
		//      silenced).
		const showErrorSpy = vi.spyOn(mode, "showError");
		await approveWithCompact("throw", new Error("synthetic compaction failure"));
		expect(session.isPlanCompactAbortPending).toBe(false);
		expect(showErrorSpy).toHaveBeenCalledWith(expect.stringContaining("synthetic compaction failure"));
	});

	it("B5: Approve and execute (no compact) → markPlanCompactAbortPending never called; flag stays false", async () => {
		const planFilePath = "local://PLAN.md";
		const finalPlanFilePath = "local://APPROVED.md";
		const resolvedPlanPath = resolveLocalUrlToPath(planFilePath, {
			getArtifactsDir: () => session.sessionManager.getArtifactsDir(),
			getSessionId: () => session.sessionManager.getSessionId(),
		});
		await Bun.write(resolvedPlanPath, "# Plan\n\nBody.");
		mode.planModeEnabled = true;
		mode.planModePlanFilePath = planFilePath;
		vi.spyOn(SelectorController.prototype, "showPlanPreview").mockResolvedValue({
			action: "Approve and execute",
			comments: [],
			notes: "",
			snapshotHash: planSnapshotHash("# Plan\n\nBody."),
		});
		const markSpy = vi.spyOn(session, "markPlanCompactAbortPending");
		vi.spyOn(session, "prompt").mockResolvedValue(undefined as never);

		await mode.handlePlanApproval({
			planFilePath,
			planExists: true,
			title: "PLAN",
			finalPlanFilePath,
		});

		expect(markSpy).not.toHaveBeenCalled();
		expect(session.isPlanCompactAbortPending).toBe(false);
	});

	// ==========================================================================
	// Phase 6 — D layer: replay-side render branches in AssistantMessageComponent.
	//
	// D1 asserts that the persisted `SILENT_ABORT_MARKER` suppresses the red
	// "Operation aborted" line. D2 is the over-suppression regression guard —
	// an aborted message with NO marker must still render the line.
	// ==========================================================================

	function renderAssistant(message: AssistantMessage, width = 120): string {
		const component = new AssistantMessageComponent(message);
		return Bun.stripANSI(component.render(width).join("\n"));
	}

	/** Build an aborted assistant message with the minimum required fields. */
	function buildAbortedAssistantMessage(overrides: Partial<AssistantMessage> = {}): AssistantMessage {
		return {
			role: "assistant",
			content: [{ type: "text", text: "Approved plan; transitioning to compaction." }],
			api: "openai-completions",
			provider: "github-copilot",
			model: "gpt-4o",
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "aborted",
			timestamp: Date.now(),
			...overrides,
		};
	}

	it("D1: Replay of an assistant message with SILENT_ABORT_MARKER + aborted: rendered component contains no /Operation aborted/", () => {
		const message = buildAbortedAssistantMessage({ errorMessage: SILENT_ABORT_MARKER });
		const rendered = renderAssistant(message);
		expect(rendered).not.toMatch(/Operation aborted/);
		// The marker itself MUST NOT leak into rendered output either.
		expect(rendered).not.toContain(SILENT_ABORT_MARKER);
	});

	it("D2: Replay of an aborted message with no marker + empty content: rendered component DOES contain 'Operation aborted'", () => {
		// Over-suppression regression guard: silent path is opt-in via the
		// persisted marker. A user-cancel abort with no marker and no content
		// still surfaces the standard label.
		const message = buildAbortedAssistantMessage({ content: [], errorMessage: undefined });
		const rendered = renderAssistant(message);
		expect(rendered).toContain("Operation aborted");
	});
});
