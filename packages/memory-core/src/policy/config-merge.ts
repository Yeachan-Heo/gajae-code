import { invalidInput, MEMORY_EXIT_CODES, type MemoryResult } from "../errors";
import type { WriteDestination } from "../index";

export const MEMORY_POLICY_CONFIG_VERSION = 1 as const;

const DESTINATIONS = [
	"global-canonical",
	"project-canonical",
	"session",
	"proposal",
	"checkpoint",
	"ledger",
	"redact-output",
	"export-output",
	"explain-output",
	"doctor-report",
] as const satisfies readonly WriteDestination[];

const SENSITIVITIES = ["public-safe", "private", "restricted"] as const;

export type MemorySensitivity = (typeof SENSITIVITIES)[number];

export interface RetrievalBudgetConfig {
	readonly maxMaps: number;
	readonly maxFiles: number;
	readonly maxSections: number;
	readonly maxChars: number;
}

export interface LedgerPolicyConfig {
	readonly enabled: boolean;
	readonly includeContent: boolean;
}

export interface WritePolicyConfig {
	readonly enabled: boolean;
	readonly requireApproval: boolean;
	readonly allowedDestinations: readonly WriteDestination[];
}

export interface SecurityPolicyConfig {
	readonly pathContainment: boolean;
	readonly secretScan: boolean;
}

export interface PrivacyPolicyConfig {
	readonly maxSensitivity: MemorySensitivity;
}

/** The fully resolved, immutable v1 memory policy. */
export interface MemoryPolicyConfig {
	readonly version: typeof MEMORY_POLICY_CONFIG_VERSION;
	readonly retrieval: RetrievalBudgetConfig;
	readonly ledger: LedgerPolicyConfig;
	readonly write: WritePolicyConfig;
	readonly security: SecurityPolicyConfig;
	readonly privacy: PrivacyPolicyConfig;
}

export type MemoryPolicyLayer = {
	readonly version?: typeof MEMORY_POLICY_CONFIG_VERSION;
	readonly retrieval?: Partial<RetrievalBudgetConfig>;
	readonly ledger?: Partial<LedgerPolicyConfig>;
	readonly write?: Partial<WritePolicyConfig>;
	readonly security?: Partial<SecurityPolicyConfig>;
	readonly privacy?: Partial<PrivacyPolicyConfig>;
};
type MutablePartial<T extends object> = {
	-readonly [Key in keyof T]?: T[Key];
};

const DEFAULT_RETRIEVAL = Object.freeze({
	maxMaps: 4,
	maxFiles: 20,
	maxSections: 8,
	maxChars: 24_000,
} satisfies RetrievalBudgetConfig);

const DEFAULT_LEDGER = Object.freeze({
	enabled: true,
	includeContent: false,
} satisfies LedgerPolicyConfig);

const DEFAULT_WRITE = Object.freeze({
	enabled: true,
	requireApproval: true,
	allowedDestinations: Object.freeze([...DESTINATIONS]),
} satisfies WritePolicyConfig);

const DEFAULT_SECURITY = Object.freeze({
	pathContainment: true,
	secretScan: true,
} satisfies SecurityPolicyConfig);

const DEFAULT_PRIVACY = Object.freeze({
	maxSensitivity: "restricted",
} satisfies PrivacyPolicyConfig);

export const DEFAULT_MEMORY_POLICY_CONFIG: MemoryPolicyConfig = Object.freeze({
	version: MEMORY_POLICY_CONFIG_VERSION,
	retrieval: DEFAULT_RETRIEVAL,
	ledger: DEFAULT_LEDGER,
	write: DEFAULT_WRITE,
	security: DEFAULT_SECURITY,
	privacy: DEFAULT_PRIVACY,
});

const TOP_LEVEL_KEYS = ["version", "retrieval", "ledger", "write", "security", "privacy"] as const;
const RETRIEVAL_KEYS = ["maxMaps", "maxFiles", "maxSections", "maxChars"] as const;
const LEDGER_KEYS = ["enabled", "includeContent"] as const;
const WRITE_KEYS = ["enabled", "requireApproval", "allowedDestinations"] as const;
const SECURITY_KEYS = ["pathContainment", "secretScan"] as const;
const PRIVACY_KEYS = ["maxSensitivity"] as const;
const FORBIDDEN_KEYS = ["override", "allowSensitive", "allowSecrets", "force"] as const;

const SENSITIVITY_RANK: Readonly<Record<MemorySensitivity, number>> = Object.freeze({
	"public-safe": 0,
	private: 1,
	restricted: 2,
});

