import { describe, expect, test } from "bun:test";
import {
	assertHeadersAllowed,
	assertMcpInstallPolicy,
	assertUrlAllowed,
	GjcPluginLoadError,
	type GjcPluginMcpManifestEntry,
	isDeniedIpv4,
	isDeniedIpv6,
} from "../src/extensibility/gjc-plugins";

function expectPolicyError(fn: () => unknown): void {
	try {
		fn();
	} catch (error) {
		expect(error).toBeInstanceOf(GjcPluginLoadError);
		expect((error as GjcPluginLoadError).code).toBe("security_policy");
		return;
	}
	throw new Error("Expected security_policy error");
}

describe("GJC MCP policy: URL", () => {
	const denied = [
		"http://example.com/",
		"https://localhost/",
		"https://127.0.0.1/",
		"https://[::1]/",
		"https://10.0.0.1/",
		"https://172.16.5.4/",
		"https://192.168.1.1/",
		"https://169.254.169.254/",
		"https://[fe80::1]/",
		"https://[fc00::1]/",
		"https://user:pass@example.com/",
		"https://localhost./",
		"https://foo.localhost./",
		"https://LOCALHOST/",
		"https://127.0.0.1./",
	];
	for (const url of denied) {
		test(`denies ${url}`, () => {
			expectPolicyError(() => assertUrlAllowed(url));
		});
	}

	test("allows a public https URL", () => {
		expect(assertUrlAllowed("https://docs.example.com/mcp").hostname).toBe("docs.example.com");
	});
});

describe("GJC MCP policy: IP ranges", () => {
	test("ipv4 deny set", () => {
		for (const ip of [
			"127.0.0.1",
			"10.1.2.3",
			"172.16.0.1",
			"172.31.255.255",
			"192.168.0.1",
			"169.254.169.254",
			"0.0.0.0",
			"224.0.0.1",
		]) {
			expect(isDeniedIpv4(ip)).toBe(true);
		}
		expect(isDeniedIpv4("8.8.8.8")).toBe(false);
		expect(isDeniedIpv4("172.32.0.1")).toBe(false);
	});
	test("ipv6 deny set", () => {
		for (const ip of ["::1", "::", "fe80::1", "fc00::1", "fd12::3", "ff02::1", "::ffff:127.0.0.1"]) {
			expect(isDeniedIpv6(ip)).toBe(true);
		}
		expect(isDeniedIpv6("2606:4700:4700::1111")).toBe(false);
	});
});

describe("GJC MCP policy: headers", () => {
	test("rejects CRLF header injection", () => {
		expectPolicyError(() => assertHeadersAllowed({ "X-Evil": "a\r\nInjected: 1" }));
	});
	test("allows clean headers", () => {
		expect(() => assertHeadersAllowed({ Authorization: "Bearer abc" })).not.toThrow();
	});
});

describe("GJC MCP policy: stdio", () => {
	const root = "/tmp/plugin-root";
	function stdio(over: Partial<GjcPluginMcpManifestEntry>): GjcPluginMcpManifestEntry {
		return { name: "s", transport: "stdio", command: "bun", args: ["mcp/server.ts"], cwd: ".", ...over };
	}
	test("allows bun launcher with root-confined script", () => {
		expect(() => assertMcpInstallPolicy(stdio({}), { pluginRoot: root })).not.toThrow();
	});
	test("denies disallowed launcher", () => {
		expectPolicyError(() => assertMcpInstallPolicy(stdio({ command: "/bin/sh" }), { pluginRoot: root }));
	});
	test("denies cwd escape", () => {
		expectPolicyError(() => assertMcpInstallPolicy(stdio({ cwd: "../../etc" }), { pluginRoot: root }));
	});
	test("denies arg path escape", () => {
		expectPolicyError(() => assertMcpInstallPolicy(stdio({ args: ["../../../etc/passwd"] }), { pluginRoot: root }));
	});
	test("denies env expansion in args", () => {
		expectPolicyError(() => assertMcpInstallPolicy(stdio({ args: [`$${"{HOME}"}/x`] }), { pluginRoot: root }));
	});
	test("denies http transport without url", () => {
		expectPolicyError(() => assertMcpInstallPolicy({ name: "h", transport: "http" }, { pluginRoot: root }));
	});
});
