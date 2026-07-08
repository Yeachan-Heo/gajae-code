import { afterEach, describe, expect, it, spyOn } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { getProjectDir, setProjectDir } from "@gajae-code/utils";
import { FooterComponent } from "../../../src/modes/components/footer";
import type { AgentSession } from "../../../src/session/agent-session";

function makeTempRepo(): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "footer-git-watch-"));
	fs.mkdirSync(path.join(dir, ".git"));
	fs.writeFileSync(path.join(dir, ".git", "HEAD"), "ref: refs/heads/main\n");
	return dir;
}

async function waitFor(condition: () => boolean, timeoutMs = 2000): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (condition()) return true;
		await new Promise(resolve => setTimeout(resolve, 10));
	}
	return condition();
}

describe("FooterComponent git watcher lifecycle", () => {
	const previousProjectDir = getProjectDir();
	let tempDir: string | null = null;

	afterEach(() => {
		setProjectDir(previousProjectDir);
		if (tempDir) {
			fs.rmSync(tempDir, { recursive: true, force: true });
			tempDir = null;
		}
	});

	it("does not install a watcher when dispose() outruns the async setup", async () => {
		tempDir = makeTempRepo();
		setProjectDir(tempDir);

		const realWatch = fs.watch;
		const created: fs.FSWatcher[] = [];
		const watchSpy = spyOn(fs, "watch").mockImplementation(((
			filename: fs.PathLike,
			listener: (event: fs.WatchEventType, name: string | null) => void,
		) => {
			const watcher = realWatch(filename, listener);
			created.push(watcher);
			return watcher;
		}) as typeof fs.watch);

		try {
			const footer = new FooterComponent({} as unknown as AgentSession);
			// dispose() runs while git.head.resolve() is still in flight — the
			// watcher must not be installed afterwards (it would leak the fd and
			// keep firing branch-change callbacks on a disposed component).
			footer.watchBranch(() => {});
			footer.dispose();

			await new Promise(resolve => setTimeout(resolve, 200));
			expect(created.length).toBe(0);
		} finally {
			for (const watcher of created) watcher.close();
			watchSpy.mockRestore();
		}
	});

	it("still fires onBranchChange for HEAD changes after setup completes", async () => {
		tempDir = makeTempRepo();
		setProjectDir(tempDir);

		const realWatch = fs.watch;
		const created: fs.FSWatcher[] = [];
		const watchSpy = spyOn(fs, "watch").mockImplementation(((
			filename: fs.PathLike,
			listener: (event: fs.WatchEventType, name: string | null) => void,
		) => {
			const watcher = realWatch(filename, listener);
			created.push(watcher);
			return watcher;
		}) as typeof fs.watch);

		const footer = new FooterComponent({} as unknown as AgentSession);
		try {
			let branchChanges = 0;
			footer.watchBranch(() => {
				branchChanges++;
			});

			expect(await waitFor(() => created.length === 1)).toBe(true);

			fs.writeFileSync(path.join(tempDir, ".git", "HEAD"), "ref: refs/heads/other\n");
			expect(await waitFor(() => branchChanges > 0)).toBe(true);
		} finally {
			footer.dispose();
			for (const watcher of created) watcher.close();
			watchSpy.mockRestore();
		}
	});
});
