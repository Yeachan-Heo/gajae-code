import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { recordFatalCrash } from "../src/postmortem";

const temporaryRoots: string[] = [];

afterEach(async () => {
	for (const root of temporaryRoots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});

async function crashRecord(reason: unknown): Promise<string> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-postmortem-reason-"));
	temporaryRoots.push(root);
	const target = path.join(root, "crash.log");
	expect(recordFatalCrash("SDK Prompt Failure", reason, { path: target, now: new Date(0) })).toBe(target);
	return fs.readFile(target, "utf8");
}

describe("postmortem observable failure diagnostics", () => {
	it("persists readable fields from a non-Error failure record", async () => {
		const record = await crashRecord({
			phase: "tool_dispatch",
			reason: "worker_exit",
			message: "bash tool worker exited with signal SIGSEGV",
		});
		expect(record).toContain("bash tool worker exited with signal SIGSEGV");
		expect(record).toContain("phase=tool_dispatch");
		expect(record).toContain("reason=worker_exit");
		expect(record).not.toContain("[object Object]");
	});

	it("does not let hostile getters hide the remaining diagnostic", async () => {
		const record = await crashRecord({
			phase: "auth_refresh",
			get message(): string {
				throw new Error("message getter exploded");
			},
			get code(): string {
				throw new Error("code getter exploded");
			},
		});
		expect(record).toContain("phase=auth_refresh");
		expect(record).not.toContain("getter exploded");
		expect(record).not.toContain("[object Object]");
	});

	it("records a failure whose cause is a revoked proxy", async () => {
		const { proxy, revoke } = Proxy.revocable({}, {});
		revoke();
		const record = await crashRecord({ message: "outer failure", cause: proxy });
		expect(record).toContain("outer failure");
	});

	it("redacts credentials before persisting a plain failure record", async () => {
		const record = await crashRecord({
			phase: "provider_request",
			message: "refresh failed: Bearer abcdefghijklmnop and https://user:password@example.com/path",
		});
		expect(record).toContain("«redacted-auth»");
		expect(record).toContain("«redacted-url-credential»");
		expect(record).not.toContain("abcdefghijklmnop");
		expect(record).not.toContain("user:password");
	});
});
