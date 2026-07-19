import { describe, expect, spyOn, test } from "bun:test";
import * as path from "node:path";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import {
	analyzeSource,
	formatFinding,
	main,
	RULES,
	sortFindings,
	verifyWorktreeReportCapabilities,
} from "./check-worktree-report-capabilities";

const fixture = "scripts/fixtures/worktree-report-capabilities";
const productionRoots = [
	"packages/coding-agent/src/cli.ts",
	"packages/coding-agent/src/commands/worktree.ts",
	"packages/coding-agent/src/cli/worktree-cli.ts",
	"packages/coding-agent/src/cli/worktree-scanner.ts",
] as const;

async function makeGraph(overrides: Record<string, string> = {}, config: Record<string, unknown> = {}) {
	const repoRoot = await mkdtemp(path.join(path.dirname(import.meta.dir), "wtr-integration-"));
	for (const relative of productionRoots) {
		const target = path.join(repoRoot, relative);
		await mkdir(path.dirname(target), { recursive: true });
		const source = overrides[relative] ?? (await readFile(path.join(import.meta.dir, "..", relative), "utf8"));
		await writeFile(target, source);
	}
	for (const [relative, source] of Object.entries(overrides)) {
		if ((productionRoots as readonly string[]).includes(relative)) continue;
		const target = path.join(repoRoot, relative);
		await mkdir(path.dirname(target), { recursive: true });
		await writeFile(target, source);
	}
	await writeFile(path.join(repoRoot, "tsconfig.json"), JSON.stringify({ compilerOptions: config }));
	return repoRoot;
}

async function graphFindings(repoRoot: string, extra: { roots?: string[] } = {}) {
	return verifyWorktreeReportCapabilities({ repoRoot, graphRoot: productionRoots[0], ...extra });
}

