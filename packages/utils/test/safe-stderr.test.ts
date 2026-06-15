import { afterEach, describe, expect, it } from "bun:test";
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
	});

	it("swallows closed stderr write errors during shutdown diagnostics", () => {
		const calls: string[] = [];
		process.stderr.write = ((chunk: string | Uint8Array) => {
			calls.push(String(chunk));
			throw stderrError("EIO");
		}) satisfies typeof process.stderr.write;

		safeStderrWrite("fatal diagnostic\n");

		expect(calls).toEqual(["fatal diagnostic\n"]);
	});

	it("rethrows unexpected stderr write errors", () => {
		process.stderr.write = (() => {
			throw new RangeError("unexpected stderr failure");
		}) satisfies typeof process.stderr.write;

		expect(() => safeStderrWrite("fatal diagnostic\n")).toThrow(RangeError);
	});
});
