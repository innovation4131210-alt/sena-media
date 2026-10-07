# Draft photo-only support

This patch is not a deployment and does not repair existing Buffer reservations.
The existing workflow runs on main pushes touching the runner/manifest. Review
and complete the migration before merging; do not dispatch it just to test.

## New manifest posts

Every new normal post requires `photo.url` (HTTPS, no redirects), `photo.sha256`
(SHA256 of exact file bytes), `photo.sourceImageId`, and `photo.qc` containing
`status: approved`, a genuine `approvedAt` timestamp and `evidence` reference.
Never convert an API verification date into a QC approval date. Provisional
candidates must remain outside executable posts until reviewed. Do not put
private review information or secrets into this public repository.

The source bytes are fetched, MIME/size/hash checked before intent persistence.
The Buffer image input and returned asset fields follow this repository's
existing `scripts/sena-threads-refill.mjs` conventions. No live API/schema test
has been performed by this patch. Pin source URLs to an immutable commit.

## Existing reservations and history

A remotely sent post remains historical, even if it was text-only. It is never
recreated or edited. Locally saved status alone is not evidence of publication.
An existing scheduled entry without an approved photo and matching recorded
asset IDs fails closed and requires separate reservation repair. This runner
intentionally does not add/replace photos on existing reservations.

Before activation:
1. Complete current QC and source/caption/usage checks for future photos.
2. Read the real account, existing IDs, dates and attachment state; repair the
   existing unpublished text-only reservations in place through an approved
   route. Do not delete/recreate them.
3. Read back their actual image asset IDs, channel, text and dueAt; only then
   record photoSourceImageId, photoSha256 and assetIds in existing state entries.
4. Populate genuinely approved photo metadata in the manifest. Do not falsely
   mark the current unmodified entries as approved or attached.
5. Review the diff and obtain deployment authorization before merging. A main
   merge touching these files will invoke the existing workflow. No workflow,
   schedule, credentials or unrelated runner is changed by this draft.

Creation records an intent before mutation, never automatically retries an
uncertain result, and requires the same created image asset IDs on readback.
If Buffer transforms asset IDs across reads, stop and reconcile rather than
loosening verification. Fetching an image is not by itself QC or proof of its
attachment. Redirecting URLs fail closed and need a durable direct source.

## Offline tests

`node --check scripts/mio-threads-pilot.mjs`
`node --test scripts/test-mio-threads-photo-policy.mjs scripts/test-mio-threads-runner.mjs`

Tests use synthetic media and mock all API requests. They do not read secrets or
send posts. This is a focused test pass, not live Buffer integration validation.
