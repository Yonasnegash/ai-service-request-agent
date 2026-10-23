
# ADR 0003: Keep Humans in Control of Case Resolution

- **Status:** Accepted
- **Date:** 2026-10-23
- **Decision owners:** Project maintainer

## Context

The AI Service Request Processing Agent uses a model to summarize incoming service requests, propose categories, and extract relevant fields.

Model outputs may be incomplete, ambiguous, invalid, or influenced by untrusted instructions in email content. A model-generated confidence score does not, by itself, establish that a classification or routing decision is correct.

The system must automate repetitive initial processing without granting the model authority over sensitive business actions or final case resolution.

## Decision

Use a human-in-the-loop workflow with explicit boundaries between AI proposals, application-enforced decisions, and employee-controlled actions.

### AI responsibilities

The AI classifier may:

- Summarize the request.
- Propose categories from the approved category set.
- Extract relevant fields.
- Identify missing information.
- Indicate ambiguity and propose review reasons.

### Application responsibilities

Application code must:

- Validate model output against a strict schema.
- Enforce category allowlists and deterministic category precedence.
- Apply configured routing policies.
- Determine whether human review is required.
- Enforce authorization and valid case status transitions.
- Record processing outcomes and relevant audit events.

The application must not treat email content as trusted instructions or allow model output to override application policy.

### Employee responsibilities

Employees retain responsibility for:

- Reviewing ambiguous, incomplete, invalid, or escalated requests.
- Investigating the underlying issue.
- Communicating with customers.
- Making decisions requiring human judgment or authorization.
- Resolving and closing cases.

The MVP will not send autonomous customer replies or allow the model to resolve or close cases.

## Review and Routing Rules

- Valid, routine requests may be routed automatically when they satisfy the approved decision policy.
- Ambiguous requests must be flagged for human review.
- Unknown categories must use general triage.
- Missing information must be recorded separately from review status.
- Sensitive-request rules must be defined and approved before the relevant workflows are enabled.
- A model-reported confidence score alone must never authorize a sensitive action or establish eligibility for automatic routing.

Any confidence threshold used by the application must be calibrated and evaluated against labeled examples before operational use.

## Alternatives Considered

### Fully autonomous case handling

Allow the AI model to classify, communicate with customers, make business decisions, and close cases.

**Reasons not selected:**

- Increases the risk of incorrect or unauthorized actions.
- Makes it harder to maintain predictable business rules and accountability.
- Requires stronger evidence of reliability and substantially broader safeguards than the MVP provides.

### Human-only processing

Require employees to perform every classification and routing step manually.

**Reasons not selected:**

- Does not achieve the project's goal of reducing repetitive initial processing.
- Misses the opportunity to evaluate controlled automation while preserving human authority over resolution.

## Consequences

### Benefits

- Business rules remain deterministic and testable.
- Employees retain control over customer-facing and consequential decisions.
- Ambiguous cases have an explicit review path.
- AI outputs can be evaluated independently from routing policy.
- The system can record why a case was routed or flagged for review.

### Trade-offs

- Some requests will require manual review, limiting full automation.
- Review queues need clear ownership and operational follow-up.
- Evaluation data and monitoring are necessary to determine whether automatic routing is sufficiently reliable.
- Authentication, authorization, audit access, and case lifecycle rules require careful implementation.

## Review Conditions

Revisit this decision only if future requirements justify additional automation and evaluation demonstrates that the proposed behavior is reliable and appropriately controlled.

Any expansion must define permitted actions, authorization boundaries, failure handling, audit requirements, and human escalation paths before implementation.
