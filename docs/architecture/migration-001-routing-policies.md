
# Migration 001: Routing Policies

**Status:** Approved
**Migration scope:** Routing policy metadata and normalized category-to-team rules
**Database:** PostgreSQL

## 1. Objective

Create the database foundation for versioned, auditable routing policies.

A routing policy maps each supported category to an approved team and assigns a precedence to resolve multi-category classifications. Application code applies the policy; the language model does not choose the authoritative team or policy.

The schema must support drafts, controlled activation, immutable active and retired versions, and atomic replacement of the active policy.

## 2. Tables

### 2.1 `routing_policies`

| Column           | Proposed type   | Constraints and purpose                         |
| ---------------- | --------------- | ----------------------------------------------- |
| `id`           | UUID            | Primary key                                     |
| `version`      | Integer         | Required, positive, unique                      |
| `status`       | Text            | Required; `DRAFT`, `ACTIVE`, or `RETIRED` |
| `created_at`   | `timestamptz` | Required                                        |
| `created_by`   | Text            | Required actor or service identifier            |
| `activated_at` | `timestamptz` | Nullable until activation                       |

Constraints:

- Primary key on `id`.
- Unique constraint on `version`.
- Positive `version`.
- Status restricted to the supported values.
- Partial unique index permitting at most one `ACTIVE` policy.
- Activated and retired policy versions are immutable.
- Retired policies cannot be reactivated; create a new draft for future changes.

The unique version is a policy version identifier, not a category-precedence decision.

### 2.2 `routing_policy_rules`

| Column         | Proposed type | Constraints and purpose                         |
| -------------- | ------------- | ----------------------------------------------- |
| `policy_id`  | UUID          | Required foreign key to `routing_policies.id` |
| `category`   | Text          | Required supported category                     |
| `team_key`   | Text          | Required approved destination team              |
| `precedence` | Integer       | Required positive priority value                |

Constraints:

- Composite primary key on `(policy_id, category)`.
- Unique `(policy_id, precedence)`.
- Foreign key to `routing_policies`.
- Category restricted to the approved category allowlist.
- Team key restricted to the approved team-key allowlist.
- Positive precedence.
- Rules are editable only while the parent policy is `DRAFT`.

Supported categories and destination teams:

| Category              | Team key              |
| --------------------- | --------------------- |
| `payment_issue`     | `payment_support`   |
| `account_support`   | `account_support`   |
| `technical_support` | `technical_support` |
| `complaint`         | `customer_care`     |
| `other`             | `general_triage`    |

These mappings are the agreed MVP mapping contract. The precedence order remains provisional.

## 3. Category precedence

The schema must store precedence as policy data rather than embed an unapproved order in application logic or authoritative seed data.

Current status:

- The five supported categories are defined.
- Each category must have exactly one rule in a complete policy.
- Each rule must have a positive, unique precedence within its policy.
- The final ordering has not been approved by the business owner.
- No production precedence values will be seeded until approval.

A draft may be prepared with explicitly provisional values for testing, provided they are clearly marked as test data and cannot be mistaken for an approved production policy.

Policy activation must reject incomplete rules and invalid precedence values. Whether an approved policy must use contiguous precedence values from 1 through 5 is an implementation invariant to finalize before SQL is written.

## 4. Policy activation and replacement

Activation is a controlled transactional operation, not an unrestricted status update.

### Required protocol

1. Authorize the actor requesting activation.
2. Begin a database transaction.
3. Lock or otherwise serialize policy activation so concurrent requests cannot race.
4. Validate that the target policy is a draft.
5. Validate that all five categories have exactly one valid mapping.
6. Validate that every precedence is positive and unique.
7. Validate that the policy's precedence configuration has been approved for production activation.
8. Retire the existing active policy, if one exists.
9. Activate the replacement and set `activated_at`.
10. Commit the transaction.

If any step fails, roll back the transaction. The previous active policy must remain active when replacement fails.

A partial unique index enforces at most one active policy at the database level. The activation protocol ensures replacement is coordinated atomically. Database permissions must prevent ordinary application code from bypassing the protocol.

The system must not permit a committed state with two active policies. Replacement must not expose an intermediate committed state with no active policy when replacing an existing active policy.

## 5. Immutability and access control

- Draft policy metadata and rules may be changed through authorized operations.
- Active and retired policy metadata and rules cannot be modified through normal application operations.
- Retired policies remain available for historical case-decision references.
- The runtime role cannot directly bypass activation or immutability controls.
- Migration ownership and runtime access use separate database roles.
- Policy activation and other administrative changes should be auditable.

Database constraints and permissions provide structural protection. Where a rule requires checking multiple rows or the parent policy state, use a controlled database operation and appropriate locking rather than relying only on application-side validation.

## 6. Indexes

Required:

- Unique index or constraint on `routing_policies.version`.
- Partial unique index on active policies.
- Primary key index on `routing_policy_rules(policy_id, category)`.
- Unique index on `(policy_id, precedence)`.

Additional indexes should be added only when justified by a specific query pattern.

## 7. Integration tests

Tests must run against real PostgreSQL.

1. A valid draft policy can be created.
2. Duplicate policy versions are rejected.
3. Invalid statuses and non-positive versions are rejected.
4. Unsupported categories and team keys are rejected.
5. Duplicate category rules are rejected.
6. Duplicate precedence within one policy is rejected.
7. Non-positive precedence is rejected.
8. An incomplete policy cannot be activated.
9. A complete policy with unapproved production precedence cannot be activated.
10. A valid approved policy can be activated.
11. Concurrent activation attempts cannot result in two active policies.
12. Replacement retires the previous active policy and activates the new one atomically.
13. A failure during replacement leaves the previous policy active.
14. Active and retired policy rules cannot be modified through the runtime role.
15. Retired policies cannot be reactivated.
16. The activation operation preserves a usable active policy when replacing an existing one.

## 8. Dependencies and deferred decisions

Migration 001 does not implement cases, jobs, processing attempts, or case audit events; those belong to later migrations.

Deferred decisions:

- Final category-precedence order: pending business-owner approval.
- Whether production precedence must be contiguous from 1 to 5: must be finalized before SQL implementation.
- Exact policy activation audit-event representation: coordinate with the audit schema in Migration 005.
- Operational identity and authorization implementation: use the external identity-provider model; do not create a local employee table.

## 9. Approval gate

Before implementation, approve:

- Table names, columns, and types.
- Constraints and indexes.
- Atomic policy replacement.
- Immutability and access-control strategy.
- No authoritative precedence seed data before business approval.
- Required PostgreSQL integration tests.
- The remaining implementation invariant for precedence values.

After approval, implement only Migration 001 and its tests, review the results, and commit them before proceeding to Migration 002.
