import * as path from "node:path";
import { postmortem } from "@gajae-code/utils";
import { releaseSettingsScope } from "../capability";
import { isSessionCredentialPinBlocking } from "../config/model-profile-activation";
import { createRegistrySelectorIndex, ModelRegistry, registrySelectorResolvesToModel } from "../config/model-registry";
import { normalizeModelSelectorValue } from "../config/model-selector-value";
import { Settings } from "../config/settings";
import { validateSettingPatch } from "../config/settings-schema";
import { loadSlashCommands } from "../extensibility/slash-commands";
import { usePostmortemSignalExitAuthority } from "../lsp/client";
import { type InitializeExtensionsOptions, initializeExtensions } from "../modes/runtime-init";
import { AgentRegistry } from "../registry/agent-registry";
import { SessionManager } from "../session/session-manager";
import { FileSessionStorage } from "../session/session-storage";
import { createSdkPreferenceControls } from "./preference-controls";
import { type CreateAgentSessionOptions, type CreateAgentSessionResult, createAgentSession } from "./session";

/** Credential-aware local catalog, including session-pin failures. */
export function getEmbeddedAvailableModels(session: CreateAgentSessionResult["session"]) {
	return session
		.getAvailableModels()
		.filter(
			model => !isSessionCredentialPinBlocking(session.modelRegistry, model.provider, session.credentialSessionId),
		);
}

export interface EmbeddedAgentSessionOptions
	extends Omit<CreateAgentSessionOptions, "sessionManager" | "settings" | "modelRegistry" | "agentRegistry"> {
	cwd: string;
	agentDir: string;
	storage:
		| { directory: string; file?: string; manager?: CreateAgentSessionResult["session"]["sessionManager"] }
		| { persist: false };
	/** Trusted factory injection for embedding integration tests. */
	createSession?: (options: CreateAgentSessionOptions) => Promise<CreateAgentSessionResult>;
	/** Control-only sessions own no transcript, extensions, MCP connections or project discovery. */
	controlOnly?: boolean;
}

export interface EmbeddedAgentSessionResult extends CreateAgentSessionResult {
	/** Initialize once per extension runner; later contexts only rebind the UI. May await an interactive session_start. */
	initializeUI(options: InitializeExtensionsOptions): Promise<void>;
	/** Refresh file-command discovery through the SDK without publishing a retired identity. */
	refreshCommands(): Promise<void>;
	/** Refresh this factory owner's credential-scoped catalog; control-only owners use the global enrollment view. */
	refreshModels(strategy: "online" | "offline"): Promise<void>;
	/** Join actual session teardown before releasing the factory's scoped dependencies. Retryable after failure. */
	releaseResources(): Promise<void>;
	modelProfileWarning?: string;
}

/** Public validation without exposing mutable schema definitions or granting write authority. */
export function validateEmbeddedConfigPatch(patch: Record<string, unknown>): Array<{ path: string; detail: string }> {
	return validateSettingPatch(patch);
}

