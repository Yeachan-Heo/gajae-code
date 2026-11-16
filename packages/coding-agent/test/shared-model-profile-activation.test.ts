import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { Agent, ThinkingLevel } from "@gajae-code/agent-core";
import type { Effort } from "@gajae-code/ai/model-thinking";
import { activateModelProfile, ModelProfilePublicationError } from "../src/config/model-profile-activation";
import {
	ModelProfileApplyCommittedError,
	readDurableModelProfileOwnership,
} from "../src/config/model-profile-ownership";
import { ModelRegistry } from "../src/config/model-registry";
import { Settings } from "../src/config/settings";
import { AgentSession } from "../src/session/agent-session";
import { AuthStorage } from "../src/session/auth-storage";
import {
	SessionManager,
	type SharedEntriesAppendOutcome,
	SharedSessionMutationUnsupportedError,
} from "../src/session/session-manager";

const roots: string[] = [];
const sessions: AgentSession[] = [];
const managers: SessionManager[] = [];
const registries: ModelRegistry[] = [];
const settingsStores: Settings[] = [];
const authStores: AuthStorage[] = [];
const provider = "shared-profile-fixture";
const profileName = "shared-publication";
const initialSelector = `${provider}/initial`;
const selectedSelector = `${provider}/selected`;
const fallbackSelector = `${provider}/fallback`;
const defaultChain = [`${selectedSelector}:high`, `${fallbackSelector}:low`];
const user = (text: string) => ({ role: "user" as const, content: text, timestamp: 1 });

interface ProfileFixture {
	session: AgentSession;
	manager: SessionManager;
	registry: ModelRegistry;
	settings: Settings;
	file: string;
	cwd: string;
	agentDir: string;
}

afterEach(async () => {
	vi.restoreAllMocks();
	const failures: unknown[] = [];
	const cleanup: Array<() => unknown> = [
		...sessions.splice(0).map(session => () => session.dispose()),
		...registries.splice(0).map(registry => () => registry.dispose()),
		...managers.splice(0).map(manager => () => manager.closeStrict()),
		...settingsStores.splice(0).map(settings => () => settings.close()),
		...authStores.splice(0).map(auth => () => auth.close()),
		...roots.splice(0).map(root => () => fs.rm(root, { recursive: true, force: true })),
	];
	for (const dispose of cleanup) {
		try {
			await dispose();
		} catch (error) {
			failures.push(error);
		}
	}
	if (failures.length > 0) throw new AggregateError(failures, "Shared profile fixture cleanup failed");
});

