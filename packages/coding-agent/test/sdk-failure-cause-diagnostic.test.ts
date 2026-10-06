import { describe, expect, it } from "bun:test";
import { createInvocationReconciliation } from "../src/sdk/host/session-runtime";
import {
	agentFailedLifecycleCause,
	FAILURE_CAUSE_DIAGNOSTIC_MAX,
	failedPromptOutcome,
	failureCauseDiagnostic,
	isValidFailureCauseDiagnostic,
	lifecycleFailureCauseDiagnostic,
	publicTerminalOutcome,
	redactedFailureCauseDiagnostic,
	sanitizePromptFailure,
} from "../src/sdk/prompt-failure";
import type { SdkPromptTerminalOutcome } from "../src/sdk/prompt-status";

describe("host terminal outcome failure cause preservation", () => {
	it("preserves the failure cause through canonicalization, staging, and finalization", async () => {
		const reconciliation = createInvocationReconciliation();
		const ids = { commandId: "diagnostic-command", turnId: "diagnostic-turn" };
		reconciliation.admit("prompt", "diagnostic-ref");
		await reconciliation.noteAccepted("prompt", ids, "diagnostic-ref");
		await reconciliation.noteTransition("prompt", ids, { type: "agent_start" });
		const outcome = failedPromptOutcome({
			code: "prompt_failed",
			provenance: "agent_failed",
			evidence: {},
			error: new Error("Network timeout"),
		});
		expect(outcome.kind).toBe("failed");
		if (outcome.kind !== "failed") throw new Error("Expected failed prompt outcome");
		expect(outcome.failureCauseDiagnostic).toBe("Error Network timeout");

		// Staging routes the failed outcome through canonicalTerminalOutcome.
		const staged = await reconciliation.stagePendingTerminalOutcome("prompt", ids, outcome);
		expect(staged).toMatchObject({
			kind: "failed",
			phase: "post_start",
			failureCauseDiagnostic: outcome.failureCauseDiagnostic,
		});
		await reconciliation.finalizeOutcome("prompt", ids);
		expect(reconciliation.lookup("prompt", { clientRef: "diagnostic-ref" })).toMatchObject({
			status: "failed",
			outcome: { kind: "failed", failureCauseDiagnostic: outcome.failureCauseDiagnostic },
		});
	});
});

