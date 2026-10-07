// A/B adapter: repeated builtin execution in one persistent native Shell session.
import { Shell } from "@gajae-code/natives";
import { runAbSuite } from "./ab-adapter";

const shell = new Shell();
const cases = [
	{
		id: "S01",
		run: async () => {
			let output = "";
			let callbackError: Error | undefined;
			const result = await shell.run({ command: "echo hi" }, (error, chunk) => {
				if (error) callbackError = error;
				else output += chunk;
			});
			if (callbackError) throw callbackError;
			if (result.exitCode !== 0 || result.cancelled || result.timedOut) {
				throw new Error(`Builtin command failed: ${JSON.stringify(result)}`);
			}
			if (!output.includes("hi")) throw new Error("Builtin command output was not captured");
		},
	},
];

await runAbSuite("shell", cases, 40).finally(async () => {
	await shell.close();
});
