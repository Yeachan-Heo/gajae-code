import { describe, expect, it } from "bun:test";
import {
	type CoordinatorModelProfile,
	type CoordinatorModelProfileLoader,
	CoordinatorModelProfileRegistryError,
	resolveCoordinatorMpreset,
} from "../src/coordinator-mcp/model-preset";

const builtinLoader: CoordinatorModelProfileLoader = () =>
	new Map<string, CoordinatorModelProfile>([["codex-eco", { name: "codex-eco" }]]);

function customProfile(name: string): CoordinatorModelProfile {
	return { name };
}

function loaderWithProfiles(...profiles: CoordinatorModelProfile[]): CoordinatorModelProfileLoader {
	return () => new Map(profiles.map(profile => [profile.name, profile]));
}

describe("resolveCoordinatorMpreset", () => {
	it("treats absent and null values as a no-op selection", async () => {
		for (const raw of [undefined, null]) {
			await expect(resolveCoordinatorMpreset(raw, builtinLoader)).resolves.toEqual({ ok: true, mpreset: null });
		}
	});

	it("rejects an explicit blank or whitespace-only selection instead of silently omitting it", async () => {
		for (const raw of ["", "   "]) {
			await expect(resolveCoordinatorMpreset(raw, loaderWithProfiles(customProfile("alpha")))).resolves.toEqual({
				ok: false,
				reason: "unknown_model_profile",
				mpreset: "",
				available_profiles: ["alpha"],
			});
		}
	});

	it("accepts and trims a known built-in profile", async () => {
		await expect(resolveCoordinatorMpreset("  codex-eco  ", builtinLoader)).resolves.toEqual({
			ok: true,
			mpreset: "codex-eco",
		});
	});

	it("accepts a custom profile supplied by the injected loader", async () => {
		const loadCustomProfiles = loaderWithProfiles(customProfile("coordinator-custom"));

		await expect(resolveCoordinatorMpreset("coordinator-custom", loadCustomProfiles)).resolves.toEqual({
			ok: true,
			mpreset: "coordinator-custom",
		});
	});

	it("canonicalizes a legacy profile alias exactly like the CLI", async () => {
		// `codex-standard` is a fallback-only alias for `codex-medium`; the resolved
		// value is the canonical profile name so the child receives `--mpreset codex-medium`.
		const loadProfiles = loaderWithProfiles(customProfile("codex-medium"));

		await expect(resolveCoordinatorMpreset("codex-standard", loadProfiles)).resolves.toEqual({
			ok: true,
			mpreset: "codex-medium",
		});
	});

	it("never lets a legacy alias shadow a real profile of the same name", async () => {
		const loadProfiles = loaderWithProfiles(customProfile("codex-standard"), customProfile("codex-medium"));

		await expect(resolveCoordinatorMpreset("codex-standard", loadProfiles)).resolves.toEqual({
			ok: true,
			mpreset: "codex-standard",
		});
	});

	it("rejects unknown profiles with a sorted available-profile listing", async () => {
		const loadProfiles = loaderWithProfiles(customProfile("zeta"), customProfile("alpha"), customProfile("middle"));

		await expect(resolveCoordinatorMpreset("unknown", loadProfiles)).resolves.toEqual({
			ok: false,
			reason: "unknown_model_profile",
			mpreset: "unknown",
			available_profiles: ["alpha", "middle", "zeta"],
		});
	});

	it("caps the echoed unknown profile name at 128 characters", async () => {
		const resolution = await resolveCoordinatorMpreset("x".repeat(500), loaderWithProfiles(customProfile("alpha")));

		expect(resolution).toEqual({
			ok: false,
			reason: "unknown_model_profile",
			mpreset: "x".repeat(128),
			available_profiles: ["alpha"],
		});
	});

	it("rejects non-string input without treating it as a profile", async () => {
		await expect(resolveCoordinatorMpreset(42, loaderWithProfiles(customProfile("alpha")))).resolves.toEqual({
			ok: false,
			reason: "unknown_model_profile",
			mpreset: "",
			available_profiles: ["alpha"],
		});
	});

	it("fails closed with a distinct reason when the profile registry cannot be loaded", async () => {
		const failingLoader: CoordinatorModelProfileLoader = () => {
			throw new CoordinatorModelProfileRegistryError(new Error("broken models.yml"));
		};

		await expect(resolveCoordinatorMpreset("codex-eco", failingLoader)).resolves.toEqual({
			ok: false,
			reason: "model_profile_registry_error",
			mpreset: "codex-eco",
			available_profiles: [],
		});
	});
});
