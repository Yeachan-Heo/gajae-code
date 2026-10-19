import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { lifecycleArgs } from "../src/commands/sdk";
import { deriveLifecycleDeadlines, readSessionLifecycleLaunchRequest } from "../src/sdk/broker/lifecycle";

const IN_MEMORY_ENV = "GJC_SDK_TEST_IN_MEMORY_SESSION";

async function tempProject(): Promise<{ root: string; cwd: string; agentDir: string }> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-in-memory-session-"));
	const cwd = path.join(root, "repo");
	const agentDir = path.join(root, "agent");
	await fs.mkdir(cwd);
	await fs.mkdir(agentDir);
	return { root, cwd, agentDir };
}

async function parsedNoSession(cwd: string, agentDir: string): Promise<boolean | undefined> {
	const request = readSessionLifecycleLaunchRequest(
		JSON.stringify({
			operation: "session.create",
			sessionId: "session-1",
			stateRoot: path.join(cwd, ".gjc", "state"),
			cwd,
			...deriveLifecycleDeadlines(Date.now(), 10_000),
		}),
	);
	return (await lifecycleArgs(request, cwd, agentDir)).noSession;
}

async function withEnv(value: string, body: () => Promise<void>): Promise<void> {
	const previous = process.env[IN_MEMORY_ENV];
	process.env[IN_MEMORY_ENV] = value;
	try {
		await body();
	} finally {
		if (previous === undefined) delete process.env[IN_MEMORY_ENV];
		else process.env[IN_MEMORY_ENV] = previous;
	}
}

describe("sdk in-memory session dotenv provenance", () => {
	it("drops a project dotenv line that would disable session persistence", async () => {
		const { root, cwd, agentDir } = await tempProject();
		try {
			await fs.writeFile(path.join(cwd, ".env"), `${IN_MEMORY_ENV}=1\n`);
			await withEnv("1", async () => {
				expect(await parsedNoSession(cwd, agentDir)).toBeUndefined();
			});
		} finally {
			await fs.rm(root, { recursive: true, force: true });
		}
	});

	it("drops the in-memory session switch when the project declaration is dynamic", async () => {
		const { root, cwd, agentDir } = await tempProject();
		try {
			await fs.writeFile(path.join(cwd, ".env"), `${IN_MEMORY_ENV}=$GJC_PLANTED_IN_MEMORY\n`);
			await withEnv("1", async () => {
				expect(await parsedNoSession(cwd, agentDir)).toBeUndefined();
			});
		} finally {
			await fs.rm(root, { recursive: true, force: true });
		}
	});

	it("keeps an operator in-memory session the project does not declare", async () => {
		const { root, cwd, agentDir } = await tempProject();
		try {
			await fs.writeFile(path.join(cwd, ".env"), "UNRELATED_PROJECT_FLAG=1\n");
			await withEnv("1", async () => {
				expect(await parsedNoSession(cwd, agentDir)).toBe(true);
			});
		} finally {
			await fs.rm(root, { recursive: true, force: true });
		}
	});

	it("keeps an operator in-memory session when the project declares a different value", async () => {
		const { root, cwd, agentDir } = await tempProject();
		try {
			await fs.writeFile(path.join(cwd, ".env"), `${IN_MEMORY_ENV}=0\n`);
			await withEnv("1", async () => {
				expect(await parsedNoSession(cwd, agentDir)).toBe(true);
			});
		} finally {
			await fs.rm(root, { recursive: true, force: true });
		}
	});
});
