/**
 * Bun preload script that traces module resolution.
 * Usage: bun --preload ./scripts/trace-loader.ts <script>
 */

import * as fs from "node:fs";
import * as path from "node:path";

type TraceRecord = {
	specifier: string;
	raw: string;
	resolved: string;
	importer?: string;
	kind?: string;
};

const TRACE_ROOT_SENTINEL = "__GJC_TRACE_ROOT__";

class TraceWriteError extends Error {
	readonly code = "TraceWriteError";

	constructor(message: string, options?: { cause?: unknown }) {
		super(message, options);
		this.name = this.code;
	}
}

class TraceCaptureError extends Error {
	readonly code: string;
	constructor(code: string, message: string, options?: { cause?: unknown }) {
		super(message, options);
		this.name = code;
		this.code = code;
	}
}

function failCapture(error: TraceCaptureError): never {
	try { process.stderr.write(`[trace-loader] ${error.code}: ${error.message}\n`); } catch {}
	process.exitCode = 1;
	throw error;
}

const startTime = Bun.nanoseconds();
const traceOutput = process.env.GJC_TRACE_OUT;
const records: TraceRecord[] = [];
const recordKeys = new Set<string>();
const scannedModules = new Set<string>();
const humanResolved = new Set<string>();

const traceRoot = path.resolve(process.argv[1] ?? process.cwd());
records.push({ specifier: TRACE_ROOT_SENTINEL, raw: TRACE_ROOT_SENTINEL, resolved: traceRoot, kind: "root" });
let traceWritten = false;
let traceWriteFailed = false;
const resolveCache = new Map<string, string>();
// Bun.resolveSync re-enters this plugin's onResolve hook. Without a guard the loader
// recurses into itself until the stack overflows, so probe resolutions are not traced.
let resolving = 0;

function resolveSpecifier(specifier: string, resolveDir: string, importer?: string): string {
	if (specifier === "bun" || specifier.startsWith("bun:") || specifier.startsWith("node:") || specifier.includes("://")) return specifier;
	if (path.isAbsolute(specifier)) return specifier;
	// Bun does not always supply `resolveDir`; fall back to the importer's directory so
	// relative specifiers still become absolute paths. Without this a record such as
	// `../../natives/native/loader-state.js` never resolves into its owning package, and a
	// package-scoped deny rule can never match it.
	const importerDir = importer && path.isAbsolute(importer) ? path.dirname(importer) : "";
	// Relative specifiers resolve against the importer first; bare specifiers against resolveDir.
	const bases = specifier.startsWith(".")
		? [importerDir, resolveDir, process.cwd()]
		: [resolveDir, importerDir, process.cwd()];
	const key = `${specifier}\u0000${bases.join("\u0001")}`;
	const cached = resolveCache.get(key);
	if (cached !== undefined) return cached;

	let result = specifier;
	// A plain path join is cheaper than a throwing resolveSync, so try it first for
	// relative specifiers and only fall back to Bun's resolver when it does not exist.
	if (specifier.startsWith(".")) {
		for (const base of bases) {
			if (!base) continue;
			const candidate = path.resolve(base, specifier);
			if (fs.existsSync(candidate)) {
				result = candidate;
				break;
			}
		}
	}
	if (result === specifier) {
		resolving += 1;
		try {
			for (const base of bases) {
				if (!base) continue;
				try {
					result = Bun.resolveSync(specifier, base);
					break;
				} catch {
					// Continue trying importer/resolveDir bases.
				}
			}
		} finally {
			resolving -= 1;
		}
	}
	if (!result || result === specifier) {
		return failCapture(new TraceCaptureError("TraceResolutionError", `unable to resolve ${specifier} from ${importer ?? resolveDir}`, {
			cause: { specifier, importer, resolveDir },
		}));
	}
	resolveCache.set(key, result);
	return result;
}

function recordResolution(args: { path: string; importer?: string; resolveDir: string; kind?: string }): void {
	const resolved = resolveSpecifier(args.path, args.resolveDir, args.importer);
	// Include the provenance kind in the dedupe key: a source-scan (lazy literal
	// mention) record must never suppress the record of the same edge actually
	// LOADING later — the loaded graph and the literal catalog are distinct proofs.
	const key = `${args.path}\u0000${resolved}\u0000${args.importer ?? ""}\u0000${args.kind ?? "load"}`;
	if (recordKeys.has(key)) return;
	recordKeys.add(key);
	records.push({
		specifier: args.path,
		raw: args.path,
		resolved,
		...(args.importer ? { importer: args.importer } : {}),
		...(args.kind ? { kind: args.kind } : {}),
	});

	const elapsed = ((Bun.nanoseconds() - startTime) / 1e6).toFixed(1);
	// Keep the historical human-readable line and its local-file filtering intact.
	if (!args.path.includes("node_modules") && !args.path.startsWith("node:")) {
		if (humanResolved.has(args.path)) return;
		humanResolved.add(args.path);
		const shortPath = args.path.replace(process.cwd(), ".");
		process.stderr.write(`[${elapsed}ms] resolve: ${shortPath}\n`);
	}
}

