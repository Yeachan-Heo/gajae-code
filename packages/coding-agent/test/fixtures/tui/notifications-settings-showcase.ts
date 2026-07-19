import chalk from "chalk";
import type { CasReceipt } from "../../../src/config/atomic-yaml-patch";
import { Settings } from "../../../src/config/settings";
import type {
	NotificationsConfigureCommitResult,
	NotificationsEditorOperations,
	NotificationsEditorPreferences,
	NotificationsEditorSetupInput,
	NotificationsEditorState,
	NotificationsMutationResult,
	NotificationsPreflightResult,
	NotificationsSaveInactiveResult,
	PreparedTelegramConfiguration,
} from "../../../src/modes/components/notifications-settings-editor";
import { SettingsSelectorComponent } from "../../../src/modes/components/settings-selector";
import { initTheme } from "../../../src/modes/theme/theme";
import type { TelegramDaemonReconnectOutcome } from "../../../src/sdk/bus/notification-orchestration";
import type {
	NotificationHealthReport,
	NotificationRecoveryReport,
	NotificationStatusReport,
	NotificationTestResult,
} from "../../../src/sdk/bus/notification-service";
import type {
	NotificationSessionReconcileResult,
	NotificationSessionStatus,
} from "../../../src/sdk/bus/session-control";

/**
 * Deterministic state contract for the Notifications settings visual-QA showcase.
 *
 * The renderer drives the live SettingsSelectorComponent to its Notifications tab
 * using only in-memory operations and a fixed clock. It performs no network or
 * fixture filesystem I/O.
 */

export const NOTIFICATIONS_SETTINGS_SHOWCASE_STATE_IDS = [
	"home-unconfigured",
	"home-configured-inactive",
	"home-runtime-active",
	"home-local-off",
	"home-env-off",
	"home-env-on",
	"home-discord-only",
	"home-slack-only",
	"setup-provider",
	"setup-chat-entry",
	"setup-token-entry",
	"setup-validating",
	"setup-threaded-warning",
	"setup-pairing",
	"setup-review",
	"saving",
	"health-probing",
	"health-ok",
	"health-warning",
	"no-health-load",
	"testing",
	"recovering",
	"reconnecting",
	"navigation-locked",
	"confirmation-remove",
	"confirmation-disable",
	"preferences",
	"success",
	"error",
	"foreign-blocked",
	"blocked-restore-retain",
	"cancellation",
	"narrow-cjk",
	"narrow-scroll",
] as const;

export type NotificationsSettingsShowcaseStateId = (typeof NOTIFICATIONS_SETTINGS_SHOWCASE_STATE_IDS)[number];

export const NOTIFICATIONS_SETTINGS_SHOWCASE_VIEWPORTS = [
	{ id: "80x24", columns: 80, rows: 24 },
	{ id: "120x36", columns: 120, rows: 36 },
	{ id: "160x48", columns: 160, rows: 48 },
] as const;

export const NOTIFICATIONS_SETTINGS_SHOWCASE_NARROW_VIEWPORT = { id: "48x36", columns: 48, rows: 36 } as const;

export type NotificationsSettingsShowcaseViewport =
	| (typeof NOTIFICATIONS_SETTINGS_SHOWCASE_VIEWPORTS)[number]
	| typeof NOTIFICATIONS_SETTINGS_SHOWCASE_NARROW_VIEWPORT;

export const NOTIFICATIONS_SETTINGS_SHOWCASE_TARGETED_UNICODE_VARIANTS: readonly {
	stateId: NotificationsSettingsShowcaseStateId;
	viewport: NotificationsSettingsShowcaseViewport;
}[] = [
	{ stateId: "narrow-cjk", viewport: NOTIFICATIONS_SETTINGS_SHOWCASE_NARROW_VIEWPORT },
	{ stateId: "narrow-scroll", viewport: NOTIFICATIONS_SETTINGS_SHOWCASE_NARROW_VIEWPORT },
];

export type NotificationsSettingsShowcaseRenderMode = "unicode-color" | "ascii-no-color";

export interface NotificationsSettingsShowcaseCopy {
	english: string;
	korean: string;
	japanese: string;
	chinese: string;
}

export interface NotificationsSettingsShowcaseState {
	stateId: NotificationsSettingsShowcaseStateId;
	title: string;
	copy: NotificationsSettingsShowcaseCopy;
}

export interface NotificationsSettingsShowcaseEntry {
	key: string;
	stateId: NotificationsSettingsShowcaseStateId;
	viewport: NotificationsSettingsShowcaseViewport;
	renderMode: NotificationsSettingsShowcaseRenderMode;
}

export interface NotificationsSettingsShowcaseRender {
	terminalText: string;
	terminalAnsiText: string;
	captureMode: "live-settings-selector";
	state: NotificationsEditorState;
	selectorTab: "notifications";
	navigation: readonly string[];
	fixedClockTimestamp: string;
}

