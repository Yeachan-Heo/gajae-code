import { expect, test } from "bun:test";
import { BUILTIN_MODEL_PROFILES } from "../src/config/model-profiles";
import {
	buildWorkModeRoleTuple,
	compareWorkModeFingerprints,
	computeWorkModeFingerprint,
	type DefinitionFact,
	definitionFactFromProfile,
	type FingerprintFact,
	missingFingerprintFact,
	presentFingerprintFact,
	type RoleId,
	type RoleResolutionFact,
	relateWorkModeFingerprints,
	unavailableFingerprintFact,
	type WorkModeFingerprint,
	type WorkModeFingerprintFact,
	type WorkModeFingerprintPayloadV1,
} from "../src/config/work-mode-result";

type RoleFact = FingerprintFact<
	RoleResolutionFact,
	"role_not_configured" | "role_unresolved",
	"role_resolution_unavailable"
>;
type FingerprintInput = Omit<WorkModeFingerprintPayloadV1, "schema">;
type FingerprintSlot = Exclude<keyof FingerprintInput, "confirmation">;
type Presence = "present" | "missing" | "unavailable";

function definitionFact(): DefinitionFact {
	const profile = BUILTIN_MODEL_PROFILES.find(candidate => candidate.name === "codex-eco");
	if (!profile) throw new Error("Missing bundled codex-eco profile");
	const fact = definitionFactFromProfile(profile, "codex-eco");
	if (!fact) throw new Error("Could not derive codex-eco definition fact");
	return fact;
}

function roles(): WorkModeFingerprintPayloadV1["roles"] {
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
			alternativeGroups: [],
		}),
		roles: roles(),
		fallback: presentFingerprintFact({ defaultChain: ["provider/default"], activeIndex: 0, skips: [] }),
		confirmation: { required: false, roleDegradation: [] },
	};
}

function catalogFact(presence: Presence): FingerprintInput["catalog"] {
	if (presence === "present")
		return presentFingerprintFact({
			version: 1,
			modeId: "quick-edit",
			profileId: "codex-eco",
			entryDigest: "catalog-entry-digest",
		});
	if (presence === "missing") return missingFingerprintFact("unknown_work_mode");
	return unavailableFingerprintFact("catalog_source_unavailable");
}

function bundledDefinitionFact(presence: Presence): FingerprintInput["bundledDefinition"] {
	if (presence === "present") return presentFingerprintFact(definitionFact());
	if (presence === "missing") return missingFingerprintFact("curated_profile_missing");
	return unavailableFingerprintFact("builtin_source_unavailable");
}

function effectiveDefinitionFact(presence: Presence): FingerprintInput["effectiveDefinition"] {
	if (presence === "present") return presentFingerprintFact(definitionFact());
	if (presence === "missing") return missingFingerprintFact("curated_profile_mismatch");
	return unavailableFingerprintFact("model_profile_registry_unavailable");
}

function registryResolutionFact(presence: Presence): FingerprintInput["registryResolution"] {
	if (presence === "present")
		return presentFingerprintFact({
			registryRevision: "registry-1",
			resolutionRevision: "resolution-1",
			resolutionDigest: "resolved-default",
		});
	if (presence === "missing") return missingFingerprintFact("not_resolved");
	return unavailableFingerprintFact("model_profile_registry_unavailable");
}

function readinessFact(presence: Presence): FingerprintInput["readiness"] {
	if (presence === "present")
		return presentFingerprintFact({
			strictProviders: [{ providerId: "openai-codex", state: "ready" }],
			alternativeGroups: [],
		});
	if (presence === "missing") return missingFingerprintFact("not_evaluated");
	return unavailableFingerprintFact("provider_readiness_unavailable");
}

function roleFact(presence: Presence, role: RoleId): RoleFact {
	if (presence === "present")
		return presentFingerprintFact({
			role,
			requested: `provider/${role}`,
			resolved: `provider/${role}`,
			effort: "medium",
			state: "resolved",
		});
	if (presence === "missing") return missingFingerprintFact("role_unresolved");
	return unavailableFingerprintFact("role_resolution_unavailable");
}

function fallbackFact(presence: Presence): FingerprintInput["fallback"] {
	if (presence === "present")
		return presentFingerprintFact({ defaultChain: ["provider/default"], activeIndex: 0, skips: [] });
	if (presence === "missing") return missingFingerprintFact("no_default_chain");
	return unavailableFingerprintFact("fallback_resolution_unavailable");
}

function withSlot(input: FingerprintInput, slot: FingerprintSlot, presence: Presence): FingerprintInput {
	switch (slot) {
		case "catalog":
			return { ...input, catalog: catalogFact(presence) };
		case "bundledDefinition":
			return { ...input, bundledDefinition: bundledDefinitionFact(presence) };
		case "effectiveDefinition":
			return { ...input, effectiveDefinition: effectiveDefinitionFact(presence) };
		case "registryResolution":
			return { ...input, registryResolution: registryResolutionFact(presence) };
		case "readiness":
			return { ...input, readiness: readinessFact(presence) };
		case "roles":
			return {
				...input,
				roles: buildWorkModeRoleTuple((index, role) =>
					index === 0 ? roleFact(presence, role) : input.roles[index],
				),
			};
		case "fallback":
			return { ...input, fallback: fallbackFact(presence) };
	}
}

