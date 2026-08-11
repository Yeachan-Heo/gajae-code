<p align="right">
  <a href="README.md">English</a> | <a href="README.ko.md">한국어</a> | <strong>中文</strong> | <a href="README.ja.md">日本語</a>
</p>

<p align="center">
  <img src="assets/hero.png" alt="Gajae-Code 自主编码代理主视觉插图" width="100%" />
</p>

<h1 align="center">G A J A E - C O D E</h1>

<p align="center">
  <strong>Encode intention. Decode software.</strong>
  <br/>
  <sub>跑在<strong>你已经在付费的订阅</strong>上、还能在手机上回复你的编码代理。</sub>
</p>

<p align="center">
  <a href="https://gajae-code.com"><img alt="Website" src="https://img.shields.io/badge/website-gajae--code.com-ff4d4f?style=flat-square"></a>
  <a href="https://www.npmjs.com/package/gajae-code"><img alt="npm package" src="https://img.shields.io/npm/v/gajae-code?style=flat-square"></a>
  <a href="LICENSE"><img alt="MIT license" src="https://img.shields.io/badge/license-MIT-green?style=flat-square"></a>
  <a href="https://discord.gg/8vPXmxSt9"><img alt="Discord" src="https://img.shields.io/badge/Discord-join-5865F2?style=flat-square&logo=discord&logoColor=white"></a>
</p>

<p align="center">
  <a href="#快速开始">快速开始</a> ·
  <a href="#为什么选-gajae-code">为什么</a> ·
  <a href="#带上你的编程订阅">编程订阅</a> ·
  <a href="#用手机回复">手机</a> ·
  <a href="#先计划后修改">工作流</a> ·
  <a href="#花更少的-token">Token 瘦身</a> ·
  <a href="#让-openclaw--hermes-驱动-gjc">控制器</a> ·
  <a href="#文档">文档</a>
</p>

**用你已有的订阅登录，在任何文件被修改之前先计划，带着证据执行 — 代理的提问在终端、手机或你自己的 bot 上随时回复。**

Gajae-Code（`gjc`）是一个外置编码代理 harness：丢进任意仓库或 worktree 就能跑。没有额外 API 计费。没有按 token 的焦虑。不用守在终端前。

> Gajae-Code 是实验性的 beta 阶段项目。可能存在粗糙之处，重要工作请先验证输出再依赖。
>
> 本文档是英文 [README.md](README.md) 的译本。若内容有出入，以英文版为准（SSOT）。

---

## 为什么选 Gajae-Code？

大多数编码代理在三个地方翻车：向你收两次钱、没搞懂就改代码、你一离开键盘就沉默。

| 问题 | 后果 | Gajae-Code 的解法 |
| :--- | :--- | :--- |
| 额外 API 计费 | 订阅费*加上*按 token 的 API 费用 | 用你已在付费的编程订阅 `/login` — Claude、Codex、Cursor、Copilot、OpenCode Go、GOAT、ClinePass 等 |
| 上来就改代码的代理 | 没理解就动手，你来返工 | 计划门控工作流：访谈 → 计划 → 评审 → *然后才*修改，带审批门 |
| 绑死终端的会话 | 凌晨两点代理提问，工作停到早上 | 提问路由到 Telegram/Discord/Slack，随时随地回复 |
| 上下文膨胀 | 整文件读取和日志洪水烧掉窗口 | 结构化摘要、artifact 溢出、缓存感知路由、压缩 |

---

## 快速开始

**安装** — 提供 Linux（x64/arm64）、macOS（arm64/x64）、Windows（x64）预编译二进制；npm/Bun 路径全平台可用：

```sh
bun install -g gajae-code
gjc
```

**首次使用** — 选好订阅就出发：

```text
/login                       选择提供商 / 编程订阅
/skill:deep-interview        澄清模糊需求
/skill:ralplan               制定并评审计划
gjc ultragoal create-goals --brief-file <已批准的计划>
```

**运行模式：**

```sh
gjc                                # 在当前 checkout 中运行
gjc --tmux                         # tmux 领导会话
gjc --tmux --worktree my-task      # 高风险工作用隔离 worktree
gjc @screenshot.png "该改什么？"      # 图片输入
```

Nightly 渠道：`bun install -g gajae-code@nightly`。完整安装矩阵、Windows 设置、更新渠道与 shell 补全：[docs/install.md](docs/install.md)。

---

## 带上你的编程订阅

<p align="center">
  <img src="assets/coding-plans-banner.png" alt="GJC 支持的编程订阅与提供商：Claude、ChatGPT/Codex、Cursor、GitHub Copilot、OpenCode Go、Kimi、GLM/Z.AI、MiniMax、Grok、Qwen、Command Code GOAT、ClinePass" width="100%" />
</p>

登录一次，GJC 就跑在你已经付费的订阅上。在会话内运行 `/login` 并选择你的订阅：

