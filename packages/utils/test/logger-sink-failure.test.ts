import { describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const LOGGER_SOURCE = path.resolve(import.meta.dir, "../src/logger.ts");

function localDateStamp(offsetDays: number): string {
	const date = new Date();
	date.setDate(date.getDate() + offsetDays);
	const pad = (value: number) => String(value).padStart(2, "0");
	return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

describe("logger file sink failure", () => {
	it("keeps the process alive when the log file cannot be opened", async () => {
		// Given a log directory whose dated log file path is occupied by a directory,
		// so the rotating file stream fails its open with EISDIR.
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-logger-sink-failure-"));
		try {
			const logDir = path.join(root, "logs");
			// Cover the neighbouring days so a run that straddles midnight still collides.
			for (const offset of [-1, 0, 1]) {
				fs.mkdirSync(path.join(logDir, `gjc.${localDateStamp(offset)}.log`), { recursive: true });
			}
			const script = path.join(root, "write-log.ts");
			fs.writeFileSync(
				script,
				`import * as logger from ${JSON.stringify(LOGGER_SOURCE)};\n` +
					`logger.setTransports({ file: process.argv[2] });\n` +
					`logger.warn("record for an unopenable sink");\n` +
					`await Bun.sleep(300);\n` +
					`logger.warn("second record after the failed open");\n` +
					`await Bun.sleep(300);\n` +
					`console.log("still-alive");\n`,
			);

			// When a child process logs through that sink.
			const proc = Bun.spawn([process.execPath, script, logDir], { stdout: "pipe", stderr: "pipe" });
			const [exitCode, stdout, stderr] = await Promise.all([
				proc.exited,
				new Response(proc.stdout).text(),
				new Response(proc.stderr).text(),
			]);

			// Then the failed open is dropped instead of crashing the process.
			expect({ exitCode, stdout: stdout.trim(), stderr: stderr.includes("EISDIR") }).toEqual({
				exitCode: 0,
				stdout: "still-alive",
				stderr: false,
			});
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});
});
