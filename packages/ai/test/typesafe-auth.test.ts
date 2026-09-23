import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

const authModule = new URL("../src/auth-storage.ts", import.meta.url).href;

async function resolveInIsolatedProcess(options: {
	shell?: string;
	project?: string;
	stored?: boolean;
}): Promise<boolean> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-typesafe-auth-"));
	try {
		const project = path.join(root, "project");
		const home = path.join(root, "home");
		await fs.mkdir(project);
		await fs.mkdir(home);
		if (options.project) await Bun.write(path.join(project, ".env"), `TYPESAFE_API_KEY=${options.project}\n`);
		const script = path.join(project, "probe.ts");
		await Bun.write(
			script,
			`import { AuthStorage, SqliteAuthCredentialStore } from ${JSON.stringify(authModule)};
const store = await SqliteAuthCredentialStore.open(${JSON.stringify(path.join(root, "auth.db"))});
try {
 const auth = new AuthStorage(store);
 if (${Boolean(options.stored)}) await auth.set("typesafe", [{ type: "api_key", key: "stored-test-key" }]);
 const key = await auth.getApiKey("typesafe", "isolated-typesafe-test", { signal: AbortSignal.timeout(5000) });
 process.stdout.write(JSON.stringify(key === ${options.stored ? '"stored-test-key"' : options.shell ? JSON.stringify(options.shell) : "undefined"}));
} finally { store.close(); }
`,
		);
		const child = Bun.spawn([process.execPath, script], {
			cwd: project,
			env: {
				PATH: process.env.PATH ?? "",
				HOME: home,
				GJC_CONFIG_DIR: path.join(home, ".gjc"),
				GJC_CODING_AGENT_DIR: path.join(home, ".gjc", "agent"),
				...(options.shell ? { TYPESAFE_API_KEY: options.shell } : {}),
			},
			stdout: "pipe",
			stderr: "pipe",
		});
		const [stdout, stderr, exitCode] = await Promise.all([
			new Response(child.stdout).text(),
			new Response(child.stderr).text(),
			child.exited,
		]);
		expect(exitCode, stderr).toBe(0);
		return JSON.parse(stdout) === true;
	} finally {
		await fs.rm(root, { recursive: true, force: true });
	}
}

describe("typesafe AuthStorage credential ingress", () => {
	it("resolves a trusted launching-shell key with a clean credential store", async () => {
		expect(await resolveInIsolatedProcess({ shell: "trusted-test-key" })).toBe(true);
	});
	it("does not turn a project-only dotenv key into authorization", async () => {
		expect(await resolveInIsolatedProcess({ project: "project-test-key" })).toBe(true);
	});
	it("keeps the stored key ahead of the environment fallback", async () => {
		expect(await resolveInIsolatedProcess({ shell: "trusted-test-key", stored: true })).toBe(true);
	});
	it("returns no credential when neither a stored nor trusted key exists", async () => {
		expect(await resolveInIsolatedProcess({})).toBe(true);
	});
});
