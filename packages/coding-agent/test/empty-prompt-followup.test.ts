import { expect, test } from "bun:test";
import { extensionUserMessageContentError } from "../src/modes/utils/injected-user-submission";

test("extension user message validation rejects empty text before optimistic UI bookkeeping", () => {
	expect(extensionUserMessageContentError(" \n\t ")).toMatchObject({ code: "invalid_input" });
	expect(extensionUserMessageContentError([{ type: "text", text: "\n" }])).toMatchObject({ code: "invalid_input" });
	expect(
		extensionUserMessageContentError([
			{ type: "text", text: "" },
			{ type: "image", data: "bytes", mimeType: "image/png" },
		]),
	).toBeUndefined();
	expect(extensionUserMessageContentError("valid Unicode — multiline\ntext")).toBeUndefined();
});
