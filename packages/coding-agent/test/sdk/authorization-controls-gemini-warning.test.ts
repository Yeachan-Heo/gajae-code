import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { AuthStorage, SqliteAuthCredentialStore } from "@gajae-code/ai/core";
import * as geminiCliModule from "@gajae-code/ai/utils/oauth/google-gemini-cli";

import { AuthorizationControls } from "../../src/sdk/authorization-controls";
import type { AgentSession } from "../../src/session/agent-session";

describe("AuthorizationControls SDK warning confirmation", () => {
	let tempDir = "";
	let dbPath = "";
	let store: SqliteAuthCredentialStore | null = null;
	let authStorage: AuthStorage | null = null;
	let loginGeminiCliSpy: Mock<typeof geminiCliModule.loginGeminiCli>;
	let mockSession: Partial<AgentSession> | null = null;

	beforeEach(async () => {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-auth-sdk-warning-"));
		dbPath = path.join(tempDir, "agent.db");
		store = await SqliteAuthCredentialStore.open(dbPath);
		authStorage = new AuthStorage(store);
		loginGeminiCliSpy = vi.spyOn(geminiCliModule, "loginGeminiCli");

		// Create a minimal mock session for AuthorizationControls
		mockSession = {
			isDisposed: false,
			sessionId: "test-session-id",
			credentialSessionId: "test-cred-session-id",
			sessionManager: {
				getSessionId: () => "test-manager-session-id",
				getSessionIdentityGeneration: () => 1,
			} as any,
			modelRegistry: {
				authStorage: authStorage!,
				refresh: async () => {},
				getAuthStorageOwner: () => ({}),
				getAll: () => [],
			} as any,
			registerToolSessionCleanup: () => () => {},
			registerToolSessionTransitionCleanup: () => () => {},
			subscribeSessionIdentityChanges: () => () => {},
		} as any;
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		store?.close();
		store = null;
		authStorage = null;
		mockSession = null;
		dbPath = "";
		if (tempDir) {
			await fs.rm(tempDir, { recursive: true, force: true });
			tempDir = "";
		}
	});

	it("surfaces warning in authorization flow state before OAuth URL", async () => {
		if (!store || !authStorage || !mockSession) throw new Error("test setup failed");

		loginGeminiCliSpy.mockImplementationOnce(async () => {
			// Simulate that onAuth will be called after login starts
			return {
				access: "test-access-token",
				refresh: "test-refresh-token",
				expires: Date.now() + 3600000,
			};
		});

		const authControls = new AuthorizationControls(mockSession as AgentSession);

		// Start the authorization flow
		const initialState = (await authControls.execute("auth.start", {
			provider: "google-gemini-cli",
			manualCode: false,
		})) as any;
		expect(initialState.provider).toBe("google-gemini-cli");
		expect(initialState.status).toBe("authorizing");

		// Wait a bit for the warning to arrive
		await new Promise(r => setTimeout(r, 100));

		// Get the current flow state to check if warning appeared
		const flowState = (await authControls.execute("auth.read", {
			flowId: initialState.id,
		})) as any;
		expect(flowState.warning).toBeDefined();
		expect(flowState.warning?.message).toContain("account suspension");

		await authControls.close();
	});

	it("requires explicit confirmation before OAuth URL is exposed", async () => {
		if (!store || !authStorage || !mockSession) throw new Error("test setup failed");

		const authUrls: string[] = [];
		loginGeminiCliSpy.mockImplementationOnce(async (ctrl: any) => {
			// Record if onAuth was called (which indicates OAuth URL was shown)
			if (ctrl.onAuth) {
				return new Promise(resolve => {
					// Don't call onAuth until confirmation is given via onConfirmWarning
					authUrls.push("called");
					resolve({
						access: "test-access-token",
						refresh: "test-refresh-token",
						expires: Date.now() + 3600000,
					});
				});
			}
			return {
				access: "test-access-token",
				refresh: "test-refresh-token",
				expires: Date.now() + 3600000,
			};
		});

		const authControls = new AuthorizationControls(mockSession as AgentSession);
		const initialState = (await authControls.execute("auth.start", {
			provider: "google-gemini-cli",
			manualCode: false,
		})) as any;

		// Wait for warning to appear in flow state
		await new Promise(r => setTimeout(r, 100));
		const flowState = (await authControls.execute("auth.read", {
			flowId: initialState.id,
		})) as any;
		expect(flowState.warning).toBeDefined();
		const warningId = flowState.warning!.id;

		// At this point, no OAuth URL should be exposed
		const flowState2 = (await authControls.execute("auth.read", {
			flowId: initialState.id,
		})) as any;
		expect(flowState2.url).toBeUndefined();

		// Provide confirmation
		await authControls.execute("auth.answer", {
			flowId: initialState.id,
			promptId: warningId,
			value: "yes",
		});

		// OAuth should now proceed
		await new Promise(r => setTimeout(r, 100));

		await authControls.close();
	});

	it("aborts authorization if user declines warning confirmation", async () => {
		if (!store || !authStorage || !mockSession) throw new Error("test setup failed");

		loginGeminiCliSpy.mockImplementationOnce(async () => {
			throw new Error("OAuth helper should not be called if user declines");
		});

		const authControls = new AuthorizationControls(mockSession as AgentSession);
		const initialState = (await authControls.execute("auth.start", {
			provider: "google-gemini-cli",
			manualCode: false,
		})) as any;

		// Wait for warning to appear
		await new Promise(r => setTimeout(r, 100));
		const flowState = (await authControls.execute("auth.read", {
			flowId: initialState.id,
		})) as any;
		expect(flowState.warning).toBeDefined();
		const warningId = flowState.warning!.id;

		// Provide rejection
		await authControls.execute("auth.answer", {
			flowId: initialState.id,
			promptId: warningId,
			value: "no",
		});

		// Wait for the flow to process the rejection
		await new Promise(r => setTimeout(r, 100));

		// The flow should now be in an error state
		const flowStateError = (await authControls.execute("auth.read", {
			flowId: initialState.id,
		})) as any;
		expect(flowStateError.status).toBe("error");

		await authControls.close();
	});

	it("accepts confirmation values", async () => {
		if (!store || !authStorage || !mockSession) throw new Error("test setup failed");

		loginGeminiCliSpy.mockImplementationOnce(async () => ({
			access: "test-access-token",
			refresh: "test-refresh-token",
			expires: Date.now() + 3600000,
		}));

		const authControls = new AuthorizationControls(mockSession as AgentSession);
		const initialState = (await authControls.execute("auth.start", {
			provider: "google-gemini-cli",
			manualCode: false,
		})) as any;

		// Wait for warning
		await new Promise(r => setTimeout(r, 50));
		const flowState = (await authControls.execute("auth.read", {
			flowId: initialState.id,
		})) as any;
		const warningId = flowState.warning?.id;
		expect(warningId).toBeDefined();

		// Confirm with "yes"
		await authControls.execute("auth.answer", {
			flowId: initialState.id,
			promptId: warningId!,
			value: "yes",
		});

		// Give it time to process
		await new Promise(r => setTimeout(r, 50));

		await authControls.close();
	});
});
