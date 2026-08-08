import { describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

describe("SDK session import graph", () => {
	test("notifications-inactive session import does not load the notification bus graph", async () => {
		const repositoryRoot = path.resolve(import.meta.dir, "../../../../..");
		const tracePath = path.join("/tmp", `sdk-session-import-${process.pid}-${randomUUID()}.json`);
		const processHandle = Bun.spawn(
			[
				"bun",
				"--preload",
				path.join(repositoryRoot, "scripts/trace-loader.ts"),
				"-e",
				'await import("./packages/coding-agent/src/sdk/session.ts")',
			],
			{
				cwd: repositoryRoot,
				env: { ...process.env, GJC_TRACE_OUT: tracePath },
				stdout: "ignore",
				stderr: "ignore",
			},
		);
		try {
			expect(await processHandle.exited).toBe(0);
			const records = JSON.parse(await fs.readFile(tracePath, "utf8")) as Array<{
				resolved?: string;
				kind?: string;
			}>;
			// `source-scan` records are literal lazy dynamic-import mentions discovered by
			// parsing loaded sources; they are catalog data, not loaded modules. The W1b
			// contract is that the notification bus graph is never LOADED here.
			const loaded = records.filter(record => record.kind !== "source-scan");
			expect(loaded.filter(record => record.resolved?.includes("/src/sdk/bus/") === true)).toEqual([]);
		} finally {
			await fs.rm(tracePath, { force: true });
		}
	});
	test("SDK session cold import does not load discoverable implementations, then loads browser on descriptor first use", async () => {
		const repositoryRoot = path.resolve(import.meta.dir, "../../../../..");
		const coldTracePath = path.join(os.tmpdir(), `sdk-session-cold-${process.pid}-${randomUUID()}.json`);
		const useTracePath = path.join(os.tmpdir(), `sdk-session-use-${process.pid}-${randomUUID()}.json`);
		const firstUseEntry = path.join(os.tmpdir(), `sdk-session-first-use-${process.pid}-${randomUUID()}.ts`);
		await fs.writeFile(
			firstUseEntry,
			'const { BUILTIN_TOOL_DESCRIPTORS } = await import("' +
				path.join(repositoryRoot, "packages/coding-agent/src/tools/descriptors.ts") +
				'");\nawait BUILTIN_TOOL_DESCRIPTORS.browser.load({});\n',
			"utf8",
		);
		const runTrace = async (tracePath: string, entry: string[]) => {
			const child = Bun.spawn(["bun", "--preload", path.join(repositoryRoot, "scripts/trace-loader.ts"), ...entry], {
				cwd: repositoryRoot,
				env: { ...process.env, GJC_TRACE_OUT: tracePath },
				stdout: "ignore",
				stderr: "ignore",
			});
			expect(await child.exited).toBe(0);
			return JSON.parse(await fs.readFile(tracePath, "utf8")) as Array<{ resolved?: string; kind?: string }>;
		};
		try {
			const coldRecords = await runTrace(coldTracePath, [
				"-e",
				'await import("./packages/coding-agent/src/sdk/session.ts")',
			]);
			const coldLoaded = coldRecords.filter(record => record.kind !== "source-scan");
			const forbidden = [
				"/src/tools/browser.",
				"/src/tools/computer.",
				"/src/tools/eval.",
				"/src/task/index.",
				"/src/web/search/index.",
			];
			expect(
				coldLoaded
					.filter(record => forbidden.some(fragment => record.resolved?.includes(fragment)))
					.map(record => record.resolved),
			).toEqual([]);

			const firstUseRecords = await runTrace(useTracePath, [firstUseEntry]);
			const firstUseLoaded = firstUseRecords.filter(record => record.kind !== "source-scan");
			expect(firstUseLoaded.some(record => record.resolved?.includes("/src/tools/browser."))).toBe(true);
		} finally {
			await fs.rm(coldTracePath, { force: true });
			await fs.rm(useTracePath, { force: true });
			await fs.rm(firstUseEntry, { force: true });
		}
	});
	test("trace provenance keeps both source-scan and runtime-load records for one dynamic edge", async () => {
		const repositoryRoot = path.resolve(import.meta.dir, "../../../../..");
		const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-trace-provenance-"));
		const moduleAPath = path.join(tempRoot, "module-a.ts");
		const moduleBPath = path.join(tempRoot, "module-b.ts");
		const entryPath = path.join(tempRoot, "entry.ts");
		const tracePath = path.join(tempRoot, "trace.json");
		await fs.writeFile(moduleBPath, "export const value = 42;\n", "utf8");
		await fs.writeFile(
			moduleAPath,
			'const moduleB = await import("./module-b.ts");\nexport const value = moduleB.value;\n',
			"utf8",
		);
		await fs.writeFile(entryPath, 'await import("./module-a.ts");\n', "utf8");
		try {
			const processHandle = Bun.spawn(
				["bun", "--preload", path.join(repositoryRoot, "scripts/trace-loader.ts"), entryPath],
				{
					cwd: repositoryRoot,
					env: { ...process.env, GJC_TRACE_OUT: tracePath },
					stdout: "ignore",
					stderr: "ignore",
				},
			);
			expect(await processHandle.exited).toBe(0);
			const records = JSON.parse(await fs.readFile(tracePath, "utf8")) as Array<{
				resolved?: string;
				importer?: string;
				kind?: string;
			}>;
			const moduleA = await fs.realpath(moduleAPath);
			const moduleB = await fs.realpath(moduleBPath);
			const edge = records.filter(record => record.importer === moduleA && record.resolved === moduleB);
			expect(edge.some(record => record.kind === "source-scan")).toBe(true);
			expect(edge.some(record => record.kind !== "source-scan")).toBe(true);
			const loadedGraph = records.filter(record => record.kind !== "source-scan");
			expect(loadedGraph.some(record => record.importer === moduleA && record.resolved === moduleB)).toBe(true);
		} finally {
			await fs.rm(tempRoot, { recursive: true, force: true });
		}
	});
});
