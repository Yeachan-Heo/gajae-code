import { describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { Broker } from "../src/sdk/broker/broker";
import {
	lifecycleSessionEnv,
	lifecycleSessionHostBaseEnv,
	setLifecycleCommandResolverForTest,
} from "../src/sdk/broker/lifecycle";

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
});

describe("lifecycle session host base env (#6735)", () => {
	test("#given inherited env #when composed #then unsetEnv removes, env overrides, and the master capability never crosses", () => {
		const base = lifecycleSessionHostBaseEnv(
			{ PATH: "/usr/bin", CI: "true", KEEP: "1", GJC_MASTER_CAPABILITY: "secret" },
			{ env: { PATH: "/opt/a/bin:/usr/bin", TENANT: "a" }, unsetEnv: ["CI"] },
		);
		expect(base).toEqual({ PATH: "/opt/a/bin:/usr/bin", KEEP: "1", TENANT: "a" });
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
