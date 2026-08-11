<p align="right">
  <a href="README.md">English</a> | <a href="README.ko.md">한국어</a> | <a href="README.zh-CN.md">中文</a> | <strong>日本語</strong>
</p>

<p align="center">
  <img src="assets/hero.png" alt="Gajae-Code 自律型コーディングエージェントのヒーローイラスト" width="100%" />
</p>

<h1 align="center">G A J A E - C O D E</h1>

<p align="center">
  <strong>Encode intention. Decode software.</strong>
  <br/>
  <sub><strong>すでに払っているプラン</strong>で動き、スマホに答えを届けるコーディングエージェント。</sub>
</p>

<p align="center">
  <a href="https://gajae-code.com"><img alt="Website" src="https://img.shields.io/badge/website-gajae--code.com-ff4d4f?style=flat-square"></a>
  <a href="https://www.npmjs.com/package/gajae-code"><img alt="npm package" src="https://img.shields.io/npm/v/gajae-code?style=flat-square"></a>
  <a href="LICENSE"><img alt="MIT license" src="https://img.shields.io/badge/license-MIT-green?style=flat-square"></a>
  <a href="https://discord.gg/8vPXmxSt9"><img alt="Discord" src="https://img.shields.io/badge/Discord-join-5865F2?style=flat-square&logo=discord&logoColor=white"></a>
</p>

<p align="center">
  <a href="#クイックスタート">クイックスタート</a> ·
  <a href="#なぜ-gajae-code-なのか">なぜ</a> ·
  <a href="#手持ちのコーディングプランで">コーディングプラン</a> ·
  <a href="#スマホで答える">スマホ</a> ·
  <a href="#変更の前に計画">ワークフロー</a> ·
  <a href="#トークンを節約">トークン節約</a> ·
  <a href="#openclaw--hermes-に-gjc-を操縦させる">コントローラ</a> ·
  <a href="#ドキュメント">ドキュメント</a>
</p>

**すでに持っているサブスクリプションでログインし、ファイルが 1 つ変わる前に計画し、証拠とともに実行する — エージェントからの質問にはターミナル・スマホ・自前の bot、どこからでも答えられます。**

Gajae-Code（`gjc`）は外付けのコーディングエージェントハーネスです。任意のリポジトリやワークツリーに放り込むだけ。追加の API 課金なし。トークン単価の不安なし。ターミナルの張り付きも不要。

> Gajae-Code は実験的なベータ段階のプロジェクトです。粗い部分が残っている可能性があるため、重要な作業では出力を検証してから利用してください。
>
> 本書は英語版 [README.md](README.md) の翻訳です。内容に差異がある場合は英語版が正（SSOT）です。

---

## なぜ Gajae-Code なのか

多くのコーディングエージェントは 3 つの場所で破綻します: 二重に課金し、理解する前にコードを変更し、キーボードを離れた瞬間に沈黙します。

| 問題 | 何が起きるか | Gajae-Code の解決策 |
| :--- | :--- | :--- |
| 別建ての API 課金 | プラン料金*に加えて*トークン従量の API 費用 | すでに払っているコーディングプランで `/login` — Claude、Codex、Cursor、Copilot、OpenCode Go、GOAT、ClinePass など |
| コードから触るエージェント | 理解する前に編集し、手戻りが発生 | 計画ゲート付きワークフロー: インタビュー → 計画 → 批評 → *それから*変更、承認ゲートあり |
| ターミナル拘束のセッション | 深夜 2 時の質問で朝まで作業停止 | 質問は Telegram/Discord/Slack にルーティング — どこからでも回答 |
| コンテキスト肥大 | ファイル全読みとログ洪水がウィンドウを焼く | 構造サマリー、artifact 退避、キャッシュ考慮ルーティング、コンパクション |

---

## クイックスタート

**インストール** — Linux（x64/arm64）、macOS（arm64/x64）、Windows（x64）向けビルド済みバイナリを提供。npm/Bun 経由はどこでも動作:

```sh
bun install -g gajae-code
gjc
```

**初回利用** — プランを選んで出発:

```text
/login                       プロバイダ / コーディングプランを選択
/skill:deep-interview        曖昧な要件を明確化
/skill:ralplan               計画の立案と批評
gjc ultragoal create-goals --brief-file <承認済みの計画>
```

**実行モード:**

```sh
gjc                                # 現在のチェックアウトで実行
gjc --tmux                         # tmux ベースのリーダーセッション
gjc --tmux --worktree my-task      # リスクの高い作業向けの隔離ワークツリー
gjc @screenshot.png "何を変えるべき？"   # 画像入力
```

