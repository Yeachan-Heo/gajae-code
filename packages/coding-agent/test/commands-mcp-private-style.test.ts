import { afterEach, describe, expect, it, mock, vi } from "bun:test";

// The real `../src/cli/mcp-cli` value-imports a config chain that eagerly
// loads the @gajae-code/natives addon (mcp-cli -> config-writer -> config ->
// discovery -> natives). That addon is a prebuilt binary not available in
// every test environment, and `runMCPCommand` is only reached on the
// non-help branch this suite never exercises. Stubbing it keeps the real
// `MCP` command class loadable here so the ES `#private` style contract is
// testable without a working native build.
mock.module("../src/cli/mcp-cli", () => ({
	runMCPCommand: async (): Promise<void> => undefined,
}));

const MCP = (await import("../src/commands/mcp")).default;

const TEST_CONFIG = {
	bin: "gjc",
	version: "0.0.0-test",
	commands: new Map<string, unknown>(),
} as const;

/**
 * AGENTS.md requires ES `#private` fields instead of TypeScript `private`/
 * `protected`/`public` on methods/fields. These tests pin the `MCP` command
 * contract after `printHelp` was converted to `#printHelp`: the class must
 * still instantiate and route `--help`/`-h` through the private help path.
 */
describe("gjc mcp command ES #private style", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("instantiates the MCP command class without throwing", () => {
		const command = new MCP(["--help"], TEST_CONFIG);
		expect(command).toBeInstanceOf(MCP);
		expect(command.argv).toEqual(["--help"]);
	});

	it("writes the standalone MCP help text when --help is passed (exercises #printHelp)", async () => {
		const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
		const command = new MCP(["--help"], TEST_CONFIG);

		await command.run();

		const text = stdout.mock.calls.map(call => String(call[0] ?? "")).join("");
		expect(text).toContain("Store standalone MCP server definitions");
		expect(text).toContain("USAGE");
		expect(text).toContain("$ gjc mcp [add|list|remove]");
		expect(text).toContain("EXAMPLES");
	});

	it("writes the help text when -h shorthand is passed", async () => {
		const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
		const command = new MCP(["-h"], TEST_CONFIG);

		await command.run();

		const text = stdout.mock.calls.map(call => String(call[0] ?? "")).join("");
		expect(text).toContain("Store standalone MCP server definitions");
	});

	it("does not leak printHelp as an own/public property of the instance", () => {
		const command = new MCP(["--help"], TEST_CONFIG);
		// ES private fields live on the instance but are inaccessible from
		// outside the class. `printHelp` must not be a reachable property name.
		expect((command as unknown as Record<string, unknown>).printHelp).toBeUndefined();
	});
});
