import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { constants as fsConstants, statSync as fsStatSync } from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

/**
 * Public-entry inertness contract for `gjc sdk diagnostics` (DESIGN §B1).
 *
 * Every observation launches a FRESH Bun process whose traps are installed by a
 * preload BEFORE the actual `bin/gjc.js` entry (or the exported `runCli`) is
 * imported, so import-time effects are counted too. The harness launch is the
 * test's own process; the observation itself must spawn nothing.
 */

const REPO_ROOT = path.resolve(import.meta.dir, "../../..");
const BIN_ENTRY = path.join(REPO_ROOT, "packages/coding-agent/bin/gjc.js");
const CLI_SOURCE = path.join(REPO_ROOT, "packages/coding-agent/src/cli.ts");
const ORDINARY_SOURCE = path.join(REPO_ROOT, "packages/coding-agent/src/cli-ordinary.ts");
const OUTPUT_BUDGET_BYTES = 8192;

type TrapReport = {
	bunSpawn: string[];
	bunSpawnSync: string[];
	childProcess: string[];
	fsMutations: string[];
	sockets: string[];
	fetchPatched: boolean;
	runtimeGlobalsInstalled: boolean;
	envDelta: Record<string, string | null>;
	reads: string[];
	nativeActivations: number;
	statReads: string[];
	promiseReads: string[];
	bunReads: string[];
	uncoveredBoundaries: string[];
	installedWrappers: string[];
	injectionEvidence: string[];
	stdioHandles: string[];
	stage: string;
};

type EntryRun = {
	exitCode: number;
	stdout: string;
	stderr: string;
	stdoutBytes: number;
	stderrBytes: number;
	trap: TrapReport;
};

let workspace: string;
let trapPreload: string;
let runCliHarness: string;
let ordinaryHarness: string;
let fixtureHome: string;
let fixtureAgentDir: string;
let absentAgentDir: string;

