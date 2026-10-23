
# Evaluation Plan

**Project:** AI Service Request Processing Agent
**Document status:** Draft; evaluation implementation pending
**Version:** 1.0-draft

## 1. Purpose

This document defines how the AI Service Request Processing Agent will be evaluated for classification quality, routing correctness, human oversight, reliability, and operational performance.

The purpose is to verify that model-assisted processing is useful while application-enforced business rules remain authoritative.

Evaluation results must be reproducible, based on labeled examples, and distinguish model errors from application, infrastructure, and policy errors.

## 2. Evaluation Principles

- Use synthetic service requests during initial development.
- Keep expected labels separate from model predictions.
- Establish evaluation examples before tuning prompts against them.
- Maintain separate development and held-out evaluation datasets.
- Use deterministic tests for routing, validation, state transitions, and idempotency.
- Do not treat model-reported confidence as proof of correctness.
- Route uncertain or policy-defined cases for human review.
- Record model, contract, and policy versions for reproducibility.
- Never use evaluation success as a substitute for authorization, privacy, or security controls.
- Do not claim production readiness based only on unit-test results.

## 3. Evaluation Dataset

Each evaluation example must contain:

- `exampleId`: stable, unique example identifier.
- `input`: synthetic normalized email input.
- `expectedPrimaryCategory`: human-labeled primary category.
- `expectedSecondaryCategories`: expected additional categories, when applicable.
- `expectedTeam`: team required by the active test policy.
- `expectedMissingInformation`: expected missing-information identifiers.
- `expectedReviewRequired`: whether human review is required.
- `expectedReviewReasons`: expected review reasons.
- `rationale`: short explanation supporting the expected labels.
- `scenarioType`: the behavior or failure condition being tested.

Labels must be reviewed against the documented category definitions and routing policy.

The initial dataset must cover:

1. Clear, single-category requests.
2. Requests involving multiple categories.
3. Ambiguous primary issues.
4. Requests missing required information.
5. Unsupported or out-of-scope requests.
6. Complaints combined with another issue.
7. Duplicate provider message delivery.
8. Potential duplicates with different provider message IDs.
9. Email content containing prompt-injection attempts.
10. Malformed or schema-invalid classifier output.
11. Sensitive requests that require review under the approved policy.
12. Empty or unusually long subject and body fields.
13. Invalid timestamps and malformed input.
14. Model-provider timeouts and transient failures.
15. Retry exhaustion and worker recovery scenarios.

The dataset must contain enough examples to exercise each scenario. Dataset size and category distribution will be recorded when the initial labeled dataset is created.

## 4. Dataset Separation

Maintain separate datasets for different purposes:

- **Development set:** used to build features, test behavior, and refine prompts.
- **Validation set:** used to compare candidate changes and select configurations.
- **Held-out evaluation set:** used to measure performance on examples not used for prompt tuning or policy adjustments.

Keep held-out labels separate from routine prompt-development workflows. When held-out examples are used to make design changes, document that use and establish a fresh evaluation set before claiming an independent result.

All datasets must use synthetic or appropriately de-identified content and must not contain credentials, private keys, or unnecessary personal information.

## 5. Quality Metrics

### 5.1 Classification quality

Measure:

- Primary-category accuracy.
- Per-category precision, recall, and F1 score.
- Secondary-category precision and recall where applicable.
- Ambiguity detection performance.
- Missing-information extraction quality.
- Review-reason precision and recall.

Report per-category results as well as aggregate results. Aggregate accuracy alone can hide poor performance on less frequent categories.

### 5.2 Routing correctness

Measure the percentage of cases assigned to the expected team by the deterministic routing policy.

Routing tests must verify:

- Category-to-team mappings.
- Multi-category precedence.
- Preservation of secondary categories.
- Fallback to General triage for `other`.
- Ambiguous cases entering `NEEDS_REVIEW`.
- Invalid classifier output never producing a normal routing decision.
- Missing information remaining separate from the review state.

Given the same validated classifier output and the same policy version, the policy engine must produce the same routing decision.

### 5.3 Human oversight and safety

Measure:

- Recall for cases that require human review.
- Percentage of invalid outputs prevented from normal routing.
- Percentage of ambiguous cases correctly flagged for review.
- Unauthorized lifecycle actions rejected.
- Attempts to override policy through email content prevented from changing application behavior.
- Cases resolved or closed by the agent: target zero.

False negatives for required human review must be reported separately and investigated.

### 5.4 Reliability

Verify:

- Duplicate provider messages produce one case and one initial job.
- Concurrent duplicate intake does not create duplicate cases.
- Distinct valid messages can be registered independently.
- Retries remain within configured limits.
- Expired worker leases can be recovered.
- Stale workers cannot commit decisions after losing ownership.
- Failed database transactions do not leave partially committed decisions or audit events.
- Recovery does not duplicate authoritative state transitions.
- Exhausted jobs remain visible for operational recovery.