export const NOTIFICATIONS_SETTINGS_SHOWCASE_STATES: readonly NotificationsSettingsShowcaseState[] = [
	{
		stateId: "home-unconfigured",
		title: "Notifications are not configured",
		copy: {
			english: "Choose Configure Telegram to add a notification destination.",
			korean: "알림 대상이 없습니다. Telegram 설정을 선택해 알림 대상을 추가하세요.",
			japanese: "通知先がありません。Telegram を設定して通知先を追加してください。",
			chinese: "尚未设置通知目标。请选择配置 Telegram 以添加通知目标。",
		},
	},
	{
		stateId: "home-configured-inactive",
		title: "Notifications are configured but inactive",
		copy: {
			english: "Telegram is saved. Turn notifications on for this session when you are ready.",
			korean: "Telegram 설정이 저장되었습니다. 준비되면 이 세션의 알림을 켜세요.",
			japanese: "Telegram の設定は保存されています。準備ができたらこのセッションの通知をオンにします。",
			chinese: "Telegram 配置已保存。准备就绪后，请为当前会话开启通知。",
		},
	},
	{
		stateId: "home-runtime-active",
		title: "Notifications are active for this session",
		copy: {
			english: "The current session can deliver notifications to the configured destination.",
			korean: "현재 세션은 구성된 대상으로 알림을 보낼 수 있습니다.",
			japanese: "現在のセッションは設定済みの通知先へ通知を送信できます。",
			chinese: "当前会话可以向已配置的目标发送通知。",
		},
	},
	{
		stateId: "home-local-off",
		title: "Notifications are off for this session",
		copy: {
			english: "Global configuration is unchanged; this session remains locally off.",
			korean: "전역 설정은 변경되지 않았으며 이 세션의 알림만 꺼져 있습니다.",
			japanese: "グローバル設定は変更されず、このセッションだけ通知がオフです。",
			chinese: "全局配置未更改；仅当前会话的通知保持关闭。",
		},
	},
	{
		stateId: "home-env-off",
		title: "Notifications are disabled by the environment",
		copy: {
			english: "An environment hard-off prevents this session from starting notifications.",
			korean: "환경의 강제 비활성화로 인해 이 세션에서 알림을 시작할 수 없습니다.",
			japanese: "環境の強制オフにより、このセッションでは通知を開始できません。",
			chinese: "环境中的强制关闭阻止当前会话启动通知。",
		},
	},
	{
		stateId: "home-env-on",
		title: "Notifications are enabled by the environment",
		copy: {
			english: "An explicit environment opt-in keeps the current session notification-enabled.",
			korean: "명시적인 환경 opt-in으로 현재 세션의 알림이 활성화되어 있습니다.",
			japanese: "明示的な環境 opt-in により、現在のセッションの通知は有効です。",
			chinese: "显式环境启用使当前会话的通知保持开启。",
		},
	},
	{
		stateId: "home-discord-only",
		title: "Discord notifications are configured",
		copy: {
			english: "Discord is the active global adapter; Telegram setup is optional.",
			korean: "Discord가 활성 전역 어댑터입니다. Telegram 설정은 선택 사항입니다.",
			japanese: "Discord が有効なグローバルアダプターです。Telegram の設定は任意です。",
			chinese: "Discord 是当前启用的全局适配器；Telegram 设置为可选项。",
		},
	},
	{
		stateId: "home-slack-only",
		title: "Slack notifications are configured",
		copy: {
			english: "Slack is the active global adapter; Telegram setup is optional.",
			korean: "Slack이 활성 전역 어댑터입니다. Telegram 설정은 선택 사항입니다.",
			japanese: "Slack が有効なグローバルアダプターです。Telegram の設定は任意です。",
			chinese: "Slack 是当前启用的全局适配器；Telegram 设置为可选项。",
		},
	},
	{
		stateId: "setup-provider",
		title: "Choose a notification provider",
		copy: {
			english: "Telegram setup is selected. Discord and Slack credentials are managed elsewhere.",
			korean: "Telegram 설정이 선택되었습니다. Discord와 Slack 자격 증명은 다른 곳에서 관리합니다.",
			japanese: "Telegram の設定が選択されています。Discord と Slack の認証情報は別の場所で管理します。",
			chinese: "已选择 Telegram 设置。Discord 和 Slack 凭据在其他位置管理。",
		},
	},
	{
		stateId: "setup-token-entry",
		title: "Enter a Telegram token",
		copy: {
			english: "The token field is masked. Paste the token, then press Enter to validate it.",
			korean: "토큰 입력란은 마스킹됩니다. 토큰을 붙여넣고 Enter를 눌러 확인하세요.",
			japanese: "トークン入力欄はマスクされています。トークンを貼り付けて Enter で検証します。",
			chinese: "令牌输入框会被遮蔽。粘贴令牌后按 Enter 验证。",
		},
	},
	{
		stateId: "setup-validating",
		title: "Validating the Telegram destination",
		copy: {
			english: "Checking the entered destination without displaying the credential.",
			korean: "자격 증명을 표시하지 않고 입력한 대상을 확인하고 있습니다.",
			japanese: "認証情報を表示せず、入力した通知先を確認しています。",
			chinese: "正在验证输入的目标，不会显示凭据。",
		},
	},
	{
		stateId: "setup-threaded-warning",
		title: "Threaded Mode needs review",
		copy: {
			english: "Threaded Mode changes how Telegram topics are reused. Review before saving.",
			korean: "Threaded Mode는 Telegram 토픽 재사용 방식을 바꿉니다. 저장하기 전에 검토하세요.",
			japanese: "Threaded Mode は Telegram トピックの再利用方法を変更します。保存前に確認してください。",
			chinese: "Threaded Mode 会改变 Telegram 话题的复用方式。保存前请确认。",
		},
	},
	{
		stateId: "setup-pairing",
		title: "Looking for a private chat",
		copy: {
			english: "Pairing is in progress. Escape cancels this search before it changes configuration.",
			korean: "페어링을 진행 중입니다. 설정을 변경하기 전에 Esc로 이 검색을 취소할 수 있습니다.",
			japanese: "ペアリング中です。設定を変更する前なら Esc で検索をキャンセルできます。",
			chinese: "正在配对。在更改配置前，可按 Esc 取消此搜索。",
		},
	},
	{
		stateId: "setup-review",
		title: "Review notification setup",
		copy: {
			english: "Review the provider, masked credential status, and destination before saving.",
			korean: "저장하기 전에 제공자, 마스킹된 자격 증명 상태 및 대상을 검토하세요.",
			japanese: "保存前に、プロバイダー、マスク済み認証情報の状態、通知先を確認してください。",
			chinese: "保存前，请检查提供商、遮蔽的凭据状态和通知目标。",
		},
	},
	{
		stateId: "saving",
		title: "Saving notification configuration",
		copy: {
			english: "Saving is in progress. Navigation stays locked until the durable write completes.",
			korean: "저장 중입니다. 내구성 있는 쓰기가 끝날 때까지 탐색이 잠깁니다.",
			japanese: "保存中です。永続書き込みが完了するまでナビゲーションはロックされます。",
			chinese: "正在保存。在持久化写入完成前，导航会保持锁定。",
		},
	},
	{
		stateId: "health-probing",
		title: "Checking notification health",
		copy: {
			english: "Health probing is in progress and cannot be cancelled once started.",
			korean: "상태 확인이 진행 중이며 시작된 후에는 취소할 수 없습니다.",
			japanese: "ヘルスチェック中です。開始後はキャンセルできません。",
			chinese: "正在检查健康状态；开始后无法取消。",
		},
	},
	{
		stateId: "health-ok",
		title: "Notification health is OK",
		copy: {
			english: "The configured destination and current runtime report healthy status.",
			korean: "구성된 대상과 현재 런타임의 상태가 정상입니다.",
			japanese: "設定済みの通知先と現在のランタイムは正常です。",
			chinese: "已配置的目标和当前运行时状态正常。",
		},
	},
	{
		stateId: "health-warning",
		title: "Notification health needs attention",
		copy: {
			english: "A recoverable warning was found. Review the safe recovery action before continuing.",
			korean: "복구 가능한 경고가 발견되었습니다. 계속하기 전에 안전한 복구 작업을 검토하세요.",
			japanese: "回復可能な警告が見つかりました。続行前に安全な回復操作を確認してください。",
			chinese: "发现可恢复的警告。继续前请检查安全恢复操作。",
		},
	},
	{
		stateId: "testing",
		title: "Sending a notification test",
		copy: {
			english: "A test delivery may already be in flight. Wait for the result before leaving this tab.",
			korean: "테스트 전송이 이미 진행 중일 수 있습니다. 이 탭을 떠나기 전에 결과를 기다리세요.",
			japanese: "テスト送信はすでに実行中の可能性があります。このタブを離れる前に結果を待ってください。",
			chinese: "测试发送可能已在进行中。离开此标签前请等待结果。",
		},
	},
	{
		stateId: "recovering",
		title: "Recovering notification delivery",
		copy: {
			english: "Recovery is running. Delivery state can change before this action returns.",
			korean: "복구를 실행 중입니다. 이 작업이 끝나기 전에 전송 상태가 바뀔 수 있습니다.",
			japanese: "回復処理中です。この操作が戻る前に配信状態が変わることがあります。",
			chinese: "正在恢复。此操作返回前，投递状态可能发生变化。",
		},
	},
	{
		stateId: "reconnecting",
		title: "Reconnecting notification runtime",
		copy: {
			english: "Reconnect is in progress. The current session stays guarded until it finishes.",
			korean: "재연결을 진행 중입니다. 완료될 때까지 현재 세션은 보호된 상태로 유지됩니다.",
			japanese: "再接続中です。完了するまで現在のセッションは保護された状態のままです。",
			chinese: "正在重新连接。完成前，当前会话将保持受保护状态。",
		},
	},
	{
		stateId: "navigation-locked",
		title: "Navigation is temporarily locked",
		copy: {
			english: "A guarded notification operation is active. Wait for completion before changing tabs.",
			korean: "보호된 알림 작업이 실행 중입니다. 탭을 바꾸기 전에 완료될 때까지 기다리세요.",
			japanese: "保護された通知操作が実行中です。タブを変更する前に完了を待ってください。",
			chinese: "受保护的通知操作正在运行。切换标签前请等待完成。",
		},
	},
	{
		stateId: "confirmation-remove",
		title: "Remove Telegram configuration?",
		copy: {
			english: "Remove only Telegram credentials. Other configured adapters remain unchanged.",
			korean: "Telegram 자격 증명만 제거합니다. 다른 구성된 어댑터는 변경되지 않습니다.",
			japanese: "Telegram の認証情報だけを削除します。ほかの設定済みアダプターは変更されません。",
			chinese: "仅移除 Telegram 凭据。其他已配置的适配器不会更改。",
		},
	},
	{
		stateId: "confirmation-disable",
		title: "Disable notifications globally?",
		copy: {
			english: "Global disable stops configured adapters. Confirm before applying this change.",
			korean: "전역 비활성화는 구성된 어댑터를 중지합니다. 변경을 적용하기 전에 확인하세요.",
			japanese: "グローバル無効化は設定済みアダプターを停止します。適用前に確認してください。",
			chinese: "全局禁用会停止已配置的适配器。应用更改前请确认。",
		},
	},
	{
		stateId: "success",
		title: "Notification action completed",
		copy: {
			english: "The requested notification action completed successfully.",
			korean: "요청한 알림 작업이 성공적으로 완료되었습니다.",
			japanese: "要求された通知操作が正常に完了しました。",
			chinese: "请求的通知操作已成功完成。",
		},
	},
	{
		stateId: "error",
		title: "Notification action could not complete",
		copy: {
			english: "The operation failed safely. Review the recovery guidance and try again when ready.",
			korean: "작업이 안전하게 실패했습니다. 복구 안내를 검토한 후 준비되면 다시 시도하세요.",
			japanese: "操作は安全に失敗しました。回復の案内を確認してから再試行してください。",
			chinese: "操作已安全失败。请查看恢复指引，并在准备好后重试。",
		},
	},
	{
		stateId: "foreign-blocked",
		title: "Telegram activation is blocked by another owner",
		copy: {
			english: "Configuration may be saved, but this session stopped before sending to a foreign daemon.",
			korean: "설정은 저장될 수 있지만 다른 데몬으로 전송하기 전에 이 세션이 중지되었습니다.",
			japanese: "設定は保存されている場合がありますが、外部デーモンへ送信する前にこのセッションは停止されました。",
			chinese: "配置可能已保存，但当前会话已在向外部守护进程发送前停止。",
		},
	},
	{
		stateId: "cancellation",
		title: "Notification setup was cancelled",
		copy: {
			english: "The cancellable setup step stopped without changing saved notification configuration.",
			korean: "취소 가능한 설정 단계가 저장된 알림 구성을 변경하지 않고 중지되었습니다.",
			japanese: "キャンセル可能な設定手順は、保存済みの通知設定を変更せずに停止しました。",
			chinese: "可取消的设置步骤已停止，未更改已保存的通知配置。",
		},
	},
	{
		stateId: "setup-chat-entry",
		title: "Enter an optional Telegram private chat ID",
		copy: {
			english: "The private-chat field is ready before the masked token entry step.",
			korean: "마스킹된 토큰 입력 전에 비공개 채팅 ID 입력란이 준비되어 있습니다.",
			japanese: "マスクされたトークン入力の前に、プライベートチャット ID 欄が表示されます。",
			chinese: "在输入遮蔽令牌之前，私聊 ID 输入框已准备就绪。",
		},
	},
	{
		stateId: "preferences",
		title: "Draft notification preferences",
		copy: {
			english: "Safe notification preferences remain a draft until the explicit atomic save action.",
			korean: "안전한 알림 기본 설정은 명시적 원자 저장 전까지 초안으로 유지됩니다.",
			japanese: "安全な通知設定は、明示的なアトミック保存まで下書きのままです。",
			chinese: "安全的通知偏好在明确执行原子保存前始终只是草稿。",
		},
	},
	{
		stateId: "blocked-restore-retain",
		title: "Resolve a blocked committed Telegram configuration",
		copy: {
			english:
				"A foreign daemon blocked activation after the configuration committed; restore or retain must be selected explicitly.",
			korean:
				"구성이 저장된 뒤 외부 데몬이 활성화를 차단했습니다. 복원 또는 유지 중 하나를 명시적으로 선택해야 합니다.",
			japanese:
				"設定の保存後に外部デーモンが有効化をブロックしました。復元または保持を明示的に選択する必要があります。",
			chinese: "配置提交后，外部守护进程阻止了激活；必须明确选择恢复或保留。",
		},
	},
	{
		stateId: "no-health-load",
		title: "Notification status load is unavailable",
		copy: {
			english: "The editor keeps recovery controls visible when the initial status and health load fails.",
			korean: "초기 상태 및 헬스 로드가 실패해도 편집기는 복구 제어를 계속 표시합니다.",
			japanese: "初期状態とヘルスの読み込みに失敗しても、エディターは回復操作を表示し続けます。",
			chinese: "即使初始状态和健康检查加载失败，编辑器仍会显示恢复控制。",
		},
	},
	{
		stateId: "narrow-cjk",
		title: "Narrow viewport CJK guidance",
		copy: {
			english: "Narrow terminals preserve localized CJK text without clipping wide characters.",
			korean: "좁은 터미널에서도 CJK 문장을 자르거나 넓은 문자를 바꾸지 않습니다.",
			japanese: "狭い端末でも CJK 文を切らず、全角文字を置き換えません。",
			chinese: "窄终端也完整保留 CJK 文本，不裁剪或替换宽字符。",
		},
	},
	{
		stateId: "narrow-scroll",
		title: "Narrow viewport action-list scroll",
		copy: {
			english:
				"The final notification action remains reachable and the list position is visible in a narrow terminal.",
			korean: "좁은 터미널에서도 마지막 알림 작업에 도달할 수 있고 목록 위치가 표시됩니다.",
			japanese: "狭い端末でも最後の通知操作に到達でき、リスト位置が表示されます。",
			chinese: "在窄终端中仍可访问最后一个通知操作，并且会显示列表位置。",
		},
	},
];

