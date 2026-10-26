
# Database Schema Specification

## 1. Purpose and status

This document defines the proposed relational schema for the AI Service Request Processing Agent.

**Status:** Design review — not yet approved for SQL implementation.

The database uses PostgreSQL as the durable store for cases, processing jobs, attempts, routing policies, and audit events. The application is authoritative for business rules, classification validation, authorization, and case transitions.

The schema must support idempotent intake, versioned routing, human review, generation-fenced processing, retries, and auditable decisions.

Related design documents:

- `docs/architecture/case-lifecycle.md`
- `docs/architecture/reprocessing-protocol.md`
- `docs/technical-contract.md`
- `docs/architecture/component-design.md`

## 2. Confirmed design decisions

- Email is the only intake source in the MVP.
- The original normalized email body is stored in PostgreSQL.
- Attachments are represented by metadata only; attachment content is not processed.
- Email identity is unique by `(provider, mailbox_id, provider_message_id)`.
- Routing policies and category-to-team rules use normalized relational tables.
- Activated routing-policy versions are immutable.
- `cases.primary_category` and `case_categories` both store the primary-category decision; the application must maintain consistency transactionally.
- Reprocessing creates a new generation. Retries reuse the current generation.
- Only the current generation may commit case updates.
- A lease and fencing token protect worker ownership; `case_version` supports optimistic concurrency.
- Review completion creates a new reviewed decision and preserves previous decisions in audit history.
- Email retention is configurable, but the exact duration and deletion workflow remain undecided.
- Employee identity is supplied by an external identity provider; no local employee table is required.
- Audit history is append-only for the ordinary application database role. Corrections are new events, not edits to historical events.
- `CLOSED` is terminal for the MVP. Further work requires a linked new case.
- Model output cannot choose authoritative team assignments or change case status to `RESOLVED` or `CLOSED`.

## 3. Migration plan

### Migration 001 — Routing policies

Tables:

- `routing_policies`
- `routing_policy_rules`

`routing_policies` stores version metadata, lifecycle status, creation metadata, and activation time.

`routing_policy_rules` stores the category-to-team mapping and precedence for a particular policy version.

Required constraints:

- Unique policy version.
- At most one active policy.
- Unique `(policy_id, category)`.
- Unique `(policy_id, precedence)`.
- Every activated policy maps all five supported categories.
- An activated policy cannot be edited in place.
- Case decisions reference the exact policy record used.

The final category-precedence order remains provisional pending business confirmation.

### Migration 002 — Cases and categories

Tables:

- `cases`
- `case_categories`

`cases` stores the normalized email identity and content, case lifecycle status, selected primary category, assigned team, review reasons, missing-information indicators, duplicate reference, policy/model references, current processing generation, optimistic concurrency version, and timestamps.

`case_categories` stores the primary and secondary categories for a case.

Required constraints:

- Unique `(provider, mailbox_id, provider_message_id)`.
- Foreign keys for duplicate references and policy references.
- Positive `case_version` and `current_processing_generation`.
- Controlled case-status and category values.
- At most one primary category per case, enforced by a partial unique index.
- A successfully classified case must have exactly one primary category; enforce this across the classification transaction.
- `cases.primary_category` must match the primary `case_categories` row.
- `OPEN` requires a valid primary category and assigned team.
- `NEEDS_REVIEW` requires at least one valid review reason.
- A case cannot reference itself as a duplicate.

The schema and application must distinguish missing information from a mandatory human-review condition. Both may be present on the same case.

### Migration 003 — Processing jobs

Table:

- `processing_jobs`

Stores the case reference, generation, job type, job status, attempt counters, retry scheduling, lease ownership, fencing token, last sanitized error code, and timestamps.

Required constraints:

- Unique `(case_id, generation)`.
- Positive generation and maximum-attempt count.
- Nonnegative attempt count.
- At most one active job per case using a partial unique index covering `PENDING`, `RUNNING`, and `RETRY_WAIT`.
- A running job must satisfy the agreed lease-state invariants.
- A job's generation must match the case's current generation before its result can update the case.

### Migration 004 — Processing attempts

Table:

- `processing_attempts`

Stores individual attempts, including attempt number, start and finish times, outcome, sanitized error code, model version, and optional duration.

Required constraints:

- Unique `(job_id, attempt_number)`.
- Positive attempt number.
- Nonnegative duration when present.
- Finish time cannot precede start time.
- Historical attempts remain available after retries and deliberate reprocessing.

A crashed worker may leave an unfinished attempt. Recovery must handle it without losing history or permitting stale writes.

### Migration 005 — Audit events

Table:

- `case_audit_events`

Stores case lifecycle changes, processing decisions, review outcomes, employee actions, reprocessing requests, and relevant recovery events.

Proposed fields:

