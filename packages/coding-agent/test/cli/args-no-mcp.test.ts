import { describe, expect, it } from "bun:test";
import * as os from "node:os";
import * as path from "node:path";
import { CliParseError } from "@gajae-code/utils/cli";
import { parseArgs } from "../../src/cli/args";

describe("--no-mcp", () => {
	it("parses the opt-out flag", () => {
		const result = parseArgs(["--no-mcp"]);
		expect(result.noMcp).toBe(true);
	});

	it("leaves conventional autoload enabled by default", () => {
		const result = parseArgs([]);
		expect(result.noMcp).toBeUndefined();
	});

	it("rejects --no-mcp combined with --mcp-config", () => {
		const configPath = path.join(os.tmpdir(), "exact.json");
		expect(() => parseArgs(["--no-mcp", "--mcp-config", configPath])).toThrow(CliParseError);
		expect(() => parseArgs(["--no-mcp", "--mcp-config", configPath])).toThrow(/mutually exclusive/);
		expect(() => parseArgs(["--mcp-config", configPath, "--no-mcp"])).toThrow(/mutually exclusive/);
	});

	it("still requires an absolute path for --mcp-config", () => {
		expect(() => parseArgs(["--mcp-config", "relative.json", "--no-mcp"])).toThrow(/requires <absolute-path>/);
	});
});
