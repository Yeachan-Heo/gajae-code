import { describe, expect, it } from "bun:test";
import * as path from "node:path";
import type { WorkerInbound, WorkerOutbound } from "../src/tools/browser/tab-protocol";
import { smokeTestTabWorker, smokeTestTabWorkerWithWorkerForTest } from "../src/tools/browser/tab-worker-smoke";

const packageDir = path.resolve(import.meta.dir, "..");
const compiledLiteral = "./packages/coding-agent/src/tools/browser/tab-worker-entry.ts";
const sourceEntrypoint = "./src/tools/browser/tab-worker-entry.ts";
const workspaceUtilsDir = path.resolve(packageDir, "../utils/src");
const workspaceUtilsSpecifier = "@gajae-code/utils/";

class FakeSmokeWorker {
	#listeners = new Map<string, Set<EventListener>>();
	readonly sent: WorkerInbound[] = [];
	terminated = false;

	postMessage(message: WorkerInbound): void {
		this.sent.push(message);
	}

	addEventListener(type: string, listener: EventListener): void {
		const listeners = this.#listeners.get(type) ?? new Set<EventListener>();
		listeners.add(listener);
		this.#listeners.set(type, listeners);
	}

	removeEventListener(type: string, listener: EventListener): void {
		this.#listeners.get(type)?.delete(listener);
	}

	terminate(): void {
		this.terminated = true;
	}

	emit(message: WorkerOutbound): void {
		for (const listener of this.#listeners.get("message") ?? []) {
			listener(new MessageEvent("message", { data: message }));
		}
	}
}

const forbiddenRuntimeSpecifiers = [
	/^@gajae-code\/utils$/,
	/^@gajae-code\/natives(?:\/|$)/,
	/^@gajae-code\/tui(?:\/|$)/,
] as const;
const forbiddenRuntimePaths = /(?:^|\/)(?:path-utils|render-utils)(?:\.ts)?$|(?:^|\/)internal-urls(?:\/|$)/;

function runtimeImportSpecifiers(source: string): string[] {
	const specifiers = new Set<string>();
	const staticImport = /^\s*import\s+(?!type\b)(?:[\s\S]*?\s+from\s+)?["']([^"']+)["'];?/gm;
	const reExport = /^\s*export\s+(?!type\b)[\s\S]*?\s+from\s+["']([^"']+)["'];?/gm;
	const dynamicImport = /\bimport\(\s*["']([^"']+)["']\s*\)/g;
	for (const pattern of [staticImport, reExport, dynamicImport]) {
		for (const match of source.matchAll(pattern)) specifiers.add(match[1]);
	}
	return [...specifiers];
}

async function resolveRelativeModule(from: string, specifier: string): Promise<string | undefined> {
	const base = path.resolve(path.dirname(from), specifier);
	const candidates = [
		base,
		`${base}.ts`,
		`${base}.tsx`,
		`${base}.mts`,
		base.endsWith(".js") ? `${base.slice(0, -3)}.ts` : "",
		path.join(base, "index.ts"),
	];
	for (const candidate of candidates) {
		if (candidate && (await Bun.file(candidate).exists())) return candidate;
	}
	return undefined;
}

async function resolveWorkspaceUtilsModule(specifier: string): Promise<string> {
	const subpath = specifier.slice(workspaceUtilsSpecifier.length);
	const base = path.resolve(workspaceUtilsDir, subpath);
	const relativePath = path.relative(workspaceUtilsDir, base);
	if (!subpath || relativePath.startsWith("..") || path.isAbsolute(relativePath)) {
		throw new Error(`Unsafe workspace utility subpath: ${specifier}`);
	}

	const resolved = await resolveRelativeModule(path.join(workspaceUtilsDir, "index.ts"), `./${subpath}`);
	if (!resolved) {
		throw new Error(`Unresolved workspace utility subpath: ${specifier}`);
	}
	return resolved;
}

async function resolveRuntimeModule(from: string, specifier: string): Promise<string | undefined> {
	if (specifier.startsWith(".")) return await resolveRelativeModule(from, specifier);
	if (specifier.startsWith(workspaceUtilsSpecifier)) return await resolveWorkspaceUtilsModule(specifier);
	return undefined;
}

async function collectRuntimeImportGraph(root: string): Promise<Map<string, string[]>> {
	const graph = new Map<string, string[]>();
	const pending = [root];
	while (pending.length > 0) {
		const file = pending.pop();
		if (!file || graph.has(file)) continue;
		const edges: string[] = [];
		graph.set(file, edges);
		for (const specifier of runtimeImportSpecifiers(await Bun.file(file).text())) {
			edges.push(specifier);
			const isRelative = specifier.startsWith(".");
			if (isRelative) {
				const extension = path.extname(specifier);
				if (extension && ![".ts", ".tsx", ".mts", ".cts", ".js", ".mjs", ".cjs"].includes(extension)) {
					continue;
				}
			}
			const resolved = await resolveRuntimeModule(file, specifier);
			if (isRelative || specifier.startsWith(workspaceUtilsSpecifier)) {
				expect(resolved, `${path.relative(packageDir, file)} imports unresolved ${specifier}`).toBeDefined();
				if (resolved) pending.push(resolved);
			}
		}
	}
	return graph;
}

function formatGraphPath(file: string): string {
	return path.relative(packageDir, file).replaceAll(path.sep, "/");
}

