import { describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { Broker } from "../src/sdk/broker/broker";
import {
	lifecycleSessionEnv,
	lifecycleSessionHostBaseEnv,
	setLifecycleCommandResolverForTest,
} from "../src/sdk/broker/lifecycle";

function seededRandom(seed: number): () => number {
	let state = seed >>> 0;
	return () => {
		state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
		return state / 0x1_0000_0000;
	};
}

function randomInt(random: () => number, max: number): number {
	return Math.floor(random() * max);
}

function randomEnvName(random: () => number, index: number): string {
	const alphabet = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_";
	let suffix = "";
	for (let charIndex = 0; charIndex < 8; charIndex++) {
		suffix += alphabet[randomInt(random, alphabet.length)] ?? "a";
	}
	return `PROPERTY_${index}_${suffix}`;
}

function randomEnvValue(random: () => number): string {
	const alphabet = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 _-/:=";
	const length = randomInt(random, 48);
	let value = "";
	for (let charIndex = 0; charIndex < length; charIndex++) {
		value += alphabet[randomInt(random, alphabet.length)] ?? "a";
	}
	return value;
}

function flipFirstLetterCase(value: string): string {
	const index = value.search(/[A-Za-z]/u);
	if (index < 0) throw new Error("expected an environment name with an ASCII letter");
	const letter = value[index]!;
	const flipped = letter === letter.toUpperCase() ? letter.toLowerCase() : letter.toUpperCase();
	return `${value.slice(0, index)}${flipped}${value.slice(index + 1)}`;
}

function envEntries(value: Readonly<Record<string, string>>): Array<[string, string]> {
	return Object.entries(value).sort(([left], [right]) => left.localeCompare(right));
}

async function tempRoot(label: string): Promise<string> {
	return await fs.mkdtemp(path.join(process.env.TMPDIR ?? "/tmp", `gjc-${label}-`));
}

describe("lifecycle per-session env validation (#6735)", () => {
	test("#given no env fields #then the launch carries none", () => {
		expect(lifecycleSessionEnv({})).toEqual({});
	});

	test("#given valid env and unsetEnv #then both are kept as supplied", () => {
		expect(lifecycleSessionEnv({ env: { PATH: "/opt/a/bin", TENANT: "a" }, unsetEnv: ["CI"] })).toEqual({
			env: { PATH: "/opt/a/bin", TENANT: "a" },
			unsetEnv: ["CI"],
		});
	});

	test.each([
		["a non-object env", { env: ["PATH"] }],
		["a non-string value", { env: { PORT: 1 } }],
		["an invalid name", { env: { "BAD-NAME": "x" } }],
		["a NUL in a value", { env: { X: "a\0b" } }],
		["a reserved GJC_ name", { env: { GJC_SDK_LIFECYCLE_REQUEST: "{}" } }],
		["a reserved gjc_ name in any case", { unsetEnv: ["gjc_state_root"] }],
		["a non-array unsetEnv", { unsetEnv: "CI" }],
		["a duplicate unsetEnv name", { unsetEnv: ["CI", "CI"] }],
		["a name both set and unset", { env: { CI: "1" }, unsetEnv: ["CI"] }],
	])("#given %s #then it is rejected", (_label, input) => {
		expect(lifecycleSessionEnv(input)).toBeNull();
	});

	test("holds generated validation and case-matching properties (seed 0x6735a11)", () => {
		const seed = 0x6735a11;
		const random = seededRandom(seed);
		const windows = process.platform === "win32";

		for (let caseIndex = 0; caseIndex < 64; caseIndex++) {
			const name = randomEnvName(random, caseIndex);
			const value = randomEnvValue(random);
			const accepted = lifecycleSessionEnv({ env: { [name]: value } });
			expect(accepted, `seed ${seed}, case ${caseIndex}`).toEqual({ env: { [name]: value } });
			expect(Object.keys(accepted?.env ?? {}).every(key => !key.toUpperCase().startsWith("GJC_"))).toBe(true);

			const reserved = `gJc_${name.slice("PROPERTY_".length)}`;
			expect(lifecycleSessionEnv({ env: { [reserved]: value } }), `seed ${seed}, case ${caseIndex}`).toBeNull();
			expect(lifecycleSessionEnv({ unsetEnv: [reserved] }), `seed ${seed}, case ${caseIndex}`).toBeNull();

			expect(lifecycleSessionEnv({ env: { [name]: value }, unsetEnv: [name] })).toBeNull();

			const caseVariant = flipFirstLetterCase(name);
			const caseVariantCollision = lifecycleSessionEnv({ env: { [name]: value }, unsetEnv: [caseVariant] });
			expect(caseVariantCollision === null, `seed ${seed}, case ${caseIndex}`).toBe(windows);

			const caseVariantUnsetDuplicate = lifecycleSessionEnv({ unsetEnv: [name, caseVariant] });
			expect(caseVariantUnsetDuplicate === null, `seed ${seed}, case ${caseIndex}`).toBe(windows);

			const caseVariantEnvDuplicate = lifecycleSessionEnv({
				env: { [name]: value, [caseVariant]: randomEnvValue(random) },
			});
			expect(caseVariantEnvDuplicate === null, `seed ${seed}, case ${caseIndex}`).toBe(windows);
		}
	});

	test("accepts exact env entry, name, and value limits and rejects the next value", () => {
		const maxEntries = 256;
		const maxNameLength = 256;
		const maxValueLength = 131_072;
		const env = Object.fromEntries(
			Array.from({ length: maxEntries }, (_, index) => [`ENTRY_${index}`, `value-${index}`]),
		);
		const unsetEnv = Array.from({ length: maxEntries }, (_, index) => `UNSET_${index}`);
		const longestName = `A${"_".repeat(maxNameLength - 1)}`;
		const longestValue = "x".repeat(maxValueLength);

		expect(lifecycleSessionEnv({ env })).not.toBeNull();
		expect(lifecycleSessionEnv({ env: { ...env, ENTRY_256: "too many" } })).toBeNull();
		expect(lifecycleSessionEnv({ unsetEnv })).not.toBeNull();
		expect(lifecycleSessionEnv({ unsetEnv: [...unsetEnv, "UNSET_256"] })).toBeNull();
		expect(lifecycleSessionEnv({ env: { [longestName]: longestValue } })).not.toBeNull();
		expect(lifecycleSessionEnv({ env: { [`${longestName}_`]: "x" } })).toBeNull();
		expect(lifecycleSessionEnv({ env: { VALUE: longestValue } })).not.toBeNull();
		expect(lifecycleSessionEnv({ env: { VALUE: `${longestValue}x` } })).toBeNull();
	});
});

describe("lifecycle session host base env (#6735)", () => {
	test("#given inherited env #when composed #then unsetEnv removes, env overrides, and the master capability never crosses", () => {
		const base = lifecycleSessionHostBaseEnv(
			{ PATH: "/usr/bin", CI: "true", KEEP: "1", GJC_MASTER_CAPABILITY: "secret" },
			{ env: { PATH: "/opt/a/bin:/usr/bin", TENANT: "a" }, unsetEnv: ["CI"] },
		);
		expect(base).toEqual({ PATH: "/opt/a/bin:/usr/bin", KEEP: "1", TENANT: "a" });
	});

	test("holds generated composition properties (seed 0x6735c0de)", () => {
		const seed = 0x6735c0de;
		const random = seededRandom(seed);
		const windows = process.platform === "win32";
		const envKey = (name: string): string => (windows ? name.toUpperCase() : name);

		for (let caseIndex = 0; caseIndex < 64; caseIndex++) {
			const keepName = randomEnvName(random, caseIndex * 4);
			const overrideName = randomEnvName(random, caseIndex * 4 + 1);
			const unsetName = randomEnvName(random, caseIndex * 4 + 2);
			const explicitName = randomEnvName(random, caseIndex * 4 + 3);
			const inheritedEntries: Array<[string, string]> = [
				[keepName, randomEnvValue(random)],
				[overrideName, randomEnvValue(random)],
				[unsetName, randomEnvValue(random)],
				["GJC_MASTER_CAPABILITY", randomEnvValue(random)],
				["__proto__", randomEnvValue(random)],
			];
			const inherited = Object.fromEntries(inheritedEntries) as Record<string, string>;
			const overrideKey = flipFirstLetterCase(overrideName);
			const unsetKey = flipFirstLetterCase(unsetName);
			const env = { [overrideKey]: randomEnvValue(random), [explicitName]: randomEnvValue(random) };
			const unsetEnv = [unsetKey];
			const actual = lifecycleSessionHostBaseEnv(inherited, { env, unsetEnv });
			const removed = new Set([...unsetEnv, ...Object.keys(env)].map(envKey));
			const expectedEntries = inheritedEntries.filter(
				([name]) => name !== "GJC_MASTER_CAPABILITY" && !removed.has(envKey(name)),
			);
			const expected = Object.fromEntries([...expectedEntries, ...Object.entries(env)]) as Record<string, string>;

			expect(envEntries(actual), `seed ${seed}, case ${caseIndex}`).toEqual(envEntries(expected));
			expect(Object.hasOwn(actual, "GJC_MASTER_CAPABILITY")).toBe(false);
			expect(actual[overrideKey]).toBe(env[overrideKey]);
			expect(Object.hasOwn(actual, overrideName)).toBe(!windows);
			expect(Object.hasOwn(actual, unsetName)).toBe(!windows);
			expect(Object.hasOwn(actual, "__proto__")).toBe(true);
		}
	});
});

describe("broker-hosted sessions observe their own env (#6735)", () => {
	test("#given two concurrent session.create calls with different env #then each host and its shell see only its own", async () => {
		const root = await tempRoot("session-env");
		const agentDir = path.join(root, "agent");
		const fixture = path.join(root, "env-probe.ts");
		const lifecycleModule = JSON.stringify(path.resolve(import.meta.dir, "../src/sdk/broker/lifecycle.ts"));
		const broker = new Broker({ agentDir });
		process.env.SESSION_ENV_INHERITED = "broker";
		try {
			await fs.writeFile(
				fixture,
				`import * as fs from "node:fs/promises";
import * as path from "node:path";
import { writeSessionLifecycleFailure } from ${lifecycleModule};
const request = JSON.parse(process.env.GJC_SDK_LIFECYCLE_REQUEST!);
const shell = Bun.spawnSync(["/bin/sh", "-c", 'printf "%s|%s|%s" "$SESSION_TENANT" "$PATH" "\${SESSION_ENV_INHERITED-unset}"'], { env: process.env });
await fs.writeFile(path.join(${JSON.stringify(root)}, (process.env.SESSION_TENANT ?? "none") + ".json"), JSON.stringify({
  tenant: process.env.SESSION_TENANT ?? null,
  path: process.env.PATH ?? null,
  inherited: process.env.SESSION_ENV_INHERITED ?? null,
  hasRequest: typeof process.env.GJC_SDK_LIFECYCLE_REQUEST === "string",
  shell: shell.stdout.toString(),
}));
await writeSessionLifecycleFailure(request.stateRoot, request.sessionId, request.effectMarker, { phase: "startup", reason: "failed", message: "env probe done" }, { endpointGeneration: null, fenced: false, runtimeRemoved: true, hostStopped: false, brokerRegistrationReleased: true });
process.exit(1);`,
			);
			setLifecycleCommandResolverForTest(broker, () => ({ file: process.execPath, args: ["run", fixture] }));
			await broker.start();

			const basePath = process.env.PATH ?? "";
			await Promise.all([
				broker.handleRequest(
					"session.create",
					{
						cwd: root,
						readinessTimeoutMs: 10_000,
						env: { SESSION_TENANT: "a", PATH: `/opt/a/bin:${basePath}` },
						unsetEnv: ["SESSION_ENV_INHERITED"],
					},
					"session-env-a",
				),
				broker.handleRequest(
					"session.create",
					{ cwd: root, readinessTimeoutMs: 10_000, env: { SESSION_TENANT: "b", PATH: `/opt/b/bin:${basePath}` } },
					"session-env-b",
				),
			]);

			const a = JSON.parse(await fs.readFile(path.join(root, "a.json"), "utf8"));
			const b = JSON.parse(await fs.readFile(path.join(root, "b.json"), "utf8"));
			expect(a).toMatchObject({ tenant: "a", inherited: null, hasRequest: true });
			expect(b).toMatchObject({ tenant: "b", inherited: "broker", hasRequest: true });
			expect(a.path.startsWith("/opt/a/bin:")).toBe(true);
			expect(b.path.startsWith("/opt/b/bin:")).toBe(true);
			expect(a.shell).toBe(`a|/opt/a/bin:${basePath}|unset`);
			expect(b.shell).toBe(`b|/opt/b/bin:${basePath}|broker`);
		} finally {
			setLifecycleCommandResolverForTest(broker, undefined);
			await broker.stop();
			delete process.env.SESSION_ENV_INHERITED;
			await fs.rm(root, { recursive: true, force: true });
		}
	}, 30_000);

	test("#given a reserved GJC_ env name #then session.create fails closed before spawning", async () => {
		const root = await tempRoot("session-env-reserved");
		const broker = new Broker({ agentDir: path.join(root, "agent") });
		try {
			setLifecycleCommandResolverForTest(broker, () => {
				throw new Error("must not spawn");
			});
			await broker.start();
			const response = await broker.handleRequest(
				"session.create",
				{ cwd: root, env: { GJC_SESSION_ID: "spoofed" } },
				"session-env-reserved",
			);
			expect(response).toMatchObject({ ok: false, error: { code: "invalid_input" } });
		} finally {
			setLifecycleCommandResolverForTest(broker, undefined);
			await broker.stop();
			await fs.rm(root, { recursive: true, force: true });
		}
	}, 15_000);
});