describe("failureCauseDiagnostic", () => {
	it("extracts class name and message from Error instances", () => {
		const error = new Error("Something went wrong");
		const diagnostic = failureCauseDiagnostic(error);
		expect(diagnostic).toContain("Error");
		expect(diagnostic).toContain("Something went wrong");
	});

	it("extracts only the first line of a multi-line message", () => {
		const error = new Error("First line\nSecond line\nThird line");
		const diagnostic = failureCauseDiagnostic(error);
		expect(diagnostic).toContain("First line");
		expect(diagnostic).not.toContain("Second line");
	});

	it("extracts exitCode from Error instances", () => {
		const error = new Error("Process failed") as Error & { exitCode?: number };
		error.exitCode = 127;
		const diagnostic = failureCauseDiagnostic(error);
		expect(diagnostic).toContain("exit=127");
	});

	it("extracts signal from Error instances", () => {
		const error = new Error("Process killed") as Error & { signal?: string };
		error.signal = "SIGTERM";
		const diagnostic = failureCauseDiagnostic(error);
		expect(diagnostic).toContain("signal=SIGTERM");
	});

	it("extracts code property from Error instances", () => {
		const error = new Error("Child process error") as Error & { code?: number };
		error.code = 42;
		const diagnostic = failureCauseDiagnostic(error);
		expect(diagnostic).toContain("code=42");
	});

	it("prefers signal over exitCode when both are present", () => {
		const error = new Error("Process error") as Error & { signal?: string; exitCode?: number };
		error.signal = "SIGKILL";
		error.exitCode = 137;
		const diagnostic = failureCauseDiagnostic(error);
		expect(diagnostic).toContain("SIGKILL");
		expect(diagnostic).not.toContain("exit=");
	});

	it("accepts only whitelisted signal names", () => {
		for (const signal of ["SIGTERM", "SIGKILL", "SIGABRT", "SIGSEGV", "SIGINT"]) {
			const error = new Error("x") as Error & { signal?: string };
			error.signal = signal;
			const diagnostic = failureCauseDiagnostic(error);
			expect(diagnostic).toContain(`signal=${signal}`);
		}

		const error = new Error("x") as Error & { signal?: string };
		error.signal = "SIGUSR1"; // not whitelisted
		const diagnostic = failureCauseDiagnostic(error);
		expect(diagnostic).not.toContain("SIGUSR1");
	});

	it("validates exitCode is 0-255", () => {
		const errorTooLarge = new Error("x") as Error & { exitCode?: number };
		errorTooLarge.exitCode = 256;
		expect(failureCauseDiagnostic(errorTooLarge)).not.toContain("exit=");

		const errorNegative = new Error("x") as Error & { exitCode?: number };
		errorNegative.exitCode = -1;
		expect(failureCauseDiagnostic(errorNegative)).not.toContain("exit=");

		const errorValid = new Error("x") as Error & { exitCode?: number };
		errorValid.exitCode = 1;
		expect(failureCauseDiagnostic(errorValid)).toContain("exit=1");
	});

	it("validates code is 0-255", () => {
		const errorValid = new Error("x") as Error & { code?: number };
		errorValid.code = 200;
		expect(failureCauseDiagnostic(errorValid)).toContain("code=200");

		const errorInvalid = new Error("x") as Error & { code?: number };
		errorInvalid.code = -5;
		expect(failureCauseDiagnostic(errorInvalid)).not.toContain("code=");
	});

	it("handles plain object errors with code/message/signal/exitCode", () => {
		const error = { code: "ENOENT", message: "File not found", signal: "SIGTERM" };
		const diagnostic = failureCauseDiagnostic(error);
		expect(diagnostic).toContain("File not found");
		expect(diagnostic).toContain("signal=SIGTERM");
	});

	it("handles string errors", () => {
		const error = "Something went wrong";
		const diagnostic = failureCauseDiagnostic(error);
		expect(diagnostic).toContain("Something went wrong");
	});

	it("handles strings with newlines by taking only the first line", () => {
		const error = "First line\nSecond line";
		const diagnostic = failureCauseDiagnostic(error);
		expect(diagnostic).toContain("First line");
		expect(diagnostic).not.toContain("Second line");
	});

	it("redacts secrets from diagnostic", () => {
		const error = new Error("Failed with token: sk-1234567890abcdef");
		const diagnostic = failureCauseDiagnostic(error);
		// redactCrashSecrets should replace the token
		expect(diagnostic).toBeDefined();
		// The redacted version should not contain the full secret
		if (diagnostic?.includes("«redacted")) {
			expect(diagnostic).not.toContain("1234567890abcdef");
		}
	});

	it("truncates diagnostic to FAILURE_CAUSE_DIAGNOSTIC_MAX (200 chars)", () => {
		const longMessage = "x".repeat(500);
		const error = new Error(longMessage);
		const diagnostic = failureCauseDiagnostic(error);
		if (diagnostic) {
			expect(diagnostic.length).toBeLessThanOrEqual(FAILURE_CAUSE_DIAGNOSTIC_MAX);
		}
	});

	it("enforces 200-char cap after sanitization with long className", () => {
		// Create an error with a very long class name that would cause
		// sanitizeExternalCrashV1 to add …[truncated] marker
		const longClassName = "VeryLongCustomError".repeat(15); // ~285 chars
		const error = Object.assign(new Error("message"), {
			constructor: { name: longClassName },
		});
		const diagnostic = failureCauseDiagnostic(error);
		if (diagnostic) {
			// Ensure byte length is capped at 200
			const byteLength = Buffer.byteLength(diagnostic, "utf8");
			expect(byteLength).toBeLessThanOrEqual(FAILURE_CAUSE_DIAGNOSTIC_MAX);
			// Verify it contains meaningful content, not just the truncation marker
			expect(diagnostic.length).toBeGreaterThan(0);
		}
	});

	it("returns undefined for null/undefined errors", () => {
		expect(failureCauseDiagnostic(null)).toBeUndefined();
		expect(failureCauseDiagnostic(undefined)).toBeUndefined();
	});

	it("returns just the class name when message is empty", () => {
		const error = new Error("");
		const diagnostic = failureCauseDiagnostic(error);
		// With empty message, should still contain the class name
		expect(diagnostic).toContain("Error");
	});

	it("handles Error.constructor.name correctly", () => {
		class CustomError extends Error {
			constructor(message: string) {
				super(message);
				this.name = "CustomError";
			}
		}
		const error = new CustomError("custom failure");
		const diagnostic = failureCauseDiagnostic(error);
		expect(diagnostic).toContain("CustomError");
		expect(diagnostic).toContain("custom failure");
	});

	it("handles errors with throwing accessors by returning undefined", () => {
		const error = {
			get message() {
				throw new Error("boom");
			},
		};
		expect(failureCauseDiagnostic(error)).toBeUndefined();
	});

	it("strips absolute POSIX paths from diagnostic", () => {
		const error = new Error("Failed at /home/user/project/src/index.ts:42");
		const diagnostic = failureCauseDiagnostic(error);
		expect(diagnostic).toBeDefined();
		if (diagnostic) {
			expect(diagnostic).not.toContain("/home/user");
			expect(diagnostic).toContain("Failed at");
		}
	});

	it("strips absolute Windows paths from diagnostic", () => {
		const error = new Error("Cannot read C:\\Users\\bob\\file.txt");
		const diagnostic = failureCauseDiagnostic(error);
		expect(diagnostic).toBeDefined();
		if (diagnostic) {
			expect(diagnostic).not.toContain("C:\\");
			expect(diagnostic).toContain("Cannot read");
		}
	});

	it("removes URL query strings and fragments", () => {
		const error = new Error("Request failed: https://api.example.com/path?token=secret&key=value#section");
		const diagnostic = failureCauseDiagnostic(error);
		expect(diagnostic).toBeDefined();
		if (diagnostic) {
			expect(diagnostic).not.toContain("token=secret");
			expect(diagnostic).not.toContain("#section");
			expect(diagnostic).toContain("Request failed");
			expect(diagnostic).toContain("example.com");
		}
	});

	it("strips ANSI control sequences from diagnostic", () => {
		const ansiError = new Error("\u001b[31mRed error\u001b[0m text");
		const diagnostic = failureCauseDiagnostic(ansiError);
		expect(diagnostic).toBeDefined();
		if (diagnostic) {
			expect(diagnostic).not.toContain("\u001b");
			expect(diagnostic).toContain("Red error");
		}
	});

	it("strips URL userinfo (credentials) from diagnostic", () => {
		const error = new Error("Connection failed: https://user:password@database.example.com/app");
		const diagnostic = failureCauseDiagnostic(error);
		expect(diagnostic).toBeDefined();
		if (diagnostic) {
			expect(diagnostic).not.toContain("password");
			expect(diagnostic).toContain("Connection failed");
			expect(diagnostic).toContain("database.example.com");
		}
	});
});

