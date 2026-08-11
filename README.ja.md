<p align="center">
  <img src="assets/hero.png" alt="Gajae-Code 自律コーディングエージェントのヒーローイラスト" width="100%" />
</p>

<h1 align="center">Gajae-Code</h1>

<p align="center">
  <strong>Encode intention. Decode software.</strong><br />
  すでに契約しているプランで動き、スマホから応答できるコーディングエージェント。
</p>

<p align="center">
  <a href="https://gajae-code.com"><img alt="Website" src="https://img.shields.io/badge/website-gajae--code.com-ff4d4f?style=flat-square"></a>
  <a href="https://www.npmjs.com/package/gajae-code"><img alt="npm package" src="https://img.shields.io/npm/v/gajae-code?style=flat-square"></a>
  <a href="LICENSE"><img alt="MIT license" src="https://img.shields.io/badge/license-MIT-green?style=flat-square"></a>
  <a href="https://discord.gg/8vPXmxSt9"><img alt="Discord" src="https://img.shields.io/badge/Discord-join-5865F2?style=flat-square&logo=discord&logoColor=white"></a>
</p>

<p align="center">
  <a href="README.md">English</a> | <a href="README.ko.md">한국어</a> | <a href="README.zh-CN.md">中文</a> | 日本語
</p>

> Gajae-Code は実験的なベータ段階のプロジェクトです。荒削りな部分があるため、重要な作業では出力を検証してから利用してください。
>
> このドキュメントは英語版 [README.md](README.md) の翻訳です。内容に差異がある場合は英語版が正（SSOT）です。

Gajae-Code（`gjc`）は外付けのコーディングエージェントハーネスです。任意のリポジトリや worktree で実行し、変更の前に計画し、証拠とともに実行し、ターミナル・スマホ・自作ボットのどこからでもコントロールできます。

## いま契約中のコーディングプランをそのまま

<p align="center">
  <img src="assets/coding-plans-banner.png" alt="GJC が対応するコーディングプランとプロバイダ: Claude、ChatGPT/Codex、Gemini、GitHub Copilot、GitLab Duo、Cursor、Grok、GLM/Z.AI、Kimi、MiniMax、Qwen、Xiaomi、Perplexity、OpenCode、Fireworks" width="100%" />
</p>

一度ログインすれば、すでに契約しているプランで GJC を動かせます。追加の API 課金は不要 — セッション内で `/login` を実行してプロバイダを選ぶだけです:

| プラン / サブスクリプション | OAuth ログイン |
| --- | --- |
| Claude Pro / Max | `anthropic` |
| ChatGPT Plus / Pro (Codex) | `openai-codex`（ブラウザ）· `openai-codex-device`（ヘッドレス） |
| Google Gemini CLI (Cloud Code Assist) | `google-gemini-cli` |
| GitHub Copilot | `github-copilot` |
| GitLab Duo | `gitlab-duo` |
| Cursor | `cursor` |
| xAI (Grok) | `xai` |
| Z.AI GLM Coding Plan | `zai` |
| Kimi Code / Coding Plan / Moonshot | `kimi-code` · `moonshot` |
| Fire Pass（Fireworks Kimi K2.6 Turbo サブスクリプション） | `firepass` |
| OpenCode Zen / OpenCode Go | `opencode-zen` · `opencode-go` |
| MiniMax Coding Plan（国際 / 中国） | `minimax-code` · `minimax-code-cn` |
| Alibaba Token Plan / Qwen Portal | `alibaba-token-plan` · `qwen-portal` |
| Xiaomi Token Plan（SGP / EU / CN） | `xiaomi-token-plan-*` |
| Perplexity Pro / Max | `perplexity` |
| Command Code GOAT コーディングプラン | `gjc setup` プリセット `commandcode-goat`（`CMD_API_KEY`） |

OAuth プラン以外にも、API キー、ローカルランタイム（Ollama、LM Studio、vLLM）、ゲートウェイ（Cloudflare AI Gateway、Vercel AI Gateway、LiteLLM など）で 50 以上のプロバイダを利用できます。`models.yml` に独自エンドポイントを登録し、プロバイダごとに複数アカウントを使用量ベースでルーティングし、モデルプリセット/プロファイルでロールごとにベンダーを混在させ、auth ブローカー/ゲートウェイでチームの資格情報を一元化できます。

