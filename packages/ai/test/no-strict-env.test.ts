import { describe, expect, it } from "bun:test";
import * as path from "node:path";

/**
 * `docs/ai-schema-normalize.md` documents `GJC_NO_STRICT` as "the global bypass"
 * consulted by `adaptSchemaForStrict`. Only the legacy `PI_NO_STRICT` was read,
 * so an operator hitting a provider that rejects strict schemas set the
 * documented name and nothing happened.
 *
 * `NO_STRICT` is a module-level constant, so each scenario runs in its own
 * process.
 */

const PROBE = path.join(import.meta.dir, "fixtures", "no-strict-probe.ts");
const KEYS = ["GJC_NO_STRICT", "PI_NO_STRICT"] as const;

async function resolveWith(overrides: Record<string, string>): Promise<boolean> {
	const env: Record<string, string> = {};
	for (const [key, value] of Object.entries(process.env)) {
		if (value !== undefined) env[key] = value;
	}
	for (const key of KEYS) delete env[key];
	Object.assign(env, overrides);

	const proc = Bun.spawn([process.execPath, PROBE], { env, stdout: "pipe", stderr: "pipe" });
	const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
	const exitCode = await proc.exited;
	if (exitCode !== 0) throw new Error(`probe failed (${exitCode}): ${stderr}`);
	return (JSON.parse(stdout.trim()) as { noStrict: boolean }).noStrict;
}

describe("strict-mode bypass env names", () => {
	it("keeps strict mode on when neither name is set", async () => {
		expect(await resolveWith({})).toBe(false);
	});

	it("honors the documented GJC_NO_STRICT", async () => {
		expect(await resolveWith({ GJC_NO_STRICT: "1" })).toBe(true);
	});

	it("still honors the legacy PI_NO_STRICT", async () => {
		expect(await resolveWith({ PI_NO_STRICT: "1" })).toBe(true);
	});

	it("accepts the documented boolean spellings case-insensitively", async () => {
		expect(await resolveWith({ GJC_NO_STRICT: "true" })).toBe(true);
		expect(await resolveWith({ GJC_NO_STRICT: "YES" })).toBe(true);
		expect(await resolveWith({ GJC_NO_STRICT: "on" })).toBe(true);
	});

	it("treats an explicit falsey documented value as off", async () => {
		expect(await resolveWith({ GJC_NO_STRICT: "0" })).toBe(false);
	});

	it("lets an explicit falsey GJC value win over a truthy legacy value", async () => {
		// $pickflag takes the first non-empty key, so the canonical name decides.
		expect(await resolveWith({ GJC_NO_STRICT: "0", PI_NO_STRICT: "1" })).toBe(false);
	});
});
