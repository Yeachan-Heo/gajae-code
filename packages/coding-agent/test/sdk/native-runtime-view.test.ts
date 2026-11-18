import { afterEach, describe, expect, it, spyOn } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { getBundledModel } from "@gajae-code/ai";
import { createMockModel } from "@gajae-code/ai/providers/mock";
import { createEmbeddedAgentSession, type EmbeddedAgentSessionOptions } from "../../src/sdk/embedding";
import {
	consentEmbeddedDisconnect,
	currentEmbeddedResumeOperation,
	type NativeEmbeddedOpenResult,
	prepareEmbeddedDisconnect,
	reconcileEmbeddedResumeCheckpoint,
	resolveEmbeddedResumeCheckpoint,
	terminateEmbeddedAgentSession,
} from "../../src/sdk/native-embedding";
import { NativeRuntimeRefusal } from "../../src/sdk/native-lifecycle";
import { captureSessionView, restoreSessionView, type SdkSessionView } from "../../src/sdk/revision-controls";
import { AuthStorage } from "../../src/session/auth-storage";
import { nativeResumeBinding } from "../../src/session/native-resume";
import type { ReconcileResult } from "../../src/session/resume-operation";

type Opened = Extract<NativeEmbeddedOpenResult, { kind: "opened" }>;
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function disconnect(opened: Opened): Promise<ReconcileResult> {
	const op = currentEmbeddedResumeOperation(opened.handle);
	await reconcileEmbeddedResumeCheckpoint(opened.handle, { op, mode: "repairDurability" });
	const preparation = await prepareEmbeddedDisconnect(opened.handle, op);
	if (!preparation.inventory) throw new Error("Missing native work inventory");
	expect(preparation.inventory.blockers).toEqual([]);
	const consent = consentEmbeddedDisconnect(opened.handle, preparation, {
		stopAndJoin: true,
		work: { inventory: preparation.inventory, targets: [] },
	});
	if (!consent) throw new Error("Missing native termination consent");
	const terminated = await terminateEmbeddedAgentSession(opened.handle, { op, consent });
	expect(terminated.receipt.terminalDisposition.kind).toBe("retired");
	expect(opened.result.session.sessionManager.getStrictCloseState()).toEqual({ kind: "closed" });
	expect(opened.result.session.getDisposeResourceState()).toBe("settled");
	return terminated;
}

async function fixture() {
	const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "gjc-native-view-")));
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
	const options: Omit<EmbeddedAgentSessionOptions, "storage"> = {
		cwd,
		agentDir,
		authStorage: auth,
		model,
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
	const directory = path.join(root, "sessions");
	const opened = await createEmbeddedAgentSession({
		...options,
		storage: { directory },
		native: { create: true, ownerPolicy: { kind: "exclusive_native" } },
	});
	if (opened.kind !== "opened") throw new Error(`Expected native open, got ${opened.kind}`);
	const transport = createMockModel({ handler: { content: ["answer"] } });
	opened.result.session.agent.streamFn = transport.stream;
	const owners = [opened];
	cleanups.push(async () => {
		for (const owner of [...owners].reverse()) {
			if (owner.result.session.sessionManager.getStrictCloseState().kind === "none_started") await disconnect(owner);
		}
		auth.close();
		await fs.rm(root, { recursive: true, force: true });
	});
	const reopen = async (): Promise<Opened> => {
		const file = opened.result.session.sessionManager.getSessionFile();
		if (!file) throw new Error("Missing native transcript");
		const resolution = resolveEmbeddedResumeCheckpoint(file);
		if (resolution.kind !== "resolved") throw new Error(`Resume failed: ${resolution.reason}`);
		const expected = { snapshotDigest: resolution.checkpoint.snapshotDigest, resolved: resolution.checkpoint };
		const successor = await createEmbeddedAgentSession({
			...options,
			storage: { directory, file },
			native: { identity: resolution.identity, expected, ownerPolicy: { kind: "exclusive_native", expected } },
		});
		if (successor.kind !== "opened") throw new Error(`Expected successor open, got ${successor.kind}`);
		owners.push(successor);
		successor.result.session.agent.streamFn = transport.stream;
		return successor;
	};
	return { opened, reopen, transport };
}

