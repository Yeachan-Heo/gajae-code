### Fixes

- Fix race condition where aborted ephemeral turns don't release IRC roster claims immediately, blocking retry attempts. When an ephemeral turn is aborted before the inner method's finally block executes, the outer method now immediately releases any held roster claim so subsequent turns can acquire it.
