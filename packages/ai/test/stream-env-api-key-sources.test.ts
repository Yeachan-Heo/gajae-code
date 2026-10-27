import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	getEnvApiKeyCredentialSource,
	getEnvApiKeyCredentialSources,
	getEnvApiKeyEnvName,
	getEnvApiKeyEnvNames,
	getGoogleVertexCredentialSource,
} from "@gajae-code/ai/stream";

const envNames = [
	"ANTHROPIC_OAUTH_TOKEN",
	"ANTHROPIC_API_KEY",
	"ANTHROPIC_FOUNDRY_API_KEY",
	"CLAUDE_CODE_USE_FOUNDRY",
	"OPENAI_API_KEY",
	"AWS_BEARER_TOKEN_BEDROCK",
	"AWS_ACCESS_KEY_ID",
	"AWS_SECRET_ACCESS_KEY",
	"AWS_SESSION_TOKEN",
	"AWS_PROFILE",
	"AWS_SHARED_CREDENTIALS_FILE",
	"AWS_CONFIG_FILE",
	"AWS_EC2_METADATA_DISABLED",
	"KIRO_API_KEY",
	"AWS_BEARER_TOKEN_KIRO",
	"GOOGLE_CLOUD_API_KEY",
	"GOOGLE_APPLICATION_CREDENTIALS",
	"GOOGLE_CLOUD_PROJECT",
	"GCLOUD_PROJECT",
	"GOOGLE_CLOUD_LOCATION",
	"GOOGLE_EXTERNAL_ACCOUNT_ALLOW_EXECUTABLES",
	"HOME",
] as const;
const originals = new Map(envNames.map(name => [name, Bun.env[name]]));
const tempDirs: string[] = [];

afterEach(async () => {
	for (const name of envNames) {
		const original = originals.get(name);
		if (original === undefined) delete Bun.env[name];
		else Bun.env[name] = original;
	}
	for (const dir of tempDirs.splice(0)) await fs.rm(dir, { recursive: true, force: true });
});

