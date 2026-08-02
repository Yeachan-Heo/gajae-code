import { afterEach, beforeEach, describe, expect, it, setDefaultTimeout } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
	__setBinaryResolverForTests,
	__setExecutableIdentityResolverForTests,
	clearPsmuxDetectionCache,
	detectPsmux,
	GJC_PSMUX_COMMAND_ENV,
	GJC_PSMUX_DETECTION_ENV,
	GJC_PSMUX_FORCE_DETECT_ENV,
	PSMUX_BINARY_NAMES,
	probePsmux,
	resolveGjcTmuxBinary,
	resolveGjcTmuxExecutableIdentity,
} from "@gajae-code/coding-agent/gjc-runtime/psmux-detect";
import {
	assertGjcTmuxMutationAuthoritySync,
	bindGjcTmuxProviderAuthority,
	buildTmuxProviderCommand,
	hasGjcTmuxProviderAuthoritySync,
	persistGjcTmuxProviderAuthoritySync,
	readGjcTmuxProviderAuthoritySync,
	resolveGjcTmuxCommand,
	resolveGjcTmuxProviderContext,
} from "@gajae-code/coding-agent/gjc-runtime/tmux-common";
import { lifecyclePaths } from "@gajae-code/coding-agent/gjc-runtime/tmux-owner-isolation";
import {
	__setTmuxProviderAuthorityPlatformForTests,
	assertGjcTmuxStagedMutationAuthoritySync,
} from "../../src/gjc-runtime/tmux-provider-context";
import { prepareManagedDirectoryRoot } from "../../src/session/internal/managed-session-storage";

setDefaultTimeout(10_000);

function psmuxVersionOutput(): string {
	return "psmux 3.3.0\n";
}

function tmuxVersionOutput(): string {
	return "tmux 3.3.6\n";
}

function failingRunner() {
	return () => ({ exitCode: 1, stdout: "", stderr: "command not found" });
}

function buildRunner(versionOutput: string | null) {
	return (_command: string, _args: string[]) => {
		if (versionOutput === null) return { exitCode: 1, stdout: "", stderr: "missing" };
		return { exitCode: 0, stdout: versionOutput, stderr: "" };
	};
}
function publishGeneration(root: string, sessionId: string, generation: string): void {
	const paths = lifecyclePaths(root, sessionId, generation);
	prepareManagedDirectoryRoot(paths.root);
	fs.writeFileSync(
		paths.generationFile,
		`${JSON.stringify({
			schema_version: 1,
			session_id: sessionId,
			generation,
			published_at: "2026-07-28T00:00:00.000Z",
		})}\n`,
	);
}

beforeEach(() => {
	clearPsmuxDetectionCache();
	// Make the binary resolver a no-op so tests are hermetic and do not
	// depend on whether psmux / pmux / tmux happen to exist on PATH in the
	// runner image. Tests that need a resolvable binary opt in by setting the
	// resolver to a stub that returns a fake path for their candidate names.
	__setBinaryResolverForTests(candidate =>
		candidate === "psmux" || candidate === "pmux" || candidate === "tmux" ? `/usr/bin/${candidate}` : null,
	);
	__setExecutableIdentityResolverForTests(() => "test-psmux-alias");
	__setTmuxProviderAuthorityPlatformForTests("win32");
});

afterEach(() => {
	clearPsmuxDetectionCache();
	__setBinaryResolverForTests(null);
	__setExecutableIdentityResolverForTests(null);
	__setTmuxProviderAuthorityPlatformForTests(null);
});

