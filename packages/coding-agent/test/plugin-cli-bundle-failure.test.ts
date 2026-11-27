import { describe, expect, it } from "bun:test";
import { homedir, tmpdir } from "node:os";
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
		const resolved = "/srv/builds/9f3a/private-bundle";
		const error = new GjcPluginLoadError(
			"unsupported_surface",
			`Unsupported GJC plugin hook field "timeout" at ${resolved}/gajae-plugin.json; supported fields are capabilities, event, name, path, phase, sha256, target`,
		);
		const detail = describeBundleInstallFailure(error, "./private-bundle");
		expect(detail).not.toContain("/srv/builds");
		expect(detail).toContain("<path>/gajae-plugin.json");
		expect(detail).toContain("supported fields are");
	});

	it("masks a resolved path that no caller-supplied candidate matched", () => {
		const error = new GjcPluginLoadError(
			"invalid_manifest",
			"Missing GJC plugin file at /var/folders/xy/T/gjc-scope/tools/run.ts",
		);
		const detail = describeBundleInstallFailure(error, "/tmp/bundle");
		expect(detail).not.toContain("/var/folders");
		expect(detail).toBe("invalid_manifest: Missing GJC plugin file at <path>/run.ts");
	});

	// A temp directory whose name contains a space ends a whitespace-delimited token early and
	// leaves the rest of the path visible; the frame ("at … :", "( … )") is what delimits it.
	it.each([
		["a POSIX path with a space", "/srv/customer private/gjc-ab12/pkg", "customer private"],
		["a Windows drive path", "D:\\gjc-temp\\gjc-ab12\\pkg", "gjc-temp"],
		["a Windows drive path with a space", "C:\\Users\\Jane Doe\\AppData\\Local\\Temp\\gjc-ab12\\pkg", "Jane Doe"],
		["a Windows drive path with forward slashes", "C:/Users/Jane Doe/Temp/gjc-ab12/pkg", "Jane Doe"],
		["a UNC path", "\\\\srv\\share\\gjc-ab12\\pkg", "share"],
	])("masks %s the loader embedded around a colon", (_name, dir, leaked) => {
		const sep = dir.includes("\\") ? "\\" : "/";
		const manifest = `${dir}${sep}gajae-plugin.json`;
		for (const message of [
			`Invalid GJC plugin manifest at ${manifest}: expected object`,
			`Unsupported GJC plugin field "x" at hooks[0] (${manifest}); supported fields are a, b`,
			`Unsupported GJC plugin surface in ${manifest}: foo. Known GJC bundle keys: a, b.`,
		]) {
			const detail = describeBundleInstallFailure(
				new GjcPluginLoadError("invalid_manifest", message),
				"/work/bundle",
			);
			expect(detail).not.toContain(leaked);
			expect(detail).not.toContain("gjc-ab12");
			// The explanation around the path survives: only the location is removed.
			expect(detail).toContain("<path>/gajae-plugin.json");
		}
	});

	it("replaces the platform temp root as a whole, so a spaced TMPDIR never leaks", () => {
		const extracted = join(tmpdir(), "gjc-plugin-tar-Ab12Cd", "pkg", "gajae-plugin.json");
		const error = new GjcPluginLoadError(
			"invalid_manifest",
			`Invalid GJC plugin manifest at ${extracted}: expected object`,
		);
		const detail = describeBundleInstallFailure(error, "/work/bundle.tgz");
		expect(detail).toBe(
			"invalid_manifest: Invalid GJC plugin manifest at <tmp>/gjc-plugin-tar-Ab12Cd/pkg/gajae-plugin.json: expected object",
		);
	});

	// The matcher is framed on the loader's own lead-ins, so prose that merely contains a slash,
	// a colon or a drive-like word must come through unchanged.
	it.each([
		"use the loose surface .gjc/hooks/pre/<tool>.ts / .gjc/hooks/post/<tool>.ts.",
		"hooks must be { name, event, path? } and/or a map",
		"see https://example.com/docs/plugins for the schema",
		"expected 1:2 got 3:4 at hooks[0]",
		"field a:b is not allowed",
	])("leaves ordinary prose untouched: %s", message => {
		expect(describeBundleInstallFailure(new GjcPluginLoadError("invalid_manifest", message), "/work/bundle")).toBe(
			`invalid_manifest: ${message}`,
		);
	});
});
