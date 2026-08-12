import { createHash } from "node:crypto";
import * as path from "node:path";
import type { Model } from "@gajae-code/ai/core";
import type { ModelRegistry } from "../config/model-registry";
import { Settings } from "../config/settings";
import { AgentRegistry } from "../registry/agent-registry";
import {
	type CreateAgentSessionResult,
	createAgentSession,
	type MasterDoctrineDocument,
	type MasterSessionCapabilityProfile,
} from "../sdk/session";
import type { AuthStorage } from "../session/auth-storage";
import { SessionManager } from "../session/session-manager";
import { EventBus } from "../utils/event-bus";
import type { MasterCoordinatorGateway } from "./coordinator-gateway";
import type { MasterDomainStore } from "./domain-store";
import { createUnavailableMemoryContract, type MemoryContract } from "./memory-contract";
import { getMasterPaths, type MasterPaths } from "./paths";
import systemPrompt from "./prompts/system.md" with { type: "text" };
import {
	createMasterOrchestrationTools,
	type MasterClaimAdapter,
	type MasterDecisionAdapter,
	type MasterOrchestrationToolDependencies,
	type MasterQueueAdapter,
	type MasterWorkerAdapter,
} from "./tools";
import { MasterWorkerObserver } from "./worker-observer";

export interface MasterDoctrine extends MasterDoctrineDocument {}

export interface MasterSessionFactoryAdapters {
	readonly queue: MasterQueueAdapter;
	readonly workers: MasterWorkerAdapter;
	readonly decisions: MasterDecisionAdapter;
	readonly claims: MasterClaimAdapter;
}

export interface MasterSessionFactoryOptions {
	readonly masterName: string;
	readonly cwd: string;
	readonly model: Model;
	readonly authStorage: AuthStorage;
	readonly modelRegistry: ModelRegistry;
	readonly domainStore: MasterDomainStore;
	readonly coordinatorGateway: MasterCoordinatorGateway;
	readonly memory?: MemoryContract;
	readonly doctrine?: MasterDoctrineDocument;
	readonly doctrineProvider?: () => MasterDoctrineDocument | Promise<MasterDoctrineDocument>;
	readonly adapters?: MasterSessionFactoryAdapters;
	readonly sessionManager?: SessionManager;
	/**
	 * The observer that dispatched this master's workers. It must be shared: the
	 * Coordinator turn ids proven by prompt delivery live on that instance, so a
	 * second observer would make `master_worker_observe` unable to read real turns.
	 */
	readonly workerObserver?: MasterWorkerObserver;
}

function sha256(value: string): string {
	return createHash("sha256").update(value, "utf8").digest("hex");
}

function validateDoctrine(value: MasterDoctrineDocument): MasterDoctrineDocument {
	if (typeof value.revision !== "string" || value.revision.trim().length === 0) {
		throw new Error("Master doctrine revision must be non-empty.");
	}
	if (typeof value.content !== "string" || value.content.trim().length === 0) {
		throw new Error("Master doctrine content must be non-empty.");
	}
	if (!/^[0-9a-f]{64}$/.test(value.sha256) || value.sha256 !== sha256(value.content)) {
		throw new Error("Master doctrine sha256 does not match its content.");
	}
	return Object.freeze({ revision: value.revision, content: value.content, sha256: value.sha256 });
}

function doctrinePrompt(doctrine: MasterDoctrineDocument): string {
	return `## Current master doctrine (${doctrine.revision})\n\n${doctrine.content}`;
}

function missingAdapter(name: string): Error {
	return new Error(`Master ${name} adapter was not injected.`);
}

function memoryWithDurableActivity(options: MasterSessionFactoryOptions, memory: MemoryContract): MemoryContract {
	const recordActivity = async (activity: {
		activityId: string;
		operation: "read" | "write";
		scope: "global";
		masterName: string;
		taskId?: string;
		workerSessionId?: string;
		entryIds?: readonly string[];
		summary: string;
		occurredAt: string;
	}): Promise<void> => {
		const recorder = (
			options.domainStore as unknown as { recordMemoryActivity?: (value: typeof activity) => Promise<unknown> }
		).recordMemoryActivity;
		if (typeof recorder !== "function") throw missingAdapter("durable memory activity");
		await recorder.call(options.domainStore, activity);
	};
	return {
		version: memory.version,
		read: async input => {
			const result = await memory.read(input);
			await recordActivity({
				activityId: result.activityId,
				operation: "read",
				scope: "global",
				masterName: input.context.masterName,
				...(input.context.taskId === undefined ? {} : { taskId: input.context.taskId }),
				...(input.context.workerSessionId === undefined ? {} : { workerSessionId: input.context.workerSessionId }),
				entryIds: result.entries.slice(0, 32).map(entry => entry.id),
				summary: `read ${result.entries.length} memory entr${result.entries.length === 1 ? "y" : "ies"}`,
				occurredAt: new Date().toISOString(),
			});
			return result;
		},
		write: async input => {
			const result = await memory.write(input);
			await recordActivity({
				activityId: result.activityId,
				operation: "write",
				scope: "global",
				masterName: input.source.masterName,
				...(input.source.taskId === undefined ? {} : { taskId: input.source.taskId }),
				...(input.source.workerSessionId === undefined ? {} : { workerSessionId: input.source.workerSessionId }),
				entryIds: [result.entryId],
				summary: `write memory entry ${result.entryId}`,
				occurredAt: new Date().toISOString(),
			});
			return result;
		},
		subscribe: listener => memory.subscribe(listener),
	};
}

