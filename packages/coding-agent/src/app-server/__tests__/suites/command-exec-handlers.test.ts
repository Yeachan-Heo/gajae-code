import { expect, test } from "bun:test";
import { stableValidators } from "../../protocol-source/schema-validators.generated";
import {
	commandExecHandler,
	commandExecHandlers,
	commandExecResizeHandler,
	commandExecTerminateHandler,
	commandExecWriteHandler,
} from "../../suites/command-exec-handlers";

const base = { tty: false, streamStdin: true, streamStdoutStderr: true, disableOutputCap: true, disableTimeout: true };

test("command/exec runs real command and routes output to the connection", async () => {
	const deltas: Array<{ target: string; params: Record<string, unknown> }> = [];
	const result = await commandExecHandler(
		{ ...base, command: ["echo", "hello"] },
		{
			connectionId: "conn-real",
			emitTo: (target, method, params) => {
				if (method === "command/exec/outputDelta")
					deltas.push({ target, params: params as Record<string, unknown> });
			},
		},
	);
	expect(result.ok).toBe(true);
	if (result.ok) {
		expect(stableValidators.clientRequestResults["command/exec"](result.result)).toBe(true);
		expect((result.result as Record<string, unknown>).stdout).toContain("hello");
	}
	expect(deltas.length).toBeGreaterThan(0);
	expect(deltas[0]?.target).toBe("conn-real");
});

test("command/exec write sends stdin to cat", async () => {
	const id = "cat-test";
	const context = { connectionId: "cat-conn" };
	const run = commandExecHandler({ ...base, command: ["cat"], processId: id }, context);
	await new Promise(r => setTimeout(r, 20));
	expect(
		(
			await commandExecWriteHandler(
				{ processId: id, deltaBase64: Buffer.from("input").toString("base64"), closeStdin: true },
				context,
			)
		).ok,
	).toBe(true);
	const result = await run;
	expect(result.ok).toBe(true);
	if (result.ok) expect((result.result as Record<string, unknown>).stdout).toBe("input");
});

test("command/exec tty uses PtySession and supports resize", async () => {
	const id = "pty-test";
	const context = { connectionId: "pty-conn" };
	const run = commandExecHandler(
		{ ...base, tty: true, command: ["sh", "-c", "sleep 0.2"], processId: id, size: { rows: 24, cols: 80 } },
		context,
	);
	await new Promise(r => setTimeout(r, 20));
	expect(await commandExecResizeHandler({ processId: id, size: { rows: 30, cols: 100 } }, context)).toMatchObject({
		ok: true,
	});
	expect((await commandExecTerminateHandler({ processId: id }, context)).ok).toBe(true);
	expect((await run).ok).toBe(true);
});

test("output cap and timeout are reported truthfully", async () => {
	const capDeltas: Array<Record<string, unknown>> = [];
	const capped = await commandExecHandler(
		{
			tty: false,
			streamStdin: false,
			streamStdoutStderr: true,
			disableOutputCap: false,
			outputBytesCap: 3,
			disableTimeout: true,
			command: ["printf", "abcdef"],
		},
		{
			connectionId: "cap-conn",
			emitTo: (_target, _method, params) => capDeltas.push(params as Record<string, unknown>),
		},
	);
	expect(capped.ok).toBe(true);
	expect(capDeltas.some(delta => delta.capReached === true)).toBe(true);
	const timedOut = await commandExecHandler(
		{
			tty: false,
			streamStdin: false,
			streamStdoutStderr: false,
			disableOutputCap: true,
			disableTimeout: false,
			timeoutMs: 20,
			command: ["sleep", "1"],
		},
		{ connectionId: "timeout-conn" },
	);
	expect(timedOut).toMatchObject({ ok: true, result: { exitCode: 124 } });
});

test("unknown ids and invalid params return pinned errors", async () => {
	expect(
		await commandExecWriteHandler({ processId: "missing", closeStdin: true }, { connectionId: "missing-conn" }),
	).toMatchObject({ ok: false, errorKey: "notFound" });
	expect(await commandExecHandler({ command: [] })).toMatchObject({ ok: false, errorKey: "invalidParams" });
	expect(Object.keys(commandExecHandlers)).toEqual([
		"command/exec",
		"command/exec/write",
		"command/exec/resize",
		"command/exec/terminate",
	]);
});
