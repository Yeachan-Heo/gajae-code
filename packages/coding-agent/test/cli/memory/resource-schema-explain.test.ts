import { describe, expect, it } from "bun:test";

import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { SCHEMA_REGISTRY, SCHEMA_VERSIONS } from "@gajae-code/memory-core";
import { type MemoryCommandArgs, type MemoryCommandDependencies, runMemoryCommand } from "../../../src/cli/memory";

type CapturedOutput = {
	stdout: string;
	stderr: string;
	exitCode: number | string | undefined;
};

const AS_OF = "2026-07-29T00:00:00.000Z";
const PRIVATE_BODY = "private lattice body that must never reach explain output";
const VOLATILE_BODY = "volatile private body that must never reach explain hints";
let captureQueue: Promise<void> = Promise.resolve();

async function captureOutput(runAction: () => Promise<void>): Promise<CapturedOutput> {
	const previousCapture = captureQueue;
	let release!: () => void;
	captureQueue = new Promise<void>(resolve => {
		release = resolve;
	});
	await previousCapture;

	const originalStdoutWrite = process.stdout.write;
	const originalStderrWrite = process.stderr.write;
	const originalExitCode = process.exitCode;
	let stdout = "";
	let stderr = "";
	process.stdout.write = ((chunk: string | Uint8Array): boolean => {
		stdout += typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk);
		return true;
	}) as typeof process.stdout.write;
	process.stderr.write = ((chunk: string | Uint8Array): boolean => {
		stderr += typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk);
		return true;
	}) as typeof process.stderr.write;
	process.exitCode = 0;

	try {
		await runAction();
		return { stdout, stderr, exitCode: process.exitCode };
	} finally {
		process.stdout.write = originalStdoutWrite;
		process.stderr.write = originalStderrWrite;
		process.exitCode = originalExitCode ?? 0;
		release();
	}
}

function dependenciesFor(agentDir: string): MemoryCommandDependencies {
	return {
		settings: { getAgentDir: () => agentDir },
		cwd: agentDir,
		clock: () => new Date(AS_OF),
		git: { repo: { resolve: async () => null }, remote: { list: async () => [], url: async () => undefined } },
		env: {},
	};
}

function command(
	action: MemoryCommandArgs["action"],
	value?: string,
	flags: MemoryCommandArgs["flags"] = {},
): MemoryCommandArgs {
	return { action, value, flags };
}

function document(id: string, sensitivity: string, body: string, volatility = "stable"): string {
	return [
		"---",
		"schemaVersion: gajae.memory.document.v1",
		`id: ${id}`,
		"type: fact",
		"scope: global",
		"authority: user-confirmed",
		`volatility: ${volatility}`,
		`sensitivity: ${sensitivity}`,
		"status: active",
		`created: ${AS_OF}`,
		`updated: ${AS_OF}`,
		"aliases: [needle]",
		"supersedes: []",
		"verification:",
		"  provider: local",
		`  resource: ${id}`,
		`  id: ${id}`,
		"---",
		`# ${id}`,
		body,
		"",
	].join("\n");
}

async function withFixture(runAction: (deps: MemoryCommandDependencies) => Promise<void>): Promise<void> {
	const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-memory-resource-explain-"));
	try {
		const deps = dependenciesFor(agentDir);
		const init = await captureOutput(() => runMemoryCommand(command("init"), deps));
		expect(init).toMatchObject({ stderr: "", exitCode: 0 });
		await fs.writeFile(
			path.join(agentDir, "memory", "global", "fixture.md"),
			document("resource-explain-fixture", "public-safe", "The deterministic needle is present here."),
			{ mode: 0o600 },
		);
		await fs.writeFile(
			path.join(agentDir, "memory", "global", "secret-lattice.md"),
			document("resource-explain-private", "private", `The needle is here too: ${PRIVATE_BODY}`),
			{ mode: 0o600 },
		);
		await fs.writeFile(
			path.join(agentDir, "memory", "global", "volatile-private.md"),
			document("resource-explain-volatile", "private", `The needle drifts: ${VOLATILE_BODY}`, "volatile"),
			{ mode: 0o600 },
		);
		await runAction(deps);
	} finally {
		await fs.rm(agentDir, { recursive: true, force: true });
	}
}

