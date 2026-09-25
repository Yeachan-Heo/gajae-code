import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { __resetVertexTokenCache, getVertexAccessToken } from "../src/providers/google-auth";
import type { FetchImpl } from "../src/types";

/**
 * Workload Identity Federation (`type: "external_account"`) for Vertex ADC (issue #5929).
 * Every HTTP hop is mocked: subject-token URL source, STS exchange, IAM impersonation.
 */

const STS_URL = "https://sts.googleapis.com/v1/token";
const IMPERSONATION_URL =
	"https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/ci@proj.iam.gserviceaccount.com:generateAccessToken";
const AUDIENCE = "//iam.googleapis.com/projects/123/locations/global/workloadIdentityPools/pool/providers/gh";
const SUBJECT_TOKEN_TYPE = "urn:ietf:params:oauth:token-type:jwt";

interface RecordedRequest {
	url: string;
	method: string;
	headers: Record<string, string>;
	body: string;
}

let tempDir: string;
const savedEnv: Record<string, string | undefined> = {};
const ENV_KEYS = ["GOOGLE_APPLICATION_CREDENTIALS", "GOOGLE_EXTERNAL_ACCOUNT_ALLOW_EXECUTABLES"] as const;

beforeEach(async () => {
	tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-wif-"));
	for (const key of ENV_KEYS) savedEnv[key] = Bun.env[key];
	__resetVertexTokenCache();
});

afterEach(async () => {
	__resetVertexTokenCache();
	for (const key of ENV_KEYS) {
		if (savedEnv[key] === undefined) delete Bun.env[key];
		else Bun.env[key] = savedEnv[key];
	}
	await fs.rm(tempDir, { recursive: true, force: true });
});

async function writeCredentialFile(creds: Record<string, unknown>): Promise<string> {
	const file = path.join(tempDir, "wif.json");
	await Bun.write(file, JSON.stringify(creds));
	Bun.env.GOOGLE_APPLICATION_CREDENTIALS = file;
	return file;
}

function headersToRecord(init: RequestInit | undefined): Record<string, string> {
	const out: Record<string, string> = {};
	new Headers(init?.headers).forEach((value, key) => {
		out[key] = value;
	});
	return out;
}

function mockFetch(routes: Record<string, (req: RecordedRequest) => Response>): {
	fetch: FetchImpl;
	requests: RecordedRequest[];
} {
	const requests: RecordedRequest[] = [];
	const fetch: FetchImpl = async (input, init) => {
		const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
		const req: RecordedRequest = {
			url,
			method: init?.method ?? "GET",
			headers: headersToRecord(init),
			body: typeof init?.body === "string" ? init.body : "",
		};
		requests.push(req);
		const route = routes[url];
		if (!route) return new Response(`no mock for ${url}`, { status: 599 });
		return route(req);
	};
	return { fetch, requests };
}

function stsOk(token = "federated-token"): Response {
	return Response.json({
		access_token: token,
		issued_token_type: "urn:ietf:params:oauth:token-type:access_token",
		token_type: "Bearer",
		expires_in: 3599,
	});
}

