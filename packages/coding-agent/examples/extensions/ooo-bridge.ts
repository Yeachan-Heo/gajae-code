import type { ExtensionAPI } from "@gajae-code/coding-agent";
import { createOuroborosOooBridge } from "@gajae-code/coding-agent/extensibility/extensions";

export default function (pi: ExtensionAPI) {
	pi.on("input", createOuroborosOooBridge());
}
