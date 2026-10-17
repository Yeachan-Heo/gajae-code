import { afterEach, describe, expect, it, vi } from "bun:test";
import type { Subprocess } from "bun";
import { BiomeClient } from "../../src/lsp/clients/biome-client";
import { SwiftLintClient } from "../../src/lsp/clients/swiftlint-client";
import {
	getCurrentSessionLaunchEnvironment,
	setCurrentSessionLaunchEnvironment,
} from "../../src/sdk/session-environment";

type SpawnOptions = Bun.SpawnOptions.SpawnOptions<
	Bun.SpawnOptions.Writable,
	Bun.SpawnOptions.Readable,
	Bun.SpawnOptions.Readable
>;

type SpawnCall = { cmd: string[]; options: SpawnOptions };

function createTextStream(text: string): ReadableStream<Uint8Array> {
	const body = new Response(text).body;
	if (!body) throw new Error("Failed to create response stream.");
	return body;
}

function createFakeProcess(stdout: string): Subprocess {
	return {
		pid: 12345,
		stdout: createTextStream(stdout),
		stderr: createTextStream(""),
		exited: Promise.resolve(0),
	} as Subprocess;
}

function createSpawnMock(calls: SpawnCall[]) {
	function mockSpawn(options: SpawnOptions & { cmd: string[] }): Subprocess;
	function mockSpawn(cmd: string[], options?: SpawnOptions): Subprocess;
	function mockSpawn(first: string[] | (SpawnOptions & { cmd: string[] }), second?: SpawnOptions): Subprocess {
		if (Array.isArray(first)) calls.push({ cmd: first, options: second ?? ({} as SpawnOptions) });
		else {
			const { cmd, ...options } = first;
			calls.push({ cmd, options });
		}
		return createFakeProcess(calls.length === 1 ? '{"diagnostics":[]}' : "[]");
	}
	return mockSpawn;
}

afterEach(() => {
	vi.restoreAllMocks();
});

describe("CLI linter session environment", () => {
	it("passes session overrides and unsets to Biome and SwiftLint subprocesses", async () => {
		const previousSessionEnvironment = getCurrentSessionLaunchEnvironment();
		const previousMarker = process.env.SESSION_ENV_MARKER;
		const previousRemoved = process.env.SESSION_ENV_REMOVED;
		process.env.SESSION_ENV_MARKER = "inherited-value";
		process.env.SESSION_ENV_REMOVED = "must-not-reach-child";
		setCurrentSessionLaunchEnvironment({
			env: { SESSION_ENV_MARKER: "session-value" },
			unsetEnv: ["SESSION_ENV_REMOVED"],
		});

		const spawnCalls: SpawnCall[] = [];
		vi.spyOn(Bun, "spawn").mockImplementation(createSpawnMock(spawnCalls));
		const config = { command: "linter", resolvedCommand: "/test/linter", fileTypes: [], rootMarkers: [] };
		const biome = new BiomeClient(config, "/test");
		const swiftLint = new SwiftLintClient(config, "/test");

		try {
			await biome.lint("/test/file.ts");
			await swiftLint.lint("/test/file.swift");

			expect(spawnCalls).toHaveLength(2);
			for (const call of spawnCalls) {
				expect(call.options.env?.SESSION_ENV_MARKER).toBe("session-value");
				expect(call.options.env?.SESSION_ENV_REMOVED).toBeUndefined();
			}
		} finally {
			setCurrentSessionLaunchEnvironment(previousSessionEnvironment);
			if (previousMarker === undefined) delete process.env.SESSION_ENV_MARKER;
			else process.env.SESSION_ENV_MARKER = previousMarker;
			if (previousRemoved === undefined) delete process.env.SESSION_ENV_REMOVED;
			else process.env.SESSION_ENV_REMOVED = previousRemoved;
		}
	});
});