function expectNativeFreeRuntimeGraph(graph: Map<string, string[]>): void {
	for (const [file, edges] of graph) {
		const displayFile = formatGraphPath(file);
		expect(displayFile, `${displayFile} is a forbidden runtime barrel`).not.toMatch(forbiddenRuntimePaths);
		for (const specifier of edges) {
			const detail = `${displayFile} -> ${specifier}`;
			expect(specifier, `${detail} is a forbidden runtime import`).not.toMatch(
				new RegExp(forbiddenRuntimeSpecifiers.map(pattern => pattern.source).join("|")),
			);
		}
	}
}

async function tabWorkerRuntimeGraph(): Promise<Map<string, string[]>> {
	return await collectRuntimeImportGraph(path.join(packageDir, "src/tools/browser/tab-worker-entry.ts"));
}

function expectGraphToContain(graph: Map<string, string[]>, file: string): void {
	expect([...graph.keys()].map(formatGraphPath)).toContain(file);
}

function expectGraphNotToContain(graph: Map<string, string[]>, file: string): void {
	expect([...graph.keys()].map(formatGraphPath)).not.toContain(file);
}

/**
 * The runtime test is host evidence only: it exercises source-worker startup
 * on the current platform without launching Chrome. macos-14 hosted execution
 * of `gjc --smoke-test` remains the Darwin compiled-binary contract.
 */
describe("issue #2598 — tab worker source and compiled smoke contract", () => {
	it("boots the actual source tab worker and closes it without a browser", async () => {
		await expect(smokeTestTabWorker()).resolves.toBeUndefined();
	});

	it("requires the ordered bootstrap-ready, close, closed smoke handshake", async () => {
		const worker = new FakeSmokeWorker();
		const pending = smokeTestTabWorkerWithWorkerForTest(worker, 1_000);
		expect(worker.sent).toEqual([{ type: "bootstrap", version: 1, mode: "native-free" }]);

		worker.emit({ type: "bootstrap-ready", version: 1, mode: "native-free" });
		expect(worker.sent).toEqual([{ type: "bootstrap", version: 1, mode: "native-free" }, { type: "close" }]);
		worker.emit({ type: "closed" });

		await expect(pending).resolves.toBeUndefined();
		expect(worker.terminated).toBe(true);
	});

	it("fails smoke when the worker closes before bootstrap confirmation", async () => {
		const worker = new FakeSmokeWorker();
		const pending = smokeTestTabWorkerWithWorkerForTest(worker, 1_000);
		worker.emit({ type: "closed" });

		await expect(pending).rejects.toThrow(
			`Tab worker startup failed (stage=protocol-phase, mode=native-free, platform=${process.platform}).`,
		);
		expect(worker.sent).toEqual([{ type: "bootstrap", version: 1, mode: "native-free" }]);
		expect(worker.terminated).toBe(true);
	});

	it("keeps the compile-safe worker literal, source URL, and explicit compile entrypoint", async () => {
		const [smokeSource, supervisorSource, compileArgsSource] = await Promise.all([
			Bun.file(path.join(packageDir, "src/tools/browser/tab-worker-smoke.ts")).text(),
			Bun.file(path.join(packageDir, "src/tools/browser/tab-supervisor.ts")).text(),
			Bun.file(path.join(packageDir, "scripts/compile-args.ts")).text(),
		]);

		for (const source of [smokeSource, supervisorSource]) {
			expect(source).toContain(`new Worker("${compiledLiteral}"`);
			expect(source).toMatch(/new URL\("\.\/tab-worker-entry\.ts",\s*import\.meta\.url\)/);
			expect(source).toContain("isCompiledBinary()");
		}
		expect(compileArgsSource).toContain(`"${compiledLiteral}"`);
		expect(compileArgsSource).toContain(`"${sourceEntrypoint}"`);
	});

	it("keeps the recursive tab-worker runtime import graph native-free", async () => {
		const graph = await tabWorkerRuntimeGraph();

		expectGraphToContain(graph, "src/tools/browser/tab-worker.ts");
		expectGraphToContain(graph, "src/tools/browser/readable.ts");
		expectGraphToContain(graph, "src/web/scrapers/html-to-markdown.ts");
		expectGraphToContain(graph, "src/tools/browser/tab-worker-path-resolver.ts");
		expectGraphToContain(graph, "../utils/src/abortable.ts");
		expectGraphToContain(graph, "../utils/src/snowflake.ts");
		expectGraphNotToContain(graph, "src/tools/path-utils.ts");
		expectGraphNotToContain(graph, "src/web/scrapers/types.ts");
		expectNativeFreeRuntimeGraph(graph);
	});

	it("rejects workspace utility subpaths that reach native bindings", async () => {
		const graph = await collectRuntimeImportGraph(await resolveWorkspaceUtilsModule("@gajae-code/utils/procmgr"));

		expectGraphToContain(graph, "../utils/src/procmgr.ts");
		expect(() => expectNativeFreeRuntimeGraph(graph)).toThrow();
	});

	it("rejects unsafe or unresolved workspace utility subpaths without falling back to package resolution", async () => {
		await expect(resolveWorkspaceUtilsModule("@gajae-code/utils/not-a-runtime-module")).rejects.toThrow(
			"Unresolved workspace utility subpath",
		);
		await expect(resolveWorkspaceUtilsModule("@gajae-code/utils/../procmgr")).rejects.toThrow(
			"Unsafe workspace utility subpath",
		);
	});

	it("wires the CLI smoke after its owner-native checks", async () => {
		const source = await Bun.file(path.join(packageDir, "src/cli.ts")).text();
		const nativeCheck = source.indexOf(
			'throw new Error("smoke-test: native fuzzy exports missing from embedded addon")',
		);
		const tabWorkerSmoke = source.indexOf("await smokeTestTabWorker()");

		expect(tabWorkerSmoke).toBeGreaterThan(nativeCheck);
	});
});