const ASCII_NO_COLOR_VARIANTS: ReadonlyArray<{
	stateId: NotificationsSettingsShowcaseStateId;
	viewportId: (typeof NOTIFICATIONS_SETTINGS_SHOWCASE_VIEWPORTS)[number]["id"];
}> = [
	{ stateId: "home-configured-inactive", viewportId: "80x24" },
	{ stateId: "health-warning", viewportId: "80x24" },
	{ stateId: "foreign-blocked", viewportId: "120x36" },
	{ stateId: "confirmation-remove", viewportId: "80x24" },
];

export const NOTIFICATIONS_SETTINGS_SHOWCASE_ENTRIES: readonly NotificationsSettingsShowcaseEntry[] = (() => {
	const entries: NotificationsSettingsShowcaseEntry[] = [];
	for (const stateId of NOTIFICATIONS_SETTINGS_SHOWCASE_STATE_IDS) {
		for (const viewport of NOTIFICATIONS_SETTINGS_SHOWCASE_VIEWPORTS) {
			entries.push({
				key: `${stateId}/${viewport.id}/unicode-color`,
				stateId,
				viewport,
				renderMode: "unicode-color",
			});
		}
	}
	for (const variant of ASCII_NO_COLOR_VARIANTS) {
		const viewport = NOTIFICATIONS_SETTINGS_SHOWCASE_VIEWPORTS.find(candidate => candidate.id === variant.viewportId);
		if (!viewport) throw new Error(`Unknown showcase viewport: ${variant.viewportId}`);
		entries.push({
			key: `${variant.stateId}/${viewport.id}/ascii-no-color`,
			stateId: variant.stateId,
			viewport,
			renderMode: "ascii-no-color",
		});
	}
	for (const variant of NOTIFICATIONS_SETTINGS_SHOWCASE_TARGETED_UNICODE_VARIANTS) {
		entries.push({
			key: `${variant.stateId}/${variant.viewport.id}/unicode-color`,
			stateId: variant.stateId,
			viewport: variant.viewport,
			renderMode: "unicode-color",
		});
	}
	return entries;
})();