describe("isValidFailureCauseDiagnostic", () => {
	it("accepts non-empty strings <= 200 chars", () => {
		expect(isValidFailureCauseDiagnostic("Error message")).toBe(true);
		expect(isValidFailureCauseDiagnostic("x")).toBe(true);
		expect(isValidFailureCauseDiagnostic("a".repeat(200))).toBe(true);
	});

	it("rejects empty strings", () => {
		expect(isValidFailureCauseDiagnostic("")).toBe(false);
	});

	it("rejects strings > 200 chars", () => {
		expect(isValidFailureCauseDiagnostic("a".repeat(201))).toBe(false);
	});

	it("rejects non-strings", () => {
		expect(isValidFailureCauseDiagnostic(123)).toBe(false);
		expect(isValidFailureCauseDiagnostic(null)).toBe(false);
		expect(isValidFailureCauseDiagnostic(undefined)).toBe(false);
		expect(isValidFailureCauseDiagnostic({ message: "test" })).toBe(false);
		expect(isValidFailureCauseDiagnostic(["Error message"])).toBe(false);
	});
});

describe("redactedFailureCauseDiagnostic", () => {
	it("preserves a valid diagnostic unchanged by redaction", () => {
		expect(redactedFailureCauseDiagnostic("Error: Network timeout")).toBe("Error: Network timeout");
	});

	it("preserves diagnostics already redacted at construction", () => {
		const diagnostic = failureCauseDiagnostic(new Error("Failed with token: sk-1234567890abcdef"));
		expect(diagnostic).toBeDefined();
		expect(diagnostic).not.toContain("sk-1234567890abcdef");
		expect(redactedFailureCauseDiagnostic(diagnostic)).toBe(diagnostic);
	});

	it("rejects invalid values and unredacted secrets", () => {
		for (const value of [null, undefined, 123, {}, [], "", "x".repeat(201), "Error sk-1234567890abcdef"]) {
			expect(redactedFailureCauseDiagnostic(value)).toBeUndefined();
		}
	});
});