| 订阅 / 计划 | OAuth 登录 |
| :--- | :--- |
| Claude Pro / Max | `anthropic` |
| ChatGPT Plus / Pro（Codex） | `openai-codex`（浏览器）· `openai-codex-device`（无头） |
| Cursor | `cursor` |
| GitHub Copilot | `github-copilot` |
| OpenCode Zen / OpenCode Go | `opencode-zen` · `opencode-go` |
| Kimi Code / Coding Plan / Moonshot | `kimi-code` · `moonshot` |
| Z.AI GLM Coding Plan | `zai` |
| MiniMax Coding Plan（国际 / 国内） | `minimax-code` · `minimax-code-cn` |
| xAI（Grok） | `xai` |
| 阿里 Token Plan / Qwen Portal | `alibaba-token-plan` · `qwen-portal` |

更多 OAuth 订阅 — Google Gemini CLI、GitLab Duo、Perplexity Pro/Max、Fire Pass、小米 Token Plan — 见 [docs/models.md](docs/models.md)。

### 新增：编程订阅预设

基于 API key 的编程订阅一条命令即可接入 — 预设会一并写入 API 类型、base URL、环境变量、兼容性标志和**实时模型目录**，新模型无需升级 GJC 就能出现：

```sh
gjc setup provider --preset commandcode-goat   # Command Code GOAT 订阅（CMD_API_KEY）
gjc setup provider --preset cline-pass         # ClinePass（CLINE_API_KEY）
```

- **Command Code GOAT** — 拉取提供商实时 `/models` 目录；`claude-*` 模型走原生 Anthropic Messages，其余走 Chat Completions。别名：`commandcode`、`goat`。
- **ClinePass** — 不硬编码模型；GJC 按 Cline 自己生成目录的方式抓取其实时目录。别名：`clinepass`、`cline`。
- 其他可用预设：`minimax`、`minimax-cn`、`glm`、`alibaba-token-plan` — 或在 TUI 中使用 `/provider add --preset <name>`。

<details>
<summary><strong>编程订阅之外：50+ 提供商、网关、本地运行时</strong></summary>

API key 提供商、本地运行时（Ollama、LM Studio、vLLM）与网关（Cloudflare AI Gateway、Vercel AI Gateway、LiteLLM 等）全部可用。在 `models.yml` 注册自有端点，按用量在每个提供商的多账户间路由，用模型预设/配置按代理角色混搭厂商，或用 auth broker/gateway 集中管理团队凭据。

- [模型、提供商与认证解析](docs/models.md)
- [自定义提供商与多账户路由](docs/custom-providers-and-multi-account.md)
- [多厂商角色配置](docs/multi-vendor-profiles.md)
- [Auth broker 与 gateway（团队共享凭据）](docs/auth-broker-gateway.md)

</details>

---

## 用手机回复

<p align="center">
  <img src="assets/telegram-mobile-hero.png" alt="Gajae Code 移动端回复主视觉插图" width="100%" />
</p>

代理需要决策时会 ping 你的 Telegram — 你在任何地方都能回复：

- **按会话的论坛话题**：实时/最终输出、上下文更新、图片附件、内联按钮、自由文本回复、输入中指示。
- **一次配置**：在运行中会话的 `/settings` → Notifications，或无头方式 `gjc notify setup|status|health|test|recovery`。令牌输入即打码，之后永不显示。
- **`gjc daemon`** 为每个 bot 令牌维持唯一的安全 long-poll 所有者，新会话干净接入，不会触发 Telegram 409 冲突。
- Discord 与 Slack 投递同步提供；通用 `action_needed`/`reply` 协议让任何 bot 或移动应用都能把回答路由回来，无需抓取终端。

[Telegram 上手](docs/telegram-onboarding.md) · [Discord](docs/discord-onboarding.md) · [Slack](docs/slack-onboarding.md)

---

## 先计划，后修改

刻意收窄的工作流表面 — 四个技能、四个角色代理，仅此而已：

```text
deep-interview -> ralplan -> ultragoal
                         └─ 并行 tmux worker 有价值时可选 team 执行
```

| 表面 | 作用 |
| :--- | :--- |
| `deep-interview` | 把模糊请求变成具体需求。 |
| `ralplan` | 在改代码之前制定并评审实现计划。 |
| `ultragoal` | 跟踪目标贯穿执行、修订、验证与证据。 |
| `team` | 并行值得时协调 tmux worker。 |
| `executor` / `architect` / `planner` / `critic` | 内置角色代理，覆盖实现与只读评审通道。 |

可选启用：**`gjc rlm`**（合成 notebook 与报告的 Jupyter 风格研究/REPL 模式）与 **`computer-use`**（实验性桌面控制）。见 [Python REPL](docs/python-repl.md) 与 [docs/tools/computer.md](docs/tools/computer.md)。

---

