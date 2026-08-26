import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { Agent } from "@gajae-code/agent-core";
import { ModelRegistry } from "@gajae-code/coding-agent/config/model-registry";
import { resetSettingsForTest, Settings } from "@gajae-code/coding-agent/config/settings";
import { submitInteractiveInput } from "@gajae-code/coding-agent/main";
import { InteractiveMode } from "@gajae-code/coding-agent/modes/interactive-mode";
import { initTheme } from "@gajae-code/coding-agent/modes/theme/theme";
import { AgentSession } from "@gajae-code/coding-agent/session/agent-session";
import { AuthStorage } from "@gajae-code/coding-agent/session/auth-storage";
import { SessionManager } from "@gajae-code/coding-agent/session/session-manager";
import { TempDir } from "@gajae-code/utils";

describe("issue #927 optimistic pending spinner", () => {
	let authStorage: AuthStorage;
	let mode: InteractiveMode;
	let session: AgentSession;
	let tempDir: TempDir;

	beforeAll(() => {
		initTheme();
	});

	beforeEach(async () => {
		vi.spyOn(process.stdout, "write").mockReturnValue(true);
		vi.spyOn(process.stdin, "resume").mockReturnValue(process.stdin);
		vi.spyOn(process.stdin, "pause").mockReturnValue(process.stdin);
		vi.spyOn(process.stdin, "setEncoding").mockReturnValue(process.stdin);
		if (typeof process.stdin.setRawMode === "function") {
			vi.spyOn(process.stdin, "setRawMode").mockReturnValue(process.stdin);
		}

		resetSettingsForTest();
		tempDir = TempDir.createSync("@pi-issue-927-");
		await Settings.init({ inMemory: true, cwd: tempDir.path() });
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth.db"));
		const modelRegistry = new ModelRegistry(authStorage);
		const model = modelRegistry.find("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected claude-sonnet-4-5 test model");

		session = new AgentSession({
			agent: new Agent({ initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] } }),
			sessionManager: SessionManager.create(tempDir.path(), tempDir.path()),
			settings: Settings.isolated(),
			modelRegistry,
		});
		vi.spyOn(session, "prompt").mockResolvedValue(undefined);
		mode = new InteractiveMode(session, "test");
		mode.addMessageToChat = vi.fn();
		mode.ui.requestRender = vi.fn();
	});

	afterEach(async () => {
		mode?.stop();
		vi.restoreAllMocks();
		await session?.dispose();
		authStorage?.close();
		tempDir?.removeSync();
		resetSettingsForTest();
	});

	it("clears the optimistic loading animation when prompt returns without a model turn", async () => {
		const input = mode.startPendingSubmission({ text: "/extension-no-turn" });
		expect(mode.loadingAnimation).toBeDefined();
		expect(mode.optimisticUserMessageSignature).toBe("/extension-no-turn\u00000");

		await submitInteractiveInput(mode, session, input);

		expect(mode.loadingAnimation).toBeUndefined();
		expect(mode.optimisticUserMessageSignature).toBeUndefined();
		expect(mode.locallySubmittedUserSignatures.has("/extension-no-turn\u00000")).toBe(false);
		expect(mode.statusContainer.children.length).toBe(0);
	});

	it("keeps overlapping prompt ownership exact until both deliveries settle", () => {
		const first = mode.startPendingSubmission({ text: "first follow-up" });
		const second = mode.startPendingSubmission({ text: "second follow-up" });
		mode.markPendingSubmissionStarted(first);
		mode.markPendingSubmissionStarted(second);
		mode.showError("first delivery failed");

		expect(mode.hasPendingSubmission()).toBe(true);
		expect(mode.loadingAnimation).toBeDefined();
		mode.finishPendingSubmission(first);
		expect(mode.hasPendingSubmission()).toBe(true);
		expect(mode.loadingAnimation).toBeDefined();
		expect(mode.locallySubmittedUserSignatures.has("first follow-up\u00000")).toBe(false);
		expect(mode.locallySubmittedUserSignatures.has("second follow-up\u00000")).toBe(true);

		mode.finishPendingSubmission(second);
		expect(mode.hasPendingSubmission()).toBe(false);
		expect(mode.loadingAnimation).toBeUndefined();
		expect(mode.locallySubmittedUserSignatures.has("second follow-up\u00000")).toBe(false);
	});

	it("retains duplicate local signature leases until every owner settles", () => {
		const signature = "same follow-up\u00000";
		mode.recordLocalSubmission("same follow-up");
		mode.recordLocalSubmission("same follow-up");
		const localSignatures = mode.locallySubmittedUserSignatures as Set<string> & {
			consumeDelivered(value: string): boolean;
		};

		expect(localSignatures.consumeDelivered(signature)).toBe(true);
		expect(localSignatures.has(signature)).toBe(true);
		expect(localSignatures.delete(signature)).toBe(true);
		expect(localSignatures.has(signature)).toBe(true);
		expect(localSignatures.delete(signature)).toBe(true);
		expect(localSignatures.has(signature)).toBe(false);
	});
});
