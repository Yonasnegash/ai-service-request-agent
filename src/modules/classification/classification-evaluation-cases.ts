import type { ClassificationCategory } from "./classification.schema.js";

export interface ClassificationEvaluationCase {
  id: string;
  input: {
    subject: string;
    bodyText: string;
  };
  expectedCategory: ClassificationCategory;
  expectedDecision: 'ready_for_routing' | 'human_review';
}

export const classificationEvaluationCases: ClassificationEvaluationCase[] = [
  {
    id: 'payment-001',
    input: {
      subject: 'Payment failed',
      bodyText: 'My payment was debited, but the merchant says it was not received.',
    },
    expectedCategory: 'payment_issue',
    expectedDecision: 'ready_for_routing',
  },
  {
    id: 'payment-002',
    input: {
      subject: 'Refund or failed payment?',
      bodyText: 'I cannot tell whether my payment failed or whether I should request a refund.',
    },
    expectedCategory: 'payment_issue',
    expectedDecision: 'human_review',
  },
  {
    id: 'account-001',
    input: {
      subject: 'Cannot access my account',
      bodyText: 'I cannot sign in even after resetting my password.',
    },
    expectedCategory: 'account_support',
    expectedDecision: 'ready_for_routing',
  },
  {
    id: 'account-002',
    input: {
      subject: 'Account access and payment',
      bodyText: 'I cannot access my account, and I need to check a recent transaction.',
    },
    expectedCategory: 'account_support',
    expectedDecision: 'human_review',
  },
  {
    id: 'technical-001',
    input: {
      subject: 'Application crashes',
      bodyText: 'The mobile application closes every time I open the transaction history.',
    },
    expectedCategory: 'technical_support',
    expectedDecision: 'ready_for_routing',
  },
  {
    id: 'technical-002',
    input: {
      subject: 'Transaction not visible',
      bodyText: 'A transaction is missing from the application, but I am unsure whether this is a technical or payment problem.',
    },
    expectedCategory: 'technical_support',
    expectedDecision: 'human_review',
  },
  {
    id: 'complaint-001',
    input: {
      subject: 'Formal complaint about service',
      bodyText: 'I am dissatisfied with how my previous support request was handled and want to make a formal complaint.',
    },
    expectedCategory: 'complaint',
    expectedDecision: 'ready_for_routing',
  },
  {
    id: 'complaint-002',
    input: {
      subject: 'Unhappy with a transaction',
      bodyText: 'I am unhappy about a transaction, but I have not explained whether it failed or was processed incorrectly.',
    },
    expectedCategory: 'complaint',
    expectedDecision: 'human_review',
  },
  {
    id: 'other-001',
    input: {
      subject: 'Office opening hours',
      bodyText: 'Could you tell me the opening hours of your nearest branch?',
    },
    expectedCategory: 'other',
    expectedDecision: 'ready_for_routing',
  },
  {
    id: 'other-002',
    input: {
      subject: 'Please help',
      bodyText: 'I need assistance with something, but I have not included any details about the problem.',
    },
    expectedCategory: 'other',
    expectedDecision: 'human_review',
  },
];
