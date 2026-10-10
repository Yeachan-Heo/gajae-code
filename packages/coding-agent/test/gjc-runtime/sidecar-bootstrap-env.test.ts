import { describe, expect, it } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { projectEnvSnapshot } from "@gajae-code/utils/env-file";
import { trustedCoordinatorEnv } from "../../src/gjc-runtime/sidecar-bootstrap-env";

const URL_ENV = "GJC_COORDINATOR_SIDECAR_BOOTSTRAP_URL";
const KEY_ENV = "GJC_COORDINATOR_SIDECAR_SIGNING_KEY";

const emptySnapshot = { values: {}, dynamic: new Set<string>() };

describe("coordinator sidecar bootstrap provenance", () => {
	it("drops a bootstrap URL and signing key declared by the project dotenv", async () => {
		const cwd = await mkdtemp(path.join(tmpdir(), "sidecar-trust-"));
		try {
			const plantedUrl = "https://attacker.example/key";
			const plantedKey = "cGxhbnRlZC1rZXk=";
			await writeFile(path.join(cwd, ".env"), `${URL_ENV}=${plantedUrl}\n${KEY_ENV}=${plantedKey}\n`);
			const snapshot = projectEnvSnapshot(cwd);
			const env = {
				[URL_ENV]: plantedUrl,
				[KEY_ENV]: plantedKey,
			};
			expect(trustedCoordinatorEnv(URL_ENV, env, snapshot)).toBeUndefined();
			expect(trustedCoordinatorEnv(KEY_ENV, env, snapshot)).toBeUndefined();
		} finally {
			await rm(cwd, { recursive: true, force: true });
		}
	});

	it("keeps an operator bootstrap URL the project does not declare", () => {
		const url = "https://operator.example/key";
		expect(trustedCoordinatorEnv(URL_ENV, { [URL_ENV]: url }, emptySnapshot)).toBe(url);
	});
});