Nightly チャンネル: `bun install -g gajae-code@nightly`。インストールマトリクス全体、Windows 設定、更新チャンネル、シェル補完: [docs/install.md](docs/install.md)。

---

## 手持ちのコーディングプランで

<p align="center">
  <img src="assets/coding-plans-banner.png" alt="GJC が対応するコーディングプランとプロバイダ: Claude、ChatGPT/Codex、Cursor、GitHub Copilot、OpenCode Go、Kimi、GLM/Z.AI、MiniMax、Grok、Qwen、Command Code GOAT、ClinePass" width="100%" />
</p>

一度ログインすれば、すでに払っているサブスクリプションで GJC が動きます。セッション内で `/login` を実行してプランを選択:

| プラン / サブスクリプション | OAuth ログイン |
| :--- | :--- |
| Claude Pro / Max | `anthropic` |
| ChatGPT Plus / Pro（Codex） | `openai-codex`（ブラウザ）· `openai-codex-device`（ヘッドレス） |
| Cursor | `cursor` |
| GitHub Copilot | `github-copilot` |
| OpenCode Zen / OpenCode Go | `opencode-zen` · `opencode-go` |
| Kimi Code / Coding Plan / Moonshot | `kimi-code` · `moonshot` |
| Z.AI GLM Coding Plan | `zai` |
| MiniMax Coding Plan（国際 / 中国） | `minimax-code` · `minimax-code-cn` |
| xAI（Grok） | `xai` |
| Alibaba Token Plan / Qwen Portal | `alibaba-token-plan` · `qwen-portal` |

その他の OAuth プラン — Google Gemini CLI、GitLab Duo、Perplexity Pro/Max、Fire Pass、Xiaomi Token Plan — は [docs/models.md](docs/models.md) を参照。

### 新着: コーディングプラン・プリセット

API キー方式のコーディングプランはコマンド 1 つでオンボード — プリセットが API 種別、ベース URL、環境変数、互換フラグ、そして**ライブモデルカタログ**を一括で書き込むため、新モデルは GJC の更新なしで現れます:

```sh
gjc setup provider --preset commandcode-goat   # Command Code GOAT プラン（CMD_API_KEY）
gjc setup provider --preset cline-pass         # ClinePass（CLINE_API_KEY）
```

- **Command Code GOAT** — プロバイダのライブ `/models` カタログを取得。`claude-*` モデルはネイティブの Anthropic Messages 経由、それ以外は Chat Completions 経由でルーティング。エイリアス: `commandcode`、`goat`。
- **ClinePass** — モデルのハードコードなし。Cline 自身がカタログを生成するのと同じ方法でライブカタログを取得。エイリアス: `clinepass`、`cline`。
- ほかに利用できるプリセット: `minimax`、`minimax-cn`、`glm`、`alibaba-token-plan` — TUI 内では `/provider add --preset <name>`。

<details>
<summary><strong>コーディングプランの先へ: 50+ プロバイダ、ゲートウェイ、ローカルランタイム</strong></summary>

API キーのプロバイダ、ローカルランタイム（Ollama、LM Studio、vLLM）、ゲートウェイ（Cloudflare AI Gateway、Vercel AI Gateway、LiteLLM など）がすべて利用可能。`models.yml` に自前のエンドポイントを登録し、プロバイダごとの複数アカウントを使用量ベースでルーティングし、モデルプリセット/プロファイルでエージェントロールごとにベンダーを混ぜ、auth ブローカー/ゲートウェイでチームの資格情報を集中管理できます。

- [モデル・プロバイダ・認証解決](docs/models.md)
- [カスタムプロバイダとマルチアカウントルーティング](docs/custom-providers-and-multi-account.md)
- [マルチベンダーロールプロファイル](docs/multi-vendor-profiles.md)
- [Auth ブローカーとゲートウェイ（チーム共有資格情報）](docs/auth-broker-gateway.md)

</details>

---

## スマホで答える

<p align="center">
  <img src="assets/telegram-mobile-hero.png" alt="Gajae Code モバイル回答のヒーローイラスト" width="100%" />
</p>

エージェントが判断を必要とすると Telegram に通知が届き、どこからでも答えられます:

- **セッションごとのフォーラムトピック** — ライブ/確定出力、コンテキスト更新、画像添付、インラインボタン、自由テキスト返信、入力中インジケータ。
- **設定は一度だけ** — 実行中セッションの `/settings` → Notifications から、またはヘッドレスで `gjc notify setup|status|health|test|recovery`。トークンは入力時にマスクされ、以後表示されません。
- **`gjc daemon`** が bot トークンごとに安全な long-poll 所有者を 1 つ維持し、新しいセッションが Telegram 409 競合なしにクリーンに接続します。
- Discord と Slack への配信も同梱。汎用の `action_needed`/`reply` プロトコルにより、どんな bot やモバイルアプリでもターミナルスクレイピングなしで回答を返せます。

