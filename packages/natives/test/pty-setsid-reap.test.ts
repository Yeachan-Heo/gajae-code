import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PtySession } from "../native/index.js";

const ESCAPE_SCRIPT = `use POSIX;
my $pidfile = $ENV{PTY_ESCAPE_PID} or die "missing pidfile\\n";
my $pid = fork();
die "fork: $!\\n" unless defined $pid;
if ($pid == 0) {
	POSIX::setsid() == -1 and die "setsid: $!\\n";
	my $child = fork();
	die "fork2: $!\n" unless defined $child;
	if ($child == 0) {
		my $original_ppid = getppid();
		open my $fh, ">", $pidfile or die "open: $!\n";
		print $fh "$$ $original_ppid\n";
		close $fh;
		sleep 60;
		exit 0;
	}
	select(undef, undef, undef, 0.5);
	exit 0;
}
sleep 60;
`;

function processAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

async function waitUntil(predicate: () => boolean, timeoutMs: number): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (predicate()) return true;
		await Bun.sleep(20);
	}
	return predicate();
}

type ChildIdentity = { pid: number; originalPpid: number };

function readChildIdentity(path: string): ChildIdentity | undefined {
	try {
		const [pidText, ppidText] = readFileSync(path, "utf8").trim().split(/\s+/);
		const pid = Number(pidText);
		const originalPpid = Number(ppidText);
		return Number.isInteger(pid) && pid > 0 && Number.isInteger(originalPpid) && originalPpid > 0
			? { pid, originalPpid }
			: undefined;
	} catch {
		return undefined;
	}
}

function readPid(path: string): number | undefined {
	return readChildIdentity(path)?.pid;
}

function escapeFiles(): { dir: string; script: string; pid: string } {
	const dir = mkdtempSync(join(tmpdir(), "pty-setsid-"));
	const script = join(dir, "escape.pl");
	const pid = join(dir, "escape.pid");
	writeFileSync(script, ESCAPE_SCRIPT);
	return { dir, script, pid };
}

async function waitReparented(pidPath: string): Promise<number> {
	let child: ChildIdentity | undefined;
	const found = await waitUntil(() => {
		child ??= readChildIdentity(pidPath);
		if (child === undefined) return false;
		const ppid = Number(
			Bun.spawnSync(["ps", "-o", "ppid=", "-p", String(child.pid)])
				.stdout.toString()
				.trim(),
		);
		return Number.isInteger(ppid) && ppid !== child.originalPpid;
	}, 8_000);
	if (!found || child === undefined) throw new Error("setsid grandchild was not reparented");
	return child.pid;
}

test.skipIf(process.platform === "win32")(
	"keeps an unrelated process alive when a PTY command is cancelled",
	async () => {
		const sibling = Bun.spawn(["sleep", "30"], { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
		try {
			const session = new PtySession();
			const controller = new AbortController();
			const run = session.start({
				command: "sleep 30",
				shell: "sh",
				timeoutMs: 10_000,
				signal: controller.signal,
			});
			await Bun.sleep(300);
			controller.abort();
			const result = await run;
			expect(session).toBeDefined();
			expect(result.cancelled).toBe(true);
			expect(processAlive(sibling.pid)).toBe(true);
			console.log("(pass) keeps an unrelated process alive when a PTY command is cancelled");
		} finally {
			sibling.kill();
		}
	},
	20_000,
);

test.skipIf(process.platform === "win32")(
	"cancel reaps a reparented setsid grandchild",
	async () => {
		const files = escapeFiles();
		let grandchild: number | undefined;
		try {
			const session = new PtySession();
			const controller = new AbortController();
			const run = session.start({
				command: 'perl "$PTY_ESCAPE_SCRIPT"',
				env: { PTY_ESCAPE_SCRIPT: files.script, PTY_ESCAPE_PID: files.pid },
				shell: "sh",
				timeoutMs: 20_000,
				signal: controller.signal,
			});
			grandchild = await waitReparented(files.pid);
			controller.abort();
			const result = await run;
			expect(session).toBeDefined();
			expect(result.cancelled).toBe(true);
			const reaped = await waitUntil(() => !processAlive(grandchild!), 3_000);
			if (!reaped) console.log("(fail) cancel reaps a reparented setsid grandchild");
			expect(reaped).toBe(true);
			console.log("(pass) cancel reaps a reparented setsid grandchild");
		} finally {
			if (grandchild !== undefined && processAlive(grandchild)) process.kill(grandchild, "SIGKILL");
			rmSync(files.dir, { recursive: true, force: true });
		}
	},
	20_000,
);

test.skipIf(process.platform === "win32")(
	"timeout reaps a reparented setsid grandchild",
	async () => {
		const files = escapeFiles();
		let grandchild: number | undefined;
		try {
			const session = new PtySession();
			const run = session.start({
				command: 'perl "$PTY_ESCAPE_SCRIPT"',
				env: { PTY_ESCAPE_SCRIPT: files.script, PTY_ESCAPE_PID: files.pid },
				shell: "sh",
				timeoutMs: 3_000,
			});
			const result = await run;
			expect(session).toBeDefined();
			expect(result.timedOut).toBe(true);
			grandchild = readPid(files.pid);
			expect(grandchild).toBeDefined();
			const reaped = await waitUntil(() => !processAlive(grandchild!), 3_000);
			if (!reaped) console.log("(fail) timeout reaps a reparented setsid grandchild");
			expect(reaped).toBe(true);
			console.log("(pass) timeout reaps a reparented setsid grandchild");
		} finally {
			if (grandchild !== undefined && processAlive(grandchild)) process.kill(grandchild, "SIGKILL");
			rmSync(files.dir, { recursive: true, force: true });
		}
	},
	20_000,
);