export const NOTIFICATIONS_SETTINGS_SHOWCASE_EXPECTED_ENTRY_COUNT = 108;

const SHOWCASE_CLOCK = {
	now: () => 1_700_000_042_000,
};
const SHOWCASE_RECEIPT: CasReceipt = {
	revisions: [],
	restore: async () => ({ status: "discarded" }),
	discard: () => {},
};
const SHOWCASE_TOKEN = "deterministic-showcase-token";

function showcaseState(stateId: NotificationsSettingsShowcaseStateId): NotificationsSettingsShowcaseState {
	const state = NOTIFICATIONS_SETTINGS_SHOWCASE_STATES.find(candidate => candidate.stateId === stateId);
	if (!state) throw new Error(`Unknown showcase state: ${stateId}`);
	return state;
}

function configuredAdapter(channel: string): NotificationStatusReport["discord"] {
	return { botTokenMasked: "••••••••", channel, configured: true };
}

function fixedHealth(
	stateId: NotificationsSettingsShowcaseStateId,
	configured: boolean,
	level: "ok" | "warn" | "error",
	clock: typeof SHOWCASE_CLOCK = SHOWCASE_CLOCK,
): NotificationHealthReport {
	const state = showcaseState(stateId);
	const heartbeatAt = clock.now() - 42_000;
	return {
		overall: level,
		configured,
		checks: [
			{
				name: "showcase",
				level,
				detail: `${state.copy.english} ${state.copy.korean} ${state.copy.japanese} ${state.copy.chinese}`,
			},
		],
		daemon: {
			present: configured,
			ownerId: configured ? "showcase-daemon" : undefined,
			pid: configured ? 2_050 : undefined,
			alive: configured,
			heartbeatFresh: level === "ok",
			identityMatches: level !== "error",
			stopped: stateId === "foreign-blocked" || stateId === "blocked-restore-retain",
			heartbeatAt: configured ? heartbeatAt : undefined,
			heartbeatAgeMs: configured ? clock.now() - heartbeatAt : undefined,
			generation: configured ? 7 : undefined,
			currentGeneration: 7,
			generationRelation: configured ? "current" : "unknown",
		},
		endpoints: {
			total: configured ? 3 : 0,
			live: configured && level !== "error" ? 2 : 0,
			dead: configured && level === "error" ? 1 : 0,
			unknown: configured ? 1 : 0,
			unreadable: 0,
		},
		reachability: {
			probed: stateId === "health-ok",
			ok: level === "ok",
			detail: level === "ok" ? "reachable" : level === "warn" ? "recovery is available" : "foreign owner blocked",
		},
	};
}

