import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";

const fixture = path.resolve(import.meta.dir, "fixtures/issue-1934-bedrock-auth-child.ts");
const roots: string[] = [];

afterEach(async () => {
	await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true })));
});

type Result = Record<string, unknown>;

async function run(scenario: string, env: Record<string, string> = {}): Promise<Result> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "issue 1934 bedrock "));
	roots.push(root);
	const project = path.join(root, "project");
	const home = path.join(root, "home");
	await fs.mkdir(project, { recursive: true });
	if (scenario === "dotenv") {
		await fs.writeFile(
			path.join(project, ".env"),
			"AWS_PROFILE=dotenv-profile\nAWS_SHARED_CREDENTIALS_FILE=dotenv-credentials\nAWS_CONFIG_FILE=dotenv-config\nAWS_ACCESS_KEY_ID=dotenv-key\nAWS_SECRET_ACCESS_KEY=dotenv-secret\nAWS_BEARER_TOKEN_BEDROCK=dotenv-token\nOPENAI_API_KEY=dotenv-openai\n",
		);
	} else if (scenario === "dotenv-imds-disabled") {
		await fs.writeFile(path.join(project, ".env"), "AWS_EC2_METADATA_DISABLED=true\n");
	}
	const launcher = path.join(project, "issue-1934-bedrock-auth-launcher.ts");
	await fs.writeFile(launcher, `import ${JSON.stringify(pathToFileURL(fixture).href)};\n`);

	const useDefaultAwsPaths = scenario === "profile-home-static";
	const awsFileEnv = useDefaultAwsPaths
		? {}
		: scenario === "profile-path-spaces"
			? {
					AWS_SHARED_CREDENTIALS_FILE: path.join(root, "credentials with spaces"),
					AWS_CONFIG_FILE: path.join(root, "config with spaces"),
				}
			: {
					AWS_SHARED_CREDENTIALS_FILE: path.join(root, "credentials"),
					AWS_CONFIG_FILE: path.join(root, "config"),
				};
	const proc = Bun.spawn({
		cmd: [process.execPath, launcher, scenario, root],
		cwd: project,
		stdout: "pipe",
		stderr: "pipe",
		env: {
			PATH: Bun.env.PATH ?? "",
			HOME: home,
			USERPROFILE: home,
			TMPDIR: os.tmpdir(),
			XDG_CONFIG_HOME: path.join(root, "xdg-config"),
			XDG_DATA_HOME: path.join(root, "xdg-data"),
			XDG_STATE_HOME: path.join(root, "xdg-state"),
			XDG_CACHE_HOME: path.join(root, "xdg-cache"),
			GJC_CONFIG_DIR: path.join(root, "gjc-config"),
			GJC_CODING_AGENT_DIR: path.join(root, "agent"),
			PI_CODING_AGENT_DIR: path.join(root, "agent"),
			...(scenario === "dotenv-imds-disabled" ? {} : { AWS_EC2_METADATA_DISABLED: "true" }),
			...awsFileEnv,
			...env,
		},
	});
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	expect(exitCode).toBe(0);
	const credentialKeys = [
		"AWS_BEARER_TOKEN_BEDROCK",
		"AWS_ACCESS_KEY_ID",
		"AWS_SECRET_ACCESS_KEY",
		"AWS_SESSION_TOKEN",
	] as const;
	const scenarioSecrets = credentialKeys.flatMap(key => (env[key] ? [env[key]] : []));
	for (const secret of ["dotenv-key", "dotenv-secret", "dotenv-token", "dotenv-openai", "dummy", ...scenarioSecrets]) {
		expect(stdout).not.toContain(secret);
		expect(stderr).not.toContain(secret);
	}
	return JSON.parse(stdout) as Result;
}

type CapturedRequestSummary = {
	bearer: boolean;
	sigv4: boolean;
	bodySha256: string;
	bodyWithoutToolChoiceSha256: string;
	contentSha256?: string;
	headers: string[];
	hasToolChoice: boolean;
};

function requests(result: Result): CapturedRequestSummary[] {
	return result.requests as CapturedRequestSummary[];
}

function authorizationChanged(result: Result): boolean {
	return result.authorizationChanged === true;
}

