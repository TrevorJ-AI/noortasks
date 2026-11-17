# Offline sync and merge rules

The engine writes locally in IndexedDB, queues ordered operations, pushes them,
then pulls the server checkpoint delta. `SyncTransport` supplies `sendRun` and
`pullDelta`; `HttpTransport` keeps the existing HTTP paths and auxiliary reads
(`afterPull`). Tests also run the engine against an in-memory SQLite transport.
Identity checks remain on the HTTP path before any outbox push.

New entity updates contain their identity/routing fields, only changed fields,
and `_sync: {baseModifiedTime, baseEtag, unset}`. The local `_syncBase` shadow
records the last fetched row with acknowledged writes applied. It never travels
as entity data. An upgrade establishes shadows with one full pull; pre-upgrade
queued writes remain compatible whole-object updates. Queued payloads are frozen,
coalesced before sending, and kept separate from writes already in flight.
Acknowledged changes update the shadow atomically with removal from the outbox,
including when the subsequent pull fails.

For new-style updates, the server merges supplied fields into the stored
object. Omitted fields, including unknown fields, survive. Legacy whole-object
updates still clear omitted known wire fields; omitted unknown fields survive.
`unset` explicitly removes a field; `null` is a value. Identity/routing removals are refused. Nested objects and arrays count
as one field. If two clients edit different fields, both survive. If they edit
the same field, the last push received by the server wins for that field only,
regardless of device clock. Base time/etag describe the client's starting point;
a stale base does not reject unrelated edits. Task activity records the actual
before/after change, including the winning same-field edit.

This covers tasks, lists, folders, tags, columns, filters, habits, habit sections,
check-ins, habit logs, focus records, timers and countdowns. Preferences retain
their existing key/section merge behavior. Server-owned fields and normalization
still apply. Shared-list requests pass the existing membership, write-permission
and assignee checks before merging. Members cannot change another owner's list
metadata or columns.

Deletion wins over a new-style stale update: deleted/missing rows are never
re-created by retrying a partial update as an add. Restoring trash is explicit.
Legacy whole-object writes and backup imports remain supported, with their
existing add/upsert retries. A legacy writer supplies all its fields, so it can
still replace values it did not consciously edit.

The app requests `navigator.storage.persist()` without blocking sync; the
browser can decline. Last successful sync and outbox creation times survive reloads.
The main view shows last-sync age and an alert when any unsynced operation is
older than 24 hours, with a sync action. Coalescing preserves the first queued
time. Old operations without timestamps use their last successful sync time
(or first upgrade time if never synced), recorded once. Storage persistence reduces eviction risk; it is not a server backup.
