import { afterEach, describe, expect, it, spyOn, vi } from "bun:test";
import * as fs from "node:fs";
import { safeStderrWrite } from "../src/safe-stderr";

const originalStderrWrite = process.stderr.write.bind(process.stderr);

function stderrError(code: string): Error {
	const error = new Error(`${code} from stderr`);
	Object.defineProperty(error, "code", { value: code });
	return error;
}

describe("safeStderrWrite", () => {
	afterEach(() => {
		process.stderr.write = originalStderrWrite;
		vi.restoreAllMocks();
	});

	it("writes diagnostics through stderr fd", () => {
		const writeSpy = spyOn(fs, "writeSync").mockImplementation((_fd, buffer) => {
			return String(buffer).length;
		});

		safeStderrWrite("fatal diagnostic\n");

		expect(writeSpy).toHaveBeenCalledWith(process.stderr.fd, "fatal diagnostic\n");
	});

	it("swallows closed stderr write errors during shutdown diagnostics", () => {
		const writeSpy = spyOn(fs, "writeSync").mockImplementation(() => {
			throw stderrError("EIO");
		});

		safeStderrWrite("fatal diagnostic\n");

		expect(writeSpy).toHaveBeenCalledWith(process.stderr.fd, "fatal diagnostic\n");
	});

	it("rethrows unexpected stderr write errors", () => {
		spyOn(fs, "writeSync").mockImplementation(() => {
			throw new RangeError("unexpected stderr failure");
		});

		expect(() => safeStderrWrite("fatal diagnostic\n")).toThrow(RangeError);
	});

	it("does not touch a non-writable stderr stream", () => {
		const writeSpy = spyOn(fs, "writeSync");
		const stderr = process.stderr as typeof process.stderr & { writable: boolean };
		const originalWritable = stderr.writable;
		Object.defineProperty(stderr, "writable", { configurable: true, value: false });
		try {
			safeStderrWrite("fatal diagnostic\n");
		} finally {
			Object.defineProperty(stderr, "writable", { configurable: true, value: originalWritable });
		}

		expect(writeSpy).not.toHaveBeenCalled();
	});
});