const TRAP_PRELOAD = String.raw`
const nodeFs = require("node:fs");
const nodeFsPromises = require("node:fs/promises");
const childProcess = require("node:child_process");
const net = require("node:net");
const tls = require("node:tls");

// Instrumentation-integrity injections: a required wrapper that refuses installation, and a
// read on a live task-owned descriptor that the artifact open never returned.
const INSTRUMENT_FAULT = process.env.GJC_ENTRY_TRAP_INSTRUMENT_FAULT ?? "";
if (INSTRUMENT_FAULT === "uninstallable") {
	Object.defineProperty(nodeFs, "readSync", { value: nodeFs.readSync, writable: false, configurable: false });
}
const rawWriteFileSync = nodeFs.writeFileSync;
const originalFetch = globalThis.fetch;
const OUT = process.env.GJC_ENTRY_TRAP_OUT;
const WATCHED_ENV = [
	"MallocStackLogging",
	"MallocStackLoggingNoCompact",
	"GJC_MANAGED_OWNER_CHILD_TOKEN",
	"GJC_TIMING",
	"HOME",
	"GJC_CODING_AGENT_DIR",
];
const envBefore = {};
for (const key of WATCHED_ENV) envBefore[key] = process.env[key] ?? null;

const report = {
	bunSpawn: [],
	bunSpawnSync: [],
	childProcess: [],
	fsMutations: [],
	reads: [],
	statReads: [],
	promiseReads: [],
	bunReads: [],
	uncoveredBoundaries: [],
	installedWrappers: [],
	injectionEvidence: [],
	stdioHandles: [],
	sockets: [],
	nativeActivations: 0,
	// One ledger for the WHOLE entry: it is never reset, so an effect during module import
	// cannot be hidden behind a later snapshot. There is deliberately no separate
	// "import stage" copy, because this harness cannot observe that boundary and a duplicate
	// count would only look like evidence.
	stage: "whole-entry",
	fetchPatched: false,
	runtimeGlobalsInstalled: false,
	envDelta: {},
};

// This ledger is never reset, so it spans the whole entry: module import AND command
// invocation are both inside it. The importStage copy is written at exit purely so a
// reader can see that no reset happened between the two phases.


// Installation readback: every required wrapper must actually be in place. A binding that
// silently refused assignment is recorded, and the assertions below refuse to treat a zero
// ledger from a blind harness as evidence.
const REQUIRED_WRAPPERS = [];
function requireWrapper(name, host, key, wrapper) {
	try {
		host[key] = wrapper;
	} catch {
		report.uncoveredBoundaries.push(name);
		return;
	}
	if (host[key] !== wrapper) report.uncoveredBoundaries.push(name);
	else REQUIRED_WRAPPERS.push(name);
}

function describeCmd(args) {
	try {
		return JSON.stringify(args).slice(0, 400);
	} catch {
		return "<unserializable>";
	}
}

const blockedSpawnSync = () => ({
	exitCode: 1,
	success: false,
	stdout: new Uint8Array(),
	stderr: new Uint8Array(),
	signalCode: null,
	resourceUsage: undefined,
	pid: -1,
});

Bun.spawn = (...args) => {
	report.bunSpawn.push(describeCmd(args));
	throw Object.assign(new Error("trap: spawn blocked"), { code: "EPERM" });
};
Bun.spawnSync = (...args) => {
	report.bunSpawnSync.push(describeCmd(args));
	return blockedSpawnSync();
};

for (const name of ["spawn", "spawnSync", "exec", "execSync", "execFile", "execFileSync", "fork"]) {
	const original = childProcess[name];
	if (typeof original !== "function") continue;
	childProcess[name] = (...args) => {
		report.childProcess.push(name + " " + describeCmd(args));
		throw Object.assign(new Error("trap: child_process blocked"), { code: "EPERM" });
	};
}

const SYNC_MUTATORS = [
	"writeFileSync",
	"appendFileSync",
	"mkdirSync",
	"mkdtempSync",
	"rmSync",
	"rmdirSync",
	"unlinkSync",
	"renameSync",
	"chmodSync",
	"chownSync",
	"symlinkSync",
	"linkSync",
	"truncateSync",
	"utimesSync",
	"copyFileSync",
	"writeSync",
	"createWriteStream",
];
for (const name of SYNC_MUTATORS) {
	const original = nodeFs[name];
	if (typeof original !== "function") continue;
	nodeFs[name] = (...args) => {
		report.fsMutations.push("fs." + name + " " + describeCmd(args[0]));
		throw Object.assign(new Error("trap: fs mutation blocked"), { code: "EPERM" });
	};
}
const ASYNC_MUTATORS = [
	"writeFile",
	"appendFile",
	"mkdir",
	"mkdtemp",
	"rm",
	"rmdir",
	"unlink",
	"rename",
	"chmod",
	"chown",
	"symlink",
	"link",
	"truncate",
	"utimes",
	"copyFile",
];
for (const name of ASYNC_MUTATORS) {
	const original = nodeFsPromises[name];
	if (typeof original !== "function") continue;
	nodeFsPromises[name] = async (...args) => {
		report.fsMutations.push("fs/promises." + name + " " + describeCmd(args[0]));
		throw Object.assign(new Error("trap: fs mutation blocked"), { code: "EPERM" });
	};
}
const rawBunWrite = Bun.write;
Bun.write = (...args) => {
	report.fsMutations.push("Bun.write " + describeCmd(args[0]));
	throw Object.assign(new Error("trap: fs mutation blocked"), { code: "EPERM" });
};
// Read-family and native-activation counters: the fresh bin is observed at both stages.
for (const name of ["readFileSync", "readSync", "readdirSync", "statSync", "lstatSync", "realpathSync"]) {
	const real = nodeFs[name];
	if (typeof real !== "function") {
		report.uncoveredBoundaries.push("fs." + name + " (absent)");
		continue;
	}
	requireWrapper("fs." + name, nodeFs, name, (...args) => {
		// Metadata reads are a separate ledger: the exact open pin stays exclusively about
		// fs.openSync, and these entries are bounded by path instead. A descriptor read is
		// attributed to the artifact only while that descriptor is the one the artifact open
		// returned; anything else is recorded as an unattributed descriptor read.
		if (name === "readSync") {
			const fd = args[0];
			report.statReads.push(
				artifactDescriptors.has(fd)
					? "fs.readSync artifact-fd " + describeCmd(fd)
					: "fs.readSync unattributed-fd " + describeCmd(fd),
			);
		} else {
			report.statReads.push("fs." + name + " " + describeCmd(args[0]));
		}
		return real(...args);
	});
}
// Async read boundary: the facade's own counters observe these, so the fresh bin does too.
// Some of these bindings are not writable in every runtime; an unpatchable one is recorded
// as an uncovered boundary instead of crashing the entry under test.
for (const name of ["readFile", "open", "readdir", "stat", "lstat", "realpath"]) {
	const real = nodeFsPromises[name];
	if (typeof real !== "function") {
		// A required boundary that does not exist cannot be counted: that invalidates the
		// ledger instead of being skipped.
		report.uncoveredBoundaries.push("fs/promises." + name + " (absent)");
		continue;
	}
	requireWrapper("fs/promises." + name, nodeFsPromises, name, (...args) => {
		report.promiseReads.push("promises." + name + " " + describeCmd(args[0]));
		return real(...args);
	});
}
{
	const rawBunFile = Bun.file;
	requireWrapper("Bun.file", Bun, "file", (...args) => {
		// A numeric handle is classified by the operation actually performed on it below, not
		// by its number: an output write is a stdio handle, a read is a read.
		const handle = rawBunFile(...args);
		if (typeof args[0] !== "number") report.bunReads.push("Bun.file " + describeCmd(args[0]));
		if (typeof args[0] === "number") {
			const fd = args[0];
			// Only an actual OUTPUT operation on one of the standard output descriptors is
			// exempt. A writer on any other descriptor is a real operation on something this
			// route holds and is recorded, and any read on a numeric handle is a read.
			const rawWriter = handle.writer?.bind(handle);
			if (typeof rawWriter === "function") {
				handle.writer = (...writerArgs) => {
					if (fd === 1 || fd === 2) report.stdioHandles.push("Bun.file.writer " + describeCmd(fd));
					else report.bunReads.push("Bun.file.writer non-stdio " + describeCmd(fd));
					return rawWriter(...writerArgs);
				};
			} else {
				report.uncoveredBoundaries.push("Bun.file(fd).writer (absent)");
			}
			for (const readOp of ["text", "arrayBuffer", "bytes", "json", "stream"]) {
				const rawRead = handle[readOp]?.bind(handle);
				if (typeof rawRead !== "function") {
					report.uncoveredBoundaries.push("Bun.file(fd)." + readOp + " (absent)");
					continue;
				}
				const wrapper = (...readArgs) => {
					report.bunReads.push("Bun.file." + readOp + " " + describeCmd(fd));
					return rawRead(...readArgs);
				};
				handle[readOp] = wrapper;
				// Readback: a silently refused assignment must not look like coverage.
				if (handle[readOp] !== wrapper) report.uncoveredBoundaries.push("Bun.file(fd)." + readOp);
			}
		}
		return handle;
	});
}

const rawDlopen = process.dlopen;
process.dlopen = (...args) => {
	report.nativeActivations += 1;
	return rawDlopen(...args);
};
// G2 negative-control injection: the fault happens inside the REAL entry process, on the
// same production route, so the resulting ledger is a production ledger and the pinned
// assertion must reject it for the stated reason.
const INJECT = process.env.GJC_ENTRY_TRAP_INJECT ?? "";
if (INJECT === "nonstdio-bunfile-read") {
	// A successful Bun.file read on a live non-stdio descriptor, performed where awaiting is
	// allowed. The descriptor is opened through the raw syscall so the open ledger never sees
	// it, and the read must still be counted.
	const fd = nodeFs.openSync.__raw
		? nodeFs.openSync.__raw(process.env.GJC_ENTRY_TRAP_STRAY ?? "", nodeFs.constants.O_RDONLY)
		: nodeFs.openSync(process.env.GJC_ENTRY_TRAP_STRAY ?? "", nodeFs.constants.O_RDONLY);
	const text = await Bun.file(fd).text();
	report.injectionEvidence.push("nonstdio-bunfile fd=" + fd + " bytes=" + text.length);
	nodeFs.closeSync(fd);
}
if (INJECT !== "") {
	const artifact = process.env.GJC_ENTRY_TRAP_ARTIFACT ?? "";
	const stray = process.env.GJC_ENTRY_TRAP_STRAY ?? "";
	const rawCloseSync = nodeFs.closeSync;
	process.on("beforeExit", () => {
		try {
			if (INJECT === "live-foreign-fd-read") {
				// A REAL live descriptor obtained through the raw syscall, so the open never
				// reaches the open ledger: the exact open path/flags/multiset gate and the
				// artifact-derived count bound both still pass. The read really succeeds and
				// returns bytes, so only attribution can reject it.
				const fd = rawOpenSync(stray, nodeFs.constants.O_RDONLY);
				const buffer = Buffer.allocUnsafe(8);
				const bytesRead = nodeFs.readSync(fd, buffer, 0, 8, 0);
				report.injectionEvidence.push("live-foreign-fd fd=" + fd + " bytesRead=" + bytesRead);
				rawCloseSync(fd);
				return;
			}
			if (INJECT === "reused-fd-number-read") {
				// Take the artifact's own descriptor number, close it (which revokes the
				// attribution) and then reopen a different file through the raw syscall so the
				// SAME number comes back. The read succeeds with bytes on a descriptor that is
				// no longer the artifact's, and the open ledger never saw the reopen.
				const artifactFd = nodeFs.openSync(
					artifact,
					nodeFs.constants.O_RDONLY | (nodeFs.constants.O_NOFOLLOW ?? 0),
				);
				nodeFs.closeSync(artifactFd);
				const reusedFd = rawOpenSync(stray, nodeFs.constants.O_RDONLY);
				const buffer = Buffer.allocUnsafe(8);
				const bytesRead = nodeFs.readSync(reusedFd, buffer, 0, 8, 0);
				report.injectionEvidence.push(
					"reused-fd artifactFd=" + artifactFd + " reusedFd=" + reusedFd + " bytesRead=" + bytesRead,
				);
				rawCloseSync(reusedFd);
				return;
			}

			if (INJECT === "foreign-fd-read") {
				// A live descriptor this route opened for something else: reading it must never
				// inherit the artifact's permission.
				const fd = nodeFs.openSync(stray, nodeFs.constants.O_RDONLY);
				const buffer = Buffer.allocUnsafe(8);
				nodeFs.readSync(fd, buffer, 0, 8, 0);
				nodeFs.closeSync(fd);
				return;
			}
			if (INJECT === "other-path") nodeFs.closeSync(nodeFs.openSync(stray, nodeFs.constants.O_RDONLY));
			else if (INJECT === "extra-open")
				nodeFs.closeSync(
					nodeFs.openSync(artifact, nodeFs.constants.O_RDONLY | (nodeFs.constants.O_NOFOLLOW ?? 0)),
				);
			else if (INJECT === "write-flags")
				nodeFs.closeSync(nodeFs.openSync(stray, nodeFs.constants.O_RDWR | nodeFs.constants.O_CREAT));
		} catch {
			// A blocked write flag is itself recorded by the trap below; nothing to recover.
		}
	});
}

const rawOpenSync = nodeFs.openSync;
// Read-only modifiers this entry route may legitimately use. Everything else -- create,
// write, append, truncate, exclusive -- stays a mutation and is blocked.
const READ_ONLY_OPEN_FLAG_BITS =
	nodeFs.constants.O_RDONLY |
	(nodeFs.constants.O_NOFOLLOW ?? 0) |
	(nodeFs.constants.O_DIRECTORY ?? 0) |
	(nodeFs.constants.O_CLOEXEC ?? 0) |
	(nodeFs.constants.O_NONBLOCK ?? 0);
// Descriptor permission registry: a successful open of the resolved artifact grants read
// permission to exactly that descriptor, and closing it revokes the permission so a reused
// number cannot inherit it.
const ARTIFACT_PATH = process.env.GJC_ENTRY_TRAP_ARTIFACT ?? "";
const artifactDescriptors = new Set();

nodeFs.openSync = (target, flags, ...rest) => {
	const mode = typeof flags === "string" ? flags : String(flags ?? "");
	const numeric = typeof flags === "number" ? flags : 0;
	const readOnly =
		typeof flags === "number" ? (numeric & ~READ_ONLY_OPEN_FLAG_BITS) === 0 : !/[wa+]/.test(mode);
	if (!readOnly) {
		report.fsMutations.push("fs.openSync " + describeCmd(target) + " " + mode);
		throw Object.assign(new Error("trap: fs mutation blocked"), { code: "EPERM" });
	}
	const entry = "fs.openSync " + describeCmd(target) + " " + mode;
	report.reads.push(entry);
	const fd = rawOpenSync(target, flags, ...rest);
	if (ARTIFACT_PATH !== "" && String(target) === ARTIFACT_PATH) artifactDescriptors.add(fd);
	return fd;
};
const rawCloseSync = nodeFs.closeSync;
requireWrapper("fs.closeSync", nodeFs, "closeSync", (fd, ...rest) => {
	artifactDescriptors.delete(fd);
	return rawCloseSync(fd, ...rest);
});

for (const [label, mod] of [
	["net", net],
	["tls", tls],
]) {
	for (const name of ["connect", "createConnection"]) {
		const original = mod[name];
		if (typeof original !== "function") continue;
		mod[name] = (...args) => {
			report.sockets.push(label + "." + name + " " + describeCmd(args[0]));
			throw Object.assign(new Error("trap: socket blocked"), { code: "EPERM" });
		};
	}
}
const RealWebSocket = globalThis.WebSocket;
class TrappedWebSocket {
	constructor(...args) {
		report.sockets.push("WebSocket " + describeCmd(args[0]));
		throw Object.assign(new Error("trap: socket blocked"), { code: "EPERM" });
	}
}
globalThis.WebSocket = TrappedWebSocket;

process.on("exit", () => {
	report.fetchPatched = globalThis.fetch !== originalFetch;
	report.runtimeGlobalsInstalled = report.fetchPatched;
	for (const key of WATCHED_ENV) {
		const now = process.env[key] ?? null;
		if (now !== envBefore[key]) report.envDelta[key] = now;
	}
	try {
		report.installedWrappers = REQUIRED_WRAPPERS;
		rawWriteFileSync(OUT, JSON.stringify(report));
	} catch {}
});
`;

