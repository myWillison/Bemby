# TODO

## Deferred bug fixes

From the system bug scan (2026-07-19). Low-risk items were already fixed; these
two were held back because the safe fix is more invasive and deserves its own
change plus a test. See GitHub issue #21 for the original crash that triggered
the scan.

- [ ] **`getLiveClient` concurrent double-connect leak** — `backend/src/tg/liveClient.ts:421`
  No in-flight guard between the map check and the `set`. Two concurrent calls
  for the same idle account both create and connect a `TelegramClient`; the
  second overwrites the first in `liveClients`, orphaning a live, connected
  session that runs its update loop until process restart.
  Fix: cache the in-flight connection promise per account so concurrent callers
  await the same client. Clear the cache entry if connect fails. Add a test.

- [ ] **embywatch ignores cancellation** — `backend/src/jobs/embywatch.ts:258`
  Unlike the other runners, `runEmbywatch` takes no `AbortSignal`. Cancelling a
  running embywatch job flips the log to cancelled, but the function keeps
  POSTing progress and marks the item watched for the full `watchDuration`.
  Fix: thread the `AbortSignal` through `runEmbywatch` and its `embyRequest`
  calls, and check it in the progress loop. Behaviour change — verify against
  the existing embywatch tests.
