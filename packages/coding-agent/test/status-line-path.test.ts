import { afterEach, beforeAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { getProjectDir, setProjectDir } from "@gajae-code/utils";
import { registerOwnedDeletionRoot, safeRmSync } from "../../../scripts/safe-cleanup";
import type { SegmentContext } from "../src/modes/components/status-line/segments";
import { renderSegment } from "../src/modes/components/status-line/segments";
import { EMPTY_JOBS_SNAPSHOT } from "../src/modes/jobs-observer";

import { initTheme, theme } from "../src/modes/theme/theme";

const originalProjectDir = getProjectDir();
beforeAll(async () => {
	await initTheme();
});

function createPathContext(): SegmentContext {
	return {
		session: {
			state: {},
			isFastModeEnabled: () => false,
			modelRegistry: { isUsingOAuth: () => false },
			sessionManager: undefined,
		} as unknown as SegmentContext["session"],
		width: 120,
		options: {
			path: {
				abbreviate: false,
				maxLength: 120,
				stripWorkPrefix: true,
			},
		},
		planMode: null,
		goalMode: null,
		usageStats: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			premiumRequests: 0,
			cost: 0,
			tokensPerSecond: null,
		},
		contextPercent: 0,
		contextWindow: 0,
		autoCompactEnabled: false,
		subagentCount: 0,
		jobs: EMPTY_JOBS_SNAPSHOT,
		sessionStartTime: Date.now(),
		git: {
			branch: null,
			status: null,
			pr: null,
		},
		usage: null,
	};
}

afterEach(() => {
	setProjectDir(originalProjectDir);
});

