import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { appendCrashEvent, formatCrashRecordMarker } from "@gajae-code/utils";
import { crashRelayExitCode } from "../src/cli/crash-cli";
import type { CrashSignatureView, CrashStatePaths } from "../src/crash/index-store";
import { compactCrashIndex, listCrashSignatures } from "../src/crash/index-store";
import {
	CRASH_UPSTREAM_DSN_ENV,
	type CrashRelayConfig,
	type CrashRelayFetch,
	isRelayDue,
	readTrustedRelayConfig,
	relayCrashSignatures,
	resolveRelayDsn,
	type TrustedRelaySettings,
} from "../src/crash/upstream/relay";

const DSN = "https://abc123@o1.ingest.sentry.io/4511929997721600";
const FINGERPRINT = "a".repeat(32);

function config(overrides: Partial<CrashRelayConfig> = {}): CrashRelayConfig {
	return { upstream: "sentry", dsn: DSN, ...overrides };
}

function signature(overrides: Partial<CrashSignatureView> = {}): CrashSignatureView {
	return {
		fingerprint: FINGERPRINT,
		fpv: 1,
		errorName: "TypeError",
		messageClass: "cannot read properties of <redacted>",
		lifetimeCount: 3,
		retainedCount: 3,
		firstSeen: 1_700_000_000_000,
		lastSeen: 1_700_000_900_000,
		lastRecordId: "rec-1",
		...overrides,
	};
}

describe("resolveRelayDsn", () => {
	test("refuses while upstream is off, before any destination is considered", () => {
		const result = resolveRelayDsn(config({ upstream: "off" }), { [CRASH_UPSTREAM_DSN_ENV]: DSN });
		expect(result).toEqual({ ok: false, reason: "disabled" });
	});

	test("reports no-dsn when neither config nor environment supplies one", () => {
		expect(resolveRelayDsn(config({ dsn: "  " }), {})).toEqual({ ok: false, reason: "no-dsn" });
	});

	test("falls back to the environment only when config is empty", () => {
		const result = resolveRelayDsn(config({ dsn: "" }), { [CRASH_UPSTREAM_DSN_ENV]: DSN });
		expect(result.ok).toBe(true);
		if (result.ok) expect(result.dsn.projectId).toBe("4511929997721600");
	});

	test("configured dsn wins over a machine-wide environment export", () => {
		const result = resolveRelayDsn(config(), {
			[CRASH_UPSTREAM_DSN_ENV]: "https://zzz@other.example.com/999",
		});
		expect(result.ok).toBe(true);
		if (result.ok) expect(result.dsn.projectId).toBe("4511929997721600");
	});

	test("rejects a malformed dsn rather than treating it as unset", () => {
		expect(resolveRelayDsn(config({ dsn: "ftp://k@h/1" }), {})).toEqual({ ok: false, reason: "invalid-dsn" });
	});
});

describe("isRelayDue", () => {
	test("a never-relayed signature is due", () => {
		expect(isRelayDue(signature())).toBe(true);
	});

	test("a signature relayed for its latest record is not due", () => {
		expect(isRelayDue(signature({ relayedRecordId: "rec-1" }))).toBe(false);
	});

	test("a same-millisecond or backdated newer record remains due", () => {
		expect(isRelayDue(signature({ relayedAt: 1_700_000_900_000, relayedRecordId: "other-record" }))).toBe(true);
	});
});

