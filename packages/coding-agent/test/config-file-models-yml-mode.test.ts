import { afterEach, describe, expect, it, spyOn } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { ConfigFile } from "@gajae-code/coding-agent/config/config-file";
import { YAML } from "bun";
import fc from "fast-check";
import * as z from "zod/v4";

const HARD_LINK_UNAVAILABLE = ["EACCES", "EISDIR", "ENOSYS", "ENOTSUP", "EOPNOTSUPP", "EPERM", "EXDEV"];

// Mode bits and final-component symlinks are POSIX. Windows ACLs are out of scope.
const skipPosix = process.platform === "win32";
const schema = z.object({}).passthrough();
const roots: string[] = [];

function tempDir(): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-models-yml-"));
	roots.push(dir);
	return dir;
}

afterEach(() => {
	for (const dir of roots.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function writeJson(dir: string, value: unknown): string {
	const jsonPath = path.join(dir, "models.json");
	fs.writeFileSync(jsonPath, JSON.stringify(value));
	return jsonPath;
}

function migrate(ymlPath: string): void {
	new ConfigFile("models", schema, ymlPath);
}

function linkError(code: string): Error {
	const error = new Error(`link ${code}`) as Error & { code: string };
	error.code = code;
	return error;
}

function pathVisible(target: string): boolean {
	try {
		fs.lstatSync(target);
		return true;
	} catch (error) {
		if (error && typeof error === "object" && "code" in error && (error as { code?: string }).code === "ENOENT") {
			return false;
		}
		throw error;
	}
}

describe("models.yml json migration", () => {
	it.skipIf(skipPosix)("writes a migrated models.yml as mode 0600 when umask is 022", () => {
		const dir = tempDir();
		writeJson(dir, { providers: { local: { baseUrl: "http://127.0.0.1:9" } } });
		const ymlPath = path.join(dir, "models.yml");
		const prev = process.umask(0o022);
		try {
			migrate(ymlPath);
		} finally {
			process.umask(prev);
		}
		expect(fs.lstatSync(ymlPath).isSymbolicLink()).toBe(false);
		expect(fs.statSync(ymlPath).mode & 0o777).toBe(0o600);
		expect(YAML.parse(fs.readFileSync(ymlPath, "utf8"))).toEqual({
			providers: { local: { baseUrl: "http://127.0.0.1:9" } },
		});
	});

	it.skipIf(skipPosix)("does not create the target of a dangling models.yml symlink", () => {
		const dir = tempDir();
		writeJson(dir, { secret: "model-key" });
		const ymlPath = path.join(dir, "models.yml");
		const victim = path.join(dir, "victim.yml");
		fs.symlinkSync(victim, ymlPath);
		migrate(ymlPath);
		expect(fs.existsSync(victim)).toBe(false);
		expect(fs.lstatSync(ymlPath).isSymbolicLink()).toBe(true);
	});

	it("still allows creating models.yml from models.json when the yml file is absent", () => {
		const dir = tempDir();
		writeJson(dir, { providers: { local: { baseUrl: "http://127.0.0.1:9" } } });
		const ymlPath = path.join(dir, "models.yml");
		migrate(ymlPath);
		expect(fs.lstatSync(ymlPath).isFile()).toBe(true);
		expect(YAML.parse(fs.readFileSync(ymlPath, "utf8"))).toEqual({
			providers: { local: { baseUrl: "http://127.0.0.1:9" } },
		});
		expect(new ConfigFile("models", schema, ymlPath).load()).toEqual({
			providers: { local: { baseUrl: "http://127.0.0.1:9" } },
		});
	});

	it("still keeps an existing models.yml when models.json is also present", () => {
		const dir = tempDir();
		writeJson(dir, { providers: { replaced: "no" } });
		const ymlPath = path.join(dir, "models.yml");
		const original = "providers:\n  kept: true\n";
		fs.writeFileSync(ymlPath, original);
		migrate(ymlPath);
		expect(fs.readFileSync(ymlPath, "utf8")).toBe(original);
	});

	it.skipIf(skipPosix)("still keeps the target of an existing models.yml symlink", () => {
		const dir = tempDir();
		writeJson(dir, { providers: { replaced: "no" } });
		const target = path.join(dir, "real.yml");
		const original = "providers:\n  kept: true\n";
		fs.writeFileSync(target, original, { mode: 0o640 });
		const ymlPath = path.join(dir, "models.yml");
		fs.symlinkSync(target, ymlPath);
		migrate(ymlPath);
		expect(fs.readFileSync(target, "utf8")).toBe(original);
		expect(fs.lstatSync(ymlPath).isSymbolicLink()).toBe(true);
		expect(fs.statSync(target).mode & 0o777).toBe(0o640);
	});

	it("loads a complete models.yml when a second migration runs during the first write", () => {
		const dir = tempDir();
		const payload = { providers: { local: { baseUrl: "http://127.0.0.1:9" } } };
		writeJson(dir, payload);
		const ymlPath = path.join(dir, "models.yml");
		let enteredDuringWrite = false;
		let destVisibleDuringWrite = false;
		let secondLoad: unknown = "second-did-not-run";
		const originalWrite = fs.writeFileSync.bind(fs);
		const spy = spyOn(fs, "writeFileSync").mockImplementation((...args: Parameters<typeof fs.writeFileSync>) => {
			const file = args[0];
			if (!enteredDuringWrite && typeof file === "number") {
				enteredDuringWrite = true;
				destVisibleDuringWrite = pathVisible(ymlPath);
				secondLoad = new ConfigFile("models", schema, ymlPath).load();
			}
			return originalWrite(...args);
		});
		try {
			const first = new ConfigFile("models", schema, ymlPath);
			expect(enteredDuringWrite).toBe(true);
			expect(destVisibleDuringWrite).toBe(false);
			expect(secondLoad).toEqual(payload);
			expect(first.load()).toEqual(payload);
			expect(YAML.parse(fs.readFileSync(ymlPath, "utf8"))).toEqual(payload);
			expect(fs.readdirSync(dir).filter(name => name.endsWith(".tmp"))).toEqual([]);
		} finally {
			spy.mockRestore();
		}
	});

	it("an interrupted publication does not hide the json source from a later migration", () => {
		const dir = tempDir();
		const payload = { providers: { local: { baseUrl: "http://127.0.0.1:9" } } };
		writeJson(dir, payload);
		const ymlPath = path.join(dir, "models.yml");
		const link = spyOn(fs, "linkSync").mockImplementation(() => {
			const error = new Error("publish interrupted") as Error & { code: string };
			error.code = "EIO";
			throw error;
		});
		try {
			expect(new ConfigFile("models", schema, ymlPath).load()).toBeNull();
			expect(pathVisible(ymlPath)).toBe(false);
			expect(fs.readdirSync(dir).filter(name => name.endsWith(".tmp"))).toEqual([]);
		} finally {
			link.mockRestore();
		}
		expect(new ConfigFile("models", schema, ymlPath).load()).toEqual(payload);
	});

	it("publishes models.yml when hard links are unavailable", () => {
		const dir = tempDir();
		const payload = { providers: { local: { baseUrl: "http://127.0.0.1:9" } } };
		writeJson(dir, payload);
		const ymlPath = path.join(dir, "models.yml");
		const prev = process.umask(0o022);
		const link = spyOn(fs, "linkSync").mockImplementation(() => {
			throw linkError("ENOTSUP");
		});
		try {
			expect(new ConfigFile("models", schema, ymlPath).load()).toEqual(payload);
		} finally {
			process.umask(prev);
			link.mockRestore();
		}
		expect(fs.lstatSync(ymlPath).isSymbolicLink()).toBe(false);
		expect(fs.lstatSync(ymlPath).isFile()).toBe(true);
		if (process.platform !== "win32") expect(fs.statSync(ymlPath).mode & 0o777).toBe(0o600);
		expect(YAML.parse(fs.readFileSync(ymlPath, "utf8"))).toEqual(payload);
		expect(fs.readdirSync(dir).filter(name => name.endsWith(".tmp"))).toEqual([]);
	});

	it("fallback publication does not replace an existing models.yml", () => {
		const dir = tempDir();
		writeJson(dir, { providers: { replaced: "no" } });
		const ymlPath = path.join(dir, "models.yml");
		const original = "providers:\n  kept: true\n";
		let calls = 0;
		const link = spyOn(fs, "linkSync").mockImplementation(() => {
			calls += 1;
			if (!pathVisible(ymlPath)) fs.writeFileSync(ymlPath, original);
			throw linkError("EPERM");
		});
		try {
			migrate(ymlPath);
		} finally {
			link.mockRestore();
		}
		expect(calls).toBeGreaterThan(0);
		expect(fs.readFileSync(ymlPath, "utf8")).toBe(original);
		expect(fs.readdirSync(dir).filter(name => name.endsWith(".tmp"))).toEqual([]);
	});

	it.skipIf(skipPosix)("fallback publication does not follow a dangling models.yml symlink", () => {
		const dir = tempDir();
		writeJson(dir, { secret: "model-key" });
		const ymlPath = path.join(dir, "models.yml");
		const victim = path.join(dir, "victim.yml");
		let calls = 0;
		const link = spyOn(fs, "linkSync").mockImplementation(() => {
			calls += 1;
			if (!pathVisible(ymlPath)) fs.symlinkSync(victim, ymlPath);
			throw linkError("EISDIR");
		});
		try {
			migrate(ymlPath);
		} finally {
			link.mockRestore();
		}
		expect(calls).toBeGreaterThan(0);
		expect(fs.existsSync(victim)).toBe(false);
		expect(fs.lstatSync(ymlPath).isSymbolicLink()).toBe(true);
		expect(fs.readdirSync(dir).filter(name => name.endsWith(".tmp"))).toEqual([]);
	});

	it.skipIf(skipPosix)("publishes through a symlink parent when hard links are unavailable", () => {
		const real = tempDir();
		const alias = path.join(tempDir(), "alias");
		fs.symlinkSync(real, alias, "dir");
		const payload = { providers: { local: { baseUrl: "http://127.0.0.1:9" } } };
		writeJson(real, payload);
		const ymlPath = path.join(alias, "models.yml");
		const prev = process.umask(0o022);
		const link = spyOn(fs, "linkSync").mockImplementation(() => {
			throw linkError("ENOTSUP");
		});
		try {
			expect(new ConfigFile("models", schema, ymlPath).load()).toEqual(payload);
			expect(link).toHaveBeenCalled();
		} finally {
			process.umask(prev);
			link.mockRestore();
		}
		const published = path.join(real, "models.yml");
		expect(fs.lstatSync(published).isFile()).toBe(true);
		expect(fs.lstatSync(published).isSymbolicLink()).toBe(false);
		expect(fs.statSync(published).mode & 0o777).toBe(0o600);
		expect(YAML.parse(fs.readFileSync(published, "utf8"))).toEqual(payload);
		expect(fs.readdirSync(real).filter(name => name.endsWith(".tmp"))).toEqual([]);
	});

	it.skipIf(process.platform !== "win32")(
		"publishes through a junction parent when hard links are unavailable",
		() => {
			const real = tempDir();
			const alias = path.join(tempDir(), "alias");
			fs.symlinkSync(real, alias, "junction");
			const payload = { providers: { local: { baseUrl: "http://127.0.0.1:9" } } };
			writeJson(real, payload);
			const ymlPath = path.join(alias, "models.yml");
			const link = spyOn(fs, "linkSync").mockImplementation(() => {
				throw linkError("EISDIR");
			});
			try {
				expect(new ConfigFile("models", schema, ymlPath).load()).toEqual(payload);
				expect(link).toHaveBeenCalled();
			} finally {
				link.mockRestore();
			}
			expect(fs.lstatSync(path.join(real, "models.yml")).isFile()).toBe(true);
			expect(YAML.parse(fs.readFileSync(ymlPath, "utf8"))).toEqual(payload);
		},
	);

	it("property: only a hard-link-unavailable link error publishes the legacy models", () => {
		fc.assert(
			fc.property(
				fc.string({ minLength: 1, maxLength: 12 }),
				fc.integer({ min: 0, max: HARD_LINK_UNAVAILABLE.length - 1 }),
				fc.boolean(),
				(raw, index, unavailable) => {
					const code = unavailable ? (HARD_LINK_UNAVAILABLE[index] ?? "ENOTSUP") : `Z${raw}`;
					const dir = tempDir();
					const payload = { providers: { local: { baseUrl: "http://127.0.0.1:9", tag: code } } };
					writeJson(dir, payload);
					const ymlPath = path.join(dir, "models.yml");
					const link = spyOn(fs, "linkSync").mockImplementation(() => {
						throw linkError(code);
					});
					try {
						const loaded = new ConfigFile("models", schema, ymlPath).load();
						if (unavailable) {
							expect(loaded).toEqual(payload);
							expect(fs.lstatSync(ymlPath).isFile()).toBe(true);
							expect(fs.lstatSync(ymlPath).isSymbolicLink()).toBe(false);
						} else {
							expect(loaded).toBeNull();
							expect(pathVisible(ymlPath)).toBe(false);
						}
						expect(fs.readdirSync(dir).filter(name => name.endsWith(".tmp"))).toEqual([]);
					} finally {
						link.mockRestore();
					}
				},
			),
			{ seed: 7026, numRuns: 64 },
		);
	});
});
