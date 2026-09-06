import { describe, expect, it } from "bun:test";
import * as os from "node:os";
import * as path from "node:path";
import { CRASH_BODY_MAX_BYTES, fenceCrashText, sanitizeExternalCrashV1 } from "../src/crash/sanitize";

function sanitized(text: string): string {
	const verdict = sanitizeExternalCrashV1(text);
	if (!verdict.ok) throw new Error(`unexpected refusal: ${verdict.reason}`);
	return verdict.value;
}

describe("sanitizeExternalCrashV1 — real corpus shapes", () => {
	it("keeps the diagnosable text of a topic-authority crash while dropping paths", () => {
		const output = sanitized(
			[
				"Error: shared topic authority unavailable",
				"    at resolveTopic (/home/alice/gjc/packages/coding-agent/src/sdk/bus/topics.ts:412:19)",
			].join("\n"),
		);
		expect(output).toContain("shared topic authority unavailable");
		expect(output).not.toContain("/home/alice");
		expect(output).toContain("<path>");
	});

	it("marks the caller's own home directory as <home>", () => {
		expect(sanitized(`read ${path.join(os.homedir(), ".gjc/agent/gjc-crash.log")}`)).toBe("read <home>");
	});

	it("keeps errno text of an ENOSPC crash", () => {
		expect(sanitized("Error: ENOSPC: no space left on device, write '/var/lib/gjc/x'")).toBe(
			"Error: ENOSPC: no space left on device, write '<path>'",
		);
	});

	it("collapses account/session identifiers that carry no triage value", () => {
		expect(sanitized("topic for account 550e8400-e29b-41d4-a716-446655440000 seq 1234567890123")).toBe(
			"topic for account <uuid> seq <num>",
		);
		expect(sanitized("session deadbeefcafebabe missing")).toBe("session <hex> missing");
		// Short, semantically meaningful codes survive.
		expect(sanitized("request failed with status 404 after 3 retries")).toBe(
			"request failed with status 404 after 3 retries",
		);
	});

	it("collapses a Windows and a UNC path", () => {
		expect(sanitized("load failed C:\\Users\\bob\\AppData\\gjc.node")).toBe("load failed <path>");
		expect(sanitized("load failed \\\\fileserver\\share\\gjc.node")).toBe("load failed <path>");
	});
});

describe("sanitizeExternalCrashV1 — hostile inputs", () => {
	it("strips ANSI, OSC, bidi and zero-width controls", () => {
		const output = sanitized("a\u001b[31mred\u001b]0;title\u0007b\u202ereversed\u200bc\r\nd");
		expect(output).not.toMatch(/[\u001b\u202e\u200b\r]/);
		expect(output).toBe("ared breversedc\nd");
	});

	it("drops URL userinfo, query and fragment and refuses to keep an unparseable URL", () => {
		expect(sanitized("see https://user:pw@example.com/a/b?token=abc#frag now")).toBe("see «url example.com/a/b» now");
		expect(sanitized("see ftp://host/secret now")).toBe("see «url dropped» now");
	});

	it("rewrites credential shapes into markers", () => {
		const output = sanitized("headers: authorization=ghp_0123456789abcdefghij and key sk-abcdefgh12345678");
		expect(output).not.toContain("ghp_0123456789abcdefghij");
		expect(output).not.toContain("sk-abcdefgh12345678");
		expect(output).toContain("«redacted");
	});

	it("refuses rather than guessing when an opaque inline payload survives", () => {
		// A `data:` URI has no origin to reduce to, so no rule can vouch for it and
		// the scanner refuses instead of shipping an unreviewed base64 blob.
		const verdict = sanitizeExternalCrashV1("failed to decode data:image/png;base64,AAAAB3NzaC1");
		expect(verdict.ok).toBe(false);
		expect(verdict.ok === false && verdict.reason).toContain("residual");
	});

	it("bounds an 80 KiB payload well under the body cap", () => {
		const output = sanitized("x".repeat(80 * 1024));
		expect(Buffer.byteLength(output, "utf8")).toBeLessThan(CRASH_BODY_MAX_BYTES);
		expect(output.endsWith("…[truncated]")).toBe(true);
	});

	it("drops the credential shapes the import scrubber already recognizes", () => {
		// All synthetic. These four survived into outbound text because the shared
		// credential layer did not name them, while session-import/redact.ts —
		// which faces strictly less exposure — already listed every one.
		const googleApiKey = `AIza${"S".repeat(35)}`;
		const pemBody = "MIIEowIBAAKCAQEAxGZ0000abcdefgHIJKLmnop";
		const output = sanitized(
			[
				`google: ${googleApiKey}`,
				"principal one: ABIAIOSFODNN7EXAMPLE",
				"principal two: ACCAIOSFODNN7EXAMPLE",
				// Control: already covered before this change.
				"principal three: ASIAIOSFODNN7EXAMPLE",
				`-----BEGIN RSA PRIVATE KEY-----\n${pemBody}\n-----END RSA PRIVATE KEY-----`,
			].join("\n"),
		);

		expect(output).not.toContain(googleApiKey);
		expect(output).not.toContain("ABIAIOSFODNN7EXAMPLE");
		expect(output).not.toContain("ACCAIOSFODNN7EXAMPLE");
		expect(output).not.toContain("ASIAIOSFODNN7EXAMPLE");
		expect(output).not.toContain(pemBody);
		// The surrounding diagnostic text still survives.
		expect(output).toContain("principal one");
		expect(output).toContain("principal two");
	});

	it("keeps url userinfo out of outbound text without hiding the host", () => {
		const output = sanitized("clone failed: https://deploy:s3cr3tvalue@git.example.com/x.git");
		expect(output).not.toContain("s3cr3tvalue");
		expect(output).toContain("clone failed");
	});

	it("scans a large credential-free body in linear time", () => {
		// The url-credential rule bounds its scheme repetition. An unbounded one
		// re-tries every prefix of a long alphabetic run before failing on `://`,
		// which is quadratic: a 200 KB crash body cost ~10s and blew the 5s test
		// timeout in packages/utils/test/crash-journal.test.ts.
		const startedAt = performance.now();
		sanitized("x".repeat(200_000));
		expect(performance.now() - startedAt).toBeLessThan(1_000);
	});
});

describe("fenceCrashText", () => {
	it("neutralizes fence escapes and de-fangs mentions", () => {
		expect(fenceCrashText("```js\nrm -rf\n``` @Yeachan-Heo")).toBe("'''js\nrm -rf\n''' (at)Yeachan-Heo");
	});
});
