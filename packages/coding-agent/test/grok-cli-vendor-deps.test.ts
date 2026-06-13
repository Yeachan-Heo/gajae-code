import { describe, expect, it } from "bun:test";
import * as path from "node:path";
import { getBundledGrokCliVendorDir } from "../src/defaults/gjc-grok-cli";

describe("bundled Grok CLI vendor dependencies", () => {
	it("does not require runtime npm install from setup defaults", async () => {
		const pkg = (await Bun.file(path.join(getBundledGrokCliVendorDir(), "package.json")).json()) as {
			dependencies?: Record<string, string>;
		};
		expect(pkg.dependencies ?? {}).toEqual({});
	});
});
