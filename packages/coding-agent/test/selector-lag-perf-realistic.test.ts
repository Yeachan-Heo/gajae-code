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

describe("selector performance - realistic usage", () => {
	it("should measure session filtering for selective queries (2000 sessions)", () => {
		const sessions = generateRealisticSessions(2000);

		// Pre-build search text cache (simulates the constructor behavior)
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

		// Measure filtering with queries that match only a few sessions
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
				const prescreened = sessions.filter(session => {
					const searchText = searchTextCache.get(session)!;
					return searchText.toLowerCase().includes(queryLower);
				});

				// Apply fuzzy ranking to prescreened results
				fuzzyFilter(prescreened, query, session => searchTextCache.get(session)!);
			}
		}

		const duration = performance.now() - start;
		console.log(`Session filtering (2000 sessions, 20 realistic keystrokes): ${duration.toFixed(2)}ms`);
		console.log(`Per keystroke: ${(duration / 20).toFixed(2)}ms`);
		expect(duration).toBeLessThan(500); // Should be <25ms per keystroke
	});

	it("should measure session filtering for broad queries (2000 sessions)", () => {
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

		// Measure filtering with broad queries that match all/most sessions
		const start = performance.now();

		// Broad query sequences that match many sessions
		const querySequences = [
			["s", "se", "ses", "sess", "sessio", "session"], // "session" matches all
			["w", "wo", "wor", "work", "worki", "working"], // "working" matches many
		];

		for (const querySequence of querySequences) {
			for (const query of querySequence) {
				const queryLower = query.toLowerCase();

				// Fast substring pre-filter
				const prescreened = sessions.filter(session => {
					const searchText = searchTextCache.get(session)!;
					return searchText.toLowerCase().includes(queryLower);
				});

				// Apply fuzzy ranking to prescreened results
				fuzzyFilter(prescreened, query, session => searchTextCache.get(session)!);
			}
		}

		const duration = performance.now() - start;
		console.log(`Session filtering broad queries (2000 sessions, 12 keystrokes): ${duration.toFixed(2)}ms`);
		console.log(`Per keystroke: ${(duration / 12).toFixed(2)}ms`);
		// Broad queries will be slower since they match more sessions
		expect(duration).toBeLessThan(2000); // Should be <166ms per keystroke
	});
});