[Telegram オンボーディング](docs/telegram-onboarding.md) · [Discord](docs/discord-onboarding.md) · [Slack](docs/slack-onboarding.md)

---

## 変更の前に計画

意図的に小さく絞ったワークフロー表面 — スキル 4 つ、ロールエージェント 4 つ、それ以上はなし:

```text
deep-interview -> ralplan -> ultragoal
                         └─ 並列 tmux ワーカーが有効な場合のみ任意の team 実行
```

| 表面 | 役割 |
| :--- | :--- |
| `deep-interview` | 曖昧な依頼を具体的な要件に変える。 |
| `ralplan` | コード変更の前に実装計画を立てて批評する。 |
| `ultragoal` | 実行・修正・検証・証拠まで目標を追跡する。 |
| `team` | 並列化に価値があるとき tmux ワーカーを調整する。 |
| `executor` / `architect` / `planner` / `critic` | 実装と読み取り専用レビューのための同梱ロールエージェント。 |

オプトインで利用可能: **`gjc rlm`**（ノートブックとレポートを合成する Jupyter スタイルのリサーチ/REPL モード）と **`computer-use`**（実験的なデスクトップ制御）。[Python REPL](docs/python-repl.md) と [docs/tools/computer.md](docs/tools/computer.md) を参照。

---

## トークンを節約

GJC はトークン請求の両側を最適化します:

- **キャッシュヒット** — プロバイダごとの `cacheRetention` 制御。Anthropic は短いキャッシュが長時間のエージェント実行に脆弱なため、デフォルトで長期（1 時間）のキャッシュ保持。プロバイダランキングは安価な `cacheRead` 経路を優先し、オプトインの session-affinity ヘッダで OpenAI 互換リレーがサーバ側プロンプトキャッシュを再利用できます。
- **コンテキスト節約** — ファイル読み取りはファイル全体でなく構造サマリーを返し、過大なシェル出力は最小化されて取得可能な `artifact://` 参照へ退避。コンパクションとブランチサマリーが、過去の作業を失わずに長いセッションをウィンドウ内に保ちます。

[キャッシュ保持とプロバイダ互換](docs/models.md) · [コンパクションとブランチサマリー](docs/compaction.md)

---

## OpenClaw / Hermes に GJC を操縦させる

GJC はネイティブの Coordinator MCP ブリッジを同梱しており、OpenClaw や Hermes のような外部コントローラが durable turn を通じて本物の GJC セッションをオーケストレーションします — ターミナルスクレイピングは一切なし。

ガイドを読む必要はありません — このプロンプトを OpenClaw/Hermes コントローラに貼り付ければ、自分で配線します:

<details>
<summary><strong>コピペ用コントローラセットアッププロンプト</strong></summary>

```text
Set up Gajae-Code (gjc) as your coding-agent backend on this machine. gjc is already installed.

1. Render and install the coordinator MCP setup package (replace the paths):
   gjc setup hermes --root <ABS_REPO_PATH> --profile <PROFILE_NAME> --repo <REPO_NAME> \
     --mutation sessions,questions,reports --profile-dir <YOUR_PROFILE_DIR> --install
   Without --install the command is render-only; re-run with --install to write files.

2. Verify the contract (non-mutating, no LLM call). Both must report ok:
   gjc setup hermes --root <ABS_REPO_PATH> --smoke
   gjc mcp-serve coordinator --check --json

3. Register the MCP server from the installed config. It is equivalent to:
   command: gjc, args: ["mcp-serve", "coordinator"]
   env: GJC_COORDINATOR_MCP_WORKDIR_ROOTS=<ABS_REPO_PATH>,
        GJC_COORDINATOR_MCP_PROFILE=<PROFILE_NAME>,
        GJC_COORDINATOR_MCP_REPO=<REPO_NAME>,
        GJC_COORDINATOR_MCP_SESSION_COMMAND="gjc --worktree",
        GJC_COORDINATOR_MCP_MUTATIONS=sessions,questions,reports

4. To delegate coding work, prefer one call per workflow:
   gjc_delegate_plan / gjc_delegate_execute / gjc_delegate_team
   with { cwd, task, allow_mutation: true, idempotency_key: <fresh-uuid> }.
   Each starts an isolated worktree session and returns a durable turn_id and artifacts.

5. For finer control: gjc_coordinator_start_session -> gjc_coordinator_send_prompt ->
   poll gjc_coordinator_read_turn or bounded gjc_coordinator_await_turn ->
   answer gjc_coordinator_list_questions rows via gjc_coordinator_submit_question_answer ->
   close with gjc_coordinator_report_status.

Rules: every mutating call needs allow_mutation: true plus a fresh idempotency_key.
Treat durable turn state as authoritative; never scrape terminal output.
The session command selector accepts only "gjc" or "gjc --worktree [name]".
```