describe("PSMUX_BINARY_NAMES", () => {
	it("includes psmux, pmux, and tmux so any psmux install resolves", () => {
		expect(PSMUX_BINARY_NAMES).toContain("psmux");
		expect(PSMUX_BINARY_NAMES).toContain("pmux");
		expect(PSMUX_BINARY_NAMES).toContain("tmux");
	});
	describe("Windows provider context", () => {
		it("uses one identity-anchored namespace for psmux aliases and emits structured argv", () => {
			__setBinaryResolverForTests(candidate =>
				candidate === "psmux" || candidate === "pmux" || candidate === "tmux"
					? `C:\\psmux\\${candidate}.exe`
					: null,
			);
			__setExecutableIdentityResolverForTests(() => "volume:42");
			const context = resolveGjcTmuxProviderContext({
				platform: "win32",
				env: {},
				runner: buildRunner(psmuxVersionOutput()),
			});

			expect(context.kind).toBe("windows-psmux");
			expect(context.commandPrefix[0]).toBe("-L");
			const namespace = context.namespace;
			if (!namespace) throw new Error("missing psmux namespace");
			expect(namespace).toMatch(/^gjc-[a-f0-9]{32}$/);
			expect(context.command).toBe("C:\\psmux\\psmux.exe");
			expect(buildTmuxProviderCommand(context, "has-session", ["-t", "managed"])).toEqual([
				"-L",
				namespace,
				"has-session",
				"-t",
				"managed",
			]);
		});
		it("rejects an explicitly classified psmux command on non-Windows platforms", () => {
			expect(() =>
				resolveGjcTmuxProviderContext({
					platform: "linux",
					binary: { command: "/usr/bin/psmux", isPsmux: true, viaExplicitOverride: true },
				}),
			).toThrow("gjc_tmux_provider_ambiguous: selected psmux command requires Windows");
		});

		it("uses the canonical psmux provider despite distinct compatibility aliases", () => {
			__setBinaryResolverForTests(candidate =>
				candidate === "psmux" || candidate === "pmux" || candidate === "tmux"
					? `C:\\psmux\\${candidate}.exe`
					: null,
			);
			__setExecutableIdentityResolverForTests(executable => executable);

			const context = resolveGjcTmuxProviderContext({
				platform: "win32",
				env: {},
				runner: buildRunner(psmuxVersionOutput()),
			});

			expect(context.kind).toBe("windows-psmux");
			expect(context.command).toBe("C:\\psmux\\psmux.exe");
		});
		it("persists authority and rejects invalid sidecars before mutation", () => {
			const root = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-psmux-provider-"));
			try {
				__setBinaryResolverForTests(candidate => (candidate === "psmux" ? "C:\\psmux\\psmux.exe" : null));
				__setExecutableIdentityResolverForTests(() => "volume:42");
				const authority = bindGjcTmuxProviderAuthority(
					resolveGjcTmuxProviderContext({
						platform: "win32",
						env: { GJC_TMUX_COMMAND: "psmux" },
						runner: buildRunner(psmuxVersionOutput()),
					}),
					{ stateDir: root, sessionId: "team", generation: "generation-a" },
				);
				persistGjcTmuxProviderAuthoritySync(authority);
				publishGeneration(root, authority.sessionId, authority.generation);
				assertGjcTmuxMutationAuthoritySync(authority);
				expect(
					hasGjcTmuxProviderAuthoritySync({
						stateDir: root,
						sessionId: authority.sessionId,
						generation: authority.generation,
					}),
				).toBe(true);
				fs.writeFileSync(
					lifecyclePaths(root, authority.sessionId, authority.generation).generationFile,
					`${JSON.stringify({
						schema_version: 1,
						session_id: authority.sessionId,
						generation: authority.generation,
						published_at: "2026-07-28T00:00:00+00:00",
					})}\n`,
				);
				expect(() => assertGjcTmuxMutationAuthoritySync(authority)).toThrow(
					"gjc_tmux_provider_authority_generation_mismatch",
				);
				publishGeneration(root, authority.sessionId, authority.generation);
				const sidecar = path.join(
					lifecyclePaths(root, "team", "generation-a").root,
					"provider-authority-generation-a.json",
				);
				fs.writeFileSync(sidecar, "{");
				expect(() => assertGjcTmuxMutationAuthoritySync(authority)).toThrow(
					"gjc_tmux_provider_authority_invalid_record",
				);
				expect(() =>
					hasGjcTmuxProviderAuthoritySync({
						stateDir: root,
						sessionId: authority.sessionId,
						generation: authority.generation,
					}),
				).toThrow("gjc_tmux_provider_authority_invalid_record");
			} finally {
				fs.rmSync(root, { recursive: true, force: true });
			}
		});
		it("treats Windows authority as absent for native probing while direct reads reject off Windows", () => {
			const root = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-psmux-off-windows-"));
			try {
				__setBinaryResolverForTests(candidate => candidate);
				const authority = bindGjcTmuxProviderAuthority(
					resolveGjcTmuxProviderContext({
						platform: "win32",
						binary: { command: "C:\\psmux\\psmux.exe", isPsmux: true, viaExplicitOverride: true },
					}),
					{ stateDir: root, sessionId: "team", generation: "generation-a" },
				);
				persistGjcTmuxProviderAuthoritySync(authority);
				publishGeneration(root, authority.sessionId, authority.generation);
				__setTmuxProviderAuthorityPlatformForTests("linux");
				expect(
					hasGjcTmuxProviderAuthoritySync({
						stateDir: authority.stateDir,
						sessionId: authority.sessionId,
						generation: authority.generation,
					}),
				).toBe(false);
				expect(() =>
					readGjcTmuxProviderAuthoritySync({
						stateDir: authority.stateDir,
						sessionId: authority.sessionId,
						generation: authority.generation,
					}),
				).toThrow("gjc_tmux_provider_authority_windows_required");
			} finally {
				fs.rmSync(root, { recursive: true, force: true });
			}
		});
		it("reports an absent provider authority as absent", () => {
			const root = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-psmux-provider-"));
			try {
				publishGeneration(root, "team", "generation-a");
				expect(
					hasGjcTmuxProviderAuthoritySync({
						stateDir: root,
						sessionId: "team",
						generation: "generation-a",
					}),
				).toBe(false);
			} finally {
				fs.rmSync(root, { recursive: true, force: true });
			}
		});
		it("rejects stale authority generations without mutating the successor pointer", () => {
			const root = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-psmux-provider-"));
			try {
				__setBinaryResolverForTests(candidate => (candidate === "psmux" ? "C:\\psmux\\psmux.exe" : null));
				__setExecutableIdentityResolverForTests(() => "volume:42");
				const context = resolveGjcTmuxProviderContext({
					platform: "win32",
					env: { GJC_TMUX_COMMAND: "psmux" },
					runner: buildRunner(psmuxVersionOutput()),
				});
				const first = bindGjcTmuxProviderAuthority(context, {
					stateDir: root,
					sessionId: "team",
					generation: "generation-a",
				});
				const second = bindGjcTmuxProviderAuthority(context, {
					stateDir: root,
					sessionId: "team",
					generation: "generation-b",
				});
				persistGjcTmuxProviderAuthoritySync(first);
				persistGjcTmuxProviderAuthoritySync(second);
				assertGjcTmuxStagedMutationAuthoritySync(second);
				expect(() => persistGjcTmuxProviderAuthoritySync(first)).toThrow();
				publishGeneration(root, second.sessionId, second.generation);
				expect(() => assertGjcTmuxMutationAuthoritySync(first)).toThrow(
					"gjc_tmux_provider_authority_generation_mismatch",
				);
				assertGjcTmuxMutationAuthoritySync(second);
				const sidecar = path.join(
					lifecyclePaths(root, "team", "generation-b").root,
					"provider-authority-generation-b.json",
				);
				expect(
					(JSON.parse(fs.readFileSync(sidecar, "utf8")) as { owner_generation: string }).owner_generation,
				).toBe("generation-b");
			} finally {
				fs.rmSync(root, { recursive: true, force: true });
			}
		});
		it("does not displace an expired lock whose independent owner is still live", () => {
			const root = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-psmux-provider-"));
			try {
				__setBinaryResolverForTests(candidate => (candidate === "psmux" ? "C:\\psmux\\psmux.exe" : null));
				__setExecutableIdentityResolverForTests(() => "volume:42");
				const context = resolveGjcTmuxProviderContext({
					platform: "win32",
					env: { GJC_TMUX_COMMAND: "psmux" },
					runner: buildRunner(psmuxVersionOutput()),
				});
				const first = bindGjcTmuxProviderAuthority(context, {
					stateDir: root,
					sessionId: "team",
					generation: "generation-a",
				});
				const successor = bindGjcTmuxProviderAuthority(context, {
					stateDir: root,
					sessionId: "team",
					generation: "generation-b",
				});
				persistGjcTmuxProviderAuthoritySync(first);
				const lifecycleRoot = lifecyclePaths(root, "team", "generation-a").root;
				const lockPath = path.join(
					lifecycleRoot,
					"provider-authority-locks",
					"provider-authority-generation-b.json.lock",
				);
				fs.mkdirSync(path.dirname(lockPath), { recursive: true, mode: 0o700 });
				fs.writeFileSync(
					lockPath,
					JSON.stringify({
						attemptId: "paused-independent-writer",
						pid: process.pid,
						processStartId: "test-start",
						createdAt: 0,
						heartbeatAt: 0,
						leaseExpiresAt: 0,
					}),
				);

				expect(() => persistGjcTmuxProviderAuthoritySync(successor)).toThrow("migration_busy");
				const sidecar = path.join(lifecycleRoot, "provider-authority-generation-a.json");
				expect(
					(JSON.parse(fs.readFileSync(sidecar, "utf8")) as { owner_generation: string }).owner_generation,
				).toBe("generation-a");
			} finally {
				fs.rmSync(root, { recursive: true, force: true });
			}
		});
		it("rejects a same-path executable replacement before a provider mutation", () => {
			const root = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-psmux-provider-"));
			try {
				let executableIdentity = "volume:42:file:100";
				__setBinaryResolverForTests(candidate => (candidate === "psmux" ? "C:\\psmux\\psmux.exe" : null));
				__setExecutableIdentityResolverForTests(() => executableIdentity);
				const authority = bindGjcTmuxProviderAuthority(
					resolveGjcTmuxProviderContext({
						platform: "win32",
						env: { GJC_TMUX_COMMAND: "psmux" },
						runner: buildRunner(psmuxVersionOutput()),
					}),
					{ stateDir: root, sessionId: "team", generation: "generation-a" },
				);
				persistGjcTmuxProviderAuthoritySync(authority);
				publishGeneration(root, authority.sessionId, authority.generation);
				executableIdentity = "volume:42:file:101";
				expect(() => assertGjcTmuxMutationAuthoritySync(authority)).toThrow(
					"gjc_tmux_provider_authority_executable_changed",
				);
			} finally {
				fs.rmSync(root, { recursive: true, force: true });
			}
		});
		it("rejects a pointer swap to another valid owner generation", () => {
			const root = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-psmux-provider-"));
			try {
				__setBinaryResolverForTests(candidate => (candidate === "psmux" ? "C:\\psmux\\psmux.exe" : null));
				__setExecutableIdentityResolverForTests(() => "volume:42:file:100");
				const authority = bindGjcTmuxProviderAuthority(
					resolveGjcTmuxProviderContext({
						platform: "win32",
						env: { GJC_TMUX_COMMAND: "psmux" },
						runner: buildRunner(psmuxVersionOutput()),
					}),
					{ stateDir: root, sessionId: "team", generation: "generation-a" },
				);
				persistGjcTmuxProviderAuthoritySync(authority);
				publishGeneration(root, authority.sessionId, authority.generation);
				const sidecar = path.join(
					lifecyclePaths(root, "team", "generation-a").root,
					"provider-authority-generation-a.json",
				);
				const swapped = JSON.parse(fs.readFileSync(sidecar, "utf8")) as Record<string, unknown>;
				swapped.owner_generation = "generation-b";
				fs.writeFileSync(sidecar, JSON.stringify(swapped));
				expect(() => assertGjcTmuxMutationAuthoritySync(authority)).toThrow("gjc_tmux_provider_authority_mismatch");
			} finally {
				fs.rmSync(root, { recursive: true, force: true });
			}
		});
	});
});
describe("executable identity", () => {
	it("captures file identity rather than accepting a same-path replacement", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-psmux-identity-"));
		const executable = path.join(root, "psmux.exe");
		try {
			fs.writeFileSync(executable, "first");
			__setExecutableIdentityResolverForTests(null);
			const first = resolveGjcTmuxExecutableIdentity(executable);
			fs.writeFileSync(executable, "replacement");
			const second = resolveGjcTmuxExecutableIdentity(executable);
			expect(first).not.toBeNull();
			expect(second).not.toBeNull();
			expect(second).not.toBe(first);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
			__setExecutableIdentityResolverForTests(() => "test-psmux-alias");
		}
	});
});

