
import { describe, expect, it } from 'vitest';

import {
    attachmentMetadataSchema,
    normalizedEmailSchema,
} from '../../src/modules/intake/normalized-email.schema.js';

const validEmail = {
    source: 'email',
    provider: 'example-provider',
    mailboxId: 'support-inbox',
    providerMessageId: 'msg-example-001',
    threadId: 'thread-example-001',
    sender: {
        email: 'customer@example.com',
    },
    subject: 'Payment still pending',
    bodyText: 'My payment has been pending since yesterday.',
    receivedAt: '2026-10-20T09:30:00+03:00',
    attachmentMetadata: [],
};

describe('normalizedEmailSchema', () => {
    it('accepts a valid normalized email', () => {
        expect(normalizedEmailSchema.safeParse(validEmail).success)
            .toBe(true);
    });

    it('accepts empty subject and body text', () => {
        const result = normalizedEmailSchema.safeParse({
            ...validEmail,
            subject: '',
            bodyText: '',
        });

        expect(result.success).toBe(true);
    });

    it('accepts a timestamp expressed in UTC', () => {
        const result = normalizedEmailSchema.safeParse({
            ...validEmail,
            receivedAt: '2026-10-20T06:30:00Z',
        });

        expect(result.success).toBe(true);
    });

    it.each([
        ['missing provider', { provider: undefined }],
        ['blank mailbox ID', { mailboxId: '   ' }],
        ['missing message ID', { providerMessageId: undefined }],
        ['unsupported source', { source: 'telegram' }],
        ['invalid sender email', {
            sender: { email: 'not-an-email' },
        }],
        ['invalid timestamp', { receivedAt: 'not-a-date' }],
        ['timestamp without timezone', {
            receivedAt: '2026-10-20T09:30:00',
        }],
        ['missing attachment metadata', {
            attachmentMetadata: undefined,
        }],
    ])('rejects %s', (_description, override) => {
        const result = normalizedEmailSchema.safeParse({
            ...validEmail,
            ...override,
        });

        expect(result.success).toBe(false);
    });

    it('rejects an invalid source type even when the other fields are valid', () => {
        expect(
            normalizedEmailSchema.safeParse({
                ...validEmail,
                source: 'web',
            }).success,
        ).toBe(false);
    });

    it('rejects a blank provider identifier', () => {
        expect(
            normalizedEmailSchema.safeParse({
                ...validEmail,
                provider: ' ',
            }).success,
        ).toBe(false);
    });

    it('rejects unknown top-level properties', () => {
        const result = normalizedEmailSchema.safeParse({
            ...validEmail,
            unexpectedField: 'not allowed',
        });

        expect(result.success).toBe(false);
    });

    it('rejects unknown sender properties', () => {
        const result = normalizedEmailSchema.safeParse({
            ...validEmail,
            sender: {
                ...validEmail.sender,
                displayName: 'Customer',
            },
        });

        expect(result.success).toBe(false);
    });
});

describe('attachmentMetadataSchema', () => {
    const validAttachment = {
        filename: 'receipt.pdf',
        mimeType: 'application/pdf',
        sizeBytes: 1024,
        providerAttachmentId: 'attachment-001',
    };

    it('accepts valid attachment metadata', () => {
        expect(
            attachmentMetadataSchema.safeParse(validAttachment).success,
        ).toBe(true);
    });

    it('allows an omitted provider attachment ID', () => {
        const attachment: Partial<typeof validAttachment> = { ...validAttachment };
        delete attachment.providerAttachmentId;

        expect(
            attachmentMetadataSchema.safeParse(attachment).success,
        ).toBe(true);
    });

    it.each([-1, 1.5, NaN, Infinity])(
        'rejects invalid attachment size %s',
        (sizeBytes) => {
            expect(
                attachmentMetadataSchema.safeParse({
                    ...validAttachment,
                    sizeBytes,
                }).success,
            ).toBe(false);
        },
    );

    it('rejects blank filenames and MIME types', () => {
        expect(
            attachmentMetadataSchema.safeParse({
                ...validAttachment,
                filename: ' ',
            }).success,
        ).toBe(false);

        expect(
            attachmentMetadataSchema.safeParse({
                ...validAttachment,
                mimeType: '',
            }).success,
        ).toBe(false);
    });

    it('rejects attachment contents and unknown attachment properties', () => {
        expect(
            attachmentMetadataSchema.safeParse({
                ...validAttachment,
                content: 'not allowed',
            }).success,
        ).toBe(false);
    });
});