function promptAccepted(response: Record<string, unknown>): boolean {
	if (["ok", "accepted", "delivered", "queued", "reconciled"].some(key => response[key] === false)) return false;
	return ["turn_id", "turnId", "accepted", "delivered", "queued", "reconciled"].some(
		key => response[key] !== undefined && response[key] !== false,
	);
}

async function followUpThroughObserver(
	options: MasterSessionFactoryOptions,
	input: Parameters<MasterWorkerAdapter["followUp"]>[0],
): Promise<unknown> {
	const store = options.domainStore;
	const pending = await store.recordFollowUpIntent({
		workerSessionId: input.workerSessionId,
		prompt: input.prompt,
		idempotencyKey: input.idempotencyKey,
	});
	const response = await options.coordinatorGateway.sendPrompt({
		session_id: input.workerSessionId,
		prompt: input.prompt,
		idempotency_key: pending.idempotencyKey,
		...(input.queue === true ? { queue: true } : {}),
		...(input.force === true ? { force: true } : {}),
		allow_mutation: true,
	});
	const prompt = await store.reconcileFollowUpIntent({
		workerSessionId: input.workerSessionId,
		idempotencyKey: pending.idempotencyKey,
		proven: promptAccepted(response),
	});
	return { workerSessionId: input.workerSessionId, promptPending: pending, prompt, response };
}

function defaultAdapters(
	options: MasterSessionFactoryOptions,
	observer: MasterWorkerObserver,
): MasterSessionFactoryAdapters {
	const queue: MasterQueueAdapter = options.adapters?.queue ?? {
		list: async () => await options.domainStore.readQueue(),
		enqueue: async input =>
			await options.domainStore.enqueue({
				idempotencyKey: input.idempotencyKey,
				priority: input.priority,
				summary: input.summary,
				workdir: input.workdir ?? undefined,
				taskId: input.taskId,
				source: "master",
			}),
		assign: async input => {
			const result = await observer.dispatchNext({ leaseId: input.leaseId });
			if (result === null) throw new Error("No durable worker lease is available for assignment.");
			return result;
		},
	};
	const workers: MasterWorkerAdapter = options.adapters?.workers ?? {
		create: async input => {
			const result = await observer.createWorker({
				taskId: input.taskId,
				canonicalCwd: input.workdir,
				prompt: input.prompt,
				createIdempotencyKey: input.idempotencyKey,
			});
			if (result === null) throw new Error("No durable worker capacity is available.");
			return result;
		},
		observe: async input =>
			await observer.observeFromCoordinator({
				workerSessionId: input.workerSessionId,
				action: input.action,
			}),
		followUp: async input => await followUpThroughObserver(options, input),
	};
	const decisions: MasterDecisionAdapter = options.adapters?.decisions ?? {
		record: async input => await options.domainStore.recordDecision(input),
		escalate: async input => await options.domainStore.escalate(input),
	};
	const claims: MasterClaimAdapter = options.adapters?.claims ?? {
		request: async input => {
			const authorization = await options.domainStore.getClaimAuthorization(input.authorizationId);
			if (authorization === null) throw new Error("Claim authorization is unknown or forged.");
			return await options.domainStore.consumeClaimAuthorization({
				authorizationId: authorization.authorizationId,
				workerSessionId: authorization.workerSessionId,
				requestedMasterName: authorization.requestedMasterName,
				actorKind: "model",
			});
		},
	};
	return { queue, workers, decisions, claims };
}

function buildToolDependencies(
	options: MasterSessionFactoryOptions,
	memory: MemoryContract,
	observer: MasterWorkerObserver,
): MasterOrchestrationToolDependencies {
	const adapters = defaultAdapters(options, observer);
	return {
		masterName: options.masterName,
		queue: adapters.queue,
		workers: adapters.workers,
		decisions: adapters.decisions,
		claims: adapters.claims,
		memory: memoryWithDurableActivity(options, memory),
	};
}

