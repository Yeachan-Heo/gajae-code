import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	buildRegistryPackageUrl,
	credentialPrefixes,
	DEFAULT_NPM_REGISTRY,
	type FetchResponseLike,
	fetchLatestPackageVersion,
	NpmRegistryConfigError,
	type NpmRegistryEnvironment,
	parseNpmrc,
	resolveNpmRegistry,
} from "../src/utils/npm-registry";

const HOME = "/home/tester";
const PACKAGE = "@gajae-code/coding-agent";
const userNpmrc = path.join(HOME, ".npmrc");

const tempDirs: string[] = [];

afterEach(async () => {
	await Promise.all(tempDirs.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true })));
});

function environment(options: {
	env?: Record<string, string | undefined>;
	files?: Record<string, string>;
	platform?: NodeJS.Platform;
	installer?: "bun" | "npm";
	npmPath?: string;
}): NpmRegistryEnvironment {
	const files = options.files ?? {};
	const env = options.env ?? {};
	return {
		lookupEnv: name => env[name],
		homeDir: HOME,
		platform: options.platform ?? "darwin",
		installer: options.installer,
		// Pinned so a real npm on the runner cannot leak a machine-wide npmrc in.
		whichExecutable: name => (name === "npm" ? options.npmPath : undefined),
		readFile: async filePath => files[filePath],
	};
}

/** Build a literal `${NAME}` env reference without tripping the template-string lint. */
function envRef(name: string): string {
	return `\${${name}}`;
}

function respond(body: unknown, init: { ok?: boolean; status?: number; statusText?: string } = {}): FetchResponseLike {
	return {
		ok: init.ok ?? true,
		status: init.status ?? 200,
		statusText: init.statusText ?? "OK",
		json: async () => body,
	};
}

async function rejectionMessage(promise: Promise<unknown>): Promise<string> {
	try {
		await promise;
	} catch (err) {
		return err instanceof Error ? err.message : String(err);
	}
	throw new Error("expected the lookup to reject");
}

describe("parseNpmrc", () => {
	it("keeps values containing '=' and strips quotes and full-line comments", () => {
		const values = parseNpmrc(
			[
				"# a comment",
				"; another comment",
				"",
				'registry="https://nexus.example.com/repository/npm-all/"',
				"//nexus.example.com/:_authToken=abc=def==",
				"   spaced   =   value   ",
			].join("\n"),
		);

		expect(values.get("registry")).toBe("https://nexus.example.com/repository/npm-all/");
		expect(values.get("//nexus.example.com/:_authToken")).toBe("abc=def==");
		expect(values.get("spaced")).toBe("value");
		expect(values.has("# a comment")).toBe(false);
	});

	it("truncates an unquoted value at an inline comment, as ini does", () => {
		const values = parseNpmrc(
			["registry=https://nexus.example.com/npm/  # corporate mirror", "other=keep;dropped"].join("\n"),
		);

		expect(values.get("registry")).toBe("https://nexus.example.com/npm/");
		expect(values.get("other")).toBe("keep");
	});

	it("keeps comment characters that are quoted or escaped", () => {
		const values = parseNpmrc(['//host/:_authToken="tok#en"', "//host/:_auth=tok\\#en"].join("\n"));

		expect(values.get("//host/:_authToken")).toBe("tok#en");
		expect(values.get("//host/:_auth")).toBe("tok#en");
	});

	it("expands env references and leaves unknown ones intact", () => {
		const values = parseNpmrc(
			`//host/:_authToken=${envRef("NPM_TOKEN")}\nregistry=https://${envRef("MISSING")}.example.com`,
			name => (name === "NPM_TOKEN" ? "secret-token" : undefined),
		);

		expect(values.get("//host/:_authToken")).toBe("secret-token");
		expect(values.get("registry")).toBe(`https://${envRef("MISSING")}.example.com`);
	});

	it("handles BOM, CRLF, and lines without a key", () => {
		const values = parseNpmrc("\uFEFFregistry=https://a.example.com\r\n=orphan\r\nnot-a-pair\r\n");

		expect(values.get("registry")).toBe("https://a.example.com");
		expect(values.size).toBe(1);
	});

	it("does not promote keys inside an ini section to top-level config", () => {
		// npm parses `[section]` into a nested table and reads only top-level keys,
		// so a sectioned registry must not become the effective registry.
		const values = parseNpmrc(["[ignored]", "registry=https://section.example"].join("\n"));

		expect(values.get("registry")).toBeUndefined();
		expect(values.size).toBe(0);
	});
});