/** A local embedding owns its transcript directory; this does not admit a managed/shared-session writer. */
export async function createEmbeddedAgentSession(
	options: EmbeddedAgentSessionOptions,
): Promise<EmbeddedAgentSessionResult> {
	const { storage, createSession = createAgentSession, controlOnly = false, ...sessionOptions } = options;
	const manager =
		"persist" in storage
			? SessionManager.inMemory(options.cwd)
			: (storage.manager ??
				(storage.file
					? await SessionManager.open(storage.file, storage.directory)
					: SessionManager.create(options.cwd, storage.directory)));
	let settings: Settings;
	try {
		if (path.resolve(manager.getCwd()) !== path.resolve(options.cwd))
			throw new Error("Session project does not match catalog");
		settings = await Settings.loadForScope({ cwd: options.cwd, agentDir: options.agentDir });
	} catch (error) {
		try {
			await manager.close();
		} catch (cleanupError) {
			throw new AggregateError([error, cleanupError], "Embedding preflight and writer release failed");
		}
		throw error;
	}
	const closeSettings = async (): Promise<void> => {
		try {
			await settings.close();
		} finally {
			releaseSettingsScope(settings);
		}
	};
	let registry: ModelRegistry | undefined;
	let result: CreateAgentSessionResult | undefined;
	try {
		const authStorage = options.authStorage;
		// Leave auth construction to the SDK factory when this is the root control owner.
		if (authStorage) {
			registry = new ModelRegistry(authStorage, path.join(options.agentDir, "models.yml"), settings, {
				agentDir: options.agentDir,
			});
			await registry.refresh("offline");
			const profile = registry.getModelProfiles().get(settings.get("modelProfile.default") ?? "");
			const selectors = [
				...Object.values(profile?.modelMapping ?? {}),
				...Object.values(settings.get("modelRoles") ?? {}),
				...Object.values(settings.get("task.agentModelOverrides") ?? {}),
			].flatMap(normalizeModelSelectorValue);
			const index = createRegistrySelectorIndex(registry.getAll());
			if (selectors.some(selector => selector.includes("/") && !registrySelectorResolvesToModel(selector, index))) {
				try {
					await registry.refresh("online");
				} catch {
					/* Construction reports unresolved selectors. */
				}
			}
		}
		result = await createSession({
			...sessionOptions,
			...(controlOnly
				? {
						extensions: [],
						disableExtensionDiscovery: true,
						skills: [],
						rules: [],
						contextFiles: [],
						promptTemplates: [],
						slashCommands: [],
						enableMcpAutoload: false,
						deferModelProfileActivation: true,
						deferOptionalModelRefresh: true,
						enableLsp: false,
						skipPythonPreflight: true,
						toolNames: [],
						notificationHostModeSupported: false,
						sdkHostModeSupported: false,
					}
				: {}),
			settings,
			...(registry ? { modelRegistry: registry } : {}),
			agentRegistry: new AgentRegistry(),
			sessionManager: manager,
		});
		const created = result;
		// The native factory establishes the scoped discovery context before capability reads.
		if (!controlOnly && sessionOptions.slashCommands === undefined)
			created.session.setSlashCommands(await loadSlashCommands({ cwd: options.cwd }));
		let modelProfileWarning: string | undefined;
		const defaultProfile = settings.get("modelProfile.default");
		if (!controlOnly && defaultProfile) {
			const controls = createSdkPreferenceControls(created.session);
			try {
				const outcome = await controls.selectProfile({ name: defaultProfile, scope: "session" });
				if (!outcome.applied)
					modelProfileWarning = `Could not apply the default model profile (${defaultProfile}). Choose a model in settings.`;
			} catch (error) {
				modelProfileWarning = `Could not apply the default model profile (${defaultProfile}): ${String(error).slice(0, 300)}`;
			} finally {
				controls.dispose();
			}
		}
		let initializedRunner: CreateAgentSessionResult["session"]["extensionRunner"];
		let initialization: Promise<void> | undefined;
		let releasing: Promise<void> | undefined;
		// Extend the actual result so lazy factory resource getters retain their exact ownership.
		return Object.assign(created, {
			...(modelProfileWarning ? { modelProfileWarning } : {}),
			initializeUI(uiOptions: InitializeExtensionsOptions): Promise<void> {
				const lifecycle = created.session.sessionLifecycle;
				if (lifecycle.disposed || lifecycle.transitioning)
					throw new Error("Session changed before extension initialization");
				if (uiOptions.uiContext) created.setToolUIContext(uiOptions.uiContext, true);
				const runner = created.session.extensionRunner;
				const generation = lifecycle.generation;
				if (initialization && initializedRunner === runner) {
					if (uiOptions.uiContext) runner?.setUIContext(uiOptions.uiContext);
					return initialization;
				}
				initializedRunner = runner;
				initialization = Promise.resolve().then(() => {
					const current = created.session.sessionLifecycle;
					if (
						current.disposed ||
						current.transitioning ||
						current.generation !== generation ||
						created.session.extensionRunner !== runner
					)
						throw new Error("Session changed before extension initialization");
					return initializeExtensions(created.session, uiOptions);
				});
				return initialization;
			},
			async refreshCommands(): Promise<void> {
				if (controlOnly) throw new Error("Command discovery is unavailable for control-only sessions");
				const session = created.session;
				const before = session.sessionLifecycle;
				if (before.disposed || before.transitioning) throw new Error("Session changed before refreshing commands");
				const generation = before.generation;
				const sessionId = session.sessionId;
				const cwd = manager.getCwd();
				const commands = await loadSlashCommands({ cwd });
				const lifecycle = session.sessionLifecycle;
				if (
					lifecycle.disposed ||
					lifecycle.transitioning ||
					lifecycle.generation !== generation ||
					session.sessionManager !== manager ||
					session.sessionId !== sessionId ||
					manager.getCwd() !== cwd
				)
					throw new Error("Session changed while refreshing commands");
				session.setSlashCommands(commands);
			},
			async refreshModels(strategy: "online" | "offline"): Promise<void> {
				const session = created.session;
				const generation = session.sessionLifecycle.generation;
				const sessionId = session.sessionId;
				const ownerRegistry = session.modelRegistry;
				const assertCurrent = () => {
					const lifecycle = session.sessionLifecycle;
					if (
						lifecycle.disposed ||
						lifecycle.transitioning ||
						lifecycle.generation !== generation ||
						session.sessionManager !== manager ||
						session.sessionId !== sessionId ||
						session.modelRegistry !== ownerRegistry
					)
						throw new Error("Session changed while refreshing models");
				};
				assertCurrent();
				if (controlOnly) await ownerRegistry.refresh(strategy);
				else await ownerRegistry.refresh(strategy, session.credentialSessionId);
				assertCurrent();
			},
			releaseResources(): Promise<void> {
				if (releasing) return releasing;
				releasing = (async () => {
					await created.session.awaitDisposeCompletion();
					const outcomes = await Promise.allSettled([registry?.dispose(), closeSettings()]);
					const failures: unknown[] = outcomes.flatMap(outcome =>
						outcome.status === "rejected" ? [outcome.reason] : [],
					);
					if (failures.length) throw new AggregateError(failures, "Session dependencies failed to release");
				})();
				void releasing.catch(() => {
					releasing = undefined;
				});
				return releasing;
			},
		});
	} catch (error) {
		if (result) {
			const disposal = result.session.dispose();
			void disposal.catch(() => {});
			await result.session.awaitDisposeCompletion();
		} else await manager.close();
		await registry?.dispose();
		await closeSettings();
		throw error;
	}
}

