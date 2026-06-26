import { describe, expect, test } from "bun:test";
import {
	assertHeadersAllowed,
	assertMcpInstallPolicy,
	assertUrlAllowed,
	GjcPluginLoadError,
	type GjcPluginLoadErrorCode,
	type GjcPluginMcpManifestEntry,
	type GjcPluginRegistryEntry,
	type NormalizedGjcPluginBundle,
	type NormalizedGjcPluginSurfaces,
	validateInstallPlan,
} from "../src/extensibility/gjc-plugins";

function expectCode(fn: () => unknown, code: GjcPluginLoadErrorCode): void {
	try {
		fn();
	} catch (error) {
		expect(error).toBeInstanceOf(GjcPluginLoadError);
		expect((error as GjcPluginLoadError).code).toBe(code);
		return;
	}
	throw new Error(`Expected ${code}`);
}

function expectSecurityPolicy(fn: () => unknown): void {
	expectCode(fn, "security_policy");
}

function surfaces(over: Partial<NormalizedGjcPluginSurfaces> = {}): NormalizedGjcPluginSurfaces {
	return { subskills: [], tools: [], hooks: [], mcps: [], systemAppendices: [], agentAppendices: [], ...over };
}

function bundle(name: string, s: Partial<NormalizedGjcPluginSurfaces>): NormalizedGjcPluginBundle {
	return {
		name,
		version: "1.0.0",
		root: "/tmp/root",
		manifestPath: "/tmp/root/gajae-plugin.json",
		manifestHash: "a".repeat(64),
		surfaces: surfaces(s),
		files: [],
	};
}

function entry(name: string, s: Partial<NormalizedGjcPluginSurfaces>): GjcPluginRegistryEntry {
	return {
		name,
		version: "1.0.0",
		scope: "project",
		enabled: true,
		pluginRoot: `/tmp/${name}`,
		manifestPath: `/tmp/${name}/gajae-plugin.json`,
		manifestHash: "b".repeat(64),
		source: { kind: "path", uri: `/tmp/${name}`, resolvedAt: new Date().toISOString() },
		installedAt: new Date().toISOString(),
		updatedAt: new Date().toISOString(),
		copiedFiles: [],
		surfaces: surfaces(s),
		disabledSurfaceIds: [],
	};
}

function stdio(over: Partial<GjcPluginMcpManifestEntry>): GjcPluginMcpManifestEntry {
	return { name: "evil", transport: "stdio", command: "bun", args: ["mcp/server.ts"], cwd: ".", ...over };
}

describe("GJC MCP policy Milestone 3 red-team: SSRF URL evasion", () => {
	const deniedUrls = [
		["decimal IPv4 loopback", "https://2130706433/"],
		["hex IPv4 loopback", "https://0x7f.0.0.1/"],
		["octal IPv4 loopback", "https://0177.0.0.1/"],
		["trailing-dot IPv4 loopback", "https://127.0.0.1./"],
		["uppercase localhost", "https://LOCALHOST/"],
		["mixed-case localhost", "https://LocalHost/"],
		["IPv6 zone-id", "https://[fe80::1%25eth0]/"],
		["IPv4-mapped IPv6", "https://[::ffff:127.0.0.1]/"],
		["bracketed IPv6 loopback", "https://[::1]/"],
	] as const;

	for (const [label, url] of deniedUrls) {
		test(`denies ${label}: ${url}`, () => {
			expectSecurityPolicy(() => assertUrlAllowed(url));
		});
	}

	const deniedSchemes = ["ftp://example.com/mcp", "file:///tmp/mcp", "data:text/plain,evil", "javascript:alert(1)"];
	for (const url of deniedSchemes) {
		test(`denies scheme bypass ${url}`, () => {
			expectSecurityPolicy(() => assertUrlAllowed(url));
		});
	}

	test("denies embedded credentials", () => {
		expectSecurityPolicy(() => assertUrlAllowed("https://user:pass@example.com/mcp"));
	});
});

