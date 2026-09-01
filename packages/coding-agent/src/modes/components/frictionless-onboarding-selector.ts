import { Container, matchesKey, type SelectItem, SelectList, Spacer, TruncatedText } from "@gajae-code/tui";
import type { OnboardingProfile } from "../../setup/frictionless-onboarding";
import { getSelectListTheme, theme } from "../theme/theme";
import { UI_LANGUAGES, type UiLanguage } from "../ui-language";
import { matchesSelectCancel } from "../utils/keybinding-matchers";
import { DynamicBorder } from "./dynamic-border";

export const UI_LANGUAGE_CHOICES: readonly { value: UiLanguage; label: string }[] = [
	{ value: "en", label: "English" },
	{ value: "ko", label: "한국어" },
	{ value: "zh", label: "简体中文" },
	{ value: "ja", label: "日本語" },
];

export class InterfaceLanguageSelectorComponent extends Container {
	readonly #selectList: SelectList;

	constructor(onSelect: (language: UiLanguage) => void, onCancel: () => void) {
		super();
		this.addChild(new DynamicBorder());
		this.addChild(new Spacer(1));
		this.addChild(
			new TruncatedText(
				theme.bold(
					"Choose your interface language / 언어를 선택하세요 / 选择界面语言 / インターフェース言語を選択",
				),
			),
		);
		this.addChild(new Spacer(1));
		const items: SelectItem[] = UI_LANGUAGE_CHOICES.map(choice => ({ value: choice.value, label: choice.label }));
		this.#selectList = new SelectList(items, items.length, getSelectListTheme());
		this.#selectList.onSelect = item => {
			if (UI_LANGUAGES.includes(item.value as UiLanguage)) onSelect(item.value as UiLanguage);
		};
		this.#selectList.onCancel = onCancel;
		this.addChild(this.#selectList);
		this.addChild(new Spacer(1));
		this.addChild(new TruncatedText(theme.fg("dim", "↑/↓ select · Enter choose · Esc use English")));
		this.addChild(new DynamicBorder());
	}

	handleInput(keyData: string): void {
		// The app.exit action is owned by the parent editor and is not a TUI
		// selector key id. Ctrl-D is its default byte when the editor is empty.
		if (keyData === "\x04") {
			this.#selectList.onCancel?.();
			return;
		}
		this.#selectList.handleInput(keyData);
	}
}

export type FrictionlessOnboardingAction =
	| "analyze"
	| "apply"
	| "skip"
	| "later"
	| "manual"
	| "manual-migration"
	| "manual-learn";
export type FrictionlessOnboardingStage = "disclosure" | "manual" | "preview";

export interface FrictionlessOnboardingCopy {
	title: string;
	disclosure: string;
	analyze: string;
	manual: string;
	skip: string;
	later: string;
	apply: string;
	preview: string;
	migration: string;
	learn: string;
	noChanges: string;
	controls: string;
	confirmTitle: string;
	completed: string;
	skipped: string;
	persistFailed: string;
}

