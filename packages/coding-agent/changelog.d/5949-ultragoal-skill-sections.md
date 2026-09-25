### Changed

- The bundled `ultragoal` skill prompt now inlines only the sections every run needs. The boundary completion cohort gate, terminal critic gate, and cross-repository succession contracts moved verbatim into on-demand skill fragments (`embedded:gjc/skill-fragments/ultragoal/<name>.md`), and short summaries in the prompt point to them. Each ultragoal `skill-prompt` injection drops from about 57k to about 33k characters (-41%) ([#5949](https://github.com/Yeachan-Heo/gajae-code/issues/5949)).
