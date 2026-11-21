/**
 * Desktop UI catalogs.
 *
 * The desktop app ships English only, but the locale codes, the persisted
 * preference key and the catalog lookup mirror the TUI's `ui.language`
 * vocabulary (`en`, `ko`, `zh`, `ja`), so adding a language later cannot
 * collide with a shipped value. Nothing here reads TUI configuration: the
 * desktop preference is browser-local, like the theme.
 */

import { useSyncExternalStore } from "react";
import { models } from "./en/models";
import { panels } from "./en/panels";
import { settings } from "./en/settings";
import { shell } from "./en/shell";
import { showcase } from "./en/showcase";
import { support } from "./en/support";

export type Locale = "en" | "ko" | "zh" | "ja";

export const DEFAULT_LOCALE: Locale = "en";
export const LOCALE_STORAGE_KEY = "gjc.desktop.locale";
export const LOCALE_CODES: readonly Locale[] = ["en", "ko", "zh", "ja"];

const english = {
	...shell,
	...support,
	...models,
	...panels,
	...settings,
	...showcase,
};

export type MessageKey = keyof typeof english;
export type MessageParams = Record<string, string | number>;

const catalogs: Partial<Record<Locale, Partial<Record<MessageKey, string>>>> = { en: english };

const listeners = new Set<() => void>();
let currentLocale: Locale | undefined;

function isLocale(value: string): value is Locale {
	return LOCALE_CODES.some(code => code === value);
}

function readStoredLocale(): Locale {
	try {
		const stored = localStorage.getItem(LOCALE_STORAGE_KEY);
		return stored && isLocale(stored) ? stored : DEFAULT_LOCALE;
	} catch {
		// WebKit throws from the localStorage getter itself in a restricted webview,
		// so the read is guarded exactly like the write path.
		return DEFAULT_LOCALE;
	}
}

export function getLocale(): Locale {
	currentLocale ??= readStoredLocale();
	return currentLocale;
}

export function setLocale(next: Locale): void {
	if (next === getLocale()) return;
	currentLocale = next;
	try {
		localStorage.setItem(LOCALE_STORAGE_KEY, next);
	} catch {
		// Storage can be unavailable in restricted webviews; the in-memory value still applies.
	}
	for (const listener of listeners) listener();
}

export function subscribeLocale(listener: () => void): () => void {
	listeners.add(listener);
	return () => listeners.delete(listener);
}

/** Catalogs that carry at least one message. A locale without a catalog is not offered for switching. */
export function availableLocales(): Locale[] {
	return LOCALE_CODES.filter(code => code === DEFAULT_LOCALE || catalogs[code] !== undefined);
}

/**
 * Subscribe the calling component to locale changes. The app root calls this so a
 * future locale switch re-renders every `t()` lookup below it.
 */
export function useLocale(): Locale {
	return useSyncExternalStore(subscribeLocale, getLocale, getLocale);
}

function interpolate(template: string, params?: MessageParams): string {
	if (!params) return template;
	return template.replace(/\{(\w+)\}/g, (match, name: string) =>
		Object.hasOwn(params, name) ? String(params[name]) : match,
	);
}

/** Resolve a message in the active locale, falling back to English when the key is missing there. */
export function t(key: MessageKey, params?: MessageParams): string {
	const active = catalogs[getLocale()]?.[key];
	return interpolate(active ?? english[key], params);
}

export function resetLocaleForTests(): void {
	currentLocale = undefined;
}
