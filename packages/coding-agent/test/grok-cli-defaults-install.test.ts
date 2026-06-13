import { describe, expect, it } from "bun:test";
import * as path from "node:path";
import {
	assertBundledGrokCliDefaults,
	getBundledGrokBuildExtensionPath,
	getBundledGrokCliModelDefaultsPath,
	getBundledGrokCliVendorDir,
} from "../src/defaults/gjc-grok-cli";

describe("bundled Grok CLI defaults", () => {
	it("fails loud only when the shipped vendor tree is missing", async () => {
		await expect(assertBundledGrokCliDefaults()).resolves.toBeUndefined();
		expect(getBundledGrokBuildExtensionPath().endsWith(path.join("grok-build", "index.ts"))).toBe(true);
		expect(await Bun.file(path.join(getBundledGrokCliVendorDir(), "src", "payload", "sanitize.ts")).exists()).toBe(
			true,
		);
		expect((await Bun.file(getBundledGrokCliModelDefaultsPath()).text()).includes("grok-composer-2.5-fast")).toBe(
			true,
		);
	});
});
