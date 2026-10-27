import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Broker } from "../src/sdk/broker/broker";

/**
 * Integration regressions for porting the accepted read-only broker-observation slice onto
 * pinned dev. These cover ONLY what the port itself can break — the two real textual
 * conflicts and the scope fence. The historically accepted O1-O7 behaviour is covered by the
 * ported suites (`sdk-diagnostics-entry`, `sdk-diagnostics-broker`,
 * `sdk-diagnostics-broker-matrix`) and is not re-claimed here as newly derived.
 *
 * IR-1 guards #5978: the ordinary dispatcher body moved from `cli.ts` into `cli-ordinary.ts`,
 *      and the accepted blob predates #5978, so the `await` in front of the async
 *      `runMemoryGuardNativeSmoke()` must be re-applied at the new home.
 * IR-2 guards #5860: `broker.diagnostics` must answer only from an already-owned healthy
 *      retained publication and must not publish, ensure, restart or recover anything.
 * IR-3 fences the slice: no B2 lifecycle-diagnostic surface may ride along.
 */

const REPO_ROOT = path.resolve(import.meta.dir, "../../..");
const CLI_ENTRY = path.join(REPO_ROOT, "packages/coding-agent/src/cli.ts");
const ORDINARY_SOURCE = path.join(REPO_ROOT, "packages/coding-agent/src/cli-ordinary.ts");

type OwnedResource = { label: string; dispose: () => Promise<void> | void };

const owned: OwnedResource[] = [];

afterEach(async () => {
	while (owned.length > 0) {
		const resource = owned.pop();
		if (!resource) continue;
		try {
			await resource.dispose();
		} catch {
			// Best effort per resource so the remaining ones still release.
		}
	}
});

async function taskFixtureAgentDir(label: string): Promise<string> {
	const root = await fs.mkdtemp(path.join(process.env.TMPDIR ?? os.tmpdir(), `gjc-obs-int-${label}-`));
	owned.push({ label: `fixture:${label}`, dispose: () => fs.rm(root, { recursive: true, force: true }) });
	const agentDir = path.join(root, "agent");
	await fs.mkdir(path.join(agentDir, "sdk"), { recursive: true });
	await fs.chmod(agentDir, 0o700);
	await fs.chmod(path.join(agentDir, "sdk"), 0o700);
	return agentDir;
}

async function listTree(root: string): Promise<string[]> {
	const entries = await fs.readdir(root, { recursive: true, withFileTypes: true });
	return entries.map(entry => path.relative(root, path.join(entry.parentPath, entry.name))).sort();
}

describe("IR-1 ordinary native-smoke route survives the inert-entry split (#5978)", () => {
	it("still awaits the async native smoke and emits its complete receipt", async () => {
		// Without the await the dispatcher returns before the dynamic native import settles,
		// the process exits at top level and the receipt is never written. Exercising the real
		// bin route is the only way to observe that.
		const child = Bun.spawn([process.execPath, CLI_ENTRY, "internal", "memory-guard-native-smoke", "--json"], {
			cwd: REPO_ROOT,
			stdout: "pipe",
			stderr: "pipe",
			env: { ...process.env },
		});
		owned.push({ label: "ir1:child", dispose: () => child.kill() });
		const [stdout, stderr, exitCode] = await Promise.all([
			new Response(child.stdout).text(),
			new Response(child.stderr).text(),
			child.exited,
		]);
		expect({ exitCode, stderr }).toEqual({ exitCode: 0, stderr: "" });
		expect(stdout.endsWith("\n")).toBe(true);
		const receipt = JSON.parse(stdout) as { api?: unknown; source?: unknown; result?: { kind?: unknown } };
		expect(receipt.api).toBe("memory_guard_windows_job_probe_v1");
		expect(receipt.source).toBe("pi_natives");
		expect(typeof receipt.result?.kind).toBe("string");
	}, 60_000);

	it("keeps the awaited smoke branch in the relocated ordinary dispatcher", async () => {
		const ordinary = await Bun.file(ORDINARY_SOURCE).text();
		expect(ordinary).toContain("export async function runOrdinaryCli(");
		expect(ordinary).toContain("await runMemoryGuardNativeSmoke();");
		// An unawaited call must not survive anywhere in the relocated body.
		expect(ordinary.includes("\t\trunMemoryGuardNativeSmoke();")).toBe(false);
	});
});

