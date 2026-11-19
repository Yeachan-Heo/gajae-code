### Fixes

- Fix SDK prompt abort during admission leaving durable row as "accepted" with turn=uncertain. When aborting a prompt while it's being admitted (after acceptance but before execution starts), the row is now properly settled as "stopped" instead of remaining uncertain.
