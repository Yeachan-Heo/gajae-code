### Fixed

- Prevented deferred startup profile recovery from replacing newer model or role selections during credential refresh or settings flush; rejected model selections no longer cancel recovery, and canceled recovery restores session-owned alias and fallback state (#6380).
