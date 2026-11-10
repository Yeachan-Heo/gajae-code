### Fixed

- With two or more unpinned accounts for one provider (for example two Anthropic OAuth logins), models known only from discovery (such as a Claude model not yet in the bundled catalog) no longer vanish from the first `/model` open after a startup refresh and reappear on the next. Offline reloads peeked the next account in the rotation, which made the cached catalog look like another account's; they now keep the account behind the published discovery while it is still stored and unchanged. Online refreshes keep rotating.