describe("environment API-key source names", () => {
	it("reports configured environment variable names without returning their values", async () => {
		delete Bun.env.ANTHROPIC_FOUNDRY_API_KEY;
		delete Bun.env.CLAUDE_CODE_USE_FOUNDRY;
		Bun.env.ANTHROPIC_OAUTH_TOKEN = "anthropic-oauth-secret";
		Bun.env.ANTHROPIC_API_KEY = "anthropic-api-key-secret";

		expect(getEnvApiKeyEnvNames("anthropic")).toEqual(["ANTHROPIC_OAUTH_TOKEN", "ANTHROPIC_API_KEY"]);
		expect(await getEnvApiKeyEnvName("anthropic")).toBe("ANTHROPIC_OAUTH_TOKEN");
		expect(await getEnvApiKeyCredentialSource("anthropic")).toEqual({
			kind: "environment",
			name: "ANTHROPIC_OAUTH_TOKEN",
		});
	});

	it("resolves the source name for providers with a fixed environment fallback", async () => {
		Bun.env.OPENAI_API_KEY = "openai-test-secret";

		expect(getEnvApiKeyEnvNames("openai")).toEqual(["OPENAI_API_KEY"]);
		expect(await getEnvApiKeyEnvName("openai")).toBe("OPENAI_API_KEY");
	});

	it("distinguishes AWS environment credentials from an API key", async () => {
		delete Bun.env.AWS_BEARER_TOKEN_BEDROCK;
		Bun.env.AWS_EC2_METADATA_DISABLED = "true";
		Bun.env.AWS_ACCESS_KEY_ID = "aws-access-key-test";
		Bun.env.AWS_SECRET_ACCESS_KEY = "aws-secret-key-test";

		expect(await getEnvApiKeyCredentialSource("amazon-bedrock")).toEqual({
			kind: "aws",
			source: "environment-credentials",
		});
	});

	it("enumerates Bedrock environment credentials before the configured profile", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-bedrock-sources-"));
		tempDirs.push(dir);
		Bun.env.AWS_BEARER_TOKEN_BEDROCK = "bedrock-bearer-test";
		Bun.env.AWS_EC2_METADATA_DISABLED = "true";
		Bun.env.AWS_ACCESS_KEY_ID = "aws-access-key-test";
		Bun.env.AWS_SECRET_ACCESS_KEY = "aws-secret-key-test";
		Bun.env.AWS_PROFILE = "work";
		const credentialsPath = path.join(dir, "credentials");
		Bun.env.AWS_SHARED_CREDENTIALS_FILE = credentialsPath;
		Bun.env.AWS_CONFIG_FILE = path.join(dir, "config");
		await Bun.write(
			credentialsPath,
			"[work]\naws_access_key_id = profile-key\naws_secret_access_key = profile-secret\n",
		);

		const sources = await getEnvApiKeyCredentialSources("amazon-bedrock");
		expect(sources).toEqual([
			{ kind: "aws", source: "bearer-token" },
			{ kind: "aws", source: "environment-credentials" },
			{ kind: "aws", source: "profile" },
		]);
		expect(await getEnvApiKeyCredentialSource("amazon-bedrock")).toEqual(sources[0]);
	});

	it("detects IMDSv2 instance-profile credentials without fetching the role secret", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-bedrock-imds-source-"));
		tempDirs.push(dir);
		const credentialsPath = path.join(dir, "credentials");
		const configPath = path.join(dir, "config");
		await Bun.write(credentialsPath, "");
		await Bun.write(configPath, "");
		delete Bun.env.AWS_BEARER_TOKEN_BEDROCK;
		delete Bun.env.AWS_ACCESS_KEY_ID;
		delete Bun.env.AWS_SECRET_ACCESS_KEY;
		delete Bun.env.AWS_SESSION_TOKEN;
		Bun.env.AWS_PROFILE = "gjc-missing-profile";
		Bun.env.AWS_SHARED_CREDENTIALS_FILE = credentialsPath;
		Bun.env.AWS_CONFIG_FILE = configPath;
		const requests: Array<{ url: string; method: string | undefined; token: string | null }> = [];
		const fetch = async (input: Parameters<typeof globalThis.fetch>[0], init?: RequestInit): Promise<Response> => {
			const url = input instanceof URL ? input.href : String(input);
			const method = init?.method;
			const headers = new Headers(init?.headers);
			requests.push({ url, method, token: headers.get("x-aws-ec2-metadata-token") });
			if (url.endsWith("/latest/api/token")) return new Response("imds-session-token");
			if (url.endsWith("/latest/meta-data/iam/security-credentials/")) {
				return new Response("instance-profile-role");
			}
			throw new Error(`unexpected AWS metadata request: ${url}`);
		};

		Bun.env.AWS_EC2_METADATA_DISABLED = "true";
		expect(await getEnvApiKeyCredentialSources("amazon-bedrock", { fetch })).toEqual([]);
		expect(requests).toEqual([]);

		Bun.env.AWS_EC2_METADATA_DISABLED = "false";
		const sources = await getEnvApiKeyCredentialSources("amazon-bedrock", { fetch });
		expect(sources).toEqual([{ kind: "aws", source: "instance-profile" }]);
		expect(requests).toEqual([
			{
				url: "http://169.254.169.254/latest/api/token",
				method: "PUT",
				token: null,
			},
			{
				url: "http://169.254.169.254/latest/meta-data/iam/security-credentials/",
				method: undefined,
				token: "imds-session-token",
			},
		]);
	});

	it("omits Kiro environment variables rejected by the provider resolver", async () => {
		Bun.env.KIRO_API_KEY = "\x01invalid-kiro-key";
		Bun.env.AWS_BEARER_TOKEN_KIRO = "valid-kiro-bearer-test";

		expect(getEnvApiKeyEnvNames("kiro")).toEqual(["AWS_BEARER_TOKEN_KIRO"]);
		expect(await getEnvApiKeyCredentialSource("kiro")).toEqual({
			kind: "environment",
			name: "AWS_BEARER_TOKEN_KIRO",
		});
	});

	it("omits a Bedrock bearer token rejected by its provider resolver", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-bedrock-invalid-bearer-"));
		tempDirs.push(dir);
		Bun.env.AWS_BEARER_TOKEN_BEDROCK = "\x01invalid-bedrock-token";
		Bun.env.AWS_ACCESS_KEY_ID = "aws-access-key-test";
		Bun.env.AWS_SECRET_ACCESS_KEY = "aws-secret-key-test";
		Bun.env.AWS_EC2_METADATA_DISABLED = "true";
		Bun.env.AWS_PROFILE = "gjc-missing-profile";
		Bun.env.AWS_SHARED_CREDENTIALS_FILE = path.join(dir, "credentials");
		Bun.env.AWS_CONFIG_FILE = path.join(dir, "config");
		await Bun.write(Bun.env.AWS_SHARED_CREDENTIALS_FILE, "");
		await Bun.write(Bun.env.AWS_CONFIG_FILE, "");

		expect(getEnvApiKeyEnvNames("amazon-bedrock")).toEqual([]);
		expect(await getEnvApiKeyCredentialSource("amazon-bedrock")).toBeUndefined();
		expect(await getEnvApiKeyCredentialSources("amazon-bedrock")).toEqual([]);
	});

	it("tracks explicit Vertex ADC file creation and removal without stale cached presence", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-vertex-adc-source-"));
		tempDirs.push(dir);
		const credentialPath = path.join(dir, "adc.json");
		Bun.env.GOOGLE_APPLICATION_CREDENTIALS = credentialPath;
		Bun.env.GOOGLE_CLOUD_PROJECT = "test-project";
		Bun.env.GOOGLE_CLOUD_LOCATION = "us-central1";

		expect(await getEnvApiKeyCredentialSource("google-vertex")).toBeUndefined();
		expect(await getGoogleVertexCredentialSource()).toBeUndefined();
		await Bun.write(
			credentialPath,
			JSON.stringify({
				type: "authorized_user",
				client_id: "test-client",
				client_secret: "test-client-secret",
				refresh_token: "test-refresh-token",
			}),
		);
		expect(await getEnvApiKeyCredentialSource("google-vertex")).toEqual({
			kind: "google-adc",
			source: "explicit-file",
		});
		expect(await getGoogleVertexCredentialSource()).toEqual({ kind: "google-adc", source: "explicit-file" });
		await fs.rm(credentialPath);
		expect(await getEnvApiKeyCredentialSource("google-vertex")).toBeUndefined();
		expect(await getGoogleVertexCredentialSource()).toBeUndefined();
	});

	it("omits malformed, unsupported, and incomplete Vertex ADC files", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-vertex-invalid-adc-"));
		tempDirs.push(dir);
		const credentialPath = path.join(dir, "adc.json");
		Bun.env.GOOGLE_APPLICATION_CREDENTIALS = credentialPath;
		delete Bun.env.GOOGLE_CLOUD_API_KEY;
		Bun.env.GOOGLE_CLOUD_PROJECT = "test-project";
		Bun.env.GOOGLE_CLOUD_LOCATION = "us-central1";

		for (const contents of [
			"{ malformed json",
			JSON.stringify({ type: "unsupported" }),
			JSON.stringify({ type: "authorized_user", client_id: "client", client_secret: "secret" }),
		]) {
			await Bun.write(credentialPath, contents);
			expect(await getEnvApiKeyCredentialSource("google-vertex")).toBeUndefined();
			expect(await getEnvApiKeyCredentialSources("google-vertex")).toEqual([]);
		}
	});

	it("identifies valid Vertex ADC without exposing the credential file path", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-vertex-adc-"));
		tempDirs.push(dir);
		const credentialPath = path.join(dir, "adc.json");
		await Bun.write(
			credentialPath,
			JSON.stringify({
				type: "authorized_user",
				client_id: "test-client",
				client_secret: "test-client-secret",
				refresh_token: "test-refresh-token",
			}),
		);
		delete Bun.env.GOOGLE_CLOUD_API_KEY;
		Bun.env.GOOGLE_APPLICATION_CREDENTIALS = credentialPath;
		Bun.env.GOOGLE_CLOUD_PROJECT = "test-project";
		Bun.env.GOOGLE_CLOUD_LOCATION = "us-central1";

		expect(await getEnvApiKeyCredentialSource("google-vertex")).toEqual({
			kind: "google-adc",
			source: "explicit-file",
		});
	});

	it("requires trusted project and location values before reporting Vertex ADC", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-vertex-adc-routing-"));
		tempDirs.push(dir);
		const credentialPath = path.join(dir, "adc.json");
		await Bun.write(
			credentialPath,
			JSON.stringify({
				type: "authorized_user",
				client_id: "test-client",
				client_secret: "test-client-secret",
				refresh_token: "test-refresh-token",
			}),
		);
		delete Bun.env.GOOGLE_CLOUD_API_KEY;
		Bun.env.GOOGLE_APPLICATION_CREDENTIALS = credentialPath;
		delete Bun.env.GOOGLE_CLOUD_PROJECT;
		delete Bun.env.GCLOUD_PROJECT;
		delete Bun.env.GOOGLE_CLOUD_LOCATION;

		expect(await getEnvApiKeyCredentialSource("google-vertex")).toBeUndefined();

		Bun.env.GOOGLE_CLOUD_PROJECT = "trusted-test-project";
		Bun.env.GOOGLE_CLOUD_LOCATION = "us-central1";
		expect(await getEnvApiKeyCredentialSource("google-vertex")).toEqual({
			kind: "google-adc",
			source: "explicit-file",
		});

		Bun.env.GOOGLE_CLOUD_LOCATION = "us-central1/invalid-host";
		expect(await getEnvApiKeyCredentialSource("google-vertex")).toBeUndefined();
	});

	it("does not report executable Vertex ADC until its opt-in is enabled", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-vertex-adc-executable-"));
		tempDirs.push(dir);
		const credentialPath = path.join(dir, "adc.json");
		await Bun.write(
			credentialPath,
			JSON.stringify({
				type: "external_account",
				audience: "//iam.googleapis.com/projects/test/locations/global/workloadIdentityPools/test/providers/test",
				subject_token_type: "urn:ietf:params:oauth:token-type:jwt",
				credential_source: { executable: { command: "test-credential-command" } },
			}),
		);
		delete Bun.env.GOOGLE_CLOUD_API_KEY;
		delete Bun.env.GOOGLE_EXTERNAL_ACCOUNT_ALLOW_EXECUTABLES;
		Bun.env.GOOGLE_APPLICATION_CREDENTIALS = credentialPath;
		Bun.env.GOOGLE_CLOUD_PROJECT = "test-project";
		Bun.env.GOOGLE_CLOUD_LOCATION = "us-central1";

		expect(await getEnvApiKeyCredentialSources("google-vertex")).toEqual([]);

		Bun.env.GOOGLE_EXTERNAL_ACCOUNT_ALLOW_EXECUTABLES = "1";
		expect(await getEnvApiKeyCredentialSource("google-vertex")).toEqual({
			kind: "google-adc",
			source: "explicit-file",
		});
	});

	it("omits external-account ADC until its subject-token file contains a valid token", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-vertex-adc-subject-file-"));
		tempDirs.push(dir);
		const credentialPath = path.join(dir, "adc.json");
		const subjectTokenPath = path.join(dir, "subject-token");
		await Bun.write(
			credentialPath,
			JSON.stringify({
				type: "external_account",
				audience: "//iam.googleapis.com/projects/test/locations/global/workloadIdentityPools/test/providers/test",
				subject_token_type: "urn:ietf:params:oauth:token-type:jwt",
				credential_source: {
					file: subjectTokenPath,
					format: { type: "json", subject_token_field_name: "subject_token" },
				},
			}),
		);
		delete Bun.env.GOOGLE_CLOUD_API_KEY;
		Bun.env.GOOGLE_APPLICATION_CREDENTIALS = credentialPath;
		Bun.env.GOOGLE_CLOUD_PROJECT = "test-project";
		Bun.env.GOOGLE_CLOUD_LOCATION = "us-central1";

		expect(await getEnvApiKeyCredentialSource("google-vertex")).toBeUndefined();

		await Bun.write(subjectTokenPath, "");
		expect(await getEnvApiKeyCredentialSource("google-vertex")).toBeUndefined();
		await Bun.write(subjectTokenPath, JSON.stringify({}));
		expect(await getEnvApiKeyCredentialSource("google-vertex")).toBeUndefined();

		await Bun.write(subjectTokenPath, JSON.stringify({ subject_token: "subject-token-value" }));
		expect(await getEnvApiKeyCredentialSource("google-vertex")).toEqual({
			kind: "google-adc",
			source: "explicit-file",
		});
	});

	it("enumerates a Vertex API key before valid ADC", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-vertex-key-adc-"));
		tempDirs.push(dir);
		const credentialPath = path.join(dir, "adc.json");
		await Bun.write(
			credentialPath,
			JSON.stringify({
				type: "authorized_user",
				client_id: "test-client",
				client_secret: "test-client-secret",
				refresh_token: "test-refresh-token",
			}),
		);
		Bun.env.GOOGLE_CLOUD_API_KEY = "vertex-api-key-test";
		Bun.env.GOOGLE_APPLICATION_CREDENTIALS = credentialPath;
		Bun.env.GOOGLE_CLOUD_PROJECT = "test-project";
		Bun.env.GOOGLE_CLOUD_LOCATION = "us-central1";

		const sources = await getEnvApiKeyCredentialSources("google-vertex");
		expect(sources).toEqual([
			{ kind: "environment", name: "GOOGLE_CLOUD_API_KEY" },
			{ kind: "google-adc", source: "explicit-file" },
		]);
		expect(await getEnvApiKeyCredentialSource("google-vertex")).toEqual(sources[0]);
	});

	it("does not treat project metadata alone as a usable ADC source", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-vertex-metadata-no-service-account-"));
		tempDirs.push(dir);
		Bun.env.HOME = dir;
		delete Bun.env.GOOGLE_APPLICATION_CREDENTIALS;
		delete Bun.env.GOOGLE_CLOUD_API_KEY;
		Bun.env.GOOGLE_CLOUD_PROJECT = "test-project";
		Bun.env.GOOGLE_CLOUD_LOCATION = "us-central1";
		const requests: string[] = [];

		const source = await getGoogleVertexCredentialSource({
			fetch: async (input, init) => {
				const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
				requests.push(url);
				expect(new Headers(init?.headers).get("Metadata-Flavor")).toBe("Google");
				if (url.endsWith("/project/project-id")) {
					return new Response("test-project", { headers: { "Metadata-Flavor": "Google" } });
				}
				return new Response("not found", { status: 404, headers: { "Metadata-Flavor": "Google" } });
			},
		});

		expect(source).toBeUndefined();
		expect(requests).toEqual([
			"http://metadata.google.internal/computeMetadata/v1/project/project-id",
			"http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/email",
		]);
	});

	it("identifies metadata-server ADC without retrieving an access token", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-vertex-metadata-source-"));
		tempDirs.push(dir);
		Bun.env.HOME = dir;
		delete Bun.env.GOOGLE_APPLICATION_CREDENTIALS;
		delete Bun.env.GOOGLE_CLOUD_API_KEY;
		Bun.env.GOOGLE_CLOUD_PROJECT = "test-project";
		Bun.env.GOOGLE_CLOUD_LOCATION = "us-central1";
		const requests: string[] = [];

		const source = await getGoogleVertexCredentialSource({
			fetch: async (input, init) => {
				const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
				requests.push(url);
				expect(new Headers(init?.headers).get("Metadata-Flavor")).toBe("Google");
				if (url.endsWith("/project/project-id")) {
					return new Response("test-project", { headers: { "Metadata-Flavor": "Google" } });
				}
				return new Response("default@test-project.iam.gserviceaccount.com", {
					headers: { "Metadata-Flavor": "Google" },
				});
			},
		});

		expect(source).toEqual({ kind: "google-adc", source: "metadata-server" });
		expect(requests).toEqual([
			"http://metadata.google.internal/computeMetadata/v1/project/project-id",
			"http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/email",
		]);
		expect(requests).not.toContain(
			"http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token",
		);
	});
});
