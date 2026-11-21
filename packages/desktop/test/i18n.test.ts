import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
	availableLocales,
	DEFAULT_LOCALE,
	getLocale,
	LOCALE_CODES,
	LOCALE_STORAGE_KEY,
	resetLocaleForTests,
	setLocale,
	subscribeLocale,
	t,
} from "../src/i18n";

const stored = new Map<string, string>();
const original = Object.getOwnPropertyDescriptor(globalThis, "localStorage");

function installStorage(options: { failWrites?: boolean } = {}): void {
	Object.defineProperty(globalThis, "localStorage", {
		configurable: true,
		value: {
			getItem: (key: string) => stored.get(key) ?? null,
			setItem: (key: string, value: string) => {
				if (options.failWrites) throw new Error("storage is unavailable");
				stored.set(key, value);
			},
		},
	});
}

beforeEach(() => {
	stored.clear();
	resetLocaleForTests();
});

afterEach(() => {
	stored.clear();
	resetLocaleForTests();
	if (original) Object.defineProperty(globalThis, "localStorage", original);
	else Reflect.deleteProperty(globalThis, "localStorage");
});

describe("desktop locale catalog", () => {
	test("ships English and keeps the TUI locale vocabulary", () => {
		expect(DEFAULT_LOCALE).toBe("en");
		expect(LOCALE_CODES).toEqual(["en", "ko", "zh", "ja"]);
		installStorage();
		expect(getLocale()).toBe("en");
	});

	test("offers only locales that actually carry a catalog", () => {
		installStorage();
		expect(availableLocales()).toEqual(["en"]);
	});

	test("reads a stored locale and ignores values outside the vocabulary", () => {
		installStorage();
		stored.set(LOCALE_STORAGE_KEY, "ko");
		expect(getLocale()).toBe("ko");

		resetLocaleForTests();
		stored.set(LOCALE_STORAGE_KEY, "fr");
		expect(getLocale()).toBe("en");
	});

	test("falls back to the English message when the active locale has no catalog", () => {
		installStorage();
		setLocale("ko");
		expect(getLocale()).toBe("ko");
		expect(t("support.send")).toBe("Send");
	});

	test("persists a locale change and notifies subscribers once", () => {
		installStorage();
		let notifications = 0;
		const stop = subscribeLocale(() => {
			notifications += 1;
		});
		setLocale("ja");
		expect(stored.get(LOCALE_STORAGE_KEY)).toBe("ja");
		expect(notifications).toBe(1);

		setLocale("ja");
		expect(notifications).toBe(1);
		stop();
		setLocale("en");
		expect(notifications).toBe(1);
	});

	test("keeps the in-memory locale when storage refuses the write", () => {
		installStorage({ failWrites: true });
		setLocale("zh");
		expect(getLocale()).toBe("zh");
		expect(stored.size).toBe(0);
	});

	test("interpolates params and leaves unknown placeholders intact", () => {
		installStorage();
		expect(t("support.imageUnavailableWithReason", { reason: "too large" })).toBe(
			"This image cannot be shown. too large",
		);
		expect(t("support.imageUnavailableWithReason")).toBe("This image cannot be shown. {reason}");
	});
});
