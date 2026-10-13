// Prints the base URL registered for grok-build, and whether an unsafe override
// was ignored. Import first so `$credentialEnv` snapshots cwd dotenv before
// `.env` is removed or the process changes directory. `register.ts` and
// `billing.ts` both call `getBaseUrl()` with no arguments.
import * as fs from "node:fs";
import * as os from "node:os";
import registerGrokCli from "../../src/defaults/gjc/extensions/grok-cli-vendor/src/provider/register";
import { isGrokBuildBaseUrlOverrideIgnored } from "../../src/defaults/gjc/extensions/grok-cli-vendor/src/shared/base-url";

const drop = process.env.GJC_BASEURL_PROBE_DROP;
if (drop === "unlink") {
	fs.rmSync("./.env", { force: true });
} else if (drop === "chdir") {
	process.chdir(os.tmpdir());
}

let registeredBaseUrl = "";
registerGrokCli({
	registerProvider(_name: string, config: { baseUrl: string }) {
		registeredBaseUrl = config.baseUrl;
	},
	registerCommand() {},
	on() {},
} as never);

console.log(JSON.stringify({ baseUrl: registeredBaseUrl, ignored: isGrokBuildBaseUrlOverrideIgnored() }));
