import * as path from "node:path";
import { postmortem } from "@gajae-code/utils";
import { releaseSettingsScope } from "../capability";
import { isSessionCredentialPinBlocking } from "../config/model-profile-activation";
import { createRegistrySelectorIndex, ModelRegistry, registrySelectorResolvesToModel } from "../config/model-registry";
import { normalizeModelSelectorValue } from "../config/model-selector-value";
import { Settings } from "../config/settings";
import { validateSettingPatch } from "../config/settings-schema";
import { loadSlashCommands } from "../extensibility/slash-commands";
import { initializeLocalRoot } from "../internal-urls";
import { usePostmortemSignalExitAuthority } from "../lsp/client";
import { type InitializeExtensionsOptions, initializeExtensions } from "../modes/runtime-init";
import { AgentRegistry } from "../registry/agent-registry";
import { type SessionEntry, SessionManager } from "../session/session-manager";
import { FileSessionStorage } from "../session/session-storage";
import { createSdkPreferenceControls } from "./preference-controls";
import type { SdkRevisionInput, SdkRevisionResult } from "./protocol/revision-contracts";
import { reviseSession, SdkRevisionError, type SdkRevisionRuntimeOptions } from "./revision-controls";
import { type CreateAgentSessionOptions, type CreateAgentSessionResult, createAgentSession } from "./session";

export type EmbeddedRevisionInput =
	| Omit<Extract<SdkRevisionInput, { action?: "edit" }>, "sessionId">
	| Omit<Extract<SdkRevisionInput, { action: "select" }>, "sessionId">;
export type EmbeddedRevisionOptions = Pick<SdkRevisionRuntimeOptions, "onRunAccepted" | "onPreflightAcceptCommit">;
export type { SdkRevisionResult } from "./protocol/revision-contracts";
export { SdkRevisionError } from "./revision-controls";

/** Answered sibling prompt revisions; identifiers are exact transcript entry IDs. */
export interface EmbeddedPromptRevision {
	index: number;
	count: number;
	previous?: string;
	next?: string;
}

const promptRevisionCache = new WeakMap<
	SessionManager,
	{
		identity: number;
		leaf: string | null;
		revisions: Map<string, EmbeddedPromptRevision | null>;
	}
>();

const isUserPrompt = (entry: SessionEntry | undefined): boolean =>
	entry?.type === "message" && entry.message.role === "user";
const isConversation = (entry: SessionEntry): boolean =>
	entry.type === "message" ||
	entry.type === "custom_message" ||
	entry.type === "compaction" ||
	entry.type === "branch_summary";

/** Oldest first, retaining manager order for ties and unreadable timestamps. */
function orderedRevisionEntries(entries: SessionEntry[]): SessionEntry[] {
	return entries
		.map((entry, order) => ({ entry, order, time: Date.parse(entry.timestamp) }))
		.sort((left, right) => {
			const elapsed = left.time - right.time;
			return (Number.isNaN(elapsed) ? 0 : elapsed) || left.order - right.order;
		})
		.map(item => item.entry);
}

/** Public read-only projection. Revision navigation belongs exclusively to the factory's revise control. */
export function getEmbeddedPromptRevision(
	session: CreateAgentSessionResult["session"],
	entryId: string,
): EmbeddedPromptRevision | undefined {
	if (session.sessionLifecycle.disposed || session.sessionLifecycle.transitioning) return undefined;
	const manager = session.sessionManager;
	const identity = manager.getSessionIdentityGeneration();
	const leaf = manager.getLeafId();
	let cache = promptRevisionCache.get(manager);
	if (!cache || cache.identity !== identity) {
		cache = { identity, leaf, revisions: new Map() };
		promptRevisionCache.set(manager, cache);
	} else if (cache.leaf !== leaf) {
		let current = leaf;
		let answersOnly = false;
		for (let steps = 0; current && steps < 64; steps++) {
			const entry = manager.getEntry(current);
			if (!entry || isUserPrompt(entry)) break;
			if (current === cache.leaf) {
				answersOnly = true;
				break;
			}
			current = entry.parentId;
		}
		if (!answersOnly) cache.revisions.clear();
		cache.leaf = leaf;
	}
	const cached = cache.revisions.get(entryId);
	if (cached !== undefined) return cached ? { ...cached } : undefined;
	const entry = manager.getEntry(entryId);
	if (!entry || !isUserPrompt(entry)) return undefined;
	let anchor = entry.parentId;
	while (anchor) {
		const parent = manager.getEntry(anchor);
		if (!parent || isConversation(parent)) break;
		anchor = parent.parentId;
	}
	const children = (id: string | null) =>
		orderedRevisionEntries(id === null ? manager.getTree().map(node => node.entry) : manager.getChildren(id));
	const prompts: SessionEntry[] = [];
	const pending = children(anchor);
	for (let index = 0; index < pending.length; index++) {
		const candidate = pending[index]!;
		if (isUserPrompt(candidate)) prompts.push(candidate);
		else if (!isConversation(candidate)) pending.push(...children(candidate.id));
	}
	const revisions = orderedRevisionEntries(prompts).filter(
		prompt => prompt.id === entryId || manager.getChildren(prompt.id).length > 0,
	);
	const index = revisions.findIndex(prompt => prompt.id === entryId);
	const result =
		index < 0 || revisions.length < 2
			? undefined
			: {
					index,
					count: revisions.length,
					...(index > 0 ? { previous: revisions[index - 1]!.id } : {}),
					...(index < revisions.length - 1 ? { next: revisions[index + 1]!.id } : {}),
				};
	cache.revisions.set(entryId, result ?? null);
	return result ? { ...result } : undefined;
}

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
		| { managed: true; file?: string; manager?: CreateAgentSessionResult["session"]["sessionManager"] }
		| { persist: false };
	/** Trusted factory injection for embedding integration tests. */
	createSession?: (options: CreateAgentSessionOptions) => Promise<CreateAgentSessionResult>;
	/** Control-only sessions own no transcript, extensions, MCP connections or project discovery. */
	controlOnly?: boolean;
}

