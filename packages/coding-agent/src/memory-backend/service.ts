import type { Settings } from "../config/settings";
import { createLazyService, type LazyService } from "../runtime/lazy-service";
import { offBackend } from "./off-backend";
import { resolveMemoryBackendId } from "./resolve";
import type { MemoryBackend, MemoryBackendId } from "./types";

type ResidentMemoryBackendIdentity = Readonly<{
	id: MemoryBackendId;
	/** Local memory startup reads this policy once and keeps it launch-bound. */
	localPolicy?: string;
}>;

// A service's resident identity is captured at the moment its initializer picks
// a backend. Keeping this out of Settings prevents a later settings mutation
// from masquerading as the backend that is already resident in the session.
const residentIdentityByService = new WeakMap<LazyService<MemoryBackend>, ResidentMemoryBackendIdentity>();

/** Canonicalize the settings group so policy comparison is independent of key order. */
function canonicalMemoryPolicy(settings: Settings): string {
	return canonicalizePolicy(settings.getGroup("memories"));
}

function canonicalizePolicy(value: unknown): string {
	if (value === undefined) return "undefined";
	if (value === null || typeof value !== "object") return JSON.stringify(value);
	if (Array.isArray(value)) return `[${value.map(canonicalizePolicy).join(",")}]`;
	const record = value as Record<string, unknown>;
	return `{${Object.keys(record)
		.sort()
		.map(key => `${JSON.stringify(key)}:${canonicalizePolicy(record[key])}`)
		.join(",")}}`;
}

/** Resolve the effective Hindsight and legacy memory policy without loading the backend. */
function canonicalHindsightPolicy(settings: Settings): string {
	return canonicalizePolicy({
		memories: settings.getGroup("memories"),
		hindsight: {
			apiUrl: settings.get("hindsight.apiUrl"),
			apiToken: settings.get("hindsight.apiToken"),
			bankId: settings.get("hindsight.bankId"),
			bankIdPrefix: settings.get("hindsight.bankIdPrefix"),
			scoping: settings.get("hindsight.scoping"),
			bankMission: settings.get("hindsight.bankMission"),
			retainMission: settings.get("hindsight.retainMission"),
			autoRecall: settings.get("hindsight.autoRecall"),
			autoRetain: settings.get("hindsight.autoRetain"),
			retainMode: settings.get("hindsight.retainMode"),
			retainEveryNTurns: settings.get("hindsight.retainEveryNTurns"),
			retainOverlapTurns: settings.get("hindsight.retainOverlapTurns"),
			retainContext: settings.get("hindsight.retainContext"),
			recallBudget: settings.get("hindsight.recallBudget"),
			recallMaxTokens: settings.get("hindsight.recallMaxTokens"),
			recallContextTurns: settings.get("hindsight.recallContextTurns"),
			recallMaxQueryChars: settings.get("hindsight.recallMaxQueryChars"),
			recallTypes: settings.get("hindsight.recallTypes"),
			debug: settings.get("hindsight.debug"),
			mentalModelsEnabled: settings.get("hindsight.mentalModelsEnabled"),
			mentalModelAutoSeed: settings.get("hindsight.mentalModelAutoSeed"),
			mentalModelRefreshIntervalMs: settings.get("hindsight.mentalModelRefreshIntervalMs"),
			mentalModelMaxRenderChars: settings.get("hindsight.mentalModelMaxRenderChars"),
		},
	});
}

/**
 * Return a refusal reason when a cwd rescope would leave the resident memory
 * service or its backend state bound to the launch scope.
 *
 * The lazy service captures its resident backend identity, while Hindsight
 * state captures both its resolved config and bank scope. Compare that identity
 * before publication instead of allowing a move to report success with stale
 * memory authority. A `undefined` result means the move is memory-safe.
 */
export async function getMemoryBackendRescopeError(
	settings: Settings,
	targetSettings: Settings,
	memoryBackend: LazyService<MemoryBackend>,
): Promise<Error | undefined> {
	const resident = residentIdentityByService.get(memoryBackend);
	const residentBackend = memoryBackend.peek();
	const residentBackendId = resident?.id ?? residentBackend?.id;
	const serviceState = memoryBackend.status().state;
	if (!residentBackendId && serviceState !== "idle") {
		return new Error(
			`Refusing to rescope before publication: resident memory backend identity is unavailable; restart the session at the target cwd.`,
		);
	}
	const sourceId = residentBackendId ?? resolveMemoryBackendId(settings);
	const targetId = resolveMemoryBackendId(targetSettings);
	if (sourceId === "hindsight") {
		const isGenuinelyIdle = serviceState === "idle" && resident === undefined && residentBackend === undefined;
		if (isGenuinelyIdle) {
			if (sourceId !== targetId) {
				return new Error(
					`Refusing to rescope before publication: memory backend would change from "${sourceId}" to "${targetId}"; restart the session at the target cwd to apply the target policy.`,
				);
			}
			const sourcePolicy = canonicalHindsightPolicy(settings);
			const targetPolicy = canonicalHindsightPolicy(targetSettings);
			if (sourcePolicy === targetPolicy) return undefined;
			return new Error(
				`Refusing to rescope before publication: Hindsight memory policy is launch-bound and differs at target cwd; restart the session at the target cwd to apply the target policy.`,
			);
		}
		// Hindsight state owns a client, resolved config, bank scope, and a
		// retain queue. Rebinding those pieces before publication would require
		// draining and recreating state with no safe ownership handoff, so fail
		// closed for every Hindsight move rather than mislabeling queued facts.
		return new Error(
			`Refusing to rescope before publication: Hindsight bank scope and queued retains are launch-bound and cannot be rebound safely; restart the session at the target cwd.`,
		);
	}
	if (sourceId !== targetId) {
		return new Error(
			`Refusing to rescope before publication: memory backend would change from "${sourceId}" to "${targetId}"; restart the session at the target cwd to apply the target policy.`,
		);
	}

	switch (sourceId) {
		case "off":
			return undefined;
		case "local": {
			if (!resident?.localPolicy) {
				return new Error(
					`Refusing to rescope before publication: local memory backend identity is unavailable for this resident service; restart the session at the target cwd.`,
				);
			}
			const sourcePolicy = resident.localPolicy;
			const targetPolicy = canonicalMemoryPolicy(targetSettings);
			if (sourcePolicy === targetPolicy) return undefined;
			return new Error(
				`Refusing to rescope before publication: local memory policy is launch-bound and differs at target cwd; restart the session at the target cwd to apply the target policy.`,
			);
		}
	}
}

/**
 * Build the lazy runtime service for the selected memory backend.
 *
 * The identity resolver is deliberately config-only. Backend implementations
 * enter the module graph only when this service is first activated, and the
 * resident no-op backend keeps `memory.backend=off` import-free.
 */
export function createMemoryBackendService(settings: Settings): LazyService<MemoryBackend> {
	let service: LazyService<MemoryBackend>;
	service = createLazyService({
		id: "memory.backend",
		enabled: () => true,
		initialize: async () => {
			const id = resolveMemoryBackendId(settings);
			residentIdentityByService.set(
				service!,
				Object.freeze({
					id,
					...(id === "local" ? { localPolicy: canonicalMemoryPolicy(settings) } : {}),
				}),
			);
			switch (id) {
				case "off":
					return { value: offBackend };
				case "local": {
					const { localBackend } = await import("./local-backend");
					return { value: localBackend };
				}
				case "hindsight": {
					const { hindsightBackend } = await import("../hindsight");
					return { value: hindsightBackend };
				}
			}
		},
	});
	return service;
}