describe("GJC MCP policy Milestone 3 red-team: headers and stdio", () => {
	test("denies CRLF/control characters in header names and values", () => {
		expectSecurityPolicy(() => assertHeadersAllowed({ "X-Good": "ok\r\nX-Injected: yes" }));
		expectSecurityPolicy(() => assertHeadersAllowed({ "X-Bad\nName": "ok" }));
		expectSecurityPolicy(() => assertHeadersAllowed({ "X-Nul": "ok\0no" }));
	});

	const root = "/tmp/plugin-root";
	const deniedLaunchers = [
		["sh", "sh"],
		["bash", "bash"],
		["python", "python"],
		["env", "/usr/bin/env"],
		["absolute path outside root", "/bin/node"],
		["relative parent command", "../bin/server"],
	] as const;

	for (const [label, command] of deniedLaunchers) {
		test(`denies stdio launcher escape: ${label}`, () => {
			expectSecurityPolicy(() => assertMcpInstallPolicy(stdio({ command }), { pluginRoot: root }));
		});
	}

	const deniedArgs = ["../server.ts", "nested/../../../etc/passwd", `$${"{HOME}"}/server.ts`, "$HOME/server.ts"];
	for (const arg of deniedArgs) {
		test(`denies stdio arg traversal/env expansion: ${arg}`, () => {
			expectSecurityPolicy(() => assertMcpInstallPolicy(stdio({ args: [arg] }), { pluginRoot: root }));
		});
	}

	test("denies http transport missing url", () => {
		expectSecurityPolicy(() =>
			assertMcpInstallPolicy({ name: "http-missing", transport: "http" }, { pluginRoot: root }),
		);
	});
});

describe("GJC plugin Milestone 3 red-team: install-time collisions", () => {
	test("duplicate hook key across plugins is denied", () => {
		const hook = {
			extensionId: "hook:preflight",
			name: "preflight",
			event: "install",
			phase: "before" as const,
			relativePath: "hooks/preflight.ts",
			sha256: "c".repeat(64),
		};
		expectCode(
			() => validateInstallPlan(bundle("new", { hooks: [hook] }), [entry("old", { hooks: [hook] })]),
			"duplicate_hook",
		);
	});

	test("duplicate appendix extensionId across plugins is denied", () => {
		const appendix = { extensionId: "system-appendix:shared", name: "shared", contentHash: "d".repeat(64), bytes: 1 };
		expectCode(
			() =>
				validateInstallPlan(bundle("new", { systemAppendices: [appendix] }), [
					entry("old", { agentAppendices: [{ ...appendix, agent: "executor" }] }),
				]),
			"duplicate_appendix",
		);
	});

	test("duplicate subskill activation_arg for same parent across plugins is denied", () => {
		const oldSubskill = {
			extensionId: "subskill:ralplan:planner:design-old",
			name: "design-old",
			description: "old",
			parent: "ralplan",
			phase: "critic",
			activationArg: "design",
			relativePath: "subskills/old/SKILL.md",
			sha256: "e".repeat(64),
		};
		const newSubskill = {
			...oldSubskill,
			extensionId: "subskill:ralplan:planner:design-new",
			phase: "planner",
			relativePath: "subskills/new/SKILL.md",
		};
		expectCode(
			() =>
				validateInstallPlan(bundle("new", { subskills: [newSubskill] }), [
					entry("old", { subskills: [oldSubskill] }),
				]),
			"duplicate_arg",
		);
	});

	test("duplicate subskill parent/phase across plugins is denied", () => {
		const oldSubskill = {
			extensionId: "subskill:executor:prompt:domain-old",
			name: "domain-old",
			description: "old",
			parent: "executor",
			phase: "prompt",
			activationArg: "domain-old",
			relativePath: "subskills/old/SKILL.md",
			sha256: "f".repeat(64),
		};
		const newSubskill = {
			...oldSubskill,
			extensionId: "subskill:executor:prompt:domain-new",
			activationArg: "domain-new",
			relativePath: "subskills/new/SKILL.md",
		};
		expectCode(
			() =>
				validateInstallPlan(bundle("new", { subskills: [newSubskill] }), [
					entry("old", { subskills: [oldSubskill] }),
				]),
			"duplicate_parent_phase",
		);
	});
});
