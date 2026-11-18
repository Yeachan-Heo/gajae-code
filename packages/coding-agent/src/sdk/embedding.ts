import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import type * as NativeBindings from "@gajae-code/natives";
import { getAgentDir, getSessionsDir, postmortem } from "@gajae-code/utils";
import { invalidate, releaseSettingsScope } from "../capability";
import { getConfigDirs } from "../config";
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
import {
	artifactTreePayloadAbsent,
	deleteManagedSessionCandidate,
	type ManagedDeleteCandidateResult,
} from "../session/internal/managed-session-scope";
import { captureNativeResumeTranscript } from "../session/native-resume";
import {
	captureOwnerTargetSync,
	deleteWithOwnerCheck,
	OwnerAuthorityError,
	type OwnerTarget,
} from "../session/owner-group";
import {
	isProjectSessionTranscriptPath,
	type SessionEntry,
	SessionManager,
	type StrictInventoryCandidate,
	type StrictInventoryFailure,
	type StrictInventoryResult,
} from "../session/session-manager";
import {
	assertSessionSpillCleanup,
	captureSessionSpillCleanup,
	FileSessionStorage,
	type SessionStorageFileIdentity,
	type VerifiedSessionDeleteResult,
	type VerifiedSessionDeleteTarget,
} from "../session/session-storage";
import {
	createNativeEmbeddedAgentSession,
	type NativeEmbeddedAgentSessionOptions,
	type NativeEmbeddedOpenResult,
	nativeEmbeddedRuntimeConstructed,
	nativeEmbeddedStartupFailed,
	resolveEmbeddedResumeCheckpoint,
} from "./native-embedding";
import { createNativeOwnerInspectors } from "./native-ownership";
import { createSdkPreferenceControls } from "./preference-controls";
import type { SdkRevisionInput, SdkRevisionResult } from "./protocol/revision-contracts";
import { reviseSession, SdkRevisionError, type SdkRevisionRuntimeOptions } from "./revision-controls";
import { type CreateAgentSessionOptions, type CreateAgentSessionResult, createAgentSession } from "./session";
import { inspectManagedFileNoFollow, validateManagedArtifactTree } from "./session-readonly/inspection";
import {
	listManagedCandidates,
	type ManagedCandidate,
	type ManagedScope,
	resolveManagedScope,
} from "./session-readonly/scope";

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
	/** The host supplies no async job manager. */
	readonly asyncJobs?: "none";
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
export function createEmbeddedAgentSession(
	options: NativeEmbeddedAgentSessionOptions,
): Promise<NativeEmbeddedOpenResult>;
export function createEmbeddedAgentSession(options: EmbeddedAgentSessionOptions): Promise<EmbeddedAgentSessionResult>;
export async function createEmbeddedAgentSession(
	options: EmbeddedAgentSessionOptions | NativeEmbeddedAgentSessionOptions,
): Promise<EmbeddedAgentSessionResult | NativeEmbeddedOpenResult> {
	if ("native" in options) return createNativeEmbeddedAgentSession(options);
	const { storage, createSession = createAgentSession, controlOnly = false, ...sessionOptions } = options;
	const destination =
		"persist" in storage
			? undefined
			: "managed" in storage
				? SessionManager.managedDestination(options.cwd, options.agentDir)
				: SessionManager.explicitDestination(storage.directory, options.agentDir);
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
		if (await nativeEmbeddedStartupFailed(manager, async () => {})) throw error;
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
		nativeEmbeddedRuntimeConstructed(manager, result);
		const created = result;
		let revisionIdentity = manager.getSessionIdentityGeneration();
		const ownsRevisionIdentity = () =>
			!controlOnly &&
			created.session.sessionManager === manager &&
			manager.getSessionIdentityGeneration() === revisionIdentity;
		// The native factory establishes the scoped discovery context before capability reads.
		if (!controlOnly && sessionOptions.slashCommands === undefined)
			created.session.setSlashCommands(
				await loadSlashCommands({ cwd: options.cwd, agentDir: options.agentDir, settings }),
			);
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
				for (const directory of getConfigDirs("commands", { cwd, existingOnly: false })) invalidate(directory.path);
				invalidate(path.join(options.agentDir, "commands"));
				const commands = await loadSlashCommands({ cwd, agentDir: options.agentDir, settings });
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
					// The factory owns this manager: once its own closure actually closed, a
					// cooperative member is no longer live and must not veto later deletion.
					// Exclusive native members retire only through their reconciled lifecycle.
					const ownedManager = created.session.sessionManager;
					const membership = ownedManager.getOwnerMembership();
					if (membership) ownedManager.retireCooperativeOwnerAfterClose(membership);
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
		if (
			await nativeEmbeddedStartupFailed(manager, async () => {
				await registry?.dispose();
				await closeSettings();
			})
		)
			throw error;
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

/** Display rows remain forgiving; completeness comes only from bounded, read-only captures. */
export async function listEmbeddedProjectSessions(input: { cwd: string; agentDir: string; directory: string }) {
	const [managed, local] = await Promise.all([
		SessionManager.listManagedForResumePickerReadOnly(input.cwd, input.agentDir),
		SessionManager.listForResumePickerReadOnly(input.cwd, input.directory),
	]);
	const storage = new FileSessionStorage();
	const inventory = (
		scan: (directory: (name: string) => fs.Dirent[] | undefined, candidate: (file: string) => void) => void,
	): StrictInventoryResult => {
		const failures: StrictInventoryFailure[] = [];
		const candidates: StrictInventoryCandidate[] = [];
		const handles = new Map<string, { fd: number; stat: fs.BigIntStats; scanned: boolean }>();
		const absent = new Set<string>();
		const seen = new Set<string>();
		let work = 0;
		const same = (left: fs.BigIntStats, right: fs.BigIntStats, scanned: boolean): boolean =>
			left.isDirectory() &&
			right.isDirectory() &&
			!right.isSymbolicLink() &&
			left.dev === right.dev &&
			left.ino === right.ino &&
			(!scanned || (left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs));
		const bind = (name: string): boolean => {
			name = path.resolve(name);
			if (handles.has(name)) return true;
			if (absent.has(name)) return false;
			if (++work > 4096) throw new Error("Directory inspection limit exceeded");
			const parent = path.dirname(name);
			if (parent !== name && !bind(parent)) {
				absent.add(name);
				return false;
			}
			let named: fs.BigIntStats;
			try {
				named = fs.lstatSync(name, { bigint: true });
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
				absent.add(name);
				return false;
			}
			if (!named.isDirectory() || named.isSymbolicLink()) throw new Error("Unsafe directory name");
			const fd = fs.openSync(name, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
			try {
				const stat = fs.fstatSync(fd, { bigint: true });
				if (!same(stat, named, false)) throw new Error("Directory name changed");
				handles.set(name, { fd, stat, scanned: false });
			} catch (error) {
				fs.closeSync(fd);
				throw error;
			}
			return true;
		};
		const directory = (name: string): fs.Dirent[] | undefined => {
			name = path.resolve(name);
			if (!bind(name)) return undefined;
			const handle = handles.get(name)!;
			const entries = fs.readdirSync(name, { withFileTypes: true });
			if (
				entries.length > 50_000 ||
				!same(handle.stat, fs.fstatSync(handle.fd, { bigint: true }), true) ||
				!same(handle.stat, fs.lstatSync(name, { bigint: true }), true)
			)
				throw new Error("Directory changed or exceeded its inspection limit");
			handle.scanned = true;
			return entries;
		};
		const candidate = (file: string): void => {
			file = path.resolve(file);
			if (seen.has(file)) return;
			seen.add(file);
			if (seen.size > 50_000) throw new Error("Session inspection limit exceeded");
			const observed = captureNativeResumeTranscript(file, storage);
			if (
				observed.capture.kind !== "captured" ||
				!observed.identity ||
				!observed.stat ||
				observed.capture.reducerView.kind === "invalid"
			) {
				failures.push({ kind: "read", message: "Candidate could not be structurally verified", path: file });
				return;
			}
			const captured = SessionManager.captureTranscriptStrict(file, storage);
			if (captured.kind !== "captured") {
				failures.push({ kind: "read", message: "Candidate changed during inspection", path: file });
				return;
			}
			try {
				if (
					captured.snapshot.identity.sha256 !== observed.capture.snapshotDigest ||
					captured.snapshot.identity.dev !== observed.identity.dev ||
					captured.snapshot.identity.ino !== observed.identity.ino
				)
					throw new Error("Candidate changed during inspection");
				let cwd: string | undefined;
				captured.snapshot.forEachLine(line => {
					const entry = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(line));
					if (entry.type === "session") cwd = entry.cwd;
					else if (entry.type === "header_patch" && entry.patch?.cwd !== undefined) cwd = entry.patch.cwd;
				});
				if (typeof cwd !== "string" || fs.realpathSync.native(cwd) !== fs.realpathSync.native(input.cwd)) {
					failures.push({
						kind: "cwd",
						message: "Candidate workspace does not match the selected project",
						path: file,
					});
					return;
				}
				if (captured.snapshot.revalidate().kind !== "valid") throw new Error("Candidate changed during inspection");
				candidates.push({
					path: file,
					id: observed.capture.reducerView.headerId,
					cwd: fs.realpathSync.native(cwd),
					identity: observed.stat,
				});
			} finally {
				captured.snapshot.close();
			}
		};
		try {
			scan(directory, candidate);
			// Certify every inspected name, including ancestors and confirmed absences,
			// only after all candidate inspection has finished. A rename is not emptiness.
			for (const [name, handle] of handles) {
				if (
					!same(handle.stat, fs.fstatSync(handle.fd, { bigint: true }), handle.scanned) ||
					!same(handle.stat, fs.lstatSync(name, { bigint: true }), handle.scanned)
				)
					throw new Error("Directory authority changed");
			}
			for (const name of absent) {
				try {
					fs.lstatSync(name);
					throw new Error("Absent directory appeared");
				} catch (error) {
					if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
				}
			}
		} catch {
			failures.push({ kind: "scan", message: "Scoped inventory could not certify its directory names" });
		} finally {
			for (const handle of handles.values()) fs.closeSync(handle.fd);
		}
		return failures.length ? { kind: "failure", failures } : { kind: "complete", candidates };
	};
	const managedInventory = inventory((directory, candidate) => {
		const sessionsRoot = getSessionsDir(input.agentDir);
		const root = directory(sessionsRoot);
		if (root) {
			const resolved = resolveManagedScope({ cwd: input.cwd, agentDir: input.agentDir, sessionsRoot });
			if (resolved.kind === "error") throw new Error(resolved.message);
			const legacy = root.filter(entry => entry.name.startsWith("-"));
			if (legacy.length > 256) throw new Error("Legacy session discovery limit exceeded");
			for (const entry of legacy) directory(path.join(sessionsRoot, entry.name));
			directory(resolved.scope.directoryPath);
			const listing = listManagedCandidates(resolved.scope);
			if (listing.kind !== "complete" || listing.invalid.length)
				throw new Error("Managed candidates could not be verified");
			for (const entry of listing.owned) {
				directory(path.dirname(entry.path));
				candidate(entry.path);
			}
		}
		const projectRoot = path.join(path.resolve(input.cwd), ".gjc");
		const pending = [projectRoot];
		while (pending.length) {
			const current = pending.pop()!;
			for (const entry of directory(current) ?? []) {
				const file = path.join(current, entry.name);
				if (entry.isSymbolicLink()) throw new Error("Project inventory encountered a symlink");
				if (entry.isDirectory()) {
					if (entry.name !== ".staging") pending.push(file);
				} else if (
					!entry.name.startsWith(".") &&
					entry.name.endsWith(".jsonl") &&
					isProjectSessionTranscriptPath(projectRoot, file)
				)
					candidate(file);
			}
		}
	});
	const localInventory = inventory((directory, candidate) => {
		for (const entry of directory(input.directory) ?? []) {
			if (entry.name.endsWith(".jsonl")) candidate(path.join(input.directory, entry.name));
		}
	});
	const incomplete = [
		...(managedInventory.kind === "failure"
			? managedInventory.failures.map(failure => ({ scope: "managed" as const, ...failure }))
			: []),
		...(localInventory.kind === "failure"
			? localInventory.failures.map(failure => ({ scope: "local" as const, ...failure }))
			: []),
	];
	return {
		managed,
		local,
		inventory: { managed: managedInventory, local: localInventory },
		outcome: incomplete.length
			? { kind: "incomplete" as const, failures: incomplete }
			: { kind: "complete" as const },
	};
}

/** Fork complete captured history with a separately selected execution checkpoint. */
export async function forkEmbeddedSession(
	input: {
		file: string;
		cwd: string;
		selection?: { snapshotDigest: string; targetLeafId: string | null };
		reserveSelectedForkTranscript?: (identity: {
			readonly role: "staging" | "successor";
			readonly sessionId: string;
			readonly file: string;
		}) => Promise<void>;
	} & (
		| { directory: string; agentDir?: string }
		| { agentDir: string; managed: true }
	),
): Promise<SessionManager> {
	const resolved = resolveEmbeddedResumeCheckpoint(input.file);
	if (resolved.kind !== "resolved")
		throw Object.assign(new Error("Could not resolve source transcript for fork"), { code: resolved.reason });
	const checkpoint = resolved.checkpoint;
	if (checkpoint.kind === "invalid")
		throw Object.assign(new Error("Source transcript has an invalid execution graph"), {
			code: "invalid_checkpoint",
			checkpoint,
		});
	// Copy consent before the first await; callers cannot change the selected digest/target in flight.
	const selection = input.selection ? Object.freeze({ ...input.selection }) : undefined;
	const reserveSelectedForkTranscript = input.reserveSelectedForkTranscript;
	if (selection && selection.snapshotDigest !== checkpoint.snapshotDigest)
		throw Object.assign(new Error("Fork source changed since selection"), { code: "stale_snapshot", checkpoint });
	if (!selection && (checkpoint.kind === "ambiguous" || checkpoint.kind === "legacy_tail"))
		throw Object.assign(new Error("Fork source requires an explicit execution selection"), {
			code: "selector_required",
			checkpoint,
		});
	const target = selection ? selection.targetLeafId : checkpoint.leafEntryId;
	if (target !== null && (typeof target !== "string" || target.length === 0))
		throw Object.assign(new Error("Invalid fork execution target"), { code: "invalid_target", checkpoint });
	const capture = SessionManager.captureTranscriptStrict(input.file);
	if (capture.kind !== "captured")
		throw Object.assign(new Error("Could not capture source transcript for fork"), { code: capture.reason });
	try {
		if (
			capture.snapshot.identity.sha256 !== checkpoint.snapshotDigest ||
			capture.snapshot.identity.dev !== resolved.identity.dev ||
			capture.snapshot.identity.ino !== resolved.identity.ino
		)
			throw Object.assign(new Error("Fork source changed since selection"), { code: "stale_snapshot", checkpoint });
		const validated = capture.snapshot.revalidate();
		if (validated.kind !== "valid")
			throw Object.assign(new Error("Fork source changed before publication"), { code: validated.reason });
		if (target !== null) {
			let found = false;
			capture.snapshot.forEachLine(line => {
				const record = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(line));
				if (record.type !== "session" && record.id === target) found = true;
			});
			if (!found)
				throw Object.assign(new Error("Fork execution target is not in the captured transcript"), {
					code: "invalid_target",
					checkpoint,
				});
		}
		if (!("managed" in input)) {
			// Refuse a known foreign collision before constructing a manager, whose
			// owner admission and resident cache initialization have write effects.
			let existing: fs.Stats | undefined;
			try {
				existing = fs.lstatSync(input.directory);
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
			}
			if (existing && (!existing.isDirectory() || existing.isSymbolicLink()))
				throw Object.assign(new Error("Fork destination is not a non-symlink directory"), {
					code: "destination_unavailable",
				});
		}
		const destination =
			"managed" in input
				? SessionManager.managedDestination(input.cwd, input.agentDir)
				: SessionManager.explicitDestination(input.directory, input.agentDir);
		// Sixth argument remains the legacy history filter. Native target selection
		// is separate so null and non-tail targets never discard original records.
		const fork = await SessionManager.forkFromCaptured(
			capture.snapshot,
			input.cwd,
			destination,
			"copy-retain",
			"auto",
			undefined,
			{ executionTargetLeafId: target, reserveSelectedForkTranscript },
		);
		if (fork.kind !== "forked")
			throw Object.assign(new Error("Could not publish forked session"), { code: fork.reason, outcome: fork });
		return fork.manager;
	} finally {
		capture.snapshot.close();
	}
}