async function fixture(): Promise<ProfileFixture> {
	const root = await fs.mkdtemp(path.join(import.meta.dirname, ".tmp-shared-profile-"));
	roots.push(root);
	const cwd = path.join(root, "workspace");
	const agentDir = path.join(root, "agent");
	await fs.mkdir(cwd, { recursive: true });
	await fs.mkdir(agentDir, { recursive: true, mode: 0o700 });
	await Bun.write(
		path.join(agentDir, "config.yml"),
		JSON.stringify({
			compaction: { enabled: false },
			todo: { reminders: false },
			startup: { networkPrewarm: false },
			defaultThinkingLevel: ThinkingLevel.Low,
			modelRoles: { default: initialSelector },
			task: { agentModelOverrides: { executor: initialSelector } },
		}),
	);
	await Bun.write(
		path.join(agentDir, "models.yml"),
		JSON.stringify({
			providers: {
				[provider]: {
					baseUrl: "https://shared-profile.invalid/v1",
					api: "openai-completions",
					apiKeyEnv: "GJC_TEST_SHARED_PROFILE_API_KEY",
					models: ["initial", "selected", "fallback"].map(id => ({
						id,
						reasoning: true,
						thinking: { mode: "effort", minLevel: "low", maxLevel: "high" },
						compat: { supportsReasoningEffort: true },
						input: ["text"],
						contextWindow: 32_000,
						maxTokens: 4_000,
					})),
				},
			},
			profiles: {
				[profileName]: {
					required_providers: [provider],
					model_mapping: { default: defaultChain, executor: fallbackSelector },
				},
			},
		}),
	);
	const settings = await Settings.loadForScope({ cwd, agentDir });
	settingsStores.push(settings);
	const auth = await AuthStorage.create(path.join(root, "auth.db"));
	authStores.push(auth);
	auth.setRuntimeApiKey(provider, "shared-profile-test-key");
	const registry = new ModelRegistry(auth, path.join(agentDir, "models.yml"), settings, {
		agentDir,
		automaticRefresh: false,
	});
	registries.push(registry);
	const model = registry.find(provider, "initial");
	if (!model) throw new Error(`Missing fixture model: ${initialSelector}`);
	const manager = SessionManager.create(cwd, SessionManager.managedDestination(cwd, agentDir));
	managers.push(manager);
	manager.appendMessage(user("initial user"));
	manager.appendModelChange(initialSelector, "default");
	manager.appendModelChange(initialSelector, "temporary");
	manager.appendThinkingLevelChange(ThinkingLevel.Low);
	await manager.ensureOnDisk();
	await manager.flush();
	const file = manager.getSessionFile();
	if (!file) throw new Error("Missing fixture transcript");
	const agent = new Agent({
		initialState: {
			model,
			thinkingLevel: ThinkingLevel.Low,
			systemPrompt: ["Shared profile fixture"],
			tools: [],
			messages: manager.buildSessionContext().messages,
		},
		streamFn: () => {
			throw new Error("Shared profile activation must not request a provider");
		},
	});
	const session = new AgentSession({
		agent,
		agentDir,
		sessionManager: manager,
		settings,
		modelRegistry: registry,
		thinkingLevel: ThinkingLevel.Low,
		rootInteractiveSharedAppend: true,
	});
	sessions.push(session);
	await manager.flush();
	return { session, manager, registry, settings, file, cwd, agentDir };
}

async function canonicalMessage(f: ProfileFixture): Promise<void> {
	f.session.agent.emitExternalEvent({ type: "message_end", message: user("canonical shared user") });
	await f.session.awaitSessionSettlement();
	expect(f.manager.getLeafEntry()).toMatchObject({
		type: "message",
		message: { role: "user", content: "canonical shared user" },
	});
	expect(await Bun.file(f.file).text()).toContain('"canonical shared user"');
}

async function title(f: ProfileFixture): Promise<void> {
	const leaf = f.manager.getLeafId();
	expect(await f.session.setSessionName("Shared profile title", "user")).toBe(true);
	expect(f.manager.getSessionName()).toBe("Shared profile title");
	expect(f.manager.getLeafId()).toBe(leaf);
}

async function activate(f: ProfileFixture, persistDefault = false): Promise<void> {
	await f.session.withSdkControlMutation(() =>
		activateModelProfile(
			{ session: f.session, settings: f.settings, modelRegistry: f.registry, profileName },
			{ persistDefault },
		),
	);
}

function expectProfileState(f: ProfileFixture, manager = f.manager, thinkingLevel: Effort = ThinkingLevel.High): void {
	expect(f.session.model).toMatchObject({ provider, id: "selected" });
	expect(f.session.thinkingLevel).toBe(thinkingLevel);
	expect(f.session.agent.state.thinkingLevel).toBe(thinkingLevel);
	expect(f.session.getActiveModelProfile()).toBe(profileName);
	expect(f.session.getActivatedModelProfile()).toBe(profileName);
	expect(f.session.getSessionDefaultModelSelector()).toBe(selectedSelector);
	expect(f.settings.get("task.agentModelOverrides").executor).toBe(fallbackSelector);
	const context = manager.buildSessionContext();
	expect(context.models).toMatchObject({ default: selectedSelector, temporary: selectedSelector });
	expect(context.thinkingLevel).toBe(thinkingLevel);
	expect(context.configuredModelChains.default).toMatchObject({
		role: "default",
		entries: defaultChain,
		origin: "profile-activation",
		identity: profileName,
		explicitHead: true,
	});
	expect(manager.getBranch().filter(entry => entry.type === "configured_model_chain")).toEqual([
		expect.objectContaining({
			role: "default",
			entries: defaultChain,
			origin: "profile-activation",
			identity: profileName,
			explicitHead: true,
		}),
	]);
}

