import { describe, expect, it } from "bun:test";
import { parseSentryDsn, type SentryDsn } from "../src/crash/upstream/dsn";
import { type BuildCrashEnvelopeInput, buildCrashEnvelope, newSentryEventId } from "../src/crash/upstream/envelope";

function requireDsn(raw: string): SentryDsn {
	const parsed = parseSentryDsn(raw);
	if (!parsed) throw new Error(`test DSN must parse: ${raw}`);
	return parsed;
}

const DSN = requireDsn("https://abc123@o1.ingest.sentry.io/4511346223808512");
const EVENT_ID = "0123456789abcdef0123456789abcdef";
const FINGERPRINT = "fedcba9876543210fedcba9876543210";

function envelopeInput(overrides: Partial<BuildCrashEnvelopeInput> = {}): BuildCrashEnvelopeInput {
	return {
		eventId: EVENT_ID,
		fingerprint: FINGERPRINT,
		errorName: "Error",
		messageClass: "shared topic authority unavailable",
		frames: [
			{ filename: "packages/coding-agent/src/newest.ts", function: "newest" },
			{ filename: "packages/coding-agent/src/oldest.ts", function: "oldest" },
		],
		firstSeen: Date.UTC(2026, 7, 10, 12, 0, 0),
		lastSeen: Date.UTC(2026, 7, 11, 12, 0, 0),
		lifetimeCount: 4,
		release: "0.13.1",
		platform: "darwin-arm64",
		bunVersion: "1.3.14",
		dsn: DSN,
		...overrides,
	};
}

describe("parseSentryDsn", () => {
	it("parses a canonical hosted DSN into its envelope endpoint", () => {
		const dsn = parseSentryDsn("https://abc123@o1.ingest.sentry.io/4511346223808512");
		expect(dsn).toEqual({
			publicKey: "abc123",
			host: "o1.ingest.sentry.io",
			projectId: "4511346223808512",
			envelopeUrl: "https://o1.ingest.sentry.io/api/4511346223808512/envelope/",
		});
	});

	it("refuses DSNs outside the restricted public-key grammar", () => {
		expect(parseSentryDsn("ftp://abc123@o1.ingest.sentry.io/1")).toBeUndefined();
		expect(parseSentryDsn("https://@o1.ingest.sentry.io/1")).toBeUndefined();
		expect(parseSentryDsn("https://abc123:secret@o1.ingest.sentry.io/1")).toBeUndefined();
		expect(parseSentryDsn("https://abc123@o1.ingest.sentry.io/project")).toBeUndefined();
		expect(parseSentryDsn("https://abc123@o1.ingest.sentry.io/")).toBeUndefined();
		expect(parseSentryDsn("http://abc123@o1.ingest.sentry.io/1")).toBeUndefined();
	});

	it("permits plaintext only for local development", () => {
		expect(parseSentryDsn("http://k@127.0.0.1:9000/1")).toEqual({
			publicKey: "k",
			host: "127.0.0.1:9000",
			projectId: "1",
			envelopeUrl: "http://127.0.0.1:9000/api/1/envelope/",
		});
	});
});

describe("buildCrashEnvelope", () => {
	it("builds a bounded three-line event with grouping and oldest-first frames", () => {
		const result = buildCrashEnvelope(envelopeInput());
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		const lines = result.body.split("\n");
		expect(lines).toHaveLength(3);
		const itemHeader = JSON.parse(lines[1] ?? "") as { length: number };
		const payload = JSON.parse(lines[2] ?? "") as Record<string, unknown>;
		const header = JSON.parse(lines[0] ?? "") as Record<string, unknown>;
		expect(itemHeader.length).toBe(Buffer.byteLength(lines[2] ?? "", "utf8"));
		expect(payload.fingerprint).toEqual([FINGERPRINT]);
		expect(header).not.toHaveProperty("sent_at");
		expect(payload.timestamp).toBe(Date.UTC(2026, 7, 11) / 1000);
		expect(result.body).not.toMatch(/T\d{2}:\d{2}:\d{2}/);
		for (const forbidden of ["user", "server_name", "contexts", "breadcrumbs", "request"])
			expect(payload).not.toHaveProperty(forbidden);
		const exception = payload.exception as { values: { stacktrace: { frames: { function: string }[] } }[] };
		expect(exception.values[0]?.stacktrace.frames.map(frame => frame.function)).toEqual(["oldest", "newest"]);
	});

	it("refuses the complete event when a crash field cannot be sanitized", () => {
		const result = buildCrashEnvelope(
			envelopeInput({ messageClass: "\u001b[31mfailed to decode data:image/png;base64,AAAAB3NzaC1" }),
		);
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.reason).toContain("residual");
	});

	// Assembled at runtime rather than written as literals: a fixture shaped like
	// a real token trips GitHub push protection and every downstream secret
	// scanner, which is a bad trade for a value that only has to match a regex.
	// The `%s` label keeps the assembled shape visible in test output.
	const BODY = "abcdefghijklmnopqrstuvwxyz";
	it.each([
		["google-api-key", `AIza${"Sy"}${"D"}${BODY}${BODY.slice(0, 12)}`],
		["npm-token", `npm${"_"}${BODY}`],
		["gitlab-pat", `glpat${"-"}${BODY}`],
		["stripe-live-key", ["sk", "live", BODY].join("_")],
		["huggingface-token", `hf${"_"}${BODY}`],
		[
			"pem-private-key",
			`${["-----BEGIN", "PRIVATE", "KEY-----"].join(" ")}\nnot-a-real-key\n${["-----END", "PRIVATE", "KEY-----"].join(" ")}`,
		],
	])("refuses credential-like egress content: %s", (_label, credential) => {
		const result = buildCrashEnvelope(envelopeInput({ messageClass: credential }));
		expect(result).toEqual({ ok: false, reason: "credential-like content" });
	});

	it("refuses an envelope that exceeds the 48 KiB body limit", () => {
		const result = buildCrashEnvelope(envelopeInput({ messageClass: "x".repeat(48 * 1024) }));
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.reason).toBe("envelope exceeds size limit");
	});
});

describe("newSentryEventId", () => {
	it("creates a lowercase 128-bit hexadecimal id", () => {
		expect(newSentryEventId()).toMatch(/^[0-9a-f]{32}$/);
	});
});