## 花更少的 token

GJC 同时优化 token 账单的两端：

- **缓存命中** — 按提供商的 `cacheRetention` 控制；Anthropic 默认长效（1 小时）缓存，因为短缓存对长代理运行太脆弱；提供商排序优先廉价的 `cacheRead` 路径；可选的 session-affinity 头让 OpenAI 兼容中继复用服务端提示缓存。
- **上下文节省** — 文件读取返回结构化摘要而非整个文件；超大 shell 输出被最小化并溢出为可取回的 `artifact://` 引用，不冲垮上下文；压缩与分支摘要让长会话留在窗口内且不丢先前工作。

[缓存保留与提供商兼容](docs/models.md) · [压缩与分支摘要](docs/compaction.md)

---

## 让 OpenClaw / Hermes 驱动 GJC

GJC 内置原生 Coordinator MCP 桥，OpenClaw 或 Hermes 等外部控制器通过持久 turn 编排真实的 GJC 会话 — 绝不抓取终端。

不用读指南 — 把这段提示词粘贴进你的 OpenClaw/Hermes 控制器，它会自己接好线：

<details>
<summary><strong>复制粘贴的控制器配置提示词</strong></summary>

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

若控制器要直接驱动单个在线会话，每个会话还暴露回环 **SDK WebSocket** 端点、`gjc sdk session` CLI（`list|inspect|send|status|tail`）以及内置 `sdk-skills/`（`gjc-sdk-discover` · `gjc-sdk-operate` · `gjc-sdk-author`）— 任何控制器托管的代理都能遵循的、经过审阅且带审批门的流程。

- [外部控制器集成指南](docs/bot-integration.md) · [Coordinator MCP 桥](docs/hermes-mcp-bridge.md)
- [外部控制器 / 机器人](docs/bot-integration.md) — 提供商无关冒烟测试；[`docs/aside-integration.md`](docs/aside-integration.md) 涵盖可选的搜索/上下文边车
- [SDK 与线协议](docs/sdk.md) · [SDK 会话 CLI](docs/sdk-session-cli.md) · [外部控制就绪度](docs/external-control-readiness.md)

---

## 文档

从 **[gajae-code.com](https://gajae-code.com)** 或 `docs/` 开始：

- [安装与更新](docs/install.md) · [环境变量](docs/environment-variables.md) · [快捷键](docs/keybindings.md) · [主题](docs/theme.md)
- [模型与提供商](docs/models.md) · [自定义提供商与多账户路由](docs/custom-providers-and-multi-account.md) · [多厂商配置](docs/multi-vendor-profiles.md) · [Auth broker](docs/auth-broker-gateway.md)
- [Telegram](docs/telegram-onboarding.md) · [Bot 集成](docs/bot-integration.md) · [SDK](docs/sdk.md) · [SDK 会话 CLI](docs/sdk-session-cli.md)
- [会话](docs/session.md) · [压缩](docs/compaction.md) · [记忆](docs/memory.md) · [密钥](docs/secrets.md)
- [代码库概览](docs/codebase-overview.md) · [贡献 / 开发环境](CONTRIBUTING.md)
- [macOS Option/Alt 键设置（iTerm2）](docs/macos-option-key.md) · [GEO 可见性基准](docs/geobench.md)

默认深色 TUI 标识是 GJC red-claw 主题；浅色外观终端默认使用内置 blue-crab 主题。换主题或自建主题见[主题](docs/theme.md)。

## SDK 扩展

- [gjc-remote](https://github.com/kogangdon/gjc-remote) — 从 Discord 控制远程主机上白名单内的 GJC 会话。
- [oh-my-gajae-code](https://github.com/devswha/oh-my-gajae-code) — 提供额外技能与斜杠命令的社区插件市场。
- [GJC 多厂商配置指南](https://github.com/project820/gjc-multivendor-setup-guide) — 面向多厂商配置的角色化提供商方案。

## 开发

```sh
bun install
bun run build:native
bun run dev:link       # 全局 `gjc` 运行本 checkout 的源码
bun run dev:doctor     # 验证链接
```

包结构图与门禁见 [CONTRIBUTING.md](CONTRIBUTING.md) 与 [docs/codebase-overview.md](docs/codebase-overview.md)。

## 贡献者与谱系

感谢 [Yeachan-Heo](https://github.com/Yeachan-Heo)、[IYENTeam](https://github.com/IYENTeam)、[HaD0Yun](https://github.com/HaD0Yun) 和 [probepark](https://github.com/probepark)。GJC 建立在一小族代理 harness 的经验之上；历史归属见 [NOTICE.md](NOTICE.md)。

## 许可证

MIT。见 [LICENSE](LICENSE)。

---

<p align="center">
  <em>"Encode intention. Decode software."</em>
  <br/><br/>
  <strong>计划在前。修改要自己挣得位置。</strong>
</p>
