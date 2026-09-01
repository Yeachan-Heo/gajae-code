export const UI_LANGUAGES = ["en", "ko", "zh", "ja"] as const;

export type UiLanguage = (typeof UI_LANGUAGES)[number];

const ENGLISH_STRINGS = {
	"settings.title": "Settings",
	"settings.navigationHint": "(tab to cycle)",
	"settings.selectHint": "  Enter to select · Esc to go back",
	"settings.preview": "Preview:",
	"settings.tab.appearance": "Appearance",
	"settings.tab.model": "Model",
	"settings.tab.interaction": "Interaction",
	"settings.tab.context": "Context",
	"settings.tab.memory": "Memory",
	"settings.tab.editing": "Editing",
	"settings.tab.tools": "Tools",
	"settings.tab.tasks": "Tasks",
	"settings.tab.providers": "Providers",
	"settings.tab.notifications": "Notifications",
	"settings.tab.plugins": "Plugins",
	"settings.tab.gjcBundles": "GJC Bundles",
	"settings.language.label": "Language",
	"settings.language.description": "Language for human-facing interactive UI text",
	"settings.language.english": "English",
	"settings.language.korean": "Korean (한국어)",
	"settings.language.chinese": "Chinese (简体中文)",
	"settings.language.japanese": "Japanese (日本語)",
	"language.current": "Current UI language:",
	"language.changed": "UI language changed to",
	"language.unknown": "Unknown language",
} as const;

export type UiStringKey = keyof typeof ENGLISH_STRINGS;

const KOREAN_STRINGS: Record<UiStringKey, string> = {
	"settings.title": "설정",
	"settings.navigationHint": "(Tab 키로 전환)",
	"settings.selectHint": "  Enter: 선택 · Esc: 뒤로",
	"settings.preview": "미리보기:",
	"settings.tab.appearance": "화면",
	"settings.tab.model": "모델",
	"settings.tab.interaction": "상호작용",
	"settings.tab.context": "컨텍스트",
	"settings.tab.memory": "메모리",
	"settings.tab.editing": "편집",
	"settings.tab.tools": "도구",
	"settings.tab.tasks": "작업",
	"settings.tab.providers": "공급자",
	"settings.tab.notifications": "알림",
	"settings.tab.plugins": "플러그인",
	"settings.tab.gjcBundles": "GJC 번들",
	"settings.language.label": "언어",
	"settings.language.description": "사람이 읽는 대화형 UI 텍스트의 언어",
	"settings.language.english": "English",
	"settings.language.korean": "한국어",
	"settings.language.chinese": "简体中文",
	"settings.language.japanese": "日本語",
	"language.current": "현재 UI 언어:",
	"language.changed": "UI 언어를 다음으로 변경했습니다:",
	"language.unknown": "알 수 없는 언어",
};

const JAPANESE_STRINGS: Record<UiStringKey, string> = {
	"settings.title": "設定",
	"settings.navigationHint": "(Tab キーで切り替え)",
	"settings.selectHint": "  Enter: 選択 · Esc: 戻る",
	"settings.preview": "プレビュー:",
	"settings.tab.appearance": "外観",
	"settings.tab.model": "モデル",
	"settings.tab.interaction": "操作",
	"settings.tab.context": "コンテキスト",
	"settings.tab.memory": "メモリ",
	"settings.tab.editing": "編集",
	"settings.tab.tools": "ツール",
	"settings.tab.tasks": "タスク",
	"settings.tab.providers": "プロバイダー",
	"settings.tab.notifications": "通知",
	"settings.tab.plugins": "プラグイン",
	"settings.tab.gjcBundles": "GJC バンドル",
	"settings.language.label": "言語",
	"settings.language.description": "対話型 UI テキストに使う言語",
	"settings.language.english": "English",
	"settings.language.korean": "한국어",
	"settings.language.chinese": "简体中文",
	"settings.language.japanese": "日本語",
	"language.current": "現在の UI 言語:",
	"language.changed": "UI 言語を次に変更しました:",
	"language.unknown": "不明な言語",
};

