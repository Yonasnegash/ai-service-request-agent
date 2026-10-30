
import { describe, expect, it } from 'vitest';

import { FakeCaseClassifier } from '../helpers/fake-case-classifier.js';
import { classificationEvaluationCases } from '../../src/modules/classification/classification-evaluation-cases.js';
import { evaluateClassification } from '../../src/modules/classification/classification.policy.js';
import { classificationInputSchema } from '../../src/modules/classification/classification.schema.js';

describe('CaseClassifier boundary', () => {
  it('passes only the defined subject and body input shape', async () => {
    const classifier = new FakeCaseClassifier({
      category: 'payment_issue',
      confidence: 0.9,
      rationale: 'The customer reports a failed payment.',
    });

    const input = {
      subject: 'Payment failed',
      bodyText: 'My payment was not received.',
    };

    await classifier.classify(input);

    expect(classifier.receivedInputs).toEqual([input]);
    expect(classificationInputSchema.safeParse(input).success).toBe(true);
    expect(
      classificationInputSchema.safeParse({
        ...input,
        senderEmail: 'customer@example.com',
      }).success,
    ).toBe(false);
  });

  it('returns deterministic output for repeated calls', async () => {
    const output = {
      category: 'account_support',
      confidence: 0.88,
      rationale: 'The customer cannot access their account.',
    };

    const classifier = new FakeCaseClassifier(output);
    const input = {
      subject: 'Cannot sign in',
      bodyText: 'My password reset did not work.',
    };

    await expect(classifier.classify(input)).resolves.toEqual(output);
    await expect(classifier.classify(input)).resolves.toEqual(output);

    expect(classifier.receivedInputs).toHaveLength(2);
  });

  it('allows the policy to reject malformed classifier output', async () => {
    const classifier = new FakeCaseClassifier({
      category: 'refund_approved',
      confidence: 0.99,
      rationale: 'Unsupported category.',
    });

    const output = await classifier.classify({
      subject: 'Refund',
      bodyText: 'Please check my refund.',
    });

    expect(evaluateClassification(output)).toEqual({
      outcome: 'invalid_output',
    });
  });

  it('keeps low-confidence output in human review', async () => {
    const classifier = new FakeCaseClassifier({
      category: 'other',
      confidence: 0.4,
      rationale: 'The request is unclear.',
    });

    const output = await classifier.classify({
      subject: 'Please help',
      bodyText: 'I need assistance.',
    });

    expect(evaluateClassification(output)).toMatchObject({
      outcome: 'human_review',
      reason: 'LOW_CONFIDENCE',
    });
  });

  it('contains examples for all five supported categories', () => {
    const categories = new Set(
      classificationEvaluationCases.map(
        (example) => example.expectedCategory,
      ),
    );

    expect(categories).toEqual(
      new Set([
        'payment_issue',
        'account_support',
        'technical_support',
        'complaint',
        'other',
      ]),
    );
  });

  it('contains both routing-ready and review examples', () => {
    expect(
      classificationEvaluationCases.some(
        (example) => example.expectedDecision === 'ready_for_routing',
      ),
    ).toBe(true);

    expect(
      classificationEvaluationCases.some(
        (example) => example.expectedDecision === 'human_review',
      ),
    ).toBe(true);
  });
});
