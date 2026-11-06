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

	it("strips control sequences a hostile manifest put in the named field", () => {
		const bundle = "/tmp/probe-bundle";
		const error = new GjcPluginLoadError(
			"unsupported_surface",
			`Unsupported GJC plugin hook field "\x1b[2J\x1b]0;pwned\x07timeout" at ${bundle}/gajae-plugin.json; supported fields are capabilities, event, name, path, phase, sha256, target`,
		);
		const detail = describeBundleInstallFailure(error, bundle);
		expect(detail).toContain("Unsupported GJC plugin hook field");
		// No ESC, CSI, OSC or the BEL that ends it survives into the terminal sink.
		expect(detail).not.toContain("\x1b");
		expect(detail).not.toContain("\x07");
		expect(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/u.test(detail)).toBe(false);
	});

	it("masks the absolute path the loader resolved from a relative spec", () => {
		// A relative spec is resolved before the loader sees it, so the caller's own
		// string does not appear in the message and cannot be the only redaction key.
		const resolved = "/private/tmp/9f3a/private-bundle";
		const error = new GjcPluginLoadError(
			"unsupported_surface",
			`Unsupported GJC plugin hook field "timeout" at ${resolved}/gajae-plugin.json; supported fields are capabilities, event, name, path, phase, sha256, target`,
		);
		const detail = describeBundleInstallFailure(error, "./private-bundle");
		expect(detail).not.toContain("/private/tmp");
		expect(detail).toContain("<path>/gajae-plugin.json");
		expect(detail).toContain("supported fields are");
	});

	it("masks a resolved path that no caller-supplied candidate matched", () => {
		const error = new GjcPluginLoadError("invalid_manifest", "scope root /var/folders/xy/T/gjc-scope is unreadable");
		const detail = describeBundleInstallFailure(error, "/tmp/bundle");
		expect(detail).not.toContain("/var/folders");
		expect(detail).toContain("<path>");
	});
});