describe("readTrustedRelayConfig", () => {
	/**
	 * The whole opt-in claim rests on this: `Settings.get` merges project `.gjc`
	 * configuration, so reading through it would let opening a repository enable
	 * the relay and choose its destination.
	 */
	function settingsDouble(
		global: Partial<Record<string, unknown>>,
		merged: Partial<Record<string, unknown>>,
	): TrustedRelaySettings & { get(path: string): unknown } {
		return {
			getGlobal: path => global[path],
			get: path => merged[path],
		};
	}

	test("project configuration cannot enable the relay", () => {
		const settings = settingsDouble({}, { "crashReport.upstream": "sentry", "crashReport.upstreamDsn": DSN });
		expect(readTrustedRelayConfig(settings)).toEqual({ upstream: "off", dsn: "" });
	});

	test("project configuration cannot redirect an already-enabled relay", () => {
		const settings = settingsDouble(
			{ "crashReport.upstream": "sentry", "crashReport.upstreamDsn": DSN },
			{ "crashReport.upstreamDsn": "https://evil@attacker.example.com/9" },
		);
		expect(readTrustedRelayConfig(settings).dsn).toBe(DSN);
	});

	test("an unset global value lands on off rather than a schema default", () => {
		expect(readTrustedRelayConfig(settingsDouble({}, {}))).toEqual({ upstream: "off", dsn: "" });
	});

	test("a malformed hand-edited global value fails closed", () => {
		expect(
			readTrustedRelayConfig(
				settingsDouble({ "crashReport.upstream": "SENTRY", "crashReport.upstreamDsn": 42 }, {}),
			),
		).toEqual({ upstream: "off", dsn: "" });
	});
});

describe("crash relay exit mapping", () => {
	test("refused and failed loud relay batches exit non-zero", () => {
		expect(crashRelayExitCode({ status: "ran", sent: 1, refused: 1, failed: 0 })).toBe(1);
		expect(crashRelayExitCode({ status: "ran", sent: 1, refused: 0, failed: 1 })).toBe(1);
		expect(crashRelayExitCode({ status: "ran", sent: 1, refused: 0, failed: 0 })).toBe(0);
	});
});

