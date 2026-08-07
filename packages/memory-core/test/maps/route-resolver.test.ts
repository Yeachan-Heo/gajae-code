import { describe, expect, it } from "bun:test";

import { parseRoutes, type RouteConfig, resolveRoutes } from "../../src/maps/route-resolver";

describe("routes.yaml parsing and resolution", () => {
	it("parses v1 routes, aliases, intents, scopes, and explicit defaults", () => {
		const parsed = parseRoutes(
			[
				"version: 1",
				"routes:",
				"  conventions:",
				"    targets:",
				"      - memory://project/acme/conventions.md",
				"    aliases: [standards, style guide]",
				"    intents: [project-convention]",
				"    scopes: [project]",
				"  current-task:",
				"    targets: [memory://session/s1/task.md]",
				"    intents: [current-task-status]",
				"    default: true",
				"defaults: [conventions]",
			].join("\n"),
		);
		expect(parsed.ok).toBe(true);
		if (!parsed.ok) return;
		expect(parsed.value.routes[0]).toMatchObject({
			id: "conventions",
			targets: ["memory://project/acme/conventions.md"],
			aliases: ["conventions", "standards", "style guide"],
			intents: ["project-convention"],
			scopes: ["project"],
		});
		expect(parsed.value.defaults).toEqual(["conventions"]);
	});

	it("rejects malformed, unknown, duplicate, and unsafe YAML/routes", () => {
		expect(parseRoutes("version: 2\nroutes: {}").ok).toBe(false);
		expect(parseRoutes("version: 1\nroutes: {}\nunknown: true").ok).toBe(false);
		expect(parseRoutes("version: 1\nversion: 1\nroutes: {}").ok).toBe(false);
		expect(
			parseRoutes(["version: 1", "routes:", "  unsafe:", "    targets: [memory://global/../secret.md]"].join("\n"))
				.ok,
		).toBe(false);
		expect(
			parseRoutes(
				["version: 1", "routes:", "  archive:", "    targets: [memory://global/archive/old.md]"].join("\n"),
			).ok,
		).toBe(false);
	});

	it("selects at most four routes by session, project, then global scope and records exclusions", () => {
		const parsed = parseRoutes(
			[
				"version: 1",
				"routes:",
				"  current-task:",
				"    targets:",
				"      - memory://global/task.md",
				"      - memory://project/acme/task.md",
				"      - memory://session/s1/task.md",
				"      - memory://session/s1/other.md",
				"      - memory://project/acme/other.md",
				"    intents: [current-task-status]",
			].join("\n"),
		);
		expect(parsed.ok).toBe(true);
		if (!parsed.ok) return;
		const resolved = resolveRoutes(parsed.value, {
			query: "current task",
			intent: "current-task-status",
			enabledScopes: ["global", "project", "session"],
			availableMapUris: [
				"memory://global/task.md",
				"memory://project/acme/task.md",
				"memory://session/s1/task.md",
				"memory://session/s1/other.md",
				"memory://project/acme/other.md",
			],
		});
		expect(resolved.ok).toBe(true);
		if (!resolved.ok) return;
		expect(resolved.value.selectedRoutes).toHaveLength(4);
		expect(resolved.value.selectedRoutes.map(route => route.scope)).toEqual([
			"session",
			"session",
			"project",
			"project",
		]);
		expect(resolved.value.truncated).toBe(true);
		expect(resolved.value.exclusionReasons).toContain("map-limit");
	});

	it("uses explicit defaults when no intent route matches", () => {
		const config: RouteConfig = {
			version: 1,
			routes: [
				{
					id: "profile",
					targets: ["memory://global/profile.md"],
					aliases: ["profile"],
					intents: [],
					scopes: [],
					queryTokens: [],
					default: false,
					sourceIndex: 0,
				},
			],
			defaults: ["profile"],
		};
		const resolved = resolveRoutes(config, {
			query: "unrelated query",
			intent: "generic-recall",
			enabledScopes: ["global"],
			availableMapUris: ["memory://global/profile.md"],
		});
		expect(resolved.ok).toBe(true);
		if (resolved.ok) expect(resolved.value.selectedRoutes[0]?.match).toBe("default");
	});
	it("routes continuity intents to the available session checkpoint", () => {
		const config: RouteConfig = { version: 1, routes: [], defaults: [] };
		for (const intent of ["resume-session", "current-task-status"] as const) {
			const resolved = resolveRoutes(config, {
				intent,
				enabledScopes: ["global", "project", "session"],
				availableMapUris: [
					"memory://project/acme/checkpoint.md",
					"memory://session/s1/notes.md",
					"memory://session/s1/checkpoint.md",
				],
			});
			expect(resolved.ok).toBe(true);
			if (!resolved.ok) continue;
			expect(resolved.value.selectedRoutes).toEqual([
				{
					uri: "memory://session/s1/checkpoint.md",
					routeId: "session-checkpoint",
					scope: "session",
					match: "default",
					sourceIndex: 0,
				},
			]);
		}
	});

	it("does not route to a checkpoint when the session scope is unavailable", () => {
		const config: RouteConfig = { version: 1, routes: [], defaults: [] };
		for (const enabledScopes of [
			["global", "project"],
			["global", "session"],
		] as const) {
			const resolved = resolveRoutes(config, {
				intent: "resume-session",
				enabledScopes,
				availableMapUris:
					enabledScopes[1] === "session"
						? ["memory://session/s1/notes.md"]
						: ["memory://session/s1/checkpoint.md"],
			});
			expect(resolved.ok).toBe(true);
			if (!resolved.ok) continue;
			expect(resolved.value.selectedRoutes).toEqual([]);
			expect(resolved.value.consideredRoutes).toEqual([]);
			expect(resolved.value.truncated).toBe(false);
		}
	});

	it("prefers an explicit continuity route over the built-in checkpoint route", () => {
		const config: RouteConfig = {
			version: 1,
			routes: [
				{
					id: "task",
					targets: ["memory://project/acme/task.md"],
					aliases: [],
					intents: ["current-task-status"],
					scopes: ["project"],
					queryTokens: [],
					default: false,
					sourceIndex: 0,
				},
			],
			defaults: [],
		};
		const resolved = resolveRoutes(config, {
			intent: "current-task-status",
			enabledScopes: ["global", "project", "session"],
			availableMapUris: ["memory://session/s1/checkpoint.md", "memory://project/acme/task.md"],
		});
		expect(resolved.ok).toBe(true);
		if (resolved.ok) {
			expect(resolved.value.selectedRoutes.map(route => route.uri)).toEqual(["memory://project/acme/task.md"]);
			expect(resolved.value.selectedRoutes[0]?.routeId).toBe("task");
		}
	});
});
