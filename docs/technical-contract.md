# Technical Contract

**Project:** AI Service Request Processing Agent
**Document status:** Design approved; implementation pending
**Contract version:** 1.0-draft

## 1. Normalized Email Input

The application accepts incoming service requests through a normalized email input contract. The email adapter is responsible for translating provider-specific messages into this format before registering a case.

### 1.1 Required fields

- `source`: required; must be `email`.
- `provider`: required; identifies the configured email provider.
- `mailboxId`: required; identifies the configured mailbox.
- `providerMessageId`: required; the provider-assigned message identifier.
- `threadId`: optional email thread identifier.
- `sender.email`: required sender email address.
- `subject`: required string; may be empty.
- `bodyText`: required string; may be empty, subject to configured size limits.
- `receivedAt`: required ISO 8601 timestamp containing a timezone.
- `attachmentMetadata`: required array containing attachment metadata only.

The MVP does not process attachment contents.

### 1.2 Validation and trust boundaries

The application must validate required fields, identifier formats, timestamp validity, and configured message-size limits.

The `provider` and `mailboxId` values must come from trusted integration configuration rather than arbitrary external input.

A syntactically valid sender email address does not prove the sender's identity. Email content, including subject, body, and sender-provided text, must be treated as untrusted input.

### 1.3 Idempotency

The unique identity of an incoming email is:

`(provider, mailboxId, providerMessageId)`

The database must enforce uniqueness for this combination. Application-level duplicate checks alone are insufficient because concurrent deliveries may race.

If the same provider message is delivered more than once, the application must return or identify the existing case without creating another case or initial processing job.

Messages with different provider message IDs that may represent the same request must be treated as potential duplicates when identified by the duplicate-detection mechanism. The MVP must not automatically merge cases based only on similarity.

### 1.4 Example normalized input

The following synthetic example illustrates the contract:

```json
{
  "source": "email",
  "provider": "example-provider",
  "mailboxId": "support-inbox",
  "providerMessageId": "msg-example-001",
  "threadId": "thread-example-001",
  "sender": {
    "email": "customer@example.com"
  },
  "subject": "Payment still pending",
  "bodyText": "My payment has been pending since yesterday.",
  "receivedAt": "2026-10-20T09:30:00+03:00",
  "attachmentMetadata": []
}
```

This example uses synthetic data and does not represent a real customer.

## 2. Classifier Output Contract

The classifier analyzes the normalized email and returns a structured proposal. Its output is not an authoritative routing decision and must not directly change case status, assign employees, or initiate customer communication.

### 2.1 Required fields

- `summary`: concise summary of the request.
- `categoryCandidates`: ordered array of candidate categories.
- `missingInformation`: array of approved field identifiers representing missing information.
- `isAmbiguous`: boolean indicating whether the classifier considers the classification ambiguous.
- `reviewReasons`: array of approved review-reason codes suggested by the classifier.
- `modelVersion`: identifier for the model version used, when available.

### 2.2 Approved categories

The initial category allowlist is:

- `payment_issue`
- `account_support`
- `technical_support`
- `complaint`
- `other`

The application must validate every returned category against this allowlist.

The candidate array must contain at least one valid category, contain no duplicates, and respect a configured maximum length.

Missing-information identifiers and review-reason codes must also belong to their respective application-defined allowlists.

### 2.3 Approved review-reason codes

The initial supported codes are:

- `AMBIGUOUS_CATEGORY`
- `UNKNOWN_CATEGORY`
- `MISSING_REQUIRED_INFORMATION`
- `INVALID_MODEL_OUTPUT`
- `SENSITIVE_REQUEST`

These codes are suggestions when returned by the classifier. The application determines which review reasons apply authoritatively.

### 2.4 Strict output validation

The application must validate classifier responses against a strict schema. Required fields, types, array limits, allowed values, and unexpected fields must be checked.