function policyDenied(reason: string): MemoryResult<never> {
	return {
		ok: false,
		error: {
			code: "policy-denied",
			exitCode: MEMORY_EXIT_CODES.policyDenied,
			destination: "global-canonical",
			reason,
		},
	};
}

function isPlainObject(value: unknown): value is { readonly [key: string]: unknown } {
	if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
	return Object.getPrototypeOf(value) === Object.prototype;
}

function hasDangerousKey(key: string): boolean {
	return key === "__proto__" || key === "prototype" || key === "constructor";
}

function ownKeys(value: object): readonly string[] | null {
	const stringKeys: string[] = [];
	for (const key of Reflect.ownKeys(value)) {
		if (typeof key !== "string" || hasDangerousKey(key)) return null;
		const descriptor = Object.getOwnPropertyDescriptor(value, key);
		if (descriptor === undefined || !Object.hasOwn(descriptor, "value")) return null;
		stringKeys.push(key);
	}
	return stringKeys;
}
function validateObjectKeys(value: object, path: string, allowed: readonly string[]): MemoryResult<true> {
	const keys = ownKeys(value);
	if (keys === null) return invalidInput(`${path} contains a symbol or prototype-polluting key`);
	const forbidden = keys.find(key => (FORBIDDEN_KEYS as readonly string[]).includes(key));
	if (forbidden !== undefined) return policyDenied("memory policy overrides are not supported");
	if (!keys.every(key => allowed.includes(key))) return invalidInput(`${path} contains an unknown key`);
	return { ok: true, value: true };
}

function isSafeArray(value: unknown): value is readonly unknown[] {
	if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) return false;
	const keys = ownKeys(value);
	if (keys === null) return false;
	for (const key of keys) {
		if (key === "length") continue;
		if (!/^(?:0|[1-9][0-9]*)$/.test(key) || Number(key) >= value.length) return false;
	}

	for (let index = 0; index < value.length; index++) {
		if (!Object.hasOwn(value, index)) return false;
	}
	return true;
}

