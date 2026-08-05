#!/usr/bin/env bun

import * as fsSync from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

type ScenarioName = "help" | "version" | "idle";
type CatalogKind = "tools" | "skills" | "providers";

const EXPECTED_TOOL_LOADER_SPECIFIERS = new Set([
	"./read",
	"./bash",
	"../edit",
	"./ast-grep",
	"./ast-edit",
	"./render-mermaid",
	"./ask",
	"./debug",
	"./bisect",
	"./eval",
	"./calculator",
	"./ssh",
	"./gh",
	"./find",
	"./search",
	"../lsp",
	"./browser",
	"./computer",
	"./checkpoint",
	"../task",
	"./subagent",
	"./job",
	"./monitor",
	"./cron",
	"./recipe",
	"./irc",
	"./todo-write",
	"../web/search",
	"./search-tool-bm25",
	"./skill-discovery",
	"./telegram-send",
	"./write",
	"./skill",
	"../goals/tools/goal-tool",
	"./yield",
	"./review",
	"./resolve",
]);
const TRACE_MILESTONE_DENY_RULES: Record<string, string[]> = {
	W1c: ["src/sdk/bus/adapters/**", "src/memories/**", "src/hindsight/**", "src/stt/**", "src/secrets/**"],
	W5b: ["@gajae-code/natives", "bun:sqlite", "packages/ai/src/providers/**"],
};

const TRACE_ROOT_SENTINEL = "__GJC_TRACE_ROOT__";

interface TraceRecord {
	specifier: string;
	raw?: string;
	resolved: string;
	importer?: string;
	kind?: string;
}

interface CliOptions {
	scenarios: ScenarioName[];
	deny: string[];
	milestone?: string;
	assertNoNativeFrom: string[];
	literalCatalogs: CatalogKind[];
	json: boolean;
}

interface ScenarioTraceReport {
	scenario: ScenarioName;
	barrier?: string;
	argv: string[];
	exitCode: number;
	stdout: string;
	stderr: string;
	records: TraceRecord[];
	offendingModules: Array<{ pattern: string; specifier: string; resolved: string; importer?: string }>;
	nativeImportViolations: Array<{
		pattern: string;
		from: string;
		nativeSpecifier: string;
		nativeResolved: string;
		importer?: string;
	}>;
}

interface CatalogReport {
	kind: CatalogKind;
	files: string[];
	violations: Array<{ file: string; line: number; column: number; expression: string }>;
}

class VerifyModuleTraceError extends Error {
	readonly code: string;
	readonly details?: unknown;

	constructor(code: string, message: string, details?: unknown) {
		super(message);
		this.name = code;
		this.code = code;
		this.details = details;
	}
}

const repoRoot = path.resolve(import.meta.dir, "..");
const packageRoot = path.join(repoRoot, "packages", "coding-agent");
const traceLoader = path.join(repoRoot, "scripts", "trace-loader.ts");
const cliEntry = path.join(packageRoot, "src", "cli.ts");
const scenarioArgv: Record<ScenarioName, string[]> = {
	help: ["--help"],
	version: ["--version"],
	idle: ["--no-session", "--no-tools"],
};
const supportedScenarios = new Set<ScenarioName>(["help", "version", "idle"]);

function usage(): string {
	return [
		"Usage: bun scripts/verify-module-trace.ts [options]",
		"",
		"  --scenario <help|version|idle>[,<scenario>...]",
		"  --milestone <W1c|W5b>                  add the milestone-scoped deny list",
		"  --deny <glob[,glob...]>                 (repeatable)",
		"  --assert-no-native-import-from <glob>   (repeatable)",
		"  --assert-literal-catalog <tools|skills|providers>",
		"  --json",
	].join("\n");
}

function splitList(value: string): string[] {
	return value
		.split(",")
		.map(part => part.trim())
		.filter(Boolean);
}

function parseScenario(value: string): ScenarioName {
	if (!Object.prototype.hasOwnProperty.call(scenarioArgv, value)) {
		throw new VerifyModuleTraceError("InvalidScenario", `Unknown module-trace scenario: ${value}`);
	}
	return value as ScenarioName;
}

function parseCatalogKind(value: string): CatalogKind {
	if (value !== "tools" && value !== "skills" && value !== "providers") {
		throw new VerifyModuleTraceError("InvalidCatalogKind", `Unknown literal catalog kind: ${value}`);
	}
	return value;
}

