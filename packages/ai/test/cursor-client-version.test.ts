import { describe, expect, it } from "bun:test";
import * as path from "node:path";
import { CURSOR_CLIENT_VERSION } from "../src/providers/cursor/client-version";

const srcRoot = path.join(import.meta.dir, "..", "src");
const CLIENT_VERSION_MODULE = path.join("providers", "cursor", "client-version.ts");
const CLIENT_VERSION_LITERAL = /["']cli-\d{4}\.\d{2}\.\d{2}-[0-9a-f]+["']/;

describe("cursor client version", () => {
	it("is a well-formed cli build identifier", () => {
		expect(CURSOR_CLIENT_VERSION).toMatch(/^cli-\d{4}\.\d{2}\.\d{2}-[0-9a-f]+$/);
	});

	it("has a single source of truth across the ai package", async () => {
		// The Cursor backend gates on x-cursor-client-version. A second hardcoded
		// version drifts silently and splits the integration: model discovery
		// keeps working while agent runs fail (or vice versa) once the backend
		// deprecates the older build.
		const offenders: string[] = [];
		const glob = new Bun.Glob("**/*.ts");
		for await (const rel of glob.scan(srcRoot)) {
			if (rel === CLIENT_VERSION_MODULE) continue;
			const text = await Bun.file(path.join(srcRoot, rel)).text();
			if (CLIENT_VERSION_LITERAL.test(text)) {
				offenders.push(rel);
			}
		}
		expect(offenders).toEqual([]);
	});
});
