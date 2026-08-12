import { expect, test } from "bun:test";
import { BUILTIN_MODEL_PROFILES, type ModelProfileDefinition } from "../src/config/model-profiles";
import {
	buildWorkModeRoleTuple,
	computeWorkModeFingerprint,
	type DefinitionFact,
	definitionFactFromProfile,
	type FingerprintFact,
	presentFingerprintFact,
	type RoleId,
	type RoleResolutionFact,
	type WorkModeFingerprintPayloadV1,
} from "../src/config/work-mode-result";

type RoleFact = FingerprintFact<
	RoleResolutionFact,
	"role_not_configured" | "role_unresolved",
	"role_resolution_unavailable"
>;
type FingerprintInput = Omit<WorkModeFingerprintPayloadV1, "schema">;

function definitionFact(profileName = "codex-eco"): DefinitionFact {
	const profile = BUILTIN_MODEL_PROFILES.find(candidate => candidate.name === profileName);
	if (!profile) throw new Error(`Missing bundled profile ${profileName}`);
	const fact = definitionFactFromProfile(profile, profileName);
	if (!fact) throw new Error(`Could not derive definition fact for ${profileName}`);
	return fact;
}

function roleFacts(): WorkModeFingerprintPayloadV1["roles"] {
	return buildWorkModeRoleTuple(
		(_index, role): RoleFact =>
			presentFingerprintFact({
				role,
				requested: `provider/${role}`,
				resolved: `provider/${role}`,
				effort: "medium",
				state: "resolved",
			}),
	);
}

function baseInput(): FingerprintInput {
	const fact = definitionFact();
	return {
		catalog: presentFingerprintFact({
			version: 1,
			modeId: "quick-edit",
			profileId: "codex-eco",
			entryDigest: "catalog-entry-digest",
		}),
		bundledDefinition: presentFingerprintFact(fact),
		effectiveDefinition: presentFingerprintFact(fact),
		registryResolution: presentFingerprintFact({
			registryRevision: "registry-1",
			resolutionRevision: "resolution-1",
			resolutionDigest: "resolved-default",
		}),
		readiness: presentFingerprintFact({
			strictProviders: [{ providerId: "openai-codex", state: "ready" }],
			alternativeGroups: [
				{ providerIds: ["provider-b", "provider-a"], state: "ready", selectedProviderId: "provider-a" },
			],
		}),
		roles: roleFacts(),
		fallback: presentFingerprintFact({
			defaultChain: ["provider/default"],
			activeIndex: 0,
			skips: [],
		}),
		confirmation: { required: false, roleDegradation: [] },
	};
}

test("fingerprint payload has the complete fixed set of tagged slots and five ordered roles", () => {
	const fingerprint = computeWorkModeFingerprint(baseInput());
	const payload = fingerprint.payload;
	const taggedSlots = [
		payload.catalog,
		payload.bundledDefinition,
		payload.effectiveDefinition,
		payload.registryResolution,
		payload.readiness,
		...payload.roles,
		payload.fallback,
	];

	expect(Object.keys(payload)).toEqual([
		"schema",
		"catalog",
		"bundledDefinition",
		"effectiveDefinition",
		"registryResolution",
		"readiness",
		"roles",
		"fallback",
		"confirmation",
	]);
	expect(taggedSlots).toHaveLength(11);
	expect(taggedSlots.every(slot => "presence" in slot)).toBe(true);
	expect(payload.roles).toHaveLength(5);
	expect(payload.roles.map(slot => (slot.presence === "present" ? slot.value.role : slot.reason))).toEqual([
		"default",
		"executor",
		"planner",
		"critic",
		"architect",
	]);
});

test("definition facts canonicalize fixed role order and provider/group members", () => {
	const left: ModelProfileDefinition = {
		name: "canonical-fixture",
		requiredProviders: ["provider-b", "provider-a"],
		alternativeProviderGroups: [
			["provider-b", "provider-a"],
			["provider-d", "provider-c"],
		],
		modelMapping: {
			architect: "provider-a/architect",
			default: "provider-a/default",
		},
		source: "builtin",
	};
	const reordered: ModelProfileDefinition = {
		name: "canonical-fixture",
		requiredProviders: ["provider-a", "provider-b"],
		alternativeProviderGroups: [
			["provider-a", "provider-b"],
			["provider-c", "provider-d"],
		],
		modelMapping: {
			default: "provider-a/default",
			architect: "provider-a/architect",
		},
		source: "builtin",
	};
	const leftFact = definitionFactFromProfile(left, "canonical-fixture");
	const reorderedFact = definitionFactFromProfile(reordered, "canonical-fixture");
	if (!leftFact || !reorderedFact) throw new Error("Expected canonical definition facts");

	expect(leftFact.requiredProviders).toEqual(["provider-a", "provider-b"]);
	expect(leftFact.alternativeProviderGroups).toEqual([
		["provider-a", "provider-b"],
		["provider-c", "provider-d"],
	]);
	expect(leftFact.modelMapping).toEqual({
		default: "provider-a/default",
		executor: null,
		planner: null,
		critic: null,
		architect: "provider-a/architect",
	});
	expect(leftFact).toEqual(reorderedFact);
});

test("role and confirmation permutations produce one stable fingerprint", () => {
	const input: FingerprintInput = {
		...baseInput(),
		confirmation: { required: false, roleDegradation: ["executor", "planner"] },
	};
	const permutedRoles = buildWorkModeRoleTuple((index, _role): RoleFact => input.roles[4 - index]);
	const roleDegradation: Array<Exclude<RoleId, "default">> = ["planner", "executor", "planner"];
	const permuted: FingerprintInput = {
		...input,
		roles: permutedRoles,
		confirmation: { required: false, roleDegradation },
	};
	const originalFingerprint = computeWorkModeFingerprint(input);
	const permutedFingerprint = computeWorkModeFingerprint(permuted);

	expect(permutedFingerprint.digest).toBe(originalFingerprint.digest);
	expect(permutedFingerprint.payload).toEqual(originalFingerprint.payload);
});

test("unknown secret, raw-error, path, and clock fields cannot affect the fingerprint", () => {
	const input = baseInput();
	const noisyInput = {
		...input,
		secret: "sk-live-must-not-enter-fingerprint",
		rawError: { message: "provider raw response", stack: "/private/raw/path" },
		path: "/private/session/transcript.jsonl",
		startedAt: 100,
		finishedAt: 200,
		clock: "wall-clock",
	};
	const clean = computeWorkModeFingerprint(input);
	const noisy = computeWorkModeFingerprint(noisyInput);

	expect(noisy.digest).toBe(clean.digest);
	expect(noisy.payload).toEqual(clean.payload);
});

test("definition facts expose only safe canonical fields", () => {
	const fact = definitionFact();
	expect(Object.keys(fact).sort()).toEqual([
		"alternativeProviderGroups",
		"definitionDigest",
		"modelMapping",
		"profileId",
		"requiredProviders",
		"source",
	]);
	expect(JSON.stringify(fact)).not.toContain("secret");
	expect(JSON.stringify(fact)).not.toContain("/private/");
});