function profileSnapshot(f: ProfileFixture) {
	return structuredClone({
		model: f.session.model,
		thinking: f.session.thinkingLevel,
		agentThinking: f.session.agent.state.thinkingLevel,
		modelRoles: f.settings.get("modelRoles"),
		agentRoles: f.settings.get("task.agentModelOverrides"),
		modelRolesOverride: f.settings.getOverride("modelRoles"),
		agentRolesOverride: f.settings.getOverride("task.agentModelOverrides"),
		chain: f.session.getConfiguredModelChainState("default"),
		fallback: f.session.getDefaultFallbackRuntimeState(),
		resumeDefault: f.session.getSessionDefaultModelSelector(),
		profile: f.session.getActiveModelProfile(),
		activatedProfile: f.session.getActivatedModelProfile(),
		leaf: f.manager.getLeafId(),
		entries: f.manager.getEntries(),
	});
}

async function activationFailure(f: ProfileFixture, persistDefault = false): Promise<Error> {
	try {
		await activate(f, persistDefault);
	} catch (error) {
		if (!(error instanceof Error)) throw error;
		return error;
	}
	throw new Error("Expected profile activation to fail");
}

async function reopen(f: ProfileFixture): Promise<SessionManager> {
	const manager = await SessionManager.open(f.file, SessionManager.managedDestination(f.cwd, f.agentDir));
	managers.push(manager);
	return manager;
}