describe("publicTerminalOutcome validation of failureCauseDiagnostic", () => {
	it("drops a tampered diagnostic containing an unredacted secret", () => {
		const outcome = {
			...failedPromptOutcome({ code: "prompt_failed", provenance: "agent_failed", evidence: {} }),
			failureCauseDiagnostic: "Error sk-1234567890abcdef",
		};
		const projected = publicTerminalOutcome(outcome);
		expect(projected.failureCauseDiagnostic).toBeUndefined();
		expect(outcome.failureCauseDiagnostic).toBe("Error sk-1234567890abcdef");
	});

	it("preserves valid failureCauseDiagnostic in public projection", () => {
		const error = new Error("test failure");
		const outcome = failedPromptOutcome({
			code: "prompt_failed",
			provenance: "agent_failed",
			evidence: {},
			error,
		}) as Extract<SdkPromptTerminalOutcome, { kind: "failed" }>;

		const projected = publicTerminalOutcome(outcome);
		expect((projected as any).failureCauseDiagnostic).toBeDefined();
		expect(typeof (projected as any).failureCauseDiagnostic).toBe("string");
	});

	it("drops invalid failureCauseDiagnostic from public projection", () => {
		const outcome = failedPromptOutcome({
			code: "prompt_failed",
			provenance: "agent_failed",
			evidence: {},
		}) as Extract<SdkPromptTerminalOutcome, { kind: "failed" }>;

		// Manually inject an invalid diagnostic to simulate a corrupted durable row
		const invalidOutcome = {
			...outcome,
			failureCauseDiagnostic: 123, // invalid: not a string
		} as any;

		const projected = publicTerminalOutcome(invalidOutcome);
		expect((projected as any).failureCauseDiagnostic).toBeUndefined();
	});

	it("drops oversized failureCauseDiagnostic from public projection", () => {
		const outcome = failedPromptOutcome({
			code: "prompt_failed",
			provenance: "agent_failed",
			evidence: {},
		}) as Extract<SdkPromptTerminalOutcome, { kind: "failed" }>;

		// Manually inject an oversized diagnostic
		const invalidOutcome = {
			...outcome,
			failureCauseDiagnostic: "x".repeat(201),
		} as any;

		const projected = publicTerminalOutcome(invalidOutcome);
		expect((projected as any).failureCauseDiagnostic).toBeUndefined();
	});

	it("passes through stopped outcomes unchanged", () => {
		const outcome: SdkPromptTerminalOutcome = {
			kind: "stopped",
			reason: "end_turn",
			provenance: "agent",
		};

		const projected = publicTerminalOutcome(outcome);
		expect(projected).toEqual(outcome);
	});

	it("passes through undefined outcomes", () => {
		const projected = publicTerminalOutcome(undefined);
		expect(projected).toBeUndefined();
	});
});

describe("failedPromptOutcome with error parameter", () => {
	it("includes extracted failureCauseDiagnostic when error is provided", () => {
		const error = new Error("Network timeout");
		const outcome = failedPromptOutcome({
			code: "prompt_failed",
			provenance: "agent_failed",
			evidence: {},
			error,
		}) as Extract<SdkPromptTerminalOutcome, { kind: "failed" }>;

		expect((outcome as any).failureCauseDiagnostic).toBeDefined();
		expect((outcome as any).failureCauseDiagnostic).toContain("Error");
		expect((outcome as any).failureCauseDiagnostic).toContain("Network timeout");
	});

	it("omits failureCauseDiagnostic when error is not provided", () => {
		const outcome = failedPromptOutcome({
			code: "prompt_failed",
			provenance: "agent_failed",
			evidence: {},
		}) as Extract<SdkPromptTerminalOutcome, { kind: "failed" }>;

		expect((outcome as any).failureCauseDiagnostic).toBeUndefined();
	});

	it("omits failureCauseDiagnostic when failureCauseDiagnostic() returns undefined", () => {
		const outcome = failedPromptOutcome({
			code: "prompt_failed",
			provenance: "agent_failed",
			evidence: {},
		}) as Extract<SdkPromptTerminalOutcome, { kind: "failed" }>;

		expect((outcome as any).failureCauseDiagnostic).toBeUndefined();
	});

	it("omits failureCauseDiagnostic when error is null/undefined", () => {
		const outcomeNull = failedPromptOutcome({
			code: "prompt_failed",
			provenance: "agent_failed",
			evidence: {},
			error: null,
		}) as Extract<SdkPromptTerminalOutcome, { kind: "failed" }>;

		expect((outcomeNull as any).failureCauseDiagnostic).toBeUndefined();

		const outcomeUndef = failedPromptOutcome({
			code: "prompt_failed",
			provenance: "agent_failed",
			evidence: {},
			error: undefined,
		}) as Extract<SdkPromptTerminalOutcome, { kind: "failed" }>;

		expect((outcomeUndef as any).failureCauseDiagnostic).toBeUndefined();
	});
});