describe("relayCrashSignatures", () => {
	let dir = "";
	let paths: CrashStatePaths;

	const RECORD_ID = "0123456789abcdef";
	const STACK = "    at readFile (packages/coding-agent/src/tools/read.ts:12:9)";

	/** Seed one journaled occurrence plus the crash-log record it points at. */
	async function seed(overrides: { at?: number; fingerprint?: string; recordId?: string } = {}): Promise<void> {
		const fingerprint = overrides.fingerprint ?? FINGERPRINT;
		const recordId = overrides.recordId ?? RECORD_ID;
		appendCrashEvent(
			{
				kind: "occurrence",
				fingerprint,
				fpv: 1,
				recordId,
				at: overrides.at ?? 1_700_000_900_000,
				errorName: "TypeError",
				messageClass: "cannot read properties of <redacted>",
			},
			paths.events,
		);
		await fs.appendFile(
			paths.crashLog,
			`2026-08-11T11:59:59.000Z pid=4242 [Uncaught Exception] TypeError: cannot read properties of <redacted>\n` +
				`${STACK}\n${formatCrashRecordMarker(fingerprint, 1, recordId)}\n\n`,
		);
	}

	function accept(seen: string[]): CrashRelayFetch {
		return async (_url, init) => {
			seen.push(String(init.body));
			return new Response(JSON.stringify({ id: "a".repeat(32) }), { status: 200 });
		};
	}

	beforeEach(async () => {
		dir = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-relay-"));
		paths = {
			index: path.join(dir, "gjc-crash-index.json"),
			events: path.join(dir, "gjc-crash-events.jsonl"),
			crashLog: path.join(dir, "gjc-crash.log"),
		};
	});

	afterEach(async () => {
		await fs.rm(dir, { recursive: true, force: true });
	});

	test("performs no network call and no state read while upstream is off", async () => {
		let called = 0;
		const outcome = await relayCrashSignatures({
			config: config({ upstream: "off" }),
			paths,
			env: {},
			fetchImpl: async () => {
				called++;
				return new Response("", { status: 200 });
			},
		});
		expect(outcome).toEqual({ status: "skipped", reason: "disabled" });
		expect(called).toBe(0);
		// The gate must precede compaction: no index file may have been created.
		expect(await Bun.file(paths.index).exists()).toBe(false);
	});

	test("does not reach the network when no dsn is configured", async () => {
		let called = 0;
		const outcome = await relayCrashSignatures({
			config: config({ dsn: "" }),
			paths,
			env: {},
			fetchImpl: async () => {
				called++;
				return new Response("", { status: 200 });
			},
		});
		expect(outcome).toEqual({ status: "skipped", reason: "no-dsn" });
		expect(called).toBe(0);
	});

	test("reports nothing-to-relay when there are no journaled signatures", async () => {
		const outcome = await relayCrashSignatures({
			config: config(),
			paths,
			env: {},
			fetchImpl: async () => new Response("", { status: 200 }),
		});
		expect(outcome).toEqual({ status: "skipped", reason: "nothing-to-relay" });
	});

	test("posts one envelope per due signature and stamps it relayed", async () => {
		await seed();
		const bodies: string[] = [];
		const outcome = await relayCrashSignatures({
			config: config(),
			paths,
			env: {},
			fetchImpl: accept(bodies),
		});
		expect(outcome).toEqual({ status: "ran", sent: 1, refused: 0, failed: 0 });
		expect(bodies).toHaveLength(1);

		const index = await compactCrashIndex({ paths });
		expect(listCrashSignatures(index)[0]?.relayedAt).toBe(1_700_000_900_000);
		expect(listCrashSignatures(index)[0]?.relayedRecordId).toBe(RECORD_ID);
	});

	test("a rerun with no new occurrences sends nothing", async () => {
		await seed();
		const bodies: string[] = [];
		await relayCrashSignatures({ config: config(), paths, env: {}, fetchImpl: accept(bodies) });
		const second = await relayCrashSignatures({ config: config(), paths, env: {}, fetchImpl: accept(bodies) });
		expect(second).toEqual({ status: "skipped", reason: "nothing-to-relay" });
		expect(bodies).toHaveLength(1);
	});

	test("an occurrence newer than the relayed watermark makes the signature due again", async () => {
		await seed();
		const bodies: string[] = [];
		await relayCrashSignatures({ config: config(), paths, env: {}, fetchImpl: accept(bodies) });
		// This is the race the watermark stamp exists for: a crash that landed after
		// the snapshot must not be swallowed by the previous stamp.
		await seed({ at: 1_700_000_999_000, recordId: "fedcba9876543210" });
		const second = await relayCrashSignatures({ config: config(), paths, env: {}, fetchImpl: accept(bodies) });
		expect(second).toEqual({ status: "ran", sent: 1, refused: 0, failed: 0 });
		expect(bodies).toHaveLength(2);
	});

	test("an occurrence appended during the POST remains due after the accepted envelope is stamped", async () => {
		await seed();
		const bodies: string[] = [];
		const outcome = await relayCrashSignatures({
			config: config(),
			paths,
			env: {},
			fetchImpl: async (_url, init) => {
				bodies.push(String(init.body));
				await seed({ at: 1_700_000_999_000, recordId: "fedcba9876543210" });
				return new Response("", { status: 200 });
			},
		});
		expect(outcome).toEqual({ status: "ran", sent: 1, refused: 0, failed: 0 });
		const index = await compactCrashIndex({ paths });
		const relayed = listCrashSignatures(index)[0];
		expect(relayed?.relayedAt).toBe(1_700_000_900_000);
		expect(relayed && isRelayDue(relayed)).toBe(true);
	});

	test("concurrent relays claim a signature before either can POST it", async () => {
		await seed();
		const bodies: string[] = [];
		const postStarted = Promise.withResolvers<void>();
		const postReleased = Promise.withResolvers<void>();
		const fetchImpl: CrashRelayFetch = async (_url, init) => {
			bodies.push(String(init.body));
			postStarted.resolve();
			await postReleased.promise;
			return new Response("", { status: 200 });
		};
		const first = relayCrashSignatures({ config: config(), paths, env: {}, fetchImpl });
		await postStarted.promise;
		const second = await relayCrashSignatures({ config: config(), paths, env: {}, fetchImpl });
		postReleased.resolve();
		const firstOutcome = await first;
		expect(firstOutcome).toEqual({ status: "ran", sent: 1, refused: 0, failed: 0 });
		expect(second).toEqual({ status: "ran", sent: 0, refused: 0, failed: 0 });
		expect(bodies).toHaveLength(1);
	});

	test("a non-2xx response counts as failed and leaves the signature due", async () => {
		await seed();
		const outcome = await relayCrashSignatures({
			config: config(),
			paths,
			env: {},
			fetchImpl: async () => new Response("nope", { status: 429 }),
		});
		expect(outcome).toEqual({ status: "ran", sent: 0, refused: 0, failed: 1 });
		const index = await compactCrashIndex({ paths });
		expect(listCrashSignatures(index)[0]?.relayedAt).toBeUndefined();
	});

	test("a transport rejection is contained and never escapes as a throw", async () => {
		await seed();
		const outcome = await relayCrashSignatures({
			config: config(),
			paths,
			env: {},
			fetchImpl: async () => {
				throw new Error("offline");
			},
		});
		expect(outcome).toEqual({ status: "ran", sent: 0, refused: 0, failed: 1 });
	});

	test.each([307, 308])("refuses %i redirects without issuing a follow-up request", async status => {
		await seed();
		let requests = 0;
		const outcome = await relayCrashSignatures({
			config: config(),
			paths,
			env: {},
			fetchImpl: async (_url, init) => {
				requests++;
				expect(init.redirect).toBe("error");
				expect(init.credentials).toBe("omit");
				return new Response("", { status, headers: { Location: "https://attacker.invalid/envelope" } });
			},
		});
		expect(outcome).toEqual({ status: "ran", sent: 0, refused: 0, failed: 1 });
		expect(requests).toBe(1);
	});

	test("retries a failed post after releasing its claim", async () => {
		await seed();
		let requests = 0;
		const fetchImpl: CrashRelayFetch = async () => {
			requests++;
			return new Response("", { status: requests === 1 ? 429 : 200 });
		};
		expect(await relayCrashSignatures({ config: config(), paths, env: {}, fetchImpl })).toEqual({
			status: "ran",
			sent: 0,
			refused: 0,
			failed: 1,
		});
		expect(await relayCrashSignatures({ config: config(), paths, env: {}, fetchImpl })).toEqual({
			status: "ran",
			sent: 1,
			refused: 0,
			failed: 0,
		});
		expect(requests).toBe(2);
	});

	test("a signature with no recoverable record is refused, not sent", async () => {
		// Journal the occurrence but never write the crash-log record it names.
		appendCrashEvent(
			{
				kind: "occurrence",
				fingerprint: FINGERPRINT,
				fpv: 1,
				recordId: RECORD_ID,
				at: 1_700_000_900_000,
				errorName: "TypeError",
				messageClass: "cannot read properties of <redacted>",
			},
			paths.events,
		);
		await fs.writeFile(paths.crashLog, "unrelated log content\n");
		let called = 0;
		const outcome = await relayCrashSignatures({
			config: config(),
			paths,
			env: {},
			fetchImpl: async () => {
				called++;
				return new Response("", { status: 200 });
			},
		});
		expect(outcome).toEqual({ status: "ran", sent: 0, refused: 1, failed: 0 });
		expect(called).toBe(0);
	});

	test("never sends more than the per-run cap", async () => {
		for (let i = 0; i < 4; i++)
			await seed({ fingerprint: `${i}`.repeat(32), recordId: `${i}`.repeat(16), at: 1_700_000_900_000 + i });
		const bodies: string[] = [];
		const outcome = await relayCrashSignatures({
			config: config(),
			paths,
			env: {},
			maxPerRun: 2,
			fetchImpl: accept(bodies),
		});
		expect(outcome).toEqual({ status: "ran", sent: 2, refused: 0, failed: 0 });
		expect(bodies).toHaveLength(2);
	});

	test("the emitted envelope carries no timestamp finer than a day", async () => {
		await seed();
		const bodies: string[] = [];
		await relayCrashSignatures({ config: config(), paths, env: {}, fetchImpl: accept(bodies) });
		const payload = JSON.parse(bodies[0]?.split("\n")[2] ?? "{}") as { timestamp: number };
		expect(payload.timestamp % 86_400).toBe(0);
	});
});

