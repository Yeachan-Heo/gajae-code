import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Broker } from "../src/sdk/broker/broker";

/**
 * Packet order 4 (full success / B3): the real exported facade, the real broker
 * diagnostics operation over the real transport, one source SdkClient connection and the
 * actual CLI. B2 nonce receipts and retention are a separate later slice.
 *
 * Every fixture here is task-owned and ephemeral. Starting the fixture broker is SETUP,
 * never an observation effect: observation counters are asserted separately.
 */

const SUPPORTED_RUNTIME = process.platform === "darwin" && process.arch === "arm64" && Bun.version === "1.4.0";

type OwnedResource = { label: string; dispose: () => Promise<void> | void };

const owned: OwnedResource[] = [];

afterEach(async () => {
	// Every fixture server, client, child and lease is released here, in reverse order.
	while (owned.length > 0) {
		const resource = owned.pop();
		if (!resource) continue;
		try {
			await resource.dispose();
		} catch {
			// Cleanup is best effort per resource; the remaining ones still run.
		}
	}
});

async function taskFixtureRoot(label: string): Promise<string> {
	const root = await fs.mkdtemp(path.join(process.env.TMPDIR ?? os.tmpdir(), `gjc-obs-${label}-`));
	owned.push({ label: `fixture:${label}`, dispose: () => fs.rm(root, { recursive: true, force: true }) });
	const agentDir = path.join(root, "agent");
	await fs.mkdir(path.join(agentDir, "sdk"), { recursive: true });
	await fs.chmod(agentDir, 0o700);
	await fs.chmod(path.join(agentDir, "sdk"), 0o700);
	return agentDir;
}

/**
 * SETUP: a real broker started through its own startup path, so the publication and its
 * retained authority are the authentic ones. Starting it is setup, not an observation
 * effect.
 */
async function startFixtureBroker(agentDir: string): Promise<{ broker: Broker }> {
	const broker = new Broker({ agentDir, packageGeneration: "observation-fixture" });
	owned.push({ label: "fixture:broker", dispose: () => broker.stop() });
	await broker.start();
	return { broker };
}

