import { afterEach, describe, expect, test } from "bun:test";
import { resolveModelRoleOverrides } from "../src/main";

const ENV_KEYS = [
	"GJC_SMOL_MODEL",
	"PI_SMOL_MODEL",
	"GJC_SLOW_MODEL",
	"PI_SLOW_MODEL",
	"GJC_PLAN_MODEL",
	"PI_PLAN_MODEL",
] as const;

function clearEnv(): void {
	for (const key of ENV_KEYS) delete Bun.env[key];
}

// Snapshot any ambient values so the suite never mutates the real environment.
const original = new Map(ENV_KEYS.map(key => [key, Bun.env[key]] as const));
afterEach(() => {
	for (const [key, value] of original) {
		if (value === undefined) delete Bun.env[key];
		else Bun.env[key] = value;
	}
});

const noFlags = {} as Pick<Parameters<typeof resolveModelRoleOverrides>[0], "smol" | "slow" | "plan">;

describe("resolveModelRoleOverrides", () => {
	test("returns no overrides when neither CLI flags nor env vars are set", () => {
		clearEnv();
		expect(resolveModelRoleOverrides(noFlags)).toEqual({});
	});

	test("reads the documented GJC_*_MODEL names for all three roles", () => {
		clearEnv();
		Bun.env.GJC_SMOL_MODEL = "prov/smol";
		Bun.env.GJC_SLOW_MODEL = "prov/slow";
		Bun.env.GJC_PLAN_MODEL = "prov/plan";
		expect(resolveModelRoleOverrides(noFlags)).toEqual({
			smol: "prov/smol",
			slow: "prov/slow",
			plan: "prov/plan",
		});
	});

	test("falls back to the legacy PI_*_MODEL name when GJC_* is unset", () => {
		clearEnv();
		Bun.env.PI_SLOW_MODEL = "prov/legacy-slow";
		expect(resolveModelRoleOverrides(noFlags)).toEqual({ slow: "prov/legacy-slow" });
	});

	test("prefers GJC_* over the legacy PI_* when both are set", () => {
		clearEnv();
		Bun.env.GJC_SMOL_MODEL = "prov/new";
		Bun.env.PI_SMOL_MODEL = "prov/legacy";
		expect(resolveModelRoleOverrides(noFlags).smol).toBe("prov/new");
	});

	test("lets the CLI flag win over both env names", () => {
		clearEnv();
		Bun.env.GJC_PLAN_MODEL = "prov/env";
		Bun.env.PI_PLAN_MODEL = "prov/legacy";
		expect(resolveModelRoleOverrides({ plan: "prov/cli" }).plan).toBe("prov/cli");
	});

	test("treats empty or whitespace-only env values as unset", () => {
		clearEnv();
		Bun.env.GJC_SMOL_MODEL = "   ";
		Bun.env.PI_SMOL_MODEL = "prov/legacy";
		expect(resolveModelRoleOverrides(noFlags).smol).toBe("prov/legacy");
		Bun.env.PI_SMOL_MODEL = "";
		expect(resolveModelRoleOverrides(noFlags).smol).toBeUndefined();
	});

	test("passes an arbitrary model id through unchanged (validation is downstream)", () => {
		clearEnv();
		Bun.env.GJC_SMOL_MODEL = "not-a-real/model-id";
		expect(resolveModelRoleOverrides(noFlags).smol).toBe("not-a-real/model-id");
	});

	test("resolves fresh per call, so a later invocation does not inherit an earlier one", () => {
		clearEnv();
		Bun.env.GJC_SMOL_MODEL = "prov/first";
		expect(resolveModelRoleOverrides(noFlags).smol).toBe("prov/first");
		clearEnv();
		expect(resolveModelRoleOverrides(noFlags).smol).toBeUndefined();
	});
});