const RUN_CLI_HARNESS = `
const { runCli } = await import(process.env.GJC_ENTRY_CLI_SOURCE);
await runCli(process.argv.slice(2));
`;

/** The preserved ordinary graph: the pre-split route for this argv, kept as the
 * old-path baseline that must attempt the forbidden managed-owner handoff write. */
const ORDINARY_HARNESS = `
const { runOrdinaryCli } = await import(process.env.GJC_ENTRY_ORDINARY_SOURCE);
try {
	await runOrdinaryCli(process.argv.slice(2));
} catch (error) {
	process.stderr.write("ordinary harness threw: " + (error?.code ?? error?.message ?? "unknown") + "\\n");
	process.exitCode = 70;
}
`;

async function runEntry(
	argv: string[],
	options: { mode?: "bin" | "runCli" | "ordinary"; env?: Record<string, string>; agentDirEnv?: string } = {},
): Promise<EntryRun> {
	const mode = options.mode ?? "bin";
	const trapOut = path.join(workspace, `trap-${Math.random().toString(36).slice(2)}.json`);
	const env: Record<string, string> = {
		PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
		HOME: fixtureHome,
		TMPDIR: workspace,
		XDG_CACHE_HOME: path.join(workspace, "cache"),
		XDG_DATA_HOME: path.join(workspace, "data"),
		XDG_STATE_HOME: path.join(workspace, "state"),
		BUN_INSTALL_CACHE_DIR: process.env.BUN_INSTALL_CACHE_DIR ?? path.join(workspace, "bun-cache"),
		GJC_ENTRY_TRAP_OUT: trapOut,
		// The descriptor registry needs the artifact identity in every run, not only in the
		// negative-control rows.
		GJC_ENTRY_TRAP_ARTIFACT: RESOLVED_ARTIFACT_PATH,
		GJC_ENTRY_CLI_SOURCE: CLI_SOURCE,
		GJC_ENTRY_ORDINARY_SOURCE: ORDINARY_SOURCE,
		...(options.agentDirEnv === undefined ? {} : { GJC_CODING_AGENT_DIR: options.agentDirEnv }),
		...(options.env ?? {}),
	};
	const target = mode === "bin" ? BIN_ENTRY : mode === "ordinary" ? ordinaryHarness : runCliHarness;
	const child = Bun.spawnSync({
		cmd: [process.execPath, "--preload", trapPreload, target, ...argv],
		cwd: REPO_ROOT,
		env,
		stdout: "pipe",
		stderr: "pipe",
	});
	const stdoutRaw = child.stdout ?? new Uint8Array();
	const stderrRaw = child.stderr ?? new Uint8Array();
	let trap: TrapReport;
	try {
		trap = JSON.parse(await Bun.file(trapOut).text()) as TrapReport;
	} catch {
		trap = {
			bunSpawn: ["<trap report missing>"],
			bunSpawnSync: [],
			childProcess: [],
			fsMutations: [],
			reads: ["<trap report missing>"],
			sockets: [],
			statReads: ["<trap report missing>"],
			promiseReads: ["<trap report missing>"],
			bunReads: ["<trap report missing>"],
			uncoveredBoundaries: ["<trap report missing>"],
			installedWrappers: [],
			injectionEvidence: [],
			stdioHandles: [],
			nativeActivations: -1,
			stage: "missing",
			fetchPatched: false,
			runtimeGlobalsInstalled: false,
			envDelta: {},
		};
	}
	return {
		exitCode: child.exitCode ?? -1,
		stdout: new TextDecoder().decode(stdoutRaw),
		stderr: new TextDecoder().decode(stderrRaw),
		stdoutBytes: stdoutRaw.byteLength,
		stderrBytes: stderrRaw.byteLength,
		trap,
	};
}