describe("resolveNpmRegistry precedence", () => {
	it("falls back to the public registry when nothing is configured", async () => {
		const resolved = await resolveNpmRegistry(PACKAGE, environment({}));

		expect(resolved.registry).toBe(DEFAULT_NPM_REGISTRY);
		expect(resolved.origin).toBe("default");
		expect(resolved.headers).toEqual({});
	});

	it("uses npm_config_registry from the environment", async () => {
		const resolved = await resolveNpmRegistry(
			PACKAGE,
			environment({ env: { npm_config_registry: "https://nexus.example.com/repository/npm-all/" } }),
		);

		expect(resolved.registry).toBe("https://nexus.example.com/repository/npm-all");
		expect(resolved.origin).toBe("env");
	});

	it("accepts the uppercase NPM_CONFIG_REGISTRY spelling", async () => {
		const resolved = await resolveNpmRegistry(
			PACKAGE,
			environment({ env: { NPM_CONFIG_REGISTRY: "https://nexus.example.com" } }),
		);

		expect(resolved.registry).toBe("https://nexus.example.com");
	});

	it("prefers BUN_CONFIG_REGISTRY over npm_config_registry, which npm run injects transiently", async () => {
		const resolved = await resolveNpmRegistry(
			PACKAGE,
			environment({
				env: {
					npm_config_registry: "https://npm-mirror.example.com",
					BUN_CONFIG_REGISTRY: "https://bun-mirror.example.com",
				},
			}),
		);

		expect(resolved.registry).toBe("https://bun-mirror.example.com");
		// Naming $npm_config_* here would send the user to inspect the wrong variable.
		expect(resolved.source).toBe("$BUN_CONFIG_REGISTRY");
	});

	it("names the exact environment variable that supplied the registry", async () => {
		const resolved = await resolveNpmRegistry(
			PACKAGE,
			environment({ env: { NPM_CONFIG_REGISTRY: "https://nexus.example.com" } }),
		);

		expect(resolved.source).toBe("$NPM_CONFIG_REGISTRY");
	});

	it("finds the machine-wide npmrc on Windows from APPDATA", async () => {
		const resolved = await resolveNpmRegistry(
			PACKAGE,
			environment({
				env: { APPDATA: "C:\\Users\\alice\\AppData\\Roaming" },
				files: {
					[path.join("C:\\Users\\alice\\AppData\\Roaming", "npm", "etc", "npmrc")]:
						"registry=https://windows-global.example.com",
				},
				platform: "win32",
			}),
		);

		expect(resolved.registry).toBe("https://windows-global.example.com");
		expect(resolved.origin).toBe("global");
	});

	it("prefers npm_config_registry when npm is the manager that will install", async () => {
		// The npm-managed update path runs `npm install -g`, which ignores
		// BUN_CONFIG_REGISTRY; preferring it there would make the check disagree
		// with the install this whole module exists to match.
		const resolved = await resolveNpmRegistry(
			PACKAGE,
			environment({
				installer: "npm",
				env: {
					BUN_CONFIG_REGISTRY: "https://bun-mirror.example.com",
					npm_config_registry: "https://npm-mirror.example.com",
				},
			}),
		);

		expect(resolved.registry).toBe("https://npm-mirror.example.com");
		expect(resolved.source).toBe("$npm_config_registry");
	});

	it("prefers BUN_CONFIG_REGISTRY when bun is the manager that will install", async () => {
		const resolved = await resolveNpmRegistry(
			PACKAGE,
			environment({
				installer: "bun",
				env: {
					BUN_CONFIG_REGISTRY: "https://bun-mirror.example.com",
					npm_config_registry: "https://npm-mirror.example.com",
				},
			}),
		);

		expect(resolved.registry).toBe("https://bun-mirror.example.com");
	});

	it("derives the machine-wide npmrc from npm's own prefix", async () => {
		// nvm, fnm, and Volta all put npm outside the fixed /usr/local and /etc
		// paths, so the effective global config has to come from where npm is.
		const resolved = await resolveNpmRegistry(
			PACKAGE,
			environment({
				npmPath: "/nvm/versions/node/v25.1.0/bin/npm",
				files: { "/nvm/versions/node/v25.1.0/etc/npmrc": "registry=https://prefixed.example.com" },
			}),
		);

		expect(resolved.registry).toBe("https://prefixed.example.com");
		expect(resolved.origin).toBe("global");
	});

	it("prefers the environment over the user .npmrc", async () => {
		const resolved = await resolveNpmRegistry(
			PACKAGE,
			environment({
				env: { npm_config_registry: "https://from-env.example.com" },
				files: { [userNpmrc]: "registry=https://from-user.example.com" },
			}),
		);

		expect(resolved.registry).toBe("https://from-env.example.com");
		expect(resolved.origin).toBe("env");
	});

	it("reads the user .npmrc and reports its path as the source", async () => {
		const resolved = await resolveNpmRegistry(
			PACKAGE,
			environment({ files: { [userNpmrc]: "registry=https://from-user.example.com" } }),
		);

		expect(resolved.registry).toBe("https://from-user.example.com");
		expect(resolved.origin).toBe("user");
		expect(resolved.source).toBe(userNpmrc);
	});

	it("ignores an empty npm_config_registry instead of masking the user .npmrc", async () => {
		const resolved = await resolveNpmRegistry(
			PACKAGE,
			environment({
				env: { npm_config_registry: "" },
				files: { [userNpmrc]: "registry=https://from-user.example.com" },
			}),
		);

		expect(resolved.registry).toBe("https://from-user.example.com");
		expect(resolved.origin).toBe("user");
	});

	it("honours npm_config_userconfig, including a ~ prefix", async () => {
		const resolved = await resolveNpmRegistry(
			PACKAGE,
			environment({
				env: { NPM_CONFIG_USERCONFIG: "~/.config/npmrc" },
				files: {
					[path.join(HOME, ".config/npmrc")]: "registry=https://custom-user.example.com",
					[userNpmrc]: "registry=https://home-user.example.com",
				},
			}),
		);

		expect(resolved.registry).toBe("https://custom-user.example.com");
	});

	it("reads the global npmrc from npm_config_globalconfig", async () => {
		const resolved = await resolveNpmRegistry(
			PACKAGE,
			environment({
				env: { npm_config_globalconfig: "/usr/local/etc/npmrc" },
				files: { "/usr/local/etc/npmrc": "registry=https://global.example.com" },
			}),
		);

		expect(resolved.registry).toBe("https://global.example.com");
		expect(resolved.origin).toBe("global");
	});

	it("finds a machine-wide npmrc even when npm did not export its path", async () => {
		const resolved = await resolveNpmRegistry(
			PACKAGE,
			environment({ files: { "/etc/npmrc": "registry=https://provisioned.example.com" } }),
		);

		expect(resolved.registry).toBe("https://provisioned.example.com");
		expect(resolved.origin).toBe("global");
		expect(resolved.source).toBe("/etc/npmrc");
	});

	it("derives the global npmrc from an npm prefix when one is configured", async () => {
		const resolved = await resolveNpmRegistry(
			PACKAGE,
			environment({
				env: { npm_config_prefix: "/opt/node" },
				files: { "/opt/node/etc/npmrc": "registry=https://prefixed.example.com" },
			}),
		);

		expect(resolved.registry).toBe("https://prefixed.example.com");
	});

	it("prefers a scoped registry over the generic one", async () => {
		const resolved = await resolveNpmRegistry(
			PACKAGE,
			environment({
				files: {
					[userNpmrc]: [
						"registry=https://generic.example.com",
						"@gajae-code:registry=https://scoped.example.com",
					].join("\n"),
				},
			}),
		);

		expect(resolved.registry).toBe("https://scoped.example.com");
	});

	it("lets a scoped key in a lower layer beat a generic key in a higher layer, as npm does", async () => {
		const resolved = await resolveNpmRegistry(
			PACKAGE,
			environment({
				env: { npm_config_registry: "https://generic-env.example.com" },
				files: { [userNpmrc]: "@gajae-code:registry=https://scoped-user.example.com" },
			}),
		);

		expect(resolved.registry).toBe("https://scoped-user.example.com");
	});

	it("ignores a scoped registry belonging to another scope", async () => {
		const resolved = await resolveNpmRegistry(
			PACKAGE,
			environment({
				files: {
					[userNpmrc]: ["registry=https://generic.example.com", "@other:registry=https://other.example.com"].join(
						"\n",
					),
				},
			}),
		);

		expect(resolved.registry).toBe("https://generic.example.com");
	});

	it("treats a scopeless name starting with @ as unscoped", async () => {
		const resolved = await resolveNpmRegistry(
			"@scope",
			environment({
				files: {
					[userNpmrc]: ["registry=https://generic.example.com", "@scop:registry=https://wrong.example.com"].join(
						"\n",
					),
				},
			}),
		);

		expect(resolved.registry).toBe("https://generic.example.com");
	});

	it("resolves unscoped package names against the generic registry", async () => {
		const resolved = await resolveNpmRegistry(
			"gajae-code",
			environment({ files: { [userNpmrc]: "registry=https://generic.example.com" } }),
		);

		expect(resolved.registry).toBe("https://generic.example.com");
	});
});

