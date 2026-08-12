import { createHash } from "node:crypto";
import {
	compileTaskExecutionPolicy,
	type TaskExecutionPolicy,
	type TaskExecutionPolicyController,
	type TaskExecutionPolicySnapshot,
} from "../task/execution-policy";
import {
	NativeProjectSettingsStoreError,
	type ScopedConfigurationExpectedOwner,
	type ScopedConfigurationMutationReceipt,
	type ScopedConfigurationMutationService,
	type ScopedConfigurationPatch,
	type ScopedConfigurationScope,
	type ScopedConfigurationSnapshot,
	type ScopedConfigurationTiming,
	type ScopedConfigurationValue,
} from "./scoped-configuration-mutation";

function persistentActiveId(snapshot: ScopedConfigurationSnapshot): string | null {
	const execution = snapshot.data.execution;
	if (execution === undefined) return null;
	if (!isRecord(execution)) throw new ExecutionPresetStoreError("invalid_shape");
	const presets = execution.presets;
	if (presets === undefined) return null;
	if (!isRecord(presets)) throw new ExecutionPresetStoreError("invalid_shape");
	const active = presets.active;
	if (active === undefined) return null;
	if (typeof active !== "string" || safeId(active) === undefined) {
		throw new ExecutionPresetStoreError("invalid_shape");
	}
	return active;
}

function expectedOwnerMatchesSnapshot(
	expectedOwner: ScopedConfigurationExpectedOwner | undefined,
	snapshot: ScopedConfigurationSnapshot,
): boolean {
	if (expectedOwner === undefined) return true;
	return (
		(expectedOwner.identity === undefined || expectedOwner.identity === snapshot.ownerIdentity) &&
		(expectedOwner.revision === undefined || expectedOwner.revision === snapshot.revision) &&
		(expectedOwner.digest === undefined || expectedOwner.digest === snapshot.digest)
	);
}

function failedPersistentDelete(
	scope: Exclude<ExecutionPresetScope, "session" | "managed">,
	presetId: string,
	status: "rejected" | "conflict",
	reason: ScopedConfigurationMutationReceipt["reason"],
): ExecutionPresetMutationReceipt {
	return deepFreeze({
		ok: false,
		operation: "delete",
		status,
		scope,
		presetId,
		persisted: false,
		timing: "next_session",
		durability: "none",
		mutationStatus: status,
		mutationReason: reason,
		errorCode: "persistent_write_failed",
	});
}

function persistentFailureReason(error: unknown): ScopedConfigurationMutationReceipt["reason"] {
	return error instanceof NativeProjectSettingsStoreError ? error.code : "scope_rejected";
}

export const EXECUTION_PRESET_MAX_COUNT = 64;
export const EXECUTION_PRESET_ACTIVE_PATH = "execution.presets.active";
export const EXECUTION_PRESET_DEFINITIONS_PATH = "execution.presets.definitions";

export type ExecutionPresetScope = "session" | Exclude<ScopedConfigurationScope, "managed"> | "managed";
export type ExecutionPresetKind = "curated" | "custom";
export type ExecutionPresetChangedField = "isolation" | "toolAccess" | "mcpDiscovery" | "maxDurationMs" | "simpleMode";

export interface ExecutionPreset {
	readonly id: string;
	readonly label: string;
	readonly description: string;
	readonly policy: TaskExecutionPolicy;
	readonly kind: ExecutionPresetKind;
}

export interface ExecutionPresetInput {
	readonly id: string;
	readonly label: string;
	readonly description: string;
	readonly policy: unknown;
}

export interface ExecutionPresetMutationOptions {
	readonly expectedOwner?: ScopedConfigurationExpectedOwner;
	readonly signal?: AbortSignal;
}

export interface ExecutionPresetStoreOptions {
	readonly scope?: ExecutionPresetScope;
	readonly scopedMutationService?: Pick<ScopedConfigurationMutationService, "read" | "mutate">;

	readonly customPresets?: readonly ExecutionPresetInput[];
}

export type ExecutionPresetStoreErrorCode =
	| "invalid_shape"
	| "invalid_id"
	| "invalid_label"
	| "invalid_description"
	| "invalid_policy"
	| "duplicate_id"
	| "duplicate_label"
	| "max_presets"
	| "curated_immutable"
	| "id_immutable"
	| "scope_locked"
	| "writer_unavailable"
	| "persistent_write_failed"
	| "unknown_preset"
	| "cancelled";

const STORE_ERROR_MESSAGES: Readonly<Record<ExecutionPresetStoreErrorCode, string>> = Object.freeze({
	invalid_shape: "Execution preset must contain an id, label, description, and policy.",
	invalid_id: "Execution preset id is invalid.",
	invalid_label: "Execution preset label is invalid.",
	invalid_description: "Execution preset description is invalid.",
	invalid_policy: "Execution preset policy is invalid.",
	duplicate_id: "Execution preset id is already in use.",
	duplicate_label: "Execution preset label is already in use.",
	max_presets: "Execution preset catalog is full.",
	curated_immutable: "Curated execution presets cannot be changed.",
	id_immutable: "Execution preset ids are stable and cannot be renamed.",
	scope_locked: "The selected execution preset scope is managed and cannot be changed.",
	writer_unavailable: "The selected persistent execution preset scope has no writer.",
	persistent_write_failed: "The execution preset persistence operation did not commit.",
	unknown_preset: "Execution preset was not found.",
	cancelled: "The execution preset operation was cancelled before commit.",
});

export class ExecutionPresetStoreError extends Error {
	readonly code: ExecutionPresetStoreErrorCode;

