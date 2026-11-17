import { afterEach, describe, expect, it, spyOn } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { type AssistantMessage, getBundledModel } from "@gajae-code/ai";
import type { BashResult } from "../../src/exec/bash-executor";
import { createEmbeddedAgentSession } from "../../src/sdk/embedding";
import {
	consentEmbeddedDisconnect,
	type NativeEmbeddedOpenResult,
	prepareEmbeddedDisconnect,
	recordEmbeddedResumeCheckpoint,
	terminateEmbeddedAgentSession,
} from "../../src/sdk/native-embedding";
import { assertNativeRuntimeEffect, NativeRuntimeRefusal } from "../../src/sdk/native-lifecycle";
import { SdkOperatorControls, SdkOperatorError } from "../../src/sdk/operator-controls";
import { SideConversationControls } from "../../src/sdk/side-conversation";
import { AuthStorage } from "../../src/session/auth-storage";

type Opened = Extract<NativeEmbeddedOpenResult, { kind: "opened" }>;
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function disconnect(opened: Opened): Promise<void> {
	if (opened.result.session.sessionManager.getStrictCloseState().kind !== "none_started") return;
	const preparation = await prepareEmbeddedDisconnect(opened.handle, opened.op);
	if (!preparation.inventory) throw new Error("Missing actual native work inventory");
	const consent = consentEmbeddedDisconnect(opened.handle, preparation, {
		stopAndJoin: true,
		work: {
			inventory: preparation.inventory,
			targets: preparation.inventory.blockers.flatMap(blocker => (blocker.target ? [blocker.target] : [])),
		},
	});
	if (!consent) throw new Error("Missing actual native termination consent");
	await terminateEmbeddedAgentSession(opened.handle, { op: opened.op, consent });
}

async function fixture(native = true) {
	const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "gjc-native-owned-controls-")));
	const cwd = path.join(root, "project");
	const agentDir = path.join(root, "agent");
	await fs.mkdir(cwd);
	const auth = await AuthStorage.create(path.join(agentDir, "auth.db"));
	const model = getBundledModel("anthropic", "claude-sonnet-4-5");
	if (!model) throw new Error("Missing bundled fixture model");
	auth.setRuntimeApiKey(model.provider, "test-only-key");
	await Bun.write(
		path.join(agentDir, "config.yml"),
		JSON.stringify({
			recipe: { enabled: false },
			compaction: { enabled: false },
			retry: { enabled: false },
			tools: { discoveryMode: "off" },
			modelRoles: { default: `${model.provider}/${model.id}` },
		}),
	);
	const options = {
		cwd,
		agentDir,
		authStorage: auth,
		model,
		storage: { directory: path.join(root, "sessions") },
		disableExtensionDiscovery: true,
		extensions: [],
		skills: [],
		rules: [],
		contextFiles: [],
		promptTemplates: [],
		slashCommands: [],
		enableMcpAutoload: false,
		enableLsp: false,
		skipPythonPreflight: true,
		deferOptionalModelRefresh: true,
		deferMemoryBackendStartup: true,
		notificationHostModeSupported: false,
		sdkHostModeSupported: false,
		toolNames: ["read"],
	};
	if (!native) {
		const result = await createEmbeddedAgentSession(options);
		cleanups.push(async () => {
			await result.session.dispose();
			auth.close();
			await fs.rm(root, { recursive: true, force: true });
		});
		return { result };
	}
	const opened = await createEmbeddedAgentSession({
		...options,
		native: { create: true, ownerPolicy: { kind: "exclusive_native" } },
	});
	if (opened.kind !== "opened") throw new Error(`Expected actual native factory, got ${opened.kind}`);
	cleanups.push(async () => {
		await disconnect(opened);
		auth.close();
		await fs.rm(root, { recursive: true, force: true });
	});
	return { result: opened.result, opened };
}

function bashResult(output = "owned output"): BashResult {
	return {
		output,
		exitCode: 0,
		cancelled: false,
		truncated: false,
		totalLines: 1,
		totalBytes: output.length,
		outputLines: 1,
		outputBytes: output.length,
	};
}

function sideResult(): { replyText: string; assistantMessage: AssistantMessage } {
	return {
		replyText: "owned side answer",
		assistantMessage: {
			role: "assistant",
			content: [{ type: "text", text: "owned side answer" }],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "claude-sonnet-4-5",
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: 1,
		},
	};
}

