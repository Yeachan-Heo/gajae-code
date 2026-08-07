import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import packageManifest from "../package.json" with { type: "json" };
import * as publicIndex from "../src/index";

const EXPECTED_EXPORT_KEYS = [".", "./package.json", "./schemas", "./schemas/*.json"];
const EXPECTED_RUNTIME_EXPORTS = [
	"EXIT_CODES",
	"MEMORY_ERROR_SCHEMA_VERSION",
	"MEMORY_EXIT_CODES",
	"SCHEMA_REGISTRY",
	"SCHEMA_VERSIONS",
	"apply",
	"applyReceiptSchema",
	"auditSchema",
	"capabilitiesSchema",
	"checkpoint",
	"checkpointSchema",
	"doctor",
	"errorSchema",
	"forget",
	"forgetReceiptSchema",
	"formatMemoryUri",
	"initMemoryRoot",
	"handoffSchema",
	"initReceiptSchema",
	"memoryCapabilities",
	"memoryErrorEnvelope",
	"parseMemoryUri",
	"propose",
	"recall",
	"writeProposalSchema",
	"recallSchema",
	"resolveReadableResource",
	"resolveReadableResourceSync",
	"resolveScopes",
	"resourceSchema",
	"resume",
	"retrievalLedgerEntrySchema",
	"scopeResolutionSchema",
	"search",
	"searchResultSchema",
];
// M6 implements propose/apply/forget as real runtime operations, so the
// removed-value guard now only needs to stay empty of re-added stubs.
const REMOVED_OPERATION_VALUES = [] as const;

interface PackageManifest {
	readonly version: string;
	readonly exports: Record<string, unknown>;
}

const manifest = packageManifest as PackageManifest;
const runtimeIndex = publicIndex as Record<string, unknown>;

function exportedModuleSpecifiers(source: string): string[] {
	return [...source.matchAll(/export\s+(?:(?:type\s+)?(?:\*|\{[\s\S]*?\}))\s+from\s+["']([^"']+)["']/g)].map(
		match => match[1],
	);
}

