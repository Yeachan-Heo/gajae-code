import { afterEach, describe, expect, it, spyOn } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { getBundledModel } from "@gajae-code/ai";
import { createMockModel } from "@gajae-code/ai/providers/mock";
import { createEmbeddedAgentSession } from "../../src/sdk/embedding";
import { consentEmbeddedDisconnect, currentEmbeddedResumeOperation, prepareEmbeddedDisconnect, reconcileEmbeddedResumeCheckpoint, terminateEmbeddedAgentSession } from "../../src/sdk/native-embedding";
import { adoptNativeRuntimeCommit, invokeNativeRuntime } from "../../src/sdk/native-lifecycle";
import { AuthStorage } from "../../src/session/auth-storage";
import { getOwnerMembershipEvidence } from "../../src/session/owner-group";
import { consumeCommittedSessionEvidence, type CommittedSessionEvidence } from "../../src/session/session-manager";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function fixture(managed: boolean) {
	const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "gjc-native-successor-")));
	const cwd = path.join(root, "project");
	const agentDir = path.join(root, "agent");
	await fs.mkdir(cwd);
	const auth = await AuthStorage.create(path.join(agentDir, "auth.db"));
	const model = getBundledModel("anthropic", "claude-sonnet-4-5")!;
	auth.setRuntimeApiKey(model.provider, "test-only-key");
	await Bun.write(path.join(agentDir, "config.yml"), JSON.stringify({
		recipe: { enabled: false }, compaction: { enabled: false }, retry: { enabled: false },
		tools: { discoveryMode: "off" }, modelRoles: { default: `${model.provider}/${model.id}` },
	}));
	const opened = await createEmbeddedAgentSession({
		cwd, agentDir, authStorage: auth, model,
		storage: managed ? { managed: true } : { directory: path.join(root, "sessions") },
		native: { create: true, ownerPolicy: { kind: "exclusive_native" } },
		disableExtensionDiscovery: true, extensions: [], skills: [], rules: [], contextFiles: [],
		promptTemplates: [], slashCommands: [], enableMcpAutoload: false, enableLsp: false,
		skipPythonPreflight: true, deferOptionalModelRefresh: true, deferMemoryBackendStartup: true,
		notificationHostModeSupported: false, sdkHostModeSupported: false, toolNames: ["read"],
	});
	if (opened.kind !== "opened") throw new Error(`Expected open, got ${opened.kind}`);
	opened.result.session.agent.streamFn = createMockModel({ handler: { content: ["answer"] } }).stream;
	cleanups.push(async () => {
		const op = currentEmbeddedResumeOperation(opened.handle);
		await reconcileEmbeddedResumeCheckpoint(opened.handle, { op, mode: "repairDurability" });
		const preparation = await prepareEmbeddedDisconnect(opened.handle, op);
		if (!preparation.inventory) throw new Error("Missing inventory");
		expect(preparation.inventory.blockers).toEqual([]);
		const consent = consentEmbeddedDisconnect(opened.handle, preparation, {
			stopAndJoin: true, work: { inventory: preparation.inventory,
				targets: preparation.inventory.blockers.flatMap(blocker => blocker.target ? [blocker.target] : []) },
		});
		if (!consent) throw new Error("Missing consent");
		const terminated = await terminateEmbeddedAgentSession(opened.handle, { op, consent });
		expect(terminated.receipt.routing).toMatchObject({ action: "POST_READONLY" });
		expect(terminated.receipt.terminalDisposition.kind).toBe("retired");
		auth.close();
		await fs.rm(root, { recursive: true, force: true });
	});
	return opened;
}