function fixedEditorState(
	stateId: NotificationsSettingsShowcaseStateId,
	clock: typeof SHOWCASE_CLOCK = SHOWCASE_CLOCK,
): NotificationsEditorState {
	const status: NotificationStatusReport = {
		enabled: true,
		redact: false,
		verbosity: "lean",
		globallyConfigured: true,
		telegram: {
			botTokenMasked: "••••••••",
			channel: "1001",
			configured: true,
			tokenFingerprint: "telegram:2050feed",
		},
		discord: { botTokenMasked: "(not set)", channel: undefined, configured: false },
		slack: { botTokenMasked: "(not set)", channel: undefined, configured: false },
	};
	let session: NotificationSessionStatus = {
		eligible: true,
		locallyEnabled: true,
		effectiveEnabled: true,
		running: true,
		environment: "default",
	};
	const preferences: NotificationsEditorPreferences = {
		redact: false,
		verbosity: "lean",
		sessionScope: "all",
		richEnabled: true,
		richDraftEnabled: false,
		toolActivityEnabled: true,
	};

	switch (stateId) {
		case "home-unconfigured":
		case "setup-provider":
		case "setup-chat-entry":
		case "setup-token-entry":
		case "setup-validating":
		case "setup-threaded-warning":
		case "setup-pairing":
		case "setup-review":
		case "saving":
		case "no-health-load":
		case "cancellation":
			status.enabled = false;
			status.globallyConfigured = false;
			status.telegram = {
				botTokenMasked: "(not set)",
				channel: undefined,
				configured: false,
				tokenFingerprint: undefined,
			};
			session = { ...session, locallyEnabled: false, effectiveEnabled: false, running: false };
			break;
		case "home-configured-inactive":
			status.enabled = false;
			session = { ...session, locallyEnabled: false, effectiveEnabled: false, running: false };
			break;
		case "home-local-off":
			session = { ...session, locallyEnabled: false, effectiveEnabled: false, running: false };
			break;
		case "home-env-off":
			session = {
				eligible: false,
				locallyEnabled: false,
				effectiveEnabled: false,
				running: false,
				environment: "off",
			};
			break;
		case "home-env-on":
			status.enabled = false;
			status.globallyConfigured = false;
			status.telegram = {
				botTokenMasked: "(not set)",
				channel: undefined,
				configured: false,
				tokenFingerprint: undefined,
			};
			session = { ...session, environment: "explicit" };
			break;
		case "home-discord-only":
			status.telegram = {
				botTokenMasked: "(not set)",
				channel: undefined,
				configured: false,
				tokenFingerprint: undefined,
			};
			status.discord = configuredAdapter("discord-channel");
			break;
		case "home-slack-only":
			status.telegram = {
				botTokenMasked: "(not set)",
				channel: undefined,
				configured: false,
				tokenFingerprint: undefined,
			};
			status.slack = configuredAdapter("slack-channel");
			break;
		case "foreign-blocked":
		case "blocked-restore-retain":
			session = { ...session, effectiveEnabled: false, running: false };
			break;
		default:
			break;
	}

	if (stateId === "no-health-load") return { status, session, preferences };
	const level =
		stateId === "health-ok"
			? "ok"
			: stateId === "error" || stateId === "foreign-blocked" || stateId === "blocked-restore-retain"
				? "error"
				: "warn";
	return { status, session, preferences, health: fixedHealth(stateId, status.globallyConfigured, level, clock) };
}

