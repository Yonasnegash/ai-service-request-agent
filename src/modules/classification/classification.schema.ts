
import { z } from 'zod';

export const classificationCategories = [
  'payment_issue',
  'account_support',
  'technical_support',
  'complaint',
  'other',
] as const;

export const classificationInputSchema = z
  .object({
    subject: z.string(),
    bodyText: z.string(),
  })
  .strict();

export const classificationOutputSchema = z
  .object({
    category: z.enum(classificationCategories),
    confidence: z.number().min(0).max(1),
    rationale: z.string().trim().min(1).max(500),
  })
  .strict();

export type ClassificationInput = z.infer<
  typeof classificationInputSchema
>;

export type ClassificationCategory =
  (typeof classificationCategories)[number];

export type ClassificationOutput = z.infer<
  typeof classificationOutputSchema
>;
