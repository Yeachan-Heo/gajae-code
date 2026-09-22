import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	appendCrashEvent,
	computeCrashFingerprint,
	computeHandledErrorFingerprint,
	formatCrashRecordMarker,
} from "@gajae-code/utils";
import { crashRelayExitCode } from "../src/cli/crash-cli";
import type { CrashSignatureView, CrashStatePaths } from "../src/crash/index-store";
import { compactCrashIndex, listCrashSignatures, readCrashIndex } from "../src/crash/index-store";
import {
	CRASH_UPSTREAM_DSN_ENV,
	type CrashRelayConfig,
	type CrashRelayFetch,
	isRelayDue,
	readTrustedRelayConfig,
	relayAllSignatures,
	relayCrashSignatures,
	resolveRelayDsn,
	type TrustedRelaySettings,
} from "../src/crash/upstream/relay";

const DSN = "https://abc123@o1.ingest.sentry.io/4511929997721600";
const STACK = "    at readFile (packages/coding-agent/src/tools/read.ts:12:9)";
const FINGERPRINT = computeCrashFingerprint({
	name: "TypeError",
	message: "cannot read properties of <redacted>",
	stack: STACK,
}).fingerprint;

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
		lastAppendRecordId: "rec-1",
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

	test("a signature relayed for its latest append is not due", () => {
		expect(isRelayDue(signature({ relayedRecordId: "rec-1" }))).toBe(false);
	});

	test("a refusal marker suppresses only the same record and contract", () => {
		expect(
			isRelayDue(
				signature({
					relayRefusedRecordId: "rec-1",
					relayRefusedVersion: "sanitize-external-crash-v1",
				}),
			),
		).toBe(false);
		expect(
			isRelayDue(signature({ relayRefusedRecordId: "rec-2", relayRefusedVersion: "sanitize-external-crash-v1" })),
		).toBe(true);
		expect(
			isRelayDue(signature({ relayRefusedRecordId: "rec-1", relayRefusedVersion: "sanitize-external-crash-v2" })),
		).toBe(true);
	});

	test("a same-millisecond or backdated newer record remains due", () => {
		expect(
			isRelayDue(
				signature({
					relayedAt: 1_700_000_900_000,
					relayedRecordId: "other-record",
					lastAppendRecordId: "rec-2",
				}),
			),
		).toBe(true);
	});

	test("a legacy relayedAt covering lastSeen is not due after upgrade", () => {
		expect(isRelayDue(signature({ lastAppendRecordId: undefined, relayedAt: 1_700_000_900_000 }))).toBe(false);
	});

	test("a legacy relayedAt older than lastSeen is due after upgrade", () => {
		expect(isRelayDue(signature({ relayedAt: 1_700_000_000_000 }))).toBe(true);
	});

	test("a downgrade that advanced relayedAt does not retransmit on re-upgrade", () => {
		expect(
			isRelayDue(
				signature({
					lastRecordId: "rec-2",
					lastAppendRecordId: undefined,
					relayedRecordId: "rec-1",
					relayedAt: 1_700_000_900_000,
				}),
			),
		).toBe(false);
	});

	test("a backdated append after a modern send stays due even when relayedAt covers lastSeen", () => {
		expect(
			isRelayDue(
				signature({
					lastRecordId: "rec-1",
					lastAppendRecordId: "rec-2",
					relayedRecordId: "rec-1",
					relayedAt: 1_700_000_900_000,
				}),
			),
		).toBe(true);
	});

	test("an equal-time append after a modern send stays due by record identity", () => {
		expect(
			isRelayDue(
				signature({
					lastRecordId: "rec-2",
					lastAppendRecordId: "rec-2",
					relayedRecordId: "rec-1",
					relayedAt: 1_700_000_900_000,
				}),
			),
		).toBe(true);
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

	/** Seed one journaled occurrence plus the crash-log record it points at. */
	async function seed(overrides: { at?: number; fingerprint?: string; recordId?: string } = {}): Promise<void> {
		const markerHint = overrides.fingerprint
			? ({
					["a".repeat(32)]: "alpha",
					["b".repeat(32)]: "bravo",
					["c".repeat(32)]: "charlie",
				}[overrides.fingerprint] ?? "variant")
			: undefined;
		const messageClass = overrides.fingerprint
			? `cannot read properties of <redacted> (${markerHint})`
			: "cannot read properties of <redacted>";
		const fingerprint = overrides.fingerprint
			? computeCrashFingerprint({ name: "TypeError", message: messageClass, stack: STACK }).fingerprint
			: FINGERPRINT;
		const recordId = overrides.recordId ?? RECORD_ID;
		appendCrashEvent(
			{
				kind: "occurrence",
				fingerprint,
				fpv: 1,
				recordId,
				at: overrides.at ?? 1_700_000_900_000,
				errorName: "TypeError",
				messageClass,
			},
			paths.events,
		);
		await fs.appendFile(
			paths.crashLog,
			`2026-08-11T11:59:59.000Z pid=4242 [Uncaught Exception] TypeError: ${messageClass}\n` +
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

	test("persistent refusals do not starve a newer safe signature", async () => {
		for (let i = 0; i < 8; i++) {
			const recordId = (i + 1).toString(16).padStart(16, "0");
			const messageClass = `cannot read properties of <redacted> (missing-${i})`;
			const fingerprint = computeCrashFingerprint({
				name: "TypeError",
				message: messageClass,
				stack: STACK,
			}).fingerprint;
			appendCrashEvent(
				{
					kind: "occurrence",
					fingerprint,
					fpv: 1,
					recordId,
					at: 1_700_000_000_000 + i,
					errorName: "TypeError",
					messageClass,
				},
				paths.events,
			);
		}
		const safeMessage = "cannot read properties of <redacted> (safe-new)";
		const safeFingerprint = computeCrashFingerprint({
			name: "TypeError",
			message: safeMessage,
			stack: STACK,
		}).fingerprint;
		const safeRecordId = "0000000000000010";
		appendCrashEvent(
			{
				kind: "occurrence",
				fingerprint: safeFingerprint,
				fpv: 1,
				recordId: safeRecordId,
				at: 1_700_000_000_100,
				errorName: "TypeError",
				messageClass: safeMessage,
			},
			paths.events,
		);
		await fs.appendFile(
			paths.crashLog,
			`2026-08-11T11:59:59.000Z pid=4242 [Uncaught Exception] TypeError: ${safeMessage}\n` +
				`${STACK}\n${formatCrashRecordMarker(safeFingerprint, 1, safeRecordId)}\n\n`,
		);

		const firstBodies: string[] = [];
		const first = await relayCrashSignatures({
			config: config(),
			paths,
			env: {},
			maxPerRun: 8,
			fetchImpl: accept(firstBodies),
		});
		expect(first).toEqual({ status: "ran", sent: 0, refused: 8, failed: 0 });
		expect(firstBodies).toHaveLength(0);

		const secondBodies: string[] = [];
		const second = await relayCrashSignatures({
			config: config(),
			paths,
			env: {},
			maxPerRun: 8,
			fetchImpl: accept(secondBodies),
		});
		expect(second).toEqual({ status: "ran", sent: 1, refused: 0, failed: 0 });
		expect(secondBodies).toHaveLength(1);
	});

	test("a refusal retries when the represented record id changes", async () => {
		const firstRecordId = "1111111111111111";
		await fs.writeFile(paths.crashLog, "unrelated crash text\n");
		appendCrashEvent(
			{
				kind: "occurrence",
				fingerprint: FINGERPRINT,
				fpv: 1,
				recordId: firstRecordId,
				at: 1_700_000_900_000,
				errorName: "TypeError",
				messageClass: "cannot read properties of <redacted>",
			},
			paths.events,
		);
		const firstBodies: string[] = [];
		const first = await relayCrashSignatures({ config: config(), paths, env: {}, fetchImpl: accept(firstBodies) });
		expect(first).toEqual({ status: "ran", sent: 0, refused: 1, failed: 0 });

		const secondRecordId = "2222222222222222";
		appendCrashEvent(
			{
				kind: "occurrence",
				fingerprint: FINGERPRINT,
				fpv: 1,
				recordId: secondRecordId,
				at: 1_700_000_900_001,
				errorName: "TypeError",
				messageClass: "cannot read properties of <redacted>",
			},
			paths.events,
		);
		await fs.appendFile(
			paths.crashLog,
			`2026-08-11T11:59:59.000Z pid=4242 [Uncaught Exception] TypeError: cannot read properties of <redacted>\n` +
				`${STACK}\n${formatCrashRecordMarker(FINGERPRINT, 1, secondRecordId)}\n\n`,
		);
		const secondBodies: string[] = [];
		const second = await relayCrashSignatures({ config: config(), paths, env: {}, fetchImpl: accept(secondBodies) });
		expect(second).toEqual({ status: "ran", sent: 1, refused: 0, failed: 0 });
		expect(secondBodies).toHaveLength(1);
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

	test("persists an exact-cap refusal across restart and relays a newer occurrence", async () => {
		await seed();
		const compacted = await compactCrashIndex({ paths });
		const entry = compacted.signatures[FINGERPRINT];
		expect(entry).toBeDefined();
		if (!entry) return;
		const { lastAppendRecordId: _ignored, ...legacy } = entry;
		await Bun.write(
			paths.index,
			`${JSON.stringify({
				...compacted,
				signatures: {
					[FINGERPRINT]: {
						...legacy,
						messageClass: "x".repeat(200),
						reportedAt: entry.lastSeen,
						reportedIssueUrl: `https://github.com/example/issues/${"r".repeat(180)}`,
						commentedIssues: [`https://github.com/example/issues/${"c".repeat(180)}`],
					},
				},
			})}\n`,
		);
		await fs.writeFile(paths.crashLog, "unrelated crash text\n");
		const refused = await relayCrashSignatures({ config: config(), paths, env: {}, fetchImpl: accept([]) });
		expect(refused).toEqual({ status: "ran", sent: 0, refused: 1, failed: 0 });
		const restarted = await relayCrashSignatures({ config: config(), paths, env: {}, fetchImpl: accept([]) });
		expect(restarted).toEqual({ status: "skipped", reason: "nothing-to-relay" });

		const newerRecordId = "2222222222222222";
		appendCrashEvent(
			{
				kind: "occurrence",
				fingerprint: FINGERPRINT,
				fpv: 1,
				recordId: newerRecordId,
				at: 1_700_000_900_001,
				errorName: "TypeError",
				messageClass: "cannot read properties of <redacted>",
			},
			paths.events,
		);
		await fs.appendFile(
			paths.crashLog,
			`2026-08-11T11:59:59.000Z pid=4242 [Uncaught Exception] TypeError: cannot read properties of <redacted>\n` +
				`${STACK}\n${formatCrashRecordMarker(FINGERPRINT, 1, newerRecordId)}\n\n`,
		);
		const bodies: string[] = [];
		const relayed = await relayCrashSignatures({ config: config(), paths, env: {}, fetchImpl: accept(bodies) });
		expect(relayed).toEqual({ status: "ran", sent: 1, refused: 0, failed: 0 });
		expect(bodies).toHaveLength(1);
	});

	test("a legacy relayedAt covering lastSeen does not retransmit after upgrade", async () => {
		await seed();
		const compacted = await compactCrashIndex({ paths });
		const entry = compacted.signatures[FINGERPRINT];
		expect(entry).toBeDefined();
		if (!entry) return;
		const { lastAppendRecordId: _ignored, ...legacy } = entry;
		await Bun.write(
			paths.index,
			`${JSON.stringify({
				...compacted,
				signatures: { [FINGERPRINT]: { ...legacy, relayedAt: entry.lastSeen } },
			})}\n`,
		);
		const bodies: string[] = [];
		const outcome = await relayCrashSignatures({ config: config(), paths, env: {}, fetchImpl: accept(bodies) });
		expect(outcome).toEqual({ status: "skipped", reason: "nothing-to-relay" });
		expect(bodies).toHaveLength(0);
	});

	test("a backdated append after legacy upgrade remains due", async () => {
		await seed();
		const compacted = await compactCrashIndex({ paths });
		const entry = compacted.signatures[FINGERPRINT];
		expect(entry).toBeDefined();
		if (!entry) return;
		const { lastAppendRecordId: _append, relayedRecordId: _relayed, ...legacy } = entry;
		await Bun.write(
			paths.index,
			`${JSON.stringify({
				...compacted,
				signatures: { [FINGERPRINT]: { ...legacy, relayedAt: entry.lastSeen } },
			})}\n`,
		);
		const recordId = "fedcba9876543210";
		appendCrashEvent(
			{
				kind: "occurrence",
				fingerprint: FINGERPRINT,
				fpv: 1,
				recordId,
				at: 1_700_000_899_000,
				errorName: "TypeError",
				messageClass: "cannot read properties of <redacted>",
			},
			paths.events,
		);
		await fs.appendFile(
			paths.crashLog,
			`2026-08-11T11:59:58.000Z pid=4242 [Uncaught Exception] TypeError: cannot read properties of <redacted>\n` +
				`${STACK}\n${formatCrashRecordMarker(FINGERPRINT, 1, recordId)}\n\n`,
		);
		const bodies: string[] = [];
		const outcome = await relayCrashSignatures({ config: config(), paths, env: {}, fetchImpl: accept(bodies) });
		expect(outcome).toEqual({ status: "ran", sent: 1, refused: 0, failed: 0 });
		expect(bodies).toHaveLength(1);
	});

	test("downgrade then re-upgrade does not retransmit when relayedAt still covers lastSeen", async () => {
		await seed();
		await relayCrashSignatures({ config: config(), paths, env: {}, fetchImpl: accept([]) });
		const compacted = await compactCrashIndex({ paths });
		const entry = compacted.signatures[FINGERPRINT];
		expect(entry?.relayedRecordId).toBe(RECORD_ID);
		if (!entry) return;
		const { lastAppendRecordId: _dropped, relayedRecordId: _legacyDropped, ...downgraded } = entry;
		await Bun.write(
			paths.index,
			`${JSON.stringify({
				...compacted,
				signatures: {
					[FINGERPRINT]: {
						...downgraded,
						lastRecordId: "9999888877776666",
						relayedAt: entry.lastSeen,
					},
				},
			})}\n`,
		);
		const bodies: string[] = [];
		const outcome = await relayCrashSignatures({ config: config(), paths, env: {}, fetchImpl: accept(bodies) });
		expect(outcome).toEqual({ status: "skipped", reason: "nothing-to-relay" });
		expect(bodies).toHaveLength(0);
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

	test("a backdated occurrence appended during the POST remains due after the watermark stamp", async () => {
		await seed();
		const bodies: string[] = [];
		const outcome = await relayCrashSignatures({
			config: config(),
			paths,
			env: {},
			fetchImpl: async (_url, init) => {
				bodies.push(String(init.body));
				await seed({ at: 1_700_000_100_000, recordId: "aaaabbbbccccdddd" });
				return new Response("", { status: 200 });
			},
		});
		expect(outcome).toEqual({ status: "ran", sent: 1, refused: 0, failed: 0 });
		const index = await compactCrashIndex({ paths });
		const relayed = listCrashSignatures(index)[0];
		expect(relayed?.lastSeen).toBe(1_700_000_900_000);
		expect(relayed?.lastRecordId).toBe(RECORD_ID);
		expect(relayed?.lastAppendRecordId).toBe("aaaabbbbccccdddd");
		expect(relayed?.relayedRecordId).toBe(RECORD_ID);
		expect(relayed && isRelayDue(relayed)).toBe(true);
		const second = await relayCrashSignatures({ config: config(), paths, env: {}, fetchImpl: accept(bodies) });
		expect(second).toEqual({ status: "ran", sent: 1, refused: 0, failed: 0 });
		expect(bodies).toHaveLength(2);
	});

	test("a journal append failure after 2xx leaves no watermark and retries the same event id", async () => {
		await seed();
		const bodies: string[] = [];
		const first = await relayCrashSignatures({
			config: config(),
			paths,
			env: {},
			fetchImpl: async (_url, init) => {
				bodies.push(String(init.body));
				await fs.rm(paths.events, { force: true });
				await fs.mkdir(paths.events);
				return new Response(JSON.stringify({ id: "a".repeat(32) }), { status: 200 });
			},
		});
		expect(first).toEqual({ status: "ran", sent: 0, refused: 0, failed: 1 });
		expect(await Bun.file(paths.index).exists()).toBe(true);
		const afterFail = await readCrashIndex(paths);
		expect(listCrashSignatures(afterFail)[0]?.relayedAt).toBeUndefined();
		expect(listCrashSignatures(afterFail)[0]?.relayedRecordId).toBeUndefined();

		await fs.rm(paths.events, { recursive: true, force: true });
		const second = await relayCrashSignatures({
			config: config(),
			paths,
			env: {},
			fetchImpl: accept(bodies),
		});
		expect(second).toEqual({ status: "ran", sent: 1, refused: 0, failed: 0 });
		expect(bodies).toHaveLength(2);
		const firstId = (JSON.parse(bodies[0]?.split("\n")[2] ?? "{}") as { event_id?: string }).event_id;
		const secondId = (JSON.parse(bodies[1]?.split("\n")[2] ?? "{}") as { event_id?: string }).event_id;
		expect(firstId).toMatch(/^[0-9a-f]{32}$/);
		expect(secondId).toBe(firstId);
		const afterRetry = await compactCrashIndex({ paths });
		expect(listCrashSignatures(afterRetry)[0]?.relayedRecordId).toBe(RECORD_ID);
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

	test("a same-fingerprint record with a mismatched append id is refused", async () => {
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
		await fs.writeFile(
			paths.crashLog,
			`2026-08-11T11:59:59.000Z pid=4242 [Uncaught Exception] TypeError: cannot read properties of <redacted>\n` +
				`${STACK}\n${formatCrashRecordMarker(FINGERPRINT, 1, "fedcba9876543210")}\n\n`,
		);
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

	test("a symlinked crash log is refused before any post", async () => {
		await seed();
		const target = path.join(dir, "outside-crash.log");
		await fs.rename(paths.crashLog, target);
		await fs.symlink(target, paths.crashLog);
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
		expect(outcome).toEqual({ status: "skipped", reason: "nothing-to-relay" });
		expect(called).toBe(0);
	});

	test("never sends more than the per-run cap", async () => {
		for (let i = 0; i < 4; i++) {
			const label = String.fromCharCode(97 + i);
			await seed({ fingerprint: label.repeat(32), recordId: `${i}`.repeat(16), at: 1_700_000_900_000 + i });
		}
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

	test("relaying the handled store marks the events as error, not fatal", async () => {
		await seed();
		const bodies: string[] = [];
		await relayCrashSignatures({
			config: config(),
			paths,
			env: {},
			severity: "error",
			fetchImpl: accept(bodies),
		});
		const payload = JSON.parse(bodies[0]?.split("\n")[2] ?? "{}") as { level: string };
		expect(payload.level).toBe("error");
	});

	test("relayAllSignatures covers both stores and keeps their levels distinct", async () => {
		const handledDir = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-relay-handled-"));
		const handledPaths: CrashStatePaths = {
			index: path.join(handledDir, "gjc-error-index.json"),
			events: path.join(handledDir, "gjc-error-events.jsonl"),
			crashLog: path.join(handledDir, "gjc-error.log"),
		};
		try {
			await seed();
			// Same shape in the handled store, under a different fingerprint.
			const handledFingerprint = computeHandledErrorFingerprint({
				name: "ToolError",
				message: "tool failed",
				stack: STACK,
			}).fingerprint;
			appendCrashEvent(
				{
					kind: "occurrence",
					fingerprint: handledFingerprint,
					fpv: 1,
					recordId: "abcdefabcdefabcd",
					at: 1_700_000_900_000,
					errorName: "ToolError",
					messageClass: "tool failed",
				},
				handledPaths.events,
			);
			await fs.writeFile(
				handledPaths.crashLog,
				`2026-08-11T11:59:59.000Z pid=4242 [Tool functions.read] ToolError: tool failed\n` +
					`${STACK}\n${formatCrashRecordMarker(handledFingerprint, 1, "abcdefabcdefabcd")}\n\n`,
			);

			const bodies: string[] = [];
			const outcome = await relayAllSignatures({
				config: config(),
				paths,
				handledPaths,
				env: {},
				fetchImpl: accept(bodies),
			});
			expect(outcome).toEqual({ status: "ran", sent: 2, refused: 0, failed: 0 });
			const levels = bodies.map(body => (JSON.parse(body.split("\n")[2] ?? "{}") as { level: string }).level);
			// Fatal is relayed first so a noisy handled class cannot starve it at the cap.
			expect(levels).toEqual(["fatal", "error"]);
		} finally {
			await fs.rm(handledDir, { recursive: true, force: true });
		}
	});

	test("relayAllSignatures shares the per-run cap across fatal and handled stores", async () => {
		const handledDir = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-relay-cap-"));
		const handledPaths: CrashStatePaths = {
			index: path.join(handledDir, "gjc-error-index.json"),
			events: path.join(handledDir, "gjc-error-events.jsonl"),
			crashLog: path.join(handledDir, "gjc-error.log"),
		};
		try {
			for (let i = 0; i < 3; i++) {
				const label = String.fromCharCode(97 + i);
				await seed({ fingerprint: label.repeat(32), recordId: `${i}`.repeat(16), at: 1_700_000_900_000 + i });
			}
			for (let i = 0; i < 3; i++) {
				const messageClass = `tool failed (${String.fromCharCode(100 + i)})`;
				const fingerprint = computeHandledErrorFingerprint({
					name: "ToolError",
					message: messageClass,
					stack: STACK,
				}).fingerprint;
				const rec = `${i + 3}`.repeat(16);
				appendCrashEvent(
					{
						kind: "occurrence",
						fingerprint,
						fpv: 1,
						recordId: rec,
						at: 1_700_000_900_000 + i,
						errorName: "ToolError",
						messageClass,
					},
					handledPaths.events,
				);
				await fs.appendFile(
					handledPaths.crashLog,
					`2026-08-11T11:59:59.000Z pid=4242 [Tool functions.read] ToolError: ${messageClass}\n` +
						`${STACK}\n${formatCrashRecordMarker(fingerprint, 1, rec)}\n\n`,
				);
			}
			const bodies: string[] = [];
			const outcome = await relayAllSignatures({
				config: config(),
				paths,
				handledPaths,
				env: {},
				maxPerRun: 4,
				fetchImpl: accept(bodies),
			});
			expect(outcome).toEqual({ status: "ran", sent: 4, refused: 0, failed: 0 });
			const levels = bodies.map(body => (JSON.parse(body.split("\n")[2] ?? "{}") as { level: string }).level);
			expect(levels).toEqual(["fatal", "fatal", "fatal", "error"]);
		} finally {
			await fs.rm(handledDir, { recursive: true, force: true });
		}
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

	async function runInCheckout(source: string, env: Record<string, string | undefined> = {}): Promise<string> {
		const script = path.join(dir, "probe.ts");
		await Bun.write(script, source);
		const childEnv: Record<string, string | undefined> = {
			PATH: Bun.env.PATH ?? "/usr/bin:/bin",
			HOME: dir,
			TMPDIR: path.join(dir, "tmp"),
			NODE_ENV: env.NODE_ENV,
			...env,
		};
		delete childEnv.GJC_CODING_AGENT_DIR;
		delete childEnv.PI_CODING_AGENT_DIR;
		delete childEnv.GJC_CONFIG_DIR;
		delete childEnv.PI_CONFIG_DIR;
		for (const [key, value] of Object.entries(env)) {
			if (value === undefined) delete childEnv[key];
			else childEnv[key] = value;
		}
		const child = Bun.spawn(["bun", script], {
			cwd: dir,
			env: childEnv,
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

	async function runCrashRelay(
		argv: string[],
		configYaml?: string,
	): Promise<{ stdout: string; stderr: string; exitCode: number }> {
		if (configYaml !== undefined) {
			await fs.mkdir(path.join(dir, ".gjc", "agent"), { recursive: true });
			await fs.writeFile(path.join(dir, ".gjc", "agent", "config.yml"), configYaml);
		}
		const child = Bun.spawn(["bun", path.resolve(import.meta.dir, "../src/cli.ts"), ...argv], {
			cwd: dir,
			env: {
				PATH: Bun.env.PATH ?? "/usr/bin:/bin",
				HOME: dir,
				TMPDIR: path.join(dir, "tmp"),
				GJC_CONFIG_DIR: ".gjc",
				GJC_CODING_AGENT_DIR: path.join(dir, ".gjc", "agent"),
			},
			stdout: "pipe",
			stderr: "pipe",
		});
		const [stdout, stderr, exitCode] = await Promise.all([
			new Response(child.stdout).text(),
			new Response(child.stderr).text(),
			child.exited,
		]);
		return { stdout, stderr, exitCode };
	}

	test("dispatches gjc crash relay through the trusted global settings flow", async () => {
		const result = await runCrashRelay(
			["crash", "relay"],
			"crashReport:\n  upstream: sentry\n  upstreamDsn: ftp://invalid.example/1\n",
		);
		expect(result.exitCode).toBe(1);
		expect(result.stdout).toContain("configured upstream DSN could not be parsed");
		expect(result.stderr).toBe("");
	});

	test("reports a due-signature-free relay as a successful command outcome", async () => {
		const result = await runCrashRelay(
			["crash", "relay"],
			"crashReport:\n  upstream: sentry\n  upstreamDsn: https://abc123@o1.ingest.sentry.io/4511929997721600\n",
		);
		expect(result.exitCode).toBe(0);
		expect(result.stdout).toContain("No crash signatures are due for relay.");
		expect(result.stderr).toBe("");
	});

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

	test("a dotenv-expanded DSN in the checkout cannot select the relay destination", async () => {
		const hostile = "https://attacker@evil.example/999";
		await Bun.write(path.join(dir, ".env"), `${CRASH_UPSTREAM_DSN_ENV}=$ATTACKER_DSN\n`);
		const resolverPath = path.resolve(import.meta.dir, "../src/crash/upstream/relay.ts");
		const out = await runInCheckout(
			`import { resolveRelayDsn } from ${JSON.stringify(resolverPath)};\n` +
				`const r = resolveRelayDsn({ upstream: "sentry", dsn: "" });\n` +
				`console.log(JSON.stringify(r.ok ? { ok: true, host: r.dsn.envelopeUrl } : r));\n`,
			{ ATTACKER_DSN: hostile },
		);
		const result = JSON.parse(out);
		expect(result).toEqual({ ok: false, reason: "no-dsn" });
		expect(out).not.toContain("evil.example");
	});

	test("a dotenv-expanded agent directory cannot redirect trusted relay state", async () => {
		const hostileAgent = path.join(dir, "checkout-agent");
		await Bun.write(path.join(dir, ".env"), "GJC_CODING_AGENT_DIR=$HOSTILE_AGENT\n");
		const relayPath = path.resolve(import.meta.dir, "../src/crash/upstream/relay.ts");
		const dirsPath = path.resolve(import.meta.dir, "../../utils/src/dirs.ts");
		const out = await runInCheckout(
			`import { getAgentDir } from ${JSON.stringify(dirsPath)};\n` +
				`import { resolveTrustedRelayStatePaths } from ${JSON.stringify(relayPath)};\n` +
				`console.log(JSON.stringify({ agent: getAgentDir(), paths: resolveTrustedRelayStatePaths() }));\n`,
			{ HOSTILE_AGENT: hostileAgent, HOME: dir },
		);
		const result = JSON.parse(out) as { agent: string; paths: CrashStatePaths };
		expect(result.agent).toBe(path.join(dir, ".gjc", "agent"));
		for (const filePath of Object.values(result.paths)) {
			expect(filePath.startsWith(hostileAgent)).toBe(false);
			expect(filePath.startsWith(result.agent)).toBe(true);
		}
	});

	test("a checkout .env HOME declaration cannot redirect trusted relay state", async () => {
		const hostileHome = path.join(dir, "checkout-home");
		await fs.mkdir(hostileHome, { recursive: true });
		await Bun.write(path.join(dir, ".env"), "HOME=$HOSTILE_HOME\n");
		const relayPath = path.resolve(import.meta.dir, "../src/crash/upstream/relay.ts");
		const dirsPath = path.resolve(import.meta.dir, "../../utils/src/dirs.ts");
		const out = await runInCheckout(
			`import { getAgentDir } from ${JSON.stringify(dirsPath)};\n` +
				`import { resolveTrustedHandledRelayStatePaths, resolveTrustedRelayStatePaths } from ${JSON.stringify(relayPath)};\n` +
				`console.log(JSON.stringify({ agent: getAgentDir(), fatal: resolveTrustedRelayStatePaths(), handled: resolveTrustedHandledRelayStatePaths() }));\n`,
			{ HOME: hostileHome, HOSTILE_HOME: hostileHome },
		);
		const result = JSON.parse(out) as {
			agent: string;
			fatal: CrashStatePaths;
			handled: CrashStatePaths;
		};
		expect(result.agent.startsWith(hostileHome)).toBe(false);
		for (const store of [result.fatal, result.handled])
			for (const filePath of Object.values(store)) expect(filePath.startsWith(hostileHome)).toBe(false);
	});

	test("automatic relay remains on the trusted agent store despite XDG state", async () => {
		const xdgState = path.join(dir, "trusted-state");
		await fs.mkdir(path.join(xdgState, "gjc"), { recursive: true });
		const relayPath = path.resolve(import.meta.dir, "../src/crash/upstream/relay.ts");
		const out = await runInCheckout(
			`import { resolveTrustedHandledRelayStatePaths, resolveTrustedRelayStatePaths } from ${JSON.stringify(relayPath)};\n` +
				`console.log(JSON.stringify({ fatal: resolveTrustedRelayStatePaths(), handled: resolveTrustedHandledRelayStatePaths() }));\n`,
			{ HOME: dir, XDG_STATE_HOME: xdgState },
		);
		const result = JSON.parse(out) as { fatal: CrashStatePaths; handled: CrashStatePaths };
		for (const store of [result.fatal, result.handled]) {
			for (const filePath of Object.values(store))
				expect(filePath.startsWith(path.join(dir, ".gjc", "agent"))).toBe(true);
		}
	});

	test("hostile repo XDG_STATE_HOME with a gjc child cannot feed fatal or handled stores", async () => {
		const hostileState = path.join(dir, "hostile-state");
		const xdgRoot = path.join(hostileState, "gjc");
		const trustedAgent = path.join(dir, ".gjc", "agent");
		await fs.mkdir(xdgRoot, { recursive: true });
		await fs.mkdir(trustedAgent, { recursive: true });

		const forgedFatal = "c".repeat(32);
		const forgedHandled = "d".repeat(32);
		const stack = "    at readFile (packages/coding-agent/src/tools/read.ts:12:9)";
		appendCrashEvent(
			{
				kind: "occurrence",
				fingerprint: forgedFatal,
				fpv: 1,
				recordId: "1111222233334444",
				at: 1_700_000_900_000,
				errorName: "TypeError",
				messageClass: "forged fatal",
			},
			path.join(xdgRoot, "gjc-crash-events.jsonl"),
		);
		await Bun.write(
			path.join(xdgRoot, "gjc-crash.log"),
			`2026-08-11T11:59:59.000Z pid=1 [Uncaught Exception] TypeError: forged fatal\n` +
				`${stack}\n${formatCrashRecordMarker(forgedFatal, 1, "1111222233334444")}\n\n`,
		);
		appendCrashEvent(
			{
				kind: "occurrence",
				fingerprint: forgedHandled,
				fpv: 1,
				recordId: "5555666677778888",
				at: 1_700_000_900_000,
				errorName: "ToolError",
				messageClass: "forged handled",
			},
			path.join(xdgRoot, "gjc-error-events.jsonl"),
		);
		await Bun.write(
			path.join(xdgRoot, "gjc-error.log"),
			`2026-08-11T11:59:59.000Z pid=1 [Tool functions.read] ToolError: forged handled\n` +
				`${stack}\n${formatCrashRecordMarker(forgedHandled, 1, "5555666677778888")}\n\n`,
		);

		await Bun.write(path.join(dir, ".env"), `XDG_STATE_HOME=${hostileState}\n`);
		const relayPath = path.resolve(import.meta.dir, "../src/crash/upstream/relay.ts");
		const dirsPath = path.resolve(import.meta.dir, "../../utils/src/dirs.ts");
		const storePath = path.resolve(import.meta.dir, "../src/crash/index-store.ts");
		const out = await runInCheckout(
			`import { getCrashIndexPath, getHandledErrorIndexPath } from ${JSON.stringify(dirsPath)};\n` +
				`import { resolveCrashStatePaths } from ${JSON.stringify(storePath)};\n` +
				`import { relayAllSignatures, resolveTrustedHandledRelayStatePaths, resolveTrustedRelayStatePaths } from ${JSON.stringify(relayPath)};\n` +
				`const posts = [];\n` +
				`const outcome = await relayAllSignatures({\n` +
				`  config: { upstream: "sentry", dsn: ${JSON.stringify(DSN)} },\n` +
				`  env: {},\n` +
				`  fetchImpl: async (_url, init) => { posts.push(String(init.body)); return new Response("", { status: 200 }); },\n` +
				`});\n` +
				`console.log(JSON.stringify({\n` +
				`  outcome,\n` +
				`  posts,\n` +
				`  trusted: resolveTrustedRelayStatePaths(),\n` +
				`  trustedHandled: resolveTrustedHandledRelayStatePaths(),\n` +
				`  xdgFatal: resolveCrashStatePaths(),\n` +
				`  xdgHandled: getHandledErrorIndexPath(),\n` +
				`  crashIndexXdg: getCrashIndexPath(),\n` +
				`}));\n`,
			{
				XDG_STATE_HOME: hostileState,
				HOME: dir,
			},
		);
		const result = JSON.parse(out) as {
			outcome: { status: string; reason?: string; sent?: number };
			posts: string[];
			trusted: { index: string; events: string; crashLog: string };
			trustedHandled: { index: string; events: string; crashLog: string };
			xdgFatal: { index: string };
			xdgHandled: string;
			crashIndexXdg: string;
		};
		expect(result.outcome).toEqual({ status: "skipped", reason: "nothing-to-relay" });
		expect(result.posts).toEqual([]);
		for (const store of [result.trusted, result.trustedHandled]) {
			for (const filePath of Object.values(store)) {
				expect(filePath.startsWith(trustedAgent)).toBe(true);
				expect(filePath.startsWith(hostileState)).toBe(false);
			}
		}
		expect(result.crashIndexXdg.startsWith(xdgRoot)).toBe(false);
		expect(result.xdgHandled.startsWith(xdgRoot)).toBe(false);
		expect(out).not.toContain(forgedFatal);
		expect(out).not.toContain(forgedHandled);
	});
});
