
import { z } from 'zod';

const nonBlankString = z.string().refine(
    (value) => value.trim().length > 0,
    'Must not be blank',
);

const timestampWithTimezone = z.iso.datetime({
    offset: true,
});

export const attachmentMetadataSchema = z
    .object({
        filename: nonBlankString,
        mimeType: nonBlankString,
        sizeBytes: z.number().int().nonnegative(),
        providerAttachmentId: nonBlankString.optional(),
    })
    .strict();

export const normalizedEmailSchema = z.object({
    source: z.literal('email'),
    provider: nonBlankString,
    mailboxId: nonBlankString,
    providerMessageId: nonBlankString,
    threadId: z.string().optional(),
    sender: z.object({
        email: z.email(),
    }).strict(),
    subject: z.string(),
    bodyText: z.string(),
    receivedAt: timestampWithTimezone,
    attachmentMetadata: z.array(attachmentMetadataSchema),
}).strict();

export type NormalizedEmail = z.infer<typeof normalizedEmailSchema>;
export type AttachmentMetadata = z.infer<
    typeof attachmentMetadataSchema
>;