describe("resolveNpmRegistry rejects unusable configuration", () => {
	it("throws rather than silently falling back to the public registry", async () => {
		for (const bad of ["not-a-url", "file:///tmp/registry"]) {
			const failing = resolveNpmRegistry(PACKAGE, environment({ env: { npm_config_registry: bad } }));

			await expect(failing).rejects.toBeInstanceOf(NpmRegistryConfigError);
			await expect(failing).rejects.toThrow(bad);
		}
	});

	it("names the config source so the user knows which file to fix", async () => {
		const failing = resolveNpmRegistry(PACKAGE, environment({ files: { [userNpmrc]: "registry=nonsense" } }));

		await expect(failing).rejects.toThrow(`npm config registry from ${userNpmrc} is not a valid http(s) URL`);
	});

	it("redacts the authority of a scheme-less value so a secret is not echoed", async () => {
		const message = await rejectionMessage(
			resolveNpmRegistry(PACKAGE, environment({ env: { npm_config_registry: "svc-npm:s3cr3t@nexus.example.com" } })),
		);

		expect(message).toContain("nexus.example.com");
		expect(message).not.toContain("s3cr3t");
		expect(message).not.toContain("svc-npm");
	});

	it("refuses to fall back to the public registry when a config file is unreadable", async () => {
		const failing = resolveNpmRegistry(PACKAGE, {
			lookupEnv: () => undefined,
			homeDir: HOME,
			platform: "darwin",
			readFile: async filePath => {
				if (filePath === userNpmrc) throw new Error("EACCES: permission denied");
				return undefined;
			},
		});

		await expect(failing).rejects.toBeInstanceOf(NpmRegistryConfigError);
		await expect(failing).rejects.toThrow("EACCES: permission denied");
	});
});

