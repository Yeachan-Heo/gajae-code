import { afterEach, describe, expect, test } from "bun:test";
import { parseArgs, resolvePlanModelOverride } from "../src/cli/args";

const ENV_KEYS = ["GJC_PLAN_MODEL", "PI_PLAN_MODEL"] as const;

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

describe("resolvePlanModelOverride", () => {
	test("returns undefined when neither --plan nor env vars are set", () => {
		clearEnv();
		expect(resolvePlanModelOverride(parseArgs([]))).toBeUndefined();
	});

	test("reads GJC_PLAN_MODEL before the legacy PI_PLAN_MODEL", () => {
		clearEnv();
		Bun.env.PI_PLAN_MODEL = "prov/legacy";
		expect(resolvePlanModelOverride(parseArgs([]))).toBe("prov/legacy");
		Bun.env.GJC_PLAN_MODEL = "prov/env";
		expect(resolvePlanModelOverride(parseArgs([]))).toBe("prov/env");
	});

	test("lets the parsed --plan flag win over both env names", () => {
		clearEnv();
		Bun.env.GJC_PLAN_MODEL = "prov/env";
		Bun.env.PI_PLAN_MODEL = "prov/legacy";
		expect(resolvePlanModelOverride(parseArgs(["--plan", "prov/cli"]))).toBe("prov/cli");
		expect(resolvePlanModelOverride(parseArgs(["--plan=prov/inline"]))).toBe("prov/inline");
	});

	test("treats empty or whitespace-only env values as unset", () => {
		clearEnv();
		Bun.env.GJC_PLAN_MODEL = "   ";
		Bun.env.PI_PLAN_MODEL = "prov/legacy";
		expect(resolvePlanModelOverride(parseArgs([]))).toBe("prov/legacy");
		Bun.env.PI_PLAN_MODEL = "";
		expect(resolvePlanModelOverride(parseArgs([]))).toBeUndefined();
	});
});