describe("shared model profile activation", () => {
	it("publishes through the SDK profile control after canonical admission", async () => {
		const f = await fixture();
		await canonicalMessage(f);
		expect(await f.session.setDefaultModelProfileForControl(profileName)).toEqual({ changed: true, id: profileName });
		expectProfileState(f);
		const reopened = await reopen(f);
		expectProfileState(f, reopened);
	});

	it("fails closed after a committed SDK profile callback failure without restoring old transcript state", async () => {
		const f = await fixture();
		await canonicalMessage(f);
		const callbackFailure = new Error("post-publication callback failed");
		const chain = vi.spyOn(f.manager, "appendConfiguredModelChain");
		const model = vi.spyOn(f.manager, "appendModelChange");
		const publish = vi.spyOn(f.manager, "appendModelProfileActivationSharingSession");
		let failure: unknown;
		try {
			await f.session.setDefaultModelProfileForControl(profileName, {
				onAfterActivation: () => {
					throw callbackFailure;
				},
			});
		} catch (error) {
			failure = error;
		}
		expect(failure).toBeInstanceOf(ModelProfilePublicationError);
		if (!(failure instanceof ModelProfilePublicationError)) throw failure;
		expect(failure.outcome.kind).toBe("committed");
		if (failure.outcome.kind !== "committed") throw failure;
		expect(failure.publicationCause).toBe(callbackFailure);
		expect(f.session.sessionLifecycle.disposed).toBe(true);
		expect(publish).toHaveBeenCalledTimes(1);
		expect(chain).not.toHaveBeenCalled();
		expect(model).not.toHaveBeenCalled();
		const reopened = await reopen(f);
		const context = reopened.buildSessionContext();
		expect(context.models).toMatchObject({ default: selectedSelector, temporary: selectedSelector });
		expect(context.thinkingLevel).toBe(ThinkingLevel.High);
		expect(context.configuredModelChains.default).toMatchObject({ entries: defaultChain, identity: profileName });
		expect(failure.outcome.ids).toHaveLength(4);
		expect(reopened.getLeafId()).toBe(failure.outcome.ids.at(-1) ?? null);
	});

	for (const admission of [["message"], ["title"], ["message", "title"], ["title", "message"]] as const) {
		it(`publishes a profile after ${admission.join(" → ")}`, async () => {
			const f = await fixture();
			for (const operation of admission) {
				if (operation === "message") await canonicalMessage(f);
				else await title(f);
			}
			const before = await Bun.file(f.file).text();
			const parent = f.manager.getLeafId();
			await activate(f);
			await f.manager.flush();
			expectProfileState(f);
			expect((await Bun.file(f.file).text()).startsWith(before)).toBe(true);
			const publication = f.manager.getBranch().filter(entry => !before.includes(`"id":"${entry.id}"`));
			expect(publication[0]?.parentId).toBe(parent);
			expect(publication.filter(entry => entry.type === "model_change")).toEqual(
				expect.arrayContaining([
					expect.objectContaining({ role: "temporary", model: selectedSelector }),
					expect.objectContaining({ role: "default", model: selectedSelector }),
				]),
			);
			const reopened = await reopen(f);
			expectProfileState(f, reopened);
			expect(reopened.getLeafId()).toBe(f.manager.getLeafId());
			expect(reopened.getSessionName()).toBe(
				admission.some(operation => operation === "title") ? "Shared profile title" : undefined,
			);
			expect(readDurableModelProfileOwnership(f.settings).marker).toEqual({ kind: "inherit" });
			expect(f.settings.getGlobal("modelRoles")?.default).toBe(initialSelector);
			expect(f.settings.getGlobal("defaultThinkingLevel")).toBe(ThinkingLevel.Low);
		});
	}

	it("preserves an unseen sibling branch while publishing on the current local cursor", async () => {
		const f = await fixture();
		await canonicalMessage(f);
		const parent = f.manager.getLeafId();
		const branchLength = f.manager.getBranch().length;
		const sibling = await reopen(f);
		const peer = await sibling.appendMessageSharingSession(user("unseen sibling user"));
		expect(peer.kind).toBe("committed");
		if (peer.kind !== "committed") throw new Error(`Sibling append ${peer.kind}`);
		const peerEntry = sibling.getEntry(peer.id);
		expect(f.manager.getEntry(peer.id)).toBeUndefined();
		expect(f.manager.getLeafId()).toBe(parent);
		const before = await Bun.file(f.file).text();
		await activate(f);
		await f.manager.flush();
		expectProfileState(f);
		expect((await Bun.file(f.file).text()).startsWith(before)).toBe(true);
		const local = f.manager.getBranch();
		expect(local.map(entry => entry.id)).not.toContain(peer.id);
		expect(local[branchLength]?.parentId).toBe(parent);
		expect(sibling.getLeafId()).toBe(peer.id);
		const reopened = await reopen(f);
		expectProfileState(f, reopened);
		expect(reopened.getLeafId()).toBe(f.manager.getLeafId());
		expect(reopened.getEntry(peer.id)).toEqual(peerEntry);
		expect(reopened.getBranch(peer.id).map(entry => entry.id)).toEqual(sibling.getBranch().map(entry => entry.id));
		expect(reopened.getBranch().map(entry => entry.id)).not.toContain(peer.id);
		expect(reopened.buildSessionContext().messages).toEqual([user("initial user"), user("canonical shared user")]);
	});

	it("persists profile ownership and effective thinking alongside a reopenable shared model chain", async () => {
		const f = await fixture();
		await canonicalMessage(f);
		await title(f);
		const before = await Bun.file(f.file).text();
		await activate(f, true);
		await f.manager.flush();
		expectProfileState(f);
		expect((await Bun.file(f.file).text()).startsWith(before)).toBe(true);
		const persisted = await Settings.loadForScope({ cwd: f.cwd, agentDir: f.agentDir });
		settingsStores.push(persisted);
		expect(readDurableModelProfileOwnership(persisted)).toEqual({
			schemaVersion: 1,
			version: 1,
			marker: { kind: "profile", profile: profileName },
		});
		expect(persisted.getGlobal("modelProfile.default")).toBe(profileName);
		expect(persisted.getGlobal("defaultThinkingLevel")).toBe(ThinkingLevel.High);
		expect(persisted.getGlobal("modelRoles")).toEqual({});
		expect(persisted.getGlobal("task.agentModelOverrides")).toEqual({});
		const reopened = await reopen(f);
		expectProfileState(f, reopened);
		expect(reopened.getLeafId()).toBe(f.manager.getLeafId());
		expect(reopened.getSessionName()).toBe("Shared profile title");
	});

	for (const failure of ["rejected", "stale"] as const) {
		it(`retains session-only state after ${failure} publication without legacy compensation`, async () => {
			const f = await fixture();
			await canonicalMessage(f);
			const before = profileSnapshot(f);
			const bytes = await Bun.file(f.file).text();
			const original = new Error("credential=publication-rejection-must-not-leak");
			const outcome: SharedEntriesAppendOutcome =
				failure === "rejected"
					? { kind: "rejected", error: original }
					: { kind: "stale", reason: "cursor_not_committed" };
			const append = vi.spyOn(f.manager, "appendModelProfileActivationSharingSession").mockResolvedValue(outcome);
			const chain = vi.spyOn(f.manager, "appendConfiguredModelChain");
			const model = vi.spyOn(f.manager, "appendModelChange");
			const thinking = vi.spyOn(f.manager, "appendThinkingLevelChange");
			const compensate = vi.spyOn(f.session, "restoreModelSelectionForRollback");
			const error = await activationFailure(f);
			expect(error).toBeInstanceOf(ModelProfilePublicationError);
			expect(error).toMatchObject({ code: "model_profile_publication_failed", outcome });
			expect(error.cause).toBe(outcome);
			if (failure === "rejected") {
				expect(error.cause).toMatchObject({ error: original });
				expect(error.message).not.toContain(original.message);
			}
			expect(error.message).not.toContain("rollback incomplete");
			expect(append).toHaveBeenCalledTimes(1);
			expect(chain).not.toHaveBeenCalled();
			expect(model).not.toHaveBeenCalled();
			expect(thinking).not.toHaveBeenCalled();
			expect(compensate).not.toHaveBeenCalled();
			expect(profileSnapshot(f)).toEqual(before);
			expect(f.session.sessionLifecycle.disposed).toBe(false);
			expect(await Bun.file(f.file).text()).toBe(bytes);
		});
	}

	it("retains uncertain attempted IDs and synchronously fails closed without retrying publication", async () => {
		const f = await fixture();
		await canonicalMessage(f);
		const before = profileSnapshot(f);
		const bytes = await Bun.file(f.file).text();
		const original = new Error("credential=uncertain-publication-must-not-leak");
		const outcome: SharedEntriesAppendOutcome = {
			kind: "unknown",
			ids: ["profile-chain-attempt", "profile-model-attempt", "profile-thinking-attempt"],
			error: original,
		};
		const append = vi.spyOn(f.manager, "appendModelProfileActivationSharingSession").mockResolvedValue(outcome);
		const dispose = f.session.dispose.bind(f.session);
		let disposedSynchronously = false;
		const teardown = vi.spyOn(f.session, "dispose").mockImplementation(options => {
			const pending = dispose(options);
			disposedSynchronously = f.session.sessionLifecycle.disposed;
			return pending;
		});
		const chain = vi.spyOn(f.manager, "appendConfiguredModelChain");
		const model = vi.spyOn(f.manager, "appendModelChange");
		const error = await activationFailure(f);
		expect(error).toBeInstanceOf(ModelProfilePublicationError);
		if (!(error instanceof ModelProfilePublicationError)) throw error;
		expect(error.outcome).toBe(outcome);
		if (error.outcome.kind !== "unknown") throw new Error("Expected unknown profile publication receipt");
		expect(error.outcome.ids).toEqual(outcome.ids);
		expect(error.outcome.error).toBe(original);
		expect(error).toMatchObject({ code: "model_profile_publication_failed", outcome });
		expect(error.cause).toBe(outcome);
		expect(error.message).not.toContain(original.message);
		expect(error.message).not.toContain("rollback incomplete");
		expect(teardown).toHaveBeenCalledTimes(1);
		expect(disposedSynchronously).toBe(true);
		expect(f.session.sessionLifecycle.disposed).toBe(true);
		expect(append).toHaveBeenCalledTimes(1);
		expect(chain).not.toHaveBeenCalled();
		expect(model).not.toHaveBeenCalled();
		expect(profileSnapshot(f)).toEqual(before);
		expect(await Bun.file(f.file).text()).toBe(bytes);
	});

	it("retains committed durable ownership when shared publication is rejected after the settings CAS", async () => {
		const f = await fixture();
		await canonicalMessage(f);
		const previousChain = f.session.getConfiguredModelChainState("default");
		const bytes = await Bun.file(f.file).text();
		const original = new Error("credential=post-CAS-rejection-must-not-leak");
		const outcome: SharedEntriesAppendOutcome = { kind: "rejected", error: original };
		const owner = { schemaVersion: 1, version: 1, marker: { kind: "profile", profile: profileName } } as const;
		const append = vi.spyOn(f.manager, "appendModelProfileActivationSharingSession").mockImplementation(async () => {
			expect(readDurableModelProfileOwnership(f.settings)).toEqual(owner);
			expect(f.settings.getGlobal("modelRoles")).toEqual({});
			expect(f.settings.getGlobal("task.agentModelOverrides")).toEqual({});
			return outcome;
		});
		const commit = vi.spyOn(f.settings, "commitAtomicBatchWithCurrent");
		const chain = vi.spyOn(f.manager, "appendConfiguredModelChain");
		const model = vi.spyOn(f.manager, "appendModelChange");
		const error = await activationFailure(f, true);
		expect(error).toBeInstanceOf(ModelProfileApplyCommittedError);
		expect(error.cause).toBeInstanceOf(ModelProfilePublicationError);
		expect(error).toMatchObject({
			profileName,
			committedVersion: 1,
			cause: { code: "model_profile_publication_failed", outcome, cause: outcome },
		});
		expect(error.message).not.toContain(original.message);
		expect(f.session.sessionLifecycle.disposed).toBe(true);
		expect(append).toHaveBeenCalledTimes(1);
		expect(commit).toHaveBeenCalledTimes(1);
		expect(chain).not.toHaveBeenCalled();
		expect(model).not.toHaveBeenCalled();
		expect(f.session.model).toMatchObject({ provider, id: "initial" });
		expect(f.session.thinkingLevel).toBe(ThinkingLevel.Low);
		expect(f.session.getActiveModelProfile()).toBeUndefined();
		expect(f.session.getConfiguredModelChainState("default")).toEqual(previousChain);
		expect(await Bun.file(f.file).text()).toBe(bytes);
		const persisted = await Settings.loadForScope({ cwd: f.cwd, agentDir: f.agentDir });
		settingsStores.push(persisted);
		expect(readDurableModelProfileOwnership(persisted)).toEqual(owner);
		expect(persisted.getGlobal("modelProfile.default")).toBe(profileName);
		expect(persisted.getGlobal("defaultThinkingLevel")).toBe(ThinkingLevel.High);
		expect(persisted.getGlobal("modelRoles")).toEqual({});
		expect(persisted.getGlobal("task.agentModelOverrides")).toEqual({});
	});

	it("adopts a foreign transcript through a title before activation and a later effort change", async () => {
		const f = await fixture();
		const parent = f.manager.getLeafId();
		const sibling = await reopen(f);
		expect(await sibling.setSessionNameSharingSession("Foreign profile title", "user")).toEqual({
			kind: "committed",
			title: "Foreign profile title",
		});
		await title(f);
		const before = await Bun.file(f.file).text();
		expect(f.manager.getLeafId()).toBe(parent);
		await activate(f);
		expectProfileState(f);
		expect(f.manager.getSessionName()).toBe("Shared profile title");
		expect((await Bun.file(f.file).text()).startsWith(before)).toBe(true);
		const activated = await Bun.file(f.file).text();
		const activatedLeaf = f.manager.getLeafId();
		await f.session.setThinkingLevelForControl(ThinkingLevel.Medium, false);
		expect(f.session.thinkingLevel).toBe(ThinkingLevel.Medium);
		expect(f.session.agent.state.thinkingLevel).toBe(ThinkingLevel.Medium);
		expect(f.manager.getLeafEntry()).toMatchObject({
			type: "thinking_level_change",
			parentId: activatedLeaf,
			thinkingLevel: ThinkingLevel.Medium,
			operatorIntent: true,
		});
		expect((await Bun.file(f.file).text()).startsWith(activated)).toBe(true);
		const settled = await Bun.file(f.file).text();
		expect(() => f.manager.appendMessage(user("legacy rewrite must stay forbidden"))).toThrow(
			SharedSessionMutationUnsupportedError,
		);
		expect(await Bun.file(f.file).text()).toBe(settled);
		const reopened = await reopen(f);
		expect(reopened.getSessionName()).toBe("Shared profile title");
		expect(reopened.getLeafId()).toBe(f.manager.getLeafId());
		expectProfileState(f, reopened, ThinkingLevel.Medium);
	});
});