const transpilers = new Map<string, InstanceType<typeof Bun.Transpiler>>();

function recordSourceImports(modulePath: string): void {
	if (!/\.(?:[cm]?[jt]sx?)$/i.test(modulePath) || !path.isAbsolute(modulePath)) return;
	if (scannedModules.has(modulePath)) return;
	scannedModules.add(modulePath);
	let source: string;
	try {
		source = fs.readFileSync(modulePath, "utf8");
	} catch (error) {
		failCapture(new TraceCaptureError("TraceSourceReadError", `unable to read imported source ${modulePath}`, { cause: error }));
	}
	// Use Bun's real parser rather than a regex: a regex scan matches keyword-shaped
	// text inside string literals (e.g. a command named "import"), which either
	// records junk specifiers or, with fail-closed resolution, aborts the capture on
	// non-imports. scanImports only reports actual import/require sites and already
	// excludes type-only imports.
	const extension = path.extname(modulePath).toLowerCase();
	const loader =
		extension === ".ts" || extension === ".mts" || extension === ".cts"
			? "ts"
			: extension === ".tsx"
				? "tsx"
				: extension === ".jsx"
					? "jsx"
					: "js";
	let transpiler = transpilers.get(loader);
	if (!transpiler) {
		transpiler = new Bun.Transpiler({ loader });
		transpilers.set(loader, transpiler);
	}
	let imports: Array<{ path: string }>;
	try {
		// scanImports rejects shebang lines; strip one (preserving length is unnecessary
		// since only specifiers are extracted).
		imports = transpiler.scanImports(source.startsWith("#!") ? source.replace(/^#![^\n]*/, "") : source);
	} catch (error) {
		return failCapture(
			new TraceCaptureError("TraceSourceScanError", `unable to scan imports in ${modulePath}`, { cause: error }),
		);
	}
	for (const entry of imports) {
		recordResolution({
			path: entry.path,
			importer: modulePath,
			resolveDir: path.dirname(modulePath),
			kind: "source-scan",
		});
	}
}

function flushTrace(): void {
	if (!traceOutput || traceWriteFailed) return;
	try {
		fs.mkdirSync(path.dirname(path.resolve(traceOutput)), { recursive: true });
		fs.writeFileSync(traceOutput, `${JSON.stringify(records, null, 2)}\n`, "utf8");
	} catch (error) {
		traceWriteFailed = true;
		const typed = new TraceWriteError(`failed to write ${traceOutput}`, { cause: error });
		const message = `${typed.code}: ${typed.message}: ${String(error)}`;
		try {
			process.stderr.write(`[trace-loader] ${message}\n`);
		} finally {
			// The exit hook is synchronous; marking the process failed is the only
			// reliable way to surface a capture failure to the verifier.
			process.exitCode = 1;
		}
	}
}

function writeTrace(): void {
	if (!traceOutput || traceWritten) return;
	traceWritten = true;
	flushTrace();
}

Bun.plugin({
	name: "trace-loader",
	setup(build) {
		build.onResolve({ filter: /.*/ }, args => {
			// Skip resolutions this loader itself triggered via Bun.resolveSync.
			if (resolving > 0) return undefined;
			recordResolution(args);
			recordSourceImports(args.path);
			if (args.importer) recordSourceImports(args.importer);
			// Return undefined to let Bun handle resolution normally.
			return undefined;
		});
	},
});

process.on("exit", writeTrace);
for (const signal of ["SIGINT", "SIGTERM"] as const) {
	process.once(signal, () => {
		writeTrace();
		process.exit(signal === "SIGINT" ? 130 : 143);
	});
}
if (traceOutput) {
	const snapshotTimer = setInterval(() => {
		if (!traceWritten && records.length > 0) flushTrace();
	}, 100);
	snapshotTimer.unref?.();
}
process.stderr.write(`[trace-loader] preload active\n`);