export interface EmbeddedAgentSessionResult extends CreateAgentSessionResult {
	/** Branch through the native lifecycle and bind revision authority to its settled successor. */
	branch(entryId: string): Promise<{ selectedText: string; cancelled: boolean }>;
	/** Factory-bound canonical same-session edit or exact answered-branch selection. */
	revise(input: EmbeddedRevisionInput, options?: EmbeddedRevisionOptions): Promise<SdkRevisionResult>;
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

/** Admit either an explicit local writer or the canonical verified managed/shared-session writer. */
export async function createEmbeddedAgentSession(
	options: EmbeddedAgentSessionOptions,
): Promise<EmbeddedAgentSessionResult> {
	const { storage, createSession = createAgentSession, controlOnly = false, ...sessionOptions } = options;
	const destination =
		"persist" in storage
			? undefined
			: "managed" in storage
				? SessionManager.managedDestination(options.cwd, options.agentDir)
				: storage.directory;
	const manager =
		"persist" in storage
			? SessionManager.inMemory(options.cwd)
			: (storage.manager ??
				(storage.file
					? await SessionManager.open(storage.file, destination)
					: SessionManager.create(options.cwd, destination)));
	let settings: Settings;
	try {
		if (path.resolve(manager.getCwd()) !== path.resolve(options.cwd))
			throw new Error("Session project does not match catalog");
		// Factory injection does not bypass the managed local:// migration barrier.
		await initializeLocalRoot({
			getArtifactsDir: () => manager.getArtifactsDir(),
			isManagedDestination: () => manager.isManagedDestination(),
			getManagedLegacyLocalMigrationSource: () => manager.getManagedLegacyLocalMigrationSource(),
			getSessionId: () => manager.getSessionId(),
		});
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
		let revisionIdentity = manager.getSessionIdentityGeneration();
		const ownsRevisionIdentity = () =>
			!controlOnly &&
			created.session.sessionManager === manager &&
			manager.getSessionIdentityGeneration() === revisionIdentity;
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
			async branch(entryId: string): Promise<{ selectedText: string; cancelled: boolean }> {
				const session = created.session;
				if (!ownsRevisionIdentity() || session.sessionLifecycle.disposed)
					throw new SdkRevisionError("resource_gone");
				if (session.sessionLifecycle.transitioning) throw new SdkRevisionError("busy");
				const identity = revisionIdentity;
				const generation = session.sessionLifecycle.generation;
				const sessionId = session.sessionId;
				const agent = session.agent;
				const result = await session.branch(entryId);
				const lifecycle = session.sessionLifecycle;
				// Native branch commits one prepared identity and one lifecycle transition;
				// reject any intervening adoption instead of trusting its mutable current token.
				if (
					created.session !== session ||
					session.sessionManager !== manager ||
					session.agent !== agent ||
					lifecycle.disposed ||
					lifecycle.transitioning ||
					manager.getSessionIdentityGeneration() !== identity + (result.cancelled ? 0 : 1) ||
					lifecycle.generation !== generation + (result.cancelled ? 0 : 1) ||
					(result.cancelled ? session.sessionId !== sessionId : session.sessionId === sessionId)
				)
					throw new SdkRevisionError("resource_gone");
				// A failure (including post-commit failure) never reaches this renewal.
				if (!result.cancelled) revisionIdentity = identity + 1;
				return result;
			},
			revise(
				input: EmbeddedRevisionInput,
				revisionOptions: EmbeddedRevisionOptions = {},
			): Promise<SdkRevisionResult> {
				const session = created.session;
				if (!ownsRevisionIdentity()) return Promise.reject(new SdkRevisionError("resource_gone"));
				if (Object.hasOwn(input, "sessionId")) return Promise.reject(new SdkRevisionError("invalid_input"));
				return reviseSession(
					session,
					{ ...input, sessionId: session.sessionId },
					{
						onRunAccepted: revisionOptions.onRunAccepted,
						onPreflightAcceptCommit: revisionOptions.onPreflightAcceptCommit,
					},
				);
			},
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
export async function forkEmbeddedSession(
	input: { file: string; cwd: string } & ({ directory: string } | { agentDir: string; managed: true }),
) {
	const capture = SessionManager.captureTranscriptStrict(input.file);
	if (capture.kind !== "captured") throw new Error("Could not capture source transcript for fork");
	try {
		const destination =
			"managed" in input ? SessionManager.managedDestination(input.cwd, input.agentDir) : input.directory;
		const copied = await SessionManager.forkFromCaptured(capture.snapshot, input.cwd, destination);
		if (copied.kind !== "forked") throw new Error("Could not create captured session fork");
		return copied.manager;
	} finally {
		capture.snapshot.close();
	}
}

/** The embedding must first release its writer and remove the durable catalog reference. */
export async function deleteEmbeddedSession(file: string, options?: { managed: true }): Promise<void> {
	if (options?.managed && (await Bun.file(file).exists())) await SessionManager.deleteManagedCandidate(file);
	// Managed deletion tombstones the verified name before artifact cleanup.
	await new FileSessionStorage().deleteSessionWithArtifacts(file);
}

/** Process-entrypoint cleanup keeps the SDK's signal-exit authority intact. */
export function registerEmbeddedProcessCleanup(name: string, cleanup: () => Promise<void>): () => void {
	usePostmortemSignalExitAuthority();
	return postmortem.register(name, cleanup);
}