function changedGroups(slot: FingerprintSlot): readonly [WorkModeFingerprintFact, ...WorkModeFingerprintFact[]] {
	switch (slot) {
		case "catalog":
			return ["catalog"];
		case "bundledDefinition":
		case "effectiveDefinition":
			return ["profile_identity", "profile_definition"];
		case "registryResolution":
			return ["registry_resolution"];
		case "readiness":
			return ["provider_readiness"];
		case "roles":
			return ["role_resolution"];
		case "fallback":
			return ["fallback"];
	}
}

test("every tagged slot maps present/missing/unavailable transitions to its fixed changed-fact group", () => {
	const slots: readonly FingerprintSlot[] = [
		"catalog",
		"bundledDefinition",
		"effectiveDefinition",
		"registryResolution",
		"readiness",
		"roles",
		"fallback",
	];
	const presences: readonly Presence[] = ["present", "missing", "unavailable"];
	const input = baseInput();

	for (const slot of slots) {
		for (const leftPresence of presences) {
			for (const rightPresence of presences) {
				if (leftPresence === rightPresence) continue;
				const comparison = compareWorkModeFingerprints(
					computeWorkModeFingerprint(withSlot(input, slot, leftPresence)),
					computeWorkModeFingerprint(withSlot(input, slot, rightPresence)),
				);
				expect(comparison.equal).toBe(false);
				if (comparison.equal) throw new Error(`Expected ${slot} drift to be reported`);
				const changedFacts = comparison.changedFacts;
				if (changedFacts.length === 0) throw new Error(`Expected ${slot} to report at least one changed fact`);
				expect(changedFacts).toEqual(changedGroups(slot));
			}
		}
	}
});

test("equal accepted and observed fingerprints produce equal comparison and relation", () => {
	const accepted = computeWorkModeFingerprint(baseInput());
	const observed = computeWorkModeFingerprint(baseInput());
	const comparison = compareWorkModeFingerprints(accepted, observed);
	const relation = relateWorkModeFingerprints(accepted, observed);

	expect(comparison).toEqual({ equal: true });
	expect(relation.kind).toBe("equal");
	if (relation.kind !== "equal") throw new Error("Expected equal fingerprint relation");
	expect(relation.accepted).toBe(accepted);
	expect(relation.observed).toBe(observed);
});

test("digest-only drift still reports a nonempty safe changed-fact list", () => {
	const accepted = computeWorkModeFingerprint(baseInput());
	const observed: WorkModeFingerprint = { ...accepted, digest: "0".repeat(64) };
	const comparison = compareWorkModeFingerprints(accepted, observed);

	expect(comparison.equal).toBe(false);
	if (comparison.equal) throw new Error("Expected digest drift to be reported");
	if (comparison.changedFacts.length === 0)
		throw new Error("Expected digest drift to report at least one changed fact");
	const expectedFacts: readonly [WorkModeFingerprintFact, ...WorkModeFingerprintFact[]] = ["profile_definition"];
	expect(comparison.changedFacts).toEqual(expectedFacts);
});

test("multiple drifted groups retain the canonical comparison order without duplicates", () => {
	const input = baseInput();
	const observedInput: FingerprintInput = {
		...input,
		catalog: catalogFact("missing"),
		readiness: readinessFact("unavailable"),
		fallback: fallbackFact("missing"),
	};
	const comparison = compareWorkModeFingerprints(
		computeWorkModeFingerprint(input),
		computeWorkModeFingerprint(observedInput),
	);

	expect(comparison.equal).toBe(false);
	if (comparison.equal) throw new Error("Expected multiple fingerprint groups to drift");
	if (comparison.changedFacts.length === 0)
		throw new Error("Expected multiple drifted groups to report changed facts");
	const expectedFacts: readonly [WorkModeFingerprintFact, ...WorkModeFingerprintFact[]] = [
		"catalog",
		"provider_readiness",
		"fallback",
	];
	expect(comparison.changedFacts).toEqual(expectedFacts);
	expect(new Set(comparison.changedFacts).size).toBe(comparison.changedFacts.length);
});

test("an absent observed fingerprint is a typed not-observed relation with its pre-gate reason", () => {
	const accepted = computeWorkModeFingerprint(baseInput());
	const relation = relateWorkModeFingerprints(accepted, undefined, "turn_admission_cancelled");

	expect(relation.kind).toBe("not_observed");
	if (relation.kind !== "not_observed") throw new Error("Expected not-observed fingerprint relation");
	expect(relation.accepted).toBe(accepted);
	expect(relation.reason).toBe("turn_admission_cancelled");
});
