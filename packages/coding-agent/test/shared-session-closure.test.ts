/**
 * Every shared publication kind closes the session on an unknown outcome (#7824 follow-up):
 * a post-write or lease-release failure leaves the entry possibly durable, so the next
 * prompt or control must refuse with the exact receipt and reopen guidance rather than
 * run against a diverged history or report `busy`.
 */
import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { Agent, ThinkingLevel } from "@gajae-code/agent-core";
import { getBundledModel } from "@gajae-code/ai/models";
import { ModelRegistry } from "../src/config/model-registry";
import { Settings } from "../src/config/settings";
import { loadExtensions } from "../src/extensibility/extensions/loader";
import { ExtensionRunner } from "../src/extensibility/extensions/runner";
import { AgentSession } from "../src/session/agent-session";
import { AuthStorage } from "../src/session/auth-storage";
import { ManagedLockTestHooks, ManagedSessionDescendantStore } from "../src/session/internal/managed-session-storage";
import { SessionManager, SharedSessionMutationUnsupportedError } from "../src/session/session-manager";

const roots: string[] = [];
const sessions: AgentSession[] = [];
const managers: SessionManager[] = [];
const registries: ModelRegistry[] = [];
const stores: AuthStorage[] = [];
const user = (content: string) => ({ role: "user" as const, content, timestamp: 1 });
// Matched structurally so a reverted source fails each case instead of the whole file.
const closed = { name: "SharedSessionClosedError", code: "shared_session_closed" };

afterEach(async () => {
	vi.restoreAllMocks();
	ManagedLockTestHooks.afterReleaseDurable = undefined;
	for (const session of sessions.splice(0)) await session.dispose().catch(() => undefined);
	for (const registry of registries.splice(0)) await registry.dispose();
	for (const manager of managers.splice(0)) await manager.closeStrict().catch(() => undefined);
	for (const store of stores.splice(0)) store.close();
	for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});

async function fixture(options: { branchHook?: boolean } = {}) {
	const root = await fs.mkdtemp(path.join(import.meta.dirname, ".tmp-shared-session-closure-"));
	roots.push(root);
	const cwd = path.join(root, "workspace");
	const agentDir = path.join(root, "agent");
	await fs.mkdir(cwd, { recursive: true });
	await fs.mkdir(agentDir, { recursive: true, mode: 0o700 });
	const manager = SessionManager.create(cwd, SessionManager.managedDestination(cwd, agentDir));
	managers.push(manager);
	const auth = await AuthStorage.create(path.join(root, "auth.db"));
	stores.push(auth);
	auth.setRuntimeApiKey("anthropic", "test-key");
	const registry = new ModelRegistry(auth);
	registries.push(registry);
	const model = getBundledModel("anthropic", "claude-sonnet-4-5");
	if (!model) throw new Error("Missing bundled model");
	let extensionRunner: ExtensionRunner | undefined;
	if (options.branchHook) {
		const extensionPath = path.join(root, "branch-hook.ts");
		await Bun.write(
			extensionPath,
			'export default function(pi) { pi.on("session_before_branch", async () => ({})); }\n',
		);
		const loaded = await loadExtensions([extensionPath], cwd);
		extensionRunner = new ExtensionRunner(loaded.extensions, loaded.runtime, cwd, manager, registry);
	}
	const agent = new Agent({ initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] } });
	const session = new AgentSession({
		agent,
		sessionManager: manager,
		settings: Settings.isolated({ "compaction.enabled": false, "todo.reminders": false }),
		modelRegistry: registry,
		extensionRunner,
		rootInteractiveSharedAppend: true,
		thinkingLevel: ThinkingLevel.Off,
	});
	sessions.push(session);
	// Never reach a provider: a prompt that is not refused fails with this sentinel.
	vi.spyOn(session.agent, "prompt").mockRejectedValue(new Error("model must not be called"));
	session.agent.emitExternalEvent({ type: "message_end", message: user("root") });
	await session.awaitSessionSettlement();
	await manager.flush();
	const file = manager.getSessionFile();
	if (!file) throw new Error("Missing transcript");
	return { session, manager, file, extensionRunner };
}

type Boundary = "post-write" | "release";

/** Fail the next shared publication after its bytes are written. */
function failNextPublication(boundary: Boundary): Error {
	const injected = new Error(`injected ${boundary} failure`);
	if (boundary === "post-write") {
		const original = ManagedSessionDescendantStore.prototype.appendExpectedIdentitySync;
		let failed = false;
		vi.spyOn(ManagedSessionDescendantStore.prototype, "appendExpectedIdentitySync").mockImplementation(function (
			this: ManagedSessionDescendantStore,
			...args: Parameters<typeof original>
		) {
			const receipt = original.apply(this, args);
			if (failed) return receipt;
			failed = true;
			throw injected;
		});
		return injected;
	}
	ManagedLockTestHooks.afterReleaseDurable = () => {
		ManagedLockTestHooks.afterReleaseDurable = undefined;
		throw injected;
	};
	return injected;
}

async function transcriptIds(file: string): Promise<string[]> {
	return (await Bun.file(file).text())
		.split("\n")
		.filter(line => line.trim().length > 0)
		.map(line => (JSON.parse(line) as { id?: string }).id ?? "");
}