describe("status line path segment", () => {
	it("strips the Projects root for symlink-equivalent aliases", () => {
		if (process.platform === "win32") return;

		// Issue #4794: the product derives ~/Projects from the REAL home at
		// render time, so this test keeps its real-home fixture — but the
		// recursive deletion is granted only for the exact process-created
		// directory (grant-before-create), never the home or its ancestors.
		const projectsRoot = path.join(fs.realpathSync(os.homedir()), "Projects");
		fs.mkdirSync(projectsRoot, { recursive: true });

		const realProjectDir = path.join(projectsRoot, `gjc-status-line-${process.pid}-${Date.now()}`);
		const forgetRealGrant = registerOwnedDeletionRoot(realProjectDir);
		const nestedDir = path.join(realProjectDir, "nested");
		const aliasRoot = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-status-line-alias-"));
		const homeAlias = path.join(aliasRoot, "home-link");

		try {
			fs.mkdirSync(nestedDir, { recursive: true });
			fs.symlinkSync(fs.realpathSync(os.homedir()), homeAlias, "dir");

			const aliasedDir = path.join(homeAlias, "Projects", path.basename(realProjectDir), "nested");
			setProjectDir(aliasedDir);

			const rendered = renderSegment("path", createPathContext());
			const expectedRelative = `${path.basename(realProjectDir)}${path.sep}nested`;

			expect(rendered.visible).toBe(true);
			expect(rendered.content).toContain(expectedRelative);
			expect(rendered.content).not.toContain("home-link");
			expect(rendered.content).not.toContain(`${path.sep}Projects${path.sep}`);
		} finally {
			safeRmSync(aliasRoot, { recursive: true, force: true });
			safeRmSync(realProjectDir, { recursive: true, force: true });
			forgetRealGrant();
		}
	});

	it("strips the scratch root and shows only the trailing folder inside the OS tmp dir", () => {
		const scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-status-line-scratch-"));
		try {
			setProjectDir(scratchDir);

			const rendered = renderSegment("path", createPathContext());
			expect(rendered.visible).toBe(true);
			expect(rendered.content).toContain(theme.icon.scratchFolder);
			expect(rendered.content).not.toContain(theme.icon.folder);
			// Display is just the scratch-relative tail — no leading tmpdir, no ancestor segments.
			expect(rendered.content).toContain(path.basename(scratchDir));
			expect(rendered.content).not.toContain(os.tmpdir());
		} finally {
			safeRmSync(scratchDir, { recursive: true, force: true });
		}
	});

	it("keeps nested subpaths visible under a scratch root", () => {
		const scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-status-line-scratch-nest-"));
		const nested = path.join(scratchDir, "sub", "deep");
		fs.mkdirSync(nested, { recursive: true });
		try {
			setProjectDir(nested);

			const rendered = renderSegment("path", createPathContext());
			const tail = `${path.basename(scratchDir)}${path.sep}sub${path.sep}deep`;
			expect(rendered.content).toContain(theme.icon.scratchFolder);
			expect(rendered.content).toContain(tail);
			expect(rendered.content).not.toContain(os.tmpdir());
		} finally {
			safeRmSync(scratchDir, { recursive: true, force: true });
		}
	});

	it("keeps the folder icon for scratch paths when stripWorkPrefix is disabled", () => {
		const scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-status-line-scratch-noprefix-"));
		try {
			setProjectDir(scratchDir);

			const ctx = createPathContext();
			ctx.options.path = { ...ctx.options.path, stripWorkPrefix: false };
			const rendered = renderSegment("path", ctx);
			expect(rendered.visible).toBe(true);
			expect(rendered.content).toContain(theme.icon.folder);
			expect(rendered.content).not.toContain(theme.icon.scratchFolder);
		} finally {
			safeRmSync(scratchDir, { recursive: true, force: true });
		}
	});

	it("keeps the folder icon for paths outside any scratch root", () => {
		const projectsRoot = path.join(fs.realpathSync(os.homedir()), "Projects");
		fs.mkdirSync(projectsRoot, { recursive: true });
		const realProjectDir = path.join(projectsRoot, `gjc-status-line-real-${process.pid}-${Date.now()}`);
		const forgetRealGrant = registerOwnedDeletionRoot(realProjectDir);
		fs.mkdirSync(realProjectDir);
		try {
			setProjectDir(realProjectDir);

			const rendered = renderSegment("path", createPathContext());
			expect(rendered.visible).toBe(true);
			expect(rendered.content).toContain(theme.icon.folder);
			expect(rendered.content).not.toContain(theme.icon.scratchFolder);
		} finally {
			safeRmSync(realProjectDir, { recursive: true, force: true });
			forgetRealGrant();
		}
	});
	it("keeps HOME/Projects a workspace even when HOME is nested under a broader scratch root", () => {
		if (process.platform === "win32") return;

		// Regression for CI harnesses that redirect HOME beneath the OS temp
		// dir: a broader scratch root (e.g. unconditional /tmp) is an ancestor
		// of HOME, so scratch classification must not win over ~/Projects.
		// This uses the same HOME the product sees at render time.
		const projectsRoot = path.join(fs.realpathSync(os.homedir()), "Projects");
		fs.mkdirSync(projectsRoot, { recursive: true });
		const realProjectDir = path.join(projectsRoot, `gjc-status-line-nested-${process.pid}-${Date.now()}`);
		// Issue #4794: real-home fixture kept for render semantics; deletion is
		// granted only for this exact process-created directory.
		const forgetRealGrant = registerOwnedDeletionRoot(realProjectDir);
		fs.mkdirSync(realProjectDir, { recursive: true });
		const aliasRoot = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-status-line-nested-alias-"));
		const homeAlias = path.join(aliasRoot, "home-link");

		try {
			fs.symlinkSync(fs.realpathSync(os.homedir()), homeAlias, "dir");
			const aliasedDir = path.join(homeAlias, "Projects", path.basename(realProjectDir));

			// The canonical HOME/Projects path keeps the folder icon and strips
			// the Projects root even though a scratch root encloses HOME.
			setProjectDir(realProjectDir);
			let rendered = renderSegment("path", createPathContext());
			expect(rendered.visible).toBe(true);
			expect(rendered.content).toContain(theme.icon.folder);
			expect(rendered.content).not.toContain(theme.icon.scratchFolder);
			expect(rendered.content).toContain(path.basename(realProjectDir));
			expect(rendered.content).not.toContain(`${path.sep}Projects${path.sep}`);

			// A symlink alias of the same HOME resolves equivalently.
			setProjectDir(aliasedDir);
			rendered = renderSegment("path", createPathContext());
			expect(rendered.visible).toBe(true);
			expect(rendered.content).toContain(theme.icon.folder);
			expect(rendered.content).not.toContain(theme.icon.scratchFolder);
			expect(rendered.content).not.toContain("home-link");
			expect(rendered.content).not.toContain(`${path.sep}Projects${path.sep}`);
		} finally {
			safeRmSync(aliasRoot, { recursive: true, force: true });
			safeRmSync(realProjectDir, { recursive: true, force: true });
			forgetRealGrant();
		}
	});
});
