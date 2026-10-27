import { describe, expect, it } from "bun:test";
import path from "node:path";
import { resolvePluginLinkPath } from "../src/extensibility/plugins/plugin-link-path";

const root = path.resolve("/plugins/node_modules");

describe("resolvePluginLinkPath", () => {
	it("keeps an unscoped name and a scoped name inside node_modules", () => {
		expect(resolvePluginLinkPath(root, "local-plugin")).toBe(path.join(root, "local-plugin"));
		expect(resolvePluginLinkPath(root, "@scope/name")).toBe(path.join(root, "@scope", "name"));
	});

	it("rejects a name that leaves the plugins node_modules root", () => {
		expect(() => resolvePluginLinkPath(root, "../../.ssh")).toThrow(/not a safe plugin link path/);
		expect(() => resolvePluginLinkPath(root, "@scope/../../outside")).toThrow(/not a safe plugin link path/);
		expect(() => resolvePluginLinkPath(root, "..")).toThrow(/not a safe plugin link path/);
	});
});