/** Read-only inventory; neither recovery nor writer admission is performed. */
export async function listEmbeddedProjectSessions(input: { cwd: string; agentDir: string; directory: string }) {
	const [managed, local] = await Promise.all([
		SessionManager.listManagedForResumePickerReadOnly(input.cwd, input.agentDir),
		SessionManager.listForResumePickerReadOnly(input.cwd, input.directory),
	]);
	return { managed, local };
}

/** Capture and copy through the SDK's strict immutable transcript boundary. */
export async function forkEmbeddedSession(input: { file: string; cwd: string; directory: string }) {
	const capture = SessionManager.captureTranscriptStrict(input.file);
	if (capture.kind !== "captured") throw new Error("Could not capture source transcript for fork");
	try {
		const copied = await SessionManager.forkFromCaptured(capture.snapshot, input.cwd, input.directory);
		if (copied.kind !== "forked") throw new Error("Could not create captured session fork");
		return copied.manager;
	} finally {
		capture.snapshot.close();
	}
}

/** The embedding must first release its writer and remove the durable catalog reference. */
export async function deleteEmbeddedSession(file: string): Promise<void> {
	await new FileSessionStorage().deleteSessionWithArtifacts(file);
}

/** Process-entrypoint cleanup keeps the SDK's signal-exit authority intact. */
export function registerEmbeddedProcessCleanup(name: string, cleanup: () => Promise<void>): () => void {
	usePostmortemSignalExitAuthority();
	return postmortem.register(name, cleanup);
}
