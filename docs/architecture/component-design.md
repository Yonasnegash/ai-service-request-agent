
# Component Design

## 1. Design Principles

The system will use a modular monolith with explicit module boundaries.

The design prioritizes:

- Separation of business logic from external integrations.
- Deterministic routing and validation outside the AI model.
- Durable processing with bounded retries and recovery.
- Transactional consistency for case state, jobs, and audit events.
- Testability through replaceable external dependencies.
- Human oversight for ambiguous, incomplete, and exceptional requests.

Modules will initially run in one Node.js application. Separate deployment units will be considered only if future requirements justify them.

## 2. Component Overview

### 2.1 Email Intake Adapter

**Responsibility**

Convert messages from the selected email provider into the application's normalized email input contract.

**Responsibilities include**

- Extracting permitted message fields.
- Normalizing provider-specific formats.
- Validating required identifiers and timestamps.
- Treating sender content as untrusted input.
- Passing normalized input to the intake service.

**Must not**

- Decide the authoritative category or destination team.
- Invoke the AI model directly.
- Send customer replies.

The email provider and integration mechanism remain open decisions.

### 2.2 Intake Service

**Responsibility**

Register each unique incoming message and create its initial processing job.

**Responsibilities include**

- Validating the normalized input.
- Applying idempotency using the provider, mailbox ID, and provider message ID.
- Assigning a unique case ID.
- Persisting the case, initial audit event, and initial job atomically.
- Returning the existing case when the same message is delivered again.

A database uniqueness constraint is required to protect against concurrent duplicate deliveries.

### 2.3 Processing Worker

**Responsibility**

Process durable jobs without losing work when an execution fails or a worker stops unexpectedly.

**Responsibilities include**

- Claiming eligible jobs safely.
- Recording processing attempts.
- Moving cases into the appropriate processing state.
- Calling the classification workflow.
- Applying bounded retries and backoff for retryable failures.
- Recovering abandoned jobs after worker leases expire.
- Making exhausted failures visible for operational recovery.

Job claiming must prevent multiple workers from simultaneously owning the same job. A worker that loses its lease must not commit a stale result.

### 2.4 Classifier Interface and AI Adapter

**Responsibility**

Use an AI model to interpret the email and return a structured classification proposal.

The classifier interface will separate application logic from provider-specific model integration.

**Expected output**

- A concise summary.
- Candidate categories from the approved category set.
- Extracted fields and missing-information indicators.
- An ambiguity indicator and proposed review reasons.
- Model and schema version information where available.

**Must not**

- Select the authoritative destination team.
- Change case status directly.
- Authorize sensitive actions.
- Send customer replies.
- Override application policy based on instructions found in email content.

The application must validate all model output, including output that appears structurally correct.

### 2.5 Policy Engine

**Responsibility**

Convert validated classification proposals into an authoritative routing decision.

**Responsibilities include**

- Checking category values against the approved allowlist.
- Applying documented primary-category precedence.
- Preserving applicable secondary categories.
- Mapping the primary category to a configured team queue.
- Flagging ambiguous or otherwise exceptional cases for human review.
- Recording missing information separately from review status.
- Applying the active, versioned routing policy.

The initial category precedence and routing configuration are defined in the project requirements and must be reviewed before production use.

The policy engine does not retrieve external policies in the MVP.

### 2.6 Case Lifecycle Service

**Responsibility**

Enforce valid case status transitions and employee-controlled case operations.

**Responsibilities include**

- Validating requested status transitions.
- Checking authorization for employee actions.
- Preventing model output from resolving or closing a case.
- Recording status changes and their actors.
- Detecting stale updates through case versioning or equivalent concurrency control.

Customer communication, investigation, resolution, and closure remain employee-controlled.

### 2.7 Case Repository

**Responsibility**

Persist and retrieve canonical case records.

**Responsibilities include**

- Reading and updating case state.
- Enforcing optimistic concurrency where appropriate.
- Persisting classification and routing outcomes.
- Managing duplicate-case references.
- Supporting atomic updates within application transactions.

Database constraints remain necessary even when equivalent checks exist in application code.

### 2.8 Processing Job Repository

**Responsibility**

Manage durable background work stored in PostgreSQL.

**Responsibilities include**

- Creating jobs within the intake transaction.
- Claiming eligible jobs safely.
- Recording job state, attempts, scheduling, and worker lease information.
- Supporting retry scheduling and recovery.
- Preventing multiple active jobs of the same type for the same case where required.