/** Minimal structural validator: the repository ships no JSON-schema runtime. */
function assertMatchesSchema(payload: unknown, schema: unknown, pointer = "$", root: unknown = schema): void {
	let node = schema as Record<string, unknown>;
	if (typeof node.$ref === "string") {
		const resolved = node.$ref
			.replace(/^#\//, "")
			.split("/")
			.reduce<unknown>((current, key) => (current as Record<string, unknown> | undefined)?.[key], root);
		expect(resolved, `${pointer} -> ${node.$ref}`).toBeDefined();
		node = resolved as Record<string, unknown>;
	}
	if (Array.isArray(node.enum)) {
		expect(node.enum as unknown[], pointer).toContain(payload);
		return;
	}
	if (typeof node.const === "string") {
		expect(payload, pointer).toBe(node.const);
		return;
	}
	if (Array.isArray(node.oneOf)) {
		const branches = node.oneOf as unknown[];
		const matched = branches.some(candidate => {
			try {
				assertMatchesSchema(payload, candidate, pointer, root);
				return true;
			} catch {
				return false;
			}
		});
		expect(matched, `${pointer} matched no oneOf branch`).toBe(true);
		return;
	}
	if (Array.isArray(node.type)) {
		const actual = payload === null ? "null" : typeof payload;
		expect(node.type as string[], pointer).toContain(actual);
		return;
	}
	switch (node.type) {
		case "object": {
			expect(typeof payload, pointer).toBe("object");
			expect(payload, pointer).not.toBeNull();
			const value = payload as Record<string, unknown>;
			const properties = (node.properties ?? {}) as Record<string, unknown>;
			for (const required of (node.required ?? []) as string[]) {
				expect(Object.hasOwn(value, required), `${pointer}.${required} is required`).toBe(true);
			}
			if (node.additionalProperties === false) {
				for (const key of Object.keys(value)) {
					expect(Object.hasOwn(properties, key), `${pointer}.${key} is not declared`).toBe(true);
				}
			}
			for (const [key, childSchema] of Object.entries(properties)) {
				if (!Object.hasOwn(value, key)) continue;
				assertMatchesSchema(value[key], childSchema, `${pointer}.${key}`, root);
			}
			return;
		}
		case "array": {
			expect(Array.isArray(payload), pointer).toBe(true);
			const items = node.items;
			if (items === undefined) return;
			for (const [index, item] of (payload as unknown[]).entries()) {
				assertMatchesSchema(item, items, `${pointer}[${index}]`, root);
			}
			return;
		}
		case "string":
			expect(typeof payload, pointer).toBe("string");
			if (typeof node.minLength === "number") {
				expect((payload as string).length, pointer).toBeGreaterThanOrEqual(node.minLength);
			}
			return;
		case "integer":
			expect(Number.isSafeInteger(payload), pointer).toBe(true);
			if (typeof node.minimum === "number") {
				expect(payload as number, pointer).toBeGreaterThanOrEqual(node.minimum);
			}
			return;
		case "boolean":
			expect(typeof payload, pointer).toBe("boolean");
			return;
		default:
			return;
	}
}

describe("memory resource envelope and explain receipt", () => {
	it("validates real get and resolve payloads against the registered resource schema", async () => {
		await withFixture(async deps => {
			const resolveJson = await captureOutput(() =>
				runMemoryCommand(command("resolve", "global://fixture.md", { json: true }), deps),
			);
			const getJson = await captureOutput(() =>
				runMemoryCommand(command("get", "global://fixture.md", { json: true }), deps),
			);

			expect(resolveJson).toMatchObject({ stderr: "", exitCode: 0 });
			expect(getJson).toMatchObject({ stderr: "", exitCode: 0 });

			const resolvePayload = JSON.parse(resolveJson.stdout) as Record<string, unknown>;
			const getPayload = JSON.parse(getJson.stdout) as Record<string, unknown>;
			expect(resolvePayload.schemaVersion).toBe(SCHEMA_VERSIONS.resource);
			expect(getPayload.schemaVersion).toBe(SCHEMA_VERSIONS.resource);

			assertMatchesSchema(resolvePayload, SCHEMA_REGISTRY.resource, "resolve", SCHEMA_REGISTRY.resource);
			assertMatchesSchema(getPayload, SCHEMA_REGISTRY.resource, "get", SCHEMA_REGISTRY.resource);
		});
	});

	it("selects machine output from the documented --format json spelling", async () => {
		await withFixture(async deps => {
			const formatted = await captureOutput(() =>
				runMemoryCommand(command("recall", "needle", { format: "json", explain: true }), deps),
			);
			const human = await captureOutput(() =>
				runMemoryCommand(command("recall", "needle", { format: "text", json: true }), deps),
			);
			const invalid = await captureOutput(() =>
				runMemoryCommand(command("recall", "needle", { format: "yaml" }), deps),
			);

			expect(formatted).toMatchObject({ stderr: "", exitCode: 0 });
			const payload = JSON.parse(formatted.stdout) as Record<string, unknown>;
			expect(payload.schemaVersion).toBe(SCHEMA_VERSIONS.recall);
			expect(payload.explain).toBeDefined();

			expect(human.exitCode).toBe(0);
			expect(() => JSON.parse(human.stdout)).toThrow();

			expect(invalid.exitCode).toBe(2);
			expect(invalid.stderr).toContain("invalid-input");
			expect(JSON.parse(invalid.stdout)).toMatchObject({
				schemaVersion: SCHEMA_VERSIONS.error,
				code: "invalid-input",
				exitCode: 2,
			});
		});
	});

	it("keeps explained recall and search payloads valid against their registered schemas", async () => {
		await withFixture(async deps => {
			const recalled = await captureOutput(() =>
				runMemoryCommand(command("recall", "needle", { format: "json", explain: true }), deps),
			);
			const searched = await captureOutput(() =>
				runMemoryCommand(command("search", "needle", { format: "json", explain: true }), deps),
			);

			expect(recalled).toMatchObject({ stderr: "", exitCode: 0 });
			expect(searched).toMatchObject({ stderr: "", exitCode: 0 });

			const recallPayload = JSON.parse(recalled.stdout) as Record<string, unknown>;
			const searchPayload = JSON.parse(searched.stdout) as Record<string, unknown>;
			expect((recallPayload.explain as Record<string, unknown>).sourcesSelected).toBeDefined();
			expect((searchPayload.explain as Record<string, unknown>).sourcesSelected).toBeDefined();

			assertMatchesSchema(recallPayload, SCHEMA_REGISTRY.recall, "recall", SCHEMA_REGISTRY.recall);
			assertMatchesSchema(searchPayload, SCHEMA_REGISTRY.searchResult, "search", SCHEMA_REGISTRY.searchResult);
		});
	});

	it("emits an explain receipt whose selected sources match the recall sources", async () => {
		await withFixture(async deps => {
			const plain = await captureOutput(() => runMemoryCommand(command("recall", "needle", { json: true }), deps));
			const explained = await captureOutput(() =>
				runMemoryCommand(command("recall", "needle", { json: true, explain: true }), deps),
			);

			expect(plain).toMatchObject({ stderr: "", exitCode: 0 });
			expect(explained).toMatchObject({ stderr: "", exitCode: 0 });

			const plainPayload = JSON.parse(plain.stdout) as Record<string, unknown>;
			const explainedPayload = JSON.parse(explained.stdout) as Record<string, unknown>;
			expect(plainPayload.explain).toBeUndefined();

			const explain = explainedPayload.explain as Record<string, unknown>;
			expect(explain).toBeDefined();
			expect(explain.sourcesSelected).toEqual(explainedPayload.sources);
			expect(explain.sourcesSelected).toEqual(plainPayload.sources);
			expect(Array.isArray(explain.routesConsidered)).toBe(true);
			expect(explain.stageCounts).toBeDefined();
			expect(explain.budget).toBeDefined();
			expect(Array.isArray(explain.exclusionReasons)).toBe(true);
			expect(Array.isArray(explain.rankingFactors)).toBe(true);
		});
	});

	it("never duplicates private body text into the explain receipt", async () => {
		await withFixture(async deps => {
			const explained = await captureOutput(() =>
				runMemoryCommand(command("recall", "needle", { json: true, explain: true }), deps),
			);

			expect(explained).toMatchObject({ stderr: "", exitCode: 0 });
			const payload = JSON.parse(explained.stdout) as Record<string, unknown>;
			expect(JSON.stringify(payload.explain)).not.toContain(PRIVATE_BODY);
			expect(explained.stdout).not.toContain(PRIVATE_BODY);

			// Hint projection is claim-key-only; the key-vs-value proof lives in
			// memory-core's recall-resolution suite, which produces volatile claims.
			expect(explained.stdout).not.toContain(VOLATILE_BODY);
		});
	});

	it("reports timings under explain and omits them for deterministic runs", async () => {
		await withFixture(async deps => {
			const explained = await captureOutput(() =>
				runMemoryCommand(command("recall", "needle", { json: true, explain: true }), deps),
			);
			const deterministic = await captureOutput(() =>
				runMemoryCommand(
					command("recall", "needle", { json: true, explain: true, deterministic: true, asOf: AS_OF }),
					deps,
				),
			);

			expect(explained).toMatchObject({ stderr: "", exitCode: 0 });
			expect(deterministic).toMatchObject({ stderr: "", exitCode: 0 });

			const explain = (JSON.parse(explained.stdout) as Record<string, unknown>).explain as Record<string, unknown>;
			const deterministicExplain = (JSON.parse(deterministic.stdout) as Record<string, unknown>).explain as Record<
				string,
				unknown
			>;
			expect(explain.timings).toBeDefined();
			expect(deterministicExplain.timings).toBeUndefined();
		});
	});
});