Invalid output must not be used to produce a normal routing decision. The system must follow the configured bounded-retry and recovery policy.

The model must not determine:

- Final primary or secondary categories.
- Assigned team or employee.
- Authoritative case status.
- Employee permissions or authorization.
- Whether a customer reply should be sent.
- Whether a case should be resolved or closed.

The MVP does not use a numeric model-confidence threshold. A model-reported confidence score alone must never authorize routing.

### 2.5 Example classifier response

```json
{
  "summary": "The customer reports that a payment remains pending.",
  "categoryCandidates": [
    "payment_issue",
    "account_support"
  ],
  "missingInformation": [],
  "isAmbiguous": false,
  "reviewReasons": [],
  "modelVersion": "example-model-version"
}
```

The application validates this response before applying routing policy.

## 3. Authoritative Routing Decision

The application converts validated classifier output into an authoritative routing decision using deterministic business rules and an explicitly versioned routing policy.

The classifier output is an input to the decision, not an instruction to execute.

### 3.1 Decision fields

The authoritative routing decision contains:

- `primaryCategory`: the single category selected by the application.
- `secondaryCategories`: other valid categories retained for context, excluding the primary category.
- `assignedTeam`: the team selected by the active routing policy.
- `reviewRequired`: whether human review is required before normal processing continues.
- `reviewReasons`: authoritative reasons requiring review.
- `missingInformation`: validated identifiers for information needed.
- `policyVersion`: version of the routing policy used.

The decision must be persisted with the case so the routing result can be explained and audited.

Employee assignment remains a human responsibility and is not determined by the classifier or routing policy.

### 3.2 Initial category-to-team mapping

| Category              | Team              |
| --------------------- | ----------------- |
| `payment_issue`     | Payment support   |
| `account_support`   | Account support   |
| `technical_support` | Technical support |
| `complaint`         | Customer care     |
| `other`             | General triage    |

The active policy must provide a valid team mapping for every approved category. A policy must not become active if any required category lacks a valid mapping.

### 3.3 Primary category selection

When multiple valid candidates are returned, the application applies the configured precedence order:

1. `payment_issue`
2. `account_support`
3. `technical_support`
4. `complaint`
5. `other`

The first category in the configured precedence order that appears in the validated candidate list becomes the primary category. Remaining valid candidates are retained as secondary categories in precedence order.

This order is provisional until confirmed by the business owner, particularly for requests involving complaints alongside other issues.

If the classifier returns only `other`, the application selects `other` and routes the case to General triage.

If the classifier returns no valid candidates or its output fails validation, the application must not invent a normal routing decision. It must follow the invalid-output and recovery rules.

### 3.4 Ambiguity and human review

A case requires human review when application checks or validated classification results indicate that the primary issue cannot be determined reliably, invalid output is received, or another approved review condition applies.

The application is authoritative for deciding whether a review reason applies. Model-suggested reasons must be validated against application rules.

If the primary issue remains ambiguous, the application must route the case to General triage, set the case status to `NEEDS_REVIEW`, and record at least one applicable review reason.

The case must not be treated as normally routed merely because the classifier returned a candidate category.

`other` is the fallback category for a valid classification that does not match a more specific supported category. It does not automatically mean that the output is invalid or that human review is required.

### 3.5 Missing information

Missing information is tracked separately from the review state.

The application validates missing-information identifiers against an approved allowlist and records the validated identifiers in the decision.

A case may have missing information without requiring classification review. Conversely, a case may require review even when no information is missing. Both conditions may apply simultaneously.

The agent must not contact the customer automatically. Employees remain responsible for requesting additional information and recording the outcome.

### 3.6 Policy safety and reproducibility

The routing decision must be reproducible from the validated classifier output, relevant application checks, and recorded policy version.

The MVP does not define a numeric confidence threshold. Any future threshold must be evaluated against labeled examples before adoption.

