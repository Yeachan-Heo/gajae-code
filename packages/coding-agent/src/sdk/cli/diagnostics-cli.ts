/** Isolated `gjc sdk diagnostics` parser and renderer.
 *
 * Reached from the inert entry before any effectful branch, so this module must
 * stay a pure leaf: no command registry, session CLI, runtime globals, managed
 * owner admission, malloc guard, evidence publisher, broker client, directory
 * resolver or logger import. Help and usage never resolve a root or open a file,
 * and every outcome is a fixed bounded string with a fixed exit code.
 *
 * Observation itself must never start, ensure, retire, restart or recover a
 * broker. The read-only observation facade (DESIGN §B3) is wired: `observe()`
 * below routes to it and to nothing else, so this command can report only what a
 * supporting broker publishes to the read-only reader. An unsupported runtime
 * tuple, a missing or mismatched native artifact and an old broker without a
 * published generation all still fail closed with the fixed `unsupported`
 * outcome.
 */

const USAGE_FAMILY = `usage: gjc sdk diagnostics <command>

Read-only broker observation. Never starts, ensures, retires, restarts or
recovers a broker, and never spawns a host.

commands:
  broker    Observe an already running broker publication.

flags:
  -h, --help    Show this help.
`;

const USAGE_BROKER = `usage: gjc sdk diagnostics broker [--agent-dir <dir>] [--expected-generation <id>] [--timeout-ms <ms>] [--json]

Observe an already running broker publication without starting, ensuring,
retiring, restarting or recovering it.

flags:
      --agent-dir <dir>            Absolute agent directory holding the broker publication.
      --expected-generation <id>   Require this exact publication generation (32 hex characters).
      --timeout-ms <ms>            Overall observation deadline, 1-10000 (default 2000).
      --json                       Emit the observation document as JSON.
  -h, --help                       Show this help.
`;

/** Fixed messages keyed by reason; never exception text, never a path. */
const UNAVAILABLE_MESSAGES = {
	absent: "No broker publication was found for the selected agent directory.",
	stale: "The broker publication is stale.",
	incompatible: "The broker uses an unsupported diagnostic protocol.",
	authentication_failed: "The broker refused the diagnostic authentication.",
	unsupported: "Read-only broker observation is not supported by this runtime or build.",
	generation_mismatch: "The observed broker publication is a different incarnation.",
	transport_unavailable: "The broker diagnostic transport is unavailable.",
	timeout: "The broker observation deadline expired.",
	invalid_response: "The broker returned an invalid diagnostic response.",
	unsafe_discovery: "The broker publication path failed read-only safety validation.",
} as const;

type UnavailableReason = keyof typeof UNAVAILABLE_MESSAGES;

type BrokerObservation =
	| {
			schema: "gjc.broker-observation";
			version: 1;
			ok: false;
			observedAt: string;
			unavailable: { reason: UnavailableReason; message: string };
	  }
	| {
			schema: "gjc.broker-observation";
			version: 1;
			ok: true;
			observedAt: string;
			broker: {
				generation: string;
				build: { packageVersion: string; buildId: string | null };
				diagnosticProtocol: 1;
			};
	  };

const MAX_ARGV_BYTES = 8192;
const MAX_PATH_BYTES = 4096;
const MAX_PATH_COMPONENTS = 128;
const DEFAULT_TIMEOUT_MS = 2000;
const MIN_TIMEOUT_MS = 1;
const MAX_TIMEOUT_MS = 10000;

type Parsed =
	| { kind: "help"; text: string }
	| { kind: "usage" }
	| {
			kind: "observe";
			agentDir: string | undefined;
			expectedGeneration: string | undefined;
			timeoutMs: number;
			json: boolean;
	  };

function isHelpToken(token: string): boolean {
	return token === "--help" || token === "-h";
}

function validAgentDir(value: string): boolean {
	if (value.length === 0 || value.includes("\0")) return false;
	if (!value.startsWith("/")) return false;
	if (Buffer.byteLength(value, "utf8") > MAX_PATH_BYTES) return false;
	return value.split("/").length <= MAX_PATH_COMPONENTS;
}

function validGeneration(value: string): boolean {
	return /^[0-9a-f]{32}$/.test(value);
}

function parseTimeout(value: string): number | undefined {
	if (!/^[0-9]{1,5}$/.test(value)) return undefined;
	const parsed = Number.parseInt(value, 10);
	if (parsed < MIN_TIMEOUT_MS || parsed > MAX_TIMEOUT_MS) return undefined;
	return parsed;
}