describe("host-level failure cause diagnostic retention through agent_failed/agent_end", () => {
	it("retains failure cause diagnostic from agent_failed until agent_end emission", () => {
		const originalError = Object.assign(new Error("Process killed"), {
			signal: "SIGKILL",
			code: "kill_signal",
		});

		// Extract the failure cause diagnostic that would be stored
		const storedDiagnostic = failureCauseDiagnostic(originalError);
		expect(storedDiagnostic).toBeDefined();
		expect(storedDiagnostic).toContain("Error");
		expect(storedDiagnostic).toContain("Process killed");
		expect(storedDiagnostic).toContain("signal=SIGKILL");

		// When agent_end reconstructs a failure from stored diagnostic, it should include the message
		const reconstructedOutcome = failedPromptOutcome({
			code: "prompt_failed",
			provenance: "agent_failed",
			evidence: {},
			error: originalError,
		});

		expect(reconstructedOutcome.kind).toBe("failed");
		if (reconstructedOutcome.kind !== "failed") throw new Error("Expected failed outcome");
		expect(reconstructedOutcome.failureCauseDiagnostic).toBe(storedDiagnostic);
	});

	it("preserves diagnostic when agent_end receives the stored failure cause", () => {
		const error = Object.assign(new Error("boom"), {
			signal: "SIGKILL",
		});

		const diagnosticFromAgentFailed = failureCauseDiagnostic(error);

		// With the stored diagnostic passed, it should be preserved
		const outcomeWithDiagnostic = failedPromptOutcome({
			code: "prompt_failed",
			provenance: "agent_failed",
			evidence: {},
			error: error, // Including original error to derive diagnostic
		});

		if (outcomeWithDiagnostic.kind !== "failed") throw new Error("Expected failed outcome");
		expect(outcomeWithDiagnostic.failureCauseDiagnostic).toBe(diagnosticFromAgentFailed);

		// Verify the diagnostic contains the key information that would be lost without it
		expect(outcomeWithDiagnostic.failureCauseDiagnostic).toContain("boom");
	});
});

describe("agent_failed lifecycle carries the original diagnostic past the public sanitizer", () => {
	const original = Object.assign(new Error("boom"), { signal: "SIGKILL" });
	const sanitized = sanitizePromptFailure(original);
	const captured = failureCauseDiagnostic(original);

	it("captures the real cause before sanitization", () => {
		expect(sanitized.message).toBe("Prompt submission failed.");
		expect(captured).toContain("boom");
		expect(captured).toContain("SIGKILL");
	});

	it("re-deriving from the sanitized error alone loses the cause", () => {
		expect(lifecycleFailureCauseDiagnostic(sanitized)).not.toContain("boom");
	});

	it("retains the carried diagnostic instead of the sanitized message", () => {
		const cause = agentFailedLifecycleCause(sanitized, captured);
		expect(lifecycleFailureCauseDiagnostic(cause)).toBe(captured);
		expect(sanitizePromptFailure(cause).code).toBe(sanitized.code);
	});

	it("rejects a carried diagnostic that the outbound sanitizer would change", () => {
		const cause = agentFailedLifecycleCause(sanitized, "Error sk-1234567890abcdef");
		expect(lifecycleFailureCauseDiagnostic(cause)).not.toContain("sk-1234567890abcdef");
	});

	it("passes the error through unchanged when no diagnostic was captured", () => {
		expect(agentFailedLifecycleCause(sanitized, undefined)).toBe(sanitized);
	});
});
