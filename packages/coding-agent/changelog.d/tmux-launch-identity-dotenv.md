### Fixed

- tmux launch and `gjc session create` ignore project dotenv pins for the tmux session name, coordinator session id, GJC session id, and coordinator state-file path, and pass that filtered GJC session id into the child so the project file cannot reload it. An operator value the project does not declare is still used, and an omitted id stays unset.
