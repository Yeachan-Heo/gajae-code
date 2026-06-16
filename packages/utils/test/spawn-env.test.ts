import { describe, expect, it } from "bun:test";
import { filterProcessEnv } from "../src/env";

describe("filterProcessEnv spawn hygiene", () => {
	it("drops disabled macOS malloc stack logging variables before spawning children", () => {
		expect(
			filterProcessEnv({
				MallocStackLogging: "0",
				MallocStackLoggingNoCompact: "0",
				KEEP: "value",
			}),
		).toEqual({
			KEEP: "value",
		});
	});
});
