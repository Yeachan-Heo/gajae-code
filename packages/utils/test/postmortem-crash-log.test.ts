import { describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { CRASH_LOG_MAX_BYTES, CRASH_RECORD_MAX_BYTES, recordFatalCrash } from "../src/postmortem";

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

	it("preserves credential lookalikes outside the supported token boundaries", () => {
		const target = tempCrashLog();
		const lookalikes = [
			"github_pat_short",
			`github_pat_${"A".repeat(19)}`,
			`prefixgithub_pat_${"B".repeat(24)}`,
			`ASIA${"C".repeat(15)}`,
			"SecretAccessKeyId=diagnostic-identifier",
			"SessionTokenCount=12345678",
			"mySecretAccessKey=diagnostic-value",
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

describe("multi-line fatal messages", () => {
	// V8's `stack` header spans as many lines as the message does. Dropping a single line left
	// lines 2..N inside the "stack" while the message had already been rendered in full, so a
	// multi-line guard printed its whole body twice on stderr and in the durable record.
	const MULTI_LINE = [
		"worktree_bucket_not_ignored",
		"The GJC launch worktree bucket is inside the repository but is not ignored by Git.",
		'Path: "/tmp/example/.worktrees"',
		"Safe remediation: add /.worktrees to /tmp/example/.gitignore, then relaunch.",
	].join("\n");

	function occurrences(haystack: string, needle: string): number {
		return haystack.split(needle).length - 1;
	}

	it("records each line of a multi-line message exactly once", () => {
		const target = tempCrashLog();

		recordFatalCrash("Uncaught Exception", new Error(MULTI_LINE), { path: target });

		const contents = fs.readFileSync(target, "utf8");
		for (const line of MULTI_LINE.split("\n").slice(1)) {
			expect(occurrences(contents, line)).toBe(1);
		}
		// The real frames must survive the header strip.
		expect(contents).toContain("    at ");
	});

	it("preserves a headerless frame-shaped stack", () => {
		const target = tempCrashLog();
		recordFatalCrash(
			"Uncaught Exception",
			{
				name: "Error",
				message: "boom",
				stack: "    at firstFrame (fixture.ts:1:1)\n    at secondFrame (fixture.ts:2:1)",
			},
			{ path: target },
		);

		const contents = fs.readFileSync(target, "utf8");
		expect(contents).toContain("    at firstFrame (fixture.ts:1:1)");
		expect(contents).toContain("    at secondFrame (fixture.ts:2:1)");
	});

	it("prints each line of a multi-line message exactly once on stderr", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-crash-multiline-"));
		const script = path.join(dir, "throw-multiline.ts");
		fs.writeFileSync(
			script,
			`import ${JSON.stringify(POSTMORTEM_SOURCE)};\nthrow new Error(${JSON.stringify(MULTI_LINE)});\n`,
		);

		const { exitCode, stderr } = spawnBun(script, {
			env: { GJC_CODING_AGENT_DIR: path.join(dir, "agent") },
		});

		expect(exitCode).toBe(1);
		const remediation = "Safe remediation: add /.worktrees to /tmp/example/.gitignore, then relaunch.";
		expect(stderr).toContain(remediation);
		expect(occurrences(stderr, remediation)).toBe(1);
		const contents = fs.readFileSync(path.join(dir, "agent", "gjc-crash.log"), "utf8");
		expect(occurrences(contents, remediation)).toBe(1);
	});
});
