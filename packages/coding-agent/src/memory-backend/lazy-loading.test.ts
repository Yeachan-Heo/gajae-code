import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "../config/settings";
import { offBackend } from "./off-backend";
import { resolveMemoryBackend, resolveMemoryBackendId } from "./resolve";
import { createMemoryBackendService } from "./service";

const repoRoot = path.resolve(import.meta.dir, "../../../..");
const traceLoader = path.join(repoRoot, "scripts", "trace-loader.ts");
const settingsModule = path.join(repoRoot, "packages", "coding-agent", "src", "config", "settings.ts");
const serviceModule = path.join(repoRoot, "packages", "coding-agent", "src", "memory-backend", "service.ts");

async function runOffProbe(): Promise<{ stdout: string; records: Array<Record<string, unknown>> }> {
	const tempDir = await mkdtemp(path.join(os.tmpdir(), "gjc-w1c-memory-"));
	const probePath = path.join(tempDir, "probe.ts");
	const tracePath = path.join(tempDir, "trace.json");
	const settingsImport = JSON.stringify(settingsModule);
	const serviceImport = JSON.stringify(serviceModule);
	await Bun.write(
		probePath,
		[
			`import { Settings } from ${settingsImport};`,
			`import { createMemoryBackendService } from ${serviceImport};`,
			`const settings = Settings.isolated({ "memory.backend": "off" });`,
			`const backend = await createMemoryBackendService(settings).get("off-probe");`,
			`console.log("W1C_MEMORY_OFF_PROBE_OK", backend.id);`,
		].join("\n"),
	);

	const child = Bun.spawn(["bun", "--preload", traceLoader, probePath], {
		cwd: repoRoot,
		env: { ...process.env, GJC_TRACE_OUT: tracePath },
		stdout: "pipe",
		stderr: "pipe",
	});
	const [exitCode, stdout] = await Promise.all([child.exited, new Response(child.stdout).text()]);
	await new Response(child.stderr).text();
	try {
		expect(exitCode).toBe(0);
		expect(stdout).toContain("W1C_MEMORY_OFF_PROBE_OK off");
		const records = JSON.parse(await Bun.file(tracePath).text()) as Array<Record<string, unknown>>;
		return { stdout, records };
	} finally {
		await rm(tempDir, { recursive: true, force: true });
	}
}

describe("memory backend lazy loading", () => {
	test("off keeps backend graphs out of the module trace", async () => {
		const { records } = await runOffProbe();
		const loadedPaths = records.map(record => String(record.resolved ?? record.specifier ?? ""));
		expect(loadedPaths.filter(item => /src\/(?:memories|hindsight|stt)\//.test(item))).toEqual([]);
	});

	test("identity resolution is synchronous and implementation-free", () => {
		for (const [backend, expectedId] of [
			["off", "off"],
			["local", "local"],
			["hindsight", "hindsight"],
		] as const) {
			const settings = Settings.isolated({ "memory.backend": backend });
			expect(resolveMemoryBackendId(settings)).toBe(expectedId);
			expect(resolveMemoryBackend(settings).id).toBe(expectedId);
		}
	});

	test("enabled selections materialize the matching backend", async () => {
		for (const backendId of ["local", "hindsight"] as const) {
			const settings = Settings.isolated({ "memory.backend": backendId });
			const service = createMemoryBackendService(settings);
			const backend = await service.get(`enabled-${backendId}`);
			expect(backend.id).toBe(backendId);
			expect(service.status().state).toBe("ready");
			await service.dispose();
		}

		const offService = createMemoryBackendService(Settings.isolated({ "memory.backend": "off" }));
		expect(await offService.get("enabled-off")).toBe(offBackend);
		await offService.dispose();
	});
});
