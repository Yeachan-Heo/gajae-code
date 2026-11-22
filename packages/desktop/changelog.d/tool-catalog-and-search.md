### Added

- The Tools dialog (formerly Active tools) now has a search field and lists each tool with its label, a short description and tags for essential tools, tools the agent found by tool search, tools hidden until a tool search finds them and the MCP server a tool comes from, split into Active and Available sections with counts.
- An expanded tool-search card shows what the agent searched for, the tools the search turned on and the ranked matches instead of raw JSON, once the app receives the call's details.

### Changed

- The Tools dialog can now be opened while the agent is working, so you can watch tool searches turn tools on. Saving waits until the conversation's turn ends, because changing tools mid-turn would cancel a tool search that is turning tools on; the dialog says why. Save is also off until you change something, and the list refreshes after a save and when a new tool search finishes.