Routing-policy activation must validate category mappings, precedence configuration, and required settings. Activated policy versions are immutable; changes must create a new version.

The model cannot override application validation, routing policy, authorization rules, or human-review requirements. The agent cannot send customer replies or resolve or close cases.

## 4. Case Record and Status Lifecycle

Each incoming service request is represented by a persistent case record. The case record is the authoritative representation of the request's processing and business status.

### 4.1 Case record fields

A case record must include:

- `caseId`: unique application-generated identifier.
- `source`: source type; `email` in the MVP.
- `provider`: configured email provider.
- `mailboxId`: trusted mailbox identifier.
- `providerMessageId`: provider-assigned message identifier.
- `threadId`: optional email thread identifier.
- `senderEmail`: normalized sender email address.
- `subject`: email subject, which may be empty.
- `bodyText` or an approved content reference: request content or its stored location.
- `summary`: validated classifier-generated summary.
- `primaryCategory`: application-selected primary category.
- `secondaryCategories`: additional valid categories.
- `assignedTeam`: team selected by the active routing policy.
- `assignedEmployeeId`: optional employee assignment managed by authorized staff.
- `status`: current case lifecycle status.
- `reviewReasons`: authoritative reasons requiring human review.
- `missingInformation`: validated identifiers for information needed.
- `duplicateOfCaseId`: optional reference to a canonical case when a potential duplicate is identified and confirmed according to the duplicate-handling policy.
- `policyVersion`: routing-policy version used for the decision.
- `modelVersion`: model version used for classification, when available.
- `caseVersion`: version number used for optimistic concurrency control.
- `createdAt` and `updatedAt`: timestamps.
- `auditHistory`: audit events stored in the separate append-only audit structure.

Processing-job state, retry counters, leases, and individual attempt details are stored in separate records.

The final choice between storing email bodies directly in PostgreSQL and storing them elsewhere with a content reference remains open until retention and access controls are defined.

### 4.2 Case statuses

The MVP supports these case statuses:

- `RECEIVED`: the request has been registered but processing has not yet been completed.
- `PROCESSING`: classification and routing are in progress.
- `OPEN`: the case has a valid routing decision and is awaiting employee action.
- `IN_PROGRESS`: an employee is actively handling the case.
- `NEEDS_REVIEW`: human review is required before normal processing continues.
- `WAITING_FOR_CUSTOMER`: an employee is waiting for information from the customer.
- `RESOLVED`: an employee has recorded that the issue has been resolved.
- `CLOSED`: the case has been formally closed by an authorized employee.

Processing-job statuses are separate and defined in Section 5.

### 4.3 Status transition rules

All case status changes must go through the application's case lifecycle service. Each transition must be validated, authorized where applicable, and recorded in the audit history.

The following rules apply:

- A newly registered case begins in `RECEIVED`.
- A worker may move an eligible case from `RECEIVED` to `PROCESSING` when it successfully claims the corresponding job.
- A successfully processed case with a valid routing decision may move to `OPEN`.
- A case requiring human review must move to `NEEDS_REVIEW` and include at least one valid review reason.
- An authorized employee may move an `OPEN` case to `IN_PROGRESS`.
- An authorized employee may move a case to `WAITING_FOR_CUSTOMER` when additional information is needed.
- When the customer provides the requested information, an employee may return the case to `IN_PROGRESS`.
- An authorized employee may move a case to `RESOLVED` after recording the resolution.
- An authorized employee may move a `RESOLVED` case to `CLOSED`.
- The agent must not independently resolve or close a case.
- A failed or exhausted processing job must not silently leave a case appearing successfully processed. Recovery behavior must be explicit and auditable.

Any transition not explicitly permitted by lifecycle rules must be rejected. Concurrent updates must not overwrite newer case state; the application must use `caseVersion` or an equivalent concurrency-control mechanism.

### 4.4 Required invariants

The application must enforce these invariants:

