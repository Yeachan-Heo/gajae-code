import { describe, expect, it } from "bun:test";
import { kNoAuth } from "../src/config/model-auth";
import type { ModelProfileDefinition } from "../src/config/model-profiles";
import {
	buildSyntheticModelId,
	collectAuthenticatedProfileProviders,
	isSyntheticModelId,
	parseSyntheticModelId,
	resolveSyntheticModelSelection,
	SYNTHETIC_PROVIDER_ID,
	syntheticNamespaceCollision,
} from "../src/sdk/model-profile-model";

const profile = (overrides: Partial<ModelProfileDefinition> = {}): ModelProfileDefinition => ({
	name: "codex-eco",
	requiredProviders: ["openai-codex"],
	modelMapping: { default: "openai-codex/gpt-5.6-terra:low" },
	source: "builtin",
	...overrides,
});

describe("synthetic model id grammar", () => {
	it("builds and recognizes ids in the reserved namespace", () => {
		expect(buildSyntheticModelId("codex-eco")).toBe(`${SYNTHETIC_PROVIDER_ID}/codex-eco`);
		expect(isSyntheticModelId(`${SYNTHETIC_PROVIDER_ID}/codex-eco`)).toBe(true);
		expect(isSyntheticModelId("openai-codex/gpt-5.6-terra")).toBe(false);
		expect(isSyntheticModelId(SYNTHETIC_PROVIDER_ID)).toBe(false);
		expect(isSyntheticModelId(`${SYNTHETIC_PROVIDER_ID}/`)).toBe(true); // empty suffix handled by parser
	});

	it("parses the profile suffix losslessly after the first namespace slash", () => {
		expect(parseSyntheticModelId(`${SYNTHETIC_PROVIDER_ID}/codex-eco`)).toEqual({ profileName: "codex-eco" });
		// Profile ids are not constrained to the TUI wizard's lowercase pattern:
		// additional slashes and punctuation are part of the suffix, never escapes.
		expect(parseSyntheticModelId(`${SYNTHETIC_PROVIDER_ID}/custom/profile !`)).toEqual({
			profileName: "custom/profile !",
		});
		expect(parseSyntheticModelId(`${SYNTHETIC_PROVIDER_ID}/`)).toBeUndefined();
		expect(parseSyntheticModelId("openai-codex/gpt-5.6-terra")).toBeUndefined();
		expect(parseSyntheticModelId(SYNTHETIC_PROVIDER_ID)).toBeUndefined();
	});

	it("detects a real provider shadowing the reserved namespace", () => {
		expect(syntheticNamespaceCollision([{ provider: "openai-codex" }])).toBe(false);
		expect(syntheticNamespaceCollision([{ provider: SYNTHETIC_PROVIDER_ID }])).toBe(true);
		expect(syntheticNamespaceCollision([{ provider: "a" }, { provider: SYNTHETIC_PROVIDER_ID }])).toBe(true);
		expect(syntheticNamespaceCollision([{ provider: "openai-codex" }], [SYNTHETIC_PROVIDER_ID])).toBe(true);
	});
});

describe("synthetic model selection resolution", () => {
	const profiles = new Map<string, ModelProfileDefinition>([
		["codex-eco", profile()],
		["codex-medium", profile({ name: "codex-medium" })],
	]);

	it("canonicalizes legacy aliases exactly like the CLI", () => {
		profiles.set("codex-medium", profile({ name: "codex-medium" }));
		const resolved = resolveSyntheticModelSelection(`${SYNTHETIC_PROVIDER_ID}/codex-standard`, profiles);
		expect(resolved.canonicalName).toBe("codex-medium");
	});

	it("resolves known profiles and preserves the raw suffix", () => {
		const resolved = resolveSyntheticModelSelection(`${SYNTHETIC_PROVIDER_ID}/codex-eco`, profiles);
		expect(resolved).toEqual({ profileName: "codex-eco", canonicalName: "codex-eco" });
	});

	it("converts unknown profiles to the SDK invalid_input code", () => {
		const error = (() => {
			try {
				resolveSyntheticModelSelection(`${SYNTHETIC_PROVIDER_ID}/no-such-profile`, profiles);
			} catch (caught) {
				return caught as { code?: string };
			}
		})();
		expect(error).toBeDefined();
		expect(error?.code).toBe("invalid_input");
	});

	it("converts an empty suffix and a registry error to invalid_input", () => {
		const empty = (() => {
			try {
				resolveSyntheticModelSelection(`${SYNTHETIC_PROVIDER_ID}/`, profiles);
			} catch (caught) {
				return caught as { code?: string };
			}
		})();
		expect(empty?.code).toBe("invalid_input");

		const broken = (() => {
			try {
				resolveSyntheticModelSelection(`${SYNTHETIC_PROVIDER_ID}/codex-eco`, profiles, new Error("broken"));
			} catch (caught) {
				return caught as { code?: string };
			}
		})();
		expect(broken?.code).toBe("invalid_input");
	});

	it("never selects a real provider model under the reserved namespace", () => {
		const error = (() => {
			try {
				resolveSyntheticModelSelection("openai-codex/gpt-5.6-terra", profiles);
			} catch (caught) {
				return caught as { code?: string };
			}
		})();
		expect(error?.code).toBe("invalid_input");
	});
});

describe("authenticated profile provider collection", () => {
	const alternativeProfiles = new Map<string, ModelProfileDefinition>([
		[
			"mimo",
			profile({
				name: "mimo",
				requiredProviders: ["xiaomi"],
				alternativeProviderGroups: [["xiaomi", "xiaomi-token-plan-sgp"]],
			}),
		],
	]);

	it("collects credentials across strict requirements and alternative groups", async () => {
		const authenticated = await collectAuthenticatedProfileProviders(alternativeProfiles, async provider => {
			if (provider === "xiaomi-token-plan-sgp") return "sk-test";
			return undefined;
		});
		expect(authenticated.has("xiaomi")).toBe(false);
		expect(authenticated.has("xiaomi-token-plan-sgp")).toBe(true);
	});

	it("counts kNoAuth as available and swallows per-provider lookup failures", async () => {
		const authenticated = await collectAuthenticatedProfileProviders(alternativeProfiles, async provider => {
			if (provider === "xiaomi-token-plan-sgp") return kNoAuth;
			throw new Error("credential read failed");
		});
		// kNoAuth on the alternative group member; the strict provider failed.
		expect(authenticated.has("xiaomi-token-plan-sgp")).toBe(true);
		expect(authenticated.has("xiaomi")).toBe(false);
	});
});