describe("credentialPrefixes", () => {
	it("walks up the registry path one segment at a time", () => {
		expect(credentialPrefixes("https://nexus.example.com/repository/npm-all")).toEqual([
			"//nexus.example.com/repository/npm-all/",
			"//nexus.example.com/repository/",
			"//nexus.example.com/",
		]);
	});

	it("keeps a non-default port in the host key", () => {
		expect(credentialPrefixes("https://nexus.example.com:8443")).toEqual(["//nexus.example.com:8443/"]);
	});

	it("returns nothing for an unparseable registry", () => {
		expect(credentialPrefixes("nonsense")).toEqual([]);
	});
});

describe("resolveNpmRegistry credentials", () => {
	async function withNpmrc(lines: string[]): Promise<Awaited<ReturnType<typeof resolveNpmRegistry>>> {
		return resolveNpmRegistry(PACKAGE, environment({ files: { [userNpmrc]: lines.join("\n") } }));
	}

	it("attaches a bearer token registered on the exact registry path", async () => {
		const resolved = await withNpmrc([
			"registry=https://nexus.example.com/repository/npm-all/",
			"//nexus.example.com/repository/npm-all/:_authToken=tok-123",
		]);

		expect(resolved.headers).toEqual({ Authorization: "Bearer tok-123" });
	});

	it("finds a token registered on the host root for a path-prefixed registry", async () => {
		const resolved = await withNpmrc([
			"registry=https://nexus.example.com/repository/npm-all/",
			"//nexus.example.com/:_authToken=tok-root",
		]);

		expect(resolved.headers).toEqual({ Authorization: "Bearer tok-root" });
	});

	it("prefers the most specific credential when several match", async () => {
		const resolved = await withNpmrc([
			"registry=https://nexus.example.com/repository/npm-all/",
			"//nexus.example.com/:_authToken=tok-root",
			"//nexus.example.com/repository/npm-all/:_authToken=tok-exact",
		]);

		expect(resolved.headers).toEqual({ Authorization: "Bearer tok-exact" });
	});

	it("never sends credentials belonging to a different host", async () => {
		const resolved = await withNpmrc([
			"registry=https://nexus.example.com/repository/npm-all/",
			"//registry.npmjs.org/:_authToken=npmjs-secret",
			"//evil.example.com/:_authToken=evil-secret",
		]);

		expect(resolved.headers).toEqual({});
	});

	it("does not reuse a host credential across a different port", async () => {
		const resolved = await withNpmrc([
			"registry=https://nexus.example.com:8443/npm/",
			"//nexus.example.com/:_authToken=tok-default-port",
		]);

		expect(resolved.headers).toEqual({});
	});

	it("ignores userinfo when matching, so a token cannot be aimed at another host", async () => {
		const resolved = await withNpmrc([
			"registry=https://nexus.example.com@evil.example.com/",
			"//nexus.example.com/:_authToken=tok-nexus",
		]);

		expect(resolved.registry).toBe("https://evil.example.com");
		expect(resolved.headers).toEqual({});
	});

	it("refuses to downgrade a bearer token onto a plaintext http registry", async () => {
		const resolved = await withNpmrc([
			"registry=http://nexus.example.com/repository/npm-all/",
			"//nexus.example.com/:_authToken=tok-123",
		]);

		expect(resolved.headers).toEqual({});
		expect(resolved.warnings).toEqual([
			"credentials configured for http://nexus.example.com/repository/npm-all were withheld because it is plaintext http",
		]);
	});

	it("says nothing when a plaintext registry has no credentials to withhold", async () => {
		const resolved = await withNpmrc(["registry=http://nexus.example.com/repository/npm-all/"]);

		expect(resolved.headers).toEqual({});
		expect(resolved.warnings).toEqual([]);
	});

	it("does not claim credentials were withheld when none would have been sent", async () => {
		const resolved = await withNpmrc([
			"registry=http://nexus.example.com/repository/npm-all/",
			// No sibling username, so this would never have produced a header anyway.
			"//nexus.example.com/:_password=cGFzcw==",
		]);

		expect(resolved.headers).toEqual({});
		expect(resolved.warnings).toEqual([]);
	});

	it("keeps a percent-encoded username usable instead of throwing a bare URIError", async () => {
		const resolved = await withNpmrc(["registry=https://svc%zz:pw@nexus.example.com/"]);

		expect(resolved.registry).toBe("https://nexus.example.com");
		expect(resolved.headers).toEqual({
			Authorization: `Basic ${Buffer.from("svc%zz:pw").toString("base64")}`,
		});
	});

	it("withholds URL-embedded credentials from a remote plaintext registry", async () => {
		// The userinfo branch used to return before the http check ran, sending
		// Basic auth in cleartext while reporting no warning at all.
		const resolved = await withNpmrc(["registry=http://alice:secret@mirror.example.com/npm"]);

		expect(resolved.headers).toEqual({});
		expect(resolved.warnings.join(" ")).toContain("plaintext http");
	});

	it("still authenticates a loopback registry that carries URL credentials", async () => {
		const resolved = await withNpmrc(["registry=http://alice:secret@localhost:4873/"]);

		expect(resolved.headers).toEqual({
			Authorization: `Basic ${Buffer.from("alice:secret").toString("base64")}`,
		});
	});

	it("still authenticates against a loopback http registry", async () => {
		const resolved = await withNpmrc(["registry=http://localhost:4873/", "//localhost:4873/:_authToken=tok-local"]);

		expect(resolved.headers).toEqual({ Authorization: "Bearer tok-local" });
	});

	it("supports the pre-encoded _auth form", async () => {
		const resolved = await withNpmrc(["registry=https://nexus.example.com", "//nexus.example.com/:_auth=YTpi"]);

		expect(resolved.headers).toEqual({ Authorization: "Basic YTpi" });
	});

	it("builds basic auth from username and base64 _password", async () => {
		const password = Buffer.from("s3cr3t").toString("base64");
		const resolved = await withNpmrc([
			"registry=https://nexus.example.com",
			"//nexus.example.com/:username=alice",
			`//nexus.example.com/:_password=${password}`,
		]);

		expect(resolved.headers).toEqual({
			Authorization: `Basic ${Buffer.from("alice:s3cr3t").toString("base64")}`,
		});
	});

	it("rejects a _password that is not really base64 rather than sending a corrupted header", async () => {
		const resolved = await withNpmrc([
			"registry=https://nexus.example.com",
			"//nexus.example.com/:username=alice",
			"//nexus.example.com/:_password=hunter2!",
		]);

		expect(resolved.headers).toEqual({});
	});

	it("ignores a username without a password", async () => {
		const resolved = await withNpmrc(["registry=https://nexus.example.com", "//nexus.example.com/:username=alice"]);

		expect(resolved.headers).toEqual({});
	});

	it("reads a token supplied through the environment", async () => {
		const resolved = await resolveNpmRegistry(
			PACKAGE,
			environment({
				env: {
					npm_config_registry: "https://nexus.example.com",
					"npm_config_//nexus.example.com/:_authToken": "env-token",
				},
			}),
		);

		expect(resolved.headers).toEqual({ Authorization: "Bearer env-token" });
	});

	it("lifts credentials out of a registry URL instead of leaving them in the request path", async () => {
		const resolved = await withNpmrc(["registry=https://svc-npm:s3cr3t@artifactory.example.com/api/npm/npm/"]);

		expect(resolved.registry).toBe("https://artifactory.example.com/api/npm/npm");
		expect(resolved.headers).toEqual({
			Authorization: `Basic ${Buffer.from("svc-npm:s3cr3t").toString("base64")}`,
		});
	});
});

