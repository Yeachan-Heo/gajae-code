import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/**
 * `buildAnthropicClientOptions()` installs Foundry CA and mTLS material from
 * `NODE_EXTRA_CA_CERTS`, `CLAUDE_CODE_CLIENT_CERT`, and `CLAUDE_CODE_CLIENT_KEY`.
 * `$env` includes the caller's `cwd/.env`, so a repository could previously
 * replace the trust anchor or present its own client certificate.
 *
 * The project snapshot is read from `process.cwd()`, so these drive a child
 * process with a controlled directory.
 */

const PROBE = path.join(import.meta.dir, "fixtures", "foundry-tls-probe.ts");
const TLS_KEYS = ["NODE_EXTRA_CA_CERTS", "CLAUDE_CODE_CLIENT_CERT", "CLAUDE_CODE_CLIENT_KEY"] as const;

interface ResolvedTls {
	error: string | null;
	serverName: string | null;
	extraCa: string | null;
	cert: string | null;
	key: string | null;
	env: Record<(typeof TLS_KEYS)[number], string | null>;
}

const tempDirs: string[] = [];

function projectDir(dotenv?: string): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-foundry-tls-trust-"));
	tempDirs.push(dir);
	if (dotenv !== undefined) fs.writeFileSync(path.join(dir, ".env"), dotenv);
	return dir;
}

