
import { describe, expect, it } from 'vitest';

import {
  DEFAULT_REVIEW_CONFIDENCE_THRESHOLD,
  evaluateClassification,
} from '../../src/modules/classification/classification.policy.js';

const validOutput = {
  category: 'payment_issue',
  confidence: 0.9,
  rationale: 'The customer reports that a payment failed.',
};

describe('evaluateClassification', () => {
  it('uses a default confidence threshold of 0.75', () => {
    expect(DEFAULT_REVIEW_CONFIDENCE_THRESHOLD).toBe(0.75);
  });

  it('allows valid high-confidence output to proceed to routing', () => {
    expect(evaluateClassification(validOutput)).toEqual({
      outcome: 'ready_for_routing',
      classification: validOutput,
    });
  });

  it('sends low-confidence output to human review', () => {
    expect(
      evaluateClassification({
        ...validOutput,
        confidence: 0.74,
      }),
    ).toMatchObject({
      outcome: 'human_review',
      reason: 'LOW_CONFIDENCE',
    });
  });

  it('allows output exactly at the threshold', () => {
    expect(
      evaluateClassification({
        ...validOutput,
        confidence: 0.75,
      }).outcome,
    ).toBe('ready_for_routing');
  });

  it('rejects an unsupported category', () => {
    expect(
      evaluateClassification({
        ...validOutput,
        category: 'refund_approved',
      }),
    ).toEqual({ outcome: 'invalid_output' });
  });

  it.each([-0.1, 1.1, Number.NaN, Number.POSITIVE_INFINITY])(
    'rejects invalid confidence value %s',
    (confidence) => {
      expect(
        evaluateClassification({
          ...validOutput,
          confidence,
        }),
      ).toEqual({ outcome: 'invalid_output' });
    },
  );

  it('rejects an empty rationale', () => {
    expect(
      evaluateClassification({
        ...validOutput,
        rationale: '   ',
      }),
    ).toEqual({ outcome: 'invalid_output' });
  });

  it('rejects unexpected fields', () => {
    expect(
      evaluateClassification({
        ...validOutput,
        senderEmail: 'customer@example.com',
      }),
    ).toEqual({ outcome: 'invalid_output' });
  });

  it('rejects a threshold outside the valid range', () => {
    expect(() =>
      evaluateClassification(validOutput, 1.1),
    ).toThrow(RangeError);
  });
});