function parseArgs(argv: string[]): CliOptions {
	const options: CliOptions = {
		scenarios: [],
		deny: [],
		assertNoNativeFrom: [],
		literalCatalogs: [],
		json: false,
	};

	for (let index = 0; index < argv.length; index += 1) {
		const arg = argv[index];
		if (arg === "--json") {
			options.json = true;
			continue;
		}
		if (arg === "--scenario") {
			const value = argv[++index];
			if (!value) throw new VerifyModuleTraceError("UsageError", "--scenario requires a value");
			options.scenarios.push(...splitList(value).map(parseScenario));
			continue;
		}
		if (arg.startsWith("--scenario=")) {
			options.scenarios.push(...splitList(arg.slice("--scenario=".length)).map(parseScenario));
			continue;
		}
		if (arg === "--milestone") {
			const value = argv[++index];
			if (!value) throw new VerifyModuleTraceError("UsageError", "--milestone requires a value");
			if (!TRACE_MILESTONE_DENY_RULES[value]) throw new VerifyModuleTraceError("InvalidMilestone", `Unknown trace milestone: ${value}`);
			options.milestone = value;
			continue;
		}
		if (arg.startsWith("--milestone=")) {
			const value = arg.slice("--milestone=".length);
			if (!TRACE_MILESTONE_DENY_RULES[value]) throw new VerifyModuleTraceError("InvalidMilestone", `Unknown trace milestone: ${value}`);
			options.milestone = value;
			continue;
		}
		if (arg === "--deny") {
			const value = argv[++index];
			if (!value) throw new VerifyModuleTraceError("UsageError", "--deny requires a glob");
			options.deny.push(...splitList(value));
			continue;
		}
		if (arg.startsWith("--deny=")) {
			options.deny.push(...splitList(arg.slice("--deny=".length)));
			continue;
		}
		if (arg === "--assert-no-native-import-from") {
			const value = argv[++index];
			if (!value) throw new VerifyModuleTraceError("UsageError", "--assert-no-native-import-from requires a glob");
			options.assertNoNativeFrom.push(value);
			continue;
		}
		if (arg.startsWith("--assert-no-native-import-from=")) {
			options.assertNoNativeFrom.push(arg.slice("--assert-no-native-import-from=".length));
			continue;
		}
		if (arg === "--assert-literal-catalog") {
			const value = argv[++index];
			if (!value) throw new VerifyModuleTraceError("UsageError", "--assert-literal-catalog requires a kind");
			options.literalCatalogs.push(parseCatalogKind(value));
			continue;
		}
		if (arg.startsWith("--assert-literal-catalog=")) {
			options.literalCatalogs.push(parseCatalogKind(arg.slice("--assert-literal-catalog=".length)));
			continue;
		}
		if (arg === "--help" || arg === "-h") {
			process.stdout.write(`${usage()}\n`);
			process.exit(0);
		}
		throw new VerifyModuleTraceError("UsageError", `Unknown option: ${arg}`);
	}

	if (options.scenarios.length === 0 && options.literalCatalogs.length === 0) {
		throw new VerifyModuleTraceError("UsageError", "At least one --scenario or --assert-literal-catalog is required");
	}
	return options;
}

function isolatedEnvironment(tempRoot: string, scenario: ScenarioName): Record<string, string> {
	const env: Record<string, string> = {};
	for (const [key, value] of Object.entries(Bun.env)) {
		if (!key.startsWith("GJC_") && value !== undefined) env[key] = value;
	}
	const home = path.join(tempRoot, "home");
	const xdgConfig = path.join(tempRoot, "xdg-config");
	const agentDir = path.join(tempRoot, "agent");
	return {
		...env,
		HOME: home,
		USERPROFILE: home,
		XDG_CONFIG_HOME: xdgConfig,
		GJC_CODING_AGENT_DIR: agentDir,
		GJC_AGENT_DIR: agentDir,
		GJC_TRACE_SCENARIO: scenario,
		GJC_TRACE_HARNESS: "1",
	};
}

function globRegex(pattern: string): RegExp {
	let source = "^";
	for (let index = 0; index < pattern.length; index += 1) {
		const char = pattern[index] ?? "";
		if (char === "*") {
			if (pattern[index + 1] === "*") {
				index += 1;
				if (pattern[index + 1] === "/") {
					index += 1;
					source += "(?:.*/)?";
				} else {
					source += ".*";
				}
			} else {
				source += "[^/]*";
			}
			continue;
		}
		if (char === "?") {
			source += "[^/]";
			continue;
		}
		source += /[\\^$+?.()|{}[\]]/.test(char) ? `\\${char}` : char;
	}
	return new RegExp(`${source}$`);
}

