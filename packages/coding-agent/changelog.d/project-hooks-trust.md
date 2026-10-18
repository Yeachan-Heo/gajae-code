### Fixed

- A repository `.gjc/hooks` pre or post module is no longer imported at session startup. Project-scope hook imports and inventories now identify those files as stored-only; user-agent hooks and explicit hook paths still load.