/**
 * The relay's trust boundary is enforced at module import: `$credentialEnv`
 * excludes the checkout's `.env` overlay, and the default state root is the
 * agent dir rather than anything `XDG_STATE_HOME` can move. Both properties are
 * therefore only observable in a fresh process whose cwd/environment is the
 * hostile one, so these regressions spawn one (review: snowykr P1 #2/#3).
 */
describe("relay trust boundary against a hostile checkout", () => {
	let dir = "";

	beforeEach(async () => {
		dir = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-relay-trust-"));
	});

	afterEach(async () => {
		await fs.rm(dir, { recursive: true, force: true });
	});

	async function runInCheckout(source: string, env: Record<string, string> = {}): Promise<string> {
		const script = path.join(dir, "probe.ts");
		await Bun.write(script, source);
		const child = Bun.spawn(["bun", script], {
			cwd: dir,
			env: { ...Bun.env, ...env },
			stdout: "pipe",
			stderr: "pipe",
		});
		const [stdout, stderr, exitCode] = await Promise.all([
			new Response(child.stdout).text(),
			new Response(child.stderr).text(),
			child.exited,
		]);
		if (exitCode !== 0) throw new Error(`probe failed (${exitCode}): ${stderr}`);
		return stdout.trim();
	}

	test("a DSN present only in the checkout's .env cannot select the relay destination", async () => {
		const hostile = "https://attacker@evil.example/999";
		await Bun.write(path.join(dir, ".env"), `${CRASH_UPSTREAM_DSN_ENV}=${hostile}\n`);
		const resolverPath = path.resolve(import.meta.dir, "../src/crash/upstream/relay.ts");
		const out = await runInCheckout(
			`import { resolveRelayDsn } from ${JSON.stringify(resolverPath)};\n` +
				`const r = resolveRelayDsn({ upstream: "sentry", dsn: "" });\n` +
				`console.log(JSON.stringify(r.ok ? { ok: true, host: r.dsn.envelopeUrl } : r));\n`,
		);
		const result = JSON.parse(out);
		expect(result.ok).toBe(false);
		expect(result.reason).toBe("no-dsn");
		expect(out).not.toContain("evil.example");
	});

	test("a project-controlled XDG_STATE_HOME cannot move the relay's state root", async () => {
		const hostileState = path.join(dir, "hostile-state");
		await fs.mkdir(hostileState, { recursive: true });
		const dirsPath = path.resolve(import.meta.dir, "../../utils/src/dirs.ts");
		const storePath = path.resolve(import.meta.dir, "../src/crash/index-store.ts");
		const out = await runInCheckout(
			`import { getAgentDir } from ${JSON.stringify(dirsPath)};\n` +
				`import { resolveCrashStatePaths } from ${JSON.stringify(storePath)};\n` +
				`const paths = resolveCrashStatePaths(getAgentDir());\n` +
				`console.log(JSON.stringify(paths));\n`,
			{ XDG_STATE_HOME: hostileState },
		);
		const paths = JSON.parse(out);
		for (const key of ["index", "events", "crashLog"]) {
			expect(typeof paths[key]).toBe("string");
			expect(paths[key].startsWith(hostileState)).toBe(false);
		}
	});
});
