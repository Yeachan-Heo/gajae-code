import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Snowflake } from "@gajae-code/utils";

const mode = process.argv[2];
const envRoot = process.env.TMPDIR;
if (!envRoot || fs.realpathSync(os.tmpdir()) !== fs.realpathSync(envRoot)) {
	console.error("recorder temp run requires TMPDIR to be the process temp root");
	process.exit(1);
}

Object.defineProperty(process, "platform", { value: "win32", configurable: true });
const emptyPath = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-stt-path-"));
process.env.PATH = emptyPath;

const created: string[] = [];

function snapshot(): Set<string> {
	return new Set(fs.readdirSync(os.tmpdir()));
}

function newScripts(before: Set<string>): string[] {
	const found: string[] = [];
	for (const name of fs.readdirSync(os.tmpdir())) {
		if (!name.startsWith("gjc-stt-record-") || before.has(name)) continue;
		const full = path.join(os.tmpdir(), name);
		created.push(full);
		const stat = fs.lstatSync(full);
		if (stat.isDirectory()) {
			const script = path.join(full, "record.ps1");
			if (fs.existsSync(script) && fs.lstatSync(script).isFile()) found.push(script);
		} else if (stat.isFile()) {
			found.push(full);
		}
	}
	return found;
}

function predictScriptId(): string {
	const fixed = 1_700_000_000_000;
	Date.now = () => fixed;
	const observed = Snowflake.next();
	const nextSeq = (Snowflake.getSequence(observed) + 1) & Snowflake.MAX_SEQUENCE;
	return Snowflake.formatParts(fixed - Snowflake.EPOCH_TIMESTAMP, nextSeq);
}

async function runAllow(): Promise<void> {
	const { startRecording } = await import("../../src/stt/recorder");
	const before = snapshot();
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-stt-out-"));
	created.push(dir);
	await startRecording(path.join(dir, "out.wav")).then(
		() => {
			throw new Error("recording started without PowerShell");
		},
		(error: unknown) => {
			const message = error instanceof Error ? error.message : String(error);
			if (!/powershell/i.test(message)) throw error;
		},
	);
	const scripts = newScripts(before);
	if (scripts.length !== 1) throw new Error(`expected one script, saw ${scripts.length}`);
	const script = scripts[0];
	if (!script || fs.lstatSync(script).isSymbolicLink()) throw new Error("script missing");
	if (!fs.readFileSync(script, "utf8").includes("alias gjc_rec")) throw new Error("script body missing");
}

async function runAttack(): Promise<void> {
	const { startRecording } = await import("../../src/stt/recorder");
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-stt-victim-"));
	created.push(dir);
	const victim = path.join(dir, "victim");
	fs.writeFileSync(victim, "SAFE");
	const now = Date.now;
	const before = snapshot();
	try {
		const id = predictScriptId();
		const linkPath = path.join(os.tmpdir(), `gjc-stt-record-${id}.ps1`);
		created.push(linkPath);
		fs.rmSync(linkPath, { force: true });
		fs.symlinkSync(victim, linkPath);
		await startRecording(path.join(dir, "out.wav")).then(
			() => {
				throw new Error("recording started without PowerShell");
			},
			(error: unknown) => {
				const message = error instanceof Error ? error.message : String(error);
				if (!/powershell/i.test(message)) throw error;
			},
		);
		if (fs.readFileSync(victim, "utf8") !== "SAFE") throw new Error("symlink target changed");
		if (!fs.lstatSync(linkPath).isSymbolicLink()) throw new Error("predicted path is not a symlink");
		const scripts = newScripts(before);
		if (scripts.length !== 1) throw new Error(`expected one script, saw ${scripts.length}`);
		const script = scripts[0];
		if (!script || script === linkPath) throw new Error("script landed on the planted symlink");
		if (!fs.readFileSync(script, "utf8").includes("alias gjc_rec")) throw new Error("script body missing");
		if (os.platform() !== "win32") {
			if ((fs.statSync(script).mode & 0o777) !== 0o600) throw new Error("script mode");
			if ((fs.statSync(path.dirname(script)).mode & 0o777) !== 0o700) throw new Error("directory mode");
		}
	} finally {
		Date.now = now;
	}
}

try {
	if (mode === "allow") await runAllow();
	else if (mode === "attack") await runAttack();
	else throw new Error(`unknown mode ${mode}`);
} catch (error) {
	console.error(error instanceof Error ? error.message : error);
	process.exitCode = 1;
} finally {
	for (const entry of created.splice(0)) fs.rmSync(entry, { recursive: true, force: true });
	fs.rmSync(emptyPath, { recursive: true, force: true });
}