describe("Vertex ADC external_account (Workload Identity Federation)", () => {
	it("reads a text subject token from a file, exchanges it at STS, then impersonates the service account", async () => {
		const subjectFile = path.join(tempDir, "oidc-token");
		await Bun.write(subjectFile, "gh-oidc-jwt\n");
		await writeCredentialFile({
			type: "external_account",
			audience: AUDIENCE,
			subject_token_type: SUBJECT_TOKEN_TYPE,
			token_url: STS_URL,
			service_account_impersonation_url: IMPERSONATION_URL,
			credential_source: { file: subjectFile },
		});
		const { fetch, requests } = mockFetch({
			[STS_URL]: () => stsOk(),
			[IMPERSONATION_URL]: () =>
				Response.json({
					accessToken: "sa-access-token",
					expireTime: new Date(Date.now() + 1800_000).toISOString(),
				}),
		});

		expect(await getVertexAccessToken({ fetch })).toBe("sa-access-token");

		expect(requests.map(r => r.url)).toEqual([STS_URL, IMPERSONATION_URL]);
		const sts = new URLSearchParams(requests[0]!.body);
		expect(sts.get("grant_type")).toBe("urn:ietf:params:oauth:grant-type:token-exchange");
		expect(sts.get("subject_token")).toBe("gh-oidc-jwt");
		expect(sts.get("subject_token_type")).toBe(SUBJECT_TOKEN_TYPE);
		expect(sts.get("audience")).toBe(AUDIENCE);
		expect(sts.get("requested_token_type")).toBe("urn:ietf:params:oauth:token-type:access_token");
		expect(sts.get("scope")).toBe("https://www.googleapis.com/auth/cloud-platform");

		const imp = requests[1]!;
		expect(imp.method).toBe("POST");
		expect(imp.headers.authorization).toBe("Bearer federated-token");
		expect(JSON.parse(imp.body)).toEqual({
			scope: ["https://www.googleapis.com/auth/cloud-platform"],
			lifetime: "3600s",
		});

		// Cached: a second call performs no network round-trip.
		expect(await getVertexAccessToken({ fetch })).toBe("sa-access-token");
		expect(requests).toHaveLength(2);
	});

	it("returns the federated token directly when no impersonation URL is configured", async () => {
		const subjectFile = path.join(tempDir, "oidc-token");
		await Bun.write(subjectFile, "direct-jwt");
		await writeCredentialFile({
			type: "external_account",
			audience: AUDIENCE,
			subject_token_type: SUBJECT_TOKEN_TYPE,
			credential_source: { file: subjectFile },
		});
		const { fetch, requests } = mockFetch({ [STS_URL]: () => stsOk("federated-only") });

		expect(await getVertexAccessToken({ fetch })).toBe("federated-only");
		expect(requests.map(r => r.url)).toEqual([STS_URL]);
	});

	it("reads a json-format subject token from a URL source with configured headers", async () => {
		const tokenUrl = "https://idp.example.test/token";
		await writeCredentialFile({
			type: "external_account",
			audience: AUDIENCE,
			subject_token_type: SUBJECT_TOKEN_TYPE,
			credential_source: {
				url: tokenUrl,
				headers: { "X-Idp-Key": "idp-header" },
				format: { type: "json", subject_token_field_name: "value" },
			},
		});
		const { fetch, requests } = mockFetch({
			[tokenUrl]: () => Response.json({ value: "url-jwt", count: 1 }),
			[STS_URL]: () => stsOk("from-url"),
		});

		expect(await getVertexAccessToken({ fetch })).toBe("from-url");
		expect(requests[0]!.headers["x-idp-key"]).toBe("idp-header");
		expect(new URLSearchParams(requests[1]!.body).get("subject_token")).toBe("url-jwt");
	});

	it("uses an executable source only when explicitly allowed", async () => {
		const script = path.join(tempDir, "provider.sh");
		await Bun.write(
			script,
			[
				"#!/bin/sh",
				'[ "$GOOGLE_EXTERNAL_ACCOUNT_AUDIENCE" = "$1" ] || exit 3',
				'printf \'{"version":1,"success":true,"token_type":"urn:ietf:params:oauth:token-type:jwt","id_token":"exec-jwt"}\'',
			].join("\n"),
		);
		await fs.chmod(script, 0o755);
		await writeCredentialFile({
			type: "external_account",
			audience: AUDIENCE,
			subject_token_type: SUBJECT_TOKEN_TYPE,
			credential_source: { executable: { command: `${script} ${AUDIENCE}`, timeout_millis: 5000 } },
		});
		const { fetch, requests } = mockFetch({ [STS_URL]: () => stsOk("from-exec") });

		delete Bun.env.GOOGLE_EXTERNAL_ACCOUNT_ALLOW_EXECUTABLES;
		await expect(getVertexAccessToken({ fetch })).rejects.toThrow("GOOGLE_EXTERNAL_ACCOUNT_ALLOW_EXECUTABLES=1");
		expect(requests).toHaveLength(0);

		Bun.env.GOOGLE_EXTERNAL_ACCOUNT_ALLOW_EXECUTABLES = "1";
		expect(await getVertexAccessToken({ fetch })).toBe("from-exec");
		expect(new URLSearchParams(requests[0]!.body).get("subject_token")).toBe("exec-jwt");
	});

	it("surfaces an STS failure without echoing the subject token", async () => {
		const subjectFile = path.join(tempDir, "oidc-token");
		await Bun.write(subjectFile, "secret-subject-jwt");
		await writeCredentialFile({
			type: "external_account",
			audience: AUDIENCE,
			subject_token_type: SUBJECT_TOKEN_TYPE,
			credential_source: { file: subjectFile },
		});
		const { fetch } = mockFetch({
			[STS_URL]: () =>
				Response.json({ error: "invalid_grant", error_description: "audience mismatch" }, { status: 400 }),
		});

		const error = await getVertexAccessToken({ fetch }).catch((e: unknown) => e as Error);
		expect(error).toBeInstanceOf(Error);
		expect((error as Error).message).toContain("Google OAuth token exchange failed (400)");
		expect((error as Error).message).toContain("audience mismatch");
		expect((error as Error).message).not.toContain("secret-subject-jwt");
	});

	it("reports a missing subject token file instead of attempting the exchange", async () => {
		await writeCredentialFile({
			type: "external_account",
			audience: AUDIENCE,
			subject_token_type: SUBJECT_TOKEN_TYPE,
			credential_source: { file: path.join(tempDir, "does-not-exist") },
		});
		const { fetch, requests } = mockFetch({});

		await expect(getVertexAccessToken({ fetch })).rejects.toThrow("credential_source file is missing");
		expect(requests).toHaveLength(0);
	});

	it("names an unsupported credential type instead of misrouting it", async () => {
		await writeCredentialFile({ type: "impersonated_service_account", source_credentials: {} });
		const { fetch, requests } = mockFetch({});

		await expect(getVertexAccessToken({ fetch })).rejects.toThrow(
			'Unsupported Google credential type "impersonated_service_account"',
		);
		expect(requests).toHaveLength(0);
	});
});
