import { APP_NAME, CONFIG_DIR_NAME } from "@gajae-code/utils/dirs";

export function getExtraHelpText(): string {
	return `Environment Variables:
  # Core Providers
  ANTHROPIC_API_KEY          - Anthropic Claude models
  ANTHROPIC_OAUTH_TOKEN      - Anthropic OAuth (takes precedence over API key)
  CLAUDE_CODE_USE_FOUNDRY    - Enable Anthropic Foundry mode (uses Foundry endpoint + mTLS)
  FOUNDRY_BASE_URL           - Anthropic Foundry base URL (e.g., https://<foundry-host>)
  ANTHROPIC_FOUNDRY_API_KEY  - Anthropic token used as Authorization: Bearer <token> in Foundry mode
  ANTHROPIC_CUSTOM_HEADERS   - Extra Foundry headers (e.g., "user-id: USERNAME")
  CLAUDE_CODE_CLIENT_CERT    - Client certificate (PEM path or inline PEM) for mTLS
  CLAUDE_CODE_CLIENT_KEY     - Client private key (PEM path or inline PEM) for mTLS
  NODE_EXTRA_CA_CERTS        - CA bundle path (or inline PEM) for server certificate validation
  OPENAI_API_KEY             - OpenAI GPT models
  GEMINI_API_KEY             - Google Gemini models
  GITHUB_TOKEN               - GitHub Copilot (or GH_TOKEN, COPILOT_GITHUB_TOKEN)

  # Additional LLM Providers
  AZURE_OPENAI_API_KEY       - Azure OpenAI models
  GROQ_API_KEY               - Groq models
  CEREBRAS_API_KEY           - Cerebras models
  XAI_API_KEY                - xAI Grok models
  OPENROUTER_API_KEY         - OpenRouter aggregated models
  KILO_API_KEY               - Kilo Gateway models
  MISTRAL_API_KEY            - Mistral models
  ZAI_API_KEY                - z.ai models (ZhipuAI/GLM)
  MINIMAX_API_KEY            - MiniMax models
  OPENCODE_API_KEY           - OpenCode Zen/OpenCode Go models
  CURSOR_ACCESS_TOKEN        - Cursor AI models
  AI_GATEWAY_API_KEY         - Vercel AI Gateway

  # Cloud Providers
  AWS_PROFILE                - AWS Bedrock (or AWS_ACCESS_KEY_ID + AWS_SECRET_ACCESS_KEY)
  GOOGLE_CLOUD_PROJECT       - Google Vertex AI (requires GOOGLE_CLOUD_LOCATION)
  GOOGLE_APPLICATION_CREDENTIALS - Service account for Vertex AI

  # Search & Tools
  EXA_API_KEY                - Exa web search
  BRAVE_API_KEY              - Brave web search
  PERPLEXITY_API_KEY         - Perplexity web search (API)
  PERPLEXITY_COOKIES         - Perplexity web search (session cookie)
  TAVILY_API_KEY             - Tavily web search
  ANTHROPIC_SEARCH_API_KEY   - Anthropic search provider

  # Configuration
  GJC_CODING_AGENT_DIR       - Session storage directory (default: ~/${CONFIG_DIR_NAME}/agent)
  GJC_PACKAGE_DIR            - Override package directory (for Nix/Guix store paths)
  GJC_SMOL_MODEL              - Override smol/fast model (see --smol)
  GJC_SLOW_MODEL              - Override slow/reasoning model (see --slow)
  GJC_PLAN_MODEL              - Override planning model (see --plan)
  GJC_NO_PTY                  - Disable PTY-based interactive bash execution
  --tmux                       - Launch interactive startup inside a new tmux session
  gjc session                  - List, inspect, create, remove, or attach tagged GJC-managed tmux sessions
  GJC_LAUNCH_POLICY           - Launch policy for --tmux startup: tmux or direct
  GJC_TMUX_SESSION            - Explicit tmux session name override for --tmux startup

  For complete environment variable reference, see:
  docs/environment-variables.md
Available Tools (default-enabled unless noted):
  read          - Read file contents
  bash          - Execute bash commands
  edit          - Edit files with find/replace
  write         - Write files (creates/overwrites)
  grep          - Search file contents
  find          - Find files by glob pattern
  lsp           - Language server protocol (code intelligence)
  python        - Execute Python code (requires: ${APP_NAME} setup python)
  notebook      - Edit Jupyter notebooks
  inspect_image - Analyze images with a vision model
  browser       - Browser automation (Puppeteer)
  task          - Launch sub-agents for parallel tasks
  todo_write    - Manage todo/task lists
  web_search    - Search the web
  ask           - Ask user questions (interactive mode only)

Useful Commands:
  ${APP_NAME} --list-models        - List configured provider models
  ${APP_NAME} --help               - Show this help`;
}