const CHINESE_STRINGS: Record<UiStringKey, string> = {
	"settings.title": "设置",
	"settings.navigationHint": "（按 Tab 切换）",
	"settings.selectHint": "  Enter：选择 · Esc：返回",
	"settings.preview": "预览：",
	"settings.tab.appearance": "外观",
	"settings.tab.model": "模型",
	"settings.tab.interaction": "交互",
	"settings.tab.context": "上下文",
	"settings.tab.memory": "记忆",
	"settings.tab.editing": "编辑",
	"settings.tab.tools": "工具",
	"settings.tab.tasks": "任务",
	"settings.tab.providers": "提供商",
	"settings.tab.notifications": "通知",
	"settings.tab.plugins": "插件",
	"settings.tab.gjcBundles": "GJC 捆绑包",
	"settings.language.label": "语言",
	"settings.language.description": "面向用户的交互式界面文字所使用的语言",
	"settings.language.english": "English",
	"settings.language.korean": "한국어",
	"settings.language.chinese": "简体中文",
	"settings.language.japanese": "日本語",
	"language.current": "当前界面语言：",
	"language.changed": "界面语言已更改为",
	"language.unknown": "未知语言",
};

const STRINGS: Record<UiLanguage, Record<UiStringKey, string>> = {
	en: ENGLISH_STRINGS,
	ko: KOREAN_STRINGS,
	zh: CHINESE_STRINGS,
	ja: JAPANESE_STRINGS,
};

/** User selection is authoritative; invalid or unavailable values deterministically fall back to English. */
export function resolveUiLanguage(value: unknown): UiLanguage {
	return value === "ko" || value === "zh" || value === "ja" ? value : "en";
}

/** Resolve explicit startup preference without allowing an invalid value to block startup. */
export function resolveExplicitUiLanguage(
	configuredValue: unknown,
	environmentValue: string | undefined,
): { language: UiLanguage; hasPreference: boolean } {
	if (configuredValue !== undefined) return { language: resolveUiLanguage(configuredValue), hasPreference: true };
	if (environmentValue === undefined) return { language: "en", hasPreference: false };
	return { language: parseUiLanguage(environmentValue) ?? "en", hasPreference: true };
}

export function uiString(language: unknown, key: UiStringKey): string {
	return STRINGS[resolveUiLanguage(language)][key];
}

/** Endonym shown by `/language` and the language submenu. */
export const UI_LANGUAGE_LABELS: Record<UiLanguage, string> = {
	en: "English",
	ko: "한국어",
	zh: "简体中文",
	ja: "日本語",
};

/** Spellings accepted by `/language`; the canonical codes stay authoritative. */
const UI_LANGUAGE_ALIASES: Readonly<Record<string, UiLanguage>> = {
	en: "en",
	eng: "en",
	english: "en",
	ko: "ko",
	kr: "ko",
	kor: "ko",
	korean: "ko",
	한국어: "ko",
	zh: "zh",
	中文: "zh",
	简体中文: "zh",
	chinese: "zh",
	ja: "ja",
	jp: "ja",
	jpn: "ja",
	japanese: "ja",
	日本語: "ja",
};

export function parseUiLanguage(value: string): UiLanguage | undefined {
	const normalized = value.trim().toLowerCase();
	if (!normalized) return undefined;
	const prefix = normalized.split(/[-_]/)[0] ?? "";
	// Own-property lookups only: untrusted slash-command input must not reach
	// inherited keys (`__proto__`, `constructor`) through either path.
	if (Object.hasOwn(UI_LANGUAGE_ALIASES, normalized)) return UI_LANGUAGE_ALIASES[normalized];
	return Object.hasOwn(UI_LANGUAGE_ALIASES, prefix) ? UI_LANGUAGE_ALIASES[prefix] : undefined;
}
