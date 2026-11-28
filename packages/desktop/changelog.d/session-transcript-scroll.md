### Fixed

- Remember each conversation's reading position, loaded message window and bottom-follow preference when switching conversations within the same app window. Preserve visible message anchors through older-message paging, streaming and layout changes without letting background updates or retired navigation callbacks move the reader.
- Keep scroll memory in a bounded, window-local 100-conversation LRU; deleted conversations, closed workspaces and evicted entries reopen at the bottom with the default message window.