describe("worktree capability verifier", () => {
	test("analyzes the canonical capability fixtures", async () => {
		const readFixture = (name: string) =>
			readFile(path.join(import.meta.dir, "fixtures/worktree-report-capabilities", name), "utf8");
		const allowed = analyzeSource(await readFixture("allowed.ts"), `${fixture}/allowed.ts`);
		const forbidden = analyzeSource(await readFixture("forbidden.ts"), `${fixture}/forbidden.ts`);
		const reexport = analyzeSource(await readFixture("reexport.ts"), `${fixture}/reexport.ts`);
		expect(allowed).toEqual([]);
		expect(forbidden.map(formatFinding)).toEqual([
			`${fixture}/forbidden.ts:1:1 WTR001_FORBIDDEN_IMPORT node:fs/promises`,
			`${fixture}/forbidden.ts:2:1 WTR001_FORBIDDEN_IMPORT node:fs`,
			`${fixture}/forbidden.ts:3:1 WTR001_FORBIDDEN_IMPORT node:fs/promises`,
			`${fixture}/forbidden.ts:7:17 WTR009_SCANNER_API open`,
			`${fixture}/forbidden.ts:7:17 WTR009_SCANNER_API open:write-mode`,
			`${fixture}/forbidden.ts:8:8 WTR009_SCANNER_API FileHandle.write`,
			`${fixture}/forbidden.ts:9:8 WTR009_SCANNER_API FileHandle.writev`,
			`${fixture}/forbidden.ts:10:8 WTR009_SCANNER_API FileHandle.writeFile`,
			`${fixture}/forbidden.ts:12:8 WTR006_WRITE_OR_MUTATION node:fs:writeFile`,
			`${fixture}/forbidden.ts:13:8 WTR006_WRITE_OR_MUTATION node:fs/promises:rm`,
			`${fixture}/forbidden.ts:13:8 WTR009_SCANNER_API rm`,
			`${fixture}/forbidden.ts:14:2 WTR006_WRITE_OR_MUTATION member-assignment`,
			`${fixture}/forbidden.ts:14:2 WTR007_UNAPPROVED_PROCESS process.env`,
			`${fixture}/forbidden.ts:15:8 WTR002_FORBIDDEN_CALL fetch`,
			`${fixture}/forbidden.ts:16:8 WTR003_FORBIDDEN_MEMBER Bun.write`,
			`${fixture}/forbidden.ts:17:6 WTR002_FORBIDDEN_CALL WebSocket`,
			`${fixture}/forbidden.ts:18:2 WTR003_FORBIDDEN_MEMBER console.log`,
			`${fixture}/forbidden.ts:19:8 WTR009_SCANNER_API FileHandle.extraction`,
			`${fixture}/forbidden.ts:19:37 WTR009_SCANNER_API open`,
			`${fixture}/forbidden.ts:19:37 WTR009_SCANNER_API open:write-mode`,
			`${fixture}/forbidden.ts:20:8 WTR009_SCANNER_API FileHandle.extraction`,
			`${fixture}/forbidden.ts:20:28 WTR009_SCANNER_API open`,
			`${fixture}/forbidden.ts:21:8 WTR009_SCANNER_API FileHandle.extraction`,
			`${fixture}/forbidden.ts:21:15 WTR009_SCANNER_API open`,
			`${fixture}/forbidden.ts:25:8 WTR009_SCANNER_API FileHandle.extraction`,
			`${fixture}/forbidden.ts:26:8 WTR009_SCANNER_API FileHandle.extraction`,
			`${fixture}/forbidden.ts:27:2 WTR009_SCANNER_API FileHandle.extraction`,
			`${fixture}/forbidden.ts:30:8 WTR009_SCANNER_API FileHandle.extraction`,
			`${fixture}/forbidden.ts:31:8 WTR009_SCANNER_API FileHandle.extraction`,
			`${fixture}/forbidden.ts:32:8 WTR009_SCANNER_API FileHandle.extraction`,
			`${fixture}/forbidden.ts:32:22 WTR004_UNKNOWN_BINDING indirect-invocation:bind`,
			`${fixture}/forbidden.ts:32:22 WTR009_SCANNER_API FileHandle.extraction`,
			`${fixture}/forbidden.ts:34:2 WTR009_SCANNER_API FileHandle.extraction`,
			`${fixture}/forbidden.ts:39:9 WTR004_UNKNOWN_BINDING computed-member`,
			`${fixture}/forbidden.ts:42:24 WTR005C_DYNAMIC_IMPORT_FORBIDDEN computed`,
			`${fixture}/forbidden.ts:43:25 WTR005C_DYNAMIC_IMPORT_FORBIDDEN computed`,
			`${fixture}/forbidden.ts:45:40 WTR005C_DYNAMIC_IMPORT_FORBIDDEN ./commands/worktree`,
			`${fixture}/forbidden.ts:49:22 WTR003_FORBIDDEN_MEMBER reflective-member:constructor`,
			`${fixture}/forbidden.ts:50:1 WTR004_UNKNOWN_BINDING indirect-invocation:call`,
			`${fixture}/forbidden.ts:51:20 WTR003_FORBIDDEN_MEMBER reflective-member:constructor`,
			`${fixture}/forbidden.ts:52:15 WTR003_FORBIDDEN_MEMBER reflective-member:prototype`,
			`${fixture}/forbidden.ts:53:19 WTR003_FORBIDDEN_MEMBER reflective-member:__proto__`,
			`${fixture}/forbidden.ts:53:19 WTR004_UNKNOWN_BINDING computed-member`,
			`${fixture}/forbidden.ts:54:26 WTR003_FORBIDDEN_MEMBER reflective-member:constructor`,
			`${fixture}/forbidden.ts:55:1 WTR004_UNKNOWN_BINDING indirect-invocation:apply`,
			`${fixture}/forbidden.ts:56:1 WTR004_UNKNOWN_BINDING indirect-invocation:bind`,
			`${fixture}/forbidden.ts:56:1 WTR004_UNKNOWN_BINDING unsupported-callee`,
			`${fixture}/forbidden.ts:57:1 WTR003_FORBIDDEN_MEMBER reflective-member:__defineGetter__`,
			`${fixture}/forbidden.ts:57:1 WTR004_UNKNOWN_BINDING indirect-invocation:call`,
		]);
		expect(reexport.map((finding) => finding.rule)).toEqual([RULES.unknownBinding, RULES.unknownBinding]);
	});
	test("rejects reflective authority in CLI, destructured, and optional-member forms", async () => {
		const cli = await readFile(path.join(import.meta.dir, "../packages/coding-agent/src/cli.ts"), "utf8");
		const cliExploit = `${cli}
const FunctionCtor = [].filter.constructor;
FunctionCtor("return process.getBuiltinModule('node:fs').rmSync('/target',{force:true})").call(null);`;
		expect(
			analyzeSource(cliExploit, "packages/coding-agent/src/cli.ts").some(
				finding =>
					finding.rule === RULES.forbiddenMember &&
					finding.symbol === "reflective-member:constructor",
			),
		).toBe(true);
		for (const source of [
			`const { constructor: FunctionCtor } = [].filter;
FunctionCtor("return process.getBuiltinModule('node:fs').rmSync('/target',{force:true})").call(null);`,
			`const FunctionCtor = []?.filter.constructor;
FunctionCtor("return process.getBuiltinModule('node:fs').rmSync('/target',{force:true})").call(null);`,
			`const { ["__proto__"]: inherited } = {};
void inherited;`,
		]) {
			expect(
				analyzeSource(source, `${fixture}/allowed.ts`).some(
					finding => finding.rule === RULES.forbiddenMember && finding.symbol.startsWith("reflective-member:"),
				),
			).toBe(true);
		}
	});
	test("rejects reflective global acquisition and composite aliases in every role", async () => {
		const cli = await readFile(path.join(import.meta.dir, "../packages/coding-agent/src/cli.ts"), "utf8");
		const cliExploit = `${cli}
const evil = Reflect.get(globalThis, "eval");
evil("process.getBuiltinModule('node:fs').rmSync('/target',{force:true})");`;
		expect(
			analyzeSource(cliExploit, "packages/coding-agent/src/cli.ts").some(
				finding =>
					finding.rule === RULES.forbiddenMember &&
					["reflective-global:Reflect", "reflective-global:globalThis"].includes(finding.symbol),
			),
		).toBe(true);
		for (const source of [
			`const [R] = [Reflect];
const evil = R.get(globalThis, "eval");
evil("process.getBuiltinModule('node:fs').rmSync('/target',{force:true})");`,
			`const processAlias = global.process;
processAlias.getBuiltinModule("node:fs").rmSync("/target", { force: true });`,
		]) {
			expect(
				analyzeSource(source, `${fixture}/allowed.ts`).some(
					finding => finding.rule === RULES.forbiddenMember && finding.symbol.startsWith("reflective-global:"),
				),
			).toBe(true);
		}
	});
	test("rejects Object reflection in command code while preserving scanner error annotation", () => {
		const exploit = `import { Command } from "@gajae-code/utils/cli";
const { getPrototypeOf, getOwnPropertyDescriptor } = Object;
const prototype = getPrototypeOf(Command);
const FunctionCtor = getOwnPropertyDescriptor(prototype, "constructor")?.value;
FunctionCtor("process.getBuiltinModule('node:fs').rmSync('/target',{force:true})")();`;
		expect(
			analyzeSource(exploit, "packages/coding-agent/src/commands/worktree.ts").some(
				finding => finding.rule === RULES.forbiddenMember && finding.symbol === "reflective-global:Object",
			),
		).toBe(true);
		const scannerAnnotation = `throw Object.assign(new Error("directory changed"), { code: "ERACE" });`;
		expect(
			analyzeSource(scannerAnnotation, "packages/coding-agent/src/cli/worktree-scanner.ts").some(
				finding => finding.symbol === "reflective-global:Object",
			),
		).toBe(false);
	});
	test("rejects statically computed reflective destructuring keys", () => {
		const source = `const { ["con" + "structor"]: FunctionCtor } = [].filter;
const evil = FunctionCtor("process.getBuiltinModule('node:fs').rmSync('/target',{force:true})");
evil();`;
		expect(
			analyzeSource(source, `${fixture}/allowed.ts`).some(
				finding => finding.rule === RULES.unknownBinding && finding.symbol === "computed-pattern",
			),
		).toBe(true);
	});
	test("rejects statically computed reflective member keys", () => {
		const source = `const FunctionCtor = [].filter["con" + "structor"];
const evil = FunctionCtor("process.getBuiltinModule('node:fs').rmSync('/target',{force:true})");
evil();`;
		expect(
			analyzeSource(source, "packages/coding-agent/src/cli.ts").some(
				finding =>
					finding.rule === RULES.forbiddenMember &&
					finding.symbol === "reflective-member:constructor",
			),
		).toBe(true);
	});
	test("rejects dynamic computed member acquisition in the CLI role", () => {
		const source = `const member = "constructor";
const FunctionCtor = [].filter[member];
const evil = FunctionCtor("process.getBuiltinModule('node:fs').rmSync('/target',{force:true})");
evil();`;
		expect(
			analyzeSource(source, "packages/coding-agent/src/cli.ts").some(
				finding => finding.rule === RULES.unknownBinding && finding.symbol === "computed-member",
			),
		).toBe(true);
	});
	test("rejects CLI descriptor extraction of process authority", () => {
		const source = `const descriptor = Object.getOwnPropertyDescriptor(process, "getBuiltinModule");
const evil = descriptor?.value;
evil("node:fs").rmSync("/target", { force: true });`;
		expect(
			analyzeSource(source, "packages/coding-agent/src/cli.ts").some(
				finding =>
					finding.rule === RULES.forbiddenMember &&
					finding.symbol === "reflective-global:Object",
			),
		).toBe(true);
	});
	test("rejects optional and composite transfers of privileged CLI authority", () => {
		const cases = [
			{
				source: `const write = Bun?.write;
await write("/target", "x");`,
				rule: RULES.unknownBinding,
				symbol: "optional-privileged-member:write",
			},
			{
				source: `const getBuiltinModule = process?.getBuiltinModule;
getBuiltinModule("node:fs").rmSync("/target", { force: true });`,
				rule: RULES.unknownBinding,
				symbol: "optional-privileged-member:getBuiltinModule",
			},
			{
				source: `const [p] = [process];
p.getBuiltinModule("node:fs").rmSync("/target", { force: true });`,
				rule: RULES.process,
				symbol: "process-transfer:process",
			},
			{
				source: `const { write } = Bun;
await write("/target", "x");`,
				rule: RULES.forbiddenCall,
				symbol: "capability-transfer:Bun",
			},
		] as const;
		for (const testCase of cases) {
			expect(
				analyzeSource(testCase.source, "packages/coding-agent/src/cli.ts").some(
					finding => finding.rule === testCase.rule && finding.symbol === testCase.symbol,
				),
			).toBe(true);
		}
	});
	test("rejects direct, destructured, and optional import.meta authority while allowing the main guard", () => {
		const direct = `import.meta.require("node:fs").rmSync("/target", { force: true });`;
		expect(
			analyzeSource(direct, "packages/coding-agent/src/cli.ts").some(
				finding => finding.rule === RULES.forbiddenMember && finding.symbol === "import-meta:require",
			),
		).toBe(true);
		for (const source of [
			`const { require } = import.meta;
require("node:fs").rmSync("/target", { force: true });`,
			`const require = import.meta?.require;
require("node:fs").rmSync("/target", { force: true });`,
		]) {
			expect(
				analyzeSource(source, "packages/coding-agent/src/cli.ts").some(
					finding => finding.rule === RULES.unknownBinding && finding.symbol === "import-meta-transfer",
				),
			).toBe(true);
		}
		expect(
			analyzeSource("if (import.meta.main) {}", "packages/coding-agent/src/cli.ts").some(
				finding => finding.symbol.startsWith("import-meta"),
			),
		).toBe(false);
	});
	test("requires the complete immediate registry factory edge", () => {
		const findings = analyzeSource(
			`import { getWorktreesDir } from "@gajae-code/utils/dirs";
			 const commands = [{ name: "worktree", load: async () => {
			   const { createWorktreeCommand } = await import("./commands/worktree");
			   return createWorktreeCommand;
			 }}];`,
			"packages/coding-agent/src/cli.ts",
		);
		expect(findings.some((finding) => finding.rule === RULES.registryEdge)).toBe(true);
	});

	test("rejects duplicate worktree registry entries", () => {
		const load = `async () => { const { createWorktreeCommand } = await import("./commands/worktree"); return createWorktreeCommand(getWorktreesDir); }`;
		const findings = analyzeSource(
			`import { getWorktreesDir } from "@gajae-code/utils/dirs"; export const commands = [{ name: "worktree", load: ${load} }, { name: "worktree", load: ${load} }];`,
			"packages/coding-agent/src/cli.ts",
		);
		expect(findings.some((finding) => finding.rule === RULES.registryEdge && finding.symbol === "count:2")).toBe(true);
	});

	test("rejects hostile dynamic forms", () => {
		const findings = analyzeSource(
			`const a = import("./third"); const b = import(name); const c = import(\`./\${name}\`); const d = Promise.resolve(import("./commands/worktree"));`,
			`${fixture}/forbidden.ts`,
		);
		expect(findings.filter((finding) => finding.rule === RULES.dynamicImport)).toHaveLength(4);
	});

	test("rejects open flags that omit O_NOFOLLOW", () => {
		const findings = analyzeSource(
			`import { constants } from "node:fs";
			 import { open } from "node:fs/promises";
			 export async function unsafe(path: string) { const handle = await open(path, constants.O_RDONLY); await handle.close(); }`,
			`${fixture}/allowed.ts`,
		);
		expect(findings.some((finding) => finding.rule === RULES.scannerApi && finding.symbol === "open:write-mode")).toBe(
			true,
		);
	});
	test("requires the exact source shape for metadata open flags", () => {
		const variants = [
			"constants.O_RDONLY | constants.O_NOFOLLOW",
			"constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK | constants.O_SYNC",
			"constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW",
			"(() => { const readonlyFlag = constants.O_RDONLY; return readonlyFlag | constants.O_NOFOLLOW | constants.O_NONBLOCK; })()",
			"c.O_RDONLY | c.O_NOFOLLOW | c.O_NONBLOCK",
			"getFlags()",
			"(constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK) as number",
			"constants['O_RDONLY'] | constants.O_NOFOLLOW | constants.O_NONBLOCK",
			"1 | constants.O_NOFOLLOW | constants.O_NONBLOCK",
			"condition ? constants.O_RDONLY : constants.O_NOFOLLOW",
			"constants.O_RDONLY | (constants.O_NOFOLLOW | constants.O_NONBLOCK)",
		];
		for (const flags of variants) {
			const findings = analyzeSource(
				`import { constants } from "node:fs";
				 import { open } from "node:fs/promises";
				 const c = constants;
				 export async function unsafe(path: string) { const handle = await open(path, ${flags}); await handle.close(); }
				 function getFlags() { return constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK; }`,
				`${fixture}/allowed.ts`,
			);
			expect(findings.some((finding) => finding.rule === RULES.scannerApi && finding.symbol === "open:write-mode")).toBe(
				true,
			);
		}
		const findings = analyzeSource(
			`import { constants } from "node:fs";
			 import { open } from "node:fs/promises";
			 export async function safe(path: string) { const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); await handle.close(); }`,
			`${fixture}/allowed.ts`,
		);
		expect(findings.some((finding) => finding.rule === RULES.scannerApi && finding.symbol === "open:write-mode")).toBe(false);
	});
	test("rejects imported capability rebinding and flag mutation", () => {
		const cases: Array<{ hostile: string; symbol: string }> = [
			{ hostile: "open = open;", symbol: "assignment" },
			{ hostile: "open += open;", symbol: "assignment" },
			{ hostile: "open++;", symbol: "assignment" },
			{ hostile: "for (open in [open]) break;", symbol: "assignment" },
			{ hostile: "for (open of [open]) break;", symbol: "assignment" },
			{ hostile: "constants = constants;", symbol: "assignment" },
			{ hostile: "constants += constants;", symbol: "assignment" },
			{ hostile: "constants++;", symbol: "assignment" },
			{ hostile: "for (constants in [constants]) break;", symbol: "assignment" },
			{ hostile: "for (constants of [constants]) break;", symbol: "assignment" },
			{ hostile: "constants.O_RDONLY = 1;", symbol: "member-assignment" },
			{ hostile: "constants.O_NOFOLLOW++;", symbol: "member-assignment" },
			{ hostile: "for (constants.O_RDONLY in [1]) break;", symbol: "member-assignment" },
			{ hostile: "for (constants.O_NONBLOCK of [1]) break;", symbol: "member-assignment" },
			{ hostile: "const c = constants; delete (c as typeof constants).O_RDONLY;", symbol: "member-assignment" },
		];
		for (const { hostile, symbol } of cases) {
			const findings = analyzeSource(
				`import { constants } from "node:fs"; import { open } from "node:fs/promises";
				 export async function safe(path: string) {
				   ${hostile}
				   const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
				   await handle.close();
				 }`,
				`${fixture}/allowed.ts`,
			);
			expect(findings.filter((finding) => finding.rule === RULES.mutation && finding.symbol === symbol)).toHaveLength(1);
		}
	});
	test("captures capability mutations when imports follow declarations", () => {
		const findings = analyzeSource(
			`function beforeImports() { open += open; }
			 export async function safe(path: string) {
			   const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
			   await handle.close();
			 }
			 import { constants } from "node:fs"; import { open } from "node:fs/promises";`,
			`${fixture}/allowed.ts`,
		);
		expect(findings.filter((finding) => finding.rule === RULES.mutation && finding.symbol === "assignment")).toHaveLength(1);
	});

	test("rejects omitted open flag forms in isolation", () => {
		const variants = [
			{
				setup: "const flags = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;",
				flagsExpression: "flags",
			},
			{
				setup: "",
				flagsExpression: "(constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK) || 0",
			},
			{
				setup: "",
				flagsExpression: "{ ...{ value: constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK } }",
			},
			{
				setup: "",
				flagsExpression: "constants.O_RDONLY | constants.O_NOFOLLOW",
			},
		];
		for (const { setup, flagsExpression } of variants) {
			const findings = analyzeSource(
				`import { constants } from "node:fs"; import { open } from "node:fs/promises";
				 export async function unsafe(path: string) { ${setup}
				   const handle = await open(path, ${flagsExpression});
				   await handle.close();
				 }`,
				`${fixture}/allowed.ts`,
			);
			const openFindings = findings.filter(
				(finding) => finding.rule === RULES.scannerApi && finding.symbol === "open:write-mode",
			);
			expect(openFindings).toHaveLength(1);
			expect(findings.filter((finding) => finding.rule !== RULES.scannerApi || finding.symbol !== "open:write-mode")).toEqual([]);
		}
	});

	test("accepts parenthesized exact open flags silently", () => {
		const findings = analyzeSource(
			`import { constants } from "node:fs"; import { open } from "node:fs/promises";
			 export async function safe(path: string) {
			   const handle = await open(path, ((constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)));
			   await handle.close();
			 }`,
			`${fixture}/allowed.ts`,
		);
		expect(findings).toEqual([]);
	});

	test("rejects scanner path APIs outside the lexical allowlist", () => {
		const findings = analyzeSource(
			'import * as path from "node:path";\nexport const escaped = path.resolve("x");\n',
			`${fixture}/allowed.ts`,
		);
		expect(findings.some((finding) => finding.rule === RULES.scannerApi && finding.symbol === "path.resolve")).toBe(
			true,
		);
	});

	test("resolves imported aliases to their capabilities", () => {
		const findings = analyzeSource(
			`import * as fs from "node:fs"; import { rm as remove } from "node:fs/promises"; const erase = remove; fs.writeFileSync("x", "y"); erase("x"); process.env.X = "1";`,
			`${fixture}/forbidden.ts`,
		);
		const rules = new Set(findings.map((finding) => finding.rule));
		expect(rules).toEqual(
			new Set([RULES.forbiddenImport, RULES.mutation, RULES.process, RULES.scannerApi, RULES.unknownBinding]),
		);
	});

	test("rejects reexports and dirs imports outside the CLI boundary", () => {
		const findings = analyzeSource(
			`export * from "./reexport"; import { getWorktreesDir } from "@gajae-code/utils/dirs";`,
			`${fixture}/reexport.ts`,
		);
		const rules = new Set(findings.map((finding) => finding.rule));
		expect(rules).toEqual(new Set([RULES.unknownBinding, RULES.dirsBaseline]));
	});

	test("requires parse-valid-getter-import-call order", () => {
		const findings = analyzeSource(
			`import { Args, Command, type CommandCtor, Flags } from "@gajae-code/utils/cli";
			 export function createWorktreeCommand(getWorktreesDir: () => string): CommandCtor {
			   return class Worktree extends Command { async run() {
			     const root = getWorktreesDir();
			     const { runWorktreeCommand } = await import("../cli/worktree-cli");
			     const { args, flags } = await this.parse(Worktree);
			     const valid = true; if (!valid) return;
			     const result = await runWorktreeCommand({ root, platform: "posix", action: args.action, json: flags.json, dryRun: false });
			   }};
			 }`,
			"packages/coding-agent/src/commands/worktree.ts",
		);
		expect(findings.some((finding) => finding.rule === RULES.getterTiming)).toBe(true);
	});
	test("rejects positional validation omissions, broadening, alternate indexes, and aliases", async () => {
		const command = await readFile(
			path.join(import.meta.dir, "../packages/coding-agent/src/commands/worktree.ts"),
			"utf8",
		);
		const canonical =
			'const validPositionals = argv.length <= 1 && (argv.length === 0 || argv[0] === action);';
		const variants = [
			command.replace(canonical, "const validPositionals = true;"),
			command.replace(
				canonical,
				"const validPositionals = argv.length <= 1 || (argv.length === 0 || argv[0] === action);",
			),
			command.replace(
				canonical,
				"const validPositionals = argv.length <= 1 && (argv.length === 0 || argv[1] === action);",
			),
			command.replace(
				canonical,
				"const positionalAlias = argv; const validPositionals = positionalAlias.length <= 1 && (positionalAlias.length === 0 || positionalAlias[0] === action);",
			),
		];
		for (const source of variants) {
			const findings = analyzeSource(source, "packages/coding-agent/src/commands/worktree.ts");
			expect(
				findings.some(
					finding =>
						finding.rule === RULES.getterTiming && finding.symbol === "parse-valid-getter-import-call",
				),
			).toBe(true);
		}
	});

	test("sorts numerically and deduplicates receipts", () => {
		const a = {
			path: "a.ts",
			line: 10,
			column: 1,
			rule: RULES.forbiddenCall,
			symbol: "rm",
		};
		const b = {
			path: "a.ts",
			line: 2,
			column: 1,
			rule: RULES.forbiddenCall,
			symbol: "rm",
		};
		expect(sortFindings([a, b, a]).map(formatFinding)).toEqual([
			"a.ts:2:1 WTR002_FORBIDDEN_CALL rm",
			"a.ts:10:1 WTR002_FORBIDDEN_CALL rm",
		]);
	});

	test("emits an exact sorted hostile receipt", async () => {
		const relativePath = `${fixture}/receipt.ts`;
		const source = 'import { rm } from "node:fs/promises";\nrm("x");\nfetch("https://example.invalid");\n';
		const findings = analyzeSource(source, relativePath);
		const receipt = findings.map(formatFinding);
		expect(receipt).toEqual([
			`${relativePath}:1:1 WTR001_FORBIDDEN_IMPORT node:fs/promises`,
			`${relativePath}:2:1 WTR006_WRITE_OR_MUTATION node:fs/promises:rm`,
			`${relativePath}:2:1 WTR009_SCANNER_API rm`,
			`${relativePath}:3:1 WTR002_FORBIDDEN_CALL fetch`,
		]);
		expect(analyzeSource(source, relativePath).map(formatFinding)).toEqual(receipt);
		const emitted: string[] = [];
		expect(
			await main([], {
				verify: async () => findings,
				write: (text) => emitted.push(text),
			}),
		).toBe(1);
		expect(emitted.join("")).toBe(`${receipt.join("\n")}\n`);
	});

	test("fails closed when an authoritative root is missing", async () => {
		const findings = await verifyWorktreeReportCapabilities({
			repoRoot: path.resolve(import.meta.dir, ".."),
			roots: ["packages/coding-agent/src/cli/does-not-exist.ts"],
		});
		expect(findings).toEqual([
			{
				path: "packages/coding-agent/src/cli/does-not-exist.ts",
				line: 1,
				column: 1,
				rule: RULES.unknownBinding,
				symbol: "unresolved-root",
			},
		]);
	});

	test("approved production graph and CLI command are silent", async () => {
		const repoRoot = path.resolve(import.meta.dir, "..");
		expect(await verifyWorktreeReportCapabilities({ repoRoot })).toEqual([]);
		const stderr = spyOn(process.stderr, "write").mockImplementation(() => true);
		const stdout = spyOn(process.stdout, "write").mockImplementation(() => true);
		try {
			expect(await main([])).toBe(0);
			expect(stderr).not.toHaveBeenCalled();
			expect(stdout).not.toHaveBeenCalled();
		} finally {
			stdout.mockRestore();
			stderr.mockRestore();
		}
	});

	test("rejects direct CLI scanner edges outside the registry", async () => {
		const cli = await readFile(path.join(import.meta.dir, "../packages/coding-agent/src/cli.ts"), "utf8");
		const staticFindings = analyzeSource(
			`${cli}\nimport { scanWorktrees } from "./cli/worktree-scanner";\n`,
			"packages/coding-agent/src/cli.ts",
		);
		expect(
			staticFindings.some(
				(finding) => finding.rule === RULES.forbiddenImport && finding.symbol === "./cli/worktree-scanner",
			),
		).toBe(true);
		const dynamicFindings = analyzeSource(
			`${cli}\nconst directScanner = import("./cli/worktree-scanner");\n`,
			"packages/coding-agent/src/cli.ts",
		);
		expect(
			dynamicFindings.some(
				(finding) => finding.rule === RULES.dynamicImport && finding.symbol === "./cli/worktree-scanner",
			),
		).toBe(true);
		const directCapabilities = analyzeSource(
			`${cli}
require("node:fs");
eval("0");
process.getBuiltinModule("node:fs");
new Function("return 0");`,
			"packages/coding-agent/src/cli.ts",
		);
		for (const symbol of ["require", "eval", "process.getBuiltinModule", "Function"]) {
			expect(
				directCapabilities.some((finding) => finding.rule === RULES.forbiddenCall && finding.symbol === symbol),
			).toBe(true);
		}
	});
	test("rejects detached registry decoys", () => {
		const findings = analyzeSource(
			`import { getWorktreesDir } from "@gajae-code/utils/dirs"; const decoy = [{ name: "worktree", load: async () => { const { createWorktreeCommand } = await import("./commands/worktree"); return createWorktreeCommand(getWorktreesDir); }}]; export const commands = [];`,
			"packages/coding-agent/src/cli.ts",
		);
		expect(findings.some((finding) => finding.rule === RULES.registryEdge)).toBe(true);
	});

	test("rejects ignored getter and bypassed worker root", () => {
		const source = `import { Args, Command, type CommandCtor, Flags } from "@gajae-code/utils/cli"; export function createWorktreeCommand(getWorktreesDir: () => string): CommandCtor { return class Worktree extends Command { async run() { const { args, flags } = await this.parse(Worktree); const action = args.action; const json = flags.json; const dryRun = flags["dry-run"]; const valid = true; if (!valid) return; const root = "arbitrary"; const { runWorktreeCommand } = await import("../cli/worktree-cli"); await runWorktreeCommand({ root: "arbitrary", platform: process.platform === "win32" ? "win32" : "posix", action, json, dryRun }); }}; }`;
		expect(
			analyzeSource(source, "packages/coding-agent/src/commands/worktree.ts").some(
				(finding) => finding.rule === RULES.getterTiming,
			),
		).toBe(true);
	});

	test("rejects aliased worker selection and shadowed factory getters", () => {
		const aliasedWorker = `import { Args, Command, type CommandCtor, Flags } from "@gajae-code/utils/cli";
      export function createWorktreeCommand(getWorktreesDir: () => string): CommandCtor {
        return class Worktree extends Command { async run() {
          const { args, flags } = await this.parse(Worktree);
          const action = args.action === "clear" ? "clear" : "list";
          const all = flags.all ?? false;
          const dryRun = flags["dry-run"] ?? false;
          const json = flags.json ?? false;
          const valid = (action === "clear" && !all) || (action === "list" && !all && !dryRun);
          if (!valid) { return; }
          const root = getWorktreesDir();
          const { runWorktreeCommand: run } = await import("../cli/worktree-cli");
          const result = await run({ root, platform: process.platform === "win32" ? "win32" : "posix", action, json, dryRun });
        }};
      }`;
		expect(
			analyzeSource(aliasedWorker, "packages/coding-agent/src/commands/worktree.ts").some(
				(finding) => finding.rule === RULES.getterTiming || finding.rule === RULES.workerEdge,
			),
		).toBe(true);

		const shadowedGetter = aliasedWorker
			.replace(
				"const root = getWorktreesDir();",
				"const getWorktreesDir = () => '/decoy'; const root = getWorktreesDir();",
			)
			.replace("const { runWorktreeCommand: run }", "const { runWorktreeCommand }")
			.replace("const result = await run(", "const result = await runWorktreeCommand(");
		expect(
			analyzeSource(shadowedGetter, "packages/coding-agent/src/commands/worktree.ts").some(
				(finding) => finding.rule === RULES.getterTiming,
			),
		).toBe(true);
	});

	test("rejects worker scanner root or platform substitution", () => {
		const source = `import { scanWorktrees } from "./worktree-scanner";
			export async function runWorktreeCommand(options: { root: string; platform: "posix" | "win32" }) {
				return scanWorktrees({ root: "/substituted", platform: options.platform });
			}`;
		expect(
			analyzeSource(source, "packages/coding-agent/src/cli/worktree-cli.ts").some(
				(finding) => finding.rule === RULES.scannerApi && finding.symbol === "worker-scan-contract",
			),
		).toBe(true);
	});
	test("fails closed on unknown CLI dynamic edges and non-exact payloads", () => {
		const cli = analyzeSource(
			`import { getWorktreesDir } from "@gajae-code/utils/dirs"; export const commands = [{ name: "worktree", aliases: ["wt"], load: async () => { const { createWorktreeCommand, extra } = await import("./commands/worktree"); return createWorktreeCommand(getWorktreesDir); } }]; const x = import("./new-command");`,
			"packages/coding-agent/src/cli.ts",
		);
		expect(cli.some((finding) => finding.rule === RULES.dynamicImport)).toBe(true);

		const command = analyzeSource(
			`import { Args, Command, type CommandCtor, Flags } from "@gajae-code/utils/cli";
			export function createWorktreeCommand(getWorktreesDir: () => string): CommandCtor {
				return class Worktree extends Command { async run() {
					const { args, flags } = await this.parse(Worktree);
					const action = args.action === "clear" ? "clear" : "list";
					const all = flags.all ?? false; const dryRun = flags["dry-run"] ?? false; const json = flags.json ?? false;
					const valid = (action === "clear" && !all) || (action === "list" && !all && !dryRun); if (!valid) return;
					const root = getWorktreesDir(); const { runWorktreeCommand } = await import("../cli/worktree-cli");
					await runWorktreeCommand({ root, platform: process.platform === "win32" ? "win32" : "posix", action, json, dryRun, ...{} });
				}};
			}`,
			"packages/coding-agent/src/commands/worktree.ts",
		);
		expect(command.some((finding) => finding.rule === RULES.getterTiming)).toBe(true);
	});

	test("rejects scanner signature and nested handle escape bypasses", () => {
		const source = `import { constants } from "node:fs"; import { open, lstat } from "node:fs/promises";
			export async function scan() { const h = await open("x", constants.O_RDONLY); lstat("x"); const box = { nested: h }; return box; }`;
		const findings = analyzeSource(source, `${fixture}/allowed.ts`);
		expect(findings.some((finding) => finding.rule === RULES.scannerApi && finding.symbol === "open:write-mode")).toBe(
			true,
		);
		expect(
			findings.some((finding) => finding.rule === RULES.scannerApi && finding.symbol === "FileHandle.extraction"),
		).toBe(true);
	});
	test("scanner flow follows only the exported reachable binding, not dead decoys", async () => {
		const scanner = await readFile(
			path.join(import.meta.dir, "../packages/coding-agent/src/cli/worktree-scanner.ts"),
			"utf8",
		);
		const hostile = scanner
			.replace("export async function scanWorktrees", "async function originalScanWorktrees")
			.concat(`
export async function scanWorktrees(_options: ScanWorktreesOptions): Promise<WorktreeDiagnostic[]> {
	return [];
}
function deadDecoy() {
	const lstat = () => ({ isSymbolicLink: () => false });
	const readdir = () => [];
	const open = () => ({ stat() {}, read() {}, close() {} });
	const handle = { stat() {}, read() {}, close() {} };
	void lstat; void readdir; void open; void handle;
	lstat("x"); readdir("x");
	const result = open("x"); result.stat(); result.read(); result.close();
	handle.stat(); handle.read(); handle.close();
}`);
		const receipts = analyzeSource(hostile, "packages/coding-agent/src/cli/worktree-scanner.ts")
			.filter((finding) => finding.rule === RULES.scannerApi && finding.symbol.startsWith("scanner-flow:"))
			.map((finding) => finding.symbol);
		expect(receipts).toEqual([
			"scanner-flow:handle.close",
			"scanner-flow:handle.read",
			"scanner-flow:handle.stat",
			"scanner-flow:lstat",
			"scanner-flow:open",
			"scanner-flow:readdir",
		]);
	});

	test("statically unreachable scanner calls cannot satisfy the reachable flow contract", () => {
		const source = `import { lstat, open, readdir } from "node:fs/promises";
export async function scanWorktrees() {
	if (false) {
		await lstat("x");
		await readdir("x");
		const handle = await open("x", 0);
		await handle.stat();
		await handle.read();
		await handle.close();
	}
	return [];
}`;
		const receipts = analyzeSource(source, "packages/coding-agent/src/cli/worktree-scanner.ts")
			.filter((finding) => finding.rule === RULES.scannerApi && finding.symbol.startsWith("scanner-flow:"))
			.map((finding) => finding.symbol);
		expect(receipts).toEqual([
			"scanner-flow:handle.close",
			"scanner-flow:handle.read",
			"scanner-flow:handle.stat",
			"scanner-flow:lstat",
			"scanner-flow:open",
			"scanner-flow:readdir",
		]);
	});

	test("local same-named functions and object methods cannot satisfy imported scanner bindings", () => {
		const source = `export async function scanWorktrees() {
	const lstat = () => ({});
	const readdir = () => [];
	const open = () => ({ stat() {}, read() {}, close() {} });
	const handle = { stat() {}, read() {}, close() {} };
	lstat("x");
	readdir("x");
	const result = await open("x");
	await result.stat();
	await result.read();
	await result.close();
	void handle;
	return [];
}`;
		const receipts = analyzeSource(source, "packages/coding-agent/src/cli/worktree-scanner.ts")
			.filter((finding) => finding.rule === RULES.scannerApi && finding.symbol.startsWith("scanner-flow:"))
			.map((finding) => finding.symbol);
		expect(receipts).toEqual([
			"scanner-flow:handle.close",
			"scanner-flow:handle.read",
			"scanner-flow:handle.stat",
			"scanner-flow:lstat",
			"scanner-flow:open",
			"scanner-flow:readdir",
		]);
	});

	test("a closure declared before assignment still extracts the later-open FileHandle binding", () => {
		const findings = analyzeSource(
			`import { constants } from "node:fs";
import { open } from "node:fs/promises";
export async function scan() {
	const leak = () => handle;
	let handle;
	handle = await open("x", constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
	return leak();
}`,
			`${fixture}/allowed.ts`,
		);
		const receipts = findings
			.filter((finding) => finding.rule === RULES.scannerApi && finding.symbol === "FileHandle.extraction")
			.map((finding) => finding.symbol);
		expect(receipts).toEqual(["FileHandle.extraction"]);
	});

	test("backward aliases declared before open assignment reach the FileHandle fixed point", () => {
		const findings = analyzeSource(
			`import { constants } from "node:fs";
import { open } from "node:fs/promises";
export async function scan() {
	let handle;
	let alias;
	alias = handle;
	handle = await open("x", constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
	return alias;
}`,
			`${fixture}/allowed.ts`,
		);
		const receipts = findings
			.filter((finding) => finding.rule === RULES.scannerApi && finding.symbol === "FileHandle.extraction")
			.map((finding) => finding.symbol);
		expect(receipts).toEqual(["FileHandle.extraction", "FileHandle.extraction"]);
	});

	test("sibling block-local handles do not cross binding identity while the outer leak does", () => {
		const findings = analyzeSource(
			`import { constants } from "node:fs";
import { open } from "node:fs/promises";
export async function scan() {
	let handle;
	const leak = () => handle;
	{
		const handle = { stat() {}, read() {}, close() {} };
		const unrelated = () => handle;
		void unrelated;
	}
	handle = await open("x", constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
	return leak();
}`,
			`${fixture}/allowed.ts`,
		);
		const receipts = findings
			.filter((finding) => finding.rule === RULES.scannerApi && finding.symbol === "FileHandle.extraction")
			.map((finding) => finding.symbol);
		expect(receipts).toEqual(["FileHandle.extraction"]);
	});
	test("rejects unassigned open flags, shadowed constants, and unsafe read bounds", () => {
		const source = `import { constants } from "node:fs"; import { open } from "node:fs/promises";
			export async function scan() {
				open("unassigned", constants.O_WRONLY);
				const handle = await open("safe", constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
				await handle.read(Buffer.alloc(9001), 0, 9001, 0);
				await (await open("nested", constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)).stat({ bigint: true });
			}
			export async function shadow(constants: { O_RDONLY: number; O_NOFOLLOW: number; O_NONBLOCK: number }) {
				await open("shadowed", constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
			}
			export async function indirect() {
				open.call(null, "indirect", constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
			}`;
		const findings = analyzeSource(source, `${fixture}/allowed.ts`);
		expect(findings.filter((finding) => finding.symbol === "open:write-mode")).toHaveLength(2);
		expect(
			findings.some((finding) => finding.rule === RULES.scannerApi && finding.symbol === "FileHandle.read:signature"),
		).toBe(true);
		expect(findings.filter((finding) => finding.symbol === "FileHandle.extraction").length).toBeGreaterThanOrEqual(2);
		expect(
			findings.some(
				finding =>
					finding.rule === RULES.unknownBinding && finding.symbol === "indirect-invocation:call",
			),
		).toBe(true);
	});

	test("freezes baseline CLI dynamic import selections and multiplicity", async () => {
		const cli = await readFile(path.join(import.meta.dir, "../packages/coding-agent/src/cli.ts"), "utf8");
		const alteredSelection = analyzeSource(
			cli.replace('import("./commands/acp").then(m => m.default)', 'import("./commands/acp").then(m => m.Command)'),
			"packages/coding-agent/src/cli.ts",
		);
		expect(
			alteredSelection.some((finding) => finding.rule === RULES.dynamicImport && finding.symbol === "./commands/acp"),
		).toBe(true);
		const duplicated = analyzeSource(
			`${cli}\nconst duplicateAcp = import("./commands/acp").then(m => m.default);\nvoid duplicateAcp;\n`,
			"packages/coding-agent/src/cli.ts",
		);
		expect(
			duplicated.some(
				(finding) => finding.rule === RULES.dynamicImport && finding.symbol === "baseline-count:./commands/acp:2",
			),
		).toBe(true);
	});
	test("rejects global aliases and worker parameter or scanner aliases", () => {
		const globalAlias = analyzeSource(
			`export function unsafe() { const request = fetch; return request("https://example.invalid"); }`,
			`${fixture}/allowed.ts`,
		);
		expect(globalAlias.some((finding) => finding.rule === RULES.forbiddenCall && finding.symbol === "fetch")).toBe(
			true,
		);
		const assignedGlobal = analyzeSource(
			`export function unsafe() { let request; request = fetch; return request("https://example.invalid"); }`,
			`${fixture}/allowed.ts`,
		);
		expect(assignedGlobal.some((finding) => finding.rule === RULES.forbiddenCall && finding.symbol === "fetch")).toBe(
			true,
		);
		const wrappedGlobal = analyzeSource(
			`export function unsafe() { return (fetch as typeof fetch)("https://example.invalid"); }`,
			`${fixture}/allowed.ts`,
		);
		expect(wrappedGlobal.some((finding) => finding.rule === RULES.forbiddenCall && finding.symbol === "fetch")).toBe(
			true,
		);

		const shadowedOptions = `import { scanWorktrees } from "./worktree-scanner";
			export async function runWorktreeCommand(options: { root: string; platform: "posix" | "win32" }) {
				{ const options = { root: "/hostile", platform: "posix" as const };
				  return scanWorktrees({ root: options.root, platform: options.platform }); }
			}`;
		expect(
			analyzeSource(shadowedOptions, "packages/coding-agent/src/cli/worktree-cli.ts").some(
				(finding) => finding.rule === RULES.scannerApi && finding.symbol === "worker-scan-contract",
			),
		).toBe(true);
		const reassignedOptions = `import { scanWorktrees } from "./worktree-scanner";
			export async function runWorktreeCommand(options: { root: string; platform: "posix" | "win32" }) {
				options = { root: "/hostile", platform: "posix" };
				return scanWorktrees({ root: options.root, platform: options.platform });
			}`;
		expect(
			analyzeSource(reassignedOptions, "packages/coding-agent/src/cli/worktree-cli.ts").some(
				(finding) => finding.rule === RULES.scannerApi && finding.symbol === "worker-scan-contract",
			),
		).toBe(true);
		const iteratedOptions = `import { scanWorktrees } from "./worktree-scanner";
			export async function runWorktreeCommand(options: { root: string; platform: "posix" | "win32" }) {
				for (options of [{ root: "/hostile", platform: "posix" as const }]) {}
				return scanWorktrees({ root: options.root, platform: options.platform });
			}`;
		expect(
			analyzeSource(iteratedOptions, "packages/coding-agent/src/cli/worktree-cli.ts").some(
				(finding) => finding.rule === RULES.scannerApi && finding.symbol === "worker-scan-contract",
			),
		).toBe(true);

		const aliasedScanner = `import { scanWorktrees } from "./worktree-scanner";
			export async function runWorktreeCommand(options: { root: string; platform: "posix" | "win32" }) {
				const direct = await scanWorktrees({ root: options.root, platform: options.platform });
				const scan = scanWorktrees;
				await scan({ root: "/hostile", platform: "posix" });
				return direct;
			}`;
		expect(
			analyzeSource(aliasedScanner, "packages/coding-agent/src/cli/worktree-cli.ts").some(
				(finding) => finding.rule === RULES.scannerApi && finding.symbol === "worker-scan-contract",
			),
		).toBe(true);
		const assignedScanner = `import { scanWorktrees } from "./worktree-scanner";
			export async function runWorktreeCommand(options: { root: string; platform: "posix" | "win32" }) {
				const direct = await scanWorktrees({ root: options.root, platform: options.platform });
				let scan;
				scan = scanWorktrees;
				await scan({ root: "/hostile", platform: "posix" });
				return direct;
			}`;
		expect(
			analyzeSource(assignedScanner, "packages/coding-agent/src/cli/worktree-cli.ts").some(
				(finding) => finding.rule === RULES.unknownBinding && finding.symbol.includes("alias-assignment"),
			),
		).toBe(true);
	});
	test("rejects optional and tagged calls as unapproved call shapes", () => {
		const findings = analyzeSource(
			"const run = () => 1; run?.(); const tag = (parts: TemplateStringsArray) => parts[0]; tag`x`;",
			`${fixture}/allowed.ts`,
		);
		expect(
			findings.some((finding) => finding.rule === RULES.unknownBinding && finding.symbol === "optional-call"),
		).toBe(true);
		expect(
			findings.some((finding) => finding.rule === RULES.forbiddenCall && finding.symbol === "tagged-template"),
		).toBe(true);
	});

	test("rejects shadowed process payloads and extra worker invocations", async () => {
		const command = await readFile(
			path.join(import.meta.dir, "../packages/coding-agent/src/commands/worktree.ts"),
			"utf8",
		);
		const shadowedProcess = command.replace(
			"const root = getWorktreesDir();",
			'const process = { platform: "win32", stdout: { write() {} }, stderr: { write() {} } }; const root = getWorktreesDir();',
		);
		expect(
			analyzeSource(shadowedProcess, "packages/coding-agent/src/commands/worktree.ts").some(
				(finding) => finding.rule === RULES.getterTiming,
			),
		).toBe(true);
		const reassignedProcess = command.replace(
			"const root = getWorktreesDir();",
			'process = { platform: "win32" } as typeof process; const root = getWorktreesDir();',
		);
		expect(
			analyzeSource(reassignedProcess, "packages/coding-agent/src/commands/worktree.ts").some(
				(finding) => finding.rule === RULES.getterTiming,
			),
		).toBe(true);
		const extraCall = command.replace(
			"if (result.stdout.length > 0)",
			`await runWorktreeCommand({
				root,
				platform: process.platform === "win32" ? "win32" : "posix",
				action,
				json,
				dryRun,
			});
			if (result.stdout.length > 0)`,
		);
		expect(
			analyzeSource(extraCall, "packages/coding-agent/src/commands/worktree.ts").some(
				(finding) => finding.rule === RULES.getterTiming,
			),
		).toBe(true);
		const nestedCall = command.replace(
			"const result = await runWorktreeCommand({",
			`const nested = () => runWorktreeCommand({
				root,
				platform: process.platform === "win32" ? "win32" : "posix",
				action,
				json,
				dryRun,
			});
			await nested();
			const result = await runWorktreeCommand({`,
		);
		expect(
			analyzeSource(nestedCall, "packages/coding-agent/src/commands/worktree.ts").some(
				(finding) => finding.rule === RULES.getterTiming,
			),
		).toBe(true);
	});
	test("rejects exported handles, transfer escapes, and mutable read limits", () => {
		const source = `import { constants } from "node:fs"; import { open } from "node:fs/promises";
			const CHUNK_BYTES = 9000;
			export const leaked = await open("top", constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
			let outer;
			export default { leaked };
			class Leak {
				field = leaked;
				#privateField = leaked;
			}
			export async function* scan() {
				outer = await open("outer", constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
				const handle = await open("local", constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
				const buffer = Buffer.alloc(9001);
				let offset = 0;
				const read = await handle.read(buffer, offset, Math.min(CHUNK_BYTES, buffer.length - offset), offset);
				offset += read.bytesRead;
				yield handle;
				throw handle;
			}`;
		const findings = analyzeSource(source, `${fixture}/allowed.ts`);
		expect(findings.filter((finding) => finding.symbol === "FileHandle.extraction").length).toBeGreaterThanOrEqual(4);
		expect(
			findings.some((finding) => finding.rule === RULES.scannerApi && finding.symbol === "FileHandle.read:signature"),
		).toBe(true);
	});

	test("rejects worker scanner decoys outside exported body", () => {
		const source = `import { scanWorktrees } from "./worktree-scanner";
			function decoy(options: { root: string; platform: "posix" | "win32" }) { return scanWorktrees({ root: options.root, platform: options.platform }); }
			export async function runWorktreeCommand(options: { root: string; platform: "posix" | "win32" }) { return 1; }`;
		expect(
			analyzeSource(source, "packages/coding-agent/src/cli/worktree-cli.ts").some(
				(finding) => finding.rule === RULES.scannerApi && finding.symbol === "worker-scan-contract",
			),
		).toBe(true);
	});
	test("rejects hostile capability graph forms", async () => {
		const cli = analyzeSource(
			"fetch('x'); Bun.write('x', 'y'); new WebSocket('x'); process.env.X = '1';",
			"packages/coding-agent/src/cli.ts",
		);
		expect(cli.some((finding) => finding.rule === RULES.forbiddenCall && finding.symbol === "fetch")).toBe(true);
		expect(cli.some((finding) => finding.rule === RULES.forbiddenMember && finding.symbol === "Bun.write")).toBe(true);
		expect(cli.some((finding) => finding.rule === RULES.forbiddenCall && finding.symbol === "WebSocket")).toBe(true);
		expect(cli.some((finding) => finding.rule === RULES.process && finding.symbol === "process.env")).toBe(true);
		const unsupported = analyzeSource("(0, open)('x', O_WRONLY);", `${fixture}/allowed.ts`);
		expect(
			unsupported.some((finding) => finding.rule === RULES.unknownBinding && finding.symbol === "unsupported-callee"),
		).toBe(true);
		const roots = await verifyWorktreeReportCapabilities({
			repoRoot: path.resolve(import.meta.dir, ".."),
			roots: [
				"",
				"packages/../outside.ts",
				"/absolute.ts",
				"scripts/fixtures/worktree-report-capabilities/allowed.ts",
				"scripts/fixtures/worktree-report-capabilities/allowed.ts",
			],
		});
		expect(roots.some((finding) => finding.symbol === "invalid-replacement-root")).toBe(true);
		expect(roots.some((finding) => finding.symbol === "duplicate-root")).toBe(true);
	});
	test("rejects privileged value transfer and unsupported callee families", () => {
		const transfers = analyzeSource(
			`import { constants } from "node:fs"; import { open } from "node:fs/promises";
			const invoke = (fn: typeof open) => fn("x", constants.O_WRONLY);
			void invoke(open);
			const api = { open };
			void api;
			export { open };
			export default open;`,
			`${fixture}/allowed.ts`,
		);
		expect(
			transfers.filter(
				(finding) => finding.rule === RULES.unknownBinding && finding.symbol === "capability-transfer:open",
			).length,
		).toBeGreaterThanOrEqual(4);

		const unsupported = analyzeSource(
			`import { constants } from "node:fs"; import { open } from "node:fs/promises";
			(0, open)("sequence", constants.O_WRONLY);
			(true ? open : open)("conditional", constants.O_WRONLY);
			(open || open)("logical", constants.O_WRONLY);`,
			`${fixture}/allowed.ts`,
		);
		expect(unsupported.filter((finding) => finding.symbol === "unsupported-callee")).toHaveLength(3);
	});

	test("rejects unreachable command flow, getter transfer, and mutation helpers", async () => {
		const command = await readFile(
			path.join(import.meta.dir, "../packages/coding-agent/src/commands/worktree.ts"),
			"utf8",
		);
		for (const terminal of ["return;", 'throw new Error("decoy");']) {
			const hostile = command.replace(
				"const { args, flags, argv } = await this.parse(Worktree);",
				`${terminal}\n\t\t\tconst { args, flags, argv } = await this.parse(Worktree);`,
			);
			expect(
				analyzeSource(hostile, "packages/coding-agent/src/commands/worktree.ts").some(
					(finding) => finding.rule === RULES.getterTiming,
				),
			).toBe(true);
		}

		const getterTransfer = command.replace(
			"const root = getWorktreesDir();",
			"const getterAlias = getWorktreesDir; const getterBox = { getWorktreesDir }; void getterAlias; void getterBox; const root = getWorktreesDir();",
		);
		expect(
			analyzeSource(getterTransfer, "packages/coding-agent/src/commands/worktree.ts").some(
				(finding) => finding.rule === RULES.getterTiming,
			),
		).toBe(true);

		const helperMutation = command.replace(
			'const action = args.action === "clear" ? "clear" : "list";',
			`Object.assign(args, { action: "clear" });
			Object.assign(flags, { all: false });
			Object.assign(process, { platform: "win32" });
			const action = args.action === "clear" ? "clear" : "list";`,
		);
		expect(
			analyzeSource(helperMutation, "packages/coding-agent/src/commands/worktree.ts").some(
				(finding) => finding.rule === RULES.forbiddenMember && finding.symbol === "Object.assign",
			),
		).toBe(true);
	});

	test("rejects unreachable, post-return, and unconsumed worker scans", async () => {
		const worker = await readFile(
			path.join(import.meta.dir, "../packages/coding-agent/src/cli/worktree-cli.ts"),
			"utf8",
		);
		const falseBranch = worker.replace(
			"diagnostics = await scanWorktrees({ root: options.root, platform: options.platform });",
			"if (false) diagnostics = await scanWorktrees({ root: options.root, platform: options.platform }); else diagnostics = [];",
		);
		expect(
			analyzeSource(falseBranch, "packages/coding-agent/src/cli/worktree-cli.ts").some(
				(finding) => finding.rule === RULES.scannerApi && finding.symbol === "worker-scan-contract",
			),
		).toBe(true);

		for (const body of [
			`let diagnostics; return []; diagnostics = await scanWorktrees({ root: options.root, platform: options.platform });`,
			`await scanWorktrees({ root: options.root, platform: options.platform }); return [];`,
		]) {
			const hostile = `import { scanWorktrees } from "./worktree-scanner";
				export async function runWorktreeCommand(options: { root: string; platform: "posix" | "win32" }) { ${body} }`;
			expect(
				analyzeSource(hostile, "packages/coding-agent/src/cli/worktree-cli.ts").some(
					(finding) => finding.rule === RULES.scannerApi && finding.symbol === "worker-scan-contract",
				),
			).toBe(true);
		}
	});
	test("rejects closed-world CLI capability and registry mutations", async () => {
		const cli = await readFile(path.join(import.meta.dir, "../packages/coding-agent/src/cli.ts"), "utf8");
		const mutants = [
			`${cli}\ncommands.length = 0;`,
			`${cli}\n(0, eval)("payload");`,
			`${cli}\n(true ? eval : eval)("payload");`,
			`${cli}\n(eval || eval)("payload");`,
			`${cli}\neval?.("payload");`,
			`${cli}\neval\`payload\`;`,
			`${cli}\nlet request; request = fetch; request("https://example.invalid");`,
			`${cli}\nFunction("return process")();`,
			`${cli}\nprocess.exit(0);`,
		];
		for (const source of mutants) {
			expect(analyzeSource(source, "packages/coding-agent/src/cli.ts").length).toBeGreaterThan(0);
		}
	});

	test("rejects privileged scanner wrapper exports", async () => {
		const scanner = await readFile(
			path.join(import.meta.dir, "../packages/coding-agent/src/cli/worktree-scanner.ts"),
			"utf8",
		);
		for (const source of [
			`${scanner}\nexport const leaked = (candidate: string) => lstat(candidate, { bigint: true });`,
			`${scanner}\nconst leaked = { inspect: (candidate: string) => lstat(candidate, { bigint: true }) }; export default leaked;`,
		]) {
			expect(
				analyzeSource(source, "packages/coding-agent/src/cli/worktree-scanner.ts").some(
					(finding) => finding.rule === RULES.scannerApi && finding.symbol === "export-surface",
				),
			).toBe(true);
		}
	});

	test("rejects duplicate and unreachable command authority", async () => {
		const command = await readFile(
			path.join(import.meta.dir, "../packages/coding-agent/src/commands/worktree.ts"),
			"utf8",
		);
		const duplicateRun = command.replace("\n\t};\n}", "\n\t\tasync run(): Promise<void> { return; }\n\t};\n}");
		const nestedTerminal = command.replace(
			"const { args, flags, argv } = await this.parse(Worktree);",
			"if (true) return;\n\t\t\tconst { args, flags, argv } = await this.parse(Worktree);",
		);
		const terminalAlternate = command.replace(
			"\t\t\t}\n\t\t\tconst root = getWorktreesDir();",
			"\t\t\t} else { return; }\n\t\t\tconst root = getWorktreesDir();",
		);
		const fakeRender = command.replace(
			"if (result.stdout.length > 0) process.stdout.write(result.stdout);",
			"void result.stdout;",
		);
		for (const source of [duplicateRun, nestedTerminal, terminalAlternate, fakeRender]) {
			expect(
				analyzeSource(source, "packages/coding-agent/src/commands/worktree.ts").some(
					(finding) => finding.rule === RULES.getterTiming,
				),
			).toBe(true);
		}
	});

	test("rejects nested, looped, and semantically unconsumed scans", async () => {
		const worker = await readFile(
			path.join(import.meta.dir, "../packages/coding-agent/src/cli/worktree-cli.ts"),
			"utf8",
		);
		const nestedTerminal = worker.replace(
			"diagnostics = await scanWorktrees({ root: options.root, platform: options.platform });",
			'if (true) return { stdout: "forged", stderr: "", exitCode: 0 }; diagnostics = await scanWorktrees({ root: options.root, platform: options.platform });',
		);
		const looped = worker.replace(
			"diagnostics = await scanWorktrees({ root: options.root, platform: options.platform });",
			"while (false) { diagnostics = await scanWorktrees({ root: options.root, platform: options.platform }); }",
		);
		const unconsumed = `import { scanWorktrees } from "./worktree-scanner";
			export async function runWorktreeCommand(options: { root: string; platform: "posix" | "win32" }) {
				let diagnostics;
				try { diagnostics = await scanWorktrees({ root: options.root, platform: options.platform }); } catch {}
				void diagnostics;
				return { stdout: "forged", stderr: "", exitCode: 0 };
			}`;
		for (const source of [nestedTerminal, looped, unconsumed]) {
			expect(
				analyzeSource(source, "packages/coding-agent/src/cli/worktree-cli.ts").some(
					(finding) => finding.rule === RULES.scannerApi && finding.symbol === "worker-scan-contract",
				),
			).toBe(true);
		}
	});

	test("rejects noncanonical and authoritative-duplicate additive roots", async () => {
		const findings = await verifyWorktreeReportCapabilities({
			repoRoot: path.resolve(import.meta.dir, ".."),
			roots: [
				"scripts/fixtures/worktree-report-capabilities/../worktree-report-capabilities/allowed.ts",
				"packages/coding-agent/src/cli.ts",
			],
		});
		expect(
			findings.some(
				(finding) =>
					finding.path === "scripts/fixtures/worktree-report-capabilities/../worktree-report-capabilities/allowed.ts" &&
					finding.symbol === "invalid-replacement-root",
			),
		).toBe(true);
		expect(
			findings.some(
				(finding) => finding.path === "packages/coding-agent/src/cli.ts" && finding.symbol === "duplicate-root",
			),
		).toBe(true);
	});
	test("rejects computed command authority and fake terminal sinks", async () => {
		const command = await readFile(
			path.join(import.meta.dir, "../packages/coding-agent/src/commands/worktree.ts"),
			"utf8",
		);
		const computedRun = command.replace("\n\t};\n}", '\n\t\tasync ["run"](): Promise<void> { return; }\n\t};\n}');
		const runField = command.replace("\n\t};\n}", "\n\t\trun = async (): Promise<void> => {};\n\t};\n}");
		const reassignedFactory = `${command}
createWorktreeCommand = () => class Worktree extends Command { async run(): Promise<void> {} };`;
		const loopReassignedFactory = `${command}
for ({ createWorktreeCommand } of [{
	createWorktreeCommand: () => class Worktree extends Command { async run(): Promise<void> {} },
}]) {}`;
		const nonNullReassignedFactory = `${command}
createWorktreeCommand! = () => class Worktree extends Command { async run(): Promise<void> {} };`;
		const fakeReads = command
			.replace("if (result.stdout.length > 0) process.stdout.write(result.stdout);", "result.stdout.length;")
			.replace("if (result.stderr.length > 0) process.stderr.write(result.stderr);", "result.stderr.length;")
			.replace("if (result.exitCode !== 0) process.exitCode = result.exitCode;", "result.exitCode;");
		const throwing = command.replace(
			"if (result.stdout.length > 0) process.stdout.write(result.stdout);",
			'if (result.stdout.length >= 0) throw new Error("stop");',
		);
		for (const source of [computedRun, runField]) {
			expect(
				analyzeSource(source, "packages/coding-agent/src/commands/worktree.ts").some(
					(finding) => finding.rule === RULES.getterTiming && finding.symbol === "run-count",
				),
			).toBe(true);
		}
		for (const source of [reassignedFactory, loopReassignedFactory, nonNullReassignedFactory]) {
			expect(
				analyzeSource(source, "packages/coding-agent/src/commands/worktree.ts").some(
					(finding) => finding.rule === RULES.getterTiming,
				),
			).toBe(true);
		}
		for (const source of [fakeReads, throwing]) {
			expect(
				analyzeSource(source, "packages/coding-agent/src/commands/worktree.ts").some(
					(finding) => finding.rule === RULES.getterTiming,
				),
			).toBe(true);
		}
	});

	test("rejects finalizer and forged worker result dataflow", async () => {
		const worker = await readFile(
			path.join(import.meta.dir, "../packages/coding-agent/src/cli/worktree-cli.ts"),
			"utf8",
		);
		const finalizer = worker.replace(
			'\n\t}\n\tif (options.action === "list")',
			'\n\t} finally { return { stdout: "forged", stderr: "", exitCode: 0 }; }\n\tif (options.action === "list")',
		);
		const forged = worker.replace(
			"0 removed · ${diagnostics.length} kept",
			'${diagnostics.length >= 0 ? "forged" : "forged"}',
		);
		const reassignedWorker = `${worker}
runWorktreeCommand = async () => ({ stdout: "forged", stderr: "", exitCode: 0 });`;
		const loopReassignedWorker = `${worker}
for ({ runWorktreeCommand } of [{
	runWorktreeCommand: async () => ({ stdout: "forged", stderr: "", exitCode: 0 }),
}]) {}`;
		const nonNullReassignedWorker = `${worker}
runWorktreeCommand! = async () => ({ stdout: "forged", stderr: "", exitCode: 0 });`;
		for (const source of [finalizer, forged]) {
			expect(
				analyzeSource(source, "packages/coding-agent/src/cli/worktree-cli.ts").some(
					(finding) => finding.rule === RULES.scannerApi,
				),
			).toBe(true);
		}
		for (const source of [reassignedWorker, loopReassignedWorker, nonNullReassignedWorker]) {
			expect(
				analyzeSource(source, "packages/coding-agent/src/cli/worktree-cli.ts").some(
					(finding) => finding.rule === RULES.scannerApi && finding.symbol === "worker-scan-contract",
				),
			).toBe(true);
		}
	});

	test("rejects bound registry mutation and scanner export facade", async () => {
		const cli = await readFile(path.join(import.meta.dir, "../packages/coding-agent/src/cli.ts"), "utf8");
		const registryMutation = `${cli}
commands.unshift({ name: "worktree", aliases: ["wt"], load: async () => class Worktree extends Command { async run() {} } });`;
		const escapedRegistry = `${cli}
const box = { commands };
box.commands.unshift({ name: "worktree", load: async () => class Worktree extends Command { async run() {} } });`;
		expect(
			analyzeSource(registryMutation, "packages/coding-agent/src/cli.ts").some(
				(finding) => finding.rule === RULES.mutation && finding.symbol === "registry-mutation",
			),
		).toBe(true);
		expect(
			analyzeSource(escapedRegistry, "packages/coding-agent/src/cli.ts").some(
				(finding) => finding.rule === RULES.mutation && finding.symbol === "registry-mutation",
			),
		).toBe(true);

		const scanner = await readFile(
			path.join(import.meta.dir, "../packages/coding-agent/src/cli/worktree-scanner.ts"),
			"utf8",
		);
		const facade = scanner
			.replace("export async function scanWorktrees", "async function originalScanWorktrees")
			.concat(`
const facade = async (options: ScanWorktreesOptions): Promise<WorktreeDiagnostic[]> => {
	void lstat(options.root, { bigint: true });
	return [];
};
export { facade as scanWorktrees };`);
		const directFacade = scanner
			.replace("export async function scanWorktrees", "async function originalScanWorktrees")
			.concat(`
export async function scanWorktrees(_options: ScanWorktreesOptions): Promise<WorktreeDiagnostic[]> {
	return [];
}`);
		expect(
			analyzeSource(facade, "packages/coding-agent/src/cli/worktree-scanner.ts").some(
				(finding) => finding.rule === RULES.scannerApi && finding.symbol === "export-surface",
			),
		).toBe(true);
		expect(
			analyzeSource(directFacade, "packages/coding-agent/src/cli/worktree-scanner.ts").some(
				(finding) => finding.rule === RULES.scannerApi && finding.symbol === "scanner-flow:open",
			),
		).toBe(true);
	});
	test("rejects process aliases, scanner rebinding, and top-level command sinks", async () => {
		const cli = await readFile(path.join(import.meta.dir, "../packages/coding-agent/src/cli.ts"), "utf8");
		const processAlias = `${cli}
const terminate = process.exit;
terminate(0);`;
		const destructuredProcess = `${cli}
const { exit: terminate } = process;
terminate(0);`;
		const shorthandCapabilities = `${cli}
const leaked = { fetch, eval, process };
void leaked;`;
		expect(
			analyzeSource(processAlias, "packages/coding-agent/src/cli.ts").some(
				(finding) => finding.rule === RULES.process && finding.symbol === "process-transfer:exit",
			),
		).toBe(true);
		expect(
			analyzeSource(destructuredProcess, "packages/coding-agent/src/cli.ts").some(
				(finding) => finding.rule === RULES.process && finding.symbol === "process-transfer:process",
			),
		).toBe(true);
		const shorthandFindings = analyzeSource(shorthandCapabilities, "packages/coding-agent/src/cli.ts");
		expect(
			shorthandFindings.some((finding) => finding.rule === RULES.forbiddenCall && finding.symbol === "fetch"),
		).toBe(true);
		expect(shorthandFindings.some((finding) => finding.rule === RULES.forbiddenCall && finding.symbol === "eval")).toBe(
			true,
		);
		expect(
			shorthandFindings.some(
				(finding) => finding.rule === RULES.process && finding.symbol === "process-transfer:process",
			),
		).toBe(true);
		const scannerShorthandFindings = analyzeSource(
			"const leaked = { fetch, eval, process }; void leaked;",
			`${fixture}/allowed.ts`,
		);
		for (const [rule, symbol] of [
			[RULES.forbiddenCall, "fetch"],
			[RULES.forbiddenCall, "eval"],
			[RULES.process, "process"],
		] as const) {
			expect(scannerShorthandFindings.some((finding) => finding.rule === rule && finding.symbol === symbol)).toBe(true);
		}

		const scanner = await readFile(
			path.join(import.meta.dir, "../packages/coding-agent/src/cli/worktree-scanner.ts"),
			"utf8",
		);
		const reboundScanner = `${scanner}
scanWorktrees = async (_options: ScanWorktreesOptions): Promise<WorktreeDiagnostic[]> => [];`;
		const satisfiesReboundScanner = `${scanner}
for ((scanWorktrees satisfies typeof scanWorktrees) of [
	async (_options: ScanWorktreesOptions): Promise<WorktreeDiagnostic[]> => [],
]) {}`;
		expect(
			analyzeSource(reboundScanner, "packages/coding-agent/src/cli/worktree-scanner.ts").some(
				(finding) => finding.rule === RULES.scannerApi && finding.symbol === "scanner-binding-mutation",
			),
		).toBe(true);
		expect(
			analyzeSource(satisfiesReboundScanner, "packages/coding-agent/src/cli/worktree-scanner.ts").some(
				(finding) => finding.rule === RULES.scannerApi && finding.symbol === "scanner-binding-mutation",
			),
		).toBe(true);

		const command = await readFile(
			path.join(import.meta.dir, "../packages/coding-agent/src/commands/worktree.ts"),
			"utf8",
		);
		const topLevelSink = `${command}
process.stdout.write("forged before run\\n");`;
		const forgedRunClass = `${command}
class Forged {
	run(): void {
		process.stdout.write("forged\\n");
		process.exitCode = 0;
	}
}`;
		expect(
			analyzeSource(topLevelSink, "packages/coding-agent/src/commands/worktree.ts").some(
				(finding) => finding.rule === RULES.process && finding.symbol === "process.stdout",
			),
		).toBe(true);
		expect(
			analyzeSource(forgedRunClass, "packages/coding-agent/src/commands/worktree.ts").some(
				(finding) => finding.rule === RULES.getterTiming,
			),
		).toBe(true);
	});
	test("graphRoot integration reports ambiguous selected leaves deterministically", async () => {
		const repoRoot = await mkdtemp(path.join(path.dirname(import.meta.dir), "wtr-graph-"));
		try {
			await mkdir(path.join(repoRoot, "packages/coding-agent/src/commands"), { recursive: true });
			await writeFile(path.join(repoRoot, "tsconfig.json"), JSON.stringify({ compilerOptions: {} }));
			await writeFile(
				path.join(repoRoot, "packages/coding-agent/src/cli.ts"),
				`export const commands = [{ name: "worktree", load: async () => { const { createWorktreeCommand } = await import("./commands/worktree"); return createWorktreeCommand; } }];`,
			);
			await writeFile(path.join(repoRoot, "packages/coding-agent/src/commands/worktree.ts"), "export const createWorktreeCommand = () => class Worktree {};");
			await mkdir(path.join(repoRoot, "packages/coding-agent/src/commands/worktree"), { recursive: true });
			await writeFile(path.join(repoRoot, "packages/coding-agent/src/commands/worktree/index.tsx"), "export const createWorktreeCommand = () => class Worktree {};");
			const findings = await verifyWorktreeReportCapabilities({
				repoRoot,
				graphRoot: "packages/coding-agent/src/cli.ts",
			});
			const receipts = findings.map(formatFinding);
			expect(findings).toEqual(sortFindings(findings));
			expect(receipts.some((receipt) => receipt.includes("ambiguous-edge:./commands/worktree"))).toBe(true);
		} finally {
			await rm(repoRoot, { recursive: true, force: true });
		}
	});
	test("graphRoot integration fails closed on malformed alias configuration", async () => {
		const repoRoot = await mkdtemp(path.join(path.dirname(import.meta.dir), "wtr-config-"));
		try {
			await mkdir(path.join(repoRoot, "packages/coding-agent/src"), { recursive: true });
			await writeFile(path.join(repoRoot, "tsconfig.json"), JSON.stringify({ compilerOptions: { paths: { "@fixture/*": ["outside/*", "other/*"] } } }));
			await writeFile(path.join(repoRoot, "packages/coding-agent/src/cli.ts"), "export const commands = [];");
			const findings = await verifyWorktreeReportCapabilities({
				repoRoot,
				graphRoot: "packages/coding-agent/src/cli.ts",
			});
			expect(findings.some((finding) => finding.symbol.startsWith("tsconfig:"))).toBe(true);
		} finally {
			await rm(repoRoot, { recursive: true, force: true });
		}
	});
	test("graphRoot integration accepts the copied direct production graph", async () => {
		const repoRoot = await makeGraph();
		try {
			const findings = await graphFindings(repoRoot);
			expect(findings.filter((finding) => finding.symbol.includes("edge") || finding.symbol.includes("reachable"))).toEqual([]);
		} finally {
			await rm(repoRoot, { recursive: true, force: true });
		}
	});
	test("graphRoot integration resolves wildcard aliases before external skip", async () => {
		const repoRoot = await makeGraph({}, { paths: { "@fixture/*": ["packages/coding-agent/src/*"] } });
		try {
			const findings = await graphFindings(repoRoot);
			expect(findings.some((finding) => finding.symbol.startsWith("tsconfig:"))).toBe(false);
		} finally {
			await rm(repoRoot, { recursive: true, force: true });
		}
	});
	test("graphRoot integration resolves index-only selected modules", async () => {
		const commandSource = await readFile(
			path.join(import.meta.dir, "..", "packages/coding-agent/src/commands/worktree.ts"),
			"utf8",
		);
		const repoRoot = await makeGraph({
			"packages/coding-agent/src/commands/worktree.ts": "export * from './barrel';",
			"packages/coding-agent/src/commands/barrel/index.ts": "export * from '../command-leaf';",
			"packages/coding-agent/src/commands/command-leaf.ts": commandSource,
		});
		try {
			const findings = await graphFindings(repoRoot);
			expect(findings).toEqual([]);
		} finally {
			await rm(repoRoot, { recursive: true, force: true });
		}
	});
	test("same-file selected binding ambiguity cannot hide hostile decoy", async () => {
		const repoRoot = await makeGraph({
			"packages/coding-agent/src/commands/worktree.ts": "export const decoy = () => class Worktree {}; export const createWorktreeCommand = process;",
		});
		try {
			const findings = await graphFindings(repoRoot);
			expect(findings.some((finding) => finding.rule === RULES.unknownBinding || finding.rule === RULES.process)).toBe(true);
		} finally {
			await rm(repoRoot, { recursive: true, force: true });
		}
	});
	test("graphRoot integration rejects wrong selected export", async () => {
		const repoRoot = await makeGraph({
			"packages/coding-agent/src/commands/worktree.ts": "export const other = () => class Worktree {};",
		});
		try {
			const findings = await graphFindings(repoRoot);
			expect(findings.some((finding) => finding.symbol === "selected-command-ambiguous")).toBe(true);
		} finally {
			await rm(repoRoot, { recursive: true, force: true });
		}
	});
	test("graphRoot integration rejects wrong importer and phase", async () => {
		const repoRoot = await makeGraph({
			"packages/coding-agent/src/cli.ts": "export const commands = [{ name: 'worktree', load: async () => import('./commands/worktree') }];",
		});
		try {
			const findings = await graphFindings(repoRoot);
			expect(findings.some((finding) => finding.rule === RULES.registryEdge)).toBe(true);
		} finally {
			await rm(repoRoot, { recursive: true, force: true });
		}
	});
	test("graphRoot integration reports unresolved dynamic wrapper", async () => {
		const repoRoot = await makeGraph({
			"packages/coding-agent/src/cli.ts": "const moduleName = './commands/worktree'; export const commands = [{ name: 'worktree', load: async () => import(moduleName) }];",
		});
		try {
			const findings = await graphFindings(repoRoot);
			expect(findings.some((finding) => finding.symbol === "selected-edge-count:0")).toBe(true);
		} finally {
			await rm(repoRoot, { recursive: true, force: true });
		}
	});
	test("graphRoot integration rejects authority-bearing bridge", async () => {
		const repoRoot = await makeGraph({
			"packages/coding-agent/src/commands/worktree.ts": "export const forged = 1; export const createWorktreeCommand = () => class Worktree {};",
		});
		try {
			const findings = await graphFindings(repoRoot);
			expect(findings.some((finding) => finding.rule === RULES.getterTiming || finding.rule === RULES.unknownBinding)).toBe(true);
		} finally {
			await rm(repoRoot, { recursive: true, force: true });
		}
	});
	test("named barrel resolves copied production command leaf", async () => {
		const command = await readFile(path.join(import.meta.dir, "..", "packages/coding-agent/src/commands/worktree.ts"), "utf8");
		const repoRoot = await makeGraph({
			"packages/coding-agent/src/commands/worktree.ts": `export { createWorktreeCommand } from "./worktree-leaf";`,
			"packages/coding-agent/src/commands/worktree-leaf.ts": command,
		});
		try {
			const findings = await graphFindings(repoRoot);
			expect(findings).toEqual([]);
		} finally {
			await rm(repoRoot, { recursive: true, force: true });
		}
	});
	test("default reexport resolves binding and fails closed for unapproved default leaf", async () => {
		const command = await readFile(path.join(import.meta.dir, "..", "packages/coding-agent/src/commands/worktree.ts"), "utf8");
		const repoRoot = await makeGraph({
			"packages/coding-agent/src/commands/worktree.ts": `export { default as createWorktreeCommand } from "./default-leaf";`,
			"packages/coding-agent/src/commands/default-leaf.ts": command.replace(
				"export function createWorktreeCommand",
				"export default function notApprovedWorktreeCommand",
			),
		});
		try {
			const receipts = (await graphFindings(repoRoot)).map(formatFinding);
			expect(receipts.some((value) => value.includes("selected-command"))).toBe(false);
			expect(receipts.length).toBeGreaterThan(0);
		} finally {
			await rm(repoRoot, { recursive: true, force: true });
		}
	});
	test("namespace reexport fails closed with exact namespace-selection receipt", async () => {
		const command = await readFile(path.join(import.meta.dir, "..", "packages/coding-agent/src/commands/worktree.ts"), "utf8");
		const repoRoot = await makeGraph({
			"packages/coding-agent/src/commands/worktree.ts": `import * as leaf from "./namespace-leaf"; export { leaf as createWorktreeCommand };`,
			"packages/coding-agent/src/commands/namespace-leaf.ts": command,
		});
		try {
			const receipts = (await graphFindings(repoRoot)).map(formatFinding);
			expect(receipts.filter((value) => value.includes("namespace-selection"))).toHaveLength(1);
		} finally {
			await rm(repoRoot, { recursive: true, force: true });
		}
	});
	test("export-star barrel cycle resolves one copied production leaf", async () => {
		const command = await readFile(path.join(import.meta.dir, "..", "packages/coding-agent/src/commands/worktree.ts"), "utf8");
		const repoRoot = await makeGraph({
			"packages/coding-agent/src/commands/worktree.ts": `export * from "./barrel-a";`,
			"packages/coding-agent/src/commands/barrel-a.ts": `export * from "./barrel-b";`,
			"packages/coding-agent/src/commands/barrel-b.ts": `export * from "./barrel-a"; export * from "./star-leaf";`,
			"packages/coding-agent/src/commands/star-leaf.ts": command,
		});
		try {
			const findings = await graphFindings(repoRoot);
			expect(findings).toEqual([]);
		} finally {
			await rm(repoRoot, { recursive: true, force: true });
		}
	});
	test("ambiguous export-star leaves produce selected-command ambiguity", async () => {
		const command = await readFile(path.join(import.meta.dir, "..", "packages/coding-agent/src/commands/worktree.ts"), "utf8");
		const repoRoot = await makeGraph({
			"packages/coding-agent/src/commands/worktree.ts": `export * from "./star-a"; export * from "./star-b";`,
			"packages/coding-agent/src/commands/star-a.ts": command,
			"packages/coding-agent/src/commands/star-b.ts": command,
		});
		try {
			const receipts = (await graphFindings(repoRoot)).map(formatFinding);
			expect(receipts.some((value) => value.includes("selected-command-ambiguous"))).toBe(true);
		} finally {
			await rm(repoRoot, { recursive: true, force: true });
		}
	});
	test("authority-bearing bridge emits unsafe-bridge", async () => {
		const command = await readFile(path.join(import.meta.dir, "..", "packages/coding-agent/src/commands/worktree.ts"), "utf8");
		const repoRoot = await makeGraph({
			"packages/coding-agent/src/commands/worktree.ts": `export * from "./authority-bridge";`,
			"packages/coding-agent/src/commands/authority-bridge.ts": `export * from "./authority-leaf"; const leak = process;`,
			"packages/coding-agent/src/commands/authority-leaf.ts": command,
		});
		try {
			const receipts = (await graphFindings(repoRoot)).map(formatFinding);
			expect(receipts.some((value) => value.includes("unsafe-bridge"))).toBe(true);
		} finally {
			await rm(repoRoot, { recursive: true, force: true });
		}
	});
	test("type-only bridge edges are safe and selected type exports fail closed", async () => {
		const command = await readFile(path.join(import.meta.dir, "..", "packages/coding-agent/src/commands/worktree.ts"), "utf8");
		const safeRoot = await makeGraph({
			"packages/coding-agent/src/commands/worktree.ts": `export { createWorktreeCommand } from "./bridge";`,
			"packages/coding-agent/src/commands/bridge.ts": `import { type Foo } from "./types"; export { createWorktreeCommand } from "./leaf";`,
			"packages/coding-agent/src/commands/types.ts": "export type Foo = string;",
			"packages/coding-agent/src/commands/leaf.ts": command,
		});
		try {
			const safeFindings = await graphFindings(safeRoot);
			expect(safeFindings.some((finding) => finding.symbol === "unsafe-bridge")).toBe(false);
		} finally {
			await rm(safeRoot, { recursive: true, force: true });
		}
		const hostileRoot = await makeGraph({
			"packages/coding-agent/src/commands/worktree.ts": `export { createWorktreeCommand } from "./bridge";`,
			"packages/coding-agent/src/commands/bridge.ts": `export { type createWorktreeCommand } from "./leaf";`,
			"packages/coding-agent/src/commands/leaf.ts": command,
		});
		try {
			const hostileFindings = await graphFindings(hostileRoot);
			expect(hostileFindings.filter((finding) => finding.symbol === "type-only-selection")).toHaveLength(1);
		} finally {
			await rm(hostileRoot, { recursive: true, force: true });
		}
	});
	test("selected command leaf receives command role override by filename", async () => {
		const command = await readFile(path.join(import.meta.dir, "..", "packages/coding-agent/src/commands/worktree.ts"), "utf8");
		const repoRoot = await makeGraph({
			"packages/coding-agent/src/commands/worktree.ts": `export { createWorktreeCommand } from "./renamed-leaf";`,
			"packages/coding-agent/src/commands/renamed-leaf.ts": command.replace("const root = getWorktreesDir();", "const eager = getWorktreesDir(); const root = getWorktreesDir();"),
		});
		try {
			const receipts = (await graphFindings(repoRoot)).map(formatFinding);
			expect(receipts.some((value) => value.includes("WTR008_FACTORY_GETTER_TIMING"))).toBe(true);
		} finally {
			await rm(repoRoot, { recursive: true, force: true });
		}
	});
	test("additive decoy roots cannot mask the production authoritative graph", async () => {
		const repoRoot = path.resolve(import.meta.dir, "..");
		const findings = await verifyWorktreeReportCapabilities({
			repoRoot,
			roots: ["scripts/fixtures/worktree-report-capabilities/allowed.ts"],
		});
		expect(findings.filter((finding) => finding.path === "packages/coding-agent/src/cli.ts")).toEqual([]);
	});
	test("graphRoot integration emits deterministic multi-finding receipts", async () => {
		const repoRoot = await makeGraph({
			"packages/coding-agent/src/cli.ts": "export const commands = [{ name: 'worktree', load: async () => import(name) }];",
		});
		try {
			const findings = await graphFindings(repoRoot);
			expect(findings).toEqual(sortFindings(findings));
		} finally {
			await rm(repoRoot, { recursive: true, force: true });
		}
	});
	test("handle references distinguish keys, members, shorthand, and computed escapes", () => {
		const source = `import { open } from "node:fs/promises"; import { constants } from "node:fs";
export async function scanWorktrees() {
	const handle = await open("x", constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
	const other = { handle: 1 };
	other.handle;
	const leaked = { handle };
	const computed = { [handle]: 1 };
	void leaked;
	void computed;
	await handle.close(); await handle.stat(); await handle.read(Buffer.alloc(1));
}`;
		const findings = analyzeSource(source, "packages/coding-agent/src/cli/worktree-scanner.ts");
		expect(findings.some((finding) => finding.symbol === "FileHandle.extraction")).toBe(true);
	});
	test("reachable bridges analyze unselected runtime reexports", async () => {
		const repoRoot = await makeGraph({
			"packages/coding-agent/src/commands/worktree.ts": `export { createWorktreeCommand } from "./safe"; export * from "./hostile";`,
			"packages/coding-agent/src/commands/safe.ts": `export { createWorktreeCommand } from "./leaf";`,
			"packages/coding-agent/src/commands/hostile.ts": `import "node:fs"; export const leak = process;`,
		});
		try {
			const findings = await graphFindings(repoRoot);
			expect(findings.some((finding) => finding.symbol === "unsafe-bridge")).toBe(true);
		} finally {
			await rm(repoRoot, { recursive: true, force: true });
		}
	});
	test("selected malformed and unreadable leaves fail closed", async () => {
		const malformed = await makeGraph({
			"packages/coding-agent/src/cli/worktree-cli.ts": "export function runWorktreeCommand( {",
		});
		try {
			const findings = await graphFindings(malformed);
			expect(findings.some((finding) => finding.symbol === "parse")).toBe(true);
		} finally {
			await rm(malformed, { recursive: true, force: true });
		}
		const missing = await makeGraph({
			"packages/coding-agent/src/commands/worktree.ts": `export { createWorktreeCommand } from "./missing-leaf";`,
		});
		try {
			const findings = await graphFindings(missing);
			expect(findings.some((finding) => finding.symbol.startsWith("unresolved-edge"))).toBe(true);
		} finally {
			await rm(missing, { recursive: true, force: true });
		}
	});
	test("root and config symlink escapes fail closed", async () => {
		const repoRoot = await makeGraph();
		try {
			const outside = await mkdtemp(path.join(path.dirname(repoRoot), "wtr-outside-"));
			await writeFile(path.join(outside, "evil.ts"), "process.env.X = '1';");
			await symlink(path.join(outside, "evil.ts"), path.join(repoRoot, "evil.ts"));
			const findings = await verifyWorktreeReportCapabilities({ repoRoot, roots: ["evil.ts"] });
			expect(findings.some((finding) => finding.path === "evil.ts" && finding.symbol === "unresolved-root")).toBe(true);
			await rm(outside, { recursive: true, force: true });
			await rm(path.join(repoRoot, "tsconfig.json"), { force: true });
			await symlink(path.join(outside, "evil.ts"), path.join(repoRoot, "tsconfig.json"));
			const configFindings = await graphFindings(repoRoot);
			expect(configFindings.some((finding) => finding.symbol.startsWith("tsconfig:"))).toBe(true);
			await rm(path.join(repoRoot, "tsconfig.json"), { force: true });
			await symlink(outside, path.join(repoRoot, "linked-dir"));
			const directoryFindings = await verifyWorktreeReportCapabilities({ repoRoot, roots: ["linked-dir"] });
			expect(directoryFindings.some((finding) => finding.path === "linked-dir")).toBe(true);
		} finally {
			await rm(repoRoot, { recursive: true, force: true });
		}
	});
	test("scanner flow ignores all statically dead call sites", () => {
		const source = `import { lstat, open, readdir } from "node:fs/promises";
export async function scanWorktrees() {
	return;
	lstat("x"); throw new Error(); open("x", 0); readdir("x");
	if (true) {} else { lstat("x"); } false && readdir("x"); true || open("x", 0);
	while (false) { lstat("x"); } for (;false;) { readdir("x"); }
}`;
		const receipts = analyzeSource(source, "packages/coding-agent/src/cli/worktree-scanner.ts")
			.filter((finding) => finding.symbol.startsWith("scanner-flow:"));
		expect(receipts).toHaveLength(6);
	});
	test("tsconfig inherited baseUrl and paths use the effective owner and selected leaf", async () => {
		const command = await readFile(path.join(import.meta.dir, "..", "packages/coding-agent/src/commands/worktree.ts"), "utf8");
		const cases = [
			{
				name: "parent-paths-child-base",
				config: { extends: "./configs/child.json" },
				files: {
					"configs/child.json": JSON.stringify({ extends: "./parent.json", compilerOptions: { baseUrl: ".." } }),
					"configs/parent.json": JSON.stringify({ compilerOptions: { paths: { "@leaf/*": ["../packages/coding-agent/src/commands/*"] } } }),
					"packages/coding-agent/src/commands/command.ts": command,
					"decoy/command.ts": "export const createWorktreeCommand = process;",
					"packages/coding-agent/src/commands/worktree.ts": `export { createWorktreeCommand } from "@leaf/command";`,
				},
			},
			{
				name: "parent-base-child-paths",
				config: { extends: "./configs/child.json" },
				files: {
					"configs/child.json": JSON.stringify({ extends: "./parent.json", compilerOptions: { paths: { "@leaf/*": ["packages/coding-agent/src/commands/*"] } } }),
					"configs/parent.json": JSON.stringify({ compilerOptions: { baseUrl: ".." } }),
					"packages/coding-agent/src/commands/command.ts": command,
					"decoy/command.ts": "export const createWorktreeCommand = process;",
					"packages/coding-agent/src/commands/worktree.ts": `export { createWorktreeCommand } from "@leaf/command";`,
				},
			},
		] as const;
		for (const scenario of cases) {
			const repoRoot = await makeGraph(scenario.files);
			await writeFile(path.join(repoRoot, "tsconfig.json"), JSON.stringify(scenario.config));
			try {
				const findings = await graphFindings(repoRoot);
				expect(findings.filter((finding) => finding.symbol.startsWith("tsconfig:"))).toEqual([]);
				expect(
					findings.filter((finding) => finding.rule === RULES.process || finding.rule === RULES.unknownBinding),
				).toEqual([]);
			} finally {
				await rm(repoRoot, { recursive: true, force: true });
			}
		}
	});
	test("live out-of-repo file, directory, and tsconfig symlinks fail closed", async () => {
		const repoRoot = await makeGraph();
		const outside = await mkdtemp(path.join(path.dirname(repoRoot), "wtr-live-outside-"));
		try {
			await writeFile(path.join(outside, "evil.ts"), "export const commands = [];");
			await mkdir(path.join(outside, "dir"), { recursive: true });
			await writeFile(path.join(outside, "dir", "evil.ts"), "export const commands = [];");
			await symlink(path.join(outside, "evil.ts"), path.join(repoRoot, "evil.ts"));
			await symlink(path.join(outside, "dir"), path.join(repoRoot, "linked-dir"));
			const fileFindings = await verifyWorktreeReportCapabilities({ repoRoot, roots: ["evil.ts"] });
			const dirFindings = await verifyWorktreeReportCapabilities({ repoRoot, roots: ["linked-dir"] });
			expect(fileFindings.some((finding) => finding.path === "evil.ts" && finding.symbol === "unresolved-root")).toBe(true);
			expect(dirFindings.some((finding) => finding.path === "linked-dir" && finding.symbol === "unresolved-root")).toBe(true);
			await rm(path.join(repoRoot, "tsconfig.json"));
			await symlink(path.join(outside, "config.json"), path.join(repoRoot, "tsconfig.json"));
			await writeFile(path.join(outside, "config.json"), JSON.stringify({ extends: "./parent.json" }));
			await writeFile(path.join(outside, "parent.json"), JSON.stringify({ compilerOptions: {} }));
			const configFindings = await graphFindings(repoRoot);
			expect(configFindings.some((finding) => finding.symbol === "tsconfig:tsconfig-out-of-repo")).toBe(true);
		} finally {
			await rm(repoRoot, { recursive: true, force: true });
			await rm(outside, { recursive: true, force: true });
		}
	});
	test("scanner flow excludes terminal branches and non-falling loops but keeps do-while body", () => {
		const required = ["handle.close", "handle.read", "handle.stat", "lstat", "open", "readdir"];
		const cases: Array<[string, string[]]> = [
			["if-true-return", required],
			["both-terminal-if", required],
			["false-loops", ["handle.close", "handle.read", "handle.stat", "lstat", "readdir"]],
			["infinite-loop", ["handle.close", "handle.read", "handle.stat", "lstat", "readdir"]],
			["do-while-false", []],
			["for-infinite", ["handle.close", "handle.read", "handle.stat", "lstat", "readdir"]],
			["infinite-do-while", ["handle.close", "handle.read", "handle.stat", "lstat", "readdir"]],
			["terminal-do-while", required],
			["while-break", ["handle.close", "handle.read", "handle.stat"]],
			["continue-break", ["handle.close", "handle.read", "handle.stat"]],
		];
		const prefix = `import { lstat, open, readdir } from "node:fs/promises";
			export async function scanWorktrees() {`;
		for (const [name, expectedMissing] of cases) {
			const body =
				name === "if-true-return"
					? `if (true) return; lstat("x"); readdir("x"); open("x", 0);`
					: name === "both-terminal-if"
						? `if (x) { return; } else { throw new Error(); } lstat("x"); readdir("x"); open("x", 0);`
						: name === "false-loops"
							? `while (false) lstat("x"); for (;false;) readdir("x"); open("x", 0);`
							: name === "infinite-loop"
								? `while (true) { open("x", 0); } lstat("x"); readdir("x");`
								: name === "for-infinite"
									? `for (;;) { open("x", 0); } lstat("x"); readdir("x");`
									: name === "infinite-do-while"
										? `do { open("x", 0); } while (true); lstat("x"); readdir("x");`
										: name === "terminal-do-while"
											? `do { return; } while (true); lstat("x"); readdir("x"); open("x", 0);`
											: name === "while-break"
												? `while (true) { open("x", 0); break; } lstat("x"); readdir("x");`
												: name === "continue-break"
													? `while (true) { if (x) continue; open("x", 0); break; } lstat("x"); readdir("x");`
													: `do { await lstat("x"); await readdir("x"); const h = await open("x", 0); await h.stat(); await h.read(); await h.close(); } while (false);`;
			const receipts = analyzeSource(`${prefix}${body}}`, "packages/coding-agent/src/cli/worktree-scanner.ts")
				.filter((finding) => finding.rule === RULES.scannerApi && finding.symbol.startsWith("scanner-flow:"))
				.map((finding) => finding.symbol.replace("scanner-flow:", ""));
			expect(receipts).toEqual(expectedMissing);
		}
	});
	test("scanner flow preserves mandatory and optional loop completion", () => {
		const required = ["handle.close", "handle.read", "handle.stat", "lstat", "open", "readdir"];
		const nestedInfinite = `import { lstat, open, readdir } from "node:fs/promises";
			export async function scanWorktrees() {
				do { for (;;) {} } while (false);
				lstat("x"); readdir("x"); open("x", 0);
			}`;
		const nestedReceipts = analyzeSource(nestedInfinite, "packages/coding-agent/src/cli/worktree-scanner.ts")
			.filter((finding) => finding.rule === RULES.scannerApi && finding.symbol.startsWith("scanner-flow:"))
			.map((finding) => finding.symbol.replace("scanner-flow:", ""));
		expect(nestedReceipts).toEqual(required);

		const optionalEntry = `import { lstat, open, readdir } from "node:fs/promises";
			export async function scanWorktrees() {
				while (condition) { return; }
				lstat("x"); readdir("x"); open("x", 0);
			}`;
		const optionalReceipts = analyzeSource(optionalEntry, "packages/coding-agent/src/cli/worktree-scanner.ts")
			.filter((finding) => finding.rule === RULES.scannerApi && finding.symbol.startsWith("scanner-flow:"))
			.map((finding) => finding.symbol.replace("scanner-flow:", ""));
		expect(optionalReceipts).toEqual(["handle.close", "handle.read", "handle.stat"]);
	});
	test("scanner flow keeps labeled breaks attached to their target loop", () => {
		const source = `import { lstat, open, readdir } from "node:fs/promises";
			export async function scanWorktrees() {
				outer: while (true) {
					while (true) { break outer; }
					lstat("x"); readdir("x"); open("x", 0);
				}
			}`;
		const receipts = analyzeSource(source, "packages/coding-agent/src/cli/worktree-scanner.ts")
			.filter((finding) => finding.rule === RULES.scannerApi && finding.symbol.startsWith("scanner-flow:"))
			.map((finding) => finding.symbol.replace("scanner-flow:", ""));
		expect(receipts).toEqual(["handle.close", "handle.read", "handle.stat", "lstat", "open", "readdir"]);
	});
	test("handle reference facts exclude safe static and erased contexts, while shorthand/computed values extract", () => {
		const safe = `import { open } from "node:fs/promises"; import { constants } from "node:fs";
			export async function scan() {
				const handle = await open("x", constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
				const other = { handle: 1 }; other.handle;
				class C { static handle = 1; handle() {} }
				type T = typeof handle;
				await handle.close(); await handle.stat(); await handle.read(Buffer.alloc(1));
			}`;
		const safeFindings = analyzeSource(safe, "packages/coding-agent/src/cli/worktree-scanner.ts");
		expect(safeFindings.filter((finding) => finding.symbol === "FileHandle.extraction")).toHaveLength(0);
		const hostile = `import { open } from "node:fs/promises"; import { constants } from "node:fs";
			export async function scan() {
				const handle = await open("x", constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
				const shorthand = { handle }; const computed = { [handle]: 1 }; void shorthand; void computed;
				await handle.close(); await handle.stat(); await handle.read(Buffer.alloc(1));
			}`;
		const hostileFindings = analyzeSource(hostile, "packages/coding-agent/src/cli/worktree-scanner.ts");
		expect(hostileFindings.filter((finding) => finding.symbol === "FileHandle.extraction")).toHaveLength(2);
	});
	test("rejects reachable runtime node reexports", async () => {
		const command = await readFile(path.join(import.meta.dir, "..", "packages/coding-agent/src/commands/worktree.ts"), "utf8");
		const repoRoot = await makeGraph({
			"packages/coding-agent/src/commands/worktree.ts": `export { createWorktreeCommand } from "./bridge";`,
			"packages/coding-agent/src/commands/bridge.ts": `export { createWorktreeCommand } from "./leaf"; export { readFile } from "node:fs"; export * from "node:fs";`,
			"packages/coding-agent/src/commands/leaf.ts": command,
		});
		try {
			const findings = await graphFindings(repoRoot);
			const unsafe = findings.filter(
				(finding) => finding.path === "packages/coding-agent/src/commands/bridge.ts" && finding.symbol === "unsafe-bridge",
			);
			expect(unsafe).toHaveLength(2);
			expect(unsafe.map((finding) => `${finding.line}:${finding.column}`)).toEqual(["1:49", "1:85"]);
		} finally {
			await rm(repoRoot, { recursive: true, force: true });
		}
	});

	test("rejects unsupported terminal scanner control flow", () => {
		const scanner = analyzeSource(
			`import { lstat, open, readdir } from "node:fs/promises";
			export async function scanWorktrees() {
				switch (true) { case true: return; default: lstat("x"); readdir("x"); open("x", 0); }
			}`,
			"packages/coding-agent/src/cli/worktree-scanner.ts",
		);
		expect(scanner.some((finding) => finding.symbol === "scanner-flow:unsupported-control-flow")).toBe(true);
	});
	test("accepts the production worker conditional catch receipts", async () => {
		const source = await readFile(path.join(import.meta.dir, "..", "packages/coding-agent/src/cli/worktree-cli.ts"), "utf8");
		expect(
			analyzeSource(source, "packages/coding-agent/src/cli/worktree-cli.ts").some(
				(finding) => finding.rule === RULES.scannerApi && finding.symbol === "worker-scan-contract",
			),
		).toBe(false);
	});
	test("rejects guarded forged worker receipts", () => {
		const source = `import { scanWorktrees } from "./worktree-scanner";
			export async function runWorktreeCommand(options: { root: string; platform: "posix" | "win32"; json: boolean }) {
				const diagnostics = await scanWorktrees({ root: options.root, platform: options.platform });
				return options.json
					? { stdout: "forged", stderr: "", exitCode: 0 }
					: { stdout: \`${"${diagnostics.length}"}\`, stderr: "", exitCode: 0 };
			}`;
		expect(
			analyzeSource(source, "packages/coding-agent/src/cli/worktree-cli.ts").some(
				(finding) => finding.rule === RULES.scannerApi && finding.symbol === "worker-scan-contract",
			),
		).toBe(true);
	});
	test("rejects forged worker receipts without authoritative returned dataflow", () => {
		const source = `import { scanWorktrees } from "./worktree-scanner";
			export async function runWorktreeCommand(options: { root: string; platform: "posix" | "win32" }) {
				const diagnostics = await scanWorktrees({ root: options.root, platform: options.platform });
				const decoy = \`${"${diagnostics.length}"}\`;
				return { stdout: "forged", stderr: "", exitCode: 0 };
			}`;
		expect(
			analyzeSource(source, "packages/coding-agent/src/cli/worktree-cli.ts").some(
				(finding) => finding.rule === RULES.scannerApi && finding.symbol === "worker-scan-contract",
			),
		).toBe(true);
	});
	test("models terminal scanner try forms without accepting dead calls", () => {
		const cases = [
			`try { return; } catch {} lstat("x"); readdir("x"); open("x", 0);`,
			`try {} finally { return; } lstat("x"); readdir("x"); open("x", 0);`,
		];
		for (const body of cases) {
			const findings = analyzeSource(
				`import { lstat, open, readdir } from "node:fs/promises"; export async function scanWorktrees() { ${body} }`,
				"packages/coding-agent/src/cli/worktree-scanner.ts",
			);
			expect(
				findings
					.filter((finding) => finding.rule === RULES.scannerApi && finding.symbol.startsWith("scanner-flow:"))
					.map((finding) => finding.symbol.replace("scanner-flow:", "")),
			).toEqual(["handle.close", "handle.read", "handle.stat", "lstat", "open", "readdir"]);
		}
	});
	test("rejects node reexports even through a catch-all alias graph", async () => {
		const command = await readFile(path.join(import.meta.dir, "..", "packages/coding-agent/src/commands/worktree.ts"), "utf8");
		const repoRoot = await makeGraph(
			{
				"packages/coding-agent/src/commands/worktree.ts": `export { createWorktreeCommand } from "./barrel";`,
				"packages/coding-agent/src/commands/barrel.ts": `export { createWorktreeCommand } from "./leaf"; export { fs } from "@fixture/*"; export * from "@fixture/*";`,
				"packages/coding-agent/src/commands/leaf.ts": command,
			},
			{ "@fixture/*": ["node:*"] },
		);
		try {
			const findings = await graphFindings(repoRoot);
			expect(findings.filter((finding) => finding.symbol === "unsafe-bridge").length).toBeGreaterThanOrEqual(2);
		} finally {
			await rm(repoRoot, { recursive: true, force: true });
		}
	});
	test("rejects mutations and shadows of authoritative worker receipts", async () => {
		const worker = await readFile(path.join(import.meta.dir, "..", "packages/coding-agent/src/cli/worktree-cli.ts"), "utf8");
		const mutants = [
			worker.replace(
				'if (options.action === "list") {',
				'if (options.action === "list") { const JSON = { stringify: () => "forged" };',
			),
			worker.replace(
				'if (options.action === "list") {',
				'if (options.action === "list") { const formatDiagnostic = () => "forged";',
			),
			worker.replace(
				'if (options.action === "list") {',
				'if (options.action === "list") { const diagnostics = [];',
			),
			worker.replace(
				'if (!(error instanceof WorktreeRootError)) throw error;',
				'if (!(error instanceof WorktreeRootError)) throw error; const SCAN_ERROR_TEXT = "forged";',
			),
			worker.replace(
				'const SCAN_ERROR_TEXT = "managed worktree root cannot be read";',
				'const SCAN_ERROR_TEXT = "forged";',
			),
			worker.replace(
				'return `diagnostic  ${diagnostic.path}  ${diagnostic.message}`;',
				'return `forged  ${diagnostic.path}  ${diagnostic.message}`;',
			),
			worker.replace(
				'if (!(error instanceof WorktreeRootError)) throw error;',
				'if (false) throw error;',
			),
			worker.replace(
				'{ stdout: "No agent-managed worktrees found.\\n", stderr: "", exitCode: 0 }',
				'{ stdout: "", stderr: "No agent-managed worktrees found.\\n", exitCode: 0 }',
			),
			worker.replace(
				'{ stdout: "No agent-managed worktrees found.\\n", stderr: "", exitCode: 0 }',
				'{ stdout: "No agent-managed worktrees found.\\n", stderr: "", exitCode: 1 }',
			),
			worker.replace(
				"function formatDiagnostic(diagnostic: WorktreeDiagnostic): string {",
				"async function formatDiagnostic(diagnostic: WorktreeDiagnostic): Promise<string> {",
			),
			worker.replace(
				"function formatDiagnostic(diagnostic: WorktreeDiagnostic): string {",
				"function* formatDiagnostic(diagnostic: WorktreeDiagnostic): Generator<string> {",
			),
			worker.replace(
				'\t}\n\tif (options.action === "list") {',
				'\t} finally { return { stdout: "No agent-managed worktrees found.\\n", stderr: "", exitCode: 0 }; }\n\tif (options.action === "list") {',
			),
			worker.replace('options.action === "list"', 'options.action === "clear"'),
			worker.replace(
				"options.dryRun || diagnostics.length === 0",
				"options.json || diagnostics.length === 0",
			),
			worker.replace("if (options.json) return", "if (options.dryRun) return"),
			worker.replace("diagnostics = await scanWorktrees", "diagnostics = scanWorktrees"),
		];
		for (const source of mutants) {
			expect(
				analyzeSource(source, "packages/coding-agent/src/cli/worktree-cli.ts").some(
					finding => finding.rule === RULES.scannerApi && finding.symbol === "worker-scan-contract",
				),
			).toBe(true);
		}
	});
});