describe("repository-controlled configuration is not consulted", () => {
	it("ignores npm_config_* when launched by an npm lifecycle", async () => {
		// npm synthesizes npm_config_* from the *project* .npmrc, expanding ${VAR}
		// from the parent environment, so `npm run` inside a cloned repository can
		// hand us an attacker-chosen host carrying a real secret. Excluding the
		// project file layer does not close that door; distrusting the env does.
		const resolved = await resolveNpmRegistry(
			PACKAGE,
			environment({
				env: {
					npm_config_registry: "https://svc:SENTINEL@collect.attacker.example/",
					npm_lifecycle_event: "start",
				},
			}),
		);

		expect(resolved.registry).toBe(DEFAULT_NPM_REGISTRY);
		expect(resolved.headers).toEqual({});
		expect(resolved.warnings.join(" ")).toContain("npm lifecycle");
	});

	it("still honours npm_config_registry outside an npm lifecycle", async () => {
		const resolved = await resolveNpmRegistry(
			PACKAGE,
			environment({ env: { npm_config_registry: "https://mirror.example.com/npm" } }),
		);

		expect(resolved.registry).toBe("https://mirror.example.com/npm");
		expect(resolved.origin).toBe("env");
	});

	it("prefers the user .npmrc over a distrusted lifecycle environment", async () => {
		const resolved = await resolveNpmRegistry(
			PACKAGE,
			environment({
				env: { npm_config_registry: "https://collect.attacker.example/", npm_execpath: "/usr/bin/npm" },
				files: { [userNpmrc]: "registry=https://nexus.example.com/npm" },
			}),
		);

		expect(resolved.registry).toBe("https://nexus.example.com/npm");
		expect(resolved.origin).toBe("user");
	});

	it("never even asks for a .npmrc in the current working directory", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-npmrc-cwd-"));
		tempDirs.push(dir);
		await fs.writeFile(
			path.join(dir, ".npmrc"),
			["registry=https://collect.attacker.example", "//collect.attacker.example/:_authToken=stolen"].join("\n"),
		);

		const requestedPaths: string[] = [];
		const previousCwd = process.cwd();
		process.chdir(dir);
		try {
			const resolved = await resolveNpmRegistry(PACKAGE, {
				lookupEnv: () => undefined,
				homeDir: "/home/nonexistent-tester",
				platform: "darwin",
				readFile: async filePath => {
					requestedPaths.push(filePath);
					return undefined;
				},
			});

			// Asserting the absence of the attempt, not just the absence of an effect:
			// a reintroduced project layer would be wired through this same reader.
			expect(requestedPaths).not.toContain(path.join(dir, ".npmrc"));
			expect(requestedPaths.some(filePath => filePath.startsWith(dir))).toBe(false);
			expect(resolved.registry).toBe(DEFAULT_NPM_REGISTRY);
			expect(resolved.headers).toEqual({});
		} finally {
			process.chdir(previousCwd);
		}
	});

	it("reads the real cwd .npmrc through the shipped reader only if the layer is reintroduced", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-npmrc-cwd-real-"));
		const home = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-npmrc-home-empty-"));
		tempDirs.push(dir, home);
		await fs.writeFile(path.join(dir, ".npmrc"), "registry=https://collect.attacker.example\n");

		const previousCwd = process.cwd();
		process.chdir(dir);
		try {
			// No readFile stub: this exercises the reader that actually ships.
			const resolved = await resolveNpmRegistry(PACKAGE, {
				lookupEnv: () => undefined,
				homeDir: home,
				platform: "win32",
			});

			expect(resolved.registry).toBe(DEFAULT_NPM_REGISTRY);
			expect(resolved.origin).toBe("default");
		} finally {
			process.chdir(previousCwd);
		}
	});
});

