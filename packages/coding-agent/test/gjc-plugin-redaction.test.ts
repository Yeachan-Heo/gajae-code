import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { getAgentDir, setAgentDir } from "@gajae-code/utils";
import {
	type GjcPluginRegistryEntry,
	type GjcPluginRegistrySource,
	redactSourceLocator,
	toBundleSummary,
} from "../src/extensibility/gjc-plugins";

const originalAgentDir = getAgentDir();
let agentDir: string;

beforeEach(async () => {
	agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-redaction-agent-"));
	setAgentDir(agentDir);
});

afterEach(async () => {
	setAgentDir(originalAgentDir);
	await fs.rm(agentDir, { recursive: true, force: true });
});

function registryEntry(source: GjcPluginRegistrySource): GjcPluginRegistryEntry {
	return {
		name: "redaction-fixture",
		version: "1.0.0",
		scope: "project",
		enabled: true,
		pluginRoot: "/private/plugin-root",
		manifestPath: "/private/plugin-root/gajae-plugin.json",
		manifestHash: "a".repeat(64),
		source,
		installedAt: "2026-01-01T00:00:00.000Z",
		updatedAt: "2026-01-01T00:00:00.000Z",
		copiedFiles: [],
		surfaces: {
			subskills: [],
			tools: [],
			hooks: [],
			mcps: [],
			systemAppendices: [],
			agentAppendices: [],
		},
		disabledSurfaceIds: [],
	};
}

const forbiddenMaterial = ["token", "user:", "supersecret", "?", "#", "/Users/", "/home/", "C:\\", "\\\\server", ".."];

function expectNoRawMaterial(value: string): void {
	for (const material of forbiddenMaterial) expect(value).not.toContain(material);
}

describe("GJC bundle redaction", () => {
	test("redacts hostile locator forms to host and safe path components", () => {
		const hostileLocators: Array<{ uri: string; expected: string }> = [
			{ uri: "https://user:token@h/o/r.git?a=1#f", expected: "h/o/r" },
			{ uri: "git@h:o/r.git", expected: "h/o/r" },
			{ uri: "ssh://git:supersecret@h:22/o/r.git", expected: "h/o/r" },
			{ uri: "C:\\Users\\me\\bundle", expected: "bundle" },
			{ uri: "\\\\server\\share\\bundle", expected: "server/share/bundle" },
			{ uri: "../../secret/bundle", expected: "bundle" },
			{ uri: "not a locator", expected: "git" },
		];

		for (const { uri, expected } of hostileLocators) {
			const source: GjcPluginRegistrySource = {
				kind: "git",
				uri,
				ref: "refs/heads/x?token=abc",
				sha: "not-a-sha?token",
				resolvedAt: "2026-01-01T00:00:00.000Z",
			};
			const display = redactSourceLocator(source);
			const serializedSummary = JSON.stringify(toBundleSummary(registryEntry(source)));
			expect(display).toBe(expected);
			expectNoRawMaterial(display);
			expectNoRawMaterial(serializedSummary);
		}
	});

	test("omits hostile refs and non-hex revisions from summaries", () => {
		for (const ref of ["refs/heads/x?token=abc", "origin@host", "/Users/me/branch"]) {
			const summary = toBundleSummary(
				registryEntry({
					kind: "git",
					uri: "https://user:token@h/o/r.git?a=1#f",
					ref,
					sha: "sha@host",
					resolvedAt: "2026-01-01T00:00:00.000Z",
				}),
			);
			expect(summary.source.ref).toBeUndefined();
			expect(summary.source.sha).toBeUndefined();
			expectNoRawMaterial(JSON.stringify(summary));
		}

		const summary = toBundleSummary(
			registryEntry({
				kind: "git",
				uri: "https://h/o/r.git",
				ref: "refs/heads/release-1.0",
				sha: "a".repeat(40),
				resolvedAt: "2026-01-01T00:00:00.000Z",
			}),
		);
		expect(summary.source).toMatchObject({ ref: "refs/heads/release-1.0", sha: "a".repeat(40) });
	});
});
