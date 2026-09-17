### Fixed

- The chat daemon no longer re-states an identical replay retention-gap concession on every re-attach. Endpoint churn on a live session rebuilds the attachment from sequence zero, so the host kept conceding the same evicted prefix — 2,467 byte-identical warnings for one bound in a single day, burying every other warning class. The first concession of each (session, generation, gap bound) still warns exactly as before, repeats drop to debug, and their running total is re-stated only at powers of ten. Frame recovery, delivery order, and cursor movement are unchanged (#5619).
