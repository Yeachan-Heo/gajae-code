import { describe, expect, it } from "bun:test";
import { homedir } from "node:os";
import { join } from "node:path";
import { describeBundleInstallFailure } from "../src/cli/plugin-cli";
import { GjcPluginLoadError } from "../src/extensibility/gjc-plugins/types";

describe("bundle install failure detail", () => {
	it("keeps the parser's explanation, relative to the caller's bundle path", () => {
		const bundle = join(homedir(), "work", "probe-bundle");
		const error = new GjcPluginLoadError(
			"unsupported_surface",
			`Unsupported GJC plugin hook field "timeout" at ${bundle}/gajae-plugin.json; supported fields are capabilities, event, name, path, phase, sha256, target`,
		);
		const detail = describeBundleInstallFailure(error, bundle);
		expect(detail).toStartWith(
			'unsupported_surface: Unsupported GJC plugin hook field "timeout" at <bundle>/gajae-plugin.json',
		);
		expect(detail).toContain("supported fields are");
		// The identity policy still holds: neither the caller's path nor the home prefix survives.
		expect(detail).not.toContain(homedir());
		expect(detail).not.toContain(bundle);
	});

	it("collapses whitespace and clamps a huge manifest message", () => {
		const bundle = "/tmp/bundle";
		const error = new GjcPluginLoadError(
			"invalid_manifest",
			`at ${bundle}/gajae-plugin.json:\n\t${"x".repeat(2000)}`,
		);
		const detail = describeBundleInstallFailure(error, bundle);
		expect(detail).toStartWith("invalid_manifest: at <bundle>/gajae-plugin.json: ");
		expect(detail.length).toBeLessThanOrEqual("invalid_manifest: ".length + 400 + 1);
		expect(detail).not.toContain("\n");
	});

	it("keeps the opaque code for anything the loader did not raise", () => {
		expect(describeBundleInstallFailure(new Error("boom at /home/someone"), "/tmp/bundle")).toBe("install_failed");
		expect(describeBundleInstallFailure(new GjcPluginLoadError("unsupported_surface", ""), "/tmp/bundle")).toBe(
			"unsupported_surface",
		);
	});
});