</details>

ライブセッション 1 つを直接操作するコントローラ向けに、各セッションはループバックの **SDK WebSocket** エンドポイント、`gjc sdk session` CLI（`list|inspect|send|status|tail`）、同梱の `sdk-skills/`（`gjc-sdk-discover` · `gjc-sdk-operate` · `gjc-sdk-author`）も公開します — コントローラ上のどんなエージェントでも従える、レビュー済みで承認ゲート付きの手順です。

- [外部コントローラ統合ガイド](docs/bot-integration.md) · [Coordinator MCP ブリッジ](docs/hermes-mcp-bridge.md)
- [外部コントローラ / ボット](docs/bot-integration.md) — プロバイダ非依存スモーク；[`docs/aside-integration.md`](docs/aside-integration.md) はオプトインの検索/コンテキストサイドカーを扱います
- [SDK とワイヤプロトコル](docs/sdk.md) · [SDK セッション CLI](docs/sdk-session-cli.md) · [外部制御レディネス](docs/external-control-readiness.md)

---

## ドキュメント

**[gajae-code.com](https://gajae-code.com)** または `docs/` から:

- [インストールと更新](docs/install.md) · [環境変数](docs/environment-variables.md) · [キーバインド](docs/keybindings.md) · [テーマ](docs/theme.md)
- [モデルとプロバイダ](docs/models.md) · [カスタムプロバイダとマルチアカウントルーティング](docs/custom-providers-and-multi-account.md) · [マルチベンダープロファイル](docs/multi-vendor-profiles.md) · [Auth ブローカー](docs/auth-broker-gateway.md)
- [Telegram](docs/telegram-onboarding.md) · [Bot 統合](docs/bot-integration.md) · [SDK](docs/sdk.md) · [SDK セッション CLI](docs/sdk-session-cli.md)
- [セッション](docs/session.md) · [コンパクション](docs/compaction.md) · [メモリ](docs/memory.md) · [シークレット](docs/secrets.md)
- [コードベース概要](docs/codebase-overview.md) · [コントリビュート / 開発環境](CONTRIBUTING.md)
- [macOS Option/Alt キー設定（iTerm2）](docs/macos-option-key.md) · [GEO 可視性ベンチマーク](docs/geobench.md)

デフォルトのダーク TUI アイデンティティは GJC red-claw テーマ。ライト外観のターミナルは同梱の blue-crab テーマがデフォルトです。切り替えや自作は[テーマ](docs/theme.md)へ。

## SDK 拡張

- [gjc-remote](https://github.com/kogangdon/gjc-remote) — Discord からリモートホスト上の許可リスト済み GJC セッションを制御。
- [oh-my-gajae-code](https://github.com/devswha/oh-my-gajae-code) — 追加スキルとスラッシュコマンドのコミュニティプラグインマーケットプレイス。
- [GJC マルチベンダーセットアップガイド](https://github.com/project820/gjc-multivendor-setup-guide) — マルチベンダー構成のためのロールベースのプロバイダプロファイル。

## 開発

```sh
bun install
bun run build:native
bun run dev:link       # グローバルの `gjc` がこのチェックアウトのソースを実行
bun run dev:doctor     # リンクを検証
```

パッケージマップとゲートは [CONTRIBUTING.md](CONTRIBUTING.md) と [docs/codebase-overview.md](docs/codebase-overview.md) を参照。

## コントリビュータと系譜

[Yeachan-Heo](https://github.com/Yeachan-Heo)、[IYENTeam](https://github.com/IYENTeam)、[HaD0Yun](https://github.com/HaD0Yun)、[probepark](https://github.com/probepark) に感謝します。GJC はエージェントハーネスの小さな系譜から得た教訓の上に築かれています。歴史的なアトリビューションは [NOTICE.md](NOTICE.md) にあります。

## ライセンス

MIT。[LICENSE](LICENSE) を参照。

---

<p align="center">
  <em>"Encode intention. Decode software."</em>
  <br/><br/>
  <strong>計画が先。変更は自らその座を勝ち取る。</strong>
</p>
