
import type { CaseClassifier } from './case-classifier.js';
import {
  classificationCategories,
  type ClassificationCategory,
} from './classification.schema.js';
import { evaluateClassification } from './classification.policy.js';
import type { ClassificationEvaluationCase } from './classification-evaluation-cases.js';

export type EvaluationOutcome =
  | 'ready_for_routing'
  | 'human_review'
  | 'invalid_output'
  | 'classifier_error';

export interface EvaluationPrediction {
  caseId: string;
  expectedCategory: ClassificationCategory;
  predictedCategory: ClassificationCategory | null;
  expectedDecision: 'ready_for_routing' | 'human_review';
  outcome: EvaluationOutcome;
  categoryCorrect: boolean;
}

export interface CategoryMetrics {
  support: number;
  correct: number;
  accuracy: number;
}

export interface ClassificationEvaluationReport {
  total: number;
  correct: number;
  accuracy: number;
  readyForRouting: number;
  humanReview: number;
  invalidOutputs: number;
  classifierErrors: number;
  reviewRate: number;
  categoryMetrics: Record<ClassificationCategory, CategoryMetrics>;
  confusionMatrix: Record<
    ClassificationCategory,
    Record<ClassificationCategory | 'INVALID_OUTPUT' | 'CLASSIFIER_ERROR', number>
  >;
  predictions: EvaluationPrediction[];
}

type ConfusionLabel =
  | ClassificationCategory
  | 'INVALID_OUTPUT'
  | 'CLASSIFIER_ERROR';

export async function evaluateClassifier(
  classifier: CaseClassifier,
  cases: readonly ClassificationEvaluationCase[],
  threshold?: number,
): Promise<ClassificationEvaluationReport> {
  const predictions: EvaluationPrediction[] = [];

  for (const testCase of cases) {
    let output: unknown;

    try {
      output = await classifier.classify(testCase.input);
    } catch {
      predictions.push({
        caseId: testCase.id,
        expectedCategory: testCase.expectedCategory,
        predictedCategory: null,
        expectedDecision: testCase.expectedDecision,
        outcome: 'classifier_error',
        categoryCorrect: false,
      });
      continue;
    }

    const decision =
      threshold === undefined
        ? evaluateClassification(output)
        : evaluateClassification(output, threshold);

    if (decision.outcome === 'invalid_output') {
      predictions.push({
        caseId: testCase.id,
        expectedCategory: testCase.expectedCategory,
        predictedCategory: null,
        expectedDecision: testCase.expectedDecision,
        outcome: 'invalid_output',
        categoryCorrect: false,
      });
      continue;
    }

    predictions.push({
      caseId: testCase.id,
      expectedCategory: testCase.expectedCategory,
      predictedCategory: decision.classification.category,
      expectedDecision: testCase.expectedDecision,
      outcome: decision.outcome,
      categoryCorrect:
        decision.classification.category === testCase.expectedCategory,
    });
  }

  const total = predictions.length;
  const correct = predictions.filter(
    (prediction) => prediction.categoryCorrect,
  ).length;

  const categoryMetrics = Object.fromEntries(
    classificationCategories.map((category) => {
      const categoryPredictions = predictions.filter(
        (prediction) => prediction.expectedCategory === category,
      );
      const categoryCorrect = categoryPredictions.filter(
        (prediction) => prediction.categoryCorrect,
      ).length;

      return [
        category,
        {
          support: categoryPredictions.length,
          correct: categoryCorrect,
          accuracy:
            categoryPredictions.length === 0
              ? 0
              : categoryCorrect / categoryPredictions.length,
        },
      ];
    }),
  ) as Record<ClassificationCategory, CategoryMetrics>;

  const labels: ConfusionLabel[] = [
    ...classificationCategories,
    'INVALID_OUTPUT',
    'CLASSIFIER_ERROR',
  ];

  const confusionMatrix = Object.fromEntries(
    classificationCategories.map((expected) => [
      expected,
      Object.fromEntries(labels.map((predicted) => [predicted, 0])),
    ]),
  ) as ClassificationEvaluationReport['confusionMatrix'];

  for (const prediction of predictions) {
    const predictedLabel =
      prediction.outcome === 'invalid_output'
        ? 'INVALID_OUTPUT'
        : prediction.outcome === 'classifier_error'
          ? 'CLASSIFIER_ERROR'
          : prediction.predictedCategory!;

    confusionMatrix[prediction.expectedCategory][predictedLabel] += 1;
  }

  const readyForRouting = predictions.filter(
    (prediction) => prediction.outcome === 'ready_for_routing',
  ).length;
  const humanReview = predictions.filter(
    (prediction) => prediction.outcome === 'human_review',
  ).length;
  const invalidOutputs = predictions.filter(
    (prediction) => prediction.outcome === 'invalid_output',
  ).length;
  const classifierErrors = predictions.filter(
    (prediction) => prediction.outcome === 'classifier_error',
  ).length;

  return {
    total,
    correct,
    accuracy: total === 0 ? 0 : correct / total,
    readyForRouting,
    humanReview,
    invalidOutputs,
    classifierErrors,
    reviewRate: total === 0 ? 0 : humanReview / total,
    categoryMetrics,
    confusionMatrix,
    predictions,
  };
}