async function observed(opened: Opened) {
	const session = opened.result.session;
	const manager = session.sessionManager;
	const file = manager.getSessionFile();
	if (!file) throw new Error("Missing native transcript");
	const op = currentEmbeddedResumeOperation(opened.handle);
	const state = nativeResumeBinding(op);
	return {
		view: captureSessionView(session),
		generation: session.sessionLifecycle.generation,
		identity: manager.getSessionIdentityGeneration(),
		revision: manager.revisionSnapshot(),
		entries: structuredClone(manager.getEntries()),
		messages: structuredClone(session.agent.state.messages),
		bytes: await Bun.file(file).text(),
		op,
		operation: structuredClone(op),
		proofs: structuredClone(state.proofs),
		successions: structuredClone(state.publicationSuccessions),
	};
}

async function settle(opened: Opened): Promise<void> {
	await opened.result.session.waitForIdle();
	await reconcileEmbeddedResumeCheckpoint(opened.handle, {
		op: currentEmbeddedResumeOperation(opened.handle),
		mode: "repairDurability",
	});
}

describe("native exact captured views", () => {
	it("restores non-tail ancestry and a captured null root without changing execution evidence", async () => {
		const { opened, transport } = await fixture();
		const session = opened.result.session;
		const manager = session.sessionManager;
		expect((await opened.runtime.prompt.prompt("first")).kind).toBe("applied");
		await settle(opened);
		const first = Object.freeze(captureSessionView(session));
		const firstAncestry = manager.getBranch().map(entry => entry.id);
		const firstMessages = structuredClone(session.buildDisplaySessionContext().messages);
		expect(firstMessages.map(message => message.role)).toEqual(["user", "assistant"]);
		expect((await opened.runtime.prompt.prompt("second")).kind).toBe("applied");
		await settle(opened);
		expect(manager.getLeafId()).not.toBe(first.leafEntryId);
		const before = await observed(opened);
		const membership = manager.getOwnerMembership();
		const providerSessionId = session.agent.providerSessionId;
		expect(before.proofs.length).toBeGreaterThan(0);

		expect(await opened.runtime.session.restoreSessionView(first)).toMatchObject({ kind: "applied", value: first });
		expect(captureSessionView(session)).toEqual(first);
		expect(manager.getBranch().map(entry => entry.id)).toEqual(firstAncestry);
		expect(session.agent.state.messages).toEqual(firstMessages);
		expect(session.sessionLifecycle.generation).toBe(before.generation + 1);

		const rootTarget: SdkSessionView = Object.freeze({ sessionId: first.sessionId, leafEntryId: null });
		expect(await opened.runtime.session.restoreSessionView(rootTarget)).toMatchObject({
			kind: "applied",
			value: rootTarget,
		});
		const rootView = Object.freeze(captureSessionView(session));
		expect(rootView).toEqual(rootTarget);
		expect(manager.getBranch()).toEqual([]);
		expect(session.agent.state.messages).toEqual([]);
		// Round-trip the actually captured root, not a guessed tail or execution cursor.
		expect((await opened.runtime.session.restoreSessionView(first)).kind).toBe("applied");
		expect((await opened.runtime.session.restoreSessionView(rootView)).kind).toBe("applied");
		expect(captureSessionView(session)).toEqual(rootView);
		const generation = session.sessionLifecycle.generation;
		expect((await opened.runtime.session.restoreSessionView(rootView)).kind).toBe("applied");
		expect(session.sessionLifecycle.generation).toBe(generation);

		const after = await observed(opened);
		expect(after.bytes).toBe(before.bytes);
		expect(after.entries).toEqual(before.entries);
		expect(after.op).toBe(before.op);
		expect(after.operation).toEqual(before.operation);
		expect(after.proofs).toEqual(before.proofs);
		expect(after.successions).toEqual(before.successions);
		expect(manager.getOwnerMembership()).toBe(membership);
		expect(session.agent.providerSessionId).toBe(providerSessionId);
		expect(transport.calls).toHaveLength(2);

		// A display target is not a durable execution selection. Return to the
		// captured execution view before asking the current owner to continue.
		expect((await opened.runtime.session.restoreSessionView(before.view)).kind).toBe("applied");
		expect((await opened.runtime.prompt.prompt("after presentation restore")).kind).toBe("applied");
		await settle(opened);
		expect(transport.calls).toHaveLength(3);
		expect(
			manager
				.getBranch()
				.filter(entry => entry.type === "message")
				.map(entry => entry.message.role),
		).toEqual(["user", "assistant", "user", "assistant", "user", "assistant"]);
		const current = currentEmbeddedResumeOperation(opened.handle);
		expect((await disconnect(opened)).receipt.op).toBe(current.op);
	});

	it("rejects foreign and missing targets and raw restoration with zero effects", async () => {
		const { opened, transport } = await fixture();
		const foreign = (await fixture()).opened;
		expect((await opened.runtime.prompt.prompt("local")).kind).toBe("applied");
		expect((await foreign.runtime.prompt.prompt("foreign")).kind).toBe("applied");
		await settle(opened);
		await settle(foreign);
		const session = opened.result.session;
		const foreignView = captureSessionView(foreign.result.session);
		const before = await observed(opened);
		const foreignBefore = await observed(foreign);
		// A facade from another source remains bound to that source, even with a local DTO.
		await expect(foreign.runtime.session.restoreSessionView(before.view)).rejects.toMatchObject({
			code: "resource_gone",
		});
		expect(await observed(foreign)).toEqual(foreignBefore);
		expect(await observed(opened)).toEqual(before);
		for (const view of [
			foreignView,
			{ sessionId: session.sessionId, leafEntryId: foreignView.leafEntryId },
			{ sessionId: session.sessionId, leafEntryId: "missing-view-entry" },
		]) {
			await expect(opened.runtime.session.restoreSessionView(view)).rejects.toMatchObject({ code: "resource_gone" });
			expect(await observed(opened)).toEqual(before);
		}
		const invalidView = { ...before.view, executionCursor: "not-presentation-metadata" };
		await expect(opened.runtime.session.restoreSessionView(invalidView)).rejects.toMatchObject({
			code: "invalid_input",
		});
		expect(await observed(opened)).toEqual(before);
		await expect(
			restoreSessionView(session, { sessionId: session.sessionId, leafEntryId: null }),
		).rejects.toMatchObject({
			// The public helper deliberately maps the raw ingress refusal to its revision error vocabulary.
			code: "revision_failed",
		});
		await expect(session.restoreTreeLeaf(null)).rejects.toBeInstanceOf(NativeRuntimeRefusal);
		expect(await observed(opened)).toEqual(before);
		expect(transport.calls).toHaveLength(1);
		expect((await opened.runtime.session.restoreSessionView(before.view)).kind).toBe("applied");
	});

	it("refuses a source identity generation mismatch before entering the restoration helper", async () => {
		const { opened, transport } = await fixture();
		expect((await opened.runtime.prompt.prompt("source")).kind).toBe("applied");
		await settle(opened);
		const manager = opened.result.session.sessionManager;
		const before = await observed(opened);
		const generation = spyOn(manager, "getSessionIdentityGeneration").mockReturnValue(before.identity + 1);
		try {
			expect(
				await opened.runtime.session.restoreSessionView({ sessionId: before.view.sessionId, leafEntryId: null }),
			).toMatchObject({ kind: "refused", reason: "context_mismatch" });
		} finally {
			generation.mockRestore();
		}
		expect(await observed(opened)).toEqual(before);
		expect(transport.calls).toHaveLength(1);
		expect((await opened.runtime.session.restoreSessionView(before.view)).kind).toBe("applied");
	});

	it("keeps a retired runtime fenced while the real successor restores and disconnects", async () => {
		const { opened, reopen, transport } = await fixture();
		expect((await opened.runtime.prompt.prompt("retained view")).kind).toBe("applied");
		await settle(opened);
		const saved = Object.freeze(captureSessionView(opened.result.session));
		await disconnect(opened);
		const successor = await reopen();
		const before = await observed(successor);
		expect(
			await opened.runtime.session.restoreSessionView({ sessionId: saved.sessionId, leafEntryId: null }),
		).toMatchObject({ kind: "refused", reason: "manager_closed" });
		expect(await observed(successor)).toEqual(before);
		expect((await successor.runtime.session.restoreSessionView(saved)).kind).toBe("applied");
		expect(captureSessionView(successor.result.session)).toEqual(saved);
		expect((await successor.runtime.prompt.prompt("current owner")).kind).toBe("applied");
		await settle(successor);
		expect(transport.calls).toHaveLength(2);
		const current = currentEmbeddedResumeOperation(successor.handle);
		expect(current).not.toBe(currentEmbeddedResumeOperation(opened.handle));
		expect((await disconnect(successor)).receipt.op).toBe(current.op);
	});
});
