import { describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { computeHandledErrorFingerprint, NO_APP_FRAME } from "../src/crash-fingerprint";
import { isCredentialKey, redactCrashSecrets } from "../src/crash-redaction";
import { CRASH_LOG_MAX_BYTES, CRASH_RECORD_MAX_BYTES, recordFatalCrash, recordHandledError } from "../src/postmortem";

function tempCrashLog(): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-crash-log-"));
	// Nested path proves the writer creates missing parent directories.
	return path.join(dir, "agent", "gjc-crash.log");
}

const POSTMORTEM_SOURCE = path.resolve(import.meta.dir, "../src/postmortem.ts");

function spawnBun(script: string, options: { args?: string[]; env?: Record<string, string> } = {}) {
	const result = Bun.spawnSync({
		cmd: [process.execPath, script, ...(options.args ?? [])],
		stdout: "pipe",
		stderr: "pipe",
		env: { ...process.env, ...options.env },
	});
	return {
		exitCode: result.exitCode,
		stdout: result.stdout.toString(),
		stderr: result.stderr.toString(),
	};
}

describe("recordFatalCrash", () => {
	it("writes a structured, diagnosable record for an Error", () => {
		const target = tempCrashLog();
		const err = new Error("boom while streaming");
		const now = new Date("2026-07-23T21:22:31.647Z");

		const written = recordFatalCrash("Uncaught Exception", err, { path: target, now });

		expect(written).toBe(target);
		const contents = fs.readFileSync(target, "utf8");
		expect(contents).toContain("2026-07-23T21:22:31.647Z");
		expect(contents).toContain(`pid=${process.pid}`);
		expect(contents).toContain("[Uncaught Exception]");
		expect(contents).toContain("Error: boom while streaming");
		// The full stack must be present so the crash is actually diagnosable.
		expect(contents).toContain(err.stack ?? "MISSING_STACK");
		expect(contents.split("\n").some(line => line.includes("at "))).toBe(true);
	});

	it("flattens a forged newline in a header that redaction rewrites", () => {
		const target = tempCrashLog();
		// Assembled at runtime so this file does not commit a literal token.
		const token = ["sk", "a".repeat(24)].join("-");
		const injected = "INJECTED";
		const header = `safe ${token}\n${injected}`;
		const err = new Error(header);
		const kept = "    at keptFrame (app.ts:1:1)";
		const alsoKept = "    at alsoKept (app.ts:2:1)";
		// The raw `name: message` prefix is not a prefix of the redacted stack.
		err.stack = [`Error: ${header}`, kept, alsoKept].join("\n");

		const written = recordFatalCrash("Uncaught Exception", err, { path: target });

		expect(written).toBe(target);
		const frameless = new Error(header);
		frameless.stack = `Error: ${header}`;
		expect(recordFatalCrash("Uncaught Exception", frameless, { path: target })).toBe(target);
		const contents = fs.readFileSync(target, "utf8");
		expect(contents).not.toContain(token);
		expect(contents).toContain("«redacted-api-key»");
		const lines = contents.split("\n");
		expect(lines.every(line => line !== injected)).toBe(true);
		expect(lines).toContain(kept);
		expect(lines).toContain(alsoKept);
	});

	it("flattens a forged at-line inside the message and keeps the real frame", () => {
		const target = tempCrashLog();
		const token = ["sk", "b".repeat(24)].join("-");
		const message = `safe ${token}\n    at forged\nINJECTED`;
		const err = new Error(message);
		const realFrame = "    at realFrame (app.ts:1:1)";
		err.stack = `Error: ${message}\n${realFrame}`;

		expect(recordFatalCrash("Uncaught Exception", err, { path: target })).toBe(target);
		const contents = fs.readFileSync(target, "utf8");
		const lines = contents.split("\n");
		expect(contents).not.toContain(token);
		expect(contents).toContain("«redacted-api-key»");
		expect(lines.every(line => line !== "INJECTED" && line !== "    at forged")).toBe(true);
		expect(lines).toContain(realFrame);

		const handled = new Error(`${message} handled`);
		handled.stack = `Error: ${handled.message}\n${realFrame}`;
		const handledLog = tempCrashLog();
		expect(recordHandledError("tool", handled, { path: handledLog })).toBe(handledLog);
		const handledLines = fs.readFileSync(handledLog, "utf8").split("\n");
		expect(handledLines.every(line => line !== "INJECTED" && line !== "    at forged")).toBe(true);
		expect(handledLines).toContain(realFrame);
	});

	it("still redacts a bearer token that continues on the line after the message", () => {
		const target = tempCrashLog();
		const token = "z".repeat(24);
		const err = new Error("Bearer");
		err.stack = `Error: Bearer\n${token}\n    at realFrame (app.ts:1:1)`;

		expect(recordFatalCrash("Uncaught Exception", err, { path: target })).toBe(target);
		const contents = fs.readFileSync(target, "utf8");
		expect(contents).not.toContain(token);
		expect(contents).toContain("«redacted-auth»");
	});

	it("keeps frame lines when the header ends in a labeled credential", () => {
		const target = tempCrashLog();
		const token = "q".repeat(24);
		const message = `password=${token}`;
		const err = new Error(message);
		const first = "    at first (app.ts:1:1)";
		const second = "    at second (app.ts:2:1)";
		err.stack = `Error: ${message}\n${first}\n${second}`;

		expect(recordFatalCrash("Uncaught Exception", err, { path: target })).toBe(target);
		const lines = fs.readFileSync(target, "utf8").split("\n");
		expect(lines.join("\n")).not.toContain(token);
		expect(lines).toContain(first);
		expect(lines).toContain(second);
	});

	it("keeps frames for a name-only empty-message stack", () => {
		const root = path.resolve(import.meta.dir, "..", "..", "..");
		const frameA = `    at firstSite (${path.join(root, "packages/utils/src/empty-a.ts")}:1:1)`;
		const frameB = `    at secondSite (${path.join(root, "packages/utils/src/empty-b.ts")}:2:1)`;
		const err = new Error("");
		err.stack = `Error\n${frameA}`;
		const target = tempCrashLog();

		expect(recordFatalCrash("Uncaught Exception", err, { path: target })).toBe(target);
		const lines = fs.readFileSync(target, "utf8").split("\n");
		expect(lines.some(line => line.includes("Error: (no message)"))).toBe(true);
		expect(lines).toContain(frameA);
		expect(lines.some(line => line.includes(`Error ${frameA.trim()}`))).toBe(false);

		const identity = (frame: string) =>
			computeHandledErrorFingerprint({
				name: "Error",
				message: "(no message)",
				stack: `Error\n${frame}`,
			});
		const first = identity(frameA);
		const second = identity(frameB);
		expect(first.frames[0]).not.toBe(NO_APP_FRAME);
		expect(second.frames[0]).not.toBe(NO_APP_FRAME);
		expect(first.fingerprint).not.toBe(second.fingerprint);

		const handledLog = tempCrashLog();
		const siteA = new Error("");
		siteA.stack = `Error\n${frameA}`;
		const siteB = new Error("");
		siteB.stack = `Error\n${frameB}`;
		expect(recordHandledError("tool", siteA, { path: handledLog })).toBe(handledLog);
		expect(recordHandledError("tool", siteB, { path: handledLog })).toBe(handledLog);
		expect(recordHandledError("tool", siteA, { path: handledLog })).toBeUndefined();
		const handled = fs.readFileSync(handledLog, "utf8").split("\n");
		expect(handled).toContain(frameA);
		expect(handled).toContain(frameB);
	});

	it("keeps at frame lines of a normal multi-line stack", () => {
		const target = tempCrashLog();
		const err = new Error("boom while streaming");
		const kept = "    at keptFrame (app.ts:4:2)";
		const alsoKept = "    at alsoKept (app.ts:5:1)";
		err.stack = ["Error: boom while streaming", kept, alsoKept].join("\n");

		const written = recordFatalCrash("Uncaught Exception", err, { path: target });

		expect(written).toBe(target);
		const lines = fs.readFileSync(target, "utf8").split("\n");
		expect(lines).toContain("Error: boom while streaming");
		expect(lines).toContain(kept);
		expect(lines).toContain(alsoKept);
	});

	it("stringifies non-Error rejection reasons", () => {
		const target = tempCrashLog();
		const written = recordFatalCrash("Unhandled Rejection", "Request was aborted", { path: target });
		expect(written).toBe(target);
		const contents = fs.readFileSync(target, "utf8");
		expect(contents).toContain("[Unhandled Rejection]");
		expect(contents).toContain("Request was aborted");
	});

	it("keeps the payload of a non-Error object throwable", () => {
		// SDK lifecycle startup failures are thrown as plain records, not Errors;
		// String(record) used to reduce the whole crash to "[object Object]".
		const target = tempCrashLog();
		const written = recordFatalCrash(
			"Uncaught Exception",
			{ phase: "startup", reason: "pending", message: "SDK startup did not complete before readiness cutoff." },
			{ path: target },
		);
		expect(written).toBe(target);
		const contents = fs.readFileSync(target, "utf8");
		expect(contents).not.toContain("[object Object]");
		expect(contents).toContain('"phase":"startup"');
		expect(contents).toContain('"reason":"pending"');
		expect(contents).toContain("SDK startup did not complete before readiness cutoff.");
	});

	it("still records a throwable that cannot be serialized", () => {
		const target = tempCrashLog();
		const cyclic: { self?: unknown; marker: string } = { marker: "cyclic-throwable" };
		cyclic.self = cyclic;
		const written = recordFatalCrash("Unhandled Rejection", cyclic, { path: target });
		expect(written).toBe(target);
		const contents = fs.readFileSync(target, "utf8");
		expect(contents).toContain("[Unhandled Rejection]");
	});

	it("appends successive crashes rather than overwriting", () => {
		const target = tempCrashLog();
		recordFatalCrash("Uncaught Exception", new Error("first"), { path: target });
		recordFatalCrash("Uncaught Exception", new Error("second"), { path: target });
		const contents = fs.readFileSync(target, "utf8");
		expect(contents).toContain("Error: first");
		expect(contents).toContain("Error: second");
		expect(contents.indexOf("first")).toBeLessThan(contents.indexOf("second"));
	});

	it("resets past the size cap so a crash loop cannot grow unbounded", () => {
		const target = tempCrashLog();
		fs.mkdirSync(path.dirname(target), { recursive: true });
		// Pre-fill beyond the 512KB cap.
		fs.writeFileSync(target, "x".repeat(600 * 1024));
		recordFatalCrash("Uncaught Exception", new Error("post-cap crash"), { path: target });
		const size = fs.statSync(target).size;
		expect(size).toBeLessThan(CRASH_LOG_MAX_BYTES);
		const contents = fs.readFileSync(target, "utf8");
		expect(contents).toContain("Error: post-cap crash");
		// Old oversized content is gone; newest crash retained.
		expect(contents).not.toContain("x".repeat(1024));
	});

	it("bounds a single oversized record so it cannot bypass the file cap", () => {
		const target = tempCrashLog();
		const huge = new Error(`megacrash ${"z".repeat(1024 * 1024)}`);

		recordFatalCrash("Uncaught Exception", huge, { path: target });

		const size = fs.statSync(target).size;
		expect(size).toBeLessThanOrEqual(CRASH_RECORD_MAX_BYTES);
		const contents = fs.readFileSync(target, "utf8");
		expect(contents).toContain("megacrash");
		expect(contents).toContain("[crash record truncated]");
	});

	it("truncates on a UTF-8 boundary without replacement characters", () => {
		const target = tempCrashLog();
		// Multi-byte characters right at the truncation boundary.
		const message = `한국어 메시지 ${"가".repeat(CRASH_RECORD_MAX_BYTES)}`;

		recordFatalCrash("Uncaught Exception", new Error(message), { path: target });

		const size = fs.statSync(target).size;
		expect(size).toBeLessThanOrEqual(CRASH_RECORD_MAX_BYTES);
		const contents = fs.readFileSync(target, "utf8");
		expect(contents).toContain("[crash record truncated]");
		expect(contents).not.toContain("�");
	});

	it("redacts credential material before persisting", () => {
		const target = tempCrashLog();
		const bearer = "Bearer abcdef0123456789abcdef0123456789";
		const apiKey = "sk-abcdef0123456789abcdef";
		const github = "ghp_abcdef0123456789abcdef0123";
		const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U";
		const refresh = `"refresh_token": "rt-abcdef0123456789"`;
		const err = new Error(`auth failed: ${bearer}, ${apiKey}, ${github}, ${jwt}, ${refresh}, password=hunter2secret`);

		recordFatalCrash("Uncaught Exception", err, { path: target });

		const contents = fs.readFileSync(target, "utf8");
		expect(contents).toContain("auth failed");
		expect(contents).toContain("«redacted»");
		expect(contents).not.toContain("abcdef0123456789");
		expect(contents).not.toContain("hunter2secret");
		expect(contents).not.toContain("dozjgNryP4J3jVmNHl0w5N");
		// The key context survives so the record stays diagnosable.
		expect(contents).toContain('"refresh_token": "«redacted»');
	});

	it("redacts literal session-id cookies and bare AWS secret keys", () => {
		const secret = `${"A".repeat(20)}/${"B".repeat(19)}`;
		const sessionCookie = "opaque-session-cookie";
		const redacted = redactCrashSecrets(
			`AWS_SECRET_ACCESS_KEY=${secret} sessionid=${sessionCookie} sessionid%3D${sessionCookie} ${secret}`,
		);

		expect(redacted).toContain("AWS_SECRET_ACCESS_KEY=«redacted»");
		expect(redacted).toContain("sessionid=«redacted»");
		expect(redacted).toContain("sessionid%3D«redacted»");
		expect(redacted).toContain("«redacted-aws-key»");
		expect(redacted).not.toContain(secret);
		expect(redacted).not.toContain(sessionCookie);
	});

	it("redacts unquoted multiword credential values before persisting", () => {
		const target = tempCrashLog();
		const secret = "correct horse battery staple";

		recordFatalCrash("Uncaught Exception", new Error(`password=${secret} token=second-secret note=keep`), {
			path: target,
		});

		const contents = fs.readFileSync(target, "utf8");
		expect(contents).not.toContain(secret);
		expect(contents).not.toContain("second-secret");
		expect(contents).toContain("password=«redacted» token=«redacted» note=keep");
	});

	it("redacts indented YAML credential block scalars before persisting", () => {
		const target = tempCrashLog();
		const message = [
			"password: | # literal header stays",
			"  opaque-literal-secret-123",
			"    opaque-literal-second-line-secret",
			"",
			"  opaque-literal-after-blank-secret",
			"note=keep",
			"password: |-",
			"  opaque-stripped-literal-secret",
			"note=keep",
			"password: |+",
			"  opaque-kept-literal-secret",
			"note=keep",
			"password: >-",
			"  opaque-folded-secret-456",
			"",
			"  opaque-folded-after-blank-secret",
			"note=keep",
			"password: >",
			"  opaque-plain-folded-secret",
			"note=keep",
			"password: |2- # indentation indicator",
			"    opaque-indicated-literal-secret",
			"note=keep",
			"password: >-2",
			"    opaque-reversed-indicated-folded-secret",
			"note=keep",
			"password: >+2",
			"    opaque-indicated-folded-secret",
			"note=keep",
			"- password: |",
			"    opaque-sequence-literal-secret",
			"  note: keep after sequence",
			"  - password_confirmation: >-",
			"      opaque-nested-sequence-secret",
			"    note: keep nested sequence",
			"password: &credential |",
			"  opaque-anchored-block-secret",
			"note: keep after anchor",
			"password: !!str >-",
			"  opaque-tagged-block-secret",
			"note: keep after tag",
			"password: &credential !!str |",
			"  opaque-anchored-tagged-block-secret",
			"note: keep after anchor and tag",
			'"password": |',
			"  opaque-double-quoted-key-secret",
			"note=keep",
			"'api_key': >-",
			"  opaque-single-quoted-key-secret",
			"note=keep",
		].join("\n");

		recordFatalCrash("Uncaught Exception", message, { path: target });

		const contents = fs.readFileSync(target, "utf8");
		for (const secret of [
			"opaque-literal-secret-123",
			"opaque-literal-second-line-secret",
			"opaque-literal-after-blank-secret",
			"opaque-stripped-literal-secret",
			"opaque-kept-literal-secret",
			"opaque-folded-secret-456",
			"opaque-folded-after-blank-secret",
			"opaque-plain-folded-secret",
			"opaque-indicated-literal-secret",
			"opaque-reversed-indicated-folded-secret",
			"opaque-indicated-folded-secret",
			"opaque-sequence-literal-secret",
			"opaque-nested-sequence-secret",
			"opaque-anchored-block-secret",
			"opaque-tagged-block-secret",
			"opaque-anchored-tagged-block-secret",
			"opaque-double-quoted-key-secret",
			"opaque-single-quoted-key-secret",
		]) {
			expect(contents).not.toContain(secret);
		}
		expect(contents).toContain("password: | # literal header stays");
		expect(contents).toContain("password: |-");
		expect(contents).toContain("password: |+");
		expect(contents).toContain("password: >-");
		expect(contents).toContain("password: >");
		expect(contents).toContain("password: |2- # indentation indicator");
		expect(contents).toContain("password: >-2");
		expect(contents).toContain("password: >+2");
		expect(contents).toContain("- password: |");
		expect(contents).toContain("  - password_confirmation: >-");
		expect(contents).toContain("  note: keep after sequence");
		expect(contents).toContain("    note: keep nested sequence");
		expect(contents).toContain("password: &credential |");
		expect(contents).toContain("password: !!str >-");
		expect(contents).toContain("password: &credential !!str |");
		expect(contents).toContain("note: keep after anchor");
		expect(contents).toContain("note: keep after tag");
		expect(contents).toContain("note: keep after anchor and tag");
		expect(contents).toContain('"password": |');
		expect(contents).toContain("'api_key': >-");
		expect(redactCrashSecrets(message)).toContain("  «redacted»\n    «redacted»\n\n  «redacted»\nnote=keep");
		expect(contents).toContain("note=keep");
	});

	it("redacts current vendor token formats, not just the legacy prefixes", () => {
		const target = tempCrashLog();
		// GitHub fine-grained PATs use `github_pat_`, not the classic `gh[opsur]_`.
		const fineGrained = "github_pat_11ABCDEFG0hijklmnopq_RSTUVWXYZ0123456789abcdefghijklmnopqr";
		// ASIA is the temporary/STS access key id; AKIA is the long-term one.
		const temporaryAws = "ASIA1234567890ABCDEF";
		const err = new Error(`upload failed: ${fineGrained}-tail ${temporaryAws}-tail`);

		recordFatalCrash("Uncaught Exception", err, { path: target });

		const contents = fs.readFileSync(target, "utf8");
		expect(contents).toContain("upload failed");
		expect(contents).not.toContain(fineGrained);
		expect(contents).not.toContain(temporaryAws);
		expect(contents).toContain("«redacted-github-token»");
		expect(contents).toContain("«redacted-aws-key»");
		expect(contents).toContain("«redacted-github-token»-tail");
		expect(contents).toContain("«redacted-aws-key»-tail");
	});

	it("redacts opaque values under generic credential labels", async () => {
		const target = tempCrashLog();
		const secrets = [
			"opaque-token-value",
			"opaque-secret-value",
			"opaque-credential-value",
			"opaque-private-key-value",
			"opaque-cookie-value",
		];
		const labels = ["token", "secret", "credential", "private_key", "cookie"];
		const labeled = labels.map((label, index) => `${label}=${secrets[index]}`).join(" ");

		recordFatalCrash("Uncaught Exception", new Error(`diagnostic safe=keep-this ${labeled}`), {
			path: target,
		});

		const contents = await Bun.file(target).text();
		expect(contents).toContain("diagnostic safe=keep-this");
		for (const secret of secrets) expect(contents).not.toContain(secret);
		expect(contents).toContain("«redacted»");
	});

	it("redacts whitespace-separated credential labels", () => {
		const labels = ["API Key", "Private Key", "Secret Access Key"];
		const labeled = labels.map((label, index) => `${label}=opaque-secret-${index}`).join(" ");

		for (const label of labels) expect(isCredentialKey(label)).toBe(true);
		expect(redactCrashSecrets(labeled)).toBe(labels.map(label => `${label}=«redacted»`).join(" "));
		expect(redactCrashSecrets('{"API Key":"opaque-json-api-secret"}')).toBe('{"API Key":"«redacted»"}');
	});

	it("redacts punctuation-bearing unquoted credential values without swallowing following fields", () => {
		expect(redactCrashSecrets("password=correct,horse")).toBe("password=«redacted»");
		expect(redactCrashSecrets("password=correct;horse")).toBe("password=«redacted»");
		expect(redactCrashSecrets("password=correct, token=second-secret note=keep")).toBe(
			"password=«redacted», token=«redacted» note=keep",
		);
	});

	it("redacts unquoted multiword credentials while preserving following fields", () => {
		expect(redactCrashSecrets("password=correct horse battery staple")).toBe("password=«redacted»");
		expect(redactCrashSecrets(`token=secret ${"horse ".repeat(250)}`)).toBe("token=«redacted»");
		expect(redactCrashSecrets("password=correct horse battery staple token=second-secret note=keep")).toBe(
			"password=«redacted» token=«redacted» note=keep",
		);
		expect(redactCrashSecrets("password=correct Secret Access Key=second-secret note=keep")).toBe(
			"password=«redacted» Secret Access Key=«redacted» note=keep",
		);
		expect(redactCrashSecrets("password=opaque-secret status: failed")).toBe("password=«redacted» status: failed");
	});

	it("redacts shell-concatenated suffixes after quoted credentials", () => {
		expect(redactCrashSecrets('password="correct-horse-"battery-staple note=keep')).toBe(
			'password="«redacted»" note=keep',
		);
		expect(redactCrashSecrets("password='correct-horse-'battery-staple status: failed")).toBe(
			"password='«redacted»' status: failed",
		);
	});

	it("redacts suffixes after single-quoted password placeholders", () => {
		for (const placeholder of ["«redacted»", "[REDACTED_TOKEN]"]) {
			expect(redactCrashSecrets(`pw='${placeholder}'tail-secret-123`)).toBe("pw='«redacted»'");
		}
		expect(redactCrashSecrets("pw='[REDACTED_TOKEN]' note=keep")).toBe("pw='[REDACTED_TOKEN]' note=keep");
	});

	it("keeps a standalone redaction placeholder under a sensitive label", () => {
		expect(redactCrashSecrets("+NPM_TOKEN=«redacted-npm-token»\n+x")).toBe("+NPM_TOKEN=«redacted-npm-token»\n+x");
		expect(redactCrashSecrets("+token=[REDACTED_TOKEN]\n+x")).toBe("+token=[REDACTED_TOKEN]\n+x");
		expect(redactCrashSecrets("pw='[REDACTED_SECRET]' a=b")).toBe("pw='[REDACTED_SECRET]' a=b");
		expect(redactCrashSecrets("token=[REDACTED_TOKEN] next=1")).toBe("token=[REDACTED_TOKEN] next=1");
	});

	it("only exempts complete placeholders, not quoted fragments with adjacent suffixes", () => {
		for (const label of ["token", "password", "serviceAccessToken"]) {
			for (const placeholder of ["[REDACTED_TOKEN]", "«redacted-npm-token»"]) {
				for (const delimiter of ['"', "'", "`", '\\"', "\\'", '\\\\"', "\\\\'"]) {
					for (const boundary of ["", " next=1", "\nnext=1", ", next=1", "; next=1", "}"]) {
						const standalone = `${label}=${delimiter}${placeholder}${delimiter}${boundary}`;
						expect(redactCrashSecrets(standalone)).toBe(standalone);
						const input = `${label}=${delimiter}${placeholder}${delimiter}tail-secret-123${boundary}`;
						const expected = `${label}=${delimiter}«redacted»${delimiter}${boundary}`;
						expect(redactCrashSecrets(input)).toBe(expected);
						expect(redactCrashSecrets(expected)).toBe(expected);
					}
				}
				const standalone = `${label}=${placeholder} next=1`;
				expect(redactCrashSecrets(standalone)).toBe(standalone);
				const expected = `${label}=«redacted» next=1`;
				expect(redactCrashSecrets(`${label}=${placeholder}tail-secret-123 next=1`)).toBe(expected);
				expect(redactCrashSecrets(expected)).toBe(expected);
			}
		}
	});

	it("keeps quoted-placeholder boundary punctuation without exempting adjacent credentials", () => {
		for (const label of ["token", "serviceAccessToken"]) {
			for (const placeholder of ["[REDACTED_TOKEN]", "«redacted-npm-token»"]) {
				for (const delimiter of ['"', "'", "`", '\\"', "\\'"]) {
					for (const boundary of [")", ".", ":", ">", "/>", ")."]) {
						const standalone = `${label}=${delimiter}${placeholder}${delimiter}${boundary}`;
						expect(redactCrashSecrets(standalone)).toBe(standalone);
						expect(redactCrashSecrets(`${standalone}tail-secret-123`)).toBe(
							`${label}=${delimiter}«redacted»${delimiter}`,
						);
					}
				}
			}
		}
	});

	it("scrubs placeholder-adjacent suffixes from fatal and handled crash records", async () => {
		for (const write of [recordFatalCrash, recordHandledError]) {
			const target = tempCrashLog();
			const message = 'token="[REDACTED_TOKEN]"tail-secret-123 note=keep';
			expect(write("synthetic-audit", new Error(message), { path: target })).toBe(target);
			const contents = await Bun.file(target).text();
			expect(contents).not.toContain("tail-secret-123");
			expect(contents).toContain('token="«redacted»" note=keep');
		}
	});

	it("still masks a value that only begins with a redaction placeholder", () => {
		for (const input of [
			"token=[REDACTED_TOKEN]tail-secret-123",
			"password=«redacted»xyz-secret",
			"token=[REDACTED_TOKENx]",
		]) {
			const output = redactCrashSecrets(input);
			expect(output).not.toContain("tail-secret-123");
			expect(output).not.toContain("xyz-secret");
			expect(output).not.toContain("TOKENx");
			expect(output).toMatch(/=«redacted»$/);
		}
	});

	it("redacts short values under sensitive labels", async () => {
		const target = tempCrashLog();
		const labeled = [
			"token=abc123",
			"secret=x",
			"credential=123456",
			"private_key=q",
			"private_token=abc123",
			"AWS_SECRET_ACCESS_KEY=x",
			"OPENAI_API_KEY=opaque-openai-key",
			"api_token=opaque-api-token",
			"cookie=z",
			"password=123456",
			"auth=x",
			"bearer=abc123",
			"session_key=opaque-session-key",
			"credentials=opaque-credentials",
			"secrets=opaque-secrets",
		].join(" ");

		recordFatalCrash("Uncaught Exception", new Error(`diagnostic safe=keep-this ${labeled}`), { path: target });

		const contents = await Bun.file(target).text();
		expect(contents).toContain("diagnostic safe=keep-this");
		for (const field of labeled.split(" ")) expect(contents).not.toContain(field);
	});

	it("redacts complete bracketed credential containers", async () => {
		const target = tempCrashLog();
		const message =
			'safe=keep credentials=["alpha","beta"] secrets={primary:alpha,secondary:{nested:[beta]}} metadata=["public"]';

		recordFatalCrash("Uncaught Exception", new Error(message), { path: target });

		const contents = await Bun.file(target).text();
		expect(contents).not.toContain("alpha");
		expect(contents).not.toContain("beta");
		expect(contents).toContain("credentials=«redacted»");
		expect(contents).toContain("secrets=«redacted»");
		expect(contents).toContain('metadata=["public"]');
	});

	it("preserves later diagnostics after an unterminated credential container", () => {
		const input = "safe=keep credentials={secret=abc\nstack frame\nafter=keep";
		expect(redactCrashSecrets(input)).toBe("safe=keep credentials=«redacted»\nstack frame\nafter=keep");
	});

	it("redacts plural cookie containers and camelCase cookie fields", () => {
		expect(isCredentialKey("cookies")).toBe(true);
		expect(isCredentialKey("sessionCookies")).toBe(true);
		const redacted = redactCrashSecrets(
			'{"cookies":[{"name":"session","value":"opaque-cookie-jar-secret"}]} note=keep',
		);
		expect(redacted).not.toContain("opaque-cookie-jar-secret");
		expect(redacted).toContain("«redacted»");
		expect(redacted).toContain("note=keep");
	});

	it("redacts multi-pair values under plural cookie labels", () => {
		const redacted = redactCrashSecrets(
			"cookies=session=topsecret; csrf=alsosecret note=keep\nset_cookies=refresh=opaque-refresh-cookie; xsrf=opaque-xsrf-token",
		);

		expect(redacted).toBe("cookies=«redacted» note=keep\nset_cookies=«redacted»");
		expect(redacted).not.toContain("topsecret");
		expect(redacted).not.toContain("alsosecret");
		expect(redacted).not.toContain("opaque-refresh-cookie");
		expect(redacted).not.toContain("opaque-xsrf-token");
	});

	it("redacts escaped-quoted containers across embedded closing delimiters", () => {
		const serialized = String.raw`credentials={\"primary\":\"alpha}suffix\",\"secondary\":\"beta-secret\"} note=keep`;
		const redacted = redactCrashSecrets(serialized);

		expect(redacted.startsWith("credentials=«redacted»")).toBe(true);
		expect(redacted.endsWith(" note=keep")).toBe(true);
		expect(redacted).not.toContain("alpha}suffix");
		expect(redacted).not.toContain("beta-secret");

		const serializedQuote = String.raw`credentials={\"primary\":\"alpha\\\"}suffix\",\"secondary\":\"beta-secret\"} note=keep`;
		const redactedQuote = redactCrashSecrets(serializedQuote);
		expect(redactedQuote.startsWith("credentials=«redacted»")).toBe(true);
		expect(redactedQuote.endsWith(" note=keep")).toBe(true);
		expect(redactedQuote).not.toContain("beta-secret");

		const serializedSingleQuote = String.raw`credentials=[\'a]x\',\'second-secret\'] note=keep`;
		const redactedSingleQuote = redactCrashSecrets(serializedSingleQuote);
		expect(redactedSingleQuote.startsWith("credentials=«redacted»")).toBe(true);
		expect(redactedSingleQuote.endsWith(" note=keep")).toBe(true);
		expect(redactedSingleQuote).not.toContain("a]x");
		expect(redactedSingleQuote).not.toContain("second-secret");

		for (const value of [serialized, serializedQuote]) {
			const multiplySerialized = redactCrashSecrets(JSON.stringify(value));
			expect(multiplySerialized).not.toContain("beta-secret");
			expect(multiplySerialized).toContain("note=keep");
		}
	});

	it("redacts backtick-quoted containers across embedded closing delimiters", () => {
		const serialized = "credentials={primary:`alpha}suffix`,secondary:`beta-secret`} note=keep";
		const redacted = redactCrashSecrets(serialized);

		expect(redacted).toBe("credentials=«redacted» note=keep");
		expect(redacted).not.toContain("alpha}suffix");
		expect(redacted).not.toContain("beta-secret");

		const escaped = "credentials={primary:\\`a}x\\`,secondary:\\`second-secret\\`} note=keep";
		expect(redactCrashSecrets(escaped)).toBe("credentials=«redacted» note=keep");
	});

	it("redacts credential assignments with raw and escaped backtick-quoted keys", () => {
		expect(redactCrashSecrets("`password`=`raw-key secret`")).toBe("`password`=`«redacted»`");
		expect(redactCrashSecrets("\\`password\\`=\\`escaped-key secret\\`")).toBe("\\`password\\`=\\`«redacted»\\`");
		expect(redactCrashSecrets("`dbPassword`=`raw camel key secret`")).toBe("`dbPassword`=`«redacted»`");
		expect(redactCrashSecrets("\\`dbPassword\\`=\\`escaped camel key secret\\`")).toBe(
			"\\`dbPassword\\`=\\`«redacted»\\`",
		);
		expect(redactCrashSecrets("`credentials`={primary:`container-secret`} note=keep")).toBe(
			"`credentials`=«redacted» note=keep",
		);
		expect(redactCrashSecrets("\\`credentials\\`={primary:\\`escaped-container-secret\\`} note=keep")).toBe(
			"\\`credentials\\`=«redacted» note=keep",
		);
	});

	it("redacts complete Cookie headers and assignments without consuming diagnostics", async () => {
		const target = tempCrashLog();
		const message = [
			"before=keep",
			"Cookie: theme=dark; sid=opaque-cookie-session",
			"after=keep",
			"Cookie: theme=light\\nserialized-after=keep",
			"cookie=session=topsecret; csrf=alsosecret",
			"cookie=session=comma-topsecret, csrf=comma-alsosecret",
			"cookie=session=comma-diagnostic-topsecret, csrf=comma-diagnostic-csrf auth=comma-auth-secret note=keep",
			'cookie=session="part auth=inside"; csrf=alsosecret auth=opaque-auth bearer=opaque-bearer note=keep',
			"set_cookie=refresh=opaque-refresh-cookie; xsrf=opaque-xsrf-token\\nserialized-cookie-after=keep",
		].join("\n");

		recordFatalCrash("Uncaught Exception", new Error(message), { path: target });

		const contents = await Bun.file(target).text();
		expect(contents).not.toContain("theme=dark");
		expect(contents).not.toContain("opaque-cookie-session");
		expect(contents).not.toContain("topsecret");
		expect(contents).not.toContain("alsosecret");
		expect(contents).not.toContain("comma-topsecret");
		expect(contents).not.toContain("comma-alsosecret");
		expect(contents).not.toContain("comma-diagnostic-topsecret");
		expect(contents).not.toContain("comma-diagnostic-csrf");
		expect(contents).not.toContain("comma-auth-secret");
		expect(contents).not.toContain("auth=inside");
		expect(contents).not.toContain("opaque-auth");
		expect(contents).not.toContain("opaque-bearer");
		expect(contents).not.toContain("opaque-refresh-cookie");
		expect(contents).not.toContain("opaque-xsrf-token");
		expect(contents).toContain("Cookie: «redacted»");
		expect(contents).toContain("cookie=«redacted»");
		expect(contents).toContain("cookie=«redacted» auth=«redacted» note=keep");
		expect(contents).toContain("cookie=«redacted» auth=«redacted» bearer=«redacted» note=keep");
		expect(contents).toContain("set_cookie=«redacted»\\nserialized-cookie-after=keep");
		expect(contents).toContain("before=keep");
		expect(contents).toContain("after=keep");
		expect(contents).toContain("Cookie: «redacted»\\nserialized-after=keep");
		expect(contents).toContain("serialized-after=keep");
	});

	it("redacts short credentials following an authorization scheme as one value", () => {
		expect(redactCrashSecrets("authorization: Bearer abc diagnostic=keep")).toBe(
			"authorization: «redacted» diagnostic=keep",
		);
		expect(redactCrashSecrets("authorization: Basic x diagnostic=keep")).toBe(
			"authorization: «redacted» diagnostic=keep",
		);
		expect(redactCrashSecrets("authorization: `Bearer abc`, note=keep")).toBe(
			"authorization: `«redacted»`, note=keep",
		);
		expect(redactCrashSecrets("authorization: \\`Bearer abc def\\`, note=keep")).toBe(
			"authorization: \\`«redacted»\\`, note=keep",
		);
	});

	it("redacts camelCase credential suffixes in labels and values", () => {
		for (const key of [
			"authToken",
			"githubToken",
			"dbPassword",
			"DBPassword",
			"openaiApiKey",
			"openAIApiKey",
			"OpenAIApiKey",
			"stripeSecretKey",
			"awsSecretAccessKey",
			"mySecretAccessKey",
		]) {
			expect(isCredentialKey(key)).toBe(true);
		}
		expect(
			redactCrashSecrets(
				'authToken=opaque-auth-token githubToken="opaque-github-token" dbPassword=opaque-db-password DBPassword=opaque-uppercase-db-password openaiApiKey=opaque-api-key openAIApiKey=opaque-mixed-api-key OpenAIApiKey=opaque-title-api-key stripeSecretKey=opaque-stripe-secret awsSecretAccessKey=opaque-aws-secret mySecretAccessKey=opaque-my-secret',
			),
		).toBe(
			'authToken=«redacted» githubToken="«redacted»" dbPassword=«redacted» DBPassword=«redacted» openaiApiKey=«redacted» openAIApiKey=«redacted» OpenAIApiKey=«redacted» stripeSecretKey=«redacted» awsSecretAccessKey=«redacted» mySecretAccessKey=«redacted»',
		);
		expect(redactCrashSecrets('{"authToken":"opaque-auth-token"}')).toBe('{"authToken":"«redacted»"}');
		expect(redactCrashSecrets("authToken={nested:opaque-secret}")).toBe("authToken=«redacted»");
	});

	it("redacts encryption and signing key fields", () => {
		const keys = ["encryptionKey", "signingKey", "myEncryptionKey", "mySigningKey", "encryption_key", "signing-key"];
		for (const key of keys) expect(isCredentialKey(key)).toBe(true);

		const labeled = keys.map((key, index) => `${key}=opaque-key-${index}`).join(" ");
		expect(redactCrashSecrets(labeled)).toBe(keys.map(key => `${key}=«redacted»`).join(" "));
		expect(redactCrashSecrets('{"encryptionKey":"opaque-json-key"}')).toBe('{"encryptionKey":"«redacted»"}');
	});

	it("redacts Azure Storage account-key field variants", () => {
		const keys = ["AccountKey", "accountKey", "account_key", "account-key", "account.key", "storageAccountKey"];
		for (const key of keys) expect(isCredentialKey(key)).toBe(true);

		const labeled = keys.map((key, index) => `${key}=opaque-account-key-${index}`).join(" ");
		expect(redactCrashSecrets(labeled)).toBe(keys.map(key => `${key}=«redacted»`).join(" "));
		expect(redactCrashSecrets('{"AccountKey":"opaque-json-account-key","account_key":"opaque-json-snake-key"}')).toBe(
			'{"AccountKey":"«redacted»","account_key":"«redacted»"}',
		);
	});

	it("redacts Azure SharedAccessKey connection-string fields", () => {
		const keys = [
			"SharedAccessKey",
			"sharedAccessKey",
			"shared_access_key",
			"shared-access-key",
			"shared.access.key",
		];
		for (const key of keys) expect(isCredentialKey(key)).toBe(true);
		expect(isCredentialKey("SharedAccessKeyName")).toBe(false);

		const connectionString =
			"Endpoint=sb://host/;SharedAccessKeyName=RootManageSharedAccessKey;SharedAccessKey=opaque-secret-123";
		expect(redactCrashSecrets(connectionString)).toBe(
			"Endpoint=sb://host/;SharedAccessKeyName=RootManageSharedAccessKey;SharedAccessKey=«redacted»",
		);
	});

	it("redacts Azure SharedAccessSignature connection-string fields", () => {
		const keys = [
			"SharedAccessSignature",
			"sharedAccessSignature",
			"shared_access_signature",
			"shared-access-signature",
			"shared.access.signature",
		];
		for (const key of keys) expect(isCredentialKey(key)).toBe(true);
		expect(isCredentialKey("SharedAccessSignatureName")).toBe(false);

		const connectionString = "Endpoint=sb://host/;SharedAccessSignature=sv=2026-01-01&sig=opaque-sas-secret&sp=rw";
		expect(redactCrashSecrets(connectionString)).toBe("Endpoint=sb://host/;SharedAccessSignature=«redacted»");
	});

	it("redacts abbreviated password credential fields", () => {
		for (const key of ["pw", "pwd", "dbPw", "dbPwd", "user_pw", "user_pwd"]) {
			expect(isCredentialKey(key)).toBe(true);
		}
		expect(
			redactCrashSecrets(
				"pw=opaque-pw pwd=opaque-pwd dbPw=opaque-db-pw dbPwd=opaque-db-pwd user_pw=opaque-user-pw user_pwd=opaque-user-pwd",
			),
		).toBe("pw=«redacted» pwd=«redacted» dbPw=«redacted» dbPwd=«redacted» user_pw=«redacted» user_pwd=«redacted»");
		expect(redactCrashSecrets('{"dbPwd":"opaque-db-pwd"}')).toBe('{"dbPwd":"«redacted»"}');
	});

	it("redacts password confirmation credential fields", () => {
		const keys = [
			"password_confirmation",
			"password-confirmation",
			"password.confirmation",
			"password confirmation",
			"password_confirm",
			"passwordConfirmation",
			"PasswordConfirmation",
			"passwordConfirm",
			"PasswordConfirm",
		];
		for (const key of keys) expect(isCredentialKey(key)).toBe(true);

		const labeled = keys.map(key => `${key}=opaque-confirmation-secret`).join(" ");
		expect(redactCrashSecrets(labeled)).toBe(keys.map(key => `${key}=«redacted»`).join(" "));
		expect(
			redactCrashSecrets(
				'{"password_confirmation":"opaque-snake-confirmation","passwordConfirmation":"opaque-camel-confirmation"}',
			),
		).toBe('{"password_confirmation":"«redacted»","passwordConfirmation":"«redacted»"}');
	});

	it("recognizes dotted credential-key segments", () => {
		const keys = ["api.key", "client.secret", "db.password", "service.api.key", "aws.secret.access.key"];
		for (const key of keys) expect(isCredentialKey(key)).toBe(true);
		expect(isCredentialKey("client.name")).toBe(false);
		expect(
			redactCrashSecrets(
				'api.key=opaque-api-key client.secret="opaque-client-secret" db.password=opaque-db-password aws.secret.access.key=opaque-aws-secret',
			),
		).toBe('api.key=«redacted» client.secret="«redacted»" db.password=«redacted» aws.secret.access.key=«redacted»');
		expect(redactCrashSecrets('{"client.secret":"opaque-json-secret","note.version":"keep"}')).toBe(
			'{"client.secret":"«redacted»","note.version":"keep"}',
		);
	});

	it("redacts separated and camelCase secret key base fields", () => {
		const keys = ["secret_key_base", "SECRET_KEY_BASE", "secretKeyBase"];
		for (const key of keys) expect(isCredentialKey(key)).toBe(true);
		expect(
			redactCrashSecrets(
				"secret_key_base=opaque-snake-base SECRET_KEY_BASE=opaque-uppercase-base secretKeyBase=opaque-camel-base",
			),
		).toBe("secret_key_base=«redacted» SECRET_KEY_BASE=«redacted» secretKeyBase=«redacted»");
		expect(redactCrashSecrets('{"secretKeyBase":"opaque-json-base"}')).toBe('{"secretKeyBase":"«redacted»"}');
	});

	it("redacts passphrase credential-key variants", () => {
		for (const key of ["passphrase", "sshPassphrase", "key_passphrase", "SSH_PASSPHRASE"]) {
			expect(isCredentialKey(key)).toBe(true);
		}
		expect(
			redactCrashSecrets(
				"passphrase=opaque-passphrase sshPassphrase=opaque-ssh-passphrase key_passphrase=opaque-key-passphrase SSH_PASSPHRASE=opaque-uppercase-passphrase",
			),
		).toBe("passphrase=«redacted» sshPassphrase=«redacted» key_passphrase=«redacted» SSH_PASSPHRASE=«redacted»");
	});

	it("redacts credential keys with multiple camelCase prefix segments", () => {
		const keys = ["gitHubAccessToken", "azureDevOpsToken", "myDatabasePassword", "GoogleCloudSecretKey"];
		for (const key of keys) expect(isCredentialKey(key)).toBe(true);
		expect(
			redactCrashSecrets(
				"gitHubAccessToken=opaque-github-value azureDevOpsToken=opaque-azure-value myDatabasePassword=opaque-database-value GoogleCloudSecretKey=opaque-cloud-value",
			),
		).toBe(
			"gitHubAccessToken=«redacted» azureDevOpsToken=«redacted» myDatabasePassword=«redacted» GoogleCloudSecretKey=«redacted»",
		);
	});

	it("redacts compound camelCase token and client-secret suffixes", () => {
		for (const key of [
			"githubAccessToken",
			"googleRefreshToken",
			"awsSessionToken",
			"oidcIdToken",
			"oauthClientSecret",
		]) {
			expect(isCredentialKey(key)).toBe(true);
		}
		expect(
			redactCrashSecrets(
				"githubAccessToken=opaque-access-token googleRefreshToken=opaque-refresh-token awsSessionToken=opaque-session-token oidcIdToken=opaque-id-token oauthClientSecret=opaque-client-secret",
			),
		).toBe(
			"githubAccessToken=«redacted» googleRefreshToken=«redacted» awsSessionToken=«redacted» oidcIdToken=«redacted» oauthClientSecret=«redacted»",
		);
	});

	it("redacts complete values for nonstandard authorization schemes", () => {
		expect(redactCrashSecrets("Authorization: ApiKey opaque-secret\nnext=keep")).toBe(
			"Authorization: «redacted»\nnext=keep",
		);
		expect(
			redactCrashSecrets('Authorization: Digest username="Mufasa", realm="test", nonce="opaque"\nnext=keep'),
		).toBe("Authorization: «redacted»\nnext=keep");
	});

	it("preserves fields after escaped authorization values in serialized JSON", () => {
		const serialized = String.raw`{\"authorization\":\"Bearer abc\",\"note\":\"keep\"}`;
		const redacted = redactCrashSecrets(serialized);

		expect(redacted).not.toContain("Bearer abc");
		expect(redacted.startsWith(String.raw`{\"authorization\":`)).toBe(true);
		expect(redacted).toContain("«redacted»");
		expect(redacted.endsWith(String.raw`,\"note\":\"keep\"}`)).toBe(true);
	});

	it("preserves diagnostics after escaped quoted values followed by punctuation", () => {
		for (const input of [
			String.raw`call(password=\"secret\") note=keep`,
			String.raw`password=\"secret\": note=keep`,
			String.raw`password=\"secret\". note=keep`,
			String.raw`call(password=\"secret\">) note=keep`,
			String.raw`call(password=\"secret\"/>) note=keep`,
		]) {
			const redacted = redactCrashSecrets(input);
			expect(redacted).not.toContain("secret");
			expect(redacted).toContain("«redacted»");
			expect(redacted).toContain("note=keep");
		}
	});

	it("preserves diagnostics after escaped newlines in authorization headers", () => {
		const escapedLf = redactCrashSecrets(String.raw`Authorization: ApiKey opaque-secret\nnext=keep`);
		expect(escapedLf.startsWith("Authorization: «redacted»")).toBe(true);
		expect(escapedLf.endsWith(String.raw`\nnext=keep`)).toBe(true);
		expect(escapedLf).not.toContain("opaque-secret");

		const escapedCrlf = redactCrashSecrets(String.raw`Authorization: ApiKey opaque-secret\r\nnext=keep`);
		expect(escapedCrlf.startsWith("Authorization: «redacted»")).toBe(true);
		expect(escapedCrlf.endsWith(String.raw`\r\nnext=keep`)).toBe(true);
		expect(escapedCrlf).not.toContain("opaque-secret");
	});

	it("redacts backslash-escaped whitespace in unquoted credential values", () => {
		const input = String.raw`password=correct\ horse\ battery diagnostic=keep`;
		expect(redactCrashSecrets(input)).toBe("password=«redacted» diagnostic=keep");
		expect(redactCrashSecrets(String.raw`authorization: Bearer correct\ horse\ battery diagnostic=keep`)).toBe(
			"authorization: «redacted» diagnostic=keep",
		);
	});

	it("redacts shell-escaped delimiters inside unquoted credential values", () => {
		const input = String.raw`password=correct\;horse api_key=correct\,comma authToken=correct\"quote dbPassword=correct\}brace githubToken=correct\]bracket diagnostic=keep`;
		expect(redactCrashSecrets(input)).toBe(
			"password=«redacted» api_key=«redacted» authToken=«redacted» dbPassword=«redacted» githubToken=«redacted» diagnostic=keep",
		);

		const authorization = redactCrashSecrets(String.raw`authorization: Bearer correct\;horse diagnostic=keep`);
		expect(authorization).toBe("authorization: «redacted» diagnostic=keep");

		const escapedNewline = redactCrashSecrets(String.raw`password=opaque-secret\nnext=keep`);
		expect(escapedNewline.startsWith("password=«redacted»")).toBe(true);
		expect(escapedNewline.endsWith(String.raw`\nnext=keep`)).toBe(true);
		expect(escapedNewline).not.toContain("opaque-secret");
	});

	it("bounds matching work for long non-credential compound keys", () => {
		const longKey = `${"a-".repeat(10_000)}tokenx`;
		const longAcronymKey = `a${"A".repeat(20_000)}x`;
		const longDiagnosticValue = `stderr=${"E".repeat(20_000)}`;
		const input = `${longKey}=public ${longAcronymKey}=public ${longDiagnosticValue}`;
		const startedAt = performance.now();

		expect(isCredentialKey(longKey)).toBe(false);
		expect(isCredentialKey(longAcronymKey)).toBe(false);
		expect(redactCrashSecrets(input)).toBe(input);
		expect(performance.now() - startedAt).toBeLessThan(500);
	});

	it("redacts full quoted credential values that contain spaces", async () => {
		const target = tempCrashLog();
		const message =
			'diagnostic safe=keep-this password="correct horse battery" authorization="Bearer abc" note=keep-this';

		recordFatalCrash("Uncaught Exception", new Error(message), { path: target });

		const contents = await Bun.file(target).text();
		expect(contents).not.toContain("correct horse battery");
		expect(contents).not.toContain("Bearer abc");
		expect(contents).toContain('password="«redacted»"');
		expect(contents).toContain('authorization="«redacted»"');
		expect(contents).toContain("note=keep-this");
	});

	it("redacts backtick-quoted credential values that contain spaces", async () => {
		const target = tempCrashLog();
		const message =
			"diagnostic safe=keep-this password=`correct horse battery` dbPassword=`secondary secret` note=keep-this";

		recordFatalCrash("Uncaught Exception", new Error(message), { path: target });

		const contents = await Bun.file(target).text();
		expect(contents).not.toContain("correct horse battery");
		expect(contents).not.toContain("secondary secret");
		expect(contents).toContain("password=`«redacted»`");
		expect(contents).toContain("dbPassword=`«redacted»`");
		expect(contents).toContain("note=keep-this");
	});

	it("redacts backslash-escaped backtick credential values", () => {
		const input = "password=\\`correct horse battery staple\\` note=keep";
		expect(redactCrashSecrets(input)).toBe("password=\\`«redacted»\\` note=keep");
		expect(redactCrashSecrets("dbPassword=\\`secondary secret\\` note=keep")).toBe(
			"dbPassword=\\`«redacted»\\` note=keep",
		);
		expect(redactCrashSecrets("password=\\`hunter2secret")).toBe("password=\\`«redacted»");
	});

	it("redacts escaped quoted credentials in serialized crash text", async () => {
		const target = tempCrashLog();
		const message = String.raw`diagnostic safe=keep-this password=\"correct horse battery\" payload={\"password\":\"correct horse battery\"} note=keep-this`;

		recordFatalCrash("Uncaught Exception", new Error(message), { path: target });

		const contents = await Bun.file(target).text();
		expect(contents).not.toContain("correct horse battery");
		expect(contents).toContain("«redacted»");
		expect(contents).toContain("payload=");
		expect(contents).toContain("note=keep-this");
	});

	it("redacts unterminated quoted credentials without consuming the next line", async () => {
		for (const credential of [
			'password="hunter2secret',
			String.raw`password=\"hunter2secret`,
			"password=`hunter2secret",
		]) {
			const target = tempCrashLog();
			const message = `${credential}\nsafe-after-newline=keep-this`;

			recordFatalCrash("Uncaught Exception", new Error(message), { path: target });

			const contents = await Bun.file(target).text();
			expect(contents).not.toContain("hunter2secret");
			expect(contents).toContain("«redacted»");
			expect(contents).toContain("safe-after-newline=keep-this");
		}
	});

	it("preserves later diagnostics when quoted credentials are unterminated", () => {
		const rawDouble = `password="secret
stack "frame"
after=keep`;
		const escapedDouble = String.raw`password=\"secret
stack \"frame\"
after=keep`;
		const rawSingle = `password='secret
stack 'frame'
after=keep`;
		const escapedSingle = "password=\\'secret\nstack \\'frame\\'\nafter=keep";
		const rawBacktick = "password=`secret\nstack `frame`\nafter=keep";
		const escapedBacktick = "password=\\`secret\nstack \\`frame\\`\nafter=keep";

		for (const input of [rawDouble, escapedDouble, rawSingle, escapedSingle, rawBacktick, escapedBacktick]) {
			const redacted = redactCrashSecrets(input);
			expect(redacted.split("\n")[1]).toBe(input.split("\n")[1]);
			expect(redacted.split("\n")[2]).toBe("after=keep");
			expect(redacted.split("\n")[0]).toContain("«redacted»");
		}
	});

	it("preserves credential lookalikes outside the supported token boundaries", () => {
		const target = tempCrashLog();
		const lookalikes = [
			"github_pat_short",
			`github_pat_${"A".repeat(19)}`,
			`prefixgithub_pat_${"B".repeat(24)}`,
			`ASIA${"C".repeat(15)}`,
			"SecretAccessKeyId=diagnostic-identifier",
			"SessionTokenCount=12345678",
			"ASessionToken=diagnosticvalue",
			"xSessionToken=diagnosticvalue",
			"_SecretAccessKey=diagnostic-value",
		];

		recordFatalCrash("Uncaught Exception", new Error(`diagnostic context: ${lookalikes.join(" ")}`), {
			path: target,
		});

		const contents = fs.readFileSync(target, "utf8");
		for (const lookalike of lookalikes) expect(contents).toContain(lookalike);
	});

	it("redacts every field of a complete STS credential payload, not just the key id", () => {
		const target = tempCrashLog();
		// A real STS response carries three fields. The `ASIA` id is the least
		// sensitive of them: it is an identifier, while the other two are the
		// actual credential. `secret_key` does not match `SecretAccessKey`
		// (the canonical name has `Access` in the middle) and `access_token`
		// does not match `SessionToken`, so both used to survive verbatim.
		const accessKeyId = "ASIAIOSFODNN7EXAMPLE";
		const secretAccessKey = "wJalrXUtnFEMI7K7MDENGbPxRfiCYEXAMPLEKEY";
		const sessionToken = "FwoGZXIvYXdzEBYaDEXAMPLESESSIONTOKENVALUE1234567890";
		const payload = `{"AccessKeyId":"${accessKeyId}","SecretAccessKey":"${secretAccessKey}","SessionToken":"${sessionToken}"}`;

		recordFatalCrash("Uncaught Exception", new Error(`assume-role failed: ${payload}`), { path: target });

		const contents = fs.readFileSync(target, "utf8");
		expect(contents).toContain("assume-role failed");
		expect(contents).not.toContain(accessKeyId);
		expect(contents).not.toContain(secretAccessKey);
		expect(contents).not.toContain(sessionToken);
		// The field names survive so the record still says which call failed.
		expect(contents).toContain("SecretAccessKey");
		expect(contents).toContain("SessionToken");
	});

	it("redacts the credential shapes the session-import scrubber already lists", async () => {
		const target = tempCrashLog();
		// All synthetic. Each shape is already catalogued by
		// packages/coding-agent/src/session-import/redact.ts; the persisted crash
		// log kept them verbatim because this scrubber never named them.
		const googleApiKey = `AIza${"S".repeat(35)}`;
		const trailingHyphenGoogleApiKey = `AIza${"S".repeat(34)}-`;
		const pemBody = "MIIEowIBAAKCAQEAxGZ0000abcdefgHIJKLmnop";
		// ABIA is the bearer access key id and ACCA the context one; both sit
		// alongside AKIA/ASIA in AWS's own identifier prefix table.
		const bearerAws = "ABIAIOSFODNN7EXAMPLE";
		const contextAws = "ACCAIOSFODNN7EXAMPLE";
		const urlSecret = "s3cr3tvalue";
		const wrappedUrlSecret = "wrapped-s3cr3t";
		const rawAtUrlPassword = "correct@horse";
		const longSchemeUrlPassword = "opaque-database-password";
		const err = new Error(
			[
				`fetch failed: ${googleApiKey} ${trailingHyphenGoogleApiKey}`,
				`${bearerAws} ${contextAws}`,
				`clone: https://deploy:${urlSecret}@git.example.com/x.git`,
				`wrapped: _https://deploy:${wrappedUrlSecret}@git.example.com/x.git_`,
				`raw-at: https://alice:${rawAtUrlPassword}@example.com/repo.git?keep=1`,
				`database: postgresql+asyncpg://alice:${longSchemeUrlPassword}@example.com/db`,
				`-----BEGIN RSA PRIVATE KEY-----\n${pemBody}\n-----END RSA PRIVATE KEY-----`,
			].join(" "),
		);

		recordFatalCrash("Uncaught Exception", err, { path: target });

		const contents = await Bun.file(target).text();
		expect(contents).toContain("fetch failed");
		expect(contents).not.toContain(googleApiKey);
		expect(contents).not.toContain(trailingHyphenGoogleApiKey);
		expect(contents).not.toContain(bearerAws);
		expect(contents).not.toContain(contextAws);
		expect(contents).not.toContain(urlSecret);
		expect(contents).not.toContain(wrappedUrlSecret);
		expect(contents).not.toContain(rawAtUrlPassword);
		expect(contents).not.toContain(longSchemeUrlPassword);
		expect(contents).not.toContain(pemBody);
		expect(contents).toContain("«redacted-google-api-key»");
		expect(contents).toContain("«redacted-private-key»");
		// Scheme and host stay readable so the record still says which remote failed.
		expect(contents).toContain("https://«redacted-url-credential»@git.example.com");
		expect(contents).toContain("_https://«redacted-url-credential»@git.example.com/x.git_");
		expect(contents).toContain("raw-at: https://«redacted-url-credential»@example.com/repo.git?keep=1");
		expect(contents).toContain("postgresql+asyncpg://«redacted-url-credential»@example.com/db");
	});

	it("scans a large credential-free crash body in linear time", () => {
		// The URL rule consumes its left boundary, so a long alphabetic run is
		// attempted once rather than at every suffix. Keep this no-URL body within
		// budget to guard against quadratic rescanning.
		const target = tempCrashLog();
		const startedAt = performance.now();
		recordFatalCrash("Uncaught Exception", new Error("x".repeat(200_000)), { path: target });
		expect(performance.now() - startedAt).toBeLessThan(1_000);
	});

	it("redacts the vendor tokens the Sentry egress guard already refuses", () => {
		const target = tempCrashLog();
		// `crash/upstream/envelope.ts` classifies these five as credential-like and
		// refuses transmission, but that guard covers only the Sentry frame fields.
		// This log is the other durable sink and reaches egress through
		// redactCrashSecrets alone. Fixtures are assembled at runtime so no literal
		// of this shape is committed.
		const npmToken = ["npm", "a".repeat(36)].join("_");
		const gitlabToken = ["glpat", "b".repeat(24)].join("-");
		const stripeKey = ["rk", "test", "c".repeat(24)].join("_");
		const hfToken = ["hf", "d".repeat(34)].join("_");
		const err = new Error(`publish failed: ${npmToken} ${gitlabToken} ${stripeKey} ${hfToken}`);

		recordFatalCrash("Uncaught Exception", err, { path: target });

		const contents = fs.readFileSync(target, "utf8");
		expect(contents).toContain("publish failed");
		for (const secret of [npmToken, gitlabToken, stripeKey, hfToken]) {
			expect(contents).not.toContain(secret);
		}
		expect(contents).toContain("«redacted-npm-token»");
		expect(contents).toContain("«redacted-gitlab-token»");
	});

	it("enforces owner-only permissions on a pre-existing file", () => {
		if (process.platform === "win32") return;
		const target = tempCrashLog();
		fs.mkdirSync(path.dirname(target), { recursive: true });
		fs.writeFileSync(target, "prior content\n", { mode: 0o644 });
		fs.chmodSync(target, 0o644);

		recordFatalCrash("Uncaught Exception", new Error("perm check"), { path: target });

		expect(fs.statSync(target).mode & 0o777).toBe(0o600);
		const contents = fs.readFileSync(target, "utf8");
		expect(contents).toContain("prior content");
		expect(contents).toContain("perm check");
	});

	it("stays bounded when concurrent writers cross the cap simultaneously", () => {
		const target = tempCrashLog();
		const dir = path.dirname(path.dirname(target));
		const writerScript = path.join(dir, "crash-writer.ts");
		fs.writeFileSync(
			writerScript,
			`import { recordFatalCrash } from ${JSON.stringify(POSTMORTEM_SOURCE)};\n` +
				`const target = process.argv[2];\n` +
				`const payload = "y".repeat(48 * 1024);\n` +
				`for (let i = 0; i < 10; i++) recordFatalCrash("Uncaught Exception", new Error(payload + i), { path: target });\n`,
		);
		const writerCount = 6;
		const results = Array.from({ length: writerCount }, () => spawnBun(writerScript, { args: [target] }));
		for (const result of results) expect(result.exitCode).toBe(0);

		// stat-then-append races across processes may overshoot the cap, but only
		// by at most one bounded record per racing writer.
		const sizeAfterRace = fs.statSync(target).size;
		expect(sizeAfterRace).toBeLessThanOrEqual(CRASH_LOG_MAX_BYTES + writerCount * CRASH_RECORD_MAX_BYTES);

		// A subsequent write observes the overshoot, resets, and retains the
		// newest crash within the cap.
		recordFatalCrash("Uncaught Exception", new Error("post-race crash"), { path: target });
		const finalSize = fs.statSync(target).size;
		expect(finalSize).toBeLessThanOrEqual(CRASH_LOG_MAX_BYTES);
		const contents = fs.readFileSync(target, "utf8");
		expect(contents).toContain("post-race crash");
	});

	it("never throws when the target path is unwritable", () => {
		// A path whose parent is an existing file cannot be created as a directory.
		const fileAsParent = tempCrashLog();
		fs.mkdirSync(path.dirname(fileAsParent), { recursive: true });
		fs.writeFileSync(fileAsParent, "i am a file");
		const bogus = path.join(fileAsParent, "nested", "gjc-crash.log");
		const result = recordFatalCrash("Uncaught Exception", new Error("x"), { path: bogus });
		expect(result).toBeUndefined();
	});
});