describe("detectPsmux", () => {
	it("returns true when the binary reports a psmux version banner", () => {
		const detected = detectPsmux("psmux", {
			env: {},
			runner: buildRunner(psmuxVersionOutput()),
			force: true,
		});
		expect(detected).toBe(true);
	});

	it("returns false when the binary reports a generic tmux banner", () => {
		const detected = detectPsmux("psmux", {
			env: {},
			runner: buildRunner(tmuxVersionOutput()),
			force: true,
		});
		expect(detected).toBe(false);
	});

	it("returns false when the probe runner cannot execute the binary", () => {
		const detected = detectPsmux("nonexistent-fake-tmux-binary-xyz", {
			env: {},
			runner: failingRunner(),
			force: true,
		});
		expect(detected).toBe(false);
	});

	it("honors GJC_PSMUX_DETECTION=off and never reports psmux", () => {
		const detected = detectPsmux("psmux", {
			env: { [GJC_PSMUX_DETECTION_ENV]: "off" },
			runner: buildRunner(psmuxVersionOutput()),
			force: true,
		});
		expect(detected).toBe(false);
	});

	it("re-probes every call when GJC_PSMUX_FORCE_DETECT is set", () => {
		let calls = 0;
		const runner = (_command: string, _args: string[]) => {
			calls += 1;
			return { exitCode: 0, stdout: calls === 1 ? "tmux 3.3\n" : "psmux 3.3.0\n", stderr: "" };
		};
		detectPsmux("psmux", {
			env: { [GJC_PSMUX_FORCE_DETECT_ENV]: "1" },
			runner,
			force: true,
		});
		detectPsmux("psmux", {
			env: { [GJC_PSMUX_FORCE_DETECT_ENV]: "1" },
			runner,
			force: true,
		});
		expect(calls).toBeGreaterThanOrEqual(2);
	});

	it("caches the verdict for repeated identical probes", () => {
		let calls = 0;
		const runner = (_command: string, _args: string[]) => {
			calls += 1;
			return { exitCode: 0, stdout: "psmux 3.3.0\n", stderr: "" };
		};
		// First call: probes and caches. Subsequent calls must not re-probe.
		detectPsmux("psmux", { env: {}, runner, force: false });
		const callsAfterFirst = calls;
		detectPsmux("psmux", { env: {}, runner, force: false });
		detectPsmux("psmux", { env: {}, runner, force: false });
		expect(calls).toBe(callsAfterFirst);
	});

	it("treats an explicit GJC_PSMUX_COMMAND override as authoritative", () => {
		// Override path must NOT consult the resolver at all; the host binary
		// resolver can be left as a no-op stub and detection still wins.
		__setBinaryResolverForTests(() => null);
		const detected = detectPsmux("psmux", {
			env: { [GJC_PSMUX_COMMAND_ENV]: "psmux" },
			runner: failingRunner(),
			force: true,
		});
		expect(detected).toBe(true);
	});
});

