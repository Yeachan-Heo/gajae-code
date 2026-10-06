import { describe, expect, it } from "bun:test";
import { expandEnvVarsDeep } from "../src/discovery/helpers";

describe("expandEnvVarsDeep project SSH secrets", () => {
	it("keeps ordinary expansion and does not substitute sensitive names when asked", () => {
		const env = { HOME: "/home/me", AWS_SECRET_ACCESS_KEY: "sek", DATABASE_URL: "postgres://user:pw@db" };
		const home = ["$", "{HOME}"].join("");
		const secret = ["$", "{AWS_SECRET_ACCESS_KEY}"].join("");
		const database = ["$", "{DATABASE_URL}"].join("");
		expect(expandEnvVarsDeep(home, env)).toBe("/home/me");
		expect(expandEnvVarsDeep(`host ${home} key ${secret}`, env, true)).toBe(`host /home/me key ${secret}`);
		expect(expandEnvVarsDeep(database, env, true)).toBe(database);
	});
});
