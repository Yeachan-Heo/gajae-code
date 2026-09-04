import * as fs from "node:fs/promises";
import * as path from "node:path";
import { processIncarnation } from "../../src/sdk/broker/process-incarnation";
import { type SessionIndexEvent, sessionIndexChecksum } from "../../src/sdk/broker/session-index";
import { SESSION_INDEX_EVENT_VERSION } from "../../src/sdk/broker/state-version";

export interface ExactSessionAuthorityFixture {
	readonly sessionId: string;
	readonly endpointGeneration: number;
	readonly pid: number;
	readonly endpointMtimeMs: number;
	readonly endpointFileId: string;
	readonly endpoint: {
		readonly sessionId: string;
		readonly pid: number;
		readonly url: string;
		readonly token: string;
	};
}

export interface ExactSessionAuthorityOptions {
	agentDir: string;
	cwd: string;
	sessionId: string;
	url: string;
	token: string;
	endpointGeneration?: number;
}

export async function prepareExactSessionAuthority(
	options: ExactSessionAuthorityOptions,
): Promise<ExactSessionAuthorityFixture> {
	const endpointGeneration = options.endpointGeneration ?? 1;
	const endpointFile = path.join(options.cwd, ".gjc", "state", "sdk", `${options.sessionId}.json`);
	await fs.mkdir(path.dirname(endpointFile), { recursive: true });
	const endpoint = {
		sessionId: options.sessionId,
		pid: process.pid,
		url: options.url,
		token: options.token,
	};
	await Bun.write(endpointFile, `${JSON.stringify({ version: 1, ...endpoint })}\n`);
	const endpointStat = await fs.stat(endpointFile);
	return {
		sessionId: options.sessionId,
		endpointGeneration,
		pid: process.pid,
		endpointMtimeMs: endpointStat.mtimeMs,
		endpointFileId: `${endpointStat.dev}:${endpointStat.ino}`,
		endpoint,
	};
}

export async function publishExactSessionAuthority(
	options: ExactSessionAuthorityOptions,
	authority: ExactSessionAuthorityFixture,
): Promise<void> {
	const stateRoot = path.join(options.cwd, ".gjc", "state");
	const indexDirectory = path.join(options.agentDir, "sdk", "sessions");
	await fs.mkdir(indexDirectory, { recursive: true });
	// SessionIndex.append() stamps the OS incarnation on every host registration it
	// writes, and liveness requires that incarnation to still match (the pid-reuse
	// fence). A fixture that writes the log directly must stamp it too; a legacy
	// row without one can never read live, so the Router would refuse to attach a
	// session this fixture is meant to present as live.
	const hostIncarnation = processIncarnation(authority.pid);
	const unsigned = {
		type: "host_registered" as const,
		sessionId: authority.sessionId,
		locator: { cwd: options.cwd, worktreeRoot: null, stateRoot },
		endpointGeneration: authority.endpointGeneration,
		pid: authority.pid,
		// A real host publishes its own OS start incarnation; without it the
		// pid-reuse fence (incarnationMatches) never holds and the session
		// reads not-live, so the fixture publishes the test process's
		// incarnation to mirror a genuine host.
		processIncarnation: processIncarnation(process.pid),
		endpointMtimeMs: authority.endpointMtimeMs,
		endpointFileId: authority.endpointFileId,
		...(hostIncarnation === undefined ? {} : { hostIncarnation }),
		version: SESSION_INDEX_EVENT_VERSION,
		indexSeq: 1,
		ts: Date.now(),
	} satisfies Omit<SessionIndexEvent, "checksum">;
	await Bun.write(
		path.join(indexDirectory, "index.jsonl"),
		`${JSON.stringify({ ...unsigned, checksum: sessionIndexChecksum(unsigned) })}\n`,
	);
}

export async function registerExactSessionAuthority(
	options: ExactSessionAuthorityOptions,
): Promise<ExactSessionAuthorityFixture> {
	const authority = await prepareExactSessionAuthority(options);
	await publishExactSessionAuthority(options, authority);
	return authority;
}