describe("observation option contract and native gate (F1)", () => {
	async function facade() {
		return (await import("../src/sdk/diagnostics/observe-broker")) as {
			observeExistingBroker: (options: unknown) => Promise<{
				ok: boolean;
				unavailable?: { reason: string; message: string };
			}>;
			OBSERVATION_TIMEOUT_DEFAULT_MS: number;
			OBSERVATION_TIMEOUT_MIN_MS: number;
			OBSERVATION_TIMEOUT_MAX_MS: number;
			validateObservationOptions: (
				options: unknown,
			) =>
				| { ok: true; value: { agentDir: string; expectedGeneration?: string; timeoutMs: number } }
				| { ok: false; error: { code: "invalid_arguments"; field: string } };
		};
	}

	it("uses the contract's timeout default and range, not a wider one", async () => {
		const api = await facade();
		expect({
			def: api.OBSERVATION_TIMEOUT_DEFAULT_MS,
			min: api.OBSERVATION_TIMEOUT_MIN_MS,
			max: api.OBSERVATION_TIMEOUT_MAX_MS,
		}).toEqual({ def: 2000, min: 1, max: 10_000 });
	});

	it("rejects every malformed option as invalid_arguments, never as absent", async () => {
		const { validateObservationOptions } = await facade();
		const rows: [string, unknown, string][] = [
			["missing-options", undefined, "options"],
			["missing-agent-dir", {}, "agentDir"],
			["empty-agent-dir", { agentDir: "" }, "agentDir"],
			["relative-agent-dir", { agentDir: "relative/path" }, "agentDir"],
			["nul-agent-dir", { agentDir: "/tmp/a\u0000b" }, "agentDir"],
			["oversize-agent-dir", { agentDir: `/${"a".repeat(4096)}` }, "agentDir"],
			["too-many-components", { agentDir: `/${Array.from({ length: 129 }, () => "a").join("/")}` }, "agentDir"],
			["wrong-agent-dir-type", { agentDir: 7 }, "agentDir"],
			["expected-generation-type", { agentDir: "/tmp/agent", expectedGeneration: 7 }, "expectedGeneration"],
			[
				"expected-generation-shape",
				{ agentDir: "/tmp/agent", expectedGeneration: "not hex!" },
				"expectedGeneration",
			],
			["expected-generation-length", { agentDir: "/tmp/agent", expectedGeneration: "ab" }, "expectedGeneration"],
			["timeout-zero", { agentDir: "/tmp/agent", timeoutMs: 0 }, "timeoutMs"],
			["timeout-negative", { agentDir: "/tmp/agent", timeoutMs: -1 }, "timeoutMs"],
			["timeout-too-large", { agentDir: "/tmp/agent", timeoutMs: 10_001 }, "timeoutMs"],
			["timeout-fractional", { agentDir: "/tmp/agent", timeoutMs: 1.5 }, "timeoutMs"],
			["timeout-nan", { agentDir: "/tmp/agent", timeoutMs: Number.NaN }, "timeoutMs"],
			["timeout-type", { agentDir: "/tmp/agent", timeoutMs: "2000" }, "timeoutMs"],
			// R3: an unknown key is reported as the fixed identifier, never reflected back.
			["unknown-field", { agentDir: "/tmp/agent", extra: true }, "options"],
		];
		for (const [label, options, field] of rows) {
			const verdict = validateObservationOptions(options);
			expect({
				label,
				ok: verdict.ok,
				code: verdict.ok ? null : verdict.error.code,
				field: verdict.ok ? null : verdict.error.field,
			}).toEqual({
				label,
				ok: false,
				code: "invalid_arguments",
				field,
			});
		}
		// The accepted shape stays accepted, with the contract default applied.
		const accepted = validateObservationOptions({ agentDir: "/tmp/agent" });
		expect(accepted.ok && accepted.value.timeoutMs).toBe(2000);
	});

	it("maps a typed argument error to the malformed-input exit code in the actual CLI", async () => {
		const cli = path.join(import.meta.dir, "..", "src", "cli.ts");
		// The CLI grammar accepts an opaque generation id, but the facade requires the
		// fixed shape: that refusal must still exit 2 rather than escaping as a crash.
		const agentDir = await taskFixtureRoot("cli-invalid-generation");
		const child = Bun.spawn({
			cmd: [
				process.execPath,
				cli,
				"sdk",
				"diagnostics",
				"broker",
				"--agent-dir",
				agentDir,
				"--expected-generation",
				"not-a-generation",
				"--json",
			],
			env: { ...process.env },
			stdout: "pipe",
			stderr: "pipe",
		});
		owned.push({ label: "cli:invalid-args", dispose: () => child.kill() });
		const stdout = await new Response(child.stdout).text();
		const exitCode = await child.exited;
		// Malformed input exits 2 and renders no observation document.
		expect({ exitCode, hasObservation: stdout.includes("gjc.broker-observation") }).toEqual({
			exitCode: 2,
			hasObservation: false,
		});
	}, 120_000);

	it("resolves the publication through the approved native lease, never ordinary discovery", async () => {
		const source = await Bun.file(
			path.join(import.meta.dir, "..", "src", "sdk", "diagnostics", "observe-broker.ts"),
		).text();
		// The approved read-only path is the only publication reader on this route.
		expect(source).toContain("loadDiagnosticNativeReadOnly");
		expect(source).toContain("openDiagnosticSnapshot");
		expect(source).toContain(".revalidate()");
		expect(source).toContain(".close()");
		// Ordinary discovery bypasses the native ACL/owner/mode/FS gate entirely.
		expect(source).not.toContain("readBrokerDiscovery");
		// The runtime tuple decision precedes any publication access.
		const gate = source.indexOf("loadDiagnosticNativeReadOnly");
		const read = source.indexOf("openDiagnosticSnapshot(");
		expect(gate).toBeGreaterThan(0);
		expect(gate).toBeLessThan(read);
	});

	it("refuses malformed options with a typed error before touching the filesystem", async () => {
		const api = (await import("../src/sdk/diagnostics/observe-broker")) as {
			observeExistingBroker: (options: unknown) => Promise<unknown>;
			DiagnosticOptionsError: new (...args: never[]) => Error & { code: string; field: string };
		};
		// The reason enum has no "invalid_arguments" member: malformed input is a typed
		// argument error (CLI exit 2), never an observed unavailability.
		let thrown: unknown;
		try {
			await api.observeExistingBroker({ agentDir: "relative/path" });
		} catch (error) {
			thrown = error;
		}
		expect(thrown).toBeInstanceOf(api.DiagnosticOptionsError);
		expect({
			code: (thrown as { code: string }).code,
			field: (thrown as { field: string }).field,
		}).toEqual({ code: "invalid_arguments", field: "agentDir" });
	});
});