- A case in `OPEN` must have a valid primary category and assigned team.
- A case in `NEEDS_REVIEW` must have at least one valid review reason.
- A case requiring review must not be treated as normally routed until the required review is completed.
- A model response cannot directly change a case status.
- Employee assignment and employee-driven lifecycle actions must be authorized.
- Every accepted status transition must produce a corresponding audit event in the same database transaction as the status change.
- Audit events must identify the actor type and, when applicable, the authorized employee or system component responsible.

### 4.5 Review completion and reopening

A human reviewer must explicitly record the outcome of a review before the case resumes normal processing. The review outcome and any resulting category, team, or status changes must be validated and audited.

The exact transition after review, and the policy for reopening resolved or closed cases, remain business rules requiring confirmation. The implementation must not invent implicit transitions or allow unrestricted reopening.

## 5. Processing Jobs, Retries, and Idempotency

The system must process incoming service requests reliably even when workers crash, external model providers fail, or messages are delivered more than once.

Processing jobs are persisted separately from case records. A case represents the business request; a job represents work the system needs to perform.

### 5.1 Job record

Each processing job must include:

- `jobId`: unique job identifier.
- `caseId`: associated case identifier.
- `jobType`: initially `CLASSIFY_CASE` or `RECOVER_CASE`.
- `status`: current processing-job status.
- `attemptCount`: number of attempts made.
- `availableAt`: earliest time the job may be claimed.
- `leaseOwner`: identifier of the worker holding the lease, when applicable.
- `leaseExpiresAt`: time after which an abandoned lease may be recovered.
- `lastErrorCode`: sanitized code describing the most recent failure, when applicable.
- `createdAt` and `updatedAt`: timestamps.

A database constraint must prevent multiple active jobs for the same case and job type where duplicate active work is not intended.

### 5.2 Job statuses

- `PENDING`: waiting to be processed.
- `RUNNING`: currently claimed by a worker.
- `RETRY_WAIT`: waiting until the next permitted retry time.
- `SUCCEEDED`: the job completed successfully.
- `DEAD_LETTER`: automatic processing has stopped after the configured retry policy was exhausted and operational or human recovery is required.

Job status is independent of case status. A case may require human review even when its classification job succeeded.

### 5.3 Atomic intake and idempotency

Registering an incoming email must be an atomic database operation.

Within one transaction, the application must:

1. Insert the new case.
2. Record the case-creation audit event.
3. Create the initial processing job.

The database must enforce uniqueness on `(provider, mailboxId, providerMessageId)`. Application-level checks alone are insufficient because concurrent deliveries may race.

If the same provider message is received again, the system must identify the existing case without creating a second case or initial job.

Messages with different provider message IDs that may represent the same customer request are potential duplicates. The MVP must flag such cases for human review when the duplicate-detection mechanism identifies them; it must not automatically merge cases solely on similarity.

### 5.4 Claiming jobs and worker leases

Workers must claim eligible jobs using an atomic database operation that prevents competing workers from claiming the same available job simultaneously.

The implementation should use row locking or an equivalent safe claim mechanism. A worker must record ownership and lease expiry when claiming a job.

Claiming a job, recording the processing attempt, and moving an eligible case to `PROCESSING` must occur in one database transaction.

The lease must be renewed or otherwise managed for long-running work. If a worker loses its lease, it must not commit a classification or routing decision using expired ownership.

The application must use a fencing mechanism, such as a monotonically increasing lease generation or equivalent ownership token, so a stale worker cannot overwrite a newer worker's result.

### 5.5 Attempt records

Each execution attempt must have a persistent attempt record associated with both the job and case.

An attempt record must capture:

- `attemptId`
- `jobId`
- `caseId`
- `attemptNumber`
- `status`
- `modelVersion`, when applicable
- Start and finish timestamps.
- Retryability classification.
- Sanitized error code or outcome metadata.