describe("memory-core public package surface", () => {
	it("declares only the supported package export paths", () => {
		expect(Object.keys(manifest.exports).sort()).toEqual([...EXPECTED_EXPORT_KEYS].sort());
		expect(manifest.exports["./*"]).toBeUndefined();
		expect(manifest.exports["."]).toEqual({
			types: "./src/index.ts",
			import: "./src/index.ts",
		});
		expect(manifest.exports["./schemas"]).toEqual({
			types: "./src/schemas/index.ts",
			import: "./src/schemas/index.ts",
		});
		expect(manifest.exports["./schemas/*.json"]).toBe("./src/schemas/*.json");
		expect(manifest.exports["./package.json"]).toBe("./package.json");
	});

	it("exposes only runtime values from the public index", () => {
		expect(Object.keys(publicIndex).sort()).toEqual([...EXPECTED_RUNTIME_EXPORTS].sort());
		for (const operation of [
			"formatMemoryUri",
			"initMemoryRoot",
			"memoryCapabilities",
			"memoryErrorEnvelope",
			"parseMemoryUri",
			"recall",
			"resolveReadableResource",
			"resolveReadableResourceSync",
			"resolveScopes",
			"resume",
			"search",
		]) {
			expect(typeof runtimeIndex[operation], operation).toBe("function");
		}
		for (const schema of [
			"auditSchema",
			"capabilitiesSchema",
			"checkpoint",
			"checkpointSchema",
			"doctor",
			"errorSchema",
			"handoffSchema",
			"initReceiptSchema",
			"recallSchema",
			"retrievalLedgerEntrySchema",
			"scopeResolutionSchema",
			"searchResultSchema",
		]) {
			expect(runtimeIndex[schema], schema).toBeDefined();
		}
		expect(runtimeIndex.MEMORY_ERROR_SCHEMA_VERSION).toBe("gajae.memory.error.v1");
		expect(runtimeIndex.MEMORY_EXIT_CODES).toEqual({
			success: 0,
			invalidInput: 2,
			notInitialized: 3,
			scopeUnresolved: 4,
			notFound: 5,
			policyDenied: 6,
			conflictRequiresConfirmation: 7,
			malformedDocument: 8,
			staleSource: 9,
			truncated: 10,
			sensitivityViolation: 11,
			lockConflict: 12,
		});
		expect(runtimeIndex.EXIT_CODES).toBe(runtimeIndex.MEMORY_EXIT_CODES);
	});

	it("keeps resolver wrappers runtime-valid and path inspection explicit", async () => {
		const environment = {
			memoryRoot: "/tmp/gjc-memory",
			repository: null,
			sessionId: null,
			now: new Date("2026-07-29T00:00:00.000Z"),
			deterministic: false,
			asOf: null,
		} satisfies publicIndex.MemoryEnvironment;

		const parsed = publicIndex.parseMemoryUri("global://profile.md");
		expect(parsed.ok).toBe(true);
		if (parsed.ok) expect(publicIndex.formatMemoryUri(parsed.value)).toEqual({ ok: true, value: parsed.value.href });

		const scopes = publicIndex.resolveScopes(environment);
		expect(scopes.ok).toBe(true);
		if (scopes.ok) {
			expect(scopes.value.memoryRoot).toBe(environment.memoryRoot);
			expect(scopes.value.scopes[0]).toMatchObject({
				kind: "global",
				relPath: "global",
				root: "/tmp/gjc-memory/global",
				available: true,
				writable: true,
			});
		}

		const invalidScopes = publicIndex.resolveScopes(environment, { registry: 42 });
		expect(invalidScopes.ok).toBe(false);
		if (!invalidScopes.ok) expect(invalidScopes.error.code).toBe("invalid-input");

		const invalidResource = await publicIndex.resolveReadableResource(
			environment,
			{} as publicIndex.ResolveReadableResourceInput,
		);
		expect(invalidResource.ok).toBe(false);
		if (!invalidResource.ok) expect(invalidResource.error.code).toBe("invalid-input");

		const invalidResourceSync = publicIndex.resolveReadableResourceSync(
			environment,
			{} as publicIndex.ResolveReadableResourceInput,
		);
		expect(invalidResourceSync.ok).toBe(false);
		if (!invalidResourceSync.ok) expect(invalidResourceSync.error.code).toBe("invalid-input");
	});

	it("keeps unsupported operation values absent from declarations and runtime surface", async () => {
		const sourcePath = path.join(import.meta.dir, "../src/index.ts");
		const source = await Bun.file(sourcePath).text();
		expect(source).not.toMatch(/export\s+declare\b/);
		for (const operation of REMOVED_OPERATION_VALUES) {
			expect(source).not.toMatch(new RegExp(`export\\s+(?:declare\\s+)?function\\s+${operation}\\b`));
			expect(Object.hasOwn(runtimeIndex, operation), operation).toBe(false);
			expect(runtimeIndex[operation], operation).toBeUndefined();
		}
	});

	it("does not expose AccessGrant or internal storage/policy modules in source exports", async () => {
		const sourcePath = path.join(import.meta.dir, "../src/index.ts");
		const source = await Bun.file(sourcePath).text();
		expect(source).not.toContain("AccessGrant");
		const internalExportPaths = exportedModuleSpecifiers(source).filter(specifier =>
			specifier.split("/").some(segment => segment === "storage" || segment === "policy"),
		);
		expect(internalExportPaths).toEqual([]);
	});

	it("maps public initialization failures to stable sanitized details", async () => {
		const parent = await fs.mkdtemp(path.join(os.tmpdir(), "memory-core-public-init-"));
		const memoryRoot = path.join(parent, "memory-root");
		try {
			await fs.writeFile(memoryRoot, "not a directory\n");
			const environment = {
				memoryRoot,
				repository: null,
				sessionId: null,
				now: new Date("2026-07-29T00:00:00.000Z"),
				deterministic: false,
				asOf: null,
			} satisfies publicIndex.MemoryEnvironment;
			const first = await publicIndex.initMemoryRoot(environment);
			const second = await publicIndex.initMemoryRoot(environment);
			expect(first).toEqual(second);
			expect(first).toEqual({
				ok: false,
				error: {
					code: "policy-denied",
					exitCode: 6,
					destination: "global-canonical",
					reason: "memory initialization denied: root-not-directory",
				},
			});
			expect(JSON.stringify(first)).not.toContain(parent);
			expect(JSON.stringify(first)).not.toContain("MemoryBootstrapError");
		} finally {
			await fs.rm(parent, { recursive: true, force: true });
		}
	});

	it("keeps the package version coupled to its manifest", () => {
		const capabilities = (runtimeIndex.memoryCapabilities as () => { readonly packageVersion: string })();
		expect(capabilities.packageVersion).toBe(manifest.version);
	});
});
