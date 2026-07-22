import { describe, expect, test } from "bun:test";
import {
	buildAlibabaImageRequest,
	collectAlibabaImageResult,
	IMAGE_PROVIDER_DEFAULTS,
	resolveAlibabaImageSize,
} from "../src/tools/image-gen";

describe("resolveAlibabaImageSize", () => {
	test("maps square size to 1K", () => {
		expect(resolveAlibabaImageSize("1024x1024")).toBe("1K");
	});

	test("maps landscape and portrait sizes to 2K", () => {
		expect(resolveAlibabaImageSize("1536x1024")).toBe("2K");
		expect(resolveAlibabaImageSize("1024x1536")).toBe("2K");
	});

	test("returns undefined when no size requested", () => {
		expect(resolveAlibabaImageSize(undefined)).toBeUndefined();
	});
});

describe("buildAlibabaImageRequest", () => {
	test("builds a generation request with prompt-only content", () => {
		const body = buildAlibabaImageRequest("wan2.7-image", "a red apple", [], undefined);
		expect(body.model).toBe("wan2.7-image");
		expect(body.input.messages).toHaveLength(1);
		expect(body.input.messages[0]!.role).toBe("user");
		expect(body.input.messages[0]!.content).toEqual([{ text: "a red apple" }]);
		expect(body.parameters.n).toBe(1);
		expect(body.parameters.size).toBeUndefined();
	});

	test("prepends input images as data URLs for editing", () => {
		const body = buildAlibabaImageRequest(
			"wan2.7-image-pro",
			"put the graffiti on the car",
			[{ data: "aGVsbG8=", mimeType: "image/png" }],
			"1024x1024",
		);
		expect(body.input.messages[0]!.content).toEqual([
			{ image: "data:image/png;base64,aGVsbG8=" },
			{ text: "put the graffiti on the car" },
		]);
		expect(body.parameters.size).toBe("1K");
	});
});

describe("collectAlibabaImageResult", () => {
	test("collects image URLs and text parts from choices", () => {
		const result = collectAlibabaImageResult({
			output: {
				choices: [
					{
						message: {
							content: [
								{ type: "image", image: "https://oss.example/img1.png" },
								{ text: "generated one image" },
							],
						},
					},
					{ message: { content: [{ image: "https://oss.example/img2.png" }] } },
				],
			},
		});
		expect(result.imageUrls).toEqual(["https://oss.example/img1.png", "https://oss.example/img2.png"]);
		expect(result.responseText).toBe("generated one image");
	});

	test("returns empty result for missing output", () => {
		const result = collectAlibabaImageResult({});
		expect(result.imageUrls).toEqual([]);
		expect(result.responseText).toBeUndefined();
	});
});

describe("alibaba image provider defaults", () => {
	test("auto-binds wan2.7-image", () => {
		expect(IMAGE_PROVIDER_DEFAULTS.alibaba).toBe("wan2.7-image");
	});
});
