
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import type { CaseClassifier } from './case-classifier.js';
import { evaluateClassifier } from './classification-evaluator.js';
import { classificationEvaluationCases } from './classification-evaluation-cases.js';

const confidenceThreshold = 0.75;

const expectedByInput = new Map(
  classificationEvaluationCases.map((testCase) => [
    JSON.stringify(testCase.input),
    testCase,
  ]),
);

const smokeTestClassifier: CaseClassifier = {
  async classify(input) {
    const testCase = expectedByInput.get(JSON.stringify(input));

    if (!testCase) {
      throw new Error('Input does not match an evaluation fixture');
    }

    return {
      category: testCase.expectedCategory,
      confidence:
        testCase.expectedDecision === 'human_review'
          ? 0.4
          : confidenceThreshold,
      rationale: 'Deterministic evaluation pipeline smoke test.',
    };
  },
};

async function main(): Promise<void> {
  const evaluation = await evaluateClassifier(
    smokeTestClassifier,
    classificationEvaluationCases,
    confidenceThreshold,
  );

  const generatedAt = new Date().toISOString();
  const safeTimestamp = generatedAt.replace(/[:.]/g, '-');
  const outputDirectory = resolve(
    process.cwd(),
    'reports',
    'classification-evaluation',
  );
  const outputPath = resolve(
    outputDirectory,
    `smoke-test-${safeTimestamp}.json`,
  );

  const report = {
    generatedAt,
    mode: 'pipeline_smoke_test',
    warning:
      'This report uses expected fixture labels. It does not measure real AI classification quality.',
    threshold: confidenceThreshold,
    evaluation,
  };

  await mkdir(outputDirectory, { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');

  console.log('Classification evaluation smoke test completed.');
  console.log(`Examples: ${evaluation.total}`);
  console.log(`Category accuracy: ${(evaluation.accuracy * 100).toFixed(1)}%`);
  console.log(`Human review: ${evaluation.humanReview}`);
  console.log(`Invalid outputs: ${evaluation.invalidOutputs}`);
  console.log(`Classifier errors: ${evaluation.classifierErrors}`);
  console.log(`Report: ${outputPath}`);
}

main().catch((error: unknown) => {
  const message =
    error instanceof Error ? error.message : 'Unknown evaluation failure';

  console.error(`Classification evaluation failed: ${message}`);
  process.exitCode = 1;
});
