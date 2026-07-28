import { describe, expect, test } from "bun:test";
import type { ClientCapabilities } from "@agentclientprotocol/sdk";
import { acpProviderRegistrations } from "../src/modes/acp/acp-agent";

function fsDefinitions(capabilities: ClientCapabilities | undefined): string[] {
	const registration = acpProviderRegistrations(capabilities, {}).find(entry => entry.capability === "fs");
	return ((registration?.definitions ?? []) as Array<{ name: string }>).map(definition => definition.name);
}

describe("ACP fs provider registration", () => {
	test("advertises only the file methods the client declared", () => {
		expect(fsDefinitions({ fs: { readTextFile: true, writeTextFile: false } } as ClientCapabilities)).toEqual([
			"fs.readTextFile",
		]);
		expect(fsDefinitions({ fs: { readTextFile: false, writeTextFile: true } } as ClientCapabilities)).toEqual([
			"fs.writeTextFile",
		]);
		expect(fsDefinitions({ fs: { readTextFile: true, writeTextFile: true } } as ClientCapabilities)).toEqual([
			"fs.readTextFile",
			"fs.writeTextFile",
		]);
	});

	test("registers no fs lease when the client declares neither method", () => {
		expect(
			acpProviderRegistrations({ fs: { readTextFile: false, writeTextFile: false } } as ClientCapabilities, {}).map(
				entry => entry.capability,
			),
		).not.toContain("fs");
		expect(acpProviderRegistrations(undefined, {}).map(entry => entry.capability)).not.toContain("fs");
	});
});