describe("resolveGjcTmuxBinary", () => {
	it("returns the explicit GJC_TMUX_COMMAND override when set", () => {
		const resolved = resolveGjcTmuxBinary({
			platform: "linux",
			env: { GJC_TMUX_COMMAND: "/custom/tmux" },
			runner: failingRunner(),
		});
		expect(resolved.command).toBe("/custom/tmux");
		expect(resolved.viaExplicitOverride).toBe(true);
		expect(resolved.isPsmux).toBe(false);
	});

	it("falls back to GJC_TEAM_TMUX_COMMAND when GJC_TMUX_COMMAND is unset", () => {
		const resolved = resolveGjcTmuxBinary({
			platform: "linux",
			env: { GJC_TEAM_TMUX_COMMAND: "team-tmux" },
			runner: failingRunner(),
		});
		expect(resolved.command).toBe("team-tmux");
		expect(resolved.viaExplicitOverride).toBe(true);
	});

	it("returns tmux as the POSIX default when no override and no binary on PATH", () => {
		__setBinaryResolverForTests(() => null);
		const resolved = resolveGjcTmuxBinary({
			platform: "linux",
			env: {},
			runner: failingRunner(),
		});
		expect(resolved.command).toBe("tmux");
		expect(resolved.viaExplicitOverride).toBe(false);
		expect(resolved.isPsmux).toBe(false);
	});

	it("flags the resolved command as psmux when the probe matches", () => {
		const resolved = resolveGjcTmuxBinary({
			platform: "linux",
			env: {},
			runner: buildRunner(psmuxVersionOutput()),
		});
		expect(resolved.isPsmux).toBe(true);
	});

	it("prefers psmux over distinct compatibility aliases without inspecting lower aliases", () => {
		const resolvedCandidates: string[] = [];
		const identityCandidates: string[] = [];
		__setBinaryResolverForTests(candidate => {
			resolvedCandidates.push(candidate);
			return `C:\\tools\\${candidate}.exe`;
		});
		__setExecutableIdentityResolverForTests(executable => {
			identityCandidates.push(executable);
			return "volume:42";
		});

		const resolved = resolveGjcTmuxBinary({
			platform: "win32",
			env: {},
			runner: buildRunner(tmuxVersionOutput()),
		});

		expect(resolved).toEqual({ command: "psmux", isPsmux: true, viaExplicitOverride: false });
		expect(resolvedCandidates).toEqual(["psmux"]);
		expect(identityCandidates).toEqual(["C:\\tools\\psmux.exe"]);
	});

	it("does not inspect broken lower-priority aliases after selecting psmux", () => {
		__setBinaryResolverForTests(candidate => {
			if (candidate === "psmux") return "C:\\tools\\psmux.exe";
			throw new Error(`unexpected compatibility alias lookup: ${candidate}`);
		});

		expect(
			resolveGjcTmuxBinary({
				platform: "win32",
				env: {},
				runner: buildRunner(tmuxVersionOutput()),
			}),
		).toEqual({ command: "psmux", isPsmux: true, viaExplicitOverride: false });
	});

	it("rejects psmux when its executable identity is unavailable", () => {
		__setBinaryResolverForTests(candidate => (candidate === "psmux" ? "C:\\tools\\psmux.exe" : null));
		__setExecutableIdentityResolverForTests(() => null);

		expect(() =>
			resolveGjcTmuxBinary({
				platform: "win32",
				env: {},
				runner: buildRunner(tmuxVersionOutput()),
			}),
		).toThrow("gjc_tmux_provider_ambiguous: Windows psmux executable identity is unavailable");
	});

	it("falls back to pmux when psmux is unavailable", () => {
		__setBinaryResolverForTests(candidate => {
			if (candidate === "psmux") return null;
			if (candidate === "pmux") return "C:\\tools\\pmux.exe";
			throw new Error(`unexpected lower-priority alias lookup: ${candidate}`);
		});

		expect(
			resolveGjcTmuxBinary({
				platform: "win32",
				env: {},
				runner: buildRunner(tmuxVersionOutput()),
			}),
		).toEqual({ command: "pmux", isPsmux: true, viaExplicitOverride: false });
	});

	it("treats a tmux alias with a psmux banner as psmux when named providers are unavailable", () => {
		__setBinaryResolverForTests(candidate => (candidate === "tmux" ? "C:\\tools\\tmux.exe" : null));

		expect(
			resolveGjcTmuxBinary({
				platform: "win32",
				env: {},
				runner: buildRunner(psmuxVersionOutput()),
			}),
		).toEqual({ command: "tmux", isPsmux: true, viaExplicitOverride: false });
	});
	it("rejects a psmux-marked tmux alias when its identity is unavailable", () => {
		__setBinaryResolverForTests(candidate => (candidate === "tmux" ? "C:\\tools\\tmux.exe" : null));
		__setExecutableIdentityResolverForTests(() => null);

		expect(() =>
			resolveGjcTmuxBinary({
				platform: "win32",
				env: {},
				runner: buildRunner(psmuxVersionOutput()),
			}),
		).toThrow("gjc_tmux_provider_ambiguous: Windows tmux executable identity is unavailable");
	});

	it("keeps a genuine tmux-only Windows installation on native-tmux semantics", () => {
		__setBinaryResolverForTests(candidate => (candidate === "tmux" ? "C:\\tools\\tmux.exe" : null));

		expect(
			resolveGjcTmuxBinary({
				platform: "win32",
				env: {},
				runner: buildRunner(tmuxVersionOutput()),
			}),
		).toEqual({ command: "tmux", isPsmux: false, viaExplicitOverride: false });
	});

	it("classifies an explicit Windows tmux.exe alias by matching the psmux executable identity", () => {
		__setBinaryResolverForTests(candidate => {
			if (candidate === "tmux") return "C:\\WinGet\\Links\\tmux.exe";
			if (candidate === "psmux") return "C:\\WinGet\\Links\\psmux.exe";
			return null;
		});
		__setExecutableIdentityResolverForTests(path =>
			path.endsWith("tmux.exe") || path.endsWith("psmux.exe") ? "win-file-id:2086" : null,
		);

		const resolved = resolveGjcTmuxBinary({
			platform: "win32",
			env: { GJC_TMUX_COMMAND: "tmux" },
			runner: buildRunner(tmuxVersionOutput()),
		});

		expect(resolved).toEqual({ command: "tmux", isPsmux: true, viaExplicitOverride: true });
	});

	it("fails closed when an explicit Windows tmux.exe identity cannot be established", () => {
		__setBinaryResolverForTests(candidate => (candidate === "tmux" ? "C:\\WinGet\\Links\\tmux.exe" : null));
		__setExecutableIdentityResolverForTests(() => null);

		expect(() =>
			resolveGjcTmuxBinary({
				platform: "win32",
				env: { GJC_TMUX_COMMAND: "tmux" },
				runner: buildRunner(tmuxVersionOutput()),
			}),
		).toThrow("gjc_tmux_provider_ambiguous");
	});

	it("keeps a distinct Windows tmux.exe on native-tmux semantics", () => {
		__setBinaryResolverForTests(candidate => `C:\\tools\\${candidate}.exe`);
		__setExecutableIdentityResolverForTests(path => path.toLowerCase());

		const resolved = resolveGjcTmuxBinary({
			platform: "win32",
			env: { GJC_TMUX_COMMAND: "tmux" },
			runner: buildRunner(tmuxVersionOutput()),
		});

		expect(resolved).toEqual({ command: "tmux", isPsmux: false, viaExplicitOverride: true });
	});

	it("fails closed when canonical psmux companions conflict", () => {
		__setBinaryResolverForTests(candidate => `C:\\tools\\${candidate}.exe`);
		__setExecutableIdentityResolverForTests(path => {
			if (path.endsWith("tmux.exe") || path.endsWith("psmux.exe")) return "same-file";
			return "different-file";
		});

		expect(() =>
			resolveGjcTmuxBinary({
				platform: "win32",
				env: { GJC_TMUX_COMMAND: "tmux" },
				runner: buildRunner(tmuxVersionOutput()),
			}),
		).toThrow("companion identities conflict");
	});

	it("fails closed when GJC_PSMUX_COMMAND selects a different executable", () => {
		__setBinaryResolverForTests(candidate => `C:\\tools\\${candidate}.exe`);
		__setExecutableIdentityResolverForTests(path => path.toLowerCase());

		expect(() =>
			resolveGjcTmuxBinary({
				platform: "win32",
				env: { GJC_TMUX_COMMAND: "tmux", GJC_PSMUX_COMMAND: "C:\\other\\psmux-wrapper.exe" },
				runner: buildRunner(tmuxVersionOutput()),
			}),
		).toThrow("GJC_PSMUX_COMMAND selects a different executable");
	});

	it("fails closed when Windows alias resolution throws", () => {
		__setBinaryResolverForTests(candidate => {
			if (candidate === "tmux") throw new Error("resolver failure");
			return null;
		});

		expect(() =>
			resolveGjcTmuxBinary({
				platform: "win32",
				env: { GJC_TMUX_COMMAND: "tmux" },
				runner: buildRunner(tmuxVersionOutput()),
			}),
		).toThrow("selected Windows tmux command resolution failed");
	});

	it("classifies a generic wrapper when GJC_PSMUX_COMMAND matches its executable identity", () => {
		__setBinaryResolverForTests(candidate => {
			if (candidate === "wrapper-tmux") return "C:\\tools\\wrapper-tmux.exe";
			if (candidate === "wrapper-psmux") return "C:\\tools\\wrapper-psmux.exe";
			return null;
		});
		__setExecutableIdentityResolverForTests(() => "same-wrapper");

		const resolved = resolveGjcTmuxBinary({
			platform: "win32",
			env: { GJC_TMUX_COMMAND: "wrapper-tmux", GJC_PSMUX_COMMAND: "wrapper-psmux" },
			runner: buildRunner(tmuxVersionOutput()),
		});

		expect(resolved).toEqual({ command: "wrapper-tmux", isPsmux: true, viaExplicitOverride: true });
	});
	it("treats an explicit Windows psmux path as psmux without relying on the version banner", () => {
		const resolved = resolveGjcTmuxBinary({
			platform: "win32",
			env: { GJC_TEAM_TMUX_COMMAND: "C:\\tools\\psmux.exe" },
			runner: buildRunner(tmuxVersionOutput()),
		});
		expect(resolved.command).toBe("C:\\tools\\psmux.exe");
		expect(resolved.viaExplicitOverride).toBe(true);
		expect(resolved.isPsmux).toBe(true);
	});
});

