import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { buildCredentialAutoImportNotice, runExternalCredentialAutoImport } from "../src/setup/credential-auto-import";
import {
	discoverExternalCredentials,
	formatCredentialSummary,
	isAutoImportOAuthCredential,
} from "../src/setup/credential-import";

const SOCIAL_ACCESS = "kiro-social-access-secret-value";
const SOCIAL_REFRESH = "kiro-social-refresh-secret-value";
const PROFILE_ARN = "arn:aws:codewhisperer:us-east-1:123456789012:profile/social-profile";

describe("Kiro CLI social credential discovery", () => {
	let homeDir = "";

	afterEach(async () => {
		if (homeDir) await fs.rm(homeDir, { recursive: true, force: true });
		homeDir = "";
	});

	async function createDatabase(databasePath: string, value: string): Promise<void> {
		await fs.mkdir(path.dirname(databasePath), { recursive: true });
		const database = new Database(databasePath);
		try {
			database.exec("CREATE TABLE auth_kv (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
			database.prepare("INSERT INTO auth_kv (key, value) VALUES (?, ?)").run("kirocli:social:token", value);
		} finally {
			database.close();
		}
	}

	test("reads social OAuth tokens from the Linux Kiro CLI database", async () => {
		homeDir = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-kiro-import-linux-"));
		const databasePath = path.join(homeDir, ".local", "share", "kiro-cli", "data.sqlite3");
		const expiresAt = new Date(Date.now() - 60_000).toISOString();
		await createDatabase(
			databasePath,
			JSON.stringify({
				access_token: SOCIAL_ACCESS,
				refresh_token: SOCIAL_REFRESH,
				expires_at: expiresAt,
				profile_arn: PROFILE_ARN,
				provider: "google",
			}),
		);

		const result = await discoverExternalCredentials({ homeDir, env: {}, platform: "linux" });
		expect(result.importable).toHaveLength(1);
		const imported = result.importable[0]!;
		expect(imported).toMatchObject({
			provider: "kiro",
			origin: "kiro-cli-social",
			kind: "oauth",
			source: "Kiro CLI (social login)",
			expiresAt: Date.parse(expiresAt),
		});
		if (imported.credential.type !== "oauth") throw new Error("expected Kiro OAuth credential");
		expect(imported.credential).toMatchObject({
			access: SOCIAL_ACCESS,
			refresh: SOCIAL_REFRESH,
			profileArn: PROFILE_ARN,
			expires: Date.parse(expiresAt),
		});
		expect(formatCredentialSummary(imported)).not.toContain(SOCIAL_ACCESS);
		expect(formatCredentialSummary(imported)).not.toContain(SOCIAL_REFRESH);
		expect(isAutoImportOAuthCredential(imported)).toBe(true);
	});

	test("discovers the macOS app-support database and accepts expired refreshable tokens at startup", async () => {
		homeDir = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-kiro-import-macos-"));
		const databasePath = path.join(homeDir, "Library", "Application Support", "kiro-cli", "data.sqlite3");
		await createDatabase(
			databasePath,
			JSON.stringify({
				access_token: SOCIAL_ACCESS,
				refresh_token: SOCIAL_REFRESH,
				expires_at: new Date(Date.now() - 3_600_000).toISOString(),
				profile_arn: PROFILE_ARN,
				provider: "github",
			}),
		);

		const discovery = await discoverExternalCredentials({ homeDir, env: {}, platform: "darwin" });
		const imports: string[] = [];
		const summary = await runExternalCredentialAutoImport({
			authStorage: {
				importCredentialIfAbsent: async provider => {
					imports.push(provider);
					return { inserted: true, reason: "inserted", provider, entries: [] };
				},
			},
			discover: async () => discovery,
			trigger: "startup",
		});

		expect(imports).toEqual(["kiro"]);
		expect(summary.imported).toHaveLength(1);
		expect(summary.discovery?.importable[0]?.expiresAt).toBeLessThan(Date.now());
		expect(buildCredentialAutoImportNotice(summary)).toBe("Imported 1 external OAuth credential(s) into gjc: Kiro.");
	});

	test("reports malformed token rows without exposing database secrets", async () => {
		homeDir = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-kiro-import-invalid-"));
		const databasePath = path.join(homeDir, "kiro.sqlite3");
		await createDatabase(databasePath, `${SOCIAL_ACCESS} malformed-json`);

		const result = await discoverExternalCredentials({
			homeDir,
			env: {},
			platform: "linux",
			kiroCliDatabasePath: databasePath,
		});
		const diagnostic = JSON.stringify(result);
		expect(result.importable).toHaveLength(0);
		expect(result.skipped).toHaveLength(1);
		expect(diagnostic).not.toContain(SOCIAL_ACCESS);
		expect(diagnostic).not.toContain(SOCIAL_REFRESH);
	});
});
