

import {
  classificationOutputSchema,
  type ClassificationOutput,
} from './classification.schema.js';

export const DEFAULT_REVIEW_CONFIDENCE_THRESHOLD = 0.75;

export type ClassificationDecision =
  | {
      outcome: 'ready_for_routing';
      classification: ClassificationOutput;
    }
  | {
      outcome: 'human_review';
      reason: 'LOW_CONFIDENCE';
      classification: ClassificationOutput;
    }
  | {
      outcome: 'invalid_output';
    };

export function evaluateClassification(
  output: unknown,
  threshold = DEFAULT_REVIEW_CONFIDENCE_THRESHOLD,
): ClassificationDecision {
  if (
    !Number.isFinite(threshold) ||
    threshold < 0 ||
    threshold > 1
  ) {
    throw new RangeError(
      'Classification threshold must be between 0 and 1',
    );
  }

  const parsed = classificationOutputSchema.safeParse(output);

  if (!parsed.success) {
    return { outcome: 'invalid_output' };
  }

  const classification = parsed.data;

  if (classification.confidence < threshold) {
    return {
      outcome: 'human_review',
      reason: 'LOW_CONFIDENCE',
      classification,
    };
  }

  return {
    outcome: 'ready_for_routing',
    classification,
  };
}
