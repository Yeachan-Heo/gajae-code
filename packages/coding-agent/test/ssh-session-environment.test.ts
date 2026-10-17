import { expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "@gajae-code/coding-agent/config/settings";
import type { SessionLaunchEnvironment } from "../src/sdk/session-environment";
import { invalidateHostMetadata, type SSHConnectionTarget } from "../src/ssh/connection-manager";
import { executeSSH } from "../src/ssh/ssh-executor";

it.skipIf(process.platform === "win32")(
	"applies the session environment to SSH execution and connection probes",
	async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-ssh-session-env-"));
		const binDir = path.join(root, "bin");
		const sshPath = path.join(binDir, "ssh");
		const reportPath = path.join(root, "ssh-env.txt");
		const host: SSHConnectionTarget = {
			name: `session-env-${process.pid}-${Date.now()}`,
			host: "session-env.example.test",
			compat: false,
		};
		const previousMarker = process.env.SESSION_ENV_MARKER;
		const previousRemoved = process.env.SESSION_ENV_REMOVED;
		const sessionEnvironment: SessionLaunchEnvironment = {
			env: { PATH: binDir, SSH_ENV_REPORT: reportPath, SESSION_ENV_MARKER: "session-value" },
			unsetEnv: ["SESSION_ENV_REMOVED"],
		};

		try {
			await fs.mkdir(binDir);
			await Bun.write(
				sshPath,
				[
					"#!/bin/sh",
					`printf '%s|%s|%s\\n' "\${SESSION_ENV_MARKER-unset}" "\${SESSION_ENV_REMOVED-unset}" "$PATH" >> "$SSH_ENV_REPORT"`,
					'case "$*" in',
					'  *"-O check"*) exit 1 ;;',
					'  *"-M -N -f"*) exit 0 ;;',
					"  *'echo \"$OSTYPE|$SHELL|$BASH_VERSION\"'*) printf 'Linux|/bin/bash|5.0\\n'; exit 0 ;;",
					"  *) printf 'session-ssh-output\\n'; exit 0 ;;",
					"esac",
					"",
				].join("\n"),
			);
			await fs.chmod(sshPath, 0o755);
			process.env.SESSION_ENV_MARKER = "inherited-value";
			process.env.SESSION_ENV_REMOVED = "project-dotenv-secret";

			const result = await executeSSH(host, "session-environment-command", {
				settings: Settings.isolated(),
				sessionEnvironment,
				timeout: 5_000,
			});
			expect(result.output).toContain("session-ssh-output");

			await invalidateHostMetadata([host.name], sessionEnvironment);
			const records = (await fs.readFile(reportPath, "utf8")).trim().split("\n");
			expect(records.length).toBeGreaterThanOrEqual(4);
			expect(records.every(record => record === `session-value|unset|${binDir}`)).toBe(true);
		} finally {
			await invalidateHostMetadata([host.name], sessionEnvironment);
			if (previousMarker === undefined) delete process.env.SESSION_ENV_MARKER;
			else process.env.SESSION_ENV_MARKER = previousMarker;
			if (previousRemoved === undefined) delete process.env.SESSION_ENV_REMOVED;
			else process.env.SESSION_ENV_REMOVED = previousRemoved;
			await fs.rm(root, { recursive: true, force: true });
		}
	},
);
