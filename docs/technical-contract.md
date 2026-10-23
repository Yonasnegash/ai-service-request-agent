
## Section 1 — Normalized Email Input

### Proposed Contract

| Field              | Required? | Purpose                                                                    |
| ------------------ | --------- | -------------------------------------------------------------------------- |
| source             | Yes       | Identifies the source as email.                                            |
| provider           | Yes       | Identifies the configured email provider.                                  |
| mailboxId          | Yes       | Identifies the mailbox that received the message.                          |
| providerMessageId  | Yes       | Stable provider identifier used for duplicate detection.                   |
| threadId           | No        | Identifies the email conversation, if available.                           |
| sender.email       | Yes       | Sender address from the received message.                                  |
| subject            | Yes       | Email subject; may be an empty string if absent.                           |
| bodyText           | Yes       | Normalized plain-text content; may be empty but must be bounded in size.   |
| receivedAt         | Yes       | Message receipt timestamp in ISO 8601 format.                              |
| attachmentMetadata | Yes       | Array describing attachments without processing their contents in the MVP. |

---

### Validation and Trust Rules

- **Provider and mailbox identity**: must come from trusted integration configuration, not from arbitrary email content or an untrusted public request.
- **Message identity**: provider, mailboxId, and providerMessageId together identify a message for idempotency.
- **Sender**: validate the email address format, but treat it as unverified identity unless the integration provides separate verification.
- **Subject and body**: treat all content as untrusted input. Bound the accepted sizes and normalize the text before classification.
- **Timestamp**: require a valid ISO 8601 timestamp with timezone information.
- **Attachments**: accept metadata only; do not download or process attachment contents in the MVP.
- **Size limits**: configure explicit maximums for message body, subject, and attachment metadata. We'll choose concrete values before implementation.
- **Duplicate delivery**: a repeated message identity must return the existing case and must not create another initial processing job. Enforce this with a PostgreSQL uniqueness constraint, not only an application-level check.

---

### Example Normalized Message