for (const managed of [true, false]) {
	describe(`native committed successors (${managed ? "managed" : "explicit"})`, () => {
		it("branches with an issuer-bound, immutable, one-shot receipt and admits the next turn", async () => {
			const opened = await fixture(managed);
			const session = opened.result.session;
			const manager = session.sessionManager;
			expect((await opened.runtime.prompt.prompt("first")).kind).toBe("applied");
			await session.waitForIdle();
			expect((await opened.runtime.prompt.prompt("second")).kind).toBe("applied");
			await session.waitForIdle();
			const user = manager.getBranch().find(entry => entry.type === "message" && entry.message.role === "user")!;
			const previousOp = currentEmbeddedResumeOperation(opened.handle);
			const previousMembership = manager.getOwnerMembership();
			let receipt: CommittedSessionEvidence | undefined;
			const commit = manager.commitPreparedNewSession.bind(manager);
			const spy = spyOn(manager, "commitPreparedNewSession").mockImplementation(prepared => {
				receipt = commit(prepared);
				expect(() => adoptNativeRuntimeCommit(session, { ...receipt! })).toThrow("context_mismatch");
				expect(Reflect.set(receipt, "targetLeafId", "forged-target")).toBe(false);
				expect(Reflect.set(receipt.successor, "generation", receipt.predecessor.generation)).toBe(false);
				return receipt;
			});
			try {
				expect((await opened.runtime.session.branch(user.id)).kind).toBe("applied");
			} finally { spy.mockRestore(); }
			if (!receipt || !receipt.membership || !receipt.pending || !receipt.publication) throw new Error("Missing evidence");
			expect(receipt.manager).toBe(manager);
			expect(receipt.targetLeafId).toBe(user.parentId);
			expect(receipt.pending.plan.target).toBe(user.parentId);
			expect(receipt.successor.sessionId).toBe(session.sessionId);
			expect(receipt.successor.generation).toBe(receipt.predecessor.generation + 1);
			expect(Object.isFrozen(receipt)).toBe(true);
			expect(Object.isFrozen(receipt.successor)).toBe(true);
			expect(Object.isFrozen(receipt.publication)).toBe(true);
			expect(receipt.membership).not.toBe(previousMembership);
			expect(getOwnerMembershipEvidence(receipt.membership).policy.kind).toBe("exclusive_native");
			expect(currentEmbeddedResumeOperation(opened.handle)).toBe(receipt.pending);
			expect(currentEmbeddedResumeOperation(opened.handle)).not.toBe(previousOp);
			expect(consumeCommittedSessionEvidence(manager, receipt)).toBe(false);
			expect(consumeCommittedSessionEvidence(manager, { ...receipt })).toBe(false);
			expect(() => adoptNativeRuntimeCommit(session, receipt!)).toThrow("context_mismatch");
			expect(await opened.runtime.prompt.prompt("successor")).toMatchObject({ kind: "applied" });
			await session.waitForIdle();
		});

		it("advances the immutable operation and binding after an authenticated move", async () => {
			const opened = await fixture(managed);
			const session = opened.result.session;
			const manager = session.sessionManager;
			expect((await opened.runtime.prompt.prompt("before move")).kind).toBe("applied");
			await session.waitForIdle();
			const previous = currentEmbeddedResumeOperation(opened.handle);
			const nextCwd = path.join(path.dirname(manager.getCwd()), "moved-project");
			await fs.mkdir(nextCwd);
			expect(await invokeNativeRuntime(opened.handle, "session", () => manager.moveTo(nextCwd))).toMatchObject({ kind: "applied" });
			const current = currentEmbeddedResumeOperation(opened.handle);
			expect(current).not.toBe(previous);
			const owner = manager.getSessionOwnerEvidence();
			if (!owner) throw new Error("Missing moved owner");
			expect(current.authorityKey).toBe(owner.authorityKey);
			expect(current.policy.rev).toBe(owner.rev);
			expect((await opened.runtime.prompt.prompt("after move")).kind).toBe("applied");
			await session.waitForIdle();
		});

		it("forks the selected branch and retires the successor membership on authorized TERM", async () => {
			const opened = await fixture(managed);
			const session = opened.result.session;
			expect((await opened.runtime.prompt.prompt("first")).kind).toBe("applied");
			await session.waitForIdle();
			const oldId = session.sessionId;
			const target = session.sessionManager.getLeafId();
			const forked = await invokeNativeRuntime(opened.handle, "session", () => session.fork());
			expect(forked.kind).toBe("applied");
			expect(forked.kind === "applied" && forked.value).toBe(true);
			expect(session.sessionId).not.toBe(oldId);
			expect(currentEmbeddedResumeOperation(opened.handle).plan.target).toBe(target);
			expect(await opened.runtime.prompt.prompt("forked")).toMatchObject({ kind: "applied" });
			await session.waitForIdle();
		});
	});
}
