import { describe, expect, it } from "bun:test";
import { sanitizeEnv } from "../src/debug/system-info";

describe("sanitizeEnv", () => {
	it("keeps ordinary values and redacts existing secret names", () => {
		expect(
			sanitizeEnv({
				PATH: "/usr/bin",
				OPENAI_API_KEY: "sk-live",
				UNSET: undefined,
			}),
		).toEqual({
			PATH: "/usr/bin",
			OPENAI_API_KEY: "[REDACTED]",
		});
	});

	it("redacts cookie, URL, and DSN values", () => {
		expect(
			sanitizeEnv({
				COOKIE: "session=abc",
				DATABASE_URL: "postgres://user:secret@localhost/db",
				SESSION_DSN: "postgres://user:secret@localhost/db",
				GITHUB_SERVER_URL: "https://github.com",
				SERVICEURL: "https://user:secret@example",
				serviceUrl: "https://user:secret@example",
			}),
		).toEqual({
			COOKIE: "[REDACTED]",
			DATABASE_URL: "[REDACTED]",
			SESSION_DSN: "[REDACTED]",
			GITHUB_SERVER_URL: "[REDACTED]",
			SERVICEURL: "[REDACTED]",
			serviceUrl: "[REDACTED]",
		});
	});
});