function parse(argv: readonly string[]): Parsed {
	let argvBytes = 0;
	for (const token of argv) argvBytes += Buffer.byteLength(token, "utf8") + 1;
	if (argvBytes > MAX_ARGV_BYTES) return { kind: "usage" };
	if (argv.length === 0) return { kind: "usage" };
	if (isHelpToken(argv[0]!)) {
		// Family help is the whole invocation or nothing: a trailing operand, a second
		// help token or a subcommand after it is a usage error, never a rendered help.
		return argv.length === 1 ? { kind: "help", text: USAGE_FAMILY } : { kind: "usage" };
	}
	if (argv[0] !== "broker") return { kind: "usage" };

	let agentDir: string | undefined;
	let expectedGeneration: string | undefined;
	let timeoutMs: number | undefined;
	let json = false;
	// A help request never short-circuits validation: the remaining argv is checked
	// first, so an unknown flag, a private marker, a trailing operand or a duplicate
	// selector next to `--help` still terminates with the fixed usage error.
	let helpRequested = false;
	for (let index = 1; index < argv.length; index += 1) {
		const token = argv[index]!;
		if (isHelpToken(token)) {
			if (helpRequested) return { kind: "usage" };
			helpRequested = true;
			continue;
		}
		if (token === "--json") {
			if (json) return { kind: "usage" };
			json = true;
			continue;
		}
		if (token === "--agent-dir" || token === "--expected-generation" || token === "--timeout-ms") {
			const value = argv[index + 1];
			if (value === undefined) return { kind: "usage" };
			index += 1;
			if (token === "--agent-dir") {
				if (agentDir !== undefined || !validAgentDir(value)) return { kind: "usage" };
				agentDir = value;
				continue;
			}
			if (token === "--expected-generation") {
				if (expectedGeneration !== undefined || !validGeneration(value)) return { kind: "usage" };
				expectedGeneration = value;
				continue;
			}
			if (timeoutMs !== undefined) return { kind: "usage" };
			const parsed = parseTimeout(value);
			if (parsed === undefined) return { kind: "usage" };
			timeoutMs = parsed;
			continue;
		}
		return { kind: "usage" };
	}
	if (helpRequested) return { kind: "help", text: USAGE_BROKER };
	return { kind: "observe", agentDir, expectedGeneration, timeoutMs: timeoutMs ?? DEFAULT_TIMEOUT_MS, json };
}

function unavailable(reason: UnavailableReason): BrokerObservation {
	return {
		schema: "gjc.broker-observation",
		version: 1,
		ok: false,
		observedAt: new Date().toISOString(),
		unavailable: { reason, message: UNAVAILABLE_MESSAGES[reason] },
	};
}

function renderText(observation: BrokerObservation): string {
	if (observation.ok) {
		return [
			"broker observation: ok",
			`generation: ${observation.broker.generation}`,
			`package version: ${observation.broker.build.packageVersion}`,
			`build id: ${observation.broker.build.buildId ?? "unknown"}`,
			`diagnostic protocol: ${observation.broker.diagnosticProtocol}`,
			"",
		].join("\n");
	}
	return `broker observation: unavailable (${observation.unavailable.reason})\n${observation.unavailable.message}\n`;
}

/**
 * Observe an already running broker.
 *
 * The read-only observation reader (narrow native snapshot adapter + read-only
 * loader) is part of this build, so a valid explicit agent directory reaches the
 * facade. A missing `--agent-dir` still returns the fixed `absent` outcome
 * without opening a path, creating a socket or writing any state: exact
 * selection never authorizes an alternative-root scan.
 */
async function observe(options: {
	agentDir: string | undefined;
	expectedGeneration: string | undefined;
	timeoutMs: number;
}): Promise<BrokerObservation> {
	if (options.agentDir === undefined) return unavailable("absent");
	// Exactly one route: the observation facade. No other broker operation is reachable
	// from here, and nothing on this path ensures, starts, recovers or retires a broker.
	const { observeExistingBroker } = await import("../diagnostics/observe-broker");
	return (await observeExistingBroker({
		agentDir: options.agentDir,
		expectedGeneration: options.expectedGeneration,
		timeoutMs: options.timeoutMs,
	})) as BrokerObservation;
}

/** Run `gjc sdk diagnostics <argv…>`; argv excludes the `sdk diagnostics` prefix. */
export async function runDiagnosticsCli(argv: readonly string[]): Promise<void> {
	let parsed: Parsed;
	try {
		parsed = parse(argv);
	} catch {
		parsed = { kind: "usage" };
	}
	if (parsed.kind === "help") {
		process.stdout.write(parsed.text);
		return;
	}
	if (parsed.kind === "usage") {
		process.stderr.write(USAGE_FAMILY);
		process.exitCode = 2;
		return;
	}
	const observation = await observe(parsed);
	process.stdout.write(parsed.json ? `${JSON.stringify(observation)}\n` : renderText(observation));
	// An observed result exits 0; a typed unavailability exits 1.
	process.exitCode = observation.ok ? 0 : 1;
}
