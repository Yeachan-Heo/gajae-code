### Fixed

- The utility quarantine contract and the SDK operation inventory now record `/fork` as a restored first-class built-in, matching the shipped `/fork` command from #5515. The quarantine still rejects a headless or standalone utility surface for it, and the inventory maps it to `session.fork` with every chat, MCP, ACP, and daemon-CLI adapter marked prohibited.