function validateInjectedSessionManagerProfile(manager: SessionManager, paths: MasterPaths): void {
	if (path.resolve(manager.getSessionDir()) !== path.resolve(paths.sessionDir))
		throw new Error("Injected master session manager is outside the master session destination.");
	const candidate = manager as unknown as {
		getPersistenceProfile?: () => unknown;
		getSessionPersistenceProfile?: () => unknown;
		getStorageProfile?: () => unknown;
		persistenceProfile?: unknown;
		storageProfile?: unknown;
	};
	const profile = (candidate.getPersistenceProfile?.() ??
		candidate.getSessionPersistenceProfile?.() ??
		candidate.getStorageProfile?.() ??
		candidate.persistenceProfile ??
		candidate.storageProfile) as
		| { blobDir?: unknown; residentCacheRootDir?: unknown; terminalBreadcrumbs?: unknown }
		| undefined;
	if (profile === undefined)
		throw new Error("Injected master session manager persistence profile could not be verified.");
	if (
		typeof profile.blobDir !== "string" ||
		typeof profile.residentCacheRootDir !== "string" ||
		profile.terminalBreadcrumbs !== false ||
		path.resolve(profile.blobDir) !== path.resolve(paths.blobDir) ||
		path.resolve(profile.residentCacheRootDir) !== path.resolve(paths.residentCacheDir)
	)
		throw new Error("Injected master session manager persistence profile is outside the master session destination.");
}

export async function createMasterSession(options: MasterSessionFactoryOptions): Promise<CreateAgentSessionResult> {
	if (options.domainStore.masterName !== options.masterName) {
		throw new Error("Master domain store name does not match the requested master session.");
	}
	if (options.modelRegistry.authStorage !== options.authStorage) {
		throw new Error("Master modelRegistry.authStorage must be the injected authStorage instance.");
	}
	const recordReader = (
		options.domainStore as unknown as { readRecord?: () => Promise<{ authorityFingerprint?: string }> }
	).readRecord;
	const record = typeof recordReader === "function" ? await recordReader.call(options.domainStore) : undefined;
	const gatewayAuthority = (options.coordinatorGateway as unknown as { authority?: { fingerprint?: unknown } })
		.authority;
	if (
		record?.authorityFingerprint !== undefined &&
		gatewayAuthority?.fingerprint !== undefined &&
		gatewayAuthority.fingerprint !== record.authorityFingerprint
	)
		throw new Error("Master Coordinator authority fingerprint does not match durable master state.");
	const initialDoctrine = options.doctrine === undefined ? undefined : validateDoctrine(options.doctrine);
	const provider = options.doctrineProvider;
	const resolvedInitialDoctrine =
		initialDoctrine ?? (provider === undefined ? undefined : validateDoctrine(await provider()));
	const doctrineProvider =
		provider === undefined
			? resolvedInitialDoctrine === undefined
				? undefined
				: async () => resolvedInitialDoctrine
			: async () => validateDoctrine(await provider());
	const memory = options.memory ?? createUnavailableMemoryContract("Master memory adapter was not injected.");
	const paths = getMasterPaths(options.masterName, { masterRootDir: options.domainStore.masterRootDir });
	const sessionManager =
		options.sessionManager ??
		SessionManager.create(options.cwd, paths.sessionDir, undefined, {
			persistenceProfile: {
				blobDir: paths.blobDir,
				residentCacheRootDir: paths.residentCacheDir,
				terminalBreadcrumbs: false,
			},
		});
	const ownsSessionManager = options.sessionManager === undefined;
	if (options.sessionManager !== undefined) validateInjectedSessionManagerProfile(sessionManager, paths);
	const settings = Settings.isolated({
		"goal.enabled": false,
		"skills.enabled": false,
		"workspaceTree.mode": "off",
		"tools.discoveryMode": "off",
		"sessionMemory.mode": "off",
		"startup.networkPrewarm": false,
	});
	const doctrineBlocks = resolvedInitialDoctrine === undefined ? [] : [doctrinePrompt(resolvedInitialDoctrine)];
	const eventBus = new EventBus();
	const agentRegistry = new AgentRegistry();
	const observer =
		options.workerObserver ??
		new MasterWorkerObserver({
			masterName: options.masterName,
			domainStore: options.domainStore,
			coordinatorGateway: options.coordinatorGateway,
		});
	const tools = createMasterOrchestrationTools(buildToolDependencies(options, memory, observer));
	const profile: MasterSessionCapabilityProfile = {
		masterName: options.masterName,
		model: options.model,
		modelRegistry: options.modelRegistry,
		authStorage: options.authStorage,
		sessionManager,
		agentRegistry,
		eventBus,
		tools,
		settings,
		systemPrompt: [systemPrompt, ...doctrineBlocks],
		providerSessionId: `master:${options.masterName}:provider`,
		credentialSessionId: `master:${options.masterName}:credential`,
		doctrineProvider,
		initialDoctrineRevision: resolvedInitialDoctrine?.revision,
	};
	try {
		return await createAgentSession({ masterProfile: profile });
	} catch (error) {
		if (ownsSessionManager) await sessionManager.close().catch(() => undefined);
		throw error;
	}
}

export const MasterSessionFactory = { create: createMasterSession } as const;