describe("actual native side/operator physical producer ownership", () => {
	it("retains the original detached executor after the public accepted projection settles", async () => {
		const { opened, result } = await fixture();
		if (!opened) throw new Error("Expected native fixture");
		const raw = Promise.withResolvers<BashResult>();
		const execute = spyOn(result.session, "executeBash").mockImplementation(() => {
			assertNativeRuntimeEffect(result.session, "operator");
			return raw.promise;
		});
		try {
			const accepted = await opened.runtime.operator.execute({ text: "!! retained executor" });
			expect(accepted.kind).toBe("applied");
			if (accepted.kind !== "applied") throw new Error("Expected accepted execution");
			expect(accepted.value.operation).toMatchObject({ status: "running", terminal: false });
			const preparation = await prepareEmbeddedDisconnect(opened.handle, opened.op);
			if (!preparation.inventory) throw new Error("Missing real inventory");
			const consent = consentEmbeddedDisconnect(opened.handle, preparation, {
				stopAndJoin: true,
				work: { inventory: preparation.inventory, targets: [] },
			});
			if (!consent) throw new Error("Missing exact consent");
			let terminal = false;
			const term = terminateEmbeddedAgentSession(opened.handle, { op: opened.op, consent });
			void term.then(() => {
				terminal = true;
			});
			try {
				await Bun.sleep(10);
				expect(terminal).toBe(false);
				expect(result.session.sessionManager.getStrictCloseState().kind).toBe("none_started");
				raw.resolve(bashResult());
				await term;
				expect(terminal).toBe(true);
				expect(result.session.sessionManager.getStrictCloseState().kind).toBe("closed");
			} finally {
				raw.resolve(bashResult());
				await term;
			}
		} finally {
			raw.resolve(bashResult());
			execute.mockRestore();
		}
	});

	for (const held of ["runner", "cleanup"] as const) {
		it(`retains the side ${held} future after its public snapshot has returned`, async () => {
			const { opened, result } = await fixture();
			if (!opened) throw new Error("Expected native fixture");
			const raw = Promise.withResolvers<{ replyText: string; assistantMessage: AssistantMessage }>();
			const cleanup = Promise.withResolvers<void>();
			const cleanupEntered = Promise.withResolvers<void>();
			const run = spyOn(result.session, "runEphemeralTurn").mockImplementation(() => {
				assertNativeRuntimeEffect(result.session, "side");
				return raw.promise;
			});
			const join = spyOn(result.session, "joinBtwTurnsForControl").mockImplementation(() => {
				cleanupEntered.resolve();
				return cleanup.promise;
			});
			try {
				const accepted = await opened.runtime.side.control("btw.open", { question: "retained side question" });
				expect(accepted.kind).toBe("applied");
				if (accepted.kind !== "applied" || !("turns" in accepted.value)) throw new Error("Missing side snapshot");
				expect(accepted.value.turns[0]).toMatchObject({ status: "running", cleanup: "pending" });
				if (held === "cleanup") {
					raw.resolve(sideResult());
					await cleanupEntered.promise;
				} else cleanup.resolve();
				let terminal = false;
				const term = disconnect(opened).then(() => {
					terminal = true;
				});
				try {
					await Bun.sleep(10);
					expect(terminal).toBe(false);
					expect(result.session.sessionManager.getStrictCloseState().kind).toBe("none_started");
				} finally {
					raw.resolve(sideResult());
					cleanup.resolve();
					await term;
				}
				expect(result.session.sessionManager.getStrictCloseState().kind).toBe("closed");
			} finally {
				raw.resolve(sideResult());
				cleanup.resolve();
				run.mockRestore();
				join.mockRestore();
			}
		});
	}

	for (const invalidate of ["selection", "generation"] as const) {
		it(`rechecks ${invalidate} after real held side credential preflight before attempt publication`, async () => {
			const { opened, result } = await fixture();
			if (!opened) throw new Error("Expected native fixture");
			const entered = Promise.withResolvers<void>();
			const credential = Promise.withResolvers<string>();
			const lookup = spyOn(result.session.modelRegistry, "getApiKey").mockImplementation(() => {
				entered.resolve();
				return credential.promise;
			});
			const mint = spyOn(result.session.agent, "mintSideAttemptScope");
			let restoreGeneration: (() => void) | undefined;
			try {
				const accepted = await opened.runtime.side.control("btw.open", { question: "withheld preflight" });
				expect(accepted.kind).toBe("applied");
				if (accepted.kind !== "applied") throw new Error("Expected accepted side preflight");
				await entered.promise;
				if (invalidate === "selection") {
					await recordEmbeddedResumeCheckpoint(opened.handle, { op: crypto.randomUUID() });
				} else {
					const manager = result.session.sessionManager;
					const generation = manager.getSessionIdentityGeneration();
					const changed = spyOn(manager, "getSessionIdentityGeneration").mockReturnValue(generation + 1);
					restoreGeneration = () => changed.mockRestore();
				}
				credential.resolve("test-only-key");
				await result.session.joinBtwTurnsForControl();
				expect(mint).not.toHaveBeenCalled();
			} finally {
				credential.resolve("test-only-key");
				await result.session.joinBtwTurnsForControl();
				restoreGeneration?.();
				lookup.mockRestore();
				mint.mockRestore();
			}
		});
	}

	it("reacquires a fresh short checkpoint after credential preflight before publishing a side attempt", async () => {
		const { opened, result } = await fixture();
		if (!opened) throw new Error("Expected native fixture");
		const entered = Promise.withResolvers<void>();
		const credential = Promise.withResolvers<string>();
		let checkpointObserved = false;
		const lookup = spyOn(result.session.modelRegistry, "getApiKey").mockImplementation(() => {
			entered.resolve();
			return credential.promise;
		});
		const mint = spyOn(result.session.agent, "mintSideAttemptScope").mockImplementation(() => {
			assertNativeRuntimeEffect(result.session, "side");
			checkpointObserved = true;
			throw new Error("stop before provider I/O");
		});
		try {
			const accepted = await opened.runtime.side.control("btw.open", { question: "fresh checkpoint" });
			if (accepted.kind !== "applied") throw new Error("Expected accepted side preflight");
			await entered.promise;
			expect(mint).not.toHaveBeenCalled();
			credential.resolve("test-only-key");
			await result.session.joinBtwTurnsForControl();
			expect(mint).toHaveBeenCalledTimes(1);
			expect(checkpointObserved).toBe(true);
		} finally {
			credential.resolve("test-only-key");
			await result.session.joinBtwTurnsForControl();
			lookup.mockRestore();
			mint.mockRestore();
		}
	});

	it("preserves parser and foreign-reference refusals without starting either producer", async () => {
		const { opened, result } = await fixture();
		if (!opened) throw new Error("Expected native fixture");
		const execute = spyOn(result.session, "executeBash");
		const run = spyOn(result.session, "runEphemeralTurn");
		const borrowed = new SideConversationControls(result.session);
		try {
			await expect(opened.runtime.operator.execute({ text: "not an operator command" })).rejects.toBeInstanceOf(
				SdkOperatorError,
			);
			await expect(opened.runtime.operator.cancel({ operationId: crypto.randomUUID() })).rejects.toBeInstanceOf(
				SdkOperatorError,
			);
			const empty = await opened.runtime.side.control("btw.open", {});
			if (empty.kind !== "applied" || !("id" in empty.value)) throw new Error("Missing side conversation");
			await expect(
				opened.runtime.side.control("btw.submit", { conversationId: crypto.randomUUID(), question: "foreign" }),
			).rejects.toMatchObject({ code: "resource_gone" });
			await expect(
				opened.runtime.side.control("btw.read", {
					conversationId: empty.value.id,
					cursor: `${crypto.randomUUID()}:0`,
				}),
			).rejects.toMatchObject({ code: "resource_gone" });
			expect(() => borrowed.control("btw.open", { question: "raw native bypass" })).toThrow(NativeRuntimeRefusal);
			expect(execute).not.toHaveBeenCalled();
			expect(run).not.toHaveBeenCalled();
		} finally {
			borrowed.dispose();
			execute.mockRestore();
			run.mockRestore();
		}
	});

	it("keeps non-native immediate acceptance and side cleanup semantics unchanged", async () => {
		const { result } = await fixture(false);
		const raw = Promise.withResolvers<{ replyText: string; assistantMessage: AssistantMessage }>();
		const run = spyOn(result.session, "runEphemeralTurn").mockReturnValue(raw.promise);
		const side = new SideConversationControls(result.session);
		const operator = new SdkOperatorControls(result.session);
		const executor = Promise.withResolvers<BashResult>();
		const execute = spyOn(result.session, "executeBash").mockReturnValue(executor.promise);
		try {
			const execution = operator.execute({ text: "!! ordinary operator" });
			expect(execution).toMatchObject({ admission: "accepted", operation: { terminal: false } });
			operator.cancel({ operationId: execution.operation.operationId });
			expect(operator.isBusy()).toBe(true);
			executor.resolve(bashResult());
			await executor.promise;
			expect(operator.read({ operationId: execution.operation.operationId }).operation.terminal).toBe(true);
			expect(operator.isBusy()).toBe(false);
			const accepted = side.control("btw.open", { question: "ordinary side" });
			if (!("turns" in accepted)) throw new Error("Missing ordinary side snapshot");
			expect(accepted.turns[0]).toMatchObject({ status: "running", cleanup: "pending" });
			raw.resolve(sideResult());
			await raw.promise;
			await result.session.joinBtwTurnsForControl();
			const settled = side.control("btw.read", { conversationId: accepted.id });
			if (!("turns" in settled)) throw new Error("Missing ordinary side snapshot");
			expect(settled.turns[0]).toMatchObject({
				status: "completed",
				cleanup: "settled",
				answer: "owned side answer",
			});
		} finally {
			raw.resolve(sideResult());
			executor.resolve(bashResult());
			side.dispose();
			operator.dispose();
			execute.mockRestore();
			run.mockRestore();
		}
	});
});