describe("probePsmux", () => {
	it("returns the captured version banner for matched probes", () => {
		const probe = probePsmux("psmux", {
			env: {},
			runner: buildRunner(psmuxVersionOutput()),
			force: true,
		});
		expect(probe.isPsmux).toBe(true);
		expect(probe.versionOutput).toContain("psmux");
	});

	it("reports an empty probe when the runner cannot find the binary", () => {
		const probe = probePsmux("nonexistent-fake-tmux-binary-xyz", {
			env: {},
			runner: failingRunner(),
			force: true,
		});
		expect(probe.isPsmux).toBe(false);
		expect(probe.versionOutput).toBe("");
	});
});

describe("resolveGjcTmuxCommand (shared session/team resolver)", () => {
	it("returns psmux on native Windows when psmux resolves and tmux.exe alias does not", () => {
		// Reproduces the case the review flagged: a Windows host with psmux
		// installed but no tmux.exe alias on PATH. The shared resolver must
		// pick psmux so gjc session ... and gjc team ... talk to the same
		// multiplexer that gjc --tmux just created.
		__setBinaryResolverForTests(candidate =>
			candidate === "psmux" || candidate === "pmux"
				? `C:\\Users\\runner\\AppData\\Local\\Microsoft\\WinGet\\Links\\${candidate}.exe`
				: null,
		);
		const command = resolveGjcTmuxCommand({}, "win32");
		expect(command).toBe("psmux");
	});

	it("returns pmux on native Windows when only pmux resolves", () => {
		__setBinaryResolverForTests(candidate => (candidate === "pmux" ? `/usr/bin/${candidate}` : null));
		const command = resolveGjcTmuxCommand({}, "win32");
		expect(command).toBe("pmux");
	});

	it("returns tmux.exe on native Windows when only the tmux alias resolves", () => {
		__setBinaryResolverForTests(candidate => (candidate === "tmux" ? `/usr/bin/${candidate}` : null));
		const command = resolveGjcTmuxCommand({}, "win32");
		expect(command).toBe("tmux");
	});

	it("honors GJC_TMUX_COMMAND override on every platform", () => {
		__setBinaryResolverForTests(() => null);
		const command = resolveGjcTmuxCommand({ GJC_TMUX_COMMAND: "psmux" }, "win32");
		expect(command).toBe("psmux");
	});

	it("falls back to literal tmux on POSIX when no binary resolves", () => {
		__setBinaryResolverForTests(() => null);
		const command = resolveGjcTmuxCommand({}, "linux");
		expect(command).toBe("tmux");
	});
});
