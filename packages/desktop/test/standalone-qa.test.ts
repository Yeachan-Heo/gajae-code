import { expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

// Fault injection only: these tiny executables test the verifier's failure
// handling. Successful packaged-runtime proof still runs the actual app binaries.
for (const fault of ["fatal_after_shutdown", "malformed_after_shutdown", "early_eof"] as const) {
	test(`standalone verifier rejects ${fault} even with an exit-zero host`, async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "desktop-verifier-fault-"));
		const app = path.join(root, "Fixture.app");
		const directory = path.join(app, "Contents/MacOS");
		try {
			await fs.mkdir(directory, { recursive: true });
			const source = `#!${process.execPath}
import * as path from "node:path";
if (path.basename(process.argv[1]) === "gjc") { process.stdout.write("fixture-cli\\n"); process.exit(0); }
if (process.argv[2] === "sdk") { process.stdout.write('{"id":"sdk/overview/summary"}\\n'); process.exit(0); }
if (${JSON.stringify(fault)} === "early_eof") process.exit(0);
let buffer = "";
for await (const chunk of Bun.stdin.stream()) {
  buffer += new TextDecoder().decode(chunk);
  let newline = buffer.indexOf("\\n");
  while (newline >= 0) {
    const request = JSON.parse(buffer.slice(0, newline)); buffer = buffer.slice(newline + 1); newline = buffer.indexOf("\\n");
    const result = request.method === "project.open" ? { id: "p" } : request.method === "session.create" ? { id: "s" } : request.method === "operator.execute" ? { operationId: "o", status: "completed", exitCode: 0, output: ${JSON.stringify(path.join(directory, "gjc"))} } : null;
    process.stdout.write(JSON.stringify({ type: "response", id: request.id, ok: true, result }) + "\\n");
    if (request.method === "shutdown") {
      process.stdout.write(${JSON.stringify(fault)} === "fatal_after_shutdown" ? JSON.stringify({ type: "fatal", error: "late fixture fatal" }) + "\\n" : "not-json\\n");
      await Bun.sleep(20); process.exit(0);
    }
  }
}
`;
			for (const name of ["gjc", "gjc-desktop-host"]) {
				const file = path.join(directory, name);
				await Bun.write(file, source);
				await fs.chmod(file, 0o700);
			}
			const child = Bun.spawn([process.execPath, path.resolve(import.meta.dir, "../scripts/standalone-qa.ts"), app], {
				cwd: root, env: { PATH: "/usr/bin:/bin", HOME: root }, stdin: "ignore", stdout: "pipe", stderr: "pipe",
			});
			const [code, output, error] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
			expect(code).not.toBe(0);
			expect(output).not.toContain('"hostExitCode": 0');
			expect(error).toContain(fault === "fatal_after_shutdown" ? "late fixture fatal" : fault === "malformed_after_shutdown" ? "JSON" : "Host");
		} finally { await fs.rm(root, { recursive: true, force: true }); }
	}, 30_000);
}