describe("issue #1934 Bedrock credential-source isolation", () => {
	test("advertises and resolves default and named static shared profiles, including paths with spaces", async () => {
		const staticProfile = await run("profile-static");
		expect(staticProfile).toEqual({ available: true, profile: true, resolved: true });
		const namedProfile = await run("profile-named-static", { AWS_PROFILE: "team" });
		expect(namedProfile).toEqual({ available: true, profile: true, resolved: true });
		const homeProfile = await run("profile-home-static");
		expect(homeProfile).toMatchObject({ available: true, profile: true });
		const spacedPathProfile = await run("profile-path-spaces");
		expect(spacedPathProfile).toEqual({ available: true, profile: true, resolved: true });
	});

	test("advertises supported named SSO and default credential_process profile shapes without executing them", async () => {
		const sso = await run("profile-sso", { AWS_PROFILE: "team" });
		expect(sso).toEqual({ available: true, profile: true });
		const processProfile = await run("profile-process");
		expect(processProfile).toEqual({ available: true, profile: true });
	});

	test("uses complete credential-only static environment credentials for visibility and resolution", async () => {
		expect(
			await run("static-env", {
				AWS_ACCESS_KEY_ID: "test-access-key",
				AWS_SECRET_ACCESS_KEY: "test-secret-key",
				AWS_SESSION_TOKEN: "test-session-token",
			}),
		).toEqual({ available: true, resolved: true, sessionToken: true });
	});

	test("hides incomplete profiles and unsupported ECS/IRSA-only source hints", async () => {
		expect(await run("negative", { AWS_ACCESS_KEY_ID: "incomplete-access-key" })).toMatchObject({ available: false });
		expect(await run("negative")).toMatchObject({ available: false, profile: false });
		expect(await run("negative", { AWS_CONTAINER_CREDENTIALS_RELATIVE_URI: "/credentials" })).toMatchObject({
			available: false,
		});
		expect(
			await run("negative", { AWS_WEB_IDENTITY_TOKEN_FILE: "/token", AWS_ROLE_ARN: "arn:aws:iam::1:role/test" }),
		).toMatchObject({
			available: false,
		});
	});

	test("does not advertise or send requests without a credential source", async () => {
		expect(await run("no-credentials")).toEqual({ available: false, resolved: false, transportRequests: 0 });
	});

	test("fails closed for region-only, incomplete, missing, malformed, and unsupported profile shapes", async () => {
		expect(await run("profile-negative-matrix")).toEqual({
			regionOnly: false,
			incompleteStatic: false,
			incompleteSso: false,
			unsupported: false,
			missing: false,
			malformed: false,
		});
	});

	test("does not use project dotenv credentials, bearer tokens, or unrelated provider keys", async () => {
		expect(await run("dotenv")).toEqual({ available: false, openai: false, resolved: false, transportRequests: 0 });
	});

	test("honors project dotenv IMDS disable without probing metadata", async () => {
		expect(await run("dotenv-imds-disabled")).toEqual({ imdsFetches: 0, resolved: false });
	});

	test("reuses profile availability within the cache age and rescans after expiry", async () => {
		expect(await run("cache")).toEqual({
			initial: true,
			cachedWithinAge: true,
			correctedAfterMaxAge: false,
			scans: 2,
		});
	});

	test("invalidates cache entries on profile changes, deletion, and recreation", async () => {
		expect(await run("cache-transitions")).toEqual({
			initial: true,
			profileChanged: false,
			deleted: false,
			recreated: true,
		});
	});
});

