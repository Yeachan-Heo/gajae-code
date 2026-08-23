import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { safeRm } from "../../../scripts/safe-cleanup";

/**
 * The account home is the evidence that lets the resolver reject a home the
 * project dotenv could have planted. It is only evidence if it is genuinely
 * independent of the environment (issue #4761, snowykr P2).
 *
 * Reading `/etc/passwd` directly is not sufficient: LDAP- and SSSD-backed
 * accounts have no local passwd entry, so the file read misses them and the
 * resolver falls through to `os.userInfo().homedir`, which Bun derives from
 * `$HOME` — exactly the untrusted value the account lookup exists to avoid.
 * `getent passwd` is the NSS front end and resolves local and directory-backed
 * accounts alike.
 *
 * These run out of process because the property under test is what the resolver
 * does with a hostile environment it inherited at startup.
 */

const DIRS = path.join(import.meta.dir, "..", "src", "dirs.ts");

/** Patched copies of `dirs.ts`; they must sit beside the original so its relative imports resolve. */
const scratch: string[] = [];

/** A temporary directory, created portably and removed after the test. */
async function tempDir(): Promise<string> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-account-home-"));
	scratch.push(dir);
	return dir;
}

afterEach(async () => {
	await Promise.all(scratch.splice(0).map(entry => safeRm(entry, { recursive: true, force: true })));
});

/** Resolve the trusted home in a child process under a controlled environment. */
async function resolveWith(env: Record<string, string | undefined>, cwd = import.meta.dir): Promise<string> {
	const childEnv: Record<string, string> = {};
	for (const [key, value] of Object.entries(process.env)) {
		if (value !== undefined) childEnv[key] = value;
	}
	for (const [key, value] of Object.entries(env)) {
		if (value === undefined) delete childEnv[key];
		else childEnv[key] = value;
	}
	const source = `import { getTrustedHomeDir } from ${JSON.stringify(DIRS)};\nconsole.log(getTrustedHomeDir());`;
	const proc = Bun.spawn([process.execPath, "-e", source], { cwd, env: childEnv, stdout: "pipe", stderr: "pipe" });
	const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
	const exitCode = await proc.exited;
	if (exitCode !== 0) throw new Error(`probe failed (${exitCode}): ${stderr}`);
	return stdout.trim().split("\n").at(-1) ?? "";
}

/**
 * The account home as NSS reports it, independent of any environment variable.
 *
 * Returns `undefined` when NSS cannot answer, including when `getent` is absent
 * entirely: `Bun.spawn` *throws* on a missing executable rather than returning a
 * non-zero exit, so a minimal or distroless host would otherwise fail this suite
 * instead of skipping the assertions that need an account entry.
 */
async function nssHome(): Promise<string | undefined> {
	try {
		const proc = Bun.spawn(["getent", "passwd", String(os.userInfo().uid)], { stdout: "pipe", stderr: "ignore" });
		const stdout = await new Response(proc.stdout).text();
		if ((await proc.exited) !== 0) return undefined;
		const home = stdout.split("\n")[0]?.split(":")[5];
		return home && path.isAbsolute(home) ? home : undefined;
	} catch {
		return undefined;
	}
}

interface UidCacheProbeResult {
	first: string;
	uidB: string[];
	uidAAgain: string;
	uidAAfterMappingChange: string;
	nssCalls: number;
}