### 5.5 Operational performance

Measure:

- End-to-end processing latency.
- Model-provider latency.
- Database and queue processing latency.
- Retry rate.
- Failure and dead-letter rates.
- Human-review rate.
- Average model cost per processed case.
- Average model cost per successfully processed case.
- Token usage where supported by the provider.

Report latency percentiles, including p50, p95, and p99 when the sample size is sufficient. Document the test environment and dataset size alongside performance results.

## 6. Test Layers

### 6.1 Unit tests

Use unit tests to verify isolated application logic:

- Input and output schema validation.
- Category precedence.
- Team mapping.
- Review rules.
- Missing-information validation.
- Error classification.
- Retry eligibility.
- Allowed case status transitions.

### 6.2 Integration tests

Use a real PostgreSQL test instance to verify:

- Database uniqueness constraints.
- Atomic case, audit, and initial-job creation.
- Concurrent job claiming.
- Attempt-number allocation.
- Lease expiry and fencing.
- Optimistic concurrency control.
- Transaction rollback when audit or decision persistence fails.
- Recovery after interrupted processing.

Mocks alone cannot establish the correctness of database locking and transaction guarantees.

### 6.3 Contract tests

Verify that normalized email inputs and classifier responses conform to the documented schemas.

Test missing fields, unexpected fields, invalid types, oversized values, unsupported categories, duplicate category candidates, and invalid reason codes.

### 6.4 Model evaluation tests

Run the classifier against the labeled evaluation dataset and compare its output with expected labels.

Record:

- Dataset version.
- Model identifier and version.
- Prompt version.
- Input and output contract versions.
- Routing-policy version.
- Evaluation timestamp.
- Metrics and known limitations.

Model evaluation must not bypass deterministic application validation and routing tests.

### 6.5 End-to-end tests

Verify complete workflows from normalized email intake through classification, routing, persistence, and human review.

Include success paths and failure paths such as provider timeouts, malformed model output, duplicate delivery, worker interruption, and retry exhaustion.

## 7. Prompt-Injection and Untrusted Input Evaluation

Email subject and body content must be treated as untrusted data.

Create synthetic test examples containing instructions that attempt to make the model:

- Ignore its classification task.
- Change the assigned team or case status.
- Reveal system instructions or secrets.
- Skip required human review.
- Send an unauthorized customer reply.
- Treat email content as application policy.

Verify that the classifier's response is validated and that application policy remains authoritative regardless of email content.

The security objective is not to assume that prompts alone prevent injection. It is to ensure that untrusted text cannot directly authorize application actions or bypass deterministic validation and access controls.

## 8. Acceptance Criteria

Before an MVP milestone is considered complete:

- Required automated tests pass.
- The held-out evaluation dataset and its labels are documented.
- Category-level classification metrics are reported.
- Routing correctness is verified independently of model accuracy.
- Invalid outputs cannot create normal routing decisions.
- Required human-review scenarios are tested.
- Duplicate intake and transactional guarantees are tested against PostgreSQL.
- Retry exhaustion and worker recovery are tested.
- Logs and error metadata are checked for accidental sensitive-data exposure.
- Known limitations and unresolved business decisions are documented.

Numeric quality, latency, and cost thresholds must be defined after an initial baseline is measured and the project's risk tolerance is reviewed. They must not be selected solely because a particular model achieves them.

## 9. Evaluation Results Record

Each formal evaluation run should produce a report containing:

- Evaluation run identifier and timestamp.
- Dataset version and number of examples.
- Model, prompt, contract, policy, and application versions.
- Classification metrics by category.
- Routing correctness.
- Human-review detection results.
- Reliability and failure-handling results.
- Latency and cost measurements.
- Failed examples and error analysis.
- Known limitations and proposed corrective actions.
- Reviewer decision: pass, revise, or stop.

Evaluation reports must use synthetic or appropriately de-identified data and must not expose secrets or unnecessary personal information.

## 10. Initial Evaluation Milestones

1. Create a small, hand-labeled synthetic dataset.
2. Implement deterministic tests for schemas, routing policy, and lifecycle rules.
3. Run baseline model evaluations without tuning against the held-out dataset.
4. Review classification errors and identify systematic failure patterns.
5. Improve prompts or application policy using development data.
6. Re-run tests and compare results against the baseline.
7. Define numeric acceptance thresholds based on observed results and risk.
8. Record evaluation findings before enabling any additional automation.

The MVP remains human-in-the-loop. Passing evaluation tests does not authorize autonomous customer replies, resolution, or closure.

