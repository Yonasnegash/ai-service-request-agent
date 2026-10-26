
# Case Lifecycle

## 1. Purpose

This document defines the allowed lifecycle transitions for a support case in the AI Service Request Processing Agent.

A **case** represents the customer-support workflow. A **processing job** represents background work performed by the system. Their states are related but independent.

The application, not the language model, is authoritative for case status, routing, authorization, and state transitions.

## 2. Case statuses

| Status                   | Meaning                                                                                                   |
| ------------------------ | --------------------------------------------------------------------------------------------------------- |
| `RECEIVED`             | The case has been accepted, but processing has not started or an authorized recovery action has reset it. |
| `PROCESSING`           | A processing generation is being evaluated, including time spent waiting for a retry.                     |
| `OPEN`                 | Classification and routing are valid; the case is ready for its assigned team.                            |
| `IN_PROGRESS`          | An authorized employee is actively handling the case.                                                     |
| `NEEDS_REVIEW`         | A human decision is required before normal processing or handling can continue.                           |
| `WAITING_FOR_CUSTOMER` | An employee needs additional information from the customer.                                               |
| `RESOLVED`             | An authorized employee has confirmed resolution.                                                          |
| `CLOSED`               | The case is closed and terminal for the MVP.                                                              |

## 3. Allowed transitions

| From                     | To                       | Actor or condition                                                                                         |
| ------------------------ | ------------------------ | ---------------------------------------------------------------------------------------------------------- |
| `RECEIVED`             | `PROCESSING`           | A worker successfully claims the initial job.                                                              |
| `PROCESSING`           | `OPEN`                 | Valid classification and routing are committed.                                                            |
| `PROCESSING`           | `NEEDS_REVIEW`         | Classification is ambiguous, a sensitive request is flagged, or another approved review condition applies. |
| `PROCESSING`           | `RECEIVED`             | An explicitly authorized operational recovery resets processing. This is not the normal retry path.        |
| `OPEN`                 | `IN_PROGRESS`          | An authorized employee starts handling the case.                                                           |
| `OPEN`                 | `NEEDS_REVIEW`         | An employee or approved system rule flags a concern.                                                       |
| `IN_PROGRESS`          | `WAITING_FOR_CUSTOMER` | An employee requests additional information.                                                               |
| `IN_PROGRESS`          | `NEEDS_REVIEW`         | An employee or approved system rule flags a concern.                                                       |
| `IN_PROGRESS`          | `RESOLVED`             | An authorized employee confirms resolution.                                                                |
| `WAITING_FOR_CUSTOMER` | `IN_PROGRESS`          | Required information is received and work resumes.                                                         |
| `WAITING_FOR_CUSTOMER` | `NEEDS_REVIEW`         | New information requires a human decision.                                                                 |
| `NEEDS_REVIEW`         | `OPEN`                 | Review is completed and the case is ready for its assigned team.                                           |
| `NEEDS_REVIEW`         | `IN_PROGRESS`          | Review is completed and an authorized employee continues handling the case.                                |
| `RESOLVED`             | `IN_PROGRESS`          | An authorized employee reopens the case.                                                                   |
| `RESOLVED`             | `CLOSED`               | Closure criteria are satisfied.                                                                            |
| `CLOSED`               | None                     | Terminal for the MVP. Create a linked new case if additional work is required.                             |

Any transition not listed above is rejected unless a later, reviewed design explicitly adds it.

## 4. Transition invariants

### Routing and classification

- A case entering `OPEN` must have a valid primary category and assigned team.
- The primary category on the case must agree with the primary row in `case_categories`.
- Every secondary category must be supported by the approved category allowlist.
- The routing decision must reference the policy version used to make it.
- Ambiguous classification must not be silently converted into an automatic routing decision.

### Human review

- A case entering `NEEDS_REVIEW` must have at least one approved review reason.
- Completing a review requires an authenticated, authorized employee identity.
- A reviewed correction creates a new decision and audit event; it does not overwrite the original decision history.
- Before leaving `NEEDS_REVIEW`, the system must validate the reviewed classification and routing result.
- A reviewer may return a case to `OPEN` or continue directly into `IN_PROGRESS` when authorized.

### Resolution and closure

- Only an authorized employee may resolve a case.
- The classifier and processing worker cannot resolve or close cases.
- Reopening a `RESOLVED` case requires an authorized employee.
- A new customer message alone does not automatically reopen a resolved case.
- `CLOSED` is terminal for the MVP. Additional work requires a linked new case.

### Persistence and audit

- Every successful status transition must be recorded in an audit event.
- The case update and corresponding audit event must commit in the same database transaction.
- Rejected transitions must not partially modify the case.
- Employee identity comes from the external identity system; the MVP does not create a local employee-account table.

## 5. Processing failures and retries

A retryable infrastructure or provider failure does not, by itself, mean the case requires human review.

When processing fails temporarily:

- Keep the case in `PROCESSING`.
- Move the job to `RETRY_WAIT` when retry policy permits.
- Record the failed attempt and a sanitized error code.
- Retry the same job generation when it becomes eligible.
- Do not overwrite prior attempt history.

When a job reaches `DEAD_LETTER`, the case does not automatically become `NEEDS_REVIEW`. Record and alert on the operational failure, then use an explicitly authorized recovery or escalation procedure.

An authorized recovery may reset the case to `RECEIVED` when a new initial processing attempt is required. That action must be audited.

## 6. Out of scope

The MVP does not define automatic customer replies, automatic resolution or closure, automatic reopening from customer messages, or arbitrary transitions performed directly by the model.

## 7. Remaining business confirmation

The final category-precedence order remains provisional. In particular, the priority of `complaint` relative to the other categories must be confirmed by the business owner before production policy activation.

The schema must support configurable precedence without embedding an unapproved order into application logic or permanent seed data.
