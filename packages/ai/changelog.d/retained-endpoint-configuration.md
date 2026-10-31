### Added
- Accept a supplied endpoint configuration in generic, simple and direct OpenAI, Azure, Anthropic/Foundry/ZCode and Vertex calls, including credential preflight, while credentials and ADC remain live/shared.

### Fixed
- Preserve caller fetch transports and OAuth credential type through simple dispatch, and keep explicit endpoints authoritative except canonical OpenAI OAuth routing.
- Exclude project-dotenv-only Vertex project/location values from credential preflight, matching the provider's trusted routing policy.