function unresolved<T>(): Promise<T> {
	return new Promise<T>(() => {});
}

class DeterministicNotificationsEditorOperations implements NotificationsEditorOperations {
	#state: NotificationsEditorState;

	constructor(
		readonly stateId: NotificationsSettingsShowcaseStateId,
		readonly clock: typeof SHOWCASE_CLOCK,
	) {
		this.#state = fixedEditorState(stateId, clock);
	}

	get snapshot(): NotificationsEditorState {
		return structuredClone(this.#state);
	}

	async loadState(): Promise<NotificationsEditorState> {
		if (this.stateId === "no-health-load") throw new Error("deterministic initial status load failure");
		return this.#state;
	}

	async refreshHealth(input: { probe: boolean; signal?: AbortSignal }): Promise<NotificationHealthReport> {
		void input.signal;
		if (this.stateId === "health-probing" && input.probe) return await unresolved<NotificationHealthReport>();
		const level = this.stateId === "health-warning" ? "warn" : "ok";
		const health = fixedHealth(this.stateId, this.#state.status.globallyConfigured, level, this.clock);
		health.reachability = input.probe
			? { probed: true, ok: level === "ok", detail: level === "ok" ? "reachable" : "warning" }
			: health.reachability;
		this.#state = { ...this.#state, health };
		return health;
	}

	async sendTest(): Promise<NotificationTestResult> {
		if (this.stateId === "testing" || this.stateId === "navigation-locked")
			return await unresolved<NotificationTestResult>();
		return {
			ok: true,
			adapter: "telegram",
			chatId: this.#state.status.telegram.channel,
			detail: "delivered to showcase chat",
		};
	}

	async recover(): Promise<NotificationRecoveryReport> {
		if (this.stateId === "recovering") return await unresolved<NotificationRecoveryReport>();
		if (this.stateId === "error") throw new Error("deterministic recovery failure");
		return {
			endpointsScanned: 3,
			endpointsRemoved: [],
			endpointsKept: 3,
			endpointsUnreadable: 0,
			daemon: { action: "none", detail: "no dead owner", ownerId: "showcase-daemon", pid: 2_050 },
		};
	}

	async reconnect(): Promise<TelegramDaemonReconnectOutcome> {
		if (this.stateId === "reconnecting") return await unresolved<TelegramDaemonReconnectOutcome>();
		return this.stateId === "foreign-blocked" ? "blocked_identity" : "attached";
	}

	async preflightProposedIdentity(
		input: NotificationsEditorSetupInput,
		_signal: AbortSignal,
	): Promise<NotificationsPreflightResult> {
		void input.token.consume();
		if (this.stateId === "setup-pairing" || this.stateId === "setup-validating" || this.stateId === "cancellation") {
			return await unresolved<NotificationsPreflightResult>();
		}
		const foreign = this.stateId === "setup-threaded-warning";
		return {
			status: "ready",
			identity: foreign ? { status: "foreign" } : { status: "absent" },
			message: foreign
				? "Threaded Mode needs review before this Telegram setup can be saved."
				: "Telegram destination is ready for review.",
			draft: {
				chatId: input.chatId ?? "1001",
				tokenMask: "••••••••",
				tokenFingerprint: "telegram:2050feed",
				richEnabled: input.richEnabled,
				richDraftEnabled: input.richDraftEnabled,
			},
		};
	}

	async commitConfigure(_draft: PreparedTelegramConfiguration): Promise<NotificationsConfigureCommitResult> {
		if (this.stateId === "saving") return await unresolved<NotificationsConfigureCommitResult>();
		this.#state = {
			...this.#state,
			status: {
				...this.#state.status,
				enabled: true,
				globallyConfigured: true,
				telegram: {
					botTokenMasked: "••••••••",
					channel: "1001",
					configured: true,
					tokenFingerprint: "telegram:2050feed",
				},
			},
		};
		if (this.stateId === "blocked-restore-retain") {
			return {
				status: "blocked_identity",
				receipt: SHOWCASE_RECEIPT,
				message: "Configuration saved but activation blocked by a foreign daemon.",
				restore: async () => ({ status: "conflict", paths: ["notifications.telegram.chatId"] }),
				retainCommitted: () => SHOWCASE_RECEIPT.discard(),
			};
		}
		return { status: "saved", receipt: SHOWCASE_RECEIPT, message: "Telegram configuration saved atomically." };
	}

	async saveInactive(_draft: PreparedTelegramConfiguration): Promise<NotificationsSaveInactiveResult> {
		return { status: "saved_inactive", receipt: SHOWCASE_RECEIPT, message: "Telegram configuration saved inactive." };
	}

	discardConfigureDraft(_draft: PreparedTelegramConfiguration): void {}

	async enableGlobally(): Promise<NotificationsMutationResult> {
		this.#state = { ...this.#state, status: { ...this.#state.status, enabled: true } };
		return { message: "Global notifications enabled using stored credentials." };
	}

	async disableGlobally(): Promise<NotificationsMutationResult> {
		this.#state = { ...this.#state, status: { ...this.#state.status, enabled: false } };
		return { message: "Notifications disabled globally." };
	}

	async removeTelegram(): Promise<NotificationsMutationResult & { globallyDisabled?: boolean }> {
		this.#state = {
			...this.#state,
			status: {
				...this.#state.status,
				telegram: {
					botTokenMasked: "(not set)",
					channel: undefined,
					configured: false,
					tokenFingerprint: undefined,
				},
			},
		};
		return { message: "Telegram removed; other adapters remain unchanged.", globallyDisabled: false };
	}

