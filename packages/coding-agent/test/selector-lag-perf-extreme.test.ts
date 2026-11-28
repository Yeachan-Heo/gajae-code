import { describe, it } from "bun:test";
import { fuzzyFilter } from "@gajae-code/tui";

interface Session {
	id: string;
	title?: string;
	cwd?: string;
	firstMessage?: string;
	recap?: string;
	allMessagesText: string;
	path: string;
}

function generateRealisticSessions(count: number): Session[] {
	const titles = [
		"Debugging auth flow",
		"Implementing feature X",
		"Code review for PR #123",
		"Database migration",
		"Testing payment integration",
		"Fixing performance issue",
		"Writing documentation",
		"Refactoring legacy code",
		"Setting up CI/CD",
		"Security audit",
	];
	const projects = ["frontend", "backend", "api", "dashboard", "mobile"];

	const sessions: Session[] = [];
	for (let i = 0; i < count; i++) {
		const title = titles[i % titles.length];
		const project = projects[i % projects.length];
		sessions.push({
			id: `session-${i}`,
			title: `${title} ${i}`,
			cwd: `/home/user/${project}/src`,
			firstMessage: `Working on ${title.toLowerCase()}`,
			recap: `Summary of ${title.toLowerCase()} session`,
			allMessagesText: `various content for session ${i}`,
			path: `/home/user/.gjc/sessions/session-${i}.json`,
		});
	}
	return sessions;
}

describe("selector performance - extreme queries", () => {
	it("should measure fuzzy filtering on 200 items (typical narrow query)", () => {
		const sessions = generateRealisticSessions(2000);
		const filtered = sessions.filter(s => s.title!.toLowerCase().includes("debug"));

		const searchTextCache = new Map<Session, string>();
		for (const session of filtered) {
			const searchText = [
				session.id,
				session.title ?? "",
				session.cwd ?? "",
				session.firstMessage ?? "",
				session.recap ?? "",
				session.allMessagesText,
				session.path,
			]
				.filter(Boolean)
				.join(" ");
			searchTextCache.set(session, searchText);
		}

		const start = performance.now();
		for (let i = 0; i < 100; i++) {
			fuzzyFilter(filtered, "debug", session => searchTextCache.get(session)!);
		}
		const duration = performance.now() - start;
		console.log(`Fuzzy filtering 200 items x100: ${duration.toFixed(2)}ms`);
		console.log(`Per query: ${(duration / 100).toFixed(2)}ms`);
	});

	it("should measure fuzzy filtering on 1000 items (broad query)", () => {
		const sessions = generateRealisticSessions(2000);
		const filtered = sessions.filter(
			s => s.title?.toLowerCase().includes("code") || s.title?.toLowerCase().includes("feature"),
		);

		const searchTextCache = new Map<Session, string>();
		for (const session of filtered) {
			const searchText = [
				session.id,
				session.title ?? "",
				session.cwd ?? "",
				session.firstMessage ?? "",
				session.recap ?? "",
				session.allMessagesText,
				session.path,
			]
				.filter(Boolean)
				.join(" ");
			searchTextCache.set(session, searchText);
		}

		const start = performance.now();
		for (let i = 0; i < 20; i++) {
			fuzzyFilter(filtered, "code", session => searchTextCache.get(session)!);
		}
		const duration = performance.now() - start;
		console.log(`Fuzzy filtering ${filtered.length} items x20: ${duration.toFixed(2)}ms`);
		console.log(`Per query: ${(duration / 20).toFixed(2)}ms`);
	});

	it("should measure fuzzy filtering on 2000 items (worst case - nearly all sessions)", () => {
		const sessions = generateRealisticSessions(2000);

		const searchTextCache = new Map<Session, string>();
		for (const session of sessions) {
			const searchText = [
				session.id,
				session.title ?? "",
				session.cwd ?? "",
				session.firstMessage ?? "",
				session.recap ?? "",
				session.allMessagesText,
				session.path,
			]
				.filter(Boolean)
				.join(" ");
			searchTextCache.set(session, searchText);
		}

		const start = performance.now();
		for (let i = 0; i < 5; i++) {
			fuzzyFilter(sessions, "feature", session => searchTextCache.get(session)!);
		}
		const duration = performance.now() - start;
		console.log(`Fuzzy filtering 2000 items x5: ${duration.toFixed(2)}ms`);
		console.log(`Per query: ${(duration / 5).toFixed(2)}ms`);
	});
});
