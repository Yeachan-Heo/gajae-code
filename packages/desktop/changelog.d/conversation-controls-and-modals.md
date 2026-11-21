### Changed

- Removed Compact conversation from Conversation actions; use `/compact` in the composer. Every remaining action now has an icon.
- Split the delete confirmation into its question and an emphasized irreversible warning.
- Made modal backdrops translucent with blur. Backdrop dismissal requires the same primary pointer to press and release outside; dragging across the boundary leaves the dialog open.
- Session status refreshes automatically every second while open, without a refresh button.
- Review and Session work toolbar toggles visibly indicate the open card. Removed their duplicate header close buttons.
- `/clear` starts a new conversation in the same project and preserves the old conversation instead of clearing its history.