function isLimit(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function parseBoolean(value: unknown, path: string): MemoryResult<boolean> {
	if (typeof value !== "boolean") return invalidInput(`${path} must be a boolean`);
	return { ok: true, value };
}

function parseLimit(value: unknown, path: string): MemoryResult<number> {
	if (!isLimit(value)) return invalidInput(`${path} must be a finite, positive integer`);
	return { ok: true, value };
}

function parseDestinations(value: unknown, path: string): MemoryResult<readonly WriteDestination[]> {
	if (!isSafeArray(value)) return invalidInput(`${path} must be an array`);
	const parsed: WriteDestination[] = [];
	for (let index = 0; index < value.length; index++) {
		const item = value[index];
		if (typeof item !== "string" || !(DESTINATIONS as readonly string[]).includes(item)) {
			return invalidInput(`${path}[${index}] is not a supported write destination`);
		}
		if (parsed.includes(item as WriteDestination)) return invalidInput(`${path} must not contain duplicates`);
		parsed.push(item as WriteDestination);
	}
	return { ok: true, value: Object.freeze(parsed) };
}

function parseSensitivity(value: unknown, path: string): MemoryResult<MemorySensitivity> {
	if (typeof value !== "string" || !(SENSITIVITIES as readonly string[]).includes(value)) {
		return invalidInput(`${path} is not a supported sensitivity`);
	}
	return { ok: true, value: value as MemorySensitivity };
}

function parseSection<T extends object>(
	value: unknown,
	path: string,
	keys: readonly string[],
	parse: (section: { readonly [key: string]: unknown }, path: string) => MemoryResult<T>,
): MemoryResult<T> {
	if (!isPlainObject(value)) return invalidInput(`${path} must be an object`);
	const keyValidation = validateObjectKeys(value, path, keys);
	if (!keyValidation.ok) return keyValidation;
	return parse(value, path);
}

function parseLayer(value: unknown): MemoryResult<MemoryPolicyLayer> {
	if (value === undefined) return { ok: true, value: {} };
	if (!isPlainObject(value)) return invalidInput("memory policy config must be an object");
	const keyValidation = validateObjectKeys(value, "memory policy config", TOP_LEVEL_KEYS);
	if (!keyValidation.ok) return keyValidation;

	const layer: {
		version?: typeof MEMORY_POLICY_CONFIG_VERSION;
		retrieval?: MutablePartial<RetrievalBudgetConfig>;
		ledger?: MutablePartial<LedgerPolicyConfig>;
		write?: MutablePartial<WritePolicyConfig>;
		security?: MutablePartial<SecurityPolicyConfig>;
		privacy?: MutablePartial<PrivacyPolicyConfig>;
	} = {};

	if (Object.hasOwn(value, "version")) {
		if (value.version !== MEMORY_POLICY_CONFIG_VERSION) return invalidInput("memory policy version must be 1");
		layer.version = MEMORY_POLICY_CONFIG_VERSION;
	}

	if (Object.hasOwn(value, "retrieval")) {
		const parsed = parseSection<MutablePartial<RetrievalBudgetConfig>>(
			value.retrieval,
			"retrieval",
			RETRIEVAL_KEYS,
			(section, path) => {
				const output: MutablePartial<RetrievalBudgetConfig> = {};

				for (const key of RETRIEVAL_KEYS) {
					if (!Object.hasOwn(section, key)) continue;
					const limit = parseLimit(section[key], `${path}.${key}`);
					if (!limit.ok) return limit;
					output[key] = limit.value;
				}
				return { ok: true, value: output };
			},
		);
		if (!parsed.ok) return parsed;
		layer.retrieval = parsed.value;
	}

	if (Object.hasOwn(value, "ledger")) {
		const parsed = parseSection<MutablePartial<LedgerPolicyConfig>>(
			value.ledger,
			"ledger",
			LEDGER_KEYS,
			(section, path) => {
				const output: MutablePartial<LedgerPolicyConfig> = {};

				for (const key of LEDGER_KEYS) {
					if (!Object.hasOwn(section, key)) continue;
					const boolean = parseBoolean(section[key], `${path}.${key}`);
					if (!boolean.ok) return boolean;
					output[key] = boolean.value;
				}
				return { ok: true, value: output };
			},
		);
		if (!parsed.ok) return parsed;
		layer.ledger = parsed.value;
	}

	if (Object.hasOwn(value, "write")) {
		const parsed = parseSection<MutablePartial<WritePolicyConfig>>(
			value.write,
			"write",
			WRITE_KEYS,
			(section, path) => {
				const output: MutablePartial<WritePolicyConfig> = {};

				if (Object.hasOwn(section, "enabled")) {
					const enabled = parseBoolean(section.enabled, `${path}.enabled`);
					if (!enabled.ok) return enabled;
					output.enabled = enabled.value;
				}
				if (Object.hasOwn(section, "requireApproval")) {
					const approval = parseBoolean(section.requireApproval, `${path}.requireApproval`);
					if (!approval.ok) return approval;
					output.requireApproval = approval.value;
				}
				if (Object.hasOwn(section, "allowedDestinations")) {
					const destinations = parseDestinations(section.allowedDestinations, `${path}.allowedDestinations`);
					if (!destinations.ok) return destinations;
					output.allowedDestinations = destinations.value;
				}
				return { ok: true, value: output };
			},
		);
		if (!parsed.ok) return parsed;
		layer.write = parsed.value;
	}

	if (Object.hasOwn(value, "security")) {
		const parsed = parseSection<MutablePartial<SecurityPolicyConfig>>(
			value.security,
			"security",
			SECURITY_KEYS,
			(section, path) => {
				const output: MutablePartial<SecurityPolicyConfig> = {};

				for (const key of SECURITY_KEYS) {
					if (!Object.hasOwn(section, key)) continue;
					const enabled = parseBoolean(section[key], `${path}.${key}`);
					if (!enabled.ok) return enabled;
					if (!enabled.value) return policyDenied(`${path}.${key} cannot be disabled`);
					output[key] = true;
				}
				return { ok: true, value: output };
			},
		);
		if (!parsed.ok) return parsed;
		layer.security = parsed.value;
	}

	if (Object.hasOwn(value, "privacy")) {
		const parsed = parseSection<MutablePartial<PrivacyPolicyConfig>>(
			value.privacy,
			"privacy",
			PRIVACY_KEYS,
			(section, path) => {
				const output: MutablePartial<PrivacyPolicyConfig> = {};

				if (Object.hasOwn(section, "maxSensitivity")) {
					const sensitivity = parseSensitivity(section.maxSensitivity, `${path}.maxSensitivity`);
					if (!sensitivity.ok) return sensitivity;
					output.maxSensitivity = sensitivity.value;
				}
				return { ok: true, value: output };
			},
		);
		if (!parsed.ok) return parsed;
		layer.privacy = parsed.value;
	}

	return { ok: true, value: layer };
}

/** Validate one untrusted config layer without reading files or interpreting YAML. */
export function validateMemoryPolicyConfig(value: unknown): MemoryResult<MemoryPolicyLayer> {
	try {
		return parseLayer(value);
	} catch {
		return invalidInput("memory policy validation failed closed");
	}
}

function orderedIntersection(
	base: readonly WriteDestination[],
	requested: readonly WriteDestination[],
): readonly WriteDestination[] {
	const allowed = new Set(requested);
	return Object.freeze(base.filter(destination => allowed.has(destination)));
}

function applyLayer(base: MemoryPolicyConfig, layer: MemoryPolicyLayer): MemoryResult<MemoryPolicyConfig> {
	if (layer.version !== undefined && layer.version !== MEMORY_POLICY_CONFIG_VERSION) {
		return invalidInput("memory policy version must be 1");
	}

	const retrieval = { ...base.retrieval };
	if (layer.retrieval !== undefined) {
		for (const key of RETRIEVAL_KEYS) {
			const value = layer.retrieval[key];
			if (value === undefined) continue;
			if (value > retrieval[key]) return policyDenied(`retrieval.${key} cannot broaden a policy`);
			retrieval[key] = value;
		}
	}

	const ledger = { ...base.ledger };
	if (layer.ledger !== undefined) {
		if (layer.ledger.enabled !== undefined) {
			if (ledger.enabled === false && layer.ledger.enabled)
				return policyDenied("ledger.enabled cannot broaden a policy");
			ledger.enabled = ledger.enabled && layer.ledger.enabled;
		}
		if (layer.ledger.includeContent !== undefined) {
			if (!ledger.includeContent && layer.ledger.includeContent) {
				return policyDenied("ledger.includeContent cannot broaden a policy");
			}
			ledger.includeContent = ledger.includeContent && layer.ledger.includeContent;
		}
	}

	const write = {
		enabled: base.write.enabled,
		requireApproval: base.write.requireApproval,
		allowedDestinations: base.write.allowedDestinations,
	};
	if (layer.write !== undefined) {
		if (layer.write.enabled !== undefined) {
			if (!write.enabled && layer.write.enabled) return policyDenied("write.enabled cannot broaden a policy");
			write.enabled = write.enabled && layer.write.enabled;
		}
		if (layer.write.requireApproval !== undefined) {
			if (write.requireApproval && !layer.write.requireApproval) {
				return policyDenied("write.requireApproval cannot broaden a policy");
			}
			write.requireApproval = write.requireApproval || layer.write.requireApproval;
		}
		if (layer.write.allowedDestinations !== undefined) {
			const requested = layer.write.allowedDestinations;
			if (requested.some(destination => !write.allowedDestinations.includes(destination))) {
				return policyDenied("write.allowedDestinations cannot broaden a policy");
			}
			write.allowedDestinations = orderedIntersection(write.allowedDestinations, requested);
		}
	}

	const privacy = { ...base.privacy };
	const maxSensitivity = layer.privacy?.maxSensitivity;
	if (maxSensitivity !== undefined) {
		if (SENSITIVITY_RANK[maxSensitivity] > SENSITIVITY_RANK[privacy.maxSensitivity]) {
			return policyDenied("privacy.maxSensitivity cannot broaden a policy");
		}
		privacy.maxSensitivity = maxSensitivity;
	}

	return {
		ok: true,
		value: Object.freeze({
			version: MEMORY_POLICY_CONFIG_VERSION,
			retrieval: Object.freeze(retrieval),
			ledger: Object.freeze(ledger),
			write: Object.freeze({
				...write,
				allowedDestinations: Object.freeze([...write.allowedDestinations]),
			}),
			security: DEFAULT_SECURITY,
			privacy: Object.freeze(privacy),
		}),
	};
}

/** Merge global, project, then session layers; every later layer can only narrow. */
export function mergeMemoryPolicyConfigs(
	global: unknown,
	project?: unknown,
	session?: unknown,
): MemoryResult<MemoryPolicyConfig> {
	try {
		let merged: MemoryPolicyConfig = DEFAULT_MEMORY_POLICY_CONFIG;
		for (const [name, value] of [
			["global", global],
			["project", project],
			["session", session],
		] as const) {
			if (value === undefined) continue;
			const parsed = parseLayer(value);
			if (!parsed.ok) return parsed;
			const applied = applyLayer(merged, parsed.value);
			if (!applied.ok) {
				if (applied.error.code === "policy-denied") {
					return policyDenied(`${name} layer: ${applied.error.reason}`);
				}
				return applied;
			}
			merged = applied.value;
		}
		return { ok: true, value: merged };
	} catch {
		return invalidInput("memory policy merge failed closed");
	}
}