> This is illustrative synthetic data, not a real customer email.

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
  "subject": "Payment status inquiry",
  "bodyText": "I made a payment but the status is still pending.",
  "receivedAt": "2026-10-23T09:30:00Z",
  "attachmentMetadata": []
}
```


## Section 2 — Classifier Output

### 2.1 Proposed Output Contract

| Field              | Type    | Purpose                                                                |
| ------------------ | ------- | ---------------------------------------------------------------------- |
| summary            | String  | Concise summary of the service request.                                |
| categoryCandidates | Array   | Proposed categories from the approved allowlist, ordered by relevance. |
| missingInformation | Array   | Approved field identifiers for information that appears to be missing. |
| isAmbiguous        | Boolean | Indicates that the primary issue cannot be determined reliably.        |
| reviewReasons      | Array   | Proposed reasons why a human may need to review the case.              |
| modelVersion       | String  | Identifies the model version used, when available.                     |

#### Initial Category Allowlist

- `payment_issue`
- `account_support`
- `technical_support`
- `complaint`
- `other`

> The application—not the model—will decide the authoritative primary category and destination team.

---

### 2.2 Validation Rules

- The response must conform to a strict schema. Reject unexpected fields or invalid types.
- Category values must belong to the approved allowlist.
- `categoryCandidates` must not be empty, must not contain duplicates, and must have a configured maximum length.
- `missingInformation` must contain only approved field identifiers.
- `reviewReasons` must contain only approved reason codes.
- The application must not trust model-generated team names, status values, permissions, or instructions.
- If the output is invalid, the application must not route the case using that output. A bounded retry may be attempted; if it still fails, the case must follow the configured human-review or operational recovery path.
- Model confidence, if introduced later, must not independently authorize automatic routing.
- For the MVP, do not include a numeric confidence score in this contract. We haven’t selected a model or established calibration, so adding a score now could imply reliability we haven’t demonstrated.

---

### 2.3 Proposed Review Reason Codes

Use stable codes rather than relying on free-form explanations for application decisions.

| Code                         | Meaning                                                         |
| ---------------------------- | --------------------------------------------------------------- |
| AMBIGUOUS_CATEGORY           | The primary issue cannot be determined reliably.                |
| UNKNOWN_CATEGORY             | The request does not fit the supported categories.              |
| MISSING_REQUIRED_INFORMATION | Information required for the next step appears to be absent.    |
| INVALID_MODEL_OUTPUT         | The model response failed schema or contract validation.        |
| SENSITIVE_REQUEST            | The request may require additional human handling under policy. |

> These codes are proposed for the contract. The policy engine remains responsible for deciding which reasons actually apply. The model may suggest a reason, but its suggestion is not authoritative.

---

### 2.4

 Example Classifier Response

> This is synthetic illustrative data.

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

## 3. Authoritative Routing Decision

The application converts validated classifier output into an authoritative routing decision using deterministic business rules and an explicitly versioned routing policy.

The classifier output is an input to this decision, not an instruction to execute. The application must not accept a model-generated team assignment, case status, employee assignment, or action as authoritative.

### 3.1 Decision fields

The routing decision contains:

- `primaryCategory`: the single category selected by the application.
- `secondaryCategories`: other valid categories retained for context, excluding the primary category.
- `assignedTeam`: the team selected by the active routing policy.
- `reviewRequired`: whether a human must review the case before normal processing continues.
- `reviewReasons`: the authoritative list of reasons requiring review.
- `missingInformation`: validated field identifiers indicating information needed for follow-up.
- `policyVersion`: the version of the routing policy used to make the decision.

The application generates these fields after validating classifier output and applying the routing policy. The decision must be persisted with the case so the routing result can be explained and audited later.

Employee assignment remains a human responsibility and is not determined by the classifier or routing policy.

### 3.2 Approved categories and team mapping

The initial category allowlist and default team mapping are:

| Category              | Team              |
| --------------------- | ----------------- |
| `payment_issue`     | Payment support   |
| `account_support`   | Account support   |
| `technical_support` | Technical support |
| `complaint`         | Customer care     |
| `other`             | General triage    |

The active routing policy must define a valid team mapping for every approved category. A policy must not become active if any category lacks a valid mapping.

### 3.3 Primary category selection

When the classifier returns multiple valid category candidates, the application applies the configured precedence order:

1. `payment_issue`
2. `account_support`
3. `technical_support`
4. `complaint`
5. `other`

The first category in the configured precedence order that appears in the validated candidate list becomes the primary category. Remaining valid candidates are retained as secondary categories in precedence order.

The precedence order is a policy decision and must be explicitly configured and versioned. The initial order above is provisional until confirmed by the business owner, particularly for cases involving complaints alongside other issues.

If the classifier returns only `other`, the primary category is `other` and the case is routed to General triage.

If the classifier returns no valid category candidates, or its output fails validation, the application must not invent a normal routing decision. It must follow the invalid-output handling and recovery rules defined in this contract.

### 3.4 Ambiguity and human review

A case requires human review when the validated result or application checks indicate that the primary issue cannot be determined reliably, the output is invalid, or an approved review condition applies.

At minimum, the application must support these review reasons:

- `AMBIGUOUS_CATEGORY`
- `UNKNOWN_CATEGORY`
- `MISSING_REQUIRED_INFORMATION`
- `INVALID_MODEL_OUTPUT`
- `SENSITIVE_REQUEST`

The application is authoritative for whether a review reason applies. A model-suggested review reason is only a signal and must be validated against application rules.

If the primary category remains ambiguous, the application must route the case to General triage and set its case status to `NEEDS_REVIEW`. It must record an applicable review reason. The case must not be treated as normally routed merely because the classifier returned a candidate category.

`other` is the fallback category for a valid classification that does not match a more specific supported category. It is not, by itself, proof that the classifier output is invalid or that human review is required. The active policy may define additional review conditions for unsupported or uncertain requests.

### 3.5 Missing information

Missing information is tracked separately from the review state.

The application validates all missing-information identifiers against an approved allowlist. It records the validated identifiers in the routing decision.

A case may have missing information without requiring classification review. Conversely, a case may require review even when no information is missing. Both conditions may apply to the same case.

The agent must not contact the customer automatically. Employees remain responsible for requesting additional information and recording the outcome.

### 3.6 Policy and decision safety

The routing decision must be reproducible from the validated classifier output, the relevant application checks, and the recorded policy version.

The application must not use a model-reported confidence score alone to authorize routing. The MVP does not define a numeric confidence threshold; any future threshold must be evaluated against labeled examples before adoption.

Routing-policy activation must validate required categories, team mappings, precedence configuration, and other required settings. Activated policy versions must be immutable. A change creates a new version.

The model cannot override application validation, routing policy, authorization rules, or human-review requirements. The agent cannot send customer replies or resolve or close cases.


## 4. Case Record and Status Lifecycle

Each incoming service request is represented by a persistent case record. The case record is the authoritative representation of the request's processing and business status.

### 4.1 Case record

A case record must include:

- `caseId`: unique application-generated identifier.
- `source`: source type; `email` in the MVP.
- `provider`: configured email provider.
- `mailboxId`: trusted mailbox identifier.
- `providerMessageId`: provider-assigned message identifier.
- `threadId`: optional email thread identifier.
- `senderEmail`: normalized sender email address.
- `subject`: email subject, which may be empty.
- `bodyText` or an approved content reference: the request content or a reference to its stored location.
- `summary`: validated classifier-generated summary.
- `primaryCategory`: application-selected primary category.
- `secondaryCategories`: additional valid categories.
- `assignedTeam`: team selected by the active routing policy.
- `assignedEmployeeId`: optional employee assignment, managed by authorized staff.
- `status`: current case lifecycle status.
- `reviewReasons`: authoritative reasons requiring human review.
- `missingInformation`: validated identifiers for information needed.
- `duplicateOfCaseId`: optional reference to a canonical case when a potential duplicate is identified and confirmed according to the duplicate-handling policy.
- `policyVersion`: routing-policy version used for the decision.
- `modelVersion`: model version used for classification, when available.
- `caseVersion`: version number used for optimistic concurrency control.
- `createdAt` and `updatedAt`: timestamps.
- `auditHistory`: the case's audit events, stored in the separate append-only audit record structure.

Processing-job state, retry counters, leases, and individual attempt details are stored in their own records rather than being treated as the case's business status.

### 4.2 Case statuses

The MVP supports the following case statuses:

- `RECEIVED`: the request has been registered but processing has not yet been completed.
- `PROCESSING`: classification and routing are in progress.
- `OPEN`: the case has a valid routing decision and is awaiting employee action.
- `IN_PROGRESS`: an employee is actively handling the case.
- `NEEDS_REVIEW`: human review is required before normal processing continues.
- `WAITING_FOR_CUSTOMER`: an employee is waiting for information from the customer.
- `RESOLVED`: the employee has recorded that the issue has been resolved.
- `CLOSED`: the case has been formally closed by an authorized employee.

Processing-job statuses are separate and are defined in Section 5.

### 4.3 Status transition rules

All case status changes must go through the application’s case lifecycle service. Each transition must be validated, authorized where applicable, and recorded in the audit history.

The following rules apply:

- A newly registered case begins in `RECEIVED`.
- A worker may move an eligible case from `RECEIVED` to `PROCESSING` when it successfully claims the corresponding job.
- A successfully processed case with a valid routing decision may move to `OPEN`.
- A case requiring human review must move to `NEEDS_REVIEW` and include at least one valid review reason.
- An authorized employee may move an `OPEN` case to `IN_PROGRESS`.
- An authorized employee may move a case to `WAITING_FOR_CUSTOMER` when additional information is needed from the customer.
- When the customer provides the requested information, an employee may return the case to `IN_PROGRESS`.
- An authorized employee may move a case to `RESOLVED` after recording the resolution.
- An authorized employee may move a `RESOLVED` case to `CLOSED`.
- The agent must not independently resolve or close a case.
- A failed or exhausted processing job must not silently leave a case appearing successfully processed. Recovery behavior must be explicit and auditable.

Any transition not explicitly permitted by the lifecycle rules must be rejected. Concurrent updates must not overwrite newer case state; the application must use `caseVersion` or an equivalent concurrency-control mechanism.

### 4.4 Required invariants

The application must enforce these invariants:

- A case in `OPEN` must have a valid primary category and assigned team.
- A case in `NEEDS_REVIEW` must have at least one valid review reason.
- A case requiring review must not be treated as normally routed until the required review is completed.
- A model response cannot directly change a case status.
- Employee assignment and employee-driven lifecycle actions must be authorized.
- Every accepted status transition must produce a corresponding audit event in the same database transaction as the status change.
- Audit events must identify the actor type and, when applicable, the authorized employee or system component responsible for the change.

### 4.5 Review completion and reopening

A human reviewer must explicitly record the outcome of a review before the case resumes normal processing. The review outcome and any resulting category, team, or status changes must be validated and audited.

The exact transition after review, and the policy for reopening resolved or closed cases, remain business rules requiring confirmation. Until these rules are defined, the implementation must not invent implicit transitions or allow unrestricted reopening.


## 5. Processing Jobs, Retries, and Idempotency

The system must process incoming service requests reliably even when workers crash, external model providers fail, or requests are delivered more than once.

Processing jobs are persisted separately from case records. A case represents the business request; a job represents work the system needs to perform.

### 5.1 Job record

Each processing job must include:

- `jobId`: unique job identifier.
- `caseId`: associated case identifier.
- `jobType`: the type of work, initially `CLASSIFY_CASE` or `RECOVER_CASE`.
- `status`: current processing-job status.
- `attemptCount`: number of attempts made.
- `availableAt`: earliest time the job may be claimed.
- `leaseOwner`: identifier of the worker currently holding the lease, when applicable.
- `leaseExpiresAt`: time after which an abandoned lease may be recovered.
- `lastErrorCode`: sanitized code describing the most recent failure, when applicable.
- `createdAt` and `updatedAt`: timestamps.

A database constraint must prevent multiple active jobs for the same case and job type where duplicate active work is not intended.

### 5.2 Job statuses

The MVP supports these job statuses:

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

If the same provider message is received again, the system must return or identify the existing case without creating a second case or initial job.

Messages with different provider message IDs that may represent the same customer request are potential duplicates. The MVP must flag such cases for human review when the duplicate-detection mechanism identifies them; it must not automatically merge cases solely on similarity.

### 5.4 Claiming jobs and worker leases

Workers must claim eligible jobs using an atomic database operation that prevents competing workers from claiming the same available job simultaneously.

The implementation should use row locking or an equivalent safe claim mechanism. A worker must record ownership and lease expiry when claiming a job.

Claiming a job, recording the processing attempt, and moving an eligible case to `PROCESSING` must occur in one database transaction.

The lease must be renewed or otherwise managed for long-running work. If a worker loses its lease, it must not commit a classification or routing decision using that expired ownership.

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
- start and finish timestamps
- retryability classification
- sanitized error code or outcome metadata

Attempt numbers must be allocated safely under concurrent execution. Sensitive email content, credentials, and unnecessary personal information must not be copied into error metadata.

### 5.6 Retry policy

Retries must be bounded and governed by explicit configuration. The policy must define the maximum number of attempts, retryable failure categories, backoff schedule, and any required jitter.

Transient failures, such as temporary provider unavailability or network errors, may be retried within the configured limit. Permanent failures, such as irrecoverably invalid configuration, must not be retried indefinitely.

Invalid model output must not be routed as if it were valid. The implementation may retry it within a specifically configured limit; if the limit is exhausted, the case must enter an explicit human-review or operational-recovery path.

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

- `INVALID_INPUT`: an incoming message fails input validation.
- `DUPLICATE_INPUT`: the provider message identity already exists; this is handled idempotently rather than treated as a new case.
- `INVALID_MODEL_OUTPUT`: the classifier response fails the output contract.
- `MODEL_PROVIDER_ERROR`: the model provider returns an error or is unavailable.
- `TRANSIENT_INFRASTRUCTURE_ERROR`: a temporary database, network, or dependent-service failure.
- `PERMANENT_CONFIGURATION_ERROR`: required configuration is missing or invalid.
- `CONCURRENCY_CONFLICT`: the case version, job ownership, or lease is no longer current.
- `POLICY_VALIDATION_ERROR`: the routing policy cannot produce a valid decision.
- `UNAUTHORIZED_ACTION`: an actor attempts an action they are not permitted to perform.
- `UNEXPECTED_INTERNAL_ERROR`: an unclassified failure that must be recorded safely and investigated.

The implementation must map errors to retry, reject, review, or operational-recovery behavior explicitly. Error names alone do not determine retry behavior; the error-handling policy must define the action for each relevant failure category.

### 6.3 Error handling rules

- Invalid incoming messages must not create normally processable cases. The intake boundary must return or record a controlled validation outcome according to the email adapter's delivery and retry behavior.
- Duplicate provider messages must resolve to the existing case without creating duplicate initial work.
- Invalid classifier output must never be treated as a valid routing decision.
- Transient failures may be retried within configured limits.
- Permanent configuration failures must be made visible to operators and must not be retried indefinitely without a configuration change or explicit recovery action.
- Concurrency conflicts must prevent stale writes. The application may reload current state and retry a safe operation where appropriate.
- Unauthorized lifecycle actions must be rejected and must not change case state.
- Unexpected failures must be logged with sanitized diagnostic context and must not expose credentials, full email bodies, or unnecessary personal information.
- Failures affecting a persisted case must leave the case and job in an explicit, recoverable state. The system must not falsely report successful processing.

### 6.4 Versioning

The system must record enough version information to reproduce or explain a routing decision.

At minimum, record:

- `policyVersion`: the routing policy used to make the authoritative decision.
- `modelVersion`: the model identifier or version used for classification, when available.
- `contractVersion`: the version of the normalized input and classifier output contracts used during processing.
- An application release or build identifier in operational diagnostics.
- A schema or migration version for database changes, managed by the migration mechanism.

Activated routing policies are immutable. Changes to category mappings, precedence, review rules, or relevant processing configuration must create a new policy version.

Contract changes must be introduced deliberately. If a new contract version changes field requirements or behavior, the application must explicitly support the relevant version or reject incompatible data with a controlled error. It must not silently interpret incompatible payloads as if they used the current contract.

### 6.5 Reprocessing and policy changes

A policy change must not silently rewrite historical decisions. Existing cases retain the policy version used for their recorded decision.

If a case is reprocessed, the system must record the reason for reprocessing and the model, contract, and policy versions used for the new attempt. The application must define whether reprocessing updates the existing case decision or creates a separate reviewable decision record before enabling that behavior in production.

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
