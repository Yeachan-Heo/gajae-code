import { afterEach, describe, expect, it, vi } from "bun:test";
import * as logger from "../src/logger";

afterEach(() => {
	vi.restoreAllMocks();
	logger.setTransports({ console: false, file: false });
});

describe("logger transport suppression", () => {
	it("drops records with no transports and resumes console logging when re-enabled", async () => {
		let stdout = "";
		let stderr = "";
		const stdoutWrite = vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => {
			stdout += String(chunk);
			return true;
		});
		const stderrWrite = vi.spyOn(process.stderr, "write").mockImplementation((chunk: string | Uint8Array) => {
			stderr += String(chunk);
			return true;
		});
		const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

		logger.setTransports({ console: false, file: false });
		logger.warn("suppressed-log-record");
		await Bun.sleep(50);

		expect(stdoutWrite).not.toHaveBeenCalled();
		expect(stderrWrite).not.toHaveBeenCalled();
		expect(consoleError).not.toHaveBeenCalled();

		logger.setTransports({ console: true });
		logger.info("visible-log-record");
		await Bun.sleep(50);

		expect(`${stdout}${stderr}`).toContain("visible-log-record");
	});
});