describe("issue #1934 Bedrock transport auth modes", () => {
	test("uses explicit bearer mode over complete IAM credentials and does not fall back after an HTTP failure", async () => {
		const result = await run("bearer", {
			AWS_BEARER_TOKEN_BEDROCK: "test-bearer",
			AWS_ACCESS_KEY_ID: "test-access-key",
			AWS_SECRET_ACCESS_KEY: "test-secret-key",
			AWS_SESSION_TOKEN: "test-session-token",
			AWS_BEDROCK_SKIP_AUTH: "1",
		});
		const captured = requests(result);
		expect(captured).toHaveLength(1);
		expect(result.resultError).toBe("Bedrock HTTP 403: validationException: toolChoice is not supported");
		for (const request of captured) {
			expect(request).toMatchObject({ bearer: true, sigv4: false, hasToolChoice: false });
			expect(request.headers).toEqual(["accept", "authorization", "content-type"]);
		}
	});

	test("does not downgrade bearer authentication after an HTTP 401", async () => {
		const result = await run("bearer-unauthorized", {
			AWS_BEARER_TOKEN_BEDROCK: "test-bearer",
			AWS_ACCESS_KEY_ID: "test-access-key",
			AWS_SECRET_ACCESS_KEY: "test-secret-key",
			AWS_BEDROCK_SKIP_AUTH: "1",
		});
		const captured = requests(result);
		expect(captured).toHaveLength(1);
		expect(result.resultError).toBe("Bedrock HTTP 401: validationException: toolChoice is not supported");
		expect(captured[0]).toMatchObject({ bearer: true, sigv4: false, hasToolChoice: false });
		expect(captured[0]?.headers).toEqual(["accept", "authorization", "content-type"]);
	});

	test("keeps bearer-only headers across forced-tool-choice retry and prefers bearer over IAM", async () => {
		const result = await run("bearer-forced", {
			AWS_BEARER_TOKEN_BEDROCK: "test-bearer",
			AWS_ACCESS_KEY_ID: "test-access-key",
			AWS_SECRET_ACCESS_KEY: "test-secret-key",
			AWS_SESSION_TOKEN: "test-session-token",
		});
		const captured = requests(result);
		expect(captured).toHaveLength(2);
		expect(result.resultError).toMatch(/^Bedrock HTTP 400: validationException: toolChoice is not supported/);
		expect(captured.map(request => request.hasToolChoice)).toEqual([true, false]);
		for (const request of captured) {
			expect(request).toMatchObject({ bearer: true, sigv4: false });
			expect(request.headers).toEqual(["accept", "authorization", "content-type"]);
		}
	});

	test("fails closed for CR, LF, other ASCII controls, and DEL bearer tokens before fetch or SigV4", async () => {
		for (const token of ["unsafe\rheader", "unsafe\nheader", "unsafe\u0001header", "unsafe\u007fheader"]) {
			const result = await run("malformed", {
				AWS_BEARER_TOKEN_BEDROCK: token,
				AWS_ACCESS_KEY_ID: "test-access-key",
				AWS_SECRET_ACCESS_KEY: "test-secret-key",
				AWS_SESSION_TOKEN: "test-session-token",
			});
			expect(result.requests).toBe(0);
			expect(result.available).toBe(false);
			expect(result.resultError).toBe("AWS_BEARER_TOKEN_BEDROCK contains unsafe control characters.");
		}
	});

	test("signs every initial and forced-tool retry request with SigV4 when bearer is absent", async () => {
		const initial = requests(await run("sigv4", { AWS_BEDROCK_SKIP_AUTH: "1" }));
		expect(initial).toHaveLength(1);
		for (const request of initial) {
			expect(request).toMatchObject({ bearer: false, sigv4: true, hasToolChoice: false });
			expect(request.headers).toEqual(expect.arrayContaining(["host", "x-amz-content-sha256", "x-amz-date"]));
			expect(request.contentSha256).toBe(request.bodySha256);
			expect(request.headers).not.toContain("x-amz-security-token");
		}
		const retryResult = await run("bearer-forced", { AWS_BEDROCK_SKIP_AUTH: "1" });
		const retry = requests(retryResult);

		expect(retry).toHaveLength(2);
		expect(retry.map(request => request.hasToolChoice)).toEqual([true, false]);
		for (const request of retry) {
			expect(request).toMatchObject({ bearer: false, sigv4: true });
			expect(request.headers).toEqual(expect.arrayContaining(["host", "x-amz-content-sha256", "x-amz-date"]));
			expect(request.contentSha256).toBe(request.bodySha256);
			expect(request.headers).not.toContain("x-amz-security-token");
		}
		expect(authorizationChanged(retryResult)).toBe(true);
		expect(retry[0]?.bodyWithoutToolChoiceSha256).toBe(retry[1]?.bodyWithoutToolChoiceSha256);
		expect(retry[0]?.contentSha256).not.toBe(retry[1]?.contentSha256);
	});
});
