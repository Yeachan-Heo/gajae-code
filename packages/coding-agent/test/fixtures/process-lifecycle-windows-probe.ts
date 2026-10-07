/** Isolated real-process regression: deliberately incomplete owners die with this fixture runtime. */
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { liveOwnedProcessCount, spawnOwnedProcess } from "@gajae-code/coding-agent/runtime/process-lifecycle";
import type { Process } from "@gajae-code/natives";
import { nativeProcessBindings } from "@gajae-code/utils/native-process";

const mode = process.argv[2];
if (process.platform !== "win32" || !["exited-intermediate", "exited-direct", "live-direct"].includes(mode)) {
	throw new Error("Windows probe requires a supported fixture mode");
}
const directory = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-windows-tree-"));
const leafMarker = path.join(directory, "leaf.pid");
const launcherMarker = path.join(directory, "launcher.pid");
const releaseMarker = path.join(directory, "release");
const quote = (value: string): string => `'${value.replaceAll("'", "''")}'`;
const encode = (source: string): string => Buffer.from(source, "utf16le").toString("base64");
const command = (source: string): string[] => [
	"powershell.exe",
	"-WindowStyle",
	"Hidden",
	"-NoProfile",
	"-NonInteractive",
	"-EncodedCommand",
	encode(source),
];
const leafSource = "Start-Sleep -Seconds 30";
const spawnLeaf = `$leaf = Start-Process -FilePath powershell.exe -WindowStyle Hidden -ArgumentList '-NoProfile -NonInteractive -EncodedCommand ${encode(leafSource)}' -PassThru; [IO.File]::WriteAllText(${quote(leafMarker)}, [string]$leaf.Id); $leaf.Dispose();`;
// The handshake allows this fixture to pin each exact incarnation before it
// exits. Those fixture handles are not given to the owner under test.
const awaitRelease = `$deadline = [DateTime]::UtcNow.AddSeconds(20); while (!(Test-Path -LiteralPath ${quote(releaseMarker)}) -and [DateTime]::UtcNow -lt $deadline) { Start-Sleep -Milliseconds 20 };`;
const launcherSource = `${spawnLeaf} ${awaitRelease}`;
const rootSource =
	mode === "exited-intermediate"
		? `$launcher = Start-Process -FilePath powershell.exe -WindowStyle Hidden -ArgumentList '-NoProfile -NonInteractive -EncodedCommand ${encode(launcherSource)}' -PassThru; [IO.File]::WriteAllText(${quote(launcherMarker)}, [string]$launcher.Id); $launcher.WaitForExit(); $launcher.Dispose(); Start-Sleep -Milliseconds 100;`
		: `${spawnLeaf} ${awaitRelease}`;
const baseline = liveOwnedProcessCount();
const control = spawnOwnedProcess(command(leafSource), { name: "windows-probe-unrelated", gracefulMs: -1 });
const owner = spawnOwnedProcess(command(rootSource), { name: `windows-probe-${mode}`, gracefulMs: -1 });
const bindings = nativeProcessBindings();
const root = bindings.Process.fromPid(owner.pid ?? -1);
const unrelated = bindings.Process.fromPid(control.pid ?? -1);
let leaf: Process | null = null;
let launcher: Process | null = null;
let report: Record<string, unknown> | undefined;

async function markerPid(marker: string): Promise<number> {
	const deadline = Date.now() + 15_000;
	while (Date.now() < deadline) {
		try {
			const pid = Number((await Bun.file(marker).text()).trim());
			if (Number.isSafeInteger(pid) && pid > 0) return pid;
		} catch {
			/* marker has not been published yet */
		}
		await Bun.sleep(20);
	}
	throw new Error(`fixture marker timed out: ${marker}`);
}

async function terminatePinned(processReference: Process | null): Promise<void> {
	if (!processReference || processReference.status() !== bindings.ProcessStatus.Running) return;
	processReference.signalRoot(9);
	if (!(await processReference.waitForExit({ timeoutMs: 2_000 }))) {
		throw new Error(`fixture cleanup failed for pinned PID ${processReference.pid}`);
	}
}

async function cleanupFixtures(): Promise<void> {
	// Every signal targets only a fixture-owned pinned handle. Continue cleaning
	// the other fixtures even when one owned handle cannot be terminated.
	const cleanup = await Promise.allSettled([
		terminatePinned(leaf),
		terminatePinned(launcher),
		terminatePinned(root),
		control.dispose(),
	]);
	cleanup.push(...(await Promise.allSettled([terminatePinned(unrelated), owner.dispose()])));
	const resolvedDirectory = path.resolve(directory);
	const temporaryRoot = `${path.resolve(os.tmpdir())}${path.sep}`;
	if (
		!resolvedDirectory.startsWith(temporaryRoot) ||
		!path.basename(resolvedDirectory).startsWith("gjc-windows-tree-")
	) {
		throw new Error("fixture cleanup refused an unexpected temporary path");
	}
	await fs.rm(resolvedDirectory, { recursive: true, force: true });
	const failures = cleanup.filter(result => result.status === "rejected").map(result => result.reason);
	if (failures.length > 0) throw new AggregateError(failures, "Windows fixture cleanup was incomplete");
}

try {
	if (!root || !unrelated) throw new Error("could not pin fixture roots");
	leaf = bindings.Process.fromPid(await markerPid(leafMarker));
	if (!leaf) throw new Error("could not pin fixture leaf");
	if (mode === "exited-intermediate") {
		launcher = bindings.Process.fromPid(await markerPid(launcherMarker));
		if (!launcher || leaf.ppid !== launcher.pid || launcher.ppid !== root.pid) {
			throw new Error("fixture ancestry does not match root -> launcher -> leaf");
		}
	} else if (leaf.ppid !== root.pid) {
		throw new Error("fixture leaf does not belong to the root");
	}
	if (mode !== "live-direct") {
		await Bun.write(releaseMarker, "release");
		if (!(await owner.awaitExit({ timeoutMs: 5_000 })).exited) throw new Error("fixture root did not exit");
	}
	const result = await owner.dispose();
	let diagnostic = "";
	if (mode !== "live-direct") {
		try {
			await root.terminate({ gracefulMs: -1, timeoutMs: 1_000 });
		} catch (error) {
			diagnostic = error instanceof Error ? error.message : String(error);
		}
	}
	report = {
		mode,
		result,
		rootPid: root.pid,
		rootIdentity: root.incarnation,
		rootStatus: root.status(),
		leafPid: leaf.pid,
		leafIdentity: leaf.incarnation,
		leafParent: leaf.ppid,
		leafStatus: leaf.status(),
		launcherPid: launcher?.pid,
		launcherIdentity: launcher?.incarnation,
		launcherStatus: launcher?.status(),
		controlStatus: unrelated.status(),
		retainedOwners: liveOwnedProcessCount() - baseline,
		ownerDisposed: owner.disposed,
		diagnostic,
	};
} finally {
	await cleanupFixtures();
}
if (!report) throw new Error("fixture did not produce a report");
process.stdout.write(`${JSON.stringify(report)}\n`);
