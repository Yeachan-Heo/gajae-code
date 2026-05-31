import { afterEach, describe, expect, it } from "bun:test";
import * as os from "node:os";
import * as path from "node:path";
import { getPackageDir } from "@gajae-code/coding-agent/config";

const ORIGINAL_GJC_PACKAGE_DIR = process.env.GJC_PACKAGE_DIR;
const ORIGINAL_PI_PACKAGE_DIR = process.env.PI_PACKAGE_DIR;

describe("getPackageDir", () => {
	afterEach(() => {
		process.env.GJC_PACKAGE_DIR = ORIGINAL_GJC_PACKAGE_DIR;
		process.env.PI_PACKAGE_DIR = ORIGINAL_PI_PACKAGE_DIR;
	});

	it("prefers GJC_PACKAGE_DIR over legacy PI_PACKAGE_DIR", () => {
		const gjcPackageDir = path.join(os.tmpdir(), "gjc-package-dir");
		const legacyPackageDir = path.join(os.tmpdir(), "legacy-pi-package-dir");

		process.env.GJC_PACKAGE_DIR = gjcPackageDir;
		process.env.PI_PACKAGE_DIR = legacyPackageDir;

		expect(getPackageDir()).toBe(gjcPackageDir);
	});

	it("keeps PI_PACKAGE_DIR as a legacy fallback", () => {
		const legacyPackageDir = path.join(os.tmpdir(), "legacy-pi-package-dir");

		delete process.env.GJC_PACKAGE_DIR;
		process.env.PI_PACKAGE_DIR = legacyPackageDir;

		expect(getPackageDir()).toBe(legacyPackageDir);
	});
});