describe("buildRegistryPackageUrl", () => {
	it("keeps the scoped package slash unencoded and collapses trailing slashes", () => {
		expect(buildRegistryPackageUrl("https://nexus.example.com/repository/npm-all/", PACKAGE, "latest")).toBe(
			"https://nexus.example.com/repository/npm-all/@gajae-code/coding-agent/latest",
		);
	});

	it("addresses the packument when no spec is given", () => {
		expect(buildRegistryPackageUrl(DEFAULT_NPM_REGISTRY, "gajae-code")).toBe("https://registry.npmjs.org/gajae-code");
	});
});

describe("fetchLatestPackageVersion", () => {
	function lookup(
		options: {
			env?: Record<string, string | undefined>;
			files?: Record<string, string>;
		},
		fetchImpl: (url: string, init?: { headers?: Record<string, string> }) => Promise<FetchResponseLike>,
	) {
		return fetchLatestPackageVersion(PACKAGE, { ...environment(options), fetchImpl });
	}

	it("queries the configured mirror and returns its version", async () => {
		const seen: Array<{ url: string; headers?: Record<string, string> }> = [];
		const result = await lookup(
			{
				files: {
					[userNpmrc]: [
						"registry=https://nexus.example.com/repository/npm-all/",
						"//nexus.example.com/:_authToken=tok-123",
					].join("\n"),
				},
			},
			async (url, init) => {
				seen.push({ url, headers: init?.headers });
				return respond({ version: "0.12.11" });
			},
		);

		expect(result).toEqual({
			version: "0.12.11",
			registry: "https://nexus.example.com/repository/npm-all",
			warnings: [],
		});
		expect(seen).toHaveLength(1);
		expect(seen[0]?.url).toBe("https://nexus.example.com/repository/npm-all/@gajae-code/coding-agent/latest");
		expect(seen[0]?.headers?.Authorization).toBe("Bearer tok-123");
		expect(seen[0]?.headers?.Accept).toContain("application/vnd.npm.install-v1+json");
	});

	it("falls back to the packument when the mirror does not serve the /latest route", async () => {
		const seen: string[] = [];
		const result = await lookup({ env: { npm_config_registry: "https://nexus.example.com/npm" } }, async url => {
			seen.push(url);
			return url.endsWith("/latest")
				? respond(null, { ok: false, status: 404, statusText: "Not Found" })
				: respond({ "dist-tags": { latest: "1.2.3" } });
		});

		expect(result.version).toBe("1.2.3");
		expect(seen).toEqual([
			"https://nexus.example.com/npm/@gajae-code/coding-agent/latest",
			"https://nexus.example.com/npm/@gajae-code/coding-agent",
		]);
	});

	it("reports the original failure when the packument fallback also fails", async () => {
		const failing = lookup({ env: { npm_config_registry: "https://nexus.example.com" } }, async () =>
			respond(null, { ok: false, status: 404, statusText: "Not Found" }),
		);

		await expect(failing).rejects.toThrow(
			"https://nexus.example.com/@gajae-code/coding-agent responded 404 Not Found (registry from $npm_config_registry)",
		);
	});

	it("reports the status, url, and config source when the registry rejects the request", async () => {
		const failing = lookup({ files: { [userNpmrc]: "registry=https://nexus.example.com" } }, async () =>
			respond("<html>blocked</html>", { ok: false, status: 503, statusText: "" }),
		);

		await expect(failing).rejects.toThrow(
			`https://nexus.example.com/@gajae-code/coding-agent/latest responded 503 (registry from ${userNpmrc})`,
		);
	});

	it("names the interception instead of surfacing a bare JSON parse error", async () => {
		const failing = lookup({ files: { [userNpmrc]: "registry=https://nexus.example.com" } }, async () => ({
			ok: true,
			status: 200,
			statusText: "OK",
			json: async () => {
				throw new SyntaxError('JSON Parse error: Unexpected identifier "html"');
			},
		}));

		await expect(failing).rejects.toThrow("returned a non-JSON body");
		await expect(failing).rejects.toThrow("a proxy is probably intercepting this request");
	});

	it("omits the config-source hint when the default registry is used", async () => {
		const message = await rejectionMessage(
			lookup({}, async () => respond(null, { ok: false, status: 500, statusText: "Server Error" })),
		);

		expect(message).toBe("https://registry.npmjs.org/@gajae-code/coding-agent/latest responded 500 Server Error");
	});

	it("reports a timeout as a timeout", async () => {
		const failing = lookup({}, async () => {
			const err = new Error("The operation timed out.");
			err.name = "TimeoutError";
			throw err;
		});

		await expect(failing).rejects.toThrow("request timed out");
	});

	it("never leaks a registry password into the error message", async () => {
		const message = await rejectionMessage(
			lookup(
				{ files: { [userNpmrc]: "registry=https://svc-npm:s3cr3t@artifactory.example.com/api/npm/npm/" } },
				async () => respond(null, { ok: false, status: 401, statusText: "Unauthorized" }),
			),
		);

		expect(message).toContain("artifactory.example.com");
		expect(message).not.toContain("s3cr3t");
		expect(message).not.toContain("svc-npm");
	});

	it("rejects a response without any version field", async () => {
		const failing = lookup({}, async () => respond({ name: PACKAGE }));

		await expect(failing).rejects.toThrow("returned no version");
	});
});

describe("default environment wiring", () => {
	it("reads a real .npmrc from disk through the shipped file reader", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-npmrc-home-"));
		tempDirs.push(dir);
		await fs.writeFile(path.join(dir, ".npmrc"), "registry=https://real-file.example.com\n");

		const resolved = await resolveNpmRegistry(PACKAGE, {
			lookupEnv: () => undefined,
			homeDir: dir,
			platform: "darwin",
		});

		expect(resolved.registry).toBe("https://real-file.example.com");
		expect(resolved.origin).toBe("user");
	});

	it("returns the default registry when the home directory holds no npmrc", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-npmrc-empty-"));
		tempDirs.push(dir);

		const resolved = await resolveNpmRegistry(PACKAGE, {
			lookupEnv: () => undefined,
			homeDir: dir,
			platform: "win32",
		});

		expect(resolved.registry).toBe(DEFAULT_NPM_REGISTRY);
		expect(resolved.origin).toBe("default");
	});
});
