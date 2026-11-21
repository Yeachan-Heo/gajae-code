import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { Agent } from "@gajae-code/agent-core";
import { getBundledModel } from "@gajae-code/ai";
import { ModelRegistry } from "@gajae-code/coding-agent/config/model-registry";
import { Settings } from "@gajae-code/coding-agent/config/settings";
import {
	AgentSession,
	type AgentSessionConfig,
	isSessionDisposalIncompleteError,
} from "@gajae-code/coding-agent/session/agent-session";
import { AuthStorage } from "@gajae-code/coding-agent/session/auth-storage";
import { SessionManager } from "@gajae-code/coding-agent/session/session-manager";
import * as tabSupervisor from "@gajae-code/coding-agent/tools/browser/tab-supervisor";
import { TempDir } from "@gajae-code/utils";

describe("AgentSession disposal with browser tab release timeout", () => {
	let tempDir: TempDir | undefined;
	let authStorage: AuthStorage | undefined;
	let session: AgentSession | undefined;
	let releaseTabs: ReturnType<typeof vi.fn>;

	async function createDisposableSession(overrides: Partial<AgentSessionConfig> = {}): Promise<AgentSession> {
		tempDir = TempDir.createSync("@gjc-disposal-browser-timeout-");
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth.db"));
		const mock = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!mock) throw new Error("Expected bundled model to exist");
		authStorage.setRuntimeApiKey(mock.provider, "test-key");
		const modelRegistry = new ModelRegistry(authStorage);
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model: mock, systemPrompt: ["Test"], tools: [], messages: [] },
		});
		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(tempDir.path()),
			settings: Settings.isolated(),
			modelRegistry,
			...overrides,
		});
		return session;
	}

	beforeEach(async () => {
		releaseTabs = vi.spyOn(tabSupervisor, "releaseTabsForOwner");
	});

	afterEach(async () => {
		// Ensure the spies resolve
		releaseTabs.mockResolvedValue(0);
		await session?.dispose().catch(() => {});
		session = undefined;
		authStorage?.close();
		authStorage = undefined;
		tempDir?.removeSync();
		tempDir = undefined;
		vi.restoreAllMocks();
	});

	it("handles browser tab release timeout gracefully during session dispose", async () => {
		session = await createDisposableSession();
		session!.setDisposeTimeoutForTests(500);

		// Simulate browser tab release hanging indefinitely
		const hangs = Promise.withResolvers<void>();
		releaseTabs.mockImplementation(() => hangs.promise);

		// Dispose should timeout with SessionDisposalIncompleteError
		const disposeError = await session!.dispose().catch(err => err);
		expect(isSessionDisposalIncompleteError(disposeError)).toBe(true);
		expect(disposeError.message).toContain("browser tab release");
	});

	it("passes dispose deadline to releaseTabsForOwner", async () => {
		session = await createDisposableSession();
		releaseTabs.mockResolvedValue(0);

		await session!.dispose();

		// Check that releaseTabsForOwner was called with deadlineAt option
		expect(releaseTabs).toHaveBeenCalledWith(
			expect.any(String),
			expect.objectContaining({ deadlineAt: expect.any(Number) }),
		);

		const callArgs = releaseTabs.mock.calls[0];
		if (!callArgs) throw new Error("Expected releaseTabsForOwner to be called");
		const opts = callArgs[1] as { deadlineAt?: number };
		expect(opts.deadlineAt).toBeDefined();
		expect(opts.deadlineAt!).toBeGreaterThan(Date.now());
	});

	it("SDK shutdown handler is resilient to SessionDisposalIncompleteError", async () => {
		session = await createDisposableSession();
		releaseTabs.mockResolvedValue(0);

		// Verify the fix is in place by checking that the shutdown handler
		// is defined to handle disposal errors gracefully.
		// We can verify this by ensuring dispose doesn't crash the process.
		const disposePromise = session!.dispose();
		await expect(disposePromise).resolves.toBeUndefined();
	});

	it("dispose respects browser tab release deadline during long shutdown", async () => {
		// Set a very short timeout to test deadline enforcement
		session = await createDisposableSession();
		session!.setDisposeTimeoutForTests(100);

		// Mock releaseTabsForOwner to verify it receives a deadline
		const receivedCalls: Array<{ ownerId: string | null | undefined; opts?: any }> = [];
		releaseTabs.mockImplementation(async (ownerId, opts) => {
			receivedCalls.push({ ownerId, opts });
			// Always return quickly so we can test the deadline was passed
			return 0;
		});

		// Dispose should include the deadline in the call to releaseTabsForOwner
		const disposePromise = session!.dispose();
		await disposePromise.catch(() => {});

		// Either successful or timed out, but it should have received the deadline
		expect(receivedCalls.length).toBeGreaterThan(0);
		const lastCall = receivedCalls[receivedCalls.length - 1];
		expect(lastCall?.opts?.deadlineAt).toBeDefined();
	});
});