function pathVariants(value: string): string[] {
	const normalized = value.replaceAll("\\", "/");
	const variants = new Set<string>([normalized]);
	let filesystemPath = normalized;
	if (normalized.startsWith("file://")) {
		try {
			filesystemPath = fileURLToPath(normalized).replaceAll("\\", "/");
			variants.add(filesystemPath);
		} catch {
			// Keep the URL form below.
		}
	}
	if (path.isAbsolute(filesystemPath)) {
		const relativeRoot = path.relative(repoRoot, filesystemPath).replaceAll("\\", "/");
		const relativePackage = path.relative(packageRoot, filesystemPath).replaceAll("\\", "/");
		if (relativeRoot && !relativeRoot.startsWith("../")) variants.add(relativeRoot);
		if (relativePackage && !relativePackage.startsWith("../")) variants.add(relativePackage);
	}
	for (const variant of [...variants]) {
		const withoutDot = variant.replace(/^\.\//, "");
		variants.add(withoutDot);
		const segments = withoutDot.split("/");
		for (let index = 1; index < segments.length; index += 1) variants.add(segments.slice(index).join("/"));
	}
	return [...variants];
}

const packageDirCache = new Map<string, string[]>();

/**
 * Directories that own a given package name (workspace package or node_modules copy).
 *
 * A trace record for `@gajae-code/natives` is usually a relative or absolute path inside
 * `packages/natives`, never the bare package name, so a literal glob can never match it.
 * Resolving the package to its directories lets a package-scoped deny rule fire on any
 * module physically inside that package.
 */
function packageDirectories(name: string): string[] {
	const cached = packageDirCache.get(name);
	if (cached) return cached;
	const dirs = new Set<string>();
	const nodeModules = path.join(repoRoot, "node_modules", name);
	if (fsSync.existsSync(nodeModules)) dirs.add(fsSync.realpathSync(nodeModules).replaceAll("\\", "/"));
	const packagesRoot = path.join(repoRoot, "packages");
	if (fsSync.existsSync(packagesRoot)) {
		for (const entry of fsSync.readdirSync(packagesRoot, { withFileTypes: true })) {
			if (!entry.isDirectory()) continue;
			const manifest = path.join(packagesRoot, entry.name, "package.json");
			if (!fsSync.existsSync(manifest)) continue;
			try {
				const parsed = JSON.parse(fsSync.readFileSync(manifest, "utf8")) as { name?: string };
				if (parsed.name === name) dirs.add(fsSync.realpathSync(path.dirname(manifest)).replaceAll("\\", "/"));
			} catch {
				// A malformed manifest simply does not contribute a directory.
			}
		}
	}
	const result = [...dirs];
	packageDirCache.set(name, result);
	return result;
}

function looksLikePackageName(pattern: string): boolean {
	if (/[*?[\]]/.test(pattern)) return false;
	if (pattern.startsWith(".") || pattern.startsWith("/")) return false;
	if (pattern.startsWith("bun:") || pattern.startsWith("node:")) return false;
	return /^@[^/]+\/[^/]+$/.test(pattern) || /^[a-z0-9][\w.-]*$/i.test(pattern);
}

function withinPackage(value: string, pattern: string): boolean {
	if (!looksLikePackageName(pattern)) return false;
	const dirs = packageDirectories(pattern);
	if (dirs.length === 0) return false;
	let candidate = value.replaceAll("\\", "/");
	if (candidate.startsWith("file://")) {
		try {
			candidate = fileURLToPath(candidate).replaceAll("\\", "/");
		} catch {
			return false;
		}
	}
	if (!path.isAbsolute(candidate)) return false;
	try {
		if (fsSync.existsSync(candidate)) candidate = fsSync.realpathSync(candidate).replaceAll("\\", "/");
	} catch {
		// Fall through with the unresolved path.
	}
	return dirs.some(dir => candidate === dir || candidate.startsWith(`${dir}/`));
}

function matchesGlob(value: string, pattern: string): boolean {
	const regex = globRegex(pattern.replaceAll("\\", "/"));
	return pathVariants(value).some(variant => regex.test(variant));
}

function entryMatches(entry: TraceRecord, pattern: string): boolean {
	return (
		matchesGlob(entry.specifier, pattern) ||
		matchesGlob(entry.resolved, pattern) ||
		withinPackage(entry.resolved, pattern)
	);
}

function isNativeImport(entry: TraceRecord): boolean {
	const values = [entry.specifier, entry.resolved].map(value => value.replaceAll("\\", "/").toLowerCase());
	return values.some(
		value =>
			value === "bun:sqlite" ||
			value.startsWith("@gajae-code/natives") ||
			value.includes("/node_modules/@gajae-code/natives") ||
			value.includes("/node_modules/@gajae-code/natives-") ||
			value.endsWith(".node") ||
			value.includes("/native/") ||
			value.includes("\\native\\"),
	);
}

function equivalentModule(left: string, right: string): boolean {
	const rightVariants = new Set(pathVariants(right));
	return pathVariants(left).some(value => rightVariants.has(value));
}

function nativeImportViolations(records: TraceRecord[], pattern: string): ScenarioTraceReport["nativeImportViolations"] {
	const starts = new Set<string>();
	for (const record of records) {
		if (matchesGlob(record.resolved, pattern) || matchesGlob(record.specifier, pattern)) {
			starts.add(record.resolved);
			starts.add(record.specifier);
		}
	}
	if (starts.size === 0) return [];

	const queue = [...starts];
	const visited = new Set<string>();
	const violations: ScenarioTraceReport["nativeImportViolations"] = [];
	while (queue.length > 0) {
		const current = queue.shift()!;
		const currentKey = pathVariants(current).sort().join("\u0000");
		if (visited.has(currentKey)) continue;
		visited.add(currentKey);
		for (const record of records) {
			if (!record.importer || !equivalentModule(record.importer, current)) continue;
			if (isNativeImport(record)) {
				violations.push({
					pattern,
					from: current,
					nativeSpecifier: record.specifier,
					nativeResolved: record.resolved,
					...(record.importer ? { importer: record.importer } : {}),
				});
				continue;
			}
			queue.push(record.resolved);
		}
	}
	return violations;
}

async function readTrace(tracePath: string, entryPath: string): Promise<TraceRecord[]> {
	let text: string;
	try {
		text = await fs.readFile(tracePath, "utf8");
	} catch (error) {
		throw new VerifyModuleTraceError("TraceCaptureMissing", `Trace capture is missing or unreadable: ${tracePath}`, { cause: String(error) });
	}
	if (text.trim().length === 0) {
		throw new VerifyModuleTraceError("TraceCaptureEmpty", `Trace capture is empty: ${tracePath}`);
	}

	let raw: unknown;
	try {
		raw = JSON.parse(text) as unknown;
	} catch (error) {
		throw new VerifyModuleTraceError("TraceCaptureMalformed", `Trace capture is not valid JSON: ${tracePath}`, { cause: String(error) });
	}
	const values = Array.isArray(raw) ? raw : raw && typeof raw === "object" && "records" in raw ? raw.records : undefined;
	if (!Array.isArray(values)) {
		throw new VerifyModuleTraceError("TraceCaptureMalformed", `Trace capture has no records array: ${tracePath}`);
	}
	const records: TraceRecord[] = [];
	for (const value of values) {
		if (!value || typeof value !== "object") {
			throw new VerifyModuleTraceError("TraceCaptureMalformed", `Trace capture contains a non-record entry: ${tracePath}`);
		}
		const item = value as Record<string, unknown>;
		const specifier = typeof item.specifier === "string" ? item.specifier : typeof item.raw === "string" ? item.raw : undefined;
		if (!specifier || typeof item.resolved !== "string") {
			throw new VerifyModuleTraceError("TraceCaptureMalformed", `Trace capture contains a malformed record: ${tracePath}`);
		}
		records.push({
			specifier,
			raw: typeof item.raw === "string" ? item.raw : undefined,
			resolved: item.resolved,
			...(typeof item.importer === "string" ? { importer: item.importer } : {}),
			...(typeof item.kind === "string" ? { kind: item.kind } : {}),
		});
	}
	if (records.length === 0) {
		throw new VerifyModuleTraceError("TraceCaptureEmpty", `Trace capture contains no records: ${tracePath}`);
	}

	const hasRootSentinel = records.some(record =>
		record.kind === "root" && record.specifier === TRACE_ROOT_SENTINEL && equivalentModule(record.resolved, entryPath),
	);
	if (!hasRootSentinel) {
		throw new VerifyModuleTraceError("TraceCaptureRootMissing", `Trace capture does not contain the entry-module root sentinel: ${entryPath}`, {
			tracePath,
			recordCount: records.length,
			sentinel: TRACE_ROOT_SENTINEL,
		});
	}
	return records;
}

async function runIdleScenario(tempRoot: string, env: Record<string, string>): Promise<{ stdout: string; stderr: string; exitCode: number; barrier: string }> {
	const debugPaths = [
		path.join(env.GJC_AGENT_DIR ?? "", "gjc-debug.log"),
		path.join(env.GJC_AGENT_DIR ?? "", "state", "gjc-debug.log"),
	];
	const driverPath = path.join(tempRoot, "idle-driver.py");
	const pythonSource = `
import os, pty, select, subprocess, sys, time
trace_loader = ${JSON.stringify(traceLoader)}
cli_entry = ${JSON.stringify(cliEntry)}
repo_root = ${JSON.stringify(repoRoot)}
debug_paths = ${JSON.stringify(debugPaths)}
command = [os.environ.get("BUN", "bun"), "--no-env-file", "--preload", trace_loader, cli_entry, "--no-session", "--no-tools"]
env = os.environ.copy()
master, slave = pty.openpty()
child = subprocess.Popen(command, cwd=repo_root, env=env, stdin=slave, stdout=slave, stderr=slave, close_fds=True)
os.close(slave)
barrier = False
deadline = time.time() + 30.0
try:
    while time.time() < deadline:
        try:
            readable, _, _ = select.select([master], [], [], 0.01)
            if readable:
                data = os.read(master, 65536)
                if data:
                    sys.stdout.buffer.write(data)
                    sys.stdout.buffer.flush()
        except (OSError, EOFError):
            pass
        for debug_path in debug_paths:
            try:
                if "fullRender: first render" in open(debug_path, encoding="utf-8").read():
                    barrier = True
                    break
            except OSError:
                pass
        if barrier:
            break
    if barrier:
        sys.stderr.write("interactive:first-render-complete\\n")
        sys.stderr.flush()
        try:
            os.write(master, b"\\x03")
        except OSError:
            pass
        try:
            child.wait(timeout=3.0)
        except subprocess.TimeoutExpired:
            child.terminate()
            try:
                child.wait(timeout=3.0)
            except subprocess.TimeoutExpired:
                child.kill()
                child.wait(timeout=3.0)
    else:
        sys.stderr.write("ScenarioBarrierTimeout: interactive:first-render-complete\\n")
        sys.stderr.flush()
        child.terminate()
        child.wait(timeout=3.0)
finally:
    try:
        os.close(master)
    except OSError:
        pass
sys.exit(0 if barrier else 1)
`;
	await fs.writeFile(driverPath, pythonSource, "utf8");
	const proc = Bun.spawn(["python3", driverPath], { cwd: repoRoot, env, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	if (!stderr.includes("interactive:first-render-complete")) {
		throw new VerifyModuleTraceError("ScenarioBarrierMissing", "Idle scenario exited without interactive:first-render-complete", {
			exitCode,
			stdout,
			stderr,
		});
	}
	if (exitCode !== 0) {
		throw new VerifyModuleTraceError("ScenarioProcessFailed", `Idle scenario driver exited with code ${exitCode}`, {
			stdout,
			stderr,
		});
	}
	return { stdout, stderr, exitCode, barrier: "interactive:first-render-complete" };
}
async function runScenario(tempRoot: string, scenario: ScenarioName): Promise<ScenarioTraceReport> {
	if (!supportedScenarios.has(scenario)) {
		throw new VerifyModuleTraceError(
			"ScenarioNotImplemented",
			`Scenario "${scenario}" cannot yet reach its non-interactive barrier`,
		);
	}
	const requestedTracePath = process.env.GJC_TRACE_OUT?.trim();
	const tracePath = requestedTracePath || path.join(tempRoot, `${scenario}.trace.json`);
	const env = isolatedEnvironment(tempRoot, scenario);
	env.GJC_TRACE_OUT = tracePath;
	if (scenario === "idle") {
		env.GJC_DEBUG_REDRAW = "1";
		const result = await runIdleScenario(tempRoot, env);
		const records = await readTrace(tracePath, cliEntry);
		return {
			scenario,
			barrier: result.barrier,
			argv: scenarioArgv[scenario],
			exitCode: result.exitCode,
			stdout: result.stdout,
			stderr: result.stderr,
			records,
			offendingModules: [],
			nativeImportViolations: [],
		};
	}
	const proc = Bun.spawn([process.execPath, "--no-env-file", "--preload", traceLoader, cliEntry, ...scenarioArgv[scenario]], {
		cwd: repoRoot,
		env,
		stdout: "pipe",
		stderr: "pipe",
	});
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	let records: TraceRecord[];
	try {
		records = await readTrace(tracePath, cliEntry);
	} catch (error) {
		if (stderr.includes("TraceWriteError")) {
			throw new VerifyModuleTraceError("TraceWriteError", `Trace loader failed to write its capture: ${tracePath}`, {
				scenario,
				exitCode,
				stderr,
			});
		}
		throw error;
	}
	if (exitCode !== 0) {
		if (stderr.includes("TraceWriteError")) {
			throw new VerifyModuleTraceError("TraceWriteError", `Trace loader failed to write its capture: ${tracePath}`, {
				scenario,
				exitCode,
				stderr,
			});
		}
		throw new VerifyModuleTraceError(
			"ScenarioProcessFailed",
			`Scenario ${scenario} exited with code ${exitCode}`,
			{ scenario, exitCode, stdout, stderr, records },
		);
	}
	return {
		scenario,
		argv: scenarioArgv[scenario],
		exitCode,
		stdout,
		stderr,
		barrier: "process-exit",
		records,
		offendingModules: [],
		nativeImportViolations: [],
	};
}

async function collectSourceFiles(dir: string): Promise<string[]> {
	let entries: import("node:fs").Dirent[];
	try {
		entries = await fs.readdir(dir, { withFileTypes: true });
	} catch (error) {
		throw new VerifyModuleTraceError("CatalogSourceReadError", `Unable to read source subtree ${dir}`, { cause: String(error) });
	}
	const files: string[] = [];
	for (const entry of entries) {
		if (entry.name === "node_modules" || entry.name === ".git") continue;
		if (entry.name === "test" || entry.name === "tests" || entry.name === "fixtures" || entry.name === "bench") continue;
		const fullPath = path.join(dir, entry.name);
		if (entry.isDirectory()) files.push(...(await collectSourceFiles(fullPath)));
		else if (entry.isFile() && /\.(?:ts|tsx|js|jsx|mjs|cjs)$/.test(entry.name)) files.push(fullPath);
	}
	return files;
}

function isCatalogCandidate(filePath: string, kind: CatalogKind): boolean {
	const relative = path.relative(packageRoot, filePath).replaceAll("\\", "/").toLowerCase();
	const basename = path.basename(filePath).toLowerCase();
	if (!relative.includes(kind)) return false;
	return (
		basename.includes("catalog") ||
		basename.includes("generated") ||
		relative.includes("/generated/") ||
		relative.includes("/catalog/")
	);
}

function lineColumn(source: string, offset: number): { line: number; column: number } {
	const before = source.slice(0, offset);
	const line = before.split("\n").length;
	const lastNewline = before.lastIndexOf("\n");
	return { line, column: offset - lastNewline };
}

function skipQuoted(source: string, start: number, quote: string): number {
	for (let index = start + 1; index < source.length; index += 1) {
		if (source[index] === "\\") {
			index += 1;
			continue;
		}
		if (source[index] === quote) return index + 1;
	}
	return source.length;
}

function dynamicImportViolations(source: string): Array<{ offset: number; expression: string }> {
	const violations: Array<{ offset: number; expression: string }> = [];
	for (let index = 0; index < source.length; index += 1) {
		const char = source[index] ?? "";
		if (char === "/" && source[index + 1] === "/") {
			const end = source.indexOf("\n", index + 2);
			index = end < 0 ? source.length : end;
			continue;
		}
		if (char === "/" && source[index + 1] === "*") {
			const end = source.indexOf("*/", index + 2);
			index = end < 0 ? source.length : end + 1;
			continue;
		}
		if (char === "\"" || char === "'") {
			index = skipQuoted(source, index, char) - 1;
			continue;
		}
		if (!source.startsWith("import", index) || /[A-Za-z0-9_$]/.test(source[index - 1] ?? "")) continue;
		let cursor = index + "import".length;
		while (/\s/.test(source[cursor] ?? "")) cursor += 1;
		if (source[cursor] !== "(") continue;
		const expressionStart = cursor;
		cursor += 1;
		let depth = 1;
		let quote: string | undefined;
		for (; cursor < source.length && depth > 0; cursor += 1) {
			const current = source[cursor] ?? "";
			if (quote) {
				if (current === "\\") cursor += 1;
				else if (current === quote) quote = undefined;
				continue;
			}
			if (current === "\"" || current === "'" || current === "`") {
				quote = current;
				continue;
			}
			if (current === "(") depth += 1;
			else if (current === ")") depth -= 1;
		}
		if (depth !== 0) continue;
		const expression = source.slice(expressionStart, cursor).trim();
		const argument = expression.slice(1, -1).trim();
		const specifierQuote = argument[0];
		const firstLiteralEnd = specifierQuote === "\"" || specifierQuote === "'" ? skipQuoted(argument, 0, specifierQuote) : 0;
		const literal =
			(specifierQuote === "\"" || specifierQuote === "'") && firstLiteralEnd > 0 && argument[firstLiteralEnd - 1] === specifierQuote;
		const trailing = firstLiteralEnd > 0 ? argument.slice(firstLiteralEnd).trim() : argument;
		const validLiteral = literal && (trailing === "" || trailing.startsWith(","));
		if (!validLiteral) violations.push({ offset: index, expression: `import${expression}` });
		index = cursor - 1;
	}
	return violations;
}

function literalDynamicImportSpecifiers(source: string): string[] {
	const specifiers: string[] = [];
	const pattern = /\bimport\s*\(\s*(["'])([^"']+)\1/g;
	for (const match of source.matchAll(pattern)) {
		const specifier = match[2];
		if (specifier !== undefined) specifiers.push(specifier);
	}
	return specifiers;
}

async function assertLiteralCatalog(kind: CatalogKind): Promise<CatalogReport> {
	if (kind === "tools") {
		const filePath = path.join(packageRoot, "src", "tools", "descriptors.ts");
		if (!fsSync.existsSync(filePath)) {
			throw new VerifyModuleTraceError("CatalogNotFound", `Tool loader registry is missing: ${filePath}`);
		}
		const source = await fs.readFile(filePath, "utf8");
		const actual = new Set(literalDynamicImportSpecifiers(source));
		const missing = [...EXPECTED_TOOL_LOADER_SPECIFIERS].filter(specifier => !actual.has(specifier));
		const unexpected = [...actual].filter(specifier => !EXPECTED_TOOL_LOADER_SPECIFIERS.has(specifier));
		if (missing.length > 0 || unexpected.length > 0) {
			throw new VerifyModuleTraceError("LiteralCatalogMismatch", "Tool loader registry specifier set does not match the expected catalog", {
				file: path.relative(repoRoot, filePath),
				missing,
				unexpected,
			});
		}
		const violations: CatalogReport["violations"] = [];
		for (const violation of dynamicImportViolations(source)) {
			const position = lineColumn(source, violation.offset);
			violations.push({ file: path.relative(repoRoot, filePath), ...position, expression: violation.expression });
		}
		return { kind, files: [path.relative(repoRoot, filePath)], violations };
	}

	if (kind === "skills") {
		const filePath = path.join(packageRoot, "src", "defaults", "gjc-skills.generated.ts");
		if (!fsSync.existsSync(filePath)) {
			throw new VerifyModuleTraceError("CatalogNotFound", `Bundled skill catalog is missing: ${filePath}`);
		}
		const source = await fs.readFile(filePath, "utf8");
		const actual = new Set(literalDynamicImportSpecifiers(source));
		if (actual.size === 0) {
			throw new VerifyModuleTraceError("LiteralCatalogEmpty", "Bundled skill catalog contains no literal dynamic imports", {
				file: path.relative(repoRoot, filePath),
			});
		}
		const expected = new Set<string>();
		for (const match of source.matchAll(/relativePath:\s*["']([^"']+)["']/g)) {
			const relativePath = match[1];
			if (relativePath !== undefined) {
				expected.add(`./gjc/skills/${relativePath.replace(/^skills\//, "").replace(/^skill-fragments\//, "")}`);
			}
		}
		if (expected.size === 0 || expected.size !== actual.size || [...expected].some(specifier => !actual.has(specifier))) {
			throw new VerifyModuleTraceError("LiteralCatalogMismatch", "Bundled skill catalog entries and literal imports differ", {
				file: path.relative(repoRoot, filePath),
				expected: [...expected],
				actual: [...actual],
			});
		}
		const violations: CatalogReport["violations"] = [];
		for (const violation of dynamicImportViolations(source)) {
			const position = lineColumn(source, violation.offset);
			violations.push({ file: path.relative(repoRoot, filePath), ...position, expression: violation.expression });
		}
		return { kind, files: [path.relative(repoRoot, filePath)], violations };
	}

	const files = (await collectSourceFiles(path.join(packageRoot, "src"))).filter(filePath => isCatalogCandidate(filePath, kind));
	if (files.length === 0) {
		throw new VerifyModuleTraceError("CatalogNotFound", `No generated ${kind} catalog source was found under packages/coding-agent/src`);
	}
	const violations: CatalogReport["violations"] = [];
	for (const filePath of files) {
		const source = await fs.readFile(filePath, "utf8");
		for (const violation of dynamicImportViolations(source)) {
			const position = lineColumn(source, violation.offset);
			violations.push({ file: path.relative(repoRoot, filePath), ...position, expression: violation.expression });
		}
	}
	return { kind, files: files.map(file => path.relative(repoRoot, file)), violations };
}

function reportError(error: unknown, json: boolean): never {
	const typed = error instanceof VerifyModuleTraceError ? error : new VerifyModuleTraceError("InternalError", String(error));
	if (json) {
		console.error(JSON.stringify({ error: { type: typed.code, message: typed.message, details: typed.details } }, null, 2));
	} else {
		console.error(`${typed.code}: ${typed.message}`);
		if (typed.details !== undefined) console.error(JSON.stringify(typed.details, null, 2));
		if (typed.code === "UsageError") console.error(`\n${usage()}`);
	}
	process.exit(1);
}

async function main(): Promise<void> {
	let options: CliOptions;
	try {
		options = parseArgs(process.argv.slice(2));
	} catch (error) {
		reportError(error, process.argv.includes("--json"));
		return;
	}

	const catalogReports: CatalogReport[] = [];
	const activeDeny = [...new Set([...options.deny, ...(options.milestone ? TRACE_MILESTONE_DENY_RULES[options.milestone] ?? [] : [])])];
	try {
		for (const kind of [...new Set(options.literalCatalogs)]) catalogReports.push(await assertLiteralCatalog(kind));
	} catch (error) {
		reportError(error, options.json);
		return;
	}

	const scenarioReports: ScenarioTraceReport[] = [];
	const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-module-trace-"));
	try {
		for (const scenario of options.scenarios) {
			const report = await runScenario(tempRoot, scenario);
			// Deny rules gate the LOADED module graph. `source-scan` records are
			// literal dynamic-import mentions discovered by parsing loaded sources —
			// they are exactly what the compile constraint requires lazified modules
			// to keep, and are validated separately by --assert-literal-catalog.
			// Counting them here would make every legitimately-deferred module fail
			// its own deny rule forever.
			report.offendingModules = report.records.flatMap(record =>
				record.kind === "source-scan"
					? []
					: activeDeny
							.filter(pattern => entryMatches(record, pattern))
							.map(pattern => ({
								pattern,
								specifier: record.specifier,
								resolved: record.resolved,
								...(record.importer ? { importer: record.importer } : {}),
							})),
			);
			report.nativeImportViolations = options.assertNoNativeFrom.flatMap(pattern =>
				nativeImportViolations(report.records, pattern),
			);
			scenarioReports.push(report);
		}
	} catch (error) {
		await fs.rm(tempRoot, { recursive: true, force: true });
		reportError(error, options.json);
		return;
	}
	await fs.rm(tempRoot, { recursive: true, force: true });

	const failedDeny = scenarioReports.flatMap(report => report.offendingModules.map(item => ({ scenario: report.scenario, ...item })));
	const failedNative = scenarioReports.flatMap(report =>
		report.nativeImportViolations.map(item => ({ scenario: report.scenario, ...item })),
	);
	const failedCatalogs = catalogReports.flatMap(report => report.violations.map(item => ({ kind: report.kind, ...item })));
	const result = {
		deny: activeDeny,
		ok: failedDeny.length === 0 && failedNative.length === 0 && failedCatalogs.length === 0,
		scenarios: scenarioReports.map(report => ({
			scenario: report.scenario,
			...(report.barrier ? { barrier: report.barrier } : {}),
			argv: report.argv,
			exitCode: report.exitCode,
			moduleCount: report.records.length,
			offendingModules: report.offendingModules,
			nativeImportViolations: report.nativeImportViolations,
		})),
		literalCatalogs: catalogReports,
	};
	if (options.json) {
		console.log(JSON.stringify(result, null, 2));
	} else {
		for (const report of scenarioReports) {
			console.log(`${report.offendingModules.length || report.nativeImportViolations.length ? "FAIL" : "PASS"} ${report.scenario} (${report.records.length} traced modules)`);
			for (const item of report.offendingModules)
				console.log(`  deny ${item.pattern}: ${item.resolved} (specifier ${item.specifier}${item.importer ? ` from ${item.importer}` : ""})`);
			for (const item of report.nativeImportViolations)
				console.log(`  native ${item.pattern}: ${item.nativeResolved} (specifier ${item.nativeSpecifier})`);
		}
		for (const report of catalogReports) {
			console.log(`${report.violations.length === 0 ? "PASS" : "FAIL"} literal ${report.kind} catalog (${report.files.length} files)`);
			for (const item of report.violations) console.log(`  ${item.file}:${item.line}:${item.column}: ${item.expression}`);
		}
	}
	process.exitCode = result.ok ? 0 : 1;
}

await main();