	constructor(code: ExecutionPresetStoreErrorCode) {
		super(STORE_ERROR_MESSAGES[code]);
		this.name = "ExecutionPresetStoreError";
		this.code = code;
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function deepFreeze<T>(value: T): T {
	if (value === null || typeof value !== "object" || Object.isFrozen(value)) return value;
	Object.freeze(value);
	for (const child of Object.values(value)) deepFreeze(child);
	return value;
}

function safeText(value: unknown, minimum: number, maximum: number): string | undefined {
	if (typeof value !== "string") return undefined;
	const trimmed = value.trim();
	if (trimmed.length < minimum || trimmed.length > maximum) return undefined;
	if ([...trimmed].some(character => character.charCodeAt(0) < 0x20 || character.charCodeAt(0) === 0x7f)) {
		return undefined;
	}
	return trimmed;
}

function safeId(value: unknown): string | undefined {
	if (typeof value !== "string" || value.length < 1 || value.length > 64) return undefined;
	if (!/^[a-z0-9][a-z0-9._-]*$/.test(value)) return undefined;
	return value;
}

function normalizedLabel(label: string): string {
	return label.toLocaleLowerCase("en-US");
}

function policyOf(value: unknown): TaskExecutionPolicy {
	const result = compileTaskExecutionPolicy(value);
	if (!result.ok) throw new ExecutionPresetStoreError("invalid_policy");
	return result.policy;
}

function policyDTO(policy: TaskExecutionPolicy): TaskExecutionPolicy {
	return deepFreeze({
		isolation: policy.isolation,
		toolAccess: {
			allow: [...policy.toolAccess.allow],
			deny: [...policy.toolAccess.deny],
		},
		mcpDiscovery: policy.mcpDiscovery,
		maxDurationMs: policy.maxDurationMs,
		simpleMode: policy.simpleMode,
	});
}

function presetDTO(input: unknown, kind: ExecutionPresetKind): ExecutionPreset {
	if (!isRecord(input)) throw new ExecutionPresetStoreError("invalid_shape");
	const id = safeId(input.id);
	if (!id) throw new ExecutionPresetStoreError("invalid_id");
	const label = safeText(input.label, 1, 80);
	if (!label) throw new ExecutionPresetStoreError("invalid_label");
	const description = safeText(input.description, 1, 240);
	if (!description) throw new ExecutionPresetStoreError("invalid_description");
	return deepFreeze({ id, label, description, policy: policyDTO(policyOf(input.policy)), kind });
}

function curatedPreset(id: string, label: string, description: string, policy: TaskExecutionPolicy): ExecutionPreset {
	return presetDTO({ id, label, description, policy }, "curated");
}

const READ_ONLY_REVIEW_POLICY: TaskExecutionPolicy = {
	isolation: "worktree",
	toolAccess: { allow: ["read", "search", "find", "lsp"], deny: ["edit", "write", "bash"] },
	mcpDiscovery: "disabled",
	maxDurationMs: 30 * 60 * 1000,
	simpleMode: true,
};

const FAST_BUILD_POLICY: TaskExecutionPolicy = {
	isolation: "current",
	toolAccess: { allow: [], deny: [] },
	mcpDiscovery: "configured",
	maxDurationMs: 15 * 60 * 1000,
	simpleMode: false,
};

const ISOLATED_AUTONOMY_POLICY: TaskExecutionPolicy = {
	isolation: "worktree",
	toolAccess: { allow: [], deny: [] },
	mcpDiscovery: "configured",
	maxDurationMs: 4 * 60 * 60 * 1000,
	simpleMode: false,
};

export const CURATED_EXECUTION_PRESETS: readonly ExecutionPreset[] = deepFreeze([
	curatedPreset(
		"secure-review",
		"Secure Review",
		"Read-heavy review in an isolated workspace.",
		READ_ONLY_REVIEW_POLICY,
	),
	curatedPreset(
		"fast-build",
		"Fast Build",
		"Unrestricted tools in the current workspace with a short bound.",
		FAST_BUILD_POLICY,
	),
	curatedPreset(
		"isolated-autonomy",
		"Isolated Autonomy",
		"Long-running unrestricted work in an isolated workspace.",
		ISOLATED_AUTONOMY_POLICY,
	),
]);

export const EXECUTION_PRESET_CATALOG = CURATED_EXECUTION_PRESETS;

function clonePreset(preset: ExecutionPreset): ExecutionPreset {
	return deepFreeze({
		id: preset.id,
		label: preset.label,
		description: preset.description,
		policy: policyDTO(preset.policy),
		kind: preset.kind,
	});
}

function serializedPreset(preset: ExecutionPreset): ScopedConfigurationValue {
	return {
		id: preset.id,
		label: preset.label,
		description: preset.description,
		policy: {
			isolation: preset.policy.isolation,
			toolAccess: {
				allow: [...preset.policy.toolAccess.allow],
				deny: [...preset.policy.toolAccess.deny],
			},
			mcpDiscovery: preset.policy.mcpDiscovery,
			maxDurationMs: preset.policy.maxDurationMs,
			simpleMode: preset.policy.simpleMode,
		},
	};
}

function presetFingerprint(preset: ExecutionPreset): string {
	return createHash("sha256")
		.update(JSON.stringify(serializedPreset(preset)), "utf8")
		.digest("hex");
}

function definitionPath(id: string): string {
	return `${EXECUTION_PRESET_DEFINITIONS_PATH}.${id}`;
}

function isDurable(receipt: ScopedConfigurationMutationReceipt): boolean {
	return (
		((receipt.status === "committed" || receipt.status === "applied") && receipt.durability === "committed") ||
		(receipt.status === "degraded" &&
			(receipt.durability === "committed" || receipt.durability === "committed_unconfirmed"))
	);
}

export interface ExecutionPresetMutationReceipt {
	readonly ok: boolean;
	readonly operation: "create" | "rename" | "delete";
	readonly status: "created" | "renamed" | "deleted" | "degraded" | "rejected" | "conflict" | "locked";
	readonly scope: ExecutionPresetScope;
	readonly presetId: string;
	readonly persisted: boolean;
	readonly timing: ScopedConfigurationTiming;
	readonly durability: "none" | "committed" | "committed_unconfirmed";
	readonly mutationStatus: ScopedConfigurationMutationReceipt["status"] | null;
	readonly mutationReason: ScopedConfigurationMutationReceipt["reason"] | null;
	readonly errorCode?: ExecutionPresetStoreErrorCode;
	readonly preset?: ExecutionPreset;
}

function failedMutation(
	operation: ExecutionPresetMutationReceipt["operation"],
	scope: ExecutionPresetScope,
	presetId: string,
	code: ExecutionPresetStoreErrorCode,
): ExecutionPresetMutationReceipt {
	const status = code === "scope_locked" ? "locked" : code === "persistent_write_failed" ? "rejected" : "rejected";
	return deepFreeze({
		ok: false,
		operation,
		status,
		scope,
		presetId,
		persisted: false,
		timing: scope === "session" ? "current_runtime" : "next_session",
		durability: "none",
		mutationStatus: null,
		mutationReason: code === "scope_locked" ? "scope_locked" : null,
		errorCode: code,
	});
}

export class ExecutionPresetStore {
	readonly #scope: ExecutionPresetScope;
	readonly #writer: Pick<ScopedConfigurationMutationService, "read" | "mutate"> | undefined;

	readonly #presets = new Map<string, ExecutionPreset>();
	#revision = 0;

	constructor(options: ExecutionPresetStoreOptions = {}) {
		this.#scope = options.scope ?? "session";
		this.#writer = options.scopedMutationService;
		for (const preset of CURATED_EXECUTION_PRESETS) this.#presets.set(preset.id, preset);
		for (const custom of options.customPresets ?? []) {
			const preset = presetDTO(custom, "custom");
			this.#assertAvailable(preset, undefined);
			this.#presets.set(preset.id, preset);
		}
	}

	get scope(): ExecutionPresetScope {
		return this.#scope;
	}

	get scopedMutationService(): Pick<ScopedConfigurationMutationService, "read" | "mutate"> | undefined {
		return this.#writer;
	}

	get revision(): number {
		return this.#revision;
	}

	get catalog(): readonly ExecutionPreset[] {
		return this.list();
	}

	list(): readonly ExecutionPreset[] {
		return deepFreeze([...this.#presets.values()].map(clonePreset));
	}

	get(id: string): ExecutionPreset | undefined {
		const preset = this.#presets.get(id);
		return preset ? clonePreset(preset) : undefined;
	}

	#assertAvailable(preset: ExecutionPreset, replacingId: string | undefined): void {
		if (this.#presets.size >= EXECUTION_PRESET_MAX_COUNT && !replacingId) {
			throw new ExecutionPresetStoreError("max_presets");
		}
		const existing = this.#presets.get(preset.id);
		if (existing && existing.id !== replacingId) throw new ExecutionPresetStoreError("duplicate_id");
		const label = normalizedLabel(preset.label);
		for (const candidate of this.#presets.values()) {
			if (candidate.id !== replacingId && normalizedLabel(candidate.label) === label) {
				throw new ExecutionPresetStoreError("duplicate_label");
			}
		}
	}

	async #persist(
		patches: readonly ScopedConfigurationPatch[],
		options: ExecutionPresetMutationOptions,
	): Promise<ScopedConfigurationMutationReceipt | undefined> {
		if (this.#scope === "session") return undefined;
		if (this.#scope === "managed") return undefined;
		if (!this.#writer) return undefined;
		return await this.#writer.mutate({ scope: this.#scope, patches, expectedOwner: options.expectedOwner });
	}

	#receipt(
		operation: ExecutionPresetMutationReceipt["operation"],
		presetId: string,
		mutation: ScopedConfigurationMutationReceipt | undefined,
		preset: ExecutionPreset | undefined,
	): ExecutionPresetMutationReceipt {
		if (!mutation) {
			return deepFreeze({
				ok: true,
				operation,
				status: operation === "create" ? "created" : operation === "rename" ? "renamed" : "deleted",
				scope: this.#scope,
				presetId,
				persisted: this.#scope !== "session",
				timing: this.#scope === "session" ? "current_runtime" : "next_session",
				durability: "none",
				mutationStatus: null,
				mutationReason: null,
				...(preset ? { preset: clonePreset(preset) } : {}),
			});
		}
		const durable = isDurable(mutation);
		const status =
			durable && mutation.status === "degraded"
				? "degraded"
				: durable
					? operation === "create"
						? "created"
						: operation === "rename"
							? "renamed"
							: "deleted"
					: mutation.status === "conflict"
						? "conflict"
						: mutation.status === "locked"
							? "locked"
							: "rejected";
		return deepFreeze({
			ok: durable,
			operation,
			status,
			scope: this.#scope,
			presetId,
			persisted: durable,
			timing: mutation.timing,
			durability: mutation.durability,
			mutationStatus: mutation.status,
			mutationReason: mutation.reason,
			...(durable && preset ? { preset: clonePreset(preset) } : {}),
		});
	}

	async createCustom(
		input: ExecutionPresetInput,
		options: ExecutionPresetMutationOptions = {},
	): Promise<ExecutionPresetMutationReceipt> {
		let preset: ExecutionPreset;
		try {
			preset = presetDTO(input, "custom");
			this.#assertAvailable(preset, undefined);
		} catch (error) {
			const code = error instanceof ExecutionPresetStoreError ? error.code : "invalid_shape";
			return failedMutation("create", this.#scope, typeof input.id === "string" ? input.id : "", code);
		}
		if (this.#scope === "managed") return failedMutation("create", this.#scope, preset.id, "scope_locked");
		if (this.#scope !== "session" && !this.#writer)
			return failedMutation("create", this.#scope, preset.id, "writer_unavailable");
		let mutation: ScopedConfigurationMutationReceipt | undefined;
		try {
			mutation = await this.#persist(
				[{ op: "set", path: definitionPath(preset.id), value: serializedPreset(preset) }],
				options,
			);
		} catch {
			return failedMutation("create", this.#scope, preset.id, "persistent_write_failed");
		}
		if (mutation && !isDurable(mutation)) return this.#receipt("create", preset.id, mutation, undefined);
		this.#presets.set(preset.id, preset);
		this.#revision += 1;
		return this.#receipt("create", preset.id, mutation, preset);
	}

	async create(
		input: ExecutionPresetInput,
		options: ExecutionPresetMutationOptions = {},
	): Promise<ExecutionPresetMutationReceipt> {
		return await this.createCustom(input, options);
	}

	async renameCustom(
		id: string,
		input: string | { readonly label: string; readonly description?: string },
		options: ExecutionPresetMutationOptions = {},
	): Promise<ExecutionPresetMutationReceipt> {
		const current = this.#presets.get(id);
		if (!current) return failedMutation("rename", this.#scope, id, "unknown_preset");
		if (current.kind === "curated") return failedMutation("rename", this.#scope, id, "curated_immutable");
		const label = typeof input === "string" ? input : input.label;
		const description = typeof input === "string" ? current.description : (input.description ?? current.description);
		let updated: ExecutionPreset;
		try {
			updated = presetDTO({ id, label, description, policy: current.policy }, "custom");
			this.#assertAvailable(updated, id);
		} catch (error) {
			const code = error instanceof ExecutionPresetStoreError ? error.code : "invalid_shape";
			return failedMutation("rename", this.#scope, id, code);
		}
		if (this.#scope === "managed") return failedMutation("rename", this.#scope, id, "scope_locked");
		if (this.#scope !== "session" && !this.#writer)
			return failedMutation("rename", this.#scope, id, "writer_unavailable");
		let mutation: ScopedConfigurationMutationReceipt | undefined;
		try {
			mutation = await this.#persist(
				[{ op: "set", path: definitionPath(id), value: serializedPreset(updated) }],
				options,
			);
		} catch {
			return failedMutation("rename", this.#scope, id, "persistent_write_failed");
		}
		if (mutation && !isDurable(mutation)) return this.#receipt("rename", id, mutation, undefined);
		this.#presets.set(id, updated);
		this.#revision += 1;
		return this.#receipt("rename", id, mutation, updated);
	}

	async rename(
		id: string,
		input: string | { readonly label: string; readonly description?: string },
		options: ExecutionPresetMutationOptions = {},
	): Promise<ExecutionPresetMutationReceipt> {
		return await this.renameCustom(id, input, options);
	}

	async deleteCustom(
		id: string,
		options: ExecutionPresetMutationOptions = {},
	): Promise<ExecutionPresetMutationReceipt> {
		const current = this.#presets.get(id);
		if (!current) return failedMutation("delete", this.#scope, id, "unknown_preset");
		if (current.kind === "curated") return failedMutation("delete", this.#scope, id, "curated_immutable");
		if (this.#scope === "managed") return failedMutation("delete", this.#scope, id, "scope_locked");
		if (this.#scope !== "session" && !this.#writer)
			return failedMutation("delete", this.#scope, id, "writer_unavailable");

		if (this.#scope === "session") {
			if (options.signal?.aborted) return failedMutation("delete", this.#scope, id, "cancelled");
			this.#presets.delete(id);
			this.#revision += 1;
			return this.#receipt("delete", id, undefined, undefined);
		}

		const writer = this.#writer;
		if (!writer) return failedMutation("delete", this.#scope, id, "writer_unavailable");
		if (options.signal?.aborted) return failedMutation("delete", this.#scope, id, "cancelled");
		let snapshot: ScopedConfigurationSnapshot;
		try {
			snapshot = await writer.read(this.#scope);
		} catch (error) {
			const reason = persistentFailureReason(error);
			return failedPersistentDelete(this.#scope, id, reason === "scope_conflict" ? "conflict" : "rejected", reason);
		}
		if (options.signal?.aborted) return failedMutation("delete", this.#scope, id, "cancelled");
		if (snapshot.scope !== this.#scope) {
			return failedPersistentDelete(this.#scope, id, "rejected", "scope_rejected");
		}
		if (!expectedOwnerMatchesSnapshot(options.expectedOwner, snapshot)) {
			return failedPersistentDelete(this.#scope, id, "conflict", "scope_conflict");
		}

		let activeId: string | null;
		try {
			activeId = persistentActiveId(snapshot);
		} catch {
			return failedPersistentDelete(this.#scope, id, "rejected", "scope_rejected");
		}
		const patches: readonly ScopedConfigurationPatch[] =
			activeId === id
				? [
						{ op: "clear", path: definitionPath(id) },
						{ op: "clear", path: EXECUTION_PRESET_ACTIVE_PATH },
					]
				: [{ op: "clear", path: definitionPath(id) }];
		if (options.signal?.aborted) return failedMutation("delete", this.#scope, id, "cancelled");
		let mutation: ScopedConfigurationMutationReceipt;
		try {
			mutation = await writer.mutate({
				scope: this.#scope,
				patches,
				expectedOwner: {
					identity: snapshot.ownerIdentity,
					revision: snapshot.revision,
					digest: snapshot.digest,
				},
				runtime: {
					phase: "before_commit",
					apply: () => options.signal?.aborted !== true,
				},
				commitGuard: () => options.signal?.aborted !== true,
			});
		} catch {
			return failedMutation("delete", this.#scope, id, "persistent_write_failed");
		}
		if (!isDurable(mutation)) {
			if (options.signal?.aborted && mutation.reason === "runtime_precommit_failed") {
				return failedMutation("delete", this.#scope, id, "cancelled");
			}
			return this.#receipt("delete", id, mutation, undefined);
		}
		this.#presets.delete(id);
		this.#revision += 1;
		return this.#receipt("delete", id, mutation, undefined);
	}

	async delete(id: string, options: ExecutionPresetMutationOptions = {}): Promise<ExecutionPresetMutationReceipt> {
		return await this.deleteCustom(id, options);
	}
}

export type PersistentExecutionPresetConfigurationStatus = "ready" | "absent" | "invalid" | "unavailable" | "conflict";

export type PersistentExecutionPresetConfigurationReason =
	| "invalid_definitions"
	| "invalid_active"
	| "active_not_found"
	| "scope_unavailable"
	| "scope_conflict"
	| null;

export interface PersistentExecutionPresetScopeConfiguration {
	readonly customDefinitions: readonly ExecutionPreset[];
	readonly activeId: string | null;
}

export interface PersistentExecutionPresetConfiguration {
	readonly status: PersistentExecutionPresetConfigurationStatus;
	readonly reason: PersistentExecutionPresetConfigurationReason;
	readonly user: PersistentExecutionPresetScopeConfiguration;
	readonly project: PersistentExecutionPresetScopeConfiguration;
	readonly activePreset: ExecutionPreset | null;
	readonly activePolicy: TaskExecutionPolicy | null;
	readonly sourceScope: Exclude<ExecutionPresetScope, "session" | "managed"> | null;
}

type PersistentScope = Exclude<ExecutionPresetScope, "session" | "managed">;
class PersistentPresetParseError extends Error {
	readonly reason: "invalid_definitions" | "invalid_active";
	readonly configuration: PersistentExecutionPresetScopeConfiguration | undefined;

	constructor(
		reason: "invalid_definitions" | "invalid_active",
		configuration?: PersistentExecutionPresetScopeConfiguration,
	) {
		super("Persistent execution preset configuration is invalid.");
		this.name = "PersistentPresetParseError";
		this.reason = reason;
		this.configuration = configuration;
	}
}

function safeParsePersistentScopeConfiguration(snapshot: ScopedConfigurationSnapshot): {
	readonly configuration: PersistentExecutionPresetScopeConfiguration;
	readonly reason: "invalid_definitions" | "invalid_active" | null;
} {
	try {
		return { configuration: parsePersistentScopeConfiguration(snapshot), reason: null };
	} catch (error) {
		return {
			configuration:
				error instanceof PersistentPresetParseError
					? (error.configuration ?? emptyPersistentScopeConfiguration())
					: emptyPersistentScopeConfiguration(),
			reason: error instanceof PersistentPresetParseError ? error.reason : "invalid_definitions",
		};
	}
}

function emptyPersistentScopeConfiguration(): PersistentExecutionPresetScopeConfiguration {
	return deepFreeze({ customDefinitions: [], activeId: null });
}

function parsePersistentScopeConfiguration(
	snapshot: ScopedConfigurationSnapshot,
): PersistentExecutionPresetScopeConfiguration {
	const execution = snapshot.data.execution;
	if (execution === undefined) return emptyPersistentScopeConfiguration();
	if (!isRecord(execution)) throw new ExecutionPresetStoreError("invalid_shape");
	const presets = execution.presets;
	if (presets === undefined) return emptyPersistentScopeConfiguration();
	if (!isRecord(presets)) throw new ExecutionPresetStoreError("invalid_shape");

	const definitionsValue = presets.definitions;
	const customInputs: ExecutionPresetInput[] = [];
	if (definitionsValue !== undefined) {
		if (!isRecord(definitionsValue)) throw new ExecutionPresetStoreError("invalid_shape");
		if (Object.keys(definitionsValue).length > EXECUTION_PRESET_MAX_COUNT) {
			throw new ExecutionPresetStoreError("max_presets");
		}
		for (const [id, definition] of Object.entries(definitionsValue)) {
			if (!isRecord(definition) || definition.id !== id) {
				throw new ExecutionPresetStoreError("invalid_shape");
			}
			customInputs.push({
				id,
				label: typeof definition.label === "string" ? definition.label : "",
				description: typeof definition.description === "string" ? definition.description : "",
				policy: definition.policy,
			});
		}
	}

	let customDefinitions: readonly ExecutionPreset[] = [];
	if (customInputs.length > 0) {
		const store = new ExecutionPresetStore({ customPresets: customInputs });
		customDefinitions = store.list().filter(preset => preset.kind === "custom");
	}

	const activeValue = presets.active;
	let activeId: string | null = null;
	if (activeValue !== undefined) {
		if (typeof activeValue !== "string" || safeId(activeValue) === undefined) {
			throw new PersistentPresetParseError("invalid_active", deepFreeze({ customDefinitions, activeId: null }));
		}
		activeId = activeValue;
	}
	return deepFreeze({ customDefinitions, activeId });
}

function persistentReadFailure(
	error: unknown,
	scope: PersistentScope,
): "invalid_definitions" | "scope_conflict" | "scope_unavailable" | null {
	if (scope === "project" && isRecord(error) && error.code === "project_scope_unavailable") return null;
	if (!(error instanceof NativeProjectSettingsStoreError)) return "scope_unavailable";
	if (error.code === "scope_conflict") return "scope_conflict";
	if (error.code === "invalid_yaml" || error.code === "invalid_yaml_root") return "invalid_definitions";
	return "scope_unavailable";
}

function persistentConfigurationFailure(
	status: "invalid" | "unavailable" | "conflict",
	reason: Exclude<PersistentExecutionPresetConfigurationReason, null>,
	user: PersistentExecutionPresetScopeConfiguration,
	project: PersistentExecutionPresetScopeConfiguration,
): PersistentExecutionPresetConfiguration {
	return deepFreeze({
		status,
		reason,
		user,
		project,
		activePreset: null,
		activePolicy: null,
		sourceScope: null,
	});
}

/**
 * Read and resolve durable execution preset state without exposing filesystem or
 * parser details. A malformed or unavailable scope never falls back to a lower
 * precedence active selection.
 */
export async function loadPersistentExecutionPresetConfiguration(
	service: Pick<ScopedConfigurationMutationService, "read" | "mutate">,
): Promise<PersistentExecutionPresetConfiguration> {
	const [userRead, projectRead] = await Promise.allSettled([service.read("user"), service.read("project")]);
	const userParsed =
		userRead.status === "fulfilled"
			? safeParsePersistentScopeConfiguration(userRead.value)
			: { configuration: emptyPersistentScopeConfiguration(), reason: null };

	const projectParsed =
		projectRead.status === "fulfilled"
			? safeParsePersistentScopeConfiguration(projectRead.value)
			: { configuration: emptyPersistentScopeConfiguration(), reason: null };
	const parseFailure = userParsed.reason ?? projectParsed.reason;
	if (parseFailure !== null) {
		return persistentConfigurationFailure(
			"invalid",
			parseFailure,
			userParsed.configuration,
			projectParsed.configuration,
		);
	}
	const userFailure = userRead.status === "rejected" ? persistentReadFailure(userRead.reason, "user") : null;
	const projectFailure =
		projectRead.status === "rejected" ? persistentReadFailure(projectRead.reason, "project") : null;
	if (userFailure === "invalid_definitions" || projectFailure === "invalid_definitions") {
		return persistentConfigurationFailure(
			"invalid",
			"invalid_definitions",
			userParsed.configuration,
			projectParsed.configuration,
		);
	}
	if (userFailure !== null || projectFailure !== null) {
		if (projectFailure === "scope_conflict" || userFailure === "scope_conflict") {
			return persistentConfigurationFailure(
				"conflict",
				"scope_conflict",
				userParsed.configuration,
				projectParsed.configuration,
			);
		}
		return persistentConfigurationFailure(
			"unavailable",
			"scope_unavailable",
			userParsed.configuration,
			projectParsed.configuration,
		);
	}

	const user = userParsed.configuration;
	const project = projectParsed.configuration;

	const mergedById = new Map<string, ExecutionPreset>();
	for (const preset of user.customDefinitions) mergedById.set(preset.id, preset);
	for (const preset of project.customDefinitions) mergedById.set(preset.id, preset);
	let catalog: ExecutionPresetStore;
	try {
		catalog = new ExecutionPresetStore({ customPresets: [...mergedById.values()] });
	} catch {
		return persistentConfigurationFailure("conflict", "scope_conflict", user, project);
	}

	const activeId = project.activeId ?? user.activeId;
	const sourceScope: PersistentScope | null =
		project.activeId !== null ? "project" : user.activeId !== null ? "user" : null;
	if (activeId === null) {
		const status = user.customDefinitions.length === 0 && project.customDefinitions.length === 0 ? "absent" : "ready";
		return deepFreeze({
			status,
			reason: null,
			user,
			project,
			activePreset: null,
			activePolicy: null,
			sourceScope: null,
		});
	}
	const activePreset = catalog.get(activeId);
	if (activePreset === undefined) {
		return persistentConfigurationFailure("invalid", "active_not_found", user, project);
	}
	return deepFreeze({
		status: "ready",
		reason: null,
		user,
		project,
		activePreset,
		activePolicy: activePreset.policy,
		sourceScope,
	});
}

export interface ExecutionPresetPreview {
	readonly schema: "execution-preset-preview.v1";
	readonly presetId: string;
	readonly preset: ExecutionPreset;
	readonly scope: ExecutionPresetScope;
	readonly before: TaskExecutionPolicySnapshot;
	readonly after: TaskExecutionPolicySnapshot;
	readonly beforeRevision: number;
	readonly beforeFingerprint: string;
	readonly revision: number;
	readonly fingerprint: string;
	readonly presetFingerprint: string;
	readonly changedFields: readonly ExecutionPresetChangedField[];
	readonly changedLaunchEnforcedFields: readonly ExecutionPresetChangedField[];
	readonly timing: ScopedConfigurationTiming;
	readonly timingExpectation: ScopedConfigurationTiming;
	readonly durability: "none" | "committed";
	readonly durabilityExpectation: "none" | "committed";
	readonly warnings: readonly string[];
	readonly derivedWorkMode: null;
	readonly expectation: Readonly<{
		readonly scope: ExecutionPresetScope;
		readonly timing: ScopedConfigurationTiming;
		readonly durability: "none" | "committed";
	}>;
}

function policyFieldChanges(
	before: TaskExecutionPolicySnapshot["policy"],
	after: TaskExecutionPolicySnapshot["policy"],
): readonly ExecutionPresetChangedField[] {
	const fields: ExecutionPresetChangedField[] = [];
	if (before.isolation !== after.isolation) fields.push("isolation");
	if (
		before.toolAccess.allow.join("\u0000") !== after.toolAccess.allow.join("\u0000") ||
		before.toolAccess.deny.join("\u0000") !== after.toolAccess.deny.join("\u0000")
	)
		fields.push("toolAccess");
	if (before.mcpDiscovery !== after.mcpDiscovery) fields.push("mcpDiscovery");
	if (before.maxDurationMs !== after.maxDurationMs) fields.push("maxDurationMs");
	if (before.simpleMode !== after.simpleMode) fields.push("simpleMode");
	return Object.freeze(fields);
}

function previewFingerprint(
	preset: ExecutionPreset,
	before: TaskExecutionPolicySnapshot,
	after: TaskExecutionPolicySnapshot,
	scope: ExecutionPresetScope,
): string {
	return createHash("sha256")
		.update(
			JSON.stringify({
				schema: "execution-preset-preview.v1",
				presetId: preset.id,
				presetFingerprint: presetFingerprint(preset),
				beforeRevision: before.revision,
				beforeFingerprint: before.fingerprint,
				afterFingerprint: after.fingerprint,
				scope,
			}),
			"utf8",
		)
		.digest("hex");
}

function previewWarnings(policy: TaskExecutionPolicy): readonly string[] {
	const warnings: string[] = [];
	if (policy.isolation === "worktree") warnings.push("Worktree isolation requires an owned workspace.");
	if (policy.mcpDiscovery === "disabled") warnings.push("MCP discovery is disabled for this preset.");
	if (policy.toolAccess.deny.length > 0) warnings.push(`Denied tools: ${policy.toolAccess.deny.join(", ")}.`);
	if (policy.maxDurationMs !== null)
		warnings.push(`Launch timeout: ${Math.round(policy.maxDurationMs / 60000)} minutes.`);
	return Object.freeze(warnings);
}

export function previewExecutionPreset(
	store: ExecutionPresetStore,
	id: string,
	controller: TaskExecutionPolicyController,
	scope: ExecutionPresetScope = store.scope,
): ExecutionPresetPreview {
	const preset = store.get(id);
	if (!preset) throw new ExecutionPresetStoreError("unknown_preset");
	const before = controller.getSnapshot();
	const applied = controller.previewApply(preset.policy);
	if (!applied.ok) throw new ExecutionPresetStoreError("invalid_policy");
	const after = applied.snapshot;
	const changedFields = policyFieldChanges(before.policy, after.policy);
	const timing = scope === "managed" ? "next_session" : "current_runtime";
	const durability = scope === "session" || scope === "managed" ? "none" : "committed";
	const fingerprint = previewFingerprint(preset, before, after, scope);
	return deepFreeze({
		schema: "execution-preset-preview.v1",
		presetId: preset.id,
		preset: clonePreset(preset),
		scope,
		before,
		after,
		beforeRevision: before.revision,
		beforeFingerprint: before.fingerprint,
		revision: before.revision,
		fingerprint,
		presetFingerprint: presetFingerprint(preset),
		changedFields,
		changedLaunchEnforcedFields: changedFields,
		timing,
		timingExpectation: timing,
		durability,
		durabilityExpectation: durability,
		warnings: previewWarnings(after.policy),
		derivedWorkMode: null,
		expectation: { scope, timing, durability },
	});
}

export interface ExecutionPresetApplyOptions {
	readonly preview?: ExecutionPresetPreview;
	readonly scope?: ExecutionPresetScope;
	readonly expectedOwner?: ScopedConfigurationExpectedOwner;
	readonly signal?: AbortSignal;
}

export interface ExecutionPresetApplyReceipt {
	readonly ok: boolean;
	readonly presetId: string;
	readonly scope: ExecutionPresetScope;
	readonly status: "applied" | "committed" | "degraded" | "rejected" | "conflict" | "locked";
	readonly reason: string | null;
	readonly mutationReceipt: ScopedConfigurationMutationReceipt | null;
	readonly controllerRevision: number;
	readonly controllerFingerprint: string;
	readonly timing: ScopedConfigurationTiming;
	readonly durability: "none" | "committed" | "committed_unconfirmed";
}

function staleApply(
	presetId: string,
	scope: ExecutionPresetScope,
	controller: TaskExecutionPolicyController,
	reason = "preview_stale",
): ExecutionPresetApplyReceipt {
	const snapshot = controller.getSnapshot();
	return deepFreeze({
		ok: false,
		presetId,
		scope,
		status: "rejected",
		reason,
		mutationReceipt: null,
		controllerRevision: snapshot.revision,
		controllerFingerprint: snapshot.fingerprint,
		timing: scope === "managed" ? "next_session" : "current_runtime",
		durability: "none",
	});
}

function isPreview(
	value: string | ExecutionPresetPreview | ExecutionPresetApplyOptions | undefined,
): value is ExecutionPresetPreview {
	return (
		typeof value !== "string" &&
		value !== undefined &&
		"schema" in value &&
		value.schema === "execution-preset-preview.v1"
	);
}

function durableStatus(receipt: ScopedConfigurationMutationReceipt): boolean {
	return isDurable(receipt);
}

type PersistentApplyStatus = "applied" | "committed" | "degraded" | "rejected" | "conflict" | "locked";

function postCommitDegraded(
	presetId: string,
	scope: ExecutionPresetScope,
	controller: TaskExecutionPolicyController,
	mutation: ScopedConfigurationMutationReceipt,
): ExecutionPresetApplyReceipt {
	const snapshot = controller.getSnapshot();
	return deepFreeze({
		ok: false,
		presetId,
		scope,
		status: "degraded",
		reason: "runtime_postcommit_failed",
		mutationReceipt: mutation,
		controllerRevision: snapshot.revision,
		controllerFingerprint: snapshot.fingerprint,
		timing: mutation.timing,
		durability: mutation.durability,
	});
}

function applyStatusForMutation(mutation: ScopedConfigurationMutationReceipt): PersistentApplyStatus {
	if (mutation.status === "conflict") return "conflict";
	if (mutation.status === "locked") return "locked";
	if (!durableStatus(mutation)) return "rejected";
	if (mutation.status === "degraded") return "degraded";
	return mutation.status === "committed" ? "committed" : "applied";
}

export async function applyExecutionPreset(
	store: ExecutionPresetStore,
	presetOrPreview: string | ExecutionPresetPreview,
	controller: TaskExecutionPolicyController,
	scopeOrOptions: ExecutionPresetScope | ExecutionPresetApplyOptions = store.scope,
	acceptedPreview?: ExecutionPresetPreview,
): Promise<ExecutionPresetApplyReceipt> {
	const scope =
		typeof scopeOrOptions === "string"
			? scopeOrOptions
			: (scopeOrOptions.scope ??
				scopeOrOptions.preview?.scope ??
				(isPreview(presetOrPreview) ? presetOrPreview.scope : store.scope));
	const options: ExecutionPresetApplyOptions =
		typeof scopeOrOptions === "string" ? { preview: acceptedPreview } : scopeOrOptions;
	const presetId = isPreview(presetOrPreview) ? presetOrPreview.presetId : presetOrPreview;
	if (options.signal?.aborted) return staleApply(presetId, scope, controller, "cancelled");
	const preview = isPreview(presetOrPreview)
		? presetOrPreview
		: (options.preview ?? previewExecutionPreset(store, presetOrPreview, controller, scope));
	if (preview.presetId !== presetId || preview.scope !== scope) return staleApply(presetId, scope, controller);
	const preset = store.get(presetId);
	if (!preset || presetFingerprint(preset) !== preview.presetFingerprint)
		return staleApply(presetId, scope, controller);
	const before = controller.getSnapshot();
	if (before.revision !== preview.beforeRevision || before.fingerprint !== preview.beforeFingerprint)
		return staleApply(presetId, scope, controller);
	if (preview.fingerprint !== previewFingerprint(preset, before, preview.after, scope))
		return staleApply(presetId, scope, controller);
	if (options.signal?.aborted) return staleApply(presetId, scope, controller, "cancelled");
	if (scope === "managed") {
		return deepFreeze({
			...staleApply(presetId, scope, controller, "scope_locked"),
			status: "locked",
			reason: "scope_locked",
		});
	}
	if (scope === "session") {
		const applied = controller.tryApply(preset.policy);
		if (!applied.ok) return staleApply(presetId, scope, controller, "invalid_policy");
		return deepFreeze({
			ok: true,
			presetId,
			scope,
			status: "applied",
			reason: null,
			mutationReceipt: null,
			controllerRevision: applied.snapshot.revision,
			controllerFingerprint: applied.snapshot.fingerprint,
			timing: "current_runtime",
			durability: "none",
		});
	}
	const writer = store.scopedMutationService;
	if (!writer) return staleApply(presetId, scope, controller, "writer_unavailable");
	let mutation: ScopedConfigurationMutationReceipt;
	if (options.signal?.aborted) return staleApply(presetId, scope, controller, "cancelled");
	try {
		mutation = await writer.mutate({
			scope,
			patches: [{ op: "set", path: EXECUTION_PRESET_ACTIVE_PATH, value: presetId }],
			expectedOwner: options.expectedOwner,
			runtime: {
				phase: "before_commit",
				apply: () => options.signal?.aborted !== true,
			},
			commitGuard: () => options.signal?.aborted !== true,
		});
	} catch {
		return staleApply(presetId, scope, controller, "persistent_write_failed");
	}
	const durable = durableStatus(mutation);
	if (!durable) {
		if (options.signal?.aborted && mutation.reason === "runtime_precommit_failed") {
			return staleApply(presetId, scope, controller, "cancelled");
		}
		const snapshot = controller.getSnapshot();
		return deepFreeze({
			ok: false,
			presetId,
			scope,
			status: applyStatusForMutation(mutation),
			reason: mutation.reason,
			mutationReceipt: mutation,
			controllerRevision: snapshot.revision,
			controllerFingerprint: snapshot.fingerprint,
			timing: mutation.timing,
			durability: mutation.durability,
		});
	}
	if (options.signal?.aborted) return postCommitDegraded(presetId, scope, controller, mutation);
	const current = controller.getSnapshot();
	if (current.revision !== preview.beforeRevision || current.fingerprint !== preview.beforeFingerprint) {
		return postCommitDegraded(presetId, scope, controller, mutation);
	}
	const applied = controller.tryApply(preset.policy);
	if (!applied.ok) return postCommitDegraded(presetId, scope, controller, mutation);
	const status = applyStatusForMutation(mutation);
	const successful =
		mutation.status !== "degraded" ||
		mutation.reason === "persistent_reload_mismatch" ||
		mutation.reason === "persistent_reload_unconfirmed";
	return deepFreeze({
		ok: successful,
		presetId,
		scope,
		status,
		reason: successful ? mutation.reason : (mutation.reason ?? "runtime_postcommit_failed"),
		mutationReceipt: mutation,
		controllerRevision: applied.snapshot.revision,
		controllerFingerprint: applied.snapshot.fingerprint,
		timing: "current_runtime",
		durability: mutation.durability,
	});
}

export interface ExecutionPresetClearOptions {
	readonly expectedOwner?: ScopedConfigurationExpectedOwner;
	readonly expectedRevision?: number;
	readonly expectedFingerprint?: string;
}

export async function clearExecutionPreset(
	store: ExecutionPresetStore,
	controller: TaskExecutionPolicyController,
	scope: ExecutionPresetScope = store.scope,
	options: ExecutionPresetClearOptions = {},
): Promise<ExecutionPresetApplyReceipt> {
	const before = controller.getSnapshot();
	if (
		(options.expectedRevision !== undefined && options.expectedRevision !== before.revision) ||
		(options.expectedFingerprint !== undefined && options.expectedFingerprint !== before.fingerprint)
	) {
		return staleApply("", scope, controller);
	}
	if (scope === "managed") return staleApply("", scope, controller, "scope_locked");
	if (scope === "session") {
		const next = controller.clear();
		return deepFreeze({
			ok: true,
			presetId: "",
			scope,
			status: "applied",
			reason: null,
			mutationReceipt: null,
			controllerRevision: next.revision,
			controllerFingerprint: next.fingerprint,
			timing: "current_runtime",
			durability: "none",
		});
	}
	const writer = store.scopedMutationService;
	if (!writer) return staleApply("", scope, controller, "writer_unavailable");
	let runtimeCalled = false;
	let appliedSnapshot: TaskExecutionPolicySnapshot | undefined;
	let mutation: ScopedConfigurationMutationReceipt;
	try {
		mutation = await writer.mutate({
			scope,
			patches: [{ op: "clear", path: EXECUTION_PRESET_ACTIVE_PATH }],
			expectedOwner: options.expectedOwner,
			runtime: {
				phase: "after_commit",
				apply: () => {
					runtimeCalled = true;
					const current = controller.getSnapshot();
					if (current.revision !== before.revision || current.fingerprint !== before.fingerprint) return false;
					appliedSnapshot = controller.clear();
					return true;
				},
			},
		});
	} catch {
		return staleApply("", scope, controller, "persistent_write_failed");
	}
	const snapshot = controller.getSnapshot();
	const successful = durableStatus(mutation) && runtimeCalled && appliedSnapshot !== undefined;
	const status =
		mutation.status === "conflict"
			? "conflict"
			: mutation.status === "locked"
				? "locked"
				: durableStatus(mutation)
					? mutation.status === "degraded" || !runtimeCalled || appliedSnapshot === undefined
						? "degraded"
						: mutation.status === "committed"
							? "committed"
							: "applied"
					: "rejected";
	return deepFreeze({
		ok: successful,
		presetId: "",
		scope,
		status,
		reason: successful ? mutation.reason : durableStatus(mutation) ? "runtime_postcommit_failed" : mutation.reason,
		mutationReceipt: mutation,
		controllerRevision: snapshot.revision,
		controllerFingerprint: snapshot.fingerprint,
		timing: mutation.timing,
		durability: mutation.durability,
	});
}