	async setSessionLocal(enabled: boolean): Promise<NotificationSessionReconcileResult> {
		const status = { ...this.#state.session, locallyEnabled: enabled, effectiveEnabled: enabled, running: enabled };
		this.#state = { ...this.#state, session: status };
		return { outcome: enabled ? "started" : "stopped", status };
	}

	async commitPreferences(preferences: NotificationsEditorPreferences): Promise<NotificationsMutationResult> {
		this.#state = {
			...this.#state,
			preferences: { ...preferences },
			status: { ...this.#state.status, redact: preferences.redact, verbosity: preferences.verbosity },
		};
		return { message: "Notification preferences saved atomically." };
	}

	async reconcileCurrentSession(): Promise<NotificationSessionReconcileResult> {
		return { outcome: "already", status: this.#state.session };
	}
}

async function settleEditor(): Promise<void> {
	for (let index = 0; index < 8; index += 1) await Promise.resolve();
}

function selectAction(component: SettingsSelectorComponent, index: number): void {
	for (let count = 0; count < index; count += 1) component.handleInput("\x1b[B");
}

function selectNotifications(component: SettingsSelectorComponent): void {
	for (let index = 0; index < 9; index += 1) component.handleInput("\t");
}

function enterTelegramSetup(component: SettingsSelectorComponent): void {
	component.handleInput("\n");
	component.handleInput("\n");
}

function enterTokenEntry(component: SettingsSelectorComponent): void {
	enterTelegramSetup(component);
	component.handleInput("\n");
}

function startPairingDiscovery(component: SettingsSelectorComponent): void {
	enterTokenEntry(component);
	component.handleInput(SHOWCASE_TOKEN);
	component.handleInput("\n");
}

function startPrivateChatValidation(component: SettingsSelectorComponent): void {
	enterTelegramSetup(component);
	component.handleInput("1001");
	component.handleInput("\n");
	component.handleInput(SHOWCASE_TOKEN);
	component.handleInput("\n");
}

async function navigateToState(
	component: SettingsSelectorComponent,
	stateId: NotificationsSettingsShowcaseStateId,
): Promise<readonly string[]> {
	switch (stateId) {
		case "setup-provider":
			component.handleInput("\n");
			return ["home:Configure Telegram"];
		case "setup-chat-entry":
			enterTelegramSetup(component);
			return ["home:Configure Telegram", "provider-selection:Telegram", "chat-entry:private chat ID"];
		case "setup-token-entry":
			enterTokenEntry(component);
			return ["home:Configure Telegram", "provider-selection:Telegram", "chat-entry:private chat ID (blank)"];
		case "setup-validating":
			startPrivateChatValidation(component);
			return [
				"home:Configure Telegram",
				"provider-selection:Telegram",
				"chat-entry:private chat ID",
				"token-entry:masked token",
				"pairing:private-chat validation",
			];
		case "setup-threaded-warning":
		case "setup-review":
			startPairingDiscovery(component);
			await settleEditor();
			return [
				"home:Configure Telegram",
				"provider-selection:Telegram",
				"chat-entry:private chat ID",
				"token-entry:masked token",
				"review",
			];
		case "setup-pairing":
			startPairingDiscovery(component);
			return [
				"home:Configure Telegram",
				"provider-selection:Telegram",
				"chat-entry:private chat ID (blank)",
				"token-entry:masked token",
				"pairing:discovery",
			];
		case "saving":
			startPairingDiscovery(component);
			await settleEditor();
			component.handleInput("\n");
			return [
				"home:Configure Telegram",
				"provider-selection:Telegram",
				"chat-entry:private chat ID",
				"token-entry:masked token",
				"review:Save configuration",
			];
		case "blocked-restore-retain":
			startPairingDiscovery(component);
			await settleEditor();
			component.handleInput("\n");
			await settleEditor();
			component.handleInput("\t");
			component.handleInput("\x1b[C");
			component.dispose();
			return [
				"home:Configure Telegram",
				"provider-selection:Telegram",
				"chat-entry:private chat ID",
				"token-entry:masked token",
				"review:Save configuration",
				"blocked:Tab, Right, and dispose leave restore/retain unresolved",
			];
		case "health-probing":
			selectAction(component, 5);
			component.handleInput("\n");
			return ["home:Probe health"];
		case "health-ok":
			selectAction(component, 4);
			component.handleInput("\n");
			await settleEditor();
			return ["home:Refresh health"];
		case "testing":
			selectAction(component, 6);
			component.handleInput("\n");
			return ["home:Send test notification"];
		case "recovering":
			selectAction(component, 7);
			component.handleInput("\n");
			return ["home:Recover notification delivery"];
		case "reconnecting":
			selectAction(component, 8);
			component.handleInput("\n");
			return ["home:Reconnect Telegram runtime"];
		case "navigation-locked":
			selectAction(component, 6);
			component.handleInput("\n");
			component.handleInput("\x1b");
			return ["home:Send test notification", "Escape while guarded"];
		case "confirmation-remove":
			selectAction(component, 9);
			component.handleInput("\n");
			return ["home:Remove Telegram"];
		case "confirmation-disable":
			selectAction(component, 2);
			component.handleInput("\n");
			return ["home:Disable globally"];
		case "preferences":
			selectAction(component, 10);
			component.handleInput("\n");
			return ["home:Notification preferences", "preferences:unsaved draft"];
		case "success":
			selectAction(component, 1);
			component.handleInput("\n");
			await settleEditor();
			return ["home:Enable globally"];
		case "error":
			selectAction(component, 7);
			component.handleInput("\n");
			await settleEditor();
			return ["home:Recover notification delivery"];
		case "foreign-blocked":
			selectAction(component, 8);
			component.handleInput("\n");
			await settleEditor();
			return ["home:Reconnect Telegram runtime"];
		case "cancellation":
			startPairingDiscovery(component);
			component.handleInput("\x1b");
			return [
				"home:Configure Telegram",
				"provider-selection:Telegram",
				"chat-entry:private chat ID (blank)",
				"token-entry:masked token",
				"pairing:Escape",
			];
		case "narrow-scroll":
			selectAction(component, 10);
			return ["home:Notification preferences", "home:list position 11/11"];
		default:
			return ["home"];
	}
}

async function configureDeterministicTheme(renderMode: NotificationsSettingsShowcaseRenderMode): Promise<() => void> {
	const originalColorTerm = Bun.env.COLORTERM;
	const originalChalkLevel = chalk.level;
	Bun.env.COLORTERM = "truecolor";
	chalk.level = 3;
	try {
		await initTheme(false, renderMode === "ascii-no-color" ? "ascii" : "unicode", false, "red-claw", "red-claw");
	} catch (error) {
		chalk.level = originalChalkLevel;
		throw error;
	} finally {
		if (originalColorTerm === undefined) delete Bun.env.COLORTERM;
		else Bun.env.COLORTERM = originalColorTerm;
	}
	return () => {
		chalk.level = originalChalkLevel;
	};
}

function renderTerminalSurface(
	component: SettingsSelectorComponent,
	viewport: NotificationsSettingsShowcaseViewport,
	stateId: NotificationsSettingsShowcaseStateId,
): string {
	const lines = component.render(viewport.columns);
	const tabLines = component.children[1]?.render(viewport.columns).length ?? 0;
	const contentStart = 1 + tabLines + 1;
	const minimumFrameRows = contentStart + 14 + 1;
	const paddingBeforeClosingBorder = Math.max(0, minimumFrameRows - lines.length);
	if (paddingBeforeClosingBorder > 0) {
		lines.splice(Math.max(0, lines.length - 1), 0, ...Array.from({ length: paddingBeforeClosingBorder }, () => ""));
	}
	if (lines.length > viewport.rows) {
		throw new Error(`Notifications selector ${stateId} exceeds ${viewport.id}: rendered ${lines.length} rows`);
	}
	while (lines.length < viewport.rows) lines.push("");
	return `${lines.join("\n")}\n`;
}

export async function renderNotificationsSettingsShowcase(
	entry: NotificationsSettingsShowcaseEntry,
): Promise<NotificationsSettingsShowcaseRender> {
	showcaseState(entry.stateId);
	const restoreChalk = await configureDeterministicTheme(entry.renderMode);
	let component: SettingsSelectorComponent | undefined;
	try {
		await Settings.init({ inMemory: true });
		const operations = new DeterministicNotificationsEditorOperations(entry.stateId, SHOWCASE_CLOCK);
		component = new SettingsSelectorComponent(
			{
				availableThinkingLevels: [],
				thinkingLevel: undefined,
				availableThemes: ["red-claw"],
				availableModelProfiles: [],
				cwd: "/showcase",
			},
			{ onChange: () => {}, onCancel: () => {} },
			operations,
		);
		selectNotifications(component);
		await settleEditor();
		const navigation = await navigateToState(component, entry.stateId);
		const rendered = renderTerminalSurface(component, entry.viewport, entry.stateId);
		const terminalAnsiText = entry.renderMode === "ascii-no-color" ? Bun.stripANSI(rendered) : rendered;
		return {
			terminalText: Bun.stripANSI(terminalAnsiText),
			terminalAnsiText,
			captureMode: "live-settings-selector",
			state: operations.snapshot,
			selectorTab: "notifications",
			navigation,
			fixedClockTimestamp: new Date(SHOWCASE_CLOCK.now()).toISOString(),
		};
	} finally {
		if (entry.stateId === "blocked-restore-retain" && component) {
			component.handleInput("\x1b[B");
			component.handleInput("\n");
			await settleEditor();
		}
		component?.dispose();
		restoreChalk();
	}
}
