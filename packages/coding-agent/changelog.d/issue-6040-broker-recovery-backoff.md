### Fixed

- A long-running session whose `gjc` binary was replaced on disk no longer respawns the shared SDK broker over and over. Broker recovery now stops and asks for a session restart when this process's runtime image was replaced (same path, new file identity) or removed, and repeated recovery failures back off exponentially up to a cap instead of retrying every 30–60 seconds. Other clients sharing the broker are no longer disrupted by the churn (#6040).