const TEXT: Record<string, FrictionlessOnboardingCopy> = {
	en: {
		title: "Frictionless onboarding",
		disclosure:
			"GJC checks Codex, Claude, OpenCode, OMP, and OMO directory metadata. Supported session content is analyzed only after Analyze; only the derived profile and completion state are retained.",
		analyze: "Analyze supported local evidence",
		manual: "Which GJC workflow do you want help with?",
		skip: "I'm experienced with GJC",
		later: "Later",
		apply: "Confirm this guided action",
		preview: "Preview — nothing has been applied",
		migration: "Map my existing workflow to GJC",
		learn: "Open the GJC command guide",
		noChanges: "No configuration changes selected",
		controls: "↑/↓ select · Enter choose · Esc cancel",
		confirmTitle: "Apply the previewed onboarding action?",
		completed: "Onboarding action completed",
		skipped: "Onboarding skipped",
		persistFailed: "Onboarding state could not be saved; onboarding remains unresolved.",
	},
	ko: {
		title: "간편 온보딩",
		disclosure:
			"GJC는 Codex, Claude, OpenCode, OMP, OMO 디렉터리 메타데이터를 확인합니다. 지원되는 세션 내용은 분석을 선택한 뒤에만 처리하며, 파생된 프로필과 완료 상태만 저장합니다.",
		analyze: "지원되는 로컬 증거 분석",
		manual: "어떤 GJC 워크플로에 도움이 필요하신가요?",
		skip: "GJC에 익숙합니다",
		later: "나중에",
		apply: "이 안내 작업 확인",
		preview: "미리보기 — 아직 적용되지 않음",
		migration: "기존 워크플로를 GJC에 매핑",
		learn: "GJC 명령 안내 열기",
		noChanges: "선택된 설정 변경 없음",
		controls: "↑/↓ 선택 · Enter 확인 · Esc 취소",
		confirmTitle: "미리 본 온보딩 작업을 적용할까요?",
		completed: "온보딩 작업 완료",
		skipped: "온보딩 건너뜀",
		persistFailed: "온보딩 상태를 저장하지 못했습니다. 온보딩은 미완료 상태로 유지됩니다.",
	},
	ja: {
		title: "簡単オンボーディング",
		disclosure:
			"GJCはCodex、Claude、OpenCode、OMP、OMOのディレクトリメタデータを確認します。対応セッションの内容は分析を選んだ後だけ処理し、派生プロフィールと完了状態だけを保存します。",
		analyze: "対応するローカル情報を分析",
		manual: "どのGJCワークフローを案内しますか？",
		skip: "GJCを使い慣れています",
		later: "後で",
		apply: "この案内操作を確認",
		preview: "プレビュー — まだ適用されていません",
		migration: "既存ワークフローをGJCに対応付ける",
		learn: "GJCコマンドガイドを開く",
		noChanges: "選択された設定変更はありません",
		controls: "↑/↓選択 · Enter決定 · Escキャンセル",
		confirmTitle: "プレビューしたオンボーディング操作を適用しますか？",
		completed: "オンボーディング操作が完了しました",
		skipped: "オンボーディングをスキップしました",
		persistFailed: "オンボーディング状態を保存できませんでした。未完了のままです。",
	},
	zh: {
		title: "轻松入门",
		disclosure:
			"GJC 会检查 Codex、Claude、OpenCode、OMP 和 OMO 的目录元数据。仅在选择分析后处理受支持的会话内容，并且只保留派生配置和完成状态。",
		analyze: "分析支持的本地信息",
		manual: "您希望获得哪种 GJC 工作流帮助？",
		skip: "我熟悉 GJC",
		later: "稍后",
		apply: "确认此引导操作",
		preview: "预览 — 尚未应用",
		migration: "将现有工作流映射到 GJC",
		learn: "打开 GJC 命令指南",
		noChanges: "未选择配置更改",
		controls: "↑/↓选择 · Enter确认 · Esc取消",
		confirmTitle: "应用预览的入门操作？",
		completed: "入门操作已完成",
		skipped: "已跳过入门",
		persistFailed: "无法保存入门状态；入门仍未完成。",
	},
	es: {
		title: "Incorporación sencilla",
		disclosure:
			"GJC revisa metadatos de directorios de Codex, Claude, OpenCode, OMP y OMO. Solo analiza sesiones compatibles después de elegir Analizar y conserva únicamente el perfil derivado y el estado de finalización.",
		analyze: "Analizar evidencia local compatible",
		manual: "¿Con qué flujo de GJC necesitas ayuda?",
		skip: "Tengo experiencia con GJC",
		later: "Más tarde",
		apply: "Confirmar esta acción guiada",
		preview: "Vista previa — aún no aplicada",
		migration: "Adaptar mi flujo existente a GJC",
		learn: "Abrir la guía de comandos de GJC",
		noChanges: "No hay cambios de configuración seleccionados",
		controls: "↑/↓ elegir · Enter confirmar · Esc cancelar",
		confirmTitle: "¿Aplicar la acción de incorporación mostrada?",
		completed: "Acción de incorporación completada",
		skipped: "Incorporación omitida",
		persistFailed: "No se pudo guardar el estado; la incorporación sigue pendiente.",
	},
	fr: {
		title: "Configuration rapide",
		disclosure:
			"GJC vérifie les métadonnées des répertoires Codex, Claude, OpenCode, OMP et OMO. Le contenu des sessions compatibles n'est analysé qu'après votre choix, et seuls le profil dérivé et l'état d'achèvement sont conservés.",
		analyze: "Analyser les éléments locaux compatibles",
		manual: "Pour quel workflow GJC souhaitez-vous de l'aide ?",
		skip: "Je connais GJC",
		later: "Plus tard",
		apply: "Confirmer cette action guidée",
		preview: "Aperçu — rien n'est encore appliqué",
		migration: "Adapter mon workflow existant à GJC",
		learn: "Ouvrir le guide des commandes GJC",
		noChanges: "Aucune modification sélectionnée",
		controls: "↑/↓ choisir · Enter confirmer · Esc annuler",
		confirmTitle: "Appliquer l'action d'accueil affichée ?",
		completed: "Action d'accueil terminée",
		skipped: "Accueil ignoré",
		persistFailed: "Impossible d'enregistrer l'état ; l'accueil reste inachevé.",
	},
	de: {
		title: "Reibungsloser Einstieg",
		disclosure:
			"GJC prüft Verzeichnismetadaten von Codex, Claude, OpenCode, OMP und OMO. Unterstützte Sitzungsinhalte werden erst nach Analysieren verarbeitet; gespeichert werden nur das abgeleitete Profil und der Abschlussstatus.",
		analyze: "Unterstützte lokale Hinweise analysieren",
		manual: "Bei welchem GJC-Workflow benötigen Sie Hilfe?",
		skip: "Ich kenne GJC",
		later: "Später",
		apply: "Diese geführte Aktion bestätigen",
		preview: "Vorschau — noch nichts angewendet",
		migration: "Meinen bestehenden Workflow auf GJC abbilden",
		learn: "GJC-Befehlsübersicht öffnen",
		noChanges: "Keine Konfigurationsänderungen ausgewählt",
		controls: "↑/↓ wählen · Enter bestätigen · Esc abbrechen",
		confirmTitle: "Die angezeigte Onboarding-Aktion anwenden?",
		completed: "Onboarding-Aktion abgeschlossen",
		skipped: "Onboarding übersprungen",
		persistFailed: "Onboarding-Status konnte nicht gespeichert werden; er bleibt offen.",
	},
};