The repository will use PostgreSQL transaction and row-locking capabilities to coordinate workers.

### 2.9 Audit Repository

**Responsibility**

Record an append-oriented history of significant case and processing events.

Events include:

- Case registration.
- Classification and routing outcomes.
- Review flags.
- Case status changes.
- Processing failures and recovery.
- Employee actions.

Audit events will include the actor or system component, event type, timestamp, and appropriate sanitized metadata.

Audit writes associated with a case transition must occur in the same database transaction as that transition. Ordinary application operations must not silently rewrite historical audit entries.

### 2.10 Configuration and Observability

**Responsibility**

Provide validated runtime configuration and visibility into system behavior.

Configuration includes database connectivity, model-provider settings, retry limits, routing policy, and operational thresholds.

Observability includes structured logs, processing metrics, latency, retry counts, failure counts, and model usage or cost where available.

Secrets must be supplied through an appropriate secret-management mechanism rather than committed to source control.

## 3. Main Processing Flow

1. The email adapter normalizes an incoming message.
2. The intake service validates the input and starts a database transaction.
3. The transaction registers the case, records its creation event, and creates the initial processing job.
4. If the provider message already exists, the existing case is returned without creating another initial job.
5. A worker claims the job and records the attempt and processing state transactionally.
6. The worker calls the classifier outside the database transaction.
7. The policy engine validates the result and determines routing or review requirements.
8. A decision transaction verifies that the worker still owns the job and that the case has not changed unexpectedly.
9. The system persists the classification, routing decision, case transition, attempt result, job result, and audit event consistently.
10. Failures are classified as retryable or non-retryable. Retryable failures are scheduled within configured limits; exhausted failures remain visible and recoverable.
11. Employees handle cases requiring review and retain responsibility for customer communication and resolution.

## 4. Transaction and Recovery Boundaries

### Intake transaction

The case record, case-created audit event, and initial processing job must commit together or roll back together.

### Job claim transaction

Job ownership, attempt creation, and the transition into processing must be coordinated transactionally.

### AI call boundary

External model calls must occur outside long-running database transactions.

### Decision transaction

The validated decision, relevant case update, attempt outcome, job completion, and audit event must commit together.

### Worker recovery

Jobs must support lease expiration and safe recovery. A worker that loses ownership must not overwrite a newer decision. If a worker retries after a successful decision commit, the system must recognize the completed work and avoid duplicating its state transition or audit event.

## 5. Error Handling

Errors should be classified into categories such as:

- Invalid incoming input.
- Duplicate delivery.
- Model-provider timeout or availability failure.
- Invalid or unexpected model output.
- Database or concurrency failure.
- Authorization failure.
- Retry exhaustion.

Retry decisions depend on error classification and configured limits. Retries must be bounded and scheduled with backoff. Invalid model output may receive a limited retry, after which the case must follow a defined review or operational recovery path.

Error logs and metadata must avoid unnecessarily exposing email content, personal data, credentials, or other sensitive information.

## 6. Testing Strategy

- **Unit tests:** category precedence, schema validation, routing rules, state transitions, retry decisions, and error classification.
- **Integration tests:** PostgreSQL constraints, transactions, job claiming, idempotency, and audit persistence.
- **Concurrency tests:** simultaneous duplicate intake, competing workers, and stale case updates.
- **Contract tests:** normalized email input and classifier output.
- **Evaluation tests:** classification quality, routing correctness, ambiguity handling, invalid output, and prompt-injection resistance.
- **Recovery tests:** expired leases, retry exhaustion, worker interruption, and retries after a decision has committed.

Tests must use synthetic or appropriately de-identified data.

## 7. Implementation Boundaries

The initial codebase will separate intake, cases, classification, routing, processing, audit, and infrastructure concerns.

External integrations will be accessed through defined interfaces. Business rules will not be embedded in HTTP controllers, provider-specific adapters, or prompts.

The detailed folder structure and public interfaces will be finalized during implementation as the modules are built incrementally.

## 8. Open Design Questions

- Which email integration will be implemented first?
- Which AI provider and model will be used initially?
- What authentication and authorization approach will protect employee operations?
- What exact retention, deletion, and audit-access rules will apply?
- Which operational metrics and alerts are required for the first deployment?
- Which error categories and retry limits will be configurable by policy?
