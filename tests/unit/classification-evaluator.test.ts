
import { describe, expect, it } from 'vitest';

import type { CaseClassifier } from '../../src/modules/classification/case-classifier.js';
import {
  evaluateClassifier,
} from '../../src/modules/classification/classification-evaluator.js';
import type { ClassificationEvaluationCase } from '../../src/modules/classification/classification-evaluation-cases.js';

const cases: ClassificationEvaluationCase[] = [
  {
    id: 'correct-payment',
    input: {
      subject: 'Payment failed',
      bodyText: 'My payment failed.',
    },
    expectedCategory: 'payment_issue',
    expectedDecision: 'ready_for_routing',
  },
  {
    id: 'unclear-account',
    input: {
      subject: 'Help with account',
      bodyText: 'I need help.',
    },
    expectedCategory: 'account_support',
    expectedDecision: 'human_review',
  },
  {
    id: 'incorrect-technical',
    input: {
      subject: 'App crashes',
      bodyText: 'The app keeps crashing.',
    },
    expectedCategory: 'technical_support',
    expectedDecision: 'ready_for_routing',
  },
  {
    id: 'invalid-complaint',
    input: {
      subject: 'Complaint',
      bodyText: 'I have a complaint.',
    },
    expectedCategory: 'complaint',
    expectedDecision: 'ready_for_routing',
  },
  {
    id: 'provider-error',
    input: {
      subject: 'General question',
      bodyText: 'I have a question.',
    },
    expectedCategory: 'other',
    expectedDecision: 'human_review',
  },
];

function classifierFrom(
  handler: (subject: string) => Promise<unknown>,
): CaseClassifier {
  return {
    async classify(input) {
      return handler(input.subject);
    },
  };
}

describe('evaluateClassifier', () => {
  it('calculates category accuracy, review rate, and confusion counts', async () => {
    const classifier = classifierFrom(async (subject) => {
      if (subject === 'Payment failed') {
        return {
          category: 'payment_issue',
          confidence: 0.9,
          rationale: 'Payment failure reported.',
        };
      }

      if (subject === 'Help with account') {
        return {
          category: 'account_support',
          confidence: 0.4,
          rationale: 'Account issue is unclear.',
        };
      }

      if (subject === 'App crashes') {
        return {
          category: 'payment_issue',
          confidence: 0.9,
          rationale: 'Incorrect category for this test.',
        };
      }

      if (subject === 'Complaint') {
        return {
          category: 'unknown',
          confidence: 0.9,
          rationale: 'Unsupported category.',
        };
      }

      throw new Error('Provider credentials or other sensitive details');
    });

    const report = await evaluateClassifier(classifier, cases);

    expect(report.total).toBe(5);
    expect(report.correct).toBe(2);
    expect(report.accuracy).toBe(2 / 5);
    expect(report.readyForRouting).toBe(2);
    expect(report.humanReview).toBe(1);
    expect(report.invalidOutputs).toBe(1);
    expect(report.classifierErrors).toBe(1);
    expect(report.reviewRate).toBe(1 / 5);

    expect(report.categoryMetrics.payment_issue).toEqual({
      support: 1,
      correct: 1,
      accuracy: 1,
    });

    expect(
      report.confusionMatrix.technical_support.payment_issue,
    ).toBe(1);

    expect(
      report.confusionMatrix.complaint.INVALID_OUTPUT,
    ).toBe(1);

    expect(
      report.confusionMatrix.other.CLASSIFIER_ERROR,
    ).toBe(1);

    expect(JSON.stringify(report)).not.toContain(
      'Provider credentials or other sensitive details',
    );
  });

  it('returns zero-valued metrics for an empty dataset', async () => {
    const classifier = classifierFrom(async () => {
      throw new Error('Should not be called');
    });

    const report = await evaluateClassifier(classifier, []);

    expect(report.total).toBe(0);
    expect(report.accuracy).toBe(0);
    expect(report.reviewRate).toBe(0);
    expect(report.predictions).toEqual([]);
  });

  it('uses the supplied confidence threshold', async () => {
    const classifier = classifierFrom(async () => ({
      category: 'payment_issue',
      confidence: 0.7,
      rationale: 'Payment issue reported.',
    }));

    const report = await evaluateClassifier(
      classifier,
      [cases[0]!],
      0.8,
    );

    expect(report.humanReview).toBe(1);
    expect(report.readyForRouting).toBe(0);
  });
});