describe("fatal handler process fixtures", () => {
	function runFatalFixture(body: string): { exitCode: number; stderr: string; crashLog: string } {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-fatal-fixture-"));
		const script = path.join(dir, "fixture.ts");
		fs.writeFileSync(script, `import ${JSON.stringify(POSTMORTEM_SOURCE)};\n${body}\n`);
		const result = spawnBun(script, {
			env: { GJC_CODING_AGENT_DIR: path.join(dir, "agent") },
		});
		return { ...result, crashLog: path.join(dir, "agent", "gjc-crash.log") };
	}

	it("persists an uncaught exception to the crash log before exiting 1", () => {
		const { exitCode, stderr, crashLog } = runFatalFixture(`throw new Error("spawned uncaught boom");`);
		expect(exitCode).toBe(1);
		expect(stderr).toContain("spawned uncaught boom");
		expect(stderr).toContain("crash recorded at");
		const contents = fs.readFileSync(crashLog, "utf8");
		expect(contents).toContain("[Uncaught Exception]");
		expect(contents).toContain("spawned uncaught boom");
	});

	it("persists an unhandled rejection to the crash log before exiting 1", () => {
		const { exitCode, stderr, crashLog } = runFatalFixture(
			`void Promise.reject(new Error("spawned rejection boom"));`,
		);
		expect(exitCode).toBe(1);
		expect(stderr).toContain("spawned rejection boom");
		expect(stderr).toContain("crash recorded at");
		const contents = fs.readFileSync(crashLog, "utf8");
		expect(contents).toContain("[Unhandled Rejection]");
		expect(contents).toContain("spawned rejection boom");
	});
});
