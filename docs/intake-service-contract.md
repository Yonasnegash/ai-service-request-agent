
# Email Intake Service Contract

**Status:** Approved design; implementation pending
**Scope:** Email-only intake MVP
**Related documents:** `docs/technical-contract.md`, `docs/architecture/component-design.md`, ADR 0001, ADR 0002, ADR 0003

## 1. Purpose

Define the contract for converting a validated normalized email into a durable service-request case.

The intake service must create the case, record its creation in the audit trail, and schedule its initial classification job atomically. Repeated delivery of the same provider message must not create duplicate cases or jobs.

This milestone does not implement email-provider integration, AI classification, routing decisions, customer replies, or HTTP endpoints.

## 2. Service interface

The conceptual service interface is:

```typescript
intakeEmail(
    email: NormalizedEmail,
    context: TrustedIntakeContext,
): Promise<IntakeResult>
```

The service accepts:

- `NormalizedEmail`: input validated against the normalized email schema.
- `TrustedIntakeContext`: provider and mailbox identifiers resolved from trusted application integration configuration.

The context must not be constructed solely from untrusted request-body fields.

### Result type

```typescript
type IntakeResult =
    | {
          outcome: 'created';
          caseId: string;
      }
    | {
          outcome: 'duplicate';
          caseId: string;
      };
```

A duplicate result identifies the existing case. It does not imply that the existing case is still in its initial state.

## 3. Trust and validation

Before persistence, the service must:

1. Verify that the provider and mailbox identifiers in the normalized email match the trusted integration context.
2. Reject a mismatch without writing to the database.
3. Ensure the normalized input satisfies the approved schema contract.
4. Avoid trusting sender-provided content as instructions or as proof of sender identity.

Error classification:

- Invalid or malformed input: `INVALID_INPUT`.
- A trusted adapter supplies identifiers inconsistent with its configured integration: `PERMANENT_CONFIGURATION_ERROR`.
- A temporary database or infrastructure failure: `TRANSIENT_INFRASTRUCTURE_ERROR`.
- An otherwise unexpected failure: `UNEXPECTED_INTERNAL_ERROR`.

Typed service errors are mapped to transport responses by the caller. The intake service does not depend on HTTP response types.

## 4. Idempotency

The unique identity is:

`(provider, mailboxId, providerMessageId)`

This maps to the existing database identity constraint using the provider, mailbox, and provider message ID columns.

PostgreSQL uniqueness is the final authority for concurrent duplicate submissions. A lookup followed by an unprotected insert is insufficient.

For a new identity, the service creates a case and its initial job.

For an existing identity, the service returns the existing case ID without creating another case or initial job and without resetting the existing case's lifecycle state.

If a conflict occurs but the existing case cannot be retrieved reliably, the service must throw a typed concurrency or infrastructure error rather than return an incomplete duplicate result.

Different provider message IDs are not automatically merged, even when their content appears similar.

## 5. Atomic persistence

For a new email, one PostgreSQL transaction must:

1. Insert the case with initial status `RECEIVED`.
2. Record the case-creation audit event through the existing database trigger.
3. Insert one initial `CLASSIFY_CASE` processing job in `PENDING` status.
4. Commit the transaction.

If any required operation fails, the transaction must roll back. A case must not be committed without its initial processing job.

The implementation must verify the existing migration 005 audit trigger behavior and must not create duplicate `CASE_CREATED` audit events by manually duplicating trigger work.

The service must use the existing schema, status rules, job constraints, and runtime database role. It must not bypass database lifecycle protections.

## 6. Error handling

The service throws typed errors rather than returning failure variants in `IntakeResult`.

Proposed service-level errors:

- `InvalidIntakeInputError`
- `IntakeContextMismatchError` or a configuration-specific error
- `PermanentConfigurationError`
- `TransientInfrastructureError`
- `UnexpectedIntakeError`

These are implementation-level names. Their mappings must remain consistent with the established technical-contract error categories.

Errors and logs must not expose raw SQL errors, database credentials, connection details, email bodies, or other sensitive message content.

A failed transaction may be retried only according to a safe retry policy. A retry must preserve idempotency.

## 7. Acceptance-test specification

### Successful intake

Given valid normalized email input and matching trusted context:

- One case is created.
- The initial case status is `RECEIVED`.
- One case-creation audit event is present.
- One initial `CLASSIFY_CASE` job is present in `PENDING` status.
- The result is `created` with the new case ID.

### Duplicate delivery

Given a previously accepted provider/mailbox/message identity:

- The result is `duplicate` with the original case ID.
- No additional case is created.
- No additional initial job is created.
- Existing case status and lifecycle fields remain unchanged.

### Concurrent duplicate delivery

Given two concurrent submissions with the same identity:

- Only one case exists for that identity.
- Only one initial job is created.
- Both callers receive a valid result identifying the same case.
- Neither caller reports success without a valid case ID.

This test must use a real PostgreSQL integration database rather than relying only on mocked repositories.

### Trust mismatch

For provider or mailbox mismatch:

- A typed error is thrown.
- No case, job, or audit event is written by the intake operation.

### Invalid input

For invalid normalized input:

- A typed validation error is thrown.
- No database writes occur.

### Transaction rollback

If initial job creation fails after case insertion:

- The case is rolled back.
- The case-creation audit event is rolled back.
- No initial job remains.

### Infrastructure failure

If PostgreSQL is unavailable or the transaction fails:

- The service throws a typed infrastructure error.
- The transaction does not leave partial committed intake state.
- Error output does not leak sensitive database details.

### Duplicate after lifecycle progression

If an existing case has progressed beyond `RECEIVED`:

- A repeated delivery returns the existing case ID.
- Its current status is preserved.
- No duplicate initial job is created.

### Database constraints and permissions

Integration tests must confirm that the configured runtime role can perform the required operations without bypassing schema constraints, triggers, or lifecycle guards.

## 8. Explicitly unresolved validation limits

The following values have not been approved and must not be invented as settled production policy:

- Maximum email body size and individual field lengths.
- Allowed provider-specific identifier formats.
- Maximum attachment count and attachment size.
- Whether zero-byte attachments are permitted.
- Provider-specific timestamp and message-age restrictions.
- Any additional content sanitization or retention limits.

The existing Express JSON request-body limit is not a substitute for a complete email and attachment validation policy.

These limits must be agreed and documented before production email integration.

## 9. Out of scope

This service does not:

- Call an AI model.
- Determine the authoritative category or destination team.
- Automatically merge suspected duplicate requests.
- Send customer replies.
- Resolve or close cases.
- Implement provider webhooks or polling.
- Introduce a separate persistence model or duplicate audit mechanism.

## 10. Completion criteria

The intake milestone is complete when:

- The service contract and error mapping are implemented.
- Case, audit event, and initial job are atomic.
- Identity-based duplicate delivery is safe under concurrency.
- The acceptance tests pass against the isolated PostgreSQL integration database.
- Existing typecheck, lint, unit, and integration tests pass.
- No unresolved production validation limit is silently treated as approved.