Attempt numbers must be allocated safely under concurrent execution. Sensitive email content, credentials, and unnecessary personal information must not be copied into error metadata.

### 5.6 Retry policy

Retries must be bounded and governed by explicit configuration. The policy must define the maximum number of attempts, retryable failure categories, backoff schedule, and any required jitter.

Transient failures, such as temporary provider unavailability or network errors, may be retried within the configured limit. Permanent failures, such as irrecoverably invalid configuration, must not be retried indefinitely.

Invalid model output must not be routed as if it were valid. The implementation may retry it within a specifically configured limit. If the limit is exhausted, the case must enter an explicit human-review or operational-recovery path.

When retrying, the job must enter `RETRY_WAIT` with an appropriate `availableAt` value. Once retries are exhausted, it must enter `DEAD_LETTER` and trigger the configured recovery or alerting mechanism.

The system must not discard the original case or silently report success when processing fails.

### 5.7 Decision persistence and crash recovery

The external model call must occur outside a database transaction so that a slow provider does not hold database locks open.

After receiving and validating the model output, the application must persist the routing decision in a transaction that:

1. Verifies current worker ownership and case state/version.
2. Saves the validated classification and authoritative routing decision.
3. Applies the permitted case status transition.
4. Completes the processing attempt.
5. Marks the job `SUCCEEDED`.
6. Appends the corresponding audit event.

These changes must commit together or roll back together.

If a worker crashes after the decision transaction commits but before it acknowledges completion outside the transaction, subsequent recovery must detect the committed outcome and avoid applying the decision or audit event twice.

If a worker crashes while holding a job lease, recovery must make the job eligible for safe processing again after the lease expires, subject to the retry policy and current case state.

### 5.8 Recovery and operational visibility

A recovery process must identify expired leases, interrupted jobs, and jobs that have exhausted their retries.

Recovery actions must be idempotent and auditable. Exhausted jobs must remain visible to authorized operators rather than disappearing from the queue.

The system must expose enough sanitized information to diagnose failures, including job ID, case ID, attempt number, error category, timestamps, and recovery status.

### 5.9 Delivery guarantees

The MVP aims for **at-least-once job execution with idempotent database effects**, not exactly-once execution of external model calls.

A model call may be repeated after a crash or timeout. The system must therefore prevent duplicate case creation, duplicate authoritative status transitions, and duplicate audit events for the same logical operation.

A unique audit `eventKey` or equivalent idempotency mechanism must protect important audit writes. The application must not assume that an external model call and a database transaction can be committed as one atomic operation.

## 6. Validation, Error Handling, and Versioning

The application must validate data at system boundaries, distinguish recoverable failures from permanent failures, and preserve enough version information to explain past decisions.

### 6.1 Boundary validation

The application must validate data before accepting it into the next processing stage.

Validation applies to:

- Normalized email input, including required fields, identifier formats, timestamp validity, and configured size limits.
- Classifier output, including required fields, field types, category allowlists, maximum array lengths, duplicate candidates, and approved reason and missing-information codes.
- Routing policies, including category mappings, team identifiers, precedence configuration, and required settings.
- Case lifecycle commands, including permitted transitions, actor authorization, required fields, and current case version.
- Processing jobs and attempt updates, including ownership, lease validity, retry eligibility, and allowed status transitions.

Invalid data must not silently pass to the next stage. Validation errors must produce an explicit, controlled outcome.

### 6.2 Error categories

The application must distinguish at least these failure categories:

