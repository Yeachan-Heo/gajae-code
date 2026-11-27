import { describe, expect, it, mock } from "bun:test";
import { AcpPromptImageStaging } from "../src/modes/acp/prompt-image-staging";
import type { SessionAttachment } from "../src/sdk/router";

function fixture() {
	let connectionId = "connection-a";
	let uploads = 0;
	const discarded: string[] = [];
	const adapter = {
		currentAttachment: () => ({ connectionId, generation: 1, isCurrent: () => true }) as SessionAttachment,
		stagePromptImage: mock(async () => `${connectionId}-${++uploads}`),
		discardPromptImage: async (id: string) => {
			discarded.push(id);
		},
	};
	return {
		adapter,
		discarded,
		reconnect: () => {
			connectionId = "connection-b";
		},
	};
}

const image = { data: "YQ==", mimeType: "image/png" };

describe("ACP staged image connection ownership", () => {
	it("restages on the same adapter after connection replacement", async () => {
		const { adapter, discarded, reconnect } = fixture();
		const staging = new AcpPromptImageStaging([image], "batch", () => true);
		await staging.stage(adapter);
		reconnect();
		const send = mock(async (ids: Array<{ id: string }>) => ids);
		expect(await staging.submit(adapter, send)).toEqual([{ id: "connection-b-2" }]);
		expect(adapter.stagePromptImage).toHaveBeenCalledTimes(2);
		expect(discarded).toEqual(["connection-a-1"]);
	});

	it("does not restage on an unchanged connection", async () => {
		const { adapter } = fixture();
		const staging = new AcpPromptImageStaging([image], "batch", () => true);
		await staging.stage(adapter);
		expect(await staging.submit(adapter, async ids => ids)).toEqual([{ id: "connection-a-1" }]);
		expect(adapter.stagePromptImage).toHaveBeenCalledTimes(1);
	});

	it("rejects a connection change during upload and discards returned IDs", async () => {
		const { adapter, discarded, reconnect } = fixture();
		adapter.stagePromptImage.mockImplementationOnce(async () => {
			reconnect();
			return "connection-a-upload";
		});
		const staging = new AcpPromptImageStaging([image, image], "batch", () => true);
		const send = mock(async (ids: Array<{ id: string }>) => ids);
		await expect(staging.submit(adapter, send)).rejects.toThrow("Connection changed during image staging");
		expect(send).not.toHaveBeenCalled();
		expect(adapter.stagePromptImage).toHaveBeenCalledTimes(1);
		expect(discarded).toEqual(["connection-a-upload"]);
	});
});
