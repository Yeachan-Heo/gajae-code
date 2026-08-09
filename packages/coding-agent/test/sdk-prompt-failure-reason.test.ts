import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "../src/extensibility/extensions";
import { createSdkSessionRuntimeExtension, type SessionSdkTransport } from "../src/sdk/host/session-runtime";
import type { SdkFrame } from "../src/sdk/host/types";

interface PromptSubmissionOptions {
	onPreflightAccepted?: () => void;
	onPreflightAcceptCommit?: () => Promise<void>;
}

interface FailedOutcome {
	status: "failed";
	error: { code: string; message: string };
}

interface MemoryTransport extends SessionSdkTransport {
	feed(connectionId: string, frame: SdkFrame): void;
	readonly sent: SdkFrame[];
}

const temporaryRoots: string[] = [];

afterEach(async () => {
	for (const root of temporaryRoots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});

async function waitFor(predicate: () => boolean | Promise<boolean>, label: string): Promise<void> {
	const deadline = Date.now() + 10_000;
	while (!(await predicate())) {
		if (Date.now() > deadline) throw new Error(`Timed out waiting for ${label}`);
		await Bun.sleep(10);
	}
}

function memoryTransport(sessionId: string, stateRoot: string, token: string): MemoryTransport {
	let handler: ((connectionId: string, frame: SdkFrame) => void) | undefined;
	let started = false;
	const sent: SdkFrame[] = [];
	return {
		sessionId,
		stateRoot,
		token,
		sent,
		onFrame(next) {
			handler = next;
			return () => {
				if (handler === next) handler = undefined;
			};
		},
		sendFrame(_connectionId, frame) {
			sent.push(frame);
		},
		async start() {
			started = true;
			return { url: "ws://127.0.0.1:1" };
		},
		async stop() {
			started = false;
		},
		feed(connectionId, frame) {
			if (!started) throw new Error("transport is not started");
			handler?.(connectionId, frame);
		},
	};
}

async function failedPrompt(
	error: unknown,
): Promise<{ client: FailedOutcome; persisted: FailedOutcome; recordBytes: number }> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-sdk-failure-reason-"));
	temporaryRoots.push(root);
	const sessionId = `failure-reason-${crypto.randomUUID()}`;
	const handlers = new Map<string, (event: unknown, context: ExtensionContext) => void | Promise<void>>();
	let transport: MemoryTransport | undefined;
	const api = {
		on(event: string, handler: (event: unknown, context: ExtensionContext) => void | Promise<void>) {
			handlers.set(event, handler);
		},
		sendUserMessage(_content: unknown, options?: PromptSubmissionOptions) {
			const accepted = options?.onPreflightAcceptCommit?.() ?? Promise.resolve();
			return accepted.then(() => {
				throw error;
			});
		},
	} as unknown as ExtensionAPI;
	createSdkSessionRuntimeExtension(api, {
		createTransport(input) {
			transport = memoryTransport(input.sessionId, input.stateRoot, input.token);
			return transport;
		},
	});
	const context = {
		cwd: root,
		workflowGate: undefined,
		sdkBindings: () => [],
		sessionManager: {
			getSessionId: () => sessionId,
			getSessionName: () => undefined,
		},
	} as unknown as ExtensionContext;
	await handlers.get("session_start")?.({}, context);
	if (!transport) throw new Error("SDK transport was not created");

	transport.feed("client", {
		type: "control_request",
		id: "prompt",
		operation: "turn.prompt",
		input: { text: "fail after acceptance", clientRef: "failure-ref" },
	});
	await waitFor(
		() => transport?.sent.some(frame => frame.type === "control_response" && frame.id === "prompt") === true,
		"accepted prompt response",
	);
	const recordPath = path.join(root, ".gjc", "state", ".sdk-reconciliation", `${sessionId}.json`);
	await waitFor(async () => {
		try {
			await fs.access(recordPath);
			return true;
		} catch {
			return false;
		}
	}, "persisted reconciliation record");
	await Bun.sleep(0);

	transport.feed("client", {
		type: "query_request",
		id: "status",
		query: "turn.prompt_status",
		input: { clientRef: "failure-ref" },
	});
	await waitFor(
		() => transport?.sent.some(frame => frame.type === "query_response" && frame.id === "status") === true,
		"prompt status response",
	);
	const response = transport.sent.find(frame => frame.type === "query_response" && frame.id === "status") as
		| { ok?: boolean; result?: FailedOutcome }
		| undefined;
	if (response?.ok !== true || response.result?.status !== "failed") {
		await handlers.get("session_shutdown")?.({}, context);
		throw new Error(`expected failed prompt status, received ${JSON.stringify(response?.result)}`);
	}
	await waitFor(async () => {
		const document = JSON.parse(await fs.readFile(recordPath, "utf8")) as { records: FailedOutcome[] };
		return document.records[0]?.status === "failed";
	}, "persisted failed prompt outcome");
	const document = JSON.parse(await fs.readFile(recordPath, "utf8")) as { records: FailedOutcome[] };
	const recordBytes = (await fs.stat(recordPath)).size;
	await handlers.get("session_shutdown")?.({}, context);
	return { client: response.result, persisted: document.records[0] as FailedOutcome, recordBytes };
}

describe("SDK prompt failure reason observable boundaries", () => {
	it("keeps the accepted failure reason local while returning the constant wire message", async () => {
		const { client, persisted } = await failedPrompt(
			Object.assign(new Error("anthropic returned 529 overloaded_error"), { code: "provider_overloaded" }),
		);
		expect(client.error).toEqual({
			code: "provider_overloaded",
			message: "Invocation failed.",
		});
		expect(persisted.error).toEqual({
			code: "provider_overloaded",
			message: "anthropic returned 529 overloaded_error",
		});
	});

	it("persists readable plain failure records without exposing them to SDK clients", async () => {
		const { client, persisted } = await failedPrompt({
			phase: "tool_dispatch",
			reason: "worker_exit",
			message: "bash tool worker exited with signal SIGSEGV",
		});
		expect(client.error).toEqual({ code: "prompt_failed", message: "Invocation failed." });
		expect(persisted.error.message).toContain("bash tool worker exited with signal SIGSEGV");
		expect(persisted.error.message).toContain("phase=tool_dispatch");
		expect(persisted.error.message).toContain("reason=worker_exit");
		expect(persisted.error.message).not.toContain("[object Object]");
	});

	it("rejects credential-shaped and oversized codes before persistence or wire return", async () => {
		const { client, persisted, recordBytes } = await failedPrompt({
			code: `sk-${"a".repeat(1024 * 1024)}`,
			message: "provider request failed after credential refresh",
		});
		expect(client.error).toEqual({ code: "prompt_failed", message: "Invocation failed." });
		expect(persisted.error.code).toBe("prompt_failed");
		expect(persisted.error.message).toBe("provider request failed after credential refresh");
		expect(recordBytes).toBeLessThan(4096);
	});
});