/** The next prompt and the next control both report the closure, never `busy`. */
async function expectClosed(session: AgentSession, receipt: unknown) {
	const prompt = session.prompt("after the uncertain publication");
	await expect(prompt).rejects.toMatchObject({ ...closed, receipt });
	const error = (await prompt.catch((caught: unknown) => caught)) as Error;
	expect(error.message).toContain(`gjc --resume ${session.sessionId}`);
	expect(error.message).not.toMatch(/busy/i);
	await expect(session.setServiceTier("priority")).rejects.toMatchObject(closed);
	expect(session.agent.prompt).not.toHaveBeenCalled();
}

describe("shared publication uncertainty closes the session", () => {
	for (const boundary of ["post-write", "release"] as const) {
		it(`closes after an unknown canonical message append (${boundary})`, async () => {
			const f = await fixture();
			failNextPublication(boundary);
			f.session.agent.emitExternalEvent({ type: "message_end", message: user("uncertain canonical") });
			await f.session.awaitSessionSettlement().catch(() => undefined);
			const attempted = f.manager.getUnknownSharedPublication();
			expect(attempted).toMatchObject({ publication: "entries", outcome: { kind: "unknown" } });
			if (attempted?.publication !== "entries") throw new Error("Missing receipt");
			const ids = attempted.outcome.ids;
			expect(ids).toHaveLength(1);
			expect((await transcriptIds(f.file)).filter(id => id === ids[0])).toHaveLength(1);
			await expectClosed(f.session, { publication: "entries", outcome: { kind: "unknown", ids } });
		});

		it(`closes after an unknown custom message append (${boundary})`, async () => {
			const f = await fixture();
			failNextPublication(boundary);
			await expect(
				f.session.sendCustomMessage({ customType: "closure-probe", content: "custom", display: true }),
			).rejects.toMatchObject(closed);
			const receipt = f.manager.getUnknownSharedPublication();
			expect(receipt).toMatchObject({ publication: "entries", outcome: { kind: "unknown" } });
			await expectClosed(f.session, receipt);
		});

		it(`closes after an unknown control publication (${boundary})`, async () => {
			const f = await fixture();
			failNextPublication(boundary);
			await expect(f.session.setServiceTier("flex")).rejects.toThrow();
			const receipt = f.manager.getUnknownSharedPublication();
			expect(receipt).toMatchObject({ publication: "entries", outcome: { kind: "unknown" } });
			await expectClosed(f.session, receipt);
		});

		it(`closes after an unknown title publication (${boundary})`, async () => {
			const f = await fixture();
			failNextPublication(boundary);
			await expect(f.session.setSessionName("Uncertain title", "user")).rejects.toMatchObject(closed);
			const receipt = f.manager.getUnknownSharedPublication();
			expect(receipt).toMatchObject({
				publication: "title",
				outcome: { kind: "unknown", patch: { title: "Uncertain title", titleSource: "user" } },
			});
			await expectClosed(f.session, receipt);
		});

		it(`closes at the next ingress after an unknown star publication (${boundary})`, async () => {
			const f = await fixture();
			failNextPublication(boundary);
			await expect(f.manager.setSessionStarred(true)).rejects.toMatchObject({ code: "unknown" });
			const receipt = f.manager.getUnknownSharedPublication();
			expect(receipt).toMatchObject({ publication: "star", outcome: { kind: "unknown", starred: true } });
			await expectClosed(f.session, receipt);
		});

		it(`closes after an unknown background mode publication (${boundary})`, async () => {
			const f = await fixture();
			failNextPublication(boundary);
			// The session closes on the latched receipt; the result still reports what the
			// transcript proves, since the entry was written before the failure.
			expect(await f.session.appendModeChangeInBackground("plan")).toEqual({ committed: true });
			const receipt = f.manager.getUnknownSharedPublication();
			expect(receipt).toMatchObject({ publication: "entries", outcome: { kind: "unknown" } });
			await expectClosed(f.session, receipt);
		});
	}
});

describe("shared branch refusal", () => {
	it("refuses a path-only branch before the hook, teardown, or flush runs", async () => {
		const f = await fixture({ branchHook: true });
		f.session.agent.emitExternalEvent({ type: "message_end", message: user("branch target") });
		await f.session.awaitSessionSettlement();
		const target = f.manager.getLeafId();
		if (!target || !f.extensionRunner) throw new Error("Missing branch fixture");
		const emit = vi.spyOn(f.extensionRunner, "emit");
		const flush = vi.spyOn(f.manager, "flush");
		const steering = vi.spyOn(f.session.agent, "snapshotSteering");
		await expect(f.session.branch(target)).rejects.toBeInstanceOf(SharedSessionMutationUnsupportedError);
		expect(emit.mock.calls.filter(([event]) => event.type === "session_before_branch")).toHaveLength(0);
		expect(steering).not.toHaveBeenCalled();
		expect(flush).not.toHaveBeenCalled();
		// The session stayed connected: a later canonical message still publishes.
		f.session.agent.emitExternalEvent({ type: "message_end", message: user("after refused branch") });
		await f.session.awaitSessionSettlement();
		await f.manager.flush();
		expect(await Bun.file(f.file).text()).toContain("after refused branch");
	});
});
