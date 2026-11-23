import { describe, expect, it } from "bun:test";
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

describe("selector performance - with MAX_FUZZY_CANDIDATES cap", () => {
	it("should measure session filtering with capping (2000 sessions)", () => {
		const sessions = generateRealisticSessions(2000);

		// Pre-build search text cache
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

		// Realistic query sequences
		const querySequences = [
			["a", "au", "aut", "auth"], // "auth" matches ~200 sessions
			["d", "de", "deb", "debu", "debug"], // "debug" matches ~200 sessions
			["p", "pa", "pay", "paym", "paymen", "payment"], // "payment" matches ~200 sessions
			["s", "se", "sec", "secu", "secur", "security"], // "security" matches ~200 sessions
		];

		for (const querySequence of querySequences) {
			for (const query of querySequence) {
				const queryLower = query.toLowerCase();

				// Fast substring pre-filter
				const prescreened: Session[] = [];
				for (const session of sessions) {
					const searchText = searchTextCache.get(session)!;
					if (searchText.toLowerCase().includes(queryLower)) {
						prescreened.push(session);
					}
				}

				// Apply fuzzy ranking only if prescreened list is small enough
				const MAX_FUZZY_CANDIDATES = 500;
				if (prescreened.length > MAX_FUZZY_CANDIDATES) {
					// Skip fuzzy matching for very broad queries
				} else {
					fuzzyFilter(prescreened, query, session => searchTextCache.get(session)!);
				}
			}
		}

		const duration = performance.now() - start;
		console.log(`Session filtering with capping (2000 sessions, 20 keystrokes): ${duration.toFixed(2)}ms`);
		console.log(`Per keystroke: ${(duration / 20).toFixed(2)}ms`);
		expect(duration).toBeLessThan(500); // Should be <25ms per keystroke
	});

	it("should measure the cost of building search text repeatedly", () => {
		const sessions = generateRealisticSessions(2000);

		const start = performance.now();

		for (let i = 0; i < 100; i++) {
			for (const session of sessions) {
				const _ = [
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
			}
		}
		const duration = performance.now() - start;
		console.log(`Building search text 100 times (2000 sessions each): ${duration.toFixed(2)}ms`);
		console.log(`Per session per build: ${(duration / 100 / 2000).toFixed(4)}ms`);
		console.log(`Per keystroke equivalent (20 keystrokes): ${(duration / 100 / 20).toFixed(2)}ms`);
	});

	it("should measure the cost of substring filtering alone (no fuzzy)", () => {
		const sessions = generateRealisticSessions(2000);

		// Pre-build search text cache
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

		const querySequences = [
			["a", "au", "aut", "auth"],
			["d", "de", "deb", "debu", "debug"],
			["p", "pa", "pay", "paym", "paymen", "payment"],
			["s", "se", "sec", "secu", "secur", "security"],
		];

		for (const querySequence of querySequences) {
			for (const query of querySequence) {
				const queryLower = query.toLowerCase();

				// Just substring filter, no fuzzy
				const prescreened: Session[] = [];
				for (const session of sessions) {
					const searchText = searchTextCache.get(session)!;
					if (searchText.toLowerCase().includes(queryLower)) {
						prescreened.push(session);
					}
				}
			}
		}

		const duration = performance.now() - start;
		console.log(`Substring filtering only (2000 sessions, 20 keystrokes): ${duration.toFixed(2)}ms`);
		console.log(`Per keystroke: ${(duration / 20).toFixed(2)}ms`);
		expect(duration).toBeLessThan(100); // Should be <5ms per keystroke
	});
});