- `INVALID_INPUT`: incoming message fails input validation.
- `DUPLICATE_INPUT`: provider message identity already exists; handled idempotently rather than treated as a new case.
- `INVALID_MODEL_OUTPUT`: classifier response fails the output contract.
- `MODEL_PROVIDER_ERROR`: model provider returns an error or is unavailable.
- `TRANSIENT_INFRASTRUCTURE_ERROR`: temporary database, network, or dependent-service failure.
- `PERMANENT_CONFIGURATION_ERROR`: required configuration is missing or invalid.
- `CONCURRENCY_CONFLICT`: case version, job ownership, or lease is no longer current.
- `POLICY_VALIDATION_ERROR`: routing policy cannot produce a valid decision.
- `UNAUTHORIZED_ACTION`: an actor attempts an action they are not permitted to perform.
- `UNEXPECTED_INTERNAL_ERROR`: an unclassified failure that must be recorded safely and investigated.

The implementation must explicitly map errors to retry, reject, review, or operational-recovery behavior. Error names alone do not determine retry behavior.

### 6.3 Error handling rules

- Invalid incoming messages must not create normally processable cases. The intake boundary must return or record a controlled validation outcome according to the email adapter's delivery and retry behavior.
- Duplicate provider messages must resolve to the existing case without creating duplicate initial work.
- Invalid classifier output must never be treated as a valid routing decision.
- Transient failures may be retried within configured limits.
- Permanent configuration failures must be visible to operators and must not be retried indefinitely without a configuration change or explicit recovery action.
- Concurrency conflicts must prevent stale writes. The application may reload current state and retry a safe operation where appropriate.
- Unauthorized lifecycle actions must be rejected and must not change case state.
- Unexpected failures must be logged with sanitized diagnostic context and must not expose credentials, full email bodies, or unnecessary personal information.
- Failures affecting a persisted case must leave the case and job in an explicit, recoverable state. The system must not falsely report successful processing.

### 6.4 Versioning

The system must record enough version information to reproduce or explain a routing decision.

At minimum, record:

- `policyVersion`: routing policy used for the decision.
- `modelVersion`: model identifier or version used for classification, when available.
- `contractVersion`: version of the normalized input and classifier output contracts used during processing.
- Application release or build identifier in operational diagnostics.
- Schema or migration version for database changes, managed by the migration mechanism.

Activated routing policies are immutable. Changes to category mappings, precedence, review rules, or relevant processing configuration must create a new policy version.

Contract changes must be introduced deliberately. If a new contract version changes field requirements or behavior, the application must explicitly support the relevant version or reject incompatible data with a controlled error. It must not silently interpret incompatible payloads as if they used the current contract.

### 6.5 Reprocessing and policy changes

A policy change must not silently rewrite historical decisions. Existing cases retain the policy version used for their recorded decision.

If a case is reprocessed, the system must record the reason for reprocessing and the model, contract, and policy versions used for the new attempt.

Before enabling reprocessing in production, the application must define whether reprocessing updates the existing case decision or creates a separate reviewable decision record.

Reprocessing must not bypass human-review requirements, duplicate protection, authorization, or audit logging.

### 6.6 Logging and sensitive data

Operational logs must support diagnosis using identifiers such as `caseId`, `jobId`, `attemptId`, request or correlation ID, error category, and timestamps.

Logs must not include secrets, access tokens, private keys, or full customer email content by default. Email addresses and other personal information must be minimized or masked where practical. Error metadata must be sanitized before persistence or logging.

The application must separate operational logs from the append-only case audit history. Logs support diagnosis; audit events provide a durable record of business actions and lifecycle transitions.

### 6.7 Contract and failure testing

Automated tests must cover:

- Invalid and oversized email input.
- Duplicate provider message delivery.
- Malformed classifier output and unsupported categories.
- Invalid routing policy configuration.
- Unauthorized and invalid case transitions.
- Stale case versions and expired worker leases.
- Retryable and permanent errors.
- Worker crashes and interrupted processing.
- Policy and contract version compatibility.
- Reprocessing behavior and audit-event idempotency.
- Sanitization of logs and error metadata.

Integration tests must exercise database constraints and transactional behavior against PostgreSQL, including relevant concurrency cases. Unit tests alone are insufficient to establish the reliability of database locking, uniqueness, and transaction guarantees.