/** Owner vetoes precede every cleanup effect. Errors retain an opaque same-process retry handle. */
export const deleteEmbeddedSession = (() => {
	type DeleteState = {
		file: string;
		managed: boolean;
		managedBinding?: { scope: ManagedScope; candidate: ManagedCandidate };
		managedOutcome?: ManagedDeleteCandidateResult;
		agentDir: string;
		cwd: string;
		owner: OwnerTarget;
		generation: string;
		target: VerifiedSessionDeleteTarget;
		artifactPlans: Set<string>;
		outcome?: VerifiedSessionDeleteResult;
		checkpoint?: { path: string; identity: SessionStorageFileIdentity; bytes: string };
		uncertain?: true;
		deleted: boolean;
		busy: boolean;
	};
	const retries = new WeakMap<object, DeleteState>();
	const encode = (value: unknown): string =>
		JSON.stringify(value, (_key, item: unknown) => (typeof item === "bigint" ? String(item) : item));
	const assertCheckpoint = (state: DeleteState): void => {
		const receipt = state.checkpoint;
		if (!receipt) throw new OwnerAuthorityError("authority_changed");
		const observed = inspectManagedFileNoFollow(receipt.path, Buffer.byteLength(receipt.bytes));
		if (
			encode(observed.identity) !== encode(receipt.identity) ||
			Buffer.from(observed.bytes).toString("utf8") !== receipt.bytes
		)
			throw new OwnerAuthorityError("authority_changed");
	};
	const publishCheckpoint = (storage: FileSessionStorage, state: DeleteState): void => {
		if (state.checkpoint) assertCheckpoint(state);
		const bytes = `${encode({ version: 1, target: state.target, artifactPlans: [...state.artifactPlans], outcome: state.outcome })}\n`;
		const pathname = path.join(state.owner.authorityRoot.realpath, `.gjc-delete-${crypto.randomUUID()}-receipt`);
		const writer = storage.openStagedWriter(pathname);
		try {
			writer.writeLine(Buffer.from(bytes.slice(0, -1)));
			writer.fsync();
		} finally {
			writer.closeSync();
		}
		const published = writer.publishNoReplace();
		if (published.kind !== "fsync" || published.namespaceSynced !== true)
			throw new Error("Deletion receipt publication was not durable");
		const observed = inspectManagedFileNoFollow(pathname, Buffer.byteLength(bytes));
		if (
			observed.identity.dev !== published.stat.dev ||
			observed.identity.ino !== published.stat.ino ||
			observed.identity.ctimeNs !== published.stat.ctimeNs ||
			observed.identity.sha256 !== published.sha256 ||
			Buffer.from(observed.bytes).toString("utf8") !== bytes
		)
			throw new OwnerAuthorityError("authority_changed");
		state.checkpoint = { path: pathname, identity: observed.identity, bytes };
		assertCheckpoint(state);
	};
	const absent = (pathname: string): boolean => {
		try {
			fs.lstatSync(pathname);
			return false;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return true;
			throw error;
		}
	};
	const assertCanonicalTranscriptAbsent = (state: DeleteState): void => {
		if (absent(state.file)) return;
		state.uncertain = true;
		throw Object.assign(new Error("Canonical transcript pathname reappeared; deletion completion is uncertain"), {
			code: "cleanup_pending",
		});
	};
	const assertArtifactCompletion = (state: DeleteState, completed = true): void => {
		const target = state.target;
		const detached = target.detachedArtifactsPath;
		const aliases = new Set([
			target.transcriptPath.slice(0, -6),
			...Array.from(state.artifactPlans, planned => [planned, `${planned}.removing`]).flat(),
			...[
				target.retainedArtifactsSuccessorPath,
				target.retainedArtifactsPlaceholderPath,
				target.retainedArtifactsUnknownPath,
			].filter((name): name is string => name !== undefined),
		]);
		for (const alias of aliases) {
			if (alias !== detached && !absent(alias)) throw new OwnerAuthorityError("authority_changed");
		}
		if (!detached) return;
		if (
			(!Array.from(state.artifactPlans).some(planned => detached === `${planned}.removing`) &&
				(completed || !state.artifactPlans.has(detached))) ||
			!target.expectedArtifactsIdentity ||
			!target.expectedArtifactsTree ||
			(completed && !artifactTreePayloadAbsent(target.expectedArtifactsTree))
		)
			throw new OwnerAuthorityError("authority_changed");
		validateManagedArtifactTree(detached);
		const native = require("@gajae-code/natives") as typeof NativeBindings;
		const observed = native.snapshotDirectoryTree(detached);
		if (
			!observed.ok ||
			!observed.snapshot ||
			observed.snapshot.rootDev !== String(target.expectedArtifactsIdentity.dev) ||
			observed.snapshot.rootIno !== String(target.expectedArtifactsIdentity.ino) ||
			(completed
				? !artifactTreePayloadAbsent(observed.snapshot)
				: encode(observed.snapshot) !== encode(target.expectedArtifactsTree))
		)
			throw new OwnerAuthorityError("authority_changed");
	};
	const generation = (owner: OwnerTarget): string => {
		try {
			const { identity } = inspectManagedFileNoFollow(owner.authorityKey, 0);
			return [
				identity.dev,
				identity.ino,
				identity.nlink,
				identity.size,
				identity.mtimeNs,
				identity.ctimeNs,
				identity.sha256,
			].join(":");
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return "absent";
			throw error;
		}
	};
	return async function deleteEmbeddedSession(
		file: string,
		options?: { managed?: true; agentDir?: string; cwd?: string; retry?: object },
	): Promise<void> {
		const retry = options?.retry ?? Object.freeze({});
		let state = retries.get(retry);
		if (options?.retry && !state) throw new Error("Invalid or completed deletion retry handle");
		if (!state) {
			// Stream the actual selected descriptor, retaining only a bounded header.
			const snapshot = inspectManagedFileNoFollow(file, 64 * 1024 + 1);
			const newline = snapshot.bytes.indexOf(10);
			const length = newline === -1 ? snapshot.bytes.length : newline;
			if (length > 64 * 1024 || (newline === -1 && snapshot.identity.size > length))
				throw new Error("Session header exceeds its bounded inspection limit");
			const header: unknown = JSON.parse(
				new TextDecoder("utf-8", { fatal: true }).decode(snapshot.bytes.subarray(0, length)),
			);
			if (
				!header ||
				typeof header !== "object" ||
				!("type" in header) ||
				header.type !== "session" ||
				!("id" in header) ||
				typeof header.id !== "string" ||
				!("cwd" in header) ||
				typeof header.cwd !== "string" ||
				!path.isAbsolute(header.cwd)
			)
				throw new Error("Session has no valid workspace header");
			const cwd = fs.realpathSync.native(header.cwd);
			if (options?.cwd && fs.realpathSync.native(options.cwd) !== cwd)
				throw new Error("Session project does not match deletion scope");
			const agentDir = options?.agentDir ?? getAgentDir();
			let managedBinding: DeleteState["managedBinding"];
			if (options?.managed && !isProjectSessionTranscriptPath(path.join(cwd, ".gjc"), file)) {
				const resolved = resolveManagedScope({ cwd, agentDir, sessionsRoot: getSessionsDir(agentDir) });
				if (resolved.kind !== "resolved") throw new Error("Managed deletion scope could not be resolved");
				const listing = listManagedCandidates(resolved.scope);
				const candidate =
					listing.kind === "complete" && !listing.invalid.length
						? listing.owned.find(
								item =>
									path.resolve(item.path) === path.resolve(file) &&
									item.identity.dev === snapshot.identity.dev &&
									item.identity.ino === snapshot.identity.ino &&
									item.identity.sha256 === snapshot.identity.sha256,
							)
						: undefined;
				if (!candidate) throw new Error("Session is not in the selected managed deletion scope");
				managedBinding = { scope: resolved.scope, candidate };
			}
			const owner = captureOwnerTargetSync({
				transcriptPath: file,
				headerId: header.id,
				snapshotDigest: snapshot.identity.sha256,
			});
			state = {
				file: path.resolve(file),
				managed: options?.managed === true,
				managedBinding,
				agentDir,
				cwd,
				owner,
				generation: generation(owner),
				target: {
					spillCleanup: captureSessionSpillCleanup(owner.transcriptPath),
					sessionsRoot: owner.authorityRoot.realpath,
					transcriptPath: owner.transcriptPath,
					sessionId: header.id,
					cwd,
					transcriptIdentity: snapshot.identity,
					transcriptParentIdentity: { dev: BigInt(owner.authorityRoot.dev), ino: BigInt(owner.authorityRoot.ino) },
				},
				artifactPlans: new Set(),
				deleted: false,
				busy: false,
			};
			retries.set(retry, state);
		}
		if (state.busy) throw new Error("Deletion retry is already running");
		if (
			path.resolve(file) !== state.file ||
			(options?.managed === true) !== state.managed ||
			(options?.agentDir !== undefined && path.resolve(options.agentDir) !== path.resolve(state.agentDir)) ||
			(options?.cwd !== undefined && fs.realpathSync.native(options.cwd) !== state.cwd)
		)
			throw new Error("Deletion retry scope does not match retained authority");
		state.busy = true;
		const retained = state;
		try {
			// Refuse a foreign live name before acquiring owner guards or replaying
			// cleanup authority. In particular, an empty replacement is not a retry.
			if (options?.retry && !absent(retained.file)) {
				const observed = inspectManagedFileNoFollow(retained.file, 0);
				if (encode(observed.identity) !== encode(retained.target.transcriptIdentity))
					throw new OwnerAuthorityError("authority_changed");
			}
			let owner = retained.owner;
			if (
				retained.deleted ||
				retained.target.detachedTranscriptPath ||
				retained.target.taskArtifactOwnerTranscriptDeleted ||
				(retained.managedOutcome?.kind === "cleanup_pending" && absent(retained.owner.transcriptPath))
			) {
				// Only retained positive/native cleanup evidence permits the absent-name case.
				owner = captureOwnerTargetSync({
					transcriptPath: retained.owner.transcriptPath,
					headerId: retained.owner.headerId,
				});
				if (
					owner.transcriptExists ||
					owner.authorityRoot.dev !== retained.owner.authorityRoot.dev ||
					owner.authorityRoot.ino !== retained.owner.authorityRoot.ino
				)
					throw new OwnerAuthorityError("authority_changed");
			}
			if (generation(owner) !== retained.generation) throw new OwnerAuthorityError("authority_changed");
			await deleteWithOwnerCheck(
				owner,
				createNativeOwnerInspectors({ agentDir: retained.agentDir, cwd: retained.cwd }),
				async resolved => {
					// A completed move needs separate retained destination authority; never guess it from absence.
					if (resolved.transcriptPath !== retained.owner.transcriptPath)
						throw new OwnerAuthorityError("session_moved");
					if (generation(resolved) !== retained.generation) throw new OwnerAuthorityError("authority_changed");
					if (!retained.deleted) {
						if (retained.managedBinding) {
							// Same coordinator as SessionManager.deleteManagedCandidate, retaining
							// its exact scope/candidate for authenticated post-retirement retry.
							const { scope, candidate } = retained.managedBinding;
							const outcome = await deleteManagedSessionCandidate(scope, candidate);
							retained.managedOutcome = structuredClone(outcome);
							if (outcome.kind !== "deleted" && outcome.kind !== "already_deleted")
								throw Object.assign(new Error(outcome.message), {
									code: outcome.kind === "cleanup_pending" ? "cleanup_pending" : outcome.code,
									outcome: structuredClone(outcome),
								});
							assertCanonicalTranscriptAbsent(retained);
							retained.deleted = true;
						} else {
							const storage = new FileSessionStorage();
							if (retained.uncertain)
								throw Object.assign(new Error("Deletion dispatch outcome is unknown; recapture is required"), {
									code: "deletion_uncertain",
								});
							for (;;) {
								const nonce = crypto.randomUUID();
								retained.target.plannedArtifactsPath ??= path.join(
									resolved.authorityRoot.realpath,
									`.gjc-delete-${nonce}-artifacts`,
								);
								retained.target.plannedTranscriptPath ??= path.join(
									resolved.authorityRoot.realpath,
									`.gjc-delete-${nonce}-transcript`,
								);
								retained.artifactPlans.add(retained.target.plannedArtifactsPath);
								if (retained.target.detachedArtifactsPath || retained.target.artifactsRemoved)
									assertArtifactCompletion(retained, retained.target.artifactsRemoved === true);
								if (retained.target.detachedArtifactsPath === retained.target.plannedArtifactsPath) {
									// Preserve the detached authority and all historical aliases, but
									// issue the distinct destination required by lower retry validation.
									retained.target.plannedArtifactsPath = path.join(
										resolved.authorityRoot.realpath,
										`.gjc-delete-${crypto.randomUUID()}-artifacts`,
									);
									retained.artifactPlans.add(retained.target.plannedArtifactsPath);
								}
								// Prepared plans and every completion checkpoint are issued by this
								// facade, fsync'd and bound to exact bytes/inodes before reentry.
								publishCheckpoint(storage, retained);
								if (retained.target.artifactsRemoved) assertArtifactCompletion(retained);
								retained.uncertain = true;
								const outcome = await storage.deleteSessionVerified(
									retained.target,
									undefined,
									async evidence => {
										assertCheckpoint(retained);
										retained.target.spillCleanup = evidence;
										publishCheckpoint(storage, retained);
									},
								);
								retained.uncertain = undefined;
								retained.outcome = structuredClone(outcome);
								if (outcome.kind === "deleted") {
									assertCanonicalTranscriptAbsent(retained);
									if (
										outcome.taskArtifactOwnerDeletionEvidence &&
										outcome.taskArtifactOwnerRetirementOutcome?.kind !== "completed"
									) {
										// Transcript retirement is not strict owner completion. Retain
										// the actual continuation so the next retry still dispatches it.
										Object.assign(retained.target, {
											detachedTranscriptPath: outcome.detachedTranscriptPath,
											retainedTranscriptSuccessorPath: outcome.retainedSuccessorPath,
											retainedTranscriptPlaceholderPath: outcome.retainedPlaceholderPath,
											retainedTranscriptUnknownPath: outcome.retainedUnknownPath,
											taskArtifactOwnerDeletionEvidence: outcome.taskArtifactOwnerDeletionEvidence,
											taskArtifactOwnerRetirementOutcome: outcome.taskArtifactOwnerRetirementOutcome,
											taskArtifactOwnerTranscriptDeleted: outcome.taskArtifactOwnerTranscriptDeleted,
											taskArtifactOwnerRetirementContinuation:
												outcome.taskArtifactOwnerRetirementContinuation,
											taskArtifactOwnerPayloadRetired: outcome.taskArtifactOwnerPayloadRetired,
											taskArtifactOwnerNamespaceRetained: outcome.taskArtifactOwnerNamespaceRetained,
										});
										publishCheckpoint(storage, retained);
										throw Object.assign(new Error("Task-artifact owner namespace cleanup remains pending"), {
											code: "cleanup_pending",
											outcome: structuredClone(outcome),
										});
									}
									retained.deleted = true;
									publishCheckpoint(storage, retained);
									assertCanonicalTranscriptAbsent(retained);
									break;
								}
								const target = retained.target;
								if (encode(outcome.transcriptIdentity) !== encode(target.transcriptIdentity))
									throw new OwnerAuthorityError("authority_changed");
								target.taskArtifactOwnerDeletionEvidence = outcome.taskArtifactOwnerDeletionEvidence;
								target.taskArtifactOwnerRetirementOutcome = outcome.taskArtifactOwnerRetirementOutcome;
								target.taskArtifactOwnerTranscriptDeleted = outcome.taskArtifactOwnerTranscriptDeleted;
								target.taskArtifactOwnerRetired = outcome.taskArtifactOwnerRetired;
								target.taskArtifactOwnerRetirementContinuation =
									outcome.taskArtifactOwnerRetirementContinuation;
								target.taskArtifactOwnerPayloadRetired = outcome.taskArtifactOwnerPayloadRetired;
								target.taskArtifactOwnerNamespaceRetained = outcome.taskArtifactOwnerNamespaceRetained;
								if (outcome.kind === "artifacts_removed") {
									assertArtifactCompletion(retained);
									target.artifactsRemoved = true;
									publishCheckpoint(storage, retained);
									continue;
								}
								if (outcome.phase === "artifacts") {
									target.expectedArtifactsIdentity = outcome.artifactsIdentity;
									target.expectedArtifactsTree = outcome.artifactsTree;
									target.detachedArtifactsPath = outcome.detachedArtifactsPath;
									target.retainedArtifactsSuccessorPath = outcome.retainedSuccessorPath;
									target.retainedArtifactsPlaceholderPath = outcome.retainedPlaceholderPath;
									target.retainedArtifactsUnknownPath = outcome.retainedUnknownPath;
								} else if (outcome.phase === "transcript") {
									target.plannedTranscriptPath = path.join(
										resolved.authorityRoot.realpath,
										`.gjc-delete-${crypto.randomUUID()}-transcript`,
									);
									target.artifactsRemoved = true;
									target.detachedTranscriptPath = outcome.detachedTranscriptPath;
									target.retainedTranscriptSuccessorPath = outcome.retainedSuccessorPath;
									target.retainedTranscriptPlaceholderPath = outcome.retainedPlaceholderPath;
									target.retainedTranscriptUnknownPath = outcome.retainedUnknownPath;
								} else if (outcome.artifactsRemoved) target.artifactsRemoved = true;
								// Ordinary artifacts have an inherited retained-namespace completion
								// class. Strict task-owner retirement never uses this adapter.
								if (
									outcome.phase === "artifacts" &&
									outcome.artifactsPayloadDurable === true &&
									outcome.retainedSuccessorPath === undefined &&
									outcome.retainedPlaceholderPath === undefined &&
									outcome.retainedUnknownPath === undefined &&
									artifactTreePayloadAbsent(outcome.artifactsTree)
								) {
									assertArtifactCompletion(retained);
									target.artifactsRemoved = true;
									publishCheckpoint(storage, retained);
									continue;
								}
								publishCheckpoint(storage, retained);
								throw Object.assign(
									new Error("Session deletion cleanup remains pending", { cause: outcome.error }),
									{ code: "cleanup_pending", retry, outcome: structuredClone(outcome) },
								);
							}
						}
					}
					if (!retained.managedBinding && retained.target.artifactsRemoved) assertArtifactCompletion(retained);
					if (!retained.managedBinding && retained.target.spillCleanup)
						assertSessionSpillCleanup(retained.target.spillCleanup, true);
					assertCanonicalTranscriptAbsent(retained);
					return { deleted: true, value: undefined };
				},
			);
			retries.delete(retry);
		} catch (error) {
			throw Object.assign(error instanceof Error ? error : new Error("Session deletion failed", { cause: error }), {
				retry,
			});
		} finally {
			retained.busy = false;
		}
	};
})();

/** Process-entrypoint cleanup keeps the SDK's signal-exit authority intact. */
export function registerEmbeddedProcessCleanup(name: string, cleanup: () => Promise<void>): () => void {
	usePostmortemSignalExitAuthority();
	return postmortem.register(name, cleanup);
}
