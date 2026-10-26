
# Processing and Reprocessing Protocol

## 1. Purpose

This document defines reliable processing, retries, deliberate reprocessing, and concurrency protection for the AI Service Request Processing Agent.

The design uses PostgreSQL as the durable job queue. Job execution is at-least-once: the system may invoke the model more than once after failures, but it must prevent stale or duplicate database effects.

## 2. Core concepts

### Processing generation

A generation identifies a deliberate processing run for a case.

- The case stores `current_processing_generation`.
- A job stores its `generation`.
- A retry continues the same generation.
- Deliberate reprocessing creates a new generation.
- Only the current generation may commit processing results to the case.

### Case version

`case_version` supports optimistic concurrency. A transaction that updates a case must validate the version it expects and increment it when making a versioned case change.

### Lease and fencing token

A worker must claim a job before executing it.

- A lease identifies the worker's temporary ownership.
- A fencing token increases when ownership is superseded.
- A worker must validate ownership and its fencing token before committing results.
- An expired lease alone does not authorize an old worker to continue writing.
- A worker that has lost ownership must discard its result for case-update purposes.

## 3. Job statuses

| Status          | Meaning                                                                                  |
| --------------- | ---------------------------------------------------------------------------------------- |
| `PENDING`     | Waiting for its first eligible execution.                                                |
| `RUNNING`     | Claimed by a worker.                                                                     |
| `RETRY_WAIT`  | Waiting for the next eligible attempt after a retryable failure.                         |
| `SUCCEEDED`   | Processing and its database effects committed successfully.                              |
| `DEAD_LETTER` | Automatic processing has ended because of a permanent failure or exhausted retry policy. |

Allowed normal transitions:

- `PENDING` → `RUNNING`
- `RUNNING` → `SUCCEEDED`
- `RUNNING` → `RETRY_WAIT`
- `RUNNING` → `DEAD_LETTER`
- `RETRY_WAIT` → `RUNNING`
- `RETRY_WAIT` → `DEAD_LETTER`

Lease expiration and worker crashes are recovery conditions. They must be handled without allowing a superseded worker to commit stale results.

## 4. Initial intake

The intake operation must use one database transaction to:

1. Validate the normalized email input.
2. Attempt to create the case using the unique identity `(provider, mailbox_id, provider_message_id)`.
3. Create the case-created audit event.
4. Create the initial processing job for generation 1.
5. Commit the transaction.

The unique email identity is the authoritative duplicate-prevention mechanism. Concurrent delivery of the same message must not create a second case or a second initial job.

When the message already exists, intake returns the existing case according to the application contract and does not create a second initial job.

## 5. Claiming a job

A worker claims an eligible job in a short database transaction.

The claim procedure must:

1. Select an eligible job using row locking or an equivalent atomic claim mechanism.
2. Verify that the job is eligible and has not exhausted its attempt limit.
3. Verify that its generation matches the case's current generation.
4. Set the job to `RUNNING`.
5. Establish or renew lease ownership and update the fencing token according to the lease protocol.
6. Record the processing attempt.
7. Move the case from `RECEIVED` to `PROCESSING` when claiming initial work, if it is still in the expected state.
8. Commit the claim.

The exact SQL locking strategy will be selected during migration and repository implementation. Concurrent workers must not both obtain valid ownership of the same job.

## 6. Executing the model call

The model call occurs outside the database transaction.

The worker must:

- Pass only the data needed for classification.
- Treat the email body as untrusted input.
- Validate the model response against the strict output schema.
- Reject unsupported categories and invalid reason codes.
- Apply routing policy in application code rather than accepting a team assignment from the model.
- Never allow model output to resolve, close, or authorize a case.
- Record sanitized errors and relevant model-version metadata.

A model timeout or other retryable error does not automatically require a new generation.

## 7. Committing a successful result

After obtaining a valid result, the worker starts a new database transaction.

Before writing, it must verify:

- The job remains in an eligible owned state.
- The worker's lease and fencing token remain current.
- The job generation equals `cases.current_processing_generation`.
- The expected `case_version` is still valid.
- The classification and routing decision pass application validation.

Within that transaction, the system must persist the classification and routing decision, synchronize `cases.primary_category` with `case_categories`, update the case status, mark the job `SUCCEEDED`, finish the attempt, and append the relevant audit event.

These effects commit together. If any required operation fails, the transaction rolls back.

A worker whose generation, lease, fencing token, or case version is stale must not commit its result. It must not overwrite a newer human decision or newer generation.

## 8. Retry handling

A retryable failure follows this process:

1. Record the failed attempt and sanitized error code.
2. If attempts remain, set the job to `RETRY_WAIT` and calculate its next `available_at`.
3. Keep the case in `PROCESSING`.
4. Retry the same job generation when eligible.
5. If the retry limit is reached, move the job to `DEAD_LETTER` and trigger the operational escalation path.

Retry limits, backoff, jitter, and lease durations will be configurable. Exact operational values are intentionally deferred.

Permanent failures may go directly to `DEAD_LETTER`. Invalid model output must never be routed; the application may retry it within the configured bounds before escalating for recovery or review.

## 9. Deliberate reprocessing

### Authorization and scope

Deliberate reprocessing is allowed for cases in `NEEDS_REVIEW`.

Other cases require an explicitly authorized operational recovery action with a recorded reason. A normal retry must not be used as a substitute for this operation.

### Atomic transaction

The reprocessing operation must:

1. Authenticate and authorize the actor.
2. Lock the case row.
3. Validate the current case status, expected case version, and generation.
4. Check that no conflicting active job exists.
5. Increment `current_processing_generation`.
6. Increment `case_version`.
7. Create a new `PENDING` job for the new generation.
8. Record the reprocessing request and actor in an audit event.
9. For ordinary review reprocessing, transition the case to `PROCESSING`.
10. Commit the transaction.

If any required operation fails, the entire transaction rolls back. The generation cannot advance without its job and audit event being created in the same transaction.

### Historical records

Previous jobs, attempts, classification decisions, and audit events remain available. Reprocessing creates a new generation; it does not rewrite historical processing records.

The new generation becomes authoritative for subsequent case updates. An older worker may finish its external model request, but it cannot commit the result.

## 10. Lease recovery and dead-letter operations

Lease recovery must atomically determine that ownership is expired or otherwise invalid, supersede the previous ownership, and issue a new fencing token before another worker can safely proceed.

Operational recovery must be authorized and auditable. It must not silently reset attempt history or reuse an old fencing token.

A dead-letter job does not automatically change the case to `NEEDS_REVIEW`. Operational staff must decide whether to retry, reprocess, or escalate according to an explicit recovery procedure.

## 11. Required integration tests

Tests against real PostgreSQL must cover:

- Concurrent intake of the same email creates one case and one initial job.
- Two workers cannot both claim the same active job.
- A retry uses the same generation.
- Deliberate reprocessing creates a new generation and job atomically.
- A stale generation cannot update the case.
- A worker with an expired or superseded lease cannot commit results.
- A case-version conflict rejects stale writes.
- A failed decision transaction leaves no partial case, job, attempt, or audit updates.
- Job success and case decision cannot be committed independently.
- Dead-letter recovery preserves prior attempts and audit events.

## 12. Guarantees and limitations

The design provides durable job state, at-least-once execution, and protection against stale database effects. It does not guarantee exactly-once model API invocation. External calls may be repeated after a crash, timeout, or uncertain response.