/**
 * The approved read-only loader opens EXACTLY the resolved trusted artifact of this
 * checkout when a valid observation runs, with read-only flags only. The identity, the
 * flag set and the number of opens are all pinned: another path, a write flag or an extra
 * open fails. Help, usage and malformed routes never reach the loader, so they keep a
 * strictly empty ledger.
 */
const RESOLVED_ARTIFACT_PATH = path.resolve(
	import.meta.dir,
	"..",
	"..",
	"natives",
	"native",
	`pi_natives.${process.platform}-${process.arch}.node`,
);
/** `O_RDONLY | O_NOFOLLOW`: the artifact itself, never followed through a symlink. */
const ARTIFACT_OPEN_FLAGS = String(fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
/** `O_RDONLY | O_DIRECTORY | O_NOFOLLOW`: one namespace component of the trust chain. */
const CHAIN_OPEN_FLAGS = String(fsConstants.O_RDONLY | (fsConstants.O_DIRECTORY ?? 0) | (fsConstants.O_NOFOLLOW ?? 0));

/**
 * The exact reads the approved loader may perform for a valid observation: the resolved
 * artifact once, plus every ancestor directory of that artifact once, all read-only. Any
 * other path, any write flag and any extra open fail this pin.
 */
/**
 * The runtime tuple the observation contract admits. The approved loader chain only
 * exists here; every other tuple refuses before any open, so its ledger must be
 * strictly empty with zero native activation rather than a relaxed subset of this pin.
 */
const SUPPORTED_RUNTIME = process.platform === "darwin" && process.arch === "arm64" && Bun.version === "1.4.0";

function approvedLoaderReads(): string[] {
	// The artifact is opened exactly twice: once to verify the trusted digest and once for
	// the descriptor-pinned activation. A third open, another path or a write flag fails.
	const reads = [
		`fs.openSync "${RESOLVED_ARTIFACT_PATH}" ${ARTIFACT_OPEN_FLAGS}`,
		`fs.openSync "${RESOLVED_ARTIFACT_PATH}" ${ARTIFACT_OPEN_FLAGS}`,
	];
	let current = path.dirname(RESOLVED_ARTIFACT_PATH);
	for (;;) {
		reads.push(`fs.openSync "${current}" ${CHAIN_OPEN_FLAGS}`);
		const parent = path.dirname(current);
		if (parent === current) break;
		current = parent;
	}
	return reads.sort();
}

function expectInert(run: EntryRun, options: { approvedLoaderChain?: boolean } = {}): void {
	expect(run.trap.bunSpawn).toEqual([]);
	expect(run.trap.bunSpawnSync).toEqual([]);
	expect(run.trap.childProcess).toEqual([]);
	expect(run.trap.fsMutations).toEqual([]);
	// Reads are pinned by exact identity, exact read-only flags and exact multiset. The
	// ledger is never reset, so this covers the whole entry: import and invocation alike.
	const approvedChain = options.approvedLoaderChain === true && SUPPORTED_RUNTIME;
	expect([...run.trap.reads].sort()).toEqual(approvedChain ? approvedLoaderReads() : []);
	// Native activation: zero before any approved artifact access, and positive exactly on
	// the route that legitimately activates the addon.
	if (approvedChain) expect(run.trap.nativeActivations).toBeGreaterThan(0);
	else expect(run.trap.nativeActivations).toBe(0);
	// One un-reset ledger for the whole entry; no fabricated stage split is claimed.
	expect(run.trap.stage).toBe("whole-entry");
	// The instrumentation itself must be installed: an unpatchable required boundary makes
	// this evidence invalid instead of letting a blind zero ledger pass.
	expect(run.trap.uncoveredBoundaries).toEqual([]);
	expect(run.trap.installedWrappers).toContain("fs.readSync");
	expect(run.trap.installedWrappers).toContain("fs.closeSync");
	// Async and Bun read boundaries are covered too: off the approved route they must be
	// empty, and on it every path must belong to the approved artifact chain.
	// Metadata reads are bounded by path: on the approved route every one of them is the
	// artifact or one of its ancestors, and on every other route there are none at all.
	// Reads the runtime itself performs while resolving modules, and any I/O the addon
	// performs inside the kernel, are outside this JavaScript boundary and are not claimed.
	const artifactChain = new Set(approvedLoaderReads().map(entry => entry.split('"')[1]));
	// `fs.readSync` takes a descriptor, not a path, so it carries no path claim at this
	// boundary: it is counted separately and is only allowed on the approved route, where it
	// is how the trusted artifact's bytes are read through the retained descriptor.
	const descriptorReads = run.trap.statReads.filter(entry => entry.startsWith("fs.readSync "));
	// Descriptor reads carry their attribution: only reads on the descriptor the artifact
	// open returned are permitted, and a closed or reused number loses that permission.
	const unattributedReads = descriptorReads.filter(entry => entry.includes("unattributed-fd"));
	const pathStatReads = run.trap.statReads.filter(entry => !entry.startsWith("fs.readSync "));
	const strayStatReads = pathStatReads.filter(entry => {
		const target = entry.split('"')[1] ?? "";
		return !artifactChain.has(target);
	});
	const strayAsyncReads = [...run.trap.promiseReads, ...run.trap.bunReads].filter(entry => {
		const target = entry.split('"')[1] ?? "";
		return !artifactChain.has(target);
	});
	if (approvedChain) {
		expect(strayStatReads).toEqual([]);
		expect(strayAsyncReads).toEqual([]);
		// Descriptor reads are bounded by the artifact itself, not left unlimited: the
		// trusted-digest pass reads the resolved artifact in 1 MiB chunks, so the count is
		// derived from its real size plus a small slack for the final short read and the
		// pre-activation metadata re-check.
		const artifactBytes = fsStatSync(RESOLVED_ARTIFACT_PATH).size;
		const chunkBound = Math.ceil(artifactBytes / (1024 * 1024)) + 2;
		expect(descriptorReads.length).toBeGreaterThan(0);
		expect(descriptorReads.length).toBeLessThanOrEqual(chunkBound);
		expect(unattributedReads).toEqual([]);
	} else {
		expect(run.trap.statReads).toEqual([]);
		expect(run.trap.promiseReads).toEqual([]);
		expect(run.trap.bunReads).toEqual([]);
		expect(descriptorReads).toEqual([]);
		expect(unattributedReads).toEqual([]);
	}
	expect(run.trap.sockets).toEqual([]);
	expect(run.trap.runtimeGlobalsInstalled).toBe(false);
	expect(run.trap.envDelta).toEqual({});
	expect(run.stdoutBytes).toBeLessThanOrEqual(OUTPUT_BUDGET_BYTES);
	expect(run.stderrBytes).toBeLessThanOrEqual(OUTPUT_BUDGET_BYTES);
}

beforeAll(async () => {
	workspace = await fs.mkdtemp(path.join(process.env.TMPDIR ?? os.tmpdir(), "gjc-diag-entry-"));
	fixtureHome = path.join(workspace, "home");
	fixtureAgentDir = path.join(workspace, "agent");
	absentAgentDir = path.join(workspace, "absent-agent");
	await fs.mkdir(fixtureHome, { recursive: true, mode: 0o700 });
	await fs.mkdir(path.join(fixtureAgentDir, "sdk"), { recursive: true, mode: 0o700 });
	trapPreload = path.join(workspace, "entry-trap.ts");
	runCliHarness = path.join(workspace, "run-cli-harness.ts");
	ordinaryHarness = path.join(workspace, "ordinary-harness.ts");
	await Bun.write(trapPreload, TRAP_PRELOAD);
	await Bun.write(runCliHarness, RUN_CLI_HARNESS);
	await Bun.write(ordinaryHarness, ORDINARY_HARNESS);
});

afterAll(async () => {
	if (workspace) await fs.rm(workspace, { recursive: true, force: true });
});

describe("sdk diagnostics public entry (B1)", () => {
	it("prints family help inertly through the actual bin entry", async () => {
		const run = await runEntry(["sdk", "diagnostics", "--help"]);
		expect(run.exitCode).toBe(0);
		expect(run.stdout).toContain("gjc sdk diagnostics");
		expect(run.stdout).toContain("broker");
		expectInert(run);
	});

	it("prints broker help inertly", async () => {
		const run = await runEntry(["sdk", "diagnostics", "broker", "--help"]);
		expect(run.exitCode).toBe(0);
		expect(run.stdout).toContain("--agent-dir");
		expect(run.stdout).toContain("--expected-generation");
		expect(run.stdout).toContain("--timeout-ms");
		expectInert(run);
	});

	it("prints help inertly through the exported runCli", async () => {
		const run = await runEntry(["sdk", "diagnostics", "--help"], { mode: "runCli" });
		expect(run.exitCode).toBe(0);
		expect(run.stdout).toContain("gjc sdk diagnostics");
		expectInert(run);
	});

	it("rejects malformed diagnostics argv with fixed usage and exit 2", async () => {
		const cases: string[][] = [
			["sdk", "diagnostics"],
			["sdk", "diagnostics", "unknown-subcommand"],
			["sdk", "diagnostics", "broker", "--nope"],
			["sdk", "diagnostics", "broker", "--agent-dir"],
			["sdk", "diagnostics", "broker", "--agent-dir", fixtureAgentDir, "--agent-dir", fixtureAgentDir],
			["sdk", "diagnostics", "broker", "extra-operand"],
			["sdk", "diagnostics", "broker", "--timeout-ms", "0"],
			["sdk", "diagnostics", "broker", "--timeout-ms", "abc"],
		];
		for (const argv of cases) {
			const run = await runEntry(argv);
			expect({ argv, exit: run.exitCode }).toEqual({ argv, exit: 2 });
			expect(run.stderr).toContain("usage: gjc sdk diagnostics");
			expectInert(run);
		}
	});

	it("validates the whole argv before rendering help (R7)", async () => {
		const malformedWithHelp: string[][] = [
			["sdk", "diagnostics", "broker", "--help", "--bogus"],
			["sdk", "diagnostics", "broker", "--bogus", "--help"],
			["sdk", "diagnostics", "broker", "--help", "stderr-drain-internal"],
			["sdk", "diagnostics", "broker", "stderr-drain-internal", "--help"],
			["sdk", "diagnostics", "broker", "--help", "trailing-operand"],
			["sdk", "diagnostics", "broker", "--help", "--agent-dir"],
			["sdk", "diagnostics", "broker", "--agent-dir", fixtureAgentDir, "--agent-dir", fixtureAgentDir, "--help"],
			["sdk", "diagnostics", "--help", "broker"],
			["sdk", "diagnostics", "broker", "broker", "--help"],
			["sdk", "diagnostics", "--help", "--help"],
		];
		for (const argv of malformedWithHelp) {
			for (const mode of ["bin", "runCli"] as const) {
				const run = await runEntry(argv, { mode });
				expect({ argv, mode, exit: run.exitCode }).toEqual({ argv, mode, exit: 2 });
				expect(run.stderr).toContain("usage: gjc sdk diagnostics");
				expect(run.stdout).toBe("");
				expectInert(run);
			}
		}
	});

	it("still renders well-formed help with exit 0 (R7 control)", async () => {
		for (const argv of [
			["sdk", "diagnostics", "--help"],
			["sdk", "diagnostics", "-h"],
			["sdk", "diagnostics", "broker", "--help"],
			["sdk", "diagnostics", "broker", "-h"],
		]) {
			for (const mode of ["bin", "runCli"] as const) {
				const run = await runEntry(argv, { mode });
				expect({ argv, mode, exit: run.exitCode }).toEqual({ argv, mode, exit: 0 });
				expect(run.stdout).toContain("gjc sdk diagnostics");
				expect(run.stderr).toBe("");
				expectInert(run);
			}
		}
	});

	it("refuses a private worker marker placed after the diagnostics prefix", async () => {
		const run = await runEntry(["sdk", "diagnostics", "stderr-drain-internal"]);
		expect(run.exitCode).toBe(2);
		expect(run.stderr).toContain("usage: gjc sdk diagnostics");
		expectInert(run);
	});

	it("keeps the private stderr drainer route unchanged for non-diagnostics argv", async () => {
		const run = await runEntry(["sdk", "stderr-drain-internal"]);
		expect(run.exitCode).toBe(2);
		expect(run.stderr).not.toContain("usage: gjc sdk diagnostics");
		expect(run.stderr).toContain("internal stderr drainer");
	});

	it("rejects oversized argv without unbounded output", async () => {
		const run = await runEntry(["sdk", "diagnostics", "broker", "--agent-dir", "/x".repeat(60_000)]);
		expect(run.exitCode).toBe(2);
		expectInert(run);
	});

	it("does not run managed-owner admission or recovery for diagnostics argv", async () => {
		const run = await runEntry(["sdk", "diagnostics", "--help"], {
			env: { GJC_MANAGED_OWNER_CHILD_TOKEN: "trap-token-fixture" },
		});
		expect(run.exitCode).toBe(0);
		expectInert(run);
	});

	it("performs no managed-owner handoff or recovery write for diagnostics argv (G1)", async () => {
		// Synthetic, task-owned managed-owner environment. A child token without a
		// predecessor token makes admission read an exact child binding that does not
		// exist, and its fail-closed path persists a durable handoff record inside the
		// owner state root -- a write that a read-only observation must never attempt.
		const ownerStateDir = path.join(workspace, `owner-state-${Math.random().toString(36).slice(2)}`);
		await fs.mkdir(ownerStateDir, { recursive: true, mode: 0o700 });
		const ownerEnv = {
			GJC_TMUX_OWNER_STATE_DIR: ownerStateDir,
			GJC_COORDINATOR_SESSION_ID: "g1-session",
			GJC_TMUX_OWNER_GENERATION: "g1-generation",
			GJC_MANAGED_OWNER_RUN_ID: "g1-run",
			GJC_MANAGED_OWNER_INCARNATION: "g1-incarnation",
			GJC_MANAGED_OWNER_CHILD_TOKEN: "g1childtoken",
		};

		// Old-path baseline: the preserved ordinary graph really does attempt the
		// forbidden write for exactly this argv. Without this row a "zero mutations"
		// result proves nothing -- the earlier stale-addon receipt recorded
		// fsMutations=[] only because the addon import failed first, which is NOT
		// evidence that the admission write was avoided.
		const baseline = await runEntry(["sdk", "diagnostics", "--help"], { mode: "ordinary", env: ownerEnv });
		const attemptedOwnerWrites = baseline.trap.fsMutations.filter(entry => entry.includes(ownerStateDir));
		expect(attemptedOwnerWrites.length).toBeGreaterThan(0);
		expect(baseline.trap.fsMutations.join("\n")).toContain("mkdir");

		// Fixed path: the actual bin entry and the exported runCli render help with no
		// mutation anywhere, and the owner state root stays empty.
		for (const mode of ["bin", "runCli"] as const) {
			const run = await runEntry(["sdk", "diagnostics", "--help"], { mode, env: ownerEnv });
			// Assert the absence of the forbidden write first, so a regression reports the
			// exact attempted mutation rather than only a changed exit code.
			expect({ mode, mutations: run.trap.fsMutations }).toEqual({ mode, mutations: [] });
			expect({ mode, exit: run.exitCode }).toEqual({ mode, exit: 0 });
			expect(run.stdout).toContain("gjc sdk diagnostics");
			expectInert(run);
		}
		expect(await fs.readdir(ownerStateDir)).toEqual([]);
	});

	it("does not re-exec for malloc-stack-logging env on diagnostics argv", async () => {
		const run = await runEntry(["sdk", "diagnostics", "broker", "--agent-dir", absentAgentDir], {
			env: { MallocStackLogging: "1", MallocStackLoggingNoCompact: "1" },
		});
		expect(run.exitCode).toBe(1);
		expectInert(run, { approvedLoaderChain: true });
	});

	it("does not start timing/logger side effects for diagnostics argv", async () => {
		const run = await runEntry(["sdk", "diagnostics", "--help"], { env: { GJC_TIMING: "1" } });
		expect(run.exitCode).toBe(0);
		expectInert(run);
	});

	it("emits a bounded typed observation DTO for a valid explicit agent dir", async () => {
		const run = await runEntry([
			"sdk",
			"diagnostics",
			"broker",
			"--agent-dir",
			absentAgentDir,
			"--timeout-ms",
			"1500",
			"--json",
		]);
		expect(run.exitCode).toBe(1);
		const parsed = JSON.parse(run.stdout) as {
			schema: string;
			version: number;
			ok: boolean;
			observedAt: string;
			unavailable?: { reason: string; message: string };
			broker?: unknown;
		};
		expect(parsed.schema).toBe("gjc.broker-observation");
		expect(parsed.version).toBe(1);
		expect(parsed.ok).toBe(false);
		expect(typeof parsed.observedAt).toBe("string");
		expect(parsed.broker).toBeUndefined();
		expect([
			"absent",
			"stale",
			"incompatible",
			"authentication_failed",
			"unsupported",
			"generation_mismatch",
			"transport_unavailable",
			"timeout",
			"invalid_response",
			"unsafe_discovery",
		]).toContain(parsed.unavailable?.reason ?? "<missing>");
		expect(parsed.unavailable?.message).not.toContain(absentAgentDir);
		expectInert(run, { approvedLoaderChain: true });
	});

	it("fails when a required counter cannot be installed, and passes when it can", async () => {
		// Negative: the harness cannot install one required wrapper. A zero ledger from a blind
		// harness must NOT pass.
		const blind = await runEntry(["sdk", "diagnostics", "--help"], {
			env: { GJC_ENTRY_TRAP_INSTRUMENT_FAULT: "uninstallable" },
		});
		expect(
			blind.trap.uncoveredBoundaries.length + (blind.trap.installedWrappers.includes("fs.readSync") ? 0 : 1),
		).toBeGreaterThan(0);
		let blindRejected = false;
		try {
			expectInert(blind);
		} catch {
			blindRejected = true;
		}
		expect(blindRejected).toBe(true);

		// Positive: the same route with intact instrumentation still passes.
		const intact = await runEntry(["sdk", "diagnostics", "--help"]);
		expect(intact.trap.uncoveredBoundaries).toEqual([]);
		expectInert(intact);
	}, 300_000);

	it("fails attribution alone for a live descriptor that really read bytes", async () => {
		const strayPath = path.join(os.tmpdir(), `gjc-entry-live-${Math.random().toString(36).slice(2)}`);
		await Bun.write(strayPath, "live-descriptor-bytes");
		try {
			const rows: { inject: string; label: string; evidence: string; requiresArtifact?: boolean }[] = [
				// A live descriptor this route holds, opened through the raw syscall so the open
				// ledger never sees it.
				{ inject: "live-foreign-fd-read", label: "live foreign descriptor", evidence: "live-foreign-fd" },
				// The artifact's own descriptor number, closed and then reused by a different
				// file: the number is back, the permission is not.
				{
					inject: "reused-fd-number-read",
					label: "reused descriptor number",
					evidence: "reused-fd",
					// Only meaningful where an artifact descriptor exists to be closed and reused.
					requiresArtifact: true,
				},
			].filter(row => SUPPORTED_RUNTIME || row.requiresArtifact !== true);
			// The foreign-descriptor negative is platform independent and always runs.
			expect(rows.map(row => row.inject)).toContain("live-foreign-fd-read");
			for (const row of rows) {
				const run = await runEntry(["sdk", "diagnostics", "broker", "--agent-dir", absentAgentDir, "--json"], {
					env: { GJC_ENTRY_TRAP_INJECT: row.inject, GJC_ENTRY_TRAP_STRAY: strayPath },
				});

				// The syscall really happened and really returned bytes.
				const evidence = run.trap.injectionEvidence.find(entry => entry.startsWith(row.evidence));
				expect({ label: row.label, evidence: evidence !== undefined }).toEqual({
					label: row.label,
					evidence: true,
				});
				expect({ label: row.label, readBytes: /bytesRead=([1-9][0-9]*)/.test(evidence ?? "") }).toEqual({
					label: row.label,
					readBytes: true,
				});

				// Every other gate is independently satisfied.
				const approved = SUPPORTED_RUNTIME ? approvedLoaderReads().sort() : [];
				const observed = [...run.trap.reads].sort();
				const descriptorReads = run.trap.statReads.filter(entry => entry.startsWith("fs.readSync "));
				const unattributed = descriptorReads.filter(entry => entry.includes("unattributed-fd"));
				// Supported tuple: the digest pass reads the real artifact in 1 MiB chunks, so the
				// budget comes from its real size. Unsupported tuple: no artifact is ever opened,
				// so the only admissible descriptor reads are the ones this row really injected on
				// its own task-owned sentinel -- asserted exactly, and never by stat'ing an addon
				// that does not exist on this platform.
				const descriptorReadsAccounted = SUPPORTED_RUNTIME
					? descriptorReads.length <= Math.ceil(fsStatSync(RESOLVED_ARTIFACT_PATH).size / (1024 * 1024)) + 2
					: descriptorReads.length === unattributed.length;
				const openGatePasses =
					row.inject === "live-foreign-fd-read"
						? JSON.stringify(observed) === JSON.stringify(approved)
						: // The reused-number row opens the artifact once more on purpose; that extra
							// open is the only open-ledger difference and is the artifact's own path.
							observed.every(entry => approved.includes(entry));
				expect({
					label: row.label,
					openGatePasses,
					pathGatePasses: observed.every(entry => approved.includes(entry)),
					countGatePasses: descriptorReadsAccounted,
					mutations: run.trap.fsMutations,
					instrumentationComplete: run.trap.uncoveredBoundaries,
				}).toEqual({
					label: row.label,
					openGatePasses: true,
					pathGatePasses: true,
					countGatePasses: true,
					mutations: [],
					instrumentationComplete: [],
				});

				// Only attribution rejects it.
				expect({ label: row.label, unattributed: unattributed.length > 0 }).toEqual({
					label: row.label,
					unattributed: true,
				});
				let rejected = false;
				try {
					expectInert(run, { approvedLoaderChain: true });
				} catch {
					rejected = true;
				}
				expect({ label: row.label, rejected }).toEqual({ label: row.label, rejected: true });
			}
		} finally {
			await fs.rm(strayPath, { force: true });
		}
	}, 300_000);

	it("counts a Bun.file read on a live non-stdio descriptor and keeps stdout output exempt", async () => {
		const strayPath = path.join(os.tmpdir(), `gjc-entry-bunfd-${Math.random().toString(36).slice(2)}`);
		await Bun.write(strayPath, "bun-file-descriptor-bytes");
		try {
			// Negative: a successful Bun.file read on a non-stdio descriptor is a read.
			const run = await runEntry(["sdk", "diagnostics", "broker", "--agent-dir", absentAgentDir, "--json"], {
				env: { GJC_ENTRY_TRAP_INJECT: "nonstdio-bunfile-read", GJC_ENTRY_TRAP_STRAY: strayPath },
			});
			const evidence = run.trap.injectionEvidence.find(entry => entry.startsWith("nonstdio-bunfile"));
			expect(evidence).toBeDefined();
			expect(/bytes=([1-9][0-9]*)/.test(evidence ?? "")).toBe(true);
			const numericReads = run.trap.bunReads.filter(entry => entry.startsWith("Bun.file."));
			expect(numericReads.length).toBeGreaterThan(0);
			let rejected = false;
			try {
				expectInert(run, { approvedLoaderChain: true });
			} catch {
				rejected = true;
			}
			expect(rejected).toBe(true);

			// Positive: the help route writes real output through a standard descriptor and stays
			// exempt, with the instrumentation fully installed.
			const help = await runEntry(["sdk", "diagnostics", "--help"]);
			expect(help.exitCode).toBe(0);
			expect(help.trap.uncoveredBoundaries).toEqual([]);
			expect(help.trap.bunReads).toEqual([]);
			expectInert(help);
		} finally {
			await fs.rm(strayPath, { force: true });
		}
	}, 300_000);

	it("rejects a read on a live descriptor the artifact open never returned", async () => {
		const strayPath = path.join(os.tmpdir(), `gjc-entry-fd-${Math.random().toString(36).slice(2)}`);
		await Bun.write(strayPath, "stray-bytes");
		try {
			const run = await runEntry(["sdk", "diagnostics", "broker", "--agent-dir", absentAgentDir, "--json"], {
				env: { GJC_ENTRY_TRAP_INJECT: "foreign-fd-read", GJC_ENTRY_TRAP_STRAY: strayPath },
			});
			// The descriptor read is recorded as unattributed, so the pinned assertion rejects
			// it even though the total count stays inside the artifact-derived slack.
			const unattributed = run.trap.statReads.filter(entry => entry.includes("unattributed-fd"));
			expect(unattributed.length).toBeGreaterThan(0);
			let rejected = false;
			try {
				expectInert(run, { approvedLoaderChain: true });
			} catch {
				rejected = true;
			}
			expect(rejected).toBe(true);
		} finally {
			await fs.rm(strayPath, { force: true });
		}
	}, 300_000);

	it("rejects an other-path open, a write-flag open and an extra artifact open on the real route", async () => {
		const strayPath = path.join(os.tmpdir(), `gjc-entry-stray-${Math.random().toString(36).slice(2)}`);
		await Bun.write(strayPath, "stray");
		try {
			// Annotated before the filter so each `expect` keeps its literal type instead of
			// widening to `string` through the chained call.
			const injections: { inject: string; expect: "reads" | "fsMutations"; requiresArtifact?: boolean }[] = [
				// Another path opened read-only: the exact multiset no longer matches.
				{ inject: "other-path", expect: "reads" },
				// One extra open of the approved artifact: the pinned count no longer matches.
				{ inject: "extra-open", expect: "reads", requiresArtifact: true },
				// A write-flag open: the trap classifies it as a mutation, which must stay empty.
				{ inject: "write-flags", expect: "fsMutations" },
			];
			const rows = injections.filter(row => SUPPORTED_RUNTIME || row.requiresArtifact !== true);
			// The path and write-flag negatives are platform independent and always run.
			expect(rows.map(row => row.inject).sort()).toEqual(
				SUPPORTED_RUNTIME ? ["extra-open", "other-path", "write-flags"] : ["other-path", "write-flags"],
			);
			const failures: { inject: string; reason: string }[] = [];
			for (const row of rows) {
				const run = await runEntry(["sdk", "diagnostics", "broker", "--agent-dir", absentAgentDir, "--json"], {
					env: {
						GJC_ENTRY_TRAP_INJECT: row.inject,
						// Unsupported tuples have no addon to name, so the injector targets this
						// row's real task-owned sentinel instead of a path that does not exist.
						GJC_ENTRY_TRAP_ARTIFACT: SUPPORTED_RUNTIME ? RESOLVED_ARTIFACT_PATH : strayPath,
						GJC_ENTRY_TRAP_STRAY: strayPath,
					},
				});
				// The SAME assertion the positive route uses must fail, and the ledger must show
				// the specific difference that caused it -- not merely "something threw".
				let thrownMessage: string | null = null;
				try {
					expectInert(run, { approvedLoaderChain: true });
				} catch (error) {
					thrownMessage = (error as Error).message;
				}
				if (thrownMessage === null) {
					failures.push({ inject: row.inject, reason: "pinned assertion accepted the injected ledger" });
					continue;
				}
				const approved = SUPPORTED_RUNTIME ? approvedLoaderReads() : [];
				const observed = [...run.trap.reads].sort();
				const extraOpens = observed.filter(entry => !approved.includes(entry));
				const artifactOpenCount = observed.filter(entry => entry.includes(RESOLVED_ARTIFACT_PATH)).length;
				const approvedArtifactOpens = approved.filter(entry => entry.includes(RESOLVED_ARTIFACT_PATH)).length;
				if (row.inject === "other-path") {
					// Exactly one open of a path outside the approved chain, and it names the stray.
					if (!extraOpens.some(entry => entry.includes(strayPath))) {
						failures.push({
							inject: row.inject,
							reason: `no stray-path open in the ledger: ${extraOpens.join(",")}`,
						});
					}
				} else if (row.inject === "extra-open") {
					// The approved paths are unchanged, but the artifact was opened once more.
					if (artifactOpenCount <= approvedArtifactOpens) {
						failures.push({
							inject: row.inject,
							reason: `artifact open count did not grow: ${artifactOpenCount} vs ${approvedArtifactOpens}`,
						});
					}
				} else if (run.trap.fsMutations.length === 0) {
					failures.push({ inject: row.inject, reason: "no write-flag mutation recorded" });
				} else if (!run.trap.fsMutations.some(entry => entry.includes(strayPath))) {
					failures.push({
						inject: row.inject,
						reason: `mutation ledger did not name the stray path: ${run.trap.fsMutations.join(",")}`,
					});
				}
			}
			expect(failures).toEqual([]);

			// Unmodified positive control: the same route with no injection still passes.
			const clean = await runEntry(["sdk", "diagnostics", "broker", "--agent-dir", absentAgentDir, "--json"]);
			expectInert(clean, { approvedLoaderChain: true });
		} finally {
			await fs.rm(strayPath, { force: true });
		}
	}, 300_000);

	it("resolves no agent dir and opens no files without an explicit root", async () => {
		const run = await runEntry(["sdk", "diagnostics", "broker", "--json"]);
		expect([1, 2]).toContain(run.exitCode);
		expectInert(run);
	});

	it.skipIf(process.platform !== "linux")(
		"never consults NSS for missing or ambiguous HOME (linux runner only)",
		async () => {
			for (const env of [{ HOME: "" }, { HOME: "/nonexistent-ambiguous-home" }]) {
				for (const argv of [
					["sdk", "diagnostics", "--help"],
					["sdk", "diagnostics", "broker", "--agent-dir", absentAgentDir, "--json"],
					["sdk", "diagnostics", "broker", "--bogus"],
				]) {
					const run = await runEntry(argv, { env });
					expect(run.trap.bunSpawnSync).toEqual([]);
					expect(run.trap.bunSpawn).toEqual([]);
					expectInert(run);
				}
			}
		},
	);
});

describe("ordinary entry graph is preserved (B1 controls)", () => {
	it("keeps the public family commands as one shared object", async () => {
		const wrapper = await import("../src/cli");
		const leaf = await import("../src/cli-commands");
		const ordinary = await import("../src/cli-ordinary");
		expect(wrapper.commands).toBe(leaf.commands);
		expect(ordinary.commands).toBe(leaf.commands);
		expect(wrapper.commands.map(entry => entry.name)).toEqual(["sdk", "daemon"]);
	});

	it("keeps the actual cli entry free of effectful static imports", async () => {
		const source = await Bun.file(CLI_SOURCE).text();
		expect(source).toContain('from "@gajae-code/utils/cli-metadata"');
		expect(source).not.toContain('from "@gajae-code/utils/dirs"');
		expect(source).not.toContain('from "@gajae-code/utils/logger"');
		expect(source).not.toContain('from "./sdk/broker/stderr-drainer"');
		expect(source).toContain('await import("./cli-ordinary")');
		const diagnosticsIndex = source.indexOf('argv[1] === "diagnostics"');
		expect(diagnosticsIndex).toBeGreaterThan(0);
		// The diagnostics selector is decided before the ordinary graph is even loaded.
		expect(diagnosticsIndex).toBeLessThan(source.indexOf('await import("./cli-ordinary")'));
		for (const effectfulMarker of [
			"GJC_MALLOC_ENV_REEXEC",
			"GJC_MANAGED_OWNER_CHILD_TOKEN",
			"stderr-drain-internal",
			"installRuntimeGlobals",
			"startTiming",
		]) {
			expect(source).not.toContain(effectfulMarker);
		}
		const ordinary = await Bun.file(path.join(REPO_ROOT, "packages/coding-agent/src/cli-ordinary.ts")).text();
		for (const preservedMarker of [
			"GJC_MALLOC_ENV_REEXEC",
			"GJC_MANAGED_OWNER_CHILD_TOKEN",
			'argv[1] === "stderr-drain-internal"',
			"installRuntimeGlobals",
			"startTiming",
			'await import("./cli-main")',
		]) {
			expect(ordinary).toContain(preservedMarker);
		}
	});

	it("keeps the diagnostics module free of ordinary-graph imports", async () => {
		const source = await Bun.file(
			path.join(REPO_ROOT, "packages/coding-agent/src/sdk/cli/diagnostics-cli.ts"),
		).text();
		for (const forbidden of [
			"./cli-ordinary",
			"cli-main",
			"public-command-entry",
			"session-cli",
			"managed-owner",
			"malloc-env-guard",
			"runtime-globals",
			"@gajae-code/utils/dirs",
			"@gajae-code/utils/logger",
			"lifecycle",
		]) {
			expect(source).not.toContain(`"${forbidden}`);
		}
	});

	it("still serves an ordinary non-diagnostics argv through the preserved route", async () => {
		const run = await runEntry(["--supports-macos-community-app"]);
		expect(run.exitCode).toBe(0);
		expect(run.stdout).toBe("macos-community-app-offer\n");
	});
});