/** Exercise the cache with a deterministic NSS/identity seam in a child process. */
async function runUidCacheProbe(homeA: string, homeAAfterMappingChange: string): Promise<UidCacheProbeResult> {
	const source = await Bun.file(DIRS).text();
	const identityStart = source.indexOf("function accountIdentity");
	const nssCommentStart = source.indexOf("/** The uid's home field", identityStart);
	const nssStart = source.indexOf("function nssAccountHome", nssCommentStart);
	const accountStart = source.indexOf("function accountHomeFromSystem", nssStart);
	expect(identityStart).toBeGreaterThanOrEqual(0);
	expect(nssCommentStart).toBeGreaterThan(identityStart);
	expect(nssStart).toBeGreaterThan(nssCommentStart);
	expect(accountStart).toBeGreaterThan(nssStart);

	const identityReplacement = `function accountIdentity(info: os.UserInfo): AccountIdentity {
	const uid = Number(process.env.GJC_TEST_EFFECTIVE_UID ?? info.uid);
	return { key: \`${process.platform}:uid=\${uid}:user=\${info.username}\`, uid };
	}

	`;
	const withIdentitySeam = source.slice(0, identityStart) + identityReplacement + source.slice(nssCommentStart);
	const nssReplacement = `function nssAccountHome(uid: number): string | undefined {
	const state = globalThis as typeof globalThis & { GJC_TEST_NSS_CALLS?: number };
	state.GJC_TEST_NSS_CALLS = (state.GJC_TEST_NSS_CALLS ?? 0) + 1;
	return usableHome(process.env[\`GJC_TEST_NSS_HOME_\${uid}\`]);
	}

	`;
	const patched =
		withIdentitySeam.slice(0, withIdentitySeam.indexOf("function nssAccountHome")) +
		nssReplacement +
		withIdentitySeam.slice(withIdentitySeam.indexOf("function accountHomeFromSystem"));
	const patchedPath = path.join(path.dirname(DIRS), `dirs-uid-cache-${Bun.randomUUIDv7()}.ts`);
	scratch.push(patchedPath);
	await Bun.write(patchedPath, patched);

	const project = await tempDir();
	await Bun.write(path.join(project, ".env"), "HOME=$GJC_TEST_RUNTIME_HOME\n");
	const probePath = path.join(project, "uid-cache-probe.ts");
	await Bun.write(
		probePath,
		[
			`import { getTrustedHomeDir } from ${JSON.stringify(patchedPath)};`,
			"const state = globalThis as typeof globalThis & { GJC_TEST_NSS_CALLS?: number };",
			'const read = () => { try { return getTrustedHomeDir(); } catch (error) { if (String(error).includes("no trustworthy home directory")) return "REFUSED"; throw error; } };',
			"const first = read();",
			'process.env.GJC_TEST_EFFECTIVE_UID = "2001";',
			"const uidB = await Promise.all([Promise.resolve().then(read), Promise.resolve().then(read)]);",
			'process.env.GJC_TEST_EFFECTIVE_UID = "1000";',
			"const uidAAgain = read();",
			`process.env.GJC_TEST_NSS_HOME_1000 = ${JSON.stringify(homeAAfterMappingChange)};`,
			"const uidAAfterMappingChange = read();",
			"console.log(JSON.stringify({ first, uidB, uidAAgain, uidAAfterMappingChange, nssCalls: state.GJC_TEST_NSS_CALLS ?? 0 }));",
		].join("\n"),
	);

	const env: Record<string, string> = {};
	for (const [key, value] of Object.entries(process.env)) {
		if (value !== undefined) env[key] = value;
	}
	env.HOME = await tempDir();
	env.GJC_TEST_RUNTIME_HOME = env.HOME;
	env.GJC_TEST_EFFECTIVE_UID = "1000";
	env.GJC_TEST_NSS_HOME_1000 = homeA;
	delete env.GJC_TEST_NSS_HOME_2001;
	const proc = Bun.spawn([process.execPath, probePath], { cwd: project, env, stdout: "pipe", stderr: "pipe" });
	const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
	const exitCode = await proc.exited;
	if (exitCode !== 0) throw new Error(`uid cache probe failed (${exitCode}): ${stderr}`);
	return JSON.parse(stdout.trim().split("\n").at(-1) ?? "{}") as UidCacheProbeResult;
}

/**
 * Report why a case cannot run here instead of passing vacuously. A silent
 * `return` is indistinguishable from a real assertion in CI output.
 */
function skip(reason: string): void {
	console.warn(`SKIP: ${reason}`);
}