- [モデル・プロバイダ・認証解決順序](docs/models.md)
- [カスタムプロバイダ & マルチアカウントルーティング](docs/custom-providers-and-multi-account.md)
- [マルチベンダーロールプロファイル](docs/multi-vendor-profiles.md)
- [Auth ブローカー & ゲートウェイ（チーム共有資格情報）](docs/auth-broker-gateway.md)

## スマホから応答

<p align="center">
  <img src="assets/telegram-mobile-hero.png" alt="Gajae Code モバイル応答のヒーローイラスト" width="100%" />
</p>

エージェントが判断を求めると Telegram に通知が届き、どこからでも応答できます:

- **セッションごとのフォーラムトピック** — ライブ/確定出力、コンテキスト更新、画像添付、インラインボタン、自由テキスト返信、入力中インジケータ。
- **設定は一度だけ** — 実行中セッションの `/settings` → Notifications から、またはヘッドレスで `gjc notify setup|status|health|test|recovery`。トークンは入力時にマスクされ、以後表示されません。
- **`gjc daemon`** — ボットトークンごとに安全な long-poll オーナーを 1 つ維持し、新しいセッションが Telegram 409 衝突なしにクリーンに接続します。
- Discord と Slack への配信も同梱。汎用の `action_needed`/`reply` プロトコルにより、どんなボットやモバイルアプリでもターミナルスクレイピングなしで回答を返せます。

- [Telegram オンボーディング](docs/telegram-onboarding.md) · [Discord](docs/discord-onboarding.md) · [Slack](docs/slack-onboarding.md)

## トークンを節約する

GJC はトークンコストの両面を最適化します:

- **キャッシュヒット** — プロバイダごとの `cacheRetention` 制御。Anthropic は短いキャッシュが長時間のエージェント実行に脆弱なため、デフォルトで長期（1 時間）キャッシュ保持。プロバイダランキングは安価な `cacheRead` 経路を優先し、オプトインの session-affinity ヘッダで OpenAI 互換リレーがサーバ側プロンプトキャッシュを再利用できます。
- **コンテキスト節約** — ファイル読み取りはファイル全体ではなく構造サマリを返し、巨大なシェル出力はコンテキストを埋める代わりに最小化されて回収可能な `artifact://` 参照へ退避されます。コンパクションとブランチ要約が、過去の作業を失わずに長いセッションをウィンドウ内に保ちます。

- [キャッシュ保持 & プロバイダ互換性](docs/models.md) · [コンパクション & ブランチ要約](docs/compaction.md)

## 変更の前に計画

意図的に小さなワークフローサーフェス — スキル 4 つ、ロールエージェント 4 つ、それだけです:

```text
deep-interview -> ralplan -> ultragoal
                         └─ 並列 tmux ワーカーが有効なときだけ任意の team 実行
```

| サーフェス | 役割 |
| --- | --- |
| `deep-interview` | 曖昧な要望を具体的な要件に変えます。 |
| `ralplan` | コード変更の前に実装計画を構築・批評します。 |
| `ultragoal` | 実行・修正・検証・証拠までゴールを追跡します。 |
| `team` | 並列化が価値を持つとき tmux ワーカーを調整します。 |
| `executor` / `architect` / `planner` / `critic` | 実装と読み取り専用レビューのための同梱ロールエージェント。 |

オプトイン機能: **`gjc rlm`**（ノートブックとレポートを合成する Jupyter スタイルのリサーチ/REPL モード）と **`computer-use`**（実験的なデスクトップ制御）。[Python REPL](docs/python-repl.md)、[docs/tools/computer.md](docs/tools/computer.md) を参照。

## インストール

```sh
bun install -g gajae-code
gjc
```

プリビルドバイナリは Linux（x64/arm64）、macOS（arm64/x64）、Windows（x64）をカバーし、npm/Bun 経由はすべてのプラットフォームで動作します。ナイトリーチャンネル: `bun install -g gajae-code@nightly`。

インストールマトリクス全体、Windows セットアップ、更新チャンネル、シェル補完: [docs/install.md](docs/install.md)。

## クイックスタート

```sh
gjc                                # 現在のチェックアウトで実行
gjc --tmux                         # tmux ベースのリーダーセッション
gjc --tmux --worktree my-task      # リスクの高い作業のための分離 worktree
gjc @screenshot.png "何を変えるべき？"   # 画像入力
```

セッション内で:

```text
/login                       プロバイダ / コーディングプランを選択
/skill:deep-interview        曖昧な要件を明確化
/skill:ralplan               計画の構築と批評
gjc ultragoal create-goals --brief-file <承認済み計画>
```