describe("IR-2 broker.diagnostics respects the readiness/ownership fence (#5860)", () => {
	it("answers a bounded startup-captured record only while the publication is healthy-owned", async () => {
		const agentDir = await taskFixtureAgentDir("owned");
		const broker = new Broker({ agentDir, packageGeneration: "observation-integration-fixture" });
		owned.push({ label: "ir2:broker", dispose: () => broker.stop() });
		await broker.start();

		const response = (await broker.handleRequest("broker.diagnostics", {})) as {
			ok: boolean;
			result?: {
				diagnosticProtocol?: unknown;
				generation?: unknown;
				build?: { packageVersion?: unknown; buildId?: unknown };
				identity?: { ownerId?: unknown; pid?: unknown; agentRoot?: unknown };
			};
		};

		expect(response.ok).toBe(true);
		expect(response.result?.diagnosticProtocol).toBe(1);
		expect(typeof response.result?.generation).toBe("string");
		// The publication incarnation id is NOT the package generation the broker was built with.
		expect(response.result?.generation).not.toBe("observation-integration-fixture");
		expect(typeof response.result?.build?.packageVersion).toBe("string");
		expect(response.result?.identity?.pid).toBe(process.pid);
		expect(response.result?.identity?.agentRoot).toBe(agentDir);
		expect(typeof response.result?.identity?.ownerId).toBe("string");

		// Startup capture: two observations of the same running broker agree exactly.
		const again = (await broker.handleRequest("broker.diagnostics", {})) as { result?: unknown };
		expect(again.result).toEqual(response.result);

		// Bounded public surface: no socket coordinate, token, argv or environment value.
		const serialized = JSON.stringify(response.result);
		expect(Buffer.byteLength(serialized, "utf8")).toBeLessThanOrEqual(8192);
		expect(serialized).not.toContain("socket");
		expect(serialized).not.toContain("token");
	}, 30_000);

	it("refuses with a typed unavailable and writes nothing when no publication is owned", async () => {
		const agentDir = await taskFixtureAgentDir("unowned");
		// Deliberately never started: the broker owns no publication, exactly the state the
		// readiness fence protects. Observation must refuse instead of acquiring authority.
		const broker = new Broker({ agentDir, packageGeneration: "observation-integration-fixture" });
		owned.push({ label: "ir2:unowned-broker", dispose: () => broker.stop() });

		const before = await listTree(agentDir);
		const response = (await broker.handleRequest("broker.diagnostics", {})) as {
			ok: boolean;
			error?: { code?: unknown };
			result?: unknown;
		};
		const after = await listTree(agentDir);

		expect(response.ok).toBe(false);
		expect(response.error?.code).toBe("unavailable");
		expect(response.result).toBeUndefined();
		// Zero publish / ensure / restart / recovery: the observation left the root untouched.
		expect(after).toEqual(before);
		expect(after).toEqual(["sdk"]);
	}, 30_000);
});

describe("IR-3 the ported slice carries no B2 lifecycle-diagnostic surface", () => {
	it("introduces neither the codec nor a lifecycleDiagnostic producer", async () => {
		const excluded = [
			"packages/coding-agent/src/sdk/diagnostics/diagnostic-codec.ts",
			"packages/coding-agent/test/sdk-lifecycle-diagnostic.test.ts",
		];
		for (const relative of excluded) {
			expect(await Bun.file(path.join(REPO_ROOT, relative)).exists()).toBe(false);
		}
		const facade = await Bun.file(
			path.join(REPO_ROOT, "packages/coding-agent/src/sdk/diagnostics/observe-broker.ts"),
		).text();
		expect(facade).not.toContain("lifecycleDiagnostic");
	});
});