describe("broker observation facade (packet order 4, full success)", () => {
	it("exports the observation facade from the public SDK barrel", async () => {
		const barrel = (await import("../src/sdk/index")) as Record<string, unknown>;
		expect(typeof barrel.observeExistingBroker).toBe("function");
	});

	it.skipIf(!SUPPORTED_RUNTIME)(
		"reports the same observation through the actual CLI in JSON and text",
		async () => {
			const agentDir = await taskFixtureRoot("cli");
			await startFixtureBroker(agentDir);
			const cli = path.join(import.meta.dir, "..", "src", "cli.ts");
			// The fixture broker serves from THIS process, so the child must be awaited
			// asynchronously: a synchronous spawn would block the event loop that has to
			// accept the child's connection.
			const run = async (extra: string[]) => {
				const child = Bun.spawn({
					cmd: [process.execPath, cli, "sdk", "diagnostics", "broker", "--agent-dir", agentDir, ...extra],
					env: { ...process.env, HOME: path.dirname(path.dirname(agentDir)) },
					stdout: "pipe",
					stderr: "pipe",
				});
				owned.push({ label: "fixture:cli-child", dispose: () => child.kill() });
				const stdout = await new Response(child.stdout).text();
				const exitCode = await child.exited;
				return { exitCode, stdout };
			};

			const json = await run(["--json"]);
			const jsonOut = json.stdout;
			const parsed = JSON.parse(jsonOut) as {
				schema: string;
				ok: boolean;
				broker?: { diagnosticProtocol: number; generation: string };
			};
			expect({ exitCode: json.exitCode, schema: parsed.schema, ok: parsed.ok }).toEqual({
				exitCode: 0,
				schema: "gjc.broker-observation",
				ok: true,
			});
			expect(parsed.broker?.diagnosticProtocol).toBe(1);
			expect(Buffer.byteLength(jsonOut, "utf8")).toBeLessThanOrEqual(8192);
			// No token, socket coordinate, path, pid or environment value is rendered.
			for (const forbidden of ["token", "ws://", "127.0.0.1", agentDir]) {
				expect(jsonOut.includes(forbidden)).toBe(false);
			}

			const text = await run([]);
			const textOut = text.stdout;
			expect(text.exitCode).toBe(0);
			expect(textOut.startsWith("broker observation: ok")).toBe(true);
			expect(textOut.includes(parsed.broker?.generation ?? "<missing>")).toBe(true);
			expect(Buffer.byteLength(textOut, "utf8")).toBeLessThanOrEqual(8192);
		},
		180_000,
	);

	it.skipIf(!SUPPORTED_RUNTIME)(
		"observes a real running broker through one client connection",
		async () => {
			const agentDir = await taskFixtureRoot("success");
			await startFixtureBroker(agentDir);
			const { observeExistingBroker } = (await import("../src/sdk/index")) as {
				observeExistingBroker: (options: { agentDir: string; timeoutMs?: number }) => Promise<{
					schema: string;
					version: number;
					ok: boolean;
					observedAt: string;
					broker?: {
						generation: string;
						build: { packageVersion: string; buildId: string | null };
						diagnosticProtocol: number;
					};
					unavailable?: { reason: string; message: string };
				}>;
			};
			const observation = await observeExistingBroker({ agentDir, timeoutMs: 5_000 });
			expect({
				schema: observation.schema,
				version: observation.version,
				ok: observation.ok,
				reason: observation.unavailable?.reason ?? null,
			}).toEqual({ schema: "gjc.broker-observation", version: 1, ok: true, reason: null });
			expect(observation.broker?.diagnosticProtocol).toBe(1);
			expect(typeof observation.broker?.generation).toBe("string");
			expect(observation.broker?.generation.length).toBeGreaterThan(0);
			expect(typeof observation.broker?.build.packageVersion).toBe("string");
			// The snapshot is detached and frozen, and carries no token, path, pid or env.
			expect(Object.isFrozen(observation)).toBe(true);
			const serialized = JSON.stringify(observation);
			for (const forbidden of ["token", "socket", "port", "pid", "path", "env", agentDir]) {
				expect(serialized.includes(forbidden)).toBe(false);
			}
			expect(Buffer.byteLength(`${serialized}\n`, "utf8")).toBeLessThanOrEqual(8192);
		},
		120_000,
	);
});