export function getFrictionlessOnboardingCopy(language: string): FrictionlessOnboardingCopy {
	return TEXT[language] ?? TEXT.en!;
}

export class FrictionlessOnboardingSelectorComponent extends Container {
	#selectedIndex = 0;
	#list: Container;
	#options: Array<{ label: string; description: string; action: FrictionlessOnboardingAction }>;

	constructor(
		profile: OnboardingProfile,
		onSelect: (action: FrictionlessOnboardingAction) => void,
		onCancel: () => void,
		language = "en",
		stage: FrictionlessOnboardingStage = "disclosure",
	) {
		super();
		const text = getFrictionlessOnboardingCopy(language);
		this.#options =
			stage === "disclosure"
				? [
						{ label: text.analyze, description: text.disclosure, action: "analyze" },
						{ label: text.manual, description: "", action: "manual" },
						{ label: text.skip, description: "", action: "skip" },
						{ label: text.later, description: "", action: "later" },
					]
				: stage === "manual"
					? [
							{ label: text.migration, description: "", action: "manual-migration" },
							{ label: text.learn, description: "", action: "manual-learn" },
							{ label: text.later, description: "", action: "later" },
						]
					: [
							{ label: text.apply, description: text.preview, action: "apply" },
							{ label: text.manual, description: "", action: "manual" },
							{ label: text.skip, description: "", action: "skip" },
							{ label: text.later, description: "", action: "later" },
						];

		this.addChild(new DynamicBorder());
		this.addChild(new Spacer(1));
		this.addChild(new TruncatedText(theme.bold(text.title)));
		const summary =
			stage === "disclosure"
				? text.disclosure
				: stage === "manual"
					? text.manual
					: `${text.preview}: ${profile.migrationMap.join(", ") || text.noChanges}`;
		this.addChild(new TruncatedText(theme.fg("muted", summary), 0, 0));
		for (const omission of stage === "disclosure" ? [] : profile.omissions) {
			this.addChild(new TruncatedText(theme.fg("warning", `  ${omission}`), 0, 0));
		}
		this.addChild(new Spacer(1));
		this.#list = new Container();
		this.addChild(this.#list);
		this.addChild(new Spacer(1));
		this.addChild(new TruncatedText(theme.fg("dim", text.controls), 0, 0));
		this.addChild(new DynamicBorder());
		this.#updateList();
		this.#onSelect = onSelect;
		this.#onCancel = onCancel;
	}

	#onSelect: (action: FrictionlessOnboardingAction) => void;
	#onCancel: () => void;

	#updateList(): void {
		this.#list.clear();
		this.#options.forEach((option, index) => {
			const selected = index === this.#selectedIndex;
			const prefix = selected ? theme.fg("accent", `${theme.nav.cursor} `) : "  ";
			const label = selected ? theme.fg("accent", option.label) : option.label;
			this.#list.addChild(new TruncatedText(`${prefix}${label}`, 0, 0));
			if (option.description)
				this.#list.addChild(new TruncatedText(theme.fg("muted", `    ${option.description}`), 0, 0));
		});
	}

	handleInput(keyData: string): void {
		if (matchesKey(keyData, "up")) {
			this.#selectedIndex = (this.#selectedIndex + this.#options.length - 1) % this.#options.length;
			this.#updateList();
			return;
		}
		if (matchesKey(keyData, "down")) {
			this.#selectedIndex = (this.#selectedIndex + 1) % this.#options.length;
			this.#updateList();
			return;
		}
		if (matchesKey(keyData, "enter")) {
			const option = this.#options[this.#selectedIndex];
			if (option) this.#onSelect(option.action);
			return;
		}
		if (matchesSelectCancel(keyData)) this.#onCancel();
	}
}