afterEach(() => {
	for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

async function resolveIn(cwd: string, overrides: Record<string, string> = {}): Promise<ResolvedTls> {
	const env: Record<string, string> = {};
	for (const [key, value] of Object.entries(process.env)) {
		if (value !== undefined) env[key] = value;
	}
	for (const key of ["CLAUDE_CODE_USE_FOUNDRY", "FOUNDRY_BASE_URL", "ANTHROPIC_BASE_URL", ...TLS_KEYS]) {
		delete env[key];
	}
	env.CLAUDE_CODE_USE_FOUNDRY = "1";
	env.FOUNDRY_BASE_URL = "https://foundry.example.com";
	Object.assign(env, overrides);

	const proc = Bun.spawn([process.execPath, PROBE], { cwd, env, stdout: "pipe", stderr: "pipe" });
	const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
	const exitCode = await proc.exited;
	if (exitCode !== 0) throw new Error(`probe failed (${exitCode}): ${stderr}`);
	return JSON.parse(stdout.trim()) as ResolvedTls;
}

function writePem(dir: string, name: string, body: string): string {
	const filePath = path.join(dir, name);
	fs.writeFileSync(filePath, body, "utf8");
	return filePath;
}

describe("Foundry TLS material trust boundary", () => {
	it("ignores CA and mTLS material declared by the project .env", async () => {
		const dir = projectDir();
		const caPath = writePem(dir, "ca.pem", "-----BEGIN CERTIFICATE-----\nPROJECT-CA\n-----END CERTIFICATE-----\n");
		const keyPath = writePem(
			dir,
			"client-key.pem",
			"-----BEGIN PRIVATE KEY-----\nPROJECT-KEY\n-----END PRIVATE KEY-----\n",
		);
		const certInline = "-----BEGIN CERTIFICATE-----PROJECT-CERT-----END CERTIFICATE-----";
		fs.writeFileSync(
			path.join(dir, ".env"),
			`NODE_EXTRA_CA_CERTS=${caPath}\nCLAUDE_CODE_CLIENT_CERT=${certInline}\nCLAUDE_CODE_CLIENT_KEY=${keyPath}\n`,
		);

		const resolved = await resolveIn(dir);
		expect(resolved.error).toBeNull();
		expect(resolved.serverName).toBe("foundry.example.com");
		expect(resolved.env.NODE_EXTRA_CA_CERTS).toBe(caPath);
		expect(resolved.env.CLAUDE_CODE_CLIENT_CERT).toBe(certInline);
		expect(resolved.env.CLAUDE_CODE_CLIENT_KEY).toBe(keyPath);
		expect(resolved.extraCa).toBeNull();
		expect(resolved.cert).toBeNull();
		expect(resolved.key).toBeNull();
	});

	it("still ignores project TLS material after the dotenv file is removed", async () => {
		const dir = projectDir();
		const caPath = writePem(dir, "ca.pem", "-----BEGIN CERTIFICATE-----\nPROJECT-CA\n-----END CERTIFICATE-----\n");
		fs.writeFileSync(path.join(dir, ".env"), `NODE_EXTRA_CA_CERTS=${caPath}\n`);
		const resolved = await resolveIn(dir, { GJC_FOUNDRY_TLS_PROBE_DROP: "unlink" });
		expect(resolved.error).toBeNull();
		expect(resolved.env.NODE_EXTRA_CA_CERTS).toBe(caPath);
		expect(resolved.extraCa).toBeNull();
	});

	it("still ignores project TLS material after the process cwd changes", async () => {
		const dir = projectDir();
		const caPath = writePem(dir, "ca.pem", "-----BEGIN CERTIFICATE-----\nPROJECT-CA\n-----END CERTIFICATE-----\n");
		fs.writeFileSync(path.join(dir, ".env"), `NODE_EXTRA_CA_CERTS=${caPath}\n`);
		const resolved = await resolveIn(dir, { GJC_FOUNDRY_TLS_PROBE_DROP: "chdir" });
		expect(resolved.error).toBeNull();
		expect(resolved.env.NODE_EXTRA_CA_CERTS).toBe(caPath);
		expect(resolved.extraCa).toBeNull();
	});

	it("ignores Foundry TLS material produced from a $ or backtick declaration", async () => {
		const dir = projectDir();
		const caPath = writePem(dir, "ca.pem", "-----BEGIN CERTIFICATE-----\nDYNAMIC-CA\n-----END CERTIFICATE-----\n");
		const keyPath = writePem(
			dir,
			"client-key.pem",
			"-----BEGIN PRIVATE KEY-----\nDYNAMIC-KEY\n-----END PRIVATE KEY-----\n",
		);
		fs.writeFileSync(
			path.join(dir, ".env"),
			"NODE_EXTRA_CA_CERTS=$EVIL_CA_PATH\nCLAUDE_CODE_CLIENT_CERT=`printf %s planted-cert`\nCLAUDE_CODE_CLIENT_KEY=$EVIL_KEY_PATH\n",
		);

		const resolved = await resolveIn(dir, {
			EVIL_CA_PATH: caPath,
			EVIL_KEY_PATH: keyPath,
		});
		expect(resolved.error).toBeNull();
		expect(resolved.serverName).toBe("foundry.example.com");
		expect(resolved.env.NODE_EXTRA_CA_CERTS).toBe(caPath);
		expect(resolved.env.CLAUDE_CODE_CLIENT_CERT).toBe("printf %s planted-cert");
		expect(resolved.env.CLAUDE_CODE_CLIENT_KEY).toBe(keyPath);
		expect(resolved.extraCa).toBeNull();
		expect(resolved.cert).toBeNull();
		expect(resolved.key).toBeNull();
	});

	it("ignores a double-quoted project PEM whose escapes Bun already decoded", async () => {
		const dir = projectDir(
			'NODE_EXTRA_CA_CERTS="-----BEGIN CERTIFICATE-----\\nESCAPED-CA\\n-----END CERTIFICATE-----\\n"\n' +
				'CLAUDE_CODE_CLIENT_CERT="-----BEGIN CERTIFICATE-----\\nESCAPED-CERT\\n-----END CERTIFICATE-----\\n"\n' +
				'CLAUDE_CODE_CLIENT_KEY="-----BEGIN PRIVATE KEY-----\\nESCAPED-KEY\\n-----END PRIVATE KEY-----\\n"\n',
		);

		const resolved = await resolveIn(dir);
		expect(resolved.error).toBeNull();
		expect(resolved.serverName).toBe("foundry.example.com");
		expect(resolved.env.NODE_EXTRA_CA_CERTS).toContain("ESCAPED-CA");
		expect(resolved.env.NODE_EXTRA_CA_CERTS).toContain("\n");
		expect(resolved.env.NODE_EXTRA_CA_CERTS).not.toContain("\\n");
		expect(resolved.env.CLAUDE_CODE_CLIENT_CERT).toContain("ESCAPED-CERT");
		expect(resolved.env.CLAUDE_CODE_CLIENT_KEY).toContain("ESCAPED-KEY");
		expect(resolved.extraCa).toBeNull();
		expect(resolved.cert).toBeNull();
		expect(resolved.key).toBeNull();
	});

	it("keeps operator Foundry TLS material the project does not declare", async () => {
		const dir = projectDir("UNRELATED=1\n");
		const caPath = writePem(dir, "ca.pem", "-----BEGIN CERTIFICATE-----\nOPERATOR-CA\n-----END CERTIFICATE-----\n");
		const certPath = writePem(
			dir,
			"client-cert.pem",
			"-----BEGIN CERTIFICATE-----\nOPERATOR-CERT\n-----END CERTIFICATE-----\n",
		);
		const keyPath = writePem(
			dir,
			"client-key.pem",
			"-----BEGIN PRIVATE KEY-----\nOPERATOR-KEY\n-----END PRIVATE KEY-----\n",
		);

		const resolved = await resolveIn(dir, {
			NODE_EXTRA_CA_CERTS: caPath,
			CLAUDE_CODE_CLIENT_CERT: certPath,
			CLAUDE_CODE_CLIENT_KEY: keyPath,
		});
		expect(resolved.error).toBeNull();
		expect(resolved.serverName).toBe("foundry.example.com");
		expect(resolved.env.NODE_EXTRA_CA_CERTS).toBe(caPath);
		expect(resolved.extraCa).toContain("OPERATOR-CA");
		expect(resolved.cert).toContain("OPERATOR-CERT");
		expect(resolved.key).toContain("OPERATOR-KEY");
	});

	it("keeps an operator value when the project declares a different static value", async () => {
		const dir = projectDir(
			"NODE_EXTRA_CA_CERTS=/project/not-operator-ca.pem\n" +
				"CLAUDE_CODE_CLIENT_CERT=-----BEGIN CERTIFICATE-----PROJECT-CERT-----END CERTIFICATE-----\n" +
				"CLAUDE_CODE_CLIENT_KEY=/project/not-operator-key.pem\n",
		);
		const caPath = writePem(dir, "ca.pem", "-----BEGIN CERTIFICATE-----\nOPERATOR-CA\n-----END CERTIFICATE-----\n");
		const certPath = writePem(
			dir,
			"client-cert.pem",
			"-----BEGIN CERTIFICATE-----\nOPERATOR-CERT\n-----END CERTIFICATE-----\n",
		);
		const keyPath = writePem(
			dir,
			"client-key.pem",
			"-----BEGIN PRIVATE KEY-----\nOPERATOR-KEY\n-----END PRIVATE KEY-----\n",
		);

		const resolved = await resolveIn(dir, {
			NODE_EXTRA_CA_CERTS: caPath,
			CLAUDE_CODE_CLIENT_CERT: certPath,
			CLAUDE_CODE_CLIENT_KEY: keyPath,
		});
		expect(resolved.error).toBeNull();
		expect(resolved.serverName).toBe("foundry.example.com");
		expect(resolved.extraCa).toContain("OPERATOR-CA");
		expect(resolved.extraCa).not.toContain("PROJECT");
		expect(resolved.cert).toContain("OPERATOR-CERT");
		expect(resolved.key).toContain("OPERATOR-KEY");
	});
});
