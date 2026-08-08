import { describe, expect, it } from "bun:test";
import { CliParseError } from "@gajae-code/utils/cli";
import { parseArgs } from "../../src/cli/args";

describe("--clipboard-transport", () => {
	it("parses each valid value", () => {
		for (const value of ["auto", "native", "osc52", "ssh"] as const) {
			const result = parseArgs(["--clipboard-transport", value]);
			expect(result.clipboardTransport).toBe(value);
		}
	});

	it("rejects a missing value", () => {
		expect(() => parseArgs(["--clipboard-transport"])).toThrow(CliParseError);
		expect(() => parseArgs(["--clipboard-transport"])).toThrow(/requires <auto\|native\|osc52\|ssh>/);
	});

	it("rejects a value that looks like another flag", () => {
		expect(() => parseArgs(["--clipboard-transport", "--clipboard-ssh-host"])).toThrow(CliParseError);
	});

	it("rejects an invalid enum value instead of silently ignoring it", () => {
		expect(() => parseArgs(["--clipboard-transport", "bogus"])).toThrow(CliParseError);
		expect(() => parseArgs(["--clipboard-transport", "bogus"])).toThrow(/invalid --clipboard-transport value/);
	});

	it("supports --clipboard-transport=ssh syntax", () => {
		const result = parseArgs(["--clipboard-transport=ssh"]);
		expect(result.clipboardTransport).toBe("ssh");
	});
});

describe("--clipboard-ssh-host", () => {
	it("parses a bare host alias", () => {
		const result = parseArgs(["--clipboard-ssh-host", "mac"]);
		expect(result.clipboardSshHost).toBe("mac");
	});

	it("rejects a missing value", () => {
		expect(() => parseArgs(["--clipboard-ssh-host"])).toThrow(CliParseError);
		expect(() => parseArgs(["--clipboard-ssh-host"])).toThrow(/requires <alias>/);
	});

	it("rejects a value starting with a dash (argv injection guard at the CLI boundary)", () => {
		expect(() => parseArgs(["--clipboard-ssh-host", "-oProxyCommand=evil"])).toThrow(CliParseError);
	});

	it("rejects a host containing whitespace", () => {
		expect(() => parseArgs(["--clipboard-ssh-host", "mac host"])).toThrow(CliParseError);
	});

	it("accepts dots, dashes, and underscores after the first character", () => {
		const result = parseArgs(["--clipboard-ssh-host", "my-mac_1.local"]);
		expect(result.clipboardSshHost).toBe("my-mac_1.local");
	});
});

describe("combined precedence surface (CLI parse only — settings-level precedence covered in clipboard-transport.test.ts)", () => {
	it("both flags parse independently and don't require each other at parse time", () => {
		const result = parseArgs(["--clipboard-transport", "ssh", "--clipboard-ssh-host", "mac"]);
		expect(result.clipboardTransport).toBe("ssh");
		expect(result.clipboardSshHost).toBe("mac");
	});

	it("--clipboard-transport ssh without --clipboard-ssh-host parses fine (main.ts enforces the requirement, not the parser)", () => {
		const result = parseArgs(["--clipboard-transport", "ssh"]);
		expect(result.clipboardTransport).toBe("ssh");
		expect(result.clipboardSshHost).toBeUndefined();
	});
});