- `id`
- `case_id`
- `event_key`
- `event_type`
- `actor_type`
- `actor_id`
- `occurred_at`
- `payload`

Required constraints and permissions:

- Unique `(case_id, event_key)` for idempotent audit effects.
- A foreign key to the case.
- Structured, versioned JSONB payloads.
- Ordinary application role can insert and read according to its permissions, but cannot update or delete audit rows.
- Case updates and corresponding audit events commit in the same transaction.
- Corrections are appended as new events.
- Audit payloads avoid unnecessary duplication of sensitive email content.

The migration/owner role must be separate from the ordinary runtime role. The runtime role must not own the audit table.

## 4. Case and job status contracts

The authoritative case transitions and their invariants are specified in `docs/architecture/case-lifecycle.md`.

The authoritative job-claim, retry, generation, fencing, and recovery protocols are specified in `docs/architecture/reprocessing-protocol.md`.

These documents are part of the database contract. Migration constraints and application services must not contradict them.

A retryable processing failure leaves the case in `PROCESSING` while its job is in `RETRY_WAIT`. A dead-letter job does not automatically move the case into `NEEDS_REVIEW`.

## 5. Transaction requirements

The implementation must preserve these atomic operations:

1. **Intake:** create the case, case-created audit event, and initial job together.
2. **Job claim:** claim ownership and record the attempt consistently.
3. **Successful processing:** persist classification, category rows, routing result, case state, job success, attempt outcome, and audit event together.
4. **Reprocessing:** advance the generation, create the new job, and record the request together.
5. **Human review:** persist the reviewed decision, resulting case state, and audit event together.
6. **Employee status transition:** persist the status change and audit event together.

Model calls must occur outside database transactions. Database effects must be protected by generation, lease/fencing, and case-version validation.

## 6. Retention and privacy

The MVP stores the original normalized email body. This content may contain personal or confidential information.

The design must support a configurable retention policy, but the exact retention duration and deletion workflow have not been approved.

Before production, the retention policy must define:

- Which email fields are retained and for how long.
- Whether deletion, redaction, or another treatment applies to each field.
- How deletion is recorded.
- Which audit metadata must remain.
- How retention interacts with legal, security, or operational requirements.

Do not assume that deleting a case also deletes its audit history. Retention and audit requirements must be reconciled before production deployment.

## 7. Indexing expectations

The final migration should include indexes supporting:

- Duplicate intake lookup by the unique email identity.
- Case retrieval by status, assigned team, and creation time.
- Cases requiring human review.
- Eligible processing-job selection by status and availability time.
- Processing-attempt history by job and attempt number.
- Audit history by case and event time.

Indexes should be justified by expected queries and tested where practical; avoid adding redundant indexes without a clear access pattern.

## 8. Required database tests

Integration tests against real PostgreSQL must verify:

- Unique email identity under concurrent intake.
- Unique policy rules and only one active policy.
- Required policy mappings before activation.
- Primary-category uniqueness and consistency.
- Status invariants.
- One active job per case.
- Generation and case-version fencing.
- Lease recovery and stale-worker rejection.
- Transaction rollback for failed case/job/audit operations.
- Preservation of historical attempts and decisions.
- Runtime-role inability to update or delete audit events.

Mocks alone are insufficient for testing database constraints, locking, isolation, or concurrent intake behavior.

## 9. Unresolved decisions

The following decisions remain open and must not be silently replaced with assumptions:

| Decision                                          | Current state                       | Impact                                                              |
| ------------------------------------------------- | ----------------------------------- | ------------------------------------------------------------------- |
| Final category precedence                         | Provisional                         | Required for final production routing policy and seed data          |
| Review completion fields and outcomes             | Partially defined                   | Must be finalized before implementing the review workflow           |
| Dead-letter recovery authorization and escalation | Protocol defined at a high level    | Detailed operational permissions and actions remain to be specified |
| Email retention duration and deletion workflow    | Deferred                            | Required before production use                                      |
| Customer reply correlation to an existing case    | Not finalized                       | Required before automatic email-reply handling is introduced        |
| Retry limits, backoff, lease duration, heartbeat  | Configurable, exact values deferred | Required for operational configuration and load testing             |

These open decisions do not all block drafting the schema structure. The category-to-team tables can be implemented without finalizing the precedence order, provided no unapproved production order is seeded as authoritative.

## 10. Approval gate

Before writing SQL:

1. Review the case lifecycle and reprocessing documents.
2. Confirm the final schema decisions and the unresolved items that can safely be deferred.
3. Ensure table constraints, transaction requirements, and integration tests align with the technical contract.
4. Approve Migration 001's table and constraint specification.

After approval, implement one migration at a time, add its tests, review the result, and commit it before proceeding to the next migration.
