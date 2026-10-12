import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { writeCrashReport } from "@gajae-code/coding-agent/debug/crash-diagnostics";

const STDERR_PREVIEW_BYTES = 4096;
const tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-crash-stderr-preview-"));
	tempDirs.push(dir);
	return dir;
}

function tailBytes(value: string, maxBytes: number): string {
	const bytes = Buffer.from(value);
	if (bytes.byteLength <= maxBytes) return value;
	return Buffer.from(bytes.subarray(bytes.byteLength - maxBytes)).toString("utf8");
}

async function persistedPreview(stderr: string, now: string): Promise<string> {
	const dir = await makeTempDir();
	const env = { GJC_CRASH_DIAGNOSTICS: "1", GJC_CRASH_DIAGNOSTICS_DIR: dir } as NodeJS.ProcessEnv;
	const written = await writeCrashReport(
		{ kind: "dap", exitCode: 1, stderr, protocol: "stdio" },
		{ env, cwd: dir, now: new Date(now) },
	);
	expect(written.path).not.toBeNull();
	const report = JSON.parse(await Bun.file(written.path as string).text()) as { stderrPreview?: string };
	expect(report.stderrPreview).toBe(written.report.stderrPreview);
	return report.stderrPreview ?? "";
}

afterEach(async () => {
	for (const dir of tempDirs.splice(0)) {
		await fs.rm(dir, { recursive: true, force: true });
	}
});

describe("crash stderr preview", () => {
	it("redacts a bearer token that the preview window would otherwise keep", async () => {
		const token = "testtokenvalue12345";
		const stderr = `${"x".repeat(6000)}\nBearer ${token}`;
		const preview = await persistedPreview(stderr, "2026-06-04T00:00:10.000Z");
		expect(Buffer.byteLength(preview)).toBeLessThanOrEqual(STDERR_PREVIEW_BYTES);
		expect(preview).not.toContain(token);
		expect(preview).toContain("«redacted-auth»");
	});

	it("keeps an ordinary stderr tail that base already stored", async () => {
		const stderr = `${"y".repeat(6000)}segmentation fault`;
		const preview = await persistedPreview(stderr, "2026-06-04T00:00:11.000Z");
		expect(preview).toBe(tailBytes(stderr, STDERR_PREVIEW_BYTES));
		expect(preview.endsWith("segmentation fault")).toBe(true);
		expect(preview).not.toContain("«redacted");
	});

	it("keeps a short ordinary stderr string unchanged", async () => {
		const stderr = "child ready\n";
		const preview = await persistedPreview(stderr, "2026-06-04T00:00:12.000Z");
		expect(preview).toBe(stderr);
	});
});