describe("account home is resolved through the OS account database", () => {
	const itLinux = it.skipIf(process.platform !== "linux");

	itLinux("scopes NSS cache entries by effective UID and never leaks across transitions", async () => {
		const homeA = await tempDir();
		const homeAAfterMappingChange = await tempDir();
		const result = await runUidCacheProbe(homeA, homeAAfterMappingChange);

		expect(result.first).toBe(homeA);
		expect(result.uidB).toEqual(["REFUSED", "REFUSED"]);
		expect(result.uidAAgain).toBe(homeA);
		// A's cached NSS answer is safely reused after B fails; the changed mapping
		// must not alter A's already-established per-UID result.
		expect(result.uidAAfterMappingChange).toBe(homeA);
		// One initial A lookup plus both concurrent failed B lookups; no lookup for
		// A after the identity returns, proving the cache is per identity.
		expect(result.nssCalls).toBe(3);
	});

	itLinux("reports the same home NSS does, not the inherited environment", async () => {
		const account = await nssHome();
		if (!account) return skip("no NSS account entry for this uid; nothing to assert against");

		// HOME removed entirely: nothing environment-derived is left to echo, so a
		// correct lookup still names the account home.
		expect(await resolveWith({ HOME: undefined })).toBe(account);
	});

	itLinux("ignores a hostile home that the account database contradicts", async () => {
		const account = await nssHome();
		if (!account) return skip("no NSS account entry for this uid; nothing to assert against");

		const hostile = await tempDir();
		try {
			// POSIX HOME absent and a hostile USERPROFILE present: the non-authoritative
			// variable must never select the home on Linux.
			expect(await resolveWith({ HOME: undefined, USERPROFILE: hostile })).toBe(account);
		} finally {
			await safeRm(hostile, { recursive: true, force: true });
		}
	});

	itLinux("never promotes a cached environment-derived home to independent evidence", async () => {
		// The failure this guards, reproduced against the real resolver:
		//
		// With NSS unavailable the account lookup falls back to
		// `os.userInfo().homedir`, which Bun derives from `$HOME`. If that value were
		// memoized while a planted home was live, a later call-time home change would
		// leave the cached attacker value *differing* from the new runtime home --
		// passing an equality-based independence check and being returned as trusted.
		//
		// A dynamic dotenv declaration keeps `ambiguousHome` true throughout, so the
		// resolver must fail closed both before and after the home moves.
		const attacker = await tempDir();
		const project = await tempDir();
		try {
			await Bun.write(path.join(project, ".env"), "HOME=$GJC_TEST_EVIL\n");
			// Point the resolver's own NSS lookup at a command that cannot exist, so
			// the failure is injected through the resolver rather than beside it.
			const source = await Bun.file(DIRS).text();
			const broken = source.replace('cmd: ["getent", "passwd", String(uid)],', 'cmd: ["gjc-no-such-nss-binary"],');
			expect(broken).not.toBe(source);
			const brokenPath = path.join(path.dirname(DIRS), `dirs-no-nss-${Bun.randomUUIDv7()}.ts`);
			scratch.push(brokenPath);
			await Bun.write(brokenPath, broken);

			const probe = [
				'import { vi } from "bun:test";',
				'import * as os from "node:os";',
				`import { getTrustedHomeDir } from ${JSON.stringify(brokenPath)};`,
				'const read = () => { try { return getTrustedHomeDir(); } catch (error) { if (String(error).includes("no trustworthy home directory")) return "REFUSED"; throw error; } };',
				"const first = read();",
				'vi.spyOn(os, "homedir").mockReturnValue("/tmp");',
				"console.log(JSON.stringify({ first, second: read() }));",
			].join("\n");
			const probePath = path.join(project, "probe.ts");
			await Bun.write(probePath, probe);

			const env: Record<string, string> = {};
			for (const [key, value] of Object.entries(process.env)) {
				if (value !== undefined) env[key] = value;
			}
			env.HOME = attacker;
			env.GJC_TEST_EVIL = attacker;
			const proc = Bun.spawn([process.execPath, probePath], {
				cwd: project,
				env,
				stdout: "pipe",
				stderr: "pipe",
			});
			const stdout = await new Response(proc.stdout).text();
			const stderr = await new Response(proc.stderr).text();
			const exitCode = await proc.exited;
			if (exitCode !== 0) throw new Error(`probe failed (${exitCode}): ${stderr}`);
			const { first, second } = JSON.parse(stdout.trim().split("\n").at(-1) ?? "{}");

			// The planted home must never be returned, before or after the change.
			expect(first).not.toBe(attacker);
			expect(second).not.toBe(attacker);
			// And with no environment-independent evidence, both must refuse outright.
			expect(first).toBe("REFUSED");
			expect(second).toBe("REFUSED");
		} finally {
			await Promise.all([attacker, project].map(dir => safeRm(dir, { recursive: true, force: true })));
		}
	});

	itLinux("still resolves an absolute home when the NSS front end is unavailable", async () => {
		// Minimal and distroless images ship no `getent`, and `Bun.spawnSync` throws
		// outright when the executable is missing rather than returning a non-zero
		// exit. The failure is injected into the resolver's own lookup so this
		// exercises the real fallback path instead of simulating it alongside.
		const work = await tempDir();
		try {
			const source = await Bun.file(DIRS).text();
			const broken = source.replace('cmd: ["getent", "passwd", String(uid)],', 'cmd: ["gjc-no-such-nss-binary"],');
			expect(broken).not.toBe(source);
			const brokenPath = path.join(path.dirname(DIRS), `dirs-no-nss-${Bun.randomUUIDv7()}.ts`);
			scratch.push(brokenPath);
			await Bun.write(brokenPath, broken);

			const probePath = path.join(work, "probe.ts");
			await Bun.write(
				probePath,
				`import { getTrustedHomeDir } from ${JSON.stringify(brokenPath)};\nconsole.log(getTrustedHomeDir());\n`,
			);

			// An honest operator home with no dotenv declaration: the lookup failure
			// must degrade to the runtime home, not take the process down.
			const home = await tempDir();
			const env: Record<string, string> = {};
			for (const [key, value] of Object.entries(process.env)) {
				if (value !== undefined) env[key] = value;
			}
			env.HOME = home;
			const proc = Bun.spawn([process.execPath, probePath], { cwd: work, env, stdout: "pipe", stderr: "pipe" });
			const stdout = await new Response(proc.stdout).text();
			const stderr = await new Response(proc.stderr).text();
			const exitCode = await proc.exited;
			if (exitCode !== 0) throw new Error(`probe failed (${exitCode}): ${stderr}`);

			const resolved = stdout.trim().split("\n").at(-1) ?? "";
			expect(resolved).toBe(home);
			expect(path.isAbsolute(resolved)).toBe(true);
			await safeRm(home, { recursive: true, force: true });
		} finally {
			await safeRm(work, { recursive: true, force: true });
		}
	});

	itLinux("accepts an NSS home that corroborates the runtime home", async () => {
		const account = await nssHome();
		if (!account) return skip("no NSS account entry for this uid; nothing to assert against");

		// A checkout can declare HOME dynamically, which makes the home ambiguous no
		// matter what it resolves to. The account lookup then decides. When NSS --
		// which no environment variable can influence -- independently reports the
		// same path, that is corroboration, not the self-justifying echo the guard
		// exists to catch. Refusing it locks a legitimate operator out of their own
		// user state whenever their HOME agrees with their account entry.
		const project = await tempDir();
		try {
			await Bun.write(path.join(project, ".env"), "HOME=$GJC_TEST_DYNAMIC\n");
			const resolved = await resolveWith({ HOME: account, GJC_TEST_DYNAMIC: account }, project);
			expect(resolved).toBe(account);
		} finally {
			await safeRm(project, { recursive: true, force: true });
		}
	});

	it("does not honor a project-declared home that spells itself with a traversal", async () => {
		// Provenance compares the declared dotenv value against the runtime home. If
		// either side were canonicalized without the other, `HOME=/tmp/x/../y` would
		// compare unequal to its own declaration and be honored as operator-supplied.
		const base = await tempDir();
		const real = path.join(base, "attacker");
		const aliased = path.join(base, "decoy", "..", "attacker");
		const project = await tempDir();
		try {
			await Promise.all([real, path.join(base, "decoy")].map(dir => fs.mkdir(dir, { recursive: true })));
			await Bun.write(path.join(project, ".env"), `HOME=${aliased}\n`);
			const resolved = await resolveWith({ HOME: aliased }, project);
			expect(resolved).not.toBe(aliased);
			expect(resolved).not.toBe(real);
		} finally {
			await Promise.all([base, project].map(dir => safeRm(dir, { recursive: true, force: true })));
		}
	});
});
