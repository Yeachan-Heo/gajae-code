import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { hasResolvableAwsProfileSource } from "../src/providers/aws-credential-config";

const MAX_AWS_INI_FILE_BYTES = 1024 * 1024;
const ENV_KEYS = ["AWS_PROFILE", "AWS_SHARED_CREDENTIALS_FILE", "AWS_CONFIG_FILE"] as const;
const credentialConfigModule = path.resolve(import.meta.dir, "../src/providers/aws-credential-config.ts");

let root: string;
const savedEnv = new Map<string, string | undefined>();

beforeEach(async () => {
	for (const key of ENV_KEYS) {
		savedEnv.set(key, Bun.env[key]);
		delete Bun.env[key];
	}
	root = await fs.mkdtemp(path.join(os.tmpdir(), "aws-credential-config-"));
});

afterEach(async () => {
	for (const [key, value] of savedEnv) {
		if (value === undefined) delete Bun.env[key];
		else Bun.env[key] = value;
	}
	savedEnv.clear();
	await fs.rm(root, { recursive: true, force: true });
});

function useSources(credentialsPath: string, configPath: string): void {
	Bun.env.AWS_SHARED_CREDENTIALS_FILE = credentialsPath;
	Bun.env.AWS_CONFIG_FILE = configPath;
}

async function writeSources(credentials: string, config = ""): Promise<void> {
	const credentialsPath = path.join(root, "credentials");
	const configPath = path.join(root, "config");
	await Promise.all([fs.writeFile(credentialsPath, credentials), fs.writeFile(configPath, config)]);
	useSources(credentialsPath, configPath);
}

describe("AWS profile availability file probing", () => {
	test("detects a valid normal credentials INI with CRLF line endings", async () => {
		await writeSources(
			"[default]\r\naws_access_key_id = test-access-key\r\naws_secret_access_key = test-secret-key\r\n",
		);

		expect(hasResolvableAwsProfileSource()).toBe(true);
	});

	test("treats directories and device paths as unavailable", async () => {
		const missing = path.join(root, "missing");
		useSources(root, missing);
		expect(hasResolvableAwsProfileSource()).toBe(false);

		if (process.platform !== "win32") {
			useSources("/dev/null", missing);
			expect(hasResolvableAwsProfileSource()).toBe(false);
		}
	});

	test("treats oversized credentials and config files as unavailable", async () => {
		const oversized = "#".repeat(MAX_AWS_INI_FILE_BYTES + 1);
		await writeSources(oversized);
		expect(hasResolvableAwsProfileSource()).toBe(false);

		await writeSources("", oversized);
		expect(hasResolvableAwsProfileSource()).toBe(false);
	});

	test("parses a credentials file at the size limit", async () => {
		const credentials = "[default]\naws_access_key_id = test-access-key\naws_secret_access_key = test-secret-key\n";
		await writeSources(`${credentials}${"#".repeat(MAX_AWS_INI_FILE_BYTES - credentials.length)}`);

		expect(hasResolvableAwsProfileSource()).toBe(true);
	});

	test("returns unavailable for a FIFO before the child-process deadline", async () => {
		if (process.platform === "win32") return;

		const fifoPath = path.join(root, "credentials.fifo");
		const mkfifo = Bun.spawn({ cmd: ["mkfifo", fifoPath] });
		expect(await mkfifo.exited).toBe(0);
		const configPath = path.join(root, "missing-config");
		const script = [
			`import { hasResolvableAwsProfileSource } from ${JSON.stringify(pathToFileURL(credentialConfigModule).href)};`,
			"if (hasResolvableAwsProfileSource()) process.exit(1);",
		].join("\n");
		const child = Bun.spawn({
			cmd: [process.execPath, "--eval", script],
			env: {
				PATH: Bun.env.PATH ?? "",
				HOME: root,
				AWS_SHARED_CREDENTIALS_FILE: fifoPath,
				AWS_CONFIG_FILE: configPath,
			},
		});
		const exitCode = await Promise.race([child.exited, Bun.sleep(1_000).then(() => "timeout" as const)]);
		if (exitCode === "timeout") {
			child.kill("SIGKILL");
			await child.exited;
			throw new Error("AWS profile availability blocked while opening a FIFO");
		}
		expect(exitCode).toBe(0);
	});
});