デフォルトのダーク TUI アイデンティティは GJC red-claw テーマで、ライト外観ターミナルは同梱の blue-crab テーマがデフォルトです。他のテーマは Settings または `/theme` から選択してください。

## OpenClaw / Hermes に GJC を使わせる

GJC はネイティブの Coordinator MCP ブリッジを同梱しており、OpenClaw や Hermes のような外部コントローラが永続 turn を通じて実際の GJC セッションをオーケストレーションします — ターミナルスクレイピングは一切不要です。

ガイドを読む必要はありません — 以下のプロンプトを OpenClaw/Hermes コントローラに貼り付ければ、自分で配線を済ませます:

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

ライブセッションを直接操作するコントローラのために、各セッションはループバック **SDK WebSocket** エンドポイント、`gjc sdk session` CLI（`list|inspect|send|status|tail`）、同梱の `sdk-skills/`（`gjc-sdk-discover` · `gjc-sdk-operate` · `gjc-sdk-author`）も公開しています — レビュー済みで承認ゲート付きの手順であり、コントローラ上のどんなエージェントでも従えます。

- [外部コントローラ統合ガイド](docs/bot-integration.md) · [Coordinator MCP ブリッジ](docs/hermes-mcp-bridge.md)
- [外部コントローラ / ボット](docs/bot-integration.md) — プロバイダ非依存スモーク；[`docs/aside-integration.md`](docs/aside-integration.md) はオプトインの検索/コンテキストサイドカーを扱います
- [SDK & ワイヤプロトコル](docs/sdk.md) · [SDK セッション CLI](docs/sdk-session-cli.md) · [外部制御レディネス](docs/external-control-readiness.md)

## ドキュメント

**[gajae-code.com](https://gajae-code.com)** または `docs/` から始めてください:

- [インストール & 更新](docs/install.md) · [環境変数](docs/environment-variables.md) · [キーバインディング](docs/keybindings.md) · [テーマ](docs/theme.md)
- [モデル & プロバイダ](docs/models.md) · [カスタムプロバイダ & マルチアカウントルーティング](docs/custom-providers-and-multi-account.md) · [マルチベンダープロファイル](docs/multi-vendor-profiles.md) · [Auth ブローカー](docs/auth-broker-gateway.md)
- [Telegram](docs/telegram-onboarding.md) · [ボット統合](docs/bot-integration.md) · [SDK](docs/sdk.md) · [SDK セッション CLI](docs/sdk-session-cli.md)
- [セッション](docs/session.md) · [コンパクション](docs/compaction.md) · [メモリ](docs/memory.md) · [シークレット](docs/secrets.md)
- [コードベース概要](docs/codebase-overview.md) · [コントリビュート / 開発環境](CONTRIBUTING.md)
- [macOS Option/Alt キー設定（iTerm2）](docs/macos-option-key.md) · [GEO 可視性ベンチマーク](docs/geobench.md)

## SDK 拡張

- [gjc-remote](https://github.com/kogangdon/gjc-remote) — Discord からリモートホスト上の許可リスト済み GJC セッションを制御。
- [oh-my-gajae-code](https://github.com/devswha/oh-my-gajae-code) — 追加スキルとスラッシュコマンドのためのコミュニティプラグインマーケットプレイス。
- [GJC マルチベンダーセットアップガイド](https://github.com/project820/gjc-multivendor-setup-guide) — マルチベンダー構成のためのロールベースプロバイダプロファイル。

## 開発

```sh
bun install
bun run build:native
bun run dev:link       # グローバルの `gjc` がこのチェックアウトのソースを実行
bun run dev:doctor     # リンクの検証
```

パッケージマップとゲートは [CONTRIBUTING.md](CONTRIBUTING.md) と [docs/codebase-overview.md](docs/codebase-overview.md) を参照してください。

## コントリビュータ & 系譜

[Yeachan-Heo](https://github.com/Yeachan-Heo)、[IYENTeam](https://github.com/IYENTeam)、[HaD0Yun](https://github.com/HaD0Yun)、[probepark](https://github.com/probepark) に感謝します。GJC は複数のエージェントハーネスから得た教訓の上に築かれており、歴史的なアトリビューションは [NOTICE.md](NOTICE.md) にあります。

## ライセンス

MIT。[LICENSE](LICENSE) を参照。
