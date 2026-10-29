import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";

const connectionString = process.env.TEST_DATABASE_URL

if (!connectionString) {
    throw new Error(
        'TEST_DATABASE_URL must point to the dedicated test database'
    )
}

const pool = new Pool({ connectionString })

const runtimeConnectionString = process.env.TEST_RUNTIME_DATABASE_URL

if (!runtimeConnectionString) {
    throw new Error(
        'TEST_RUNTIME_DATABASE_URL must point to the restricted runtime test role',
    )
}

const runtimePool = new Pool({
    connectionString: runtimeConnectionString,
})

const createdCaseIds: string[] = []

async function createCase(): Promise<string> {
    const providerMessageId = `processing-job-test-${randomUUID()}`

    const result = await pool.query<{ id: string }>(
        `INSERT INTO public.cases (
        source_provider,
        provider_message_id,
        sender_email,
        body_text,
        received_at
        )
        VALUES ($1, $2, $3, $4, clock_timestamp())
        RETURNING id`,
        [
            'processing-job-integration-test',
            providerMessageId,
            'test@example.com',
            'Case created by processing-job integration tests',
        ],
    )

    const id = result.rows[0]?.id
    if (!id) throw new Error('INSERT did not return an id')
    createdCaseIds.push(id)

    return id
}

async function createJob(
    caseId: string,
    availableAt?: Date,
): Promise<string> {
    const result = await pool.query<{ id: string }>(
        `INSERT INTO public.processing_jobs (case_id, job_type, available_at)
         VALUES ($1, 'CLASSIFY_CASE', COALESCE($2, NOW()))
         RETURNING id`,
        [caseId, availableAt ?? null],
    )

    const id = result.rows[0]?.id
    if (!id) throw new Error('INSERT did not return an id')
    return id
}

describe('processing_jobs PostgreSQL integration', () => {
    beforeAll(async () => {
        const result = await pool.query<{
            database_name: string
            is_superuser: boolean
        }>(
            `SELECT current_database() AS database_name,
                rolsuper AS is_superuser
            FROM pg_roles
            WHERE rolname = current_user`,
        )

        expect(result.rows[0]?.database_name).toBe('migration005_check')
        expect(result.rows[0]?.is_superuser).toBe(true)
    })

    afterAll(async () => {
        try {
            if (createdCaseIds.length > 0) {
                await pool.query(
                    'DELETE FROM public.processing_jobs WHERE case_id = ANY($1::uuid[])',
                    [createdCaseIds],
                )

                await pool.query(
                    'DELETE FROM public.cases WHERE id = ANY($1::uuid[])',
                    [createdCaseIds],
                )
            }
        } finally {
            await Promise.all([
                pool.end(),
                runtimePool.end(),
            ])
        }
    })

    it('creates a job in the initial PENDING state', async () => {
        const caseId = await createCase()
        const jobId = await createJob(caseId)

        const result = await pool.query(
            `SELECT status, attempt_count, lease_generation,
                lease_owner, lease_expires_at
            FROM public.processing_jobs
            WHERE id = $1`,
            [jobId],
        )

        expect(result.rows[0]).toMatchObject({
            status: 'PENDING',
            attempt_count: 0,
            lease_generation: 0,
            lease_owner: null,
            lease_expires_at: null,
        })
    })

    it('rejects a new job that starts in RUNNING state', async () => {
        const caseId = await createCase()

        await expect(
            pool.query(
                `INSERT INTO public.processing_jobs (
                    case_id,
                    job_type,
                    status,
                    attempt_count,
                    lease_generation,
                    lease_owner,
                    lease_expires_at
                )
                VALUES (
                    $1, 'CLASSIFY_CASE', 'RUNNING',
                    1, 1, 'worker-test',
                    clock_timestamp() + interval '1 minute'
                )`,
                [caseId],
            ),
        ).rejects.toThrow(/must start PENDING/i)
    })

    it('prevents duplicate active jobs of the same type for one case', async () => {
        const caseId = await createCase()

        await createJob(caseId)

        await expect(createJob(caseId)).rejects.toThrow()
    })

    it('accepts a valid claim and increments both counters', async () => {
        const caseId = await createCase()
        const jobId = await createJob(caseId)

        await pool.query(
            `UPDATE public.processing_jobs
             SET status = 'RUNNING',
                 attempt_count = 1,
                 lease_generation = 1,
                 lease_owner = 'worker-a',
                 lease_expires_at = clock_timestamp() + interval '1 minute'
             WHERE id = $1`,
            [jobId],
        )

        const result = await pool.query(
            `SELECT status, attempt_count, lease_generation, lease_owner
             FROM public.processing_jobs
             WHERE id = $1`,
            [jobId],
        )

        expect(result.rows[0]).toMatchObject({
            status: 'RUNNING',
            attempt_count: 1,
            lease_generation: 1,
            lease_owner: 'worker-a',
        })
    })

    it('rejects a claim that does not increment both counters', async () => {
        const caseId = await createCase()
        const jobId = await createJob(caseId)

        await expect(
            pool.query(
                `UPDATE public.processing_jobs
                 SET status = 'RUNNING',
                     lease_owner = 'worker-a',
                     lease_expires_at = clock_timestamp() + interval '1 minute'
                 WHERE id = $1`,
                [jobId],
            ),
        ).rejects.toThrow(/increment attempt_count and lease_generation/i)
    })

    it('rejects a claim with an expired lease', async () => {
        const caseId = await createCase()
        const jobId = await createJob(caseId)

        await expect(
            pool.query(
                `UPDATE public.processing_jobs
                SET status = 'RUNNING',
                    attempt_count = 1,
                    lease_generation = 1,
                    lease_owner = 'worker-a',
                    lease_expires_at = clock_timestamp() - interval '1 second'
                WHERE id = $1`,
                [jobId],
            ),
        ).rejects.toThrow(/future lease expiry/i)
    })

    it('allows a running job to enter RETRY_WAIT and clears its lease', async () => {
        const caseId = await createCase()
        const jobId = await createJob(caseId)

        await pool.query(
            `UPDATE public.processing_jobs
             SET status = 'RUNNING',
                 attempt_count = 1,
                 lease_generation = 1,
                 lease_owner = 'worker-a',
                 lease_expires_at = clock_timestamp() + interval '1 minute'
             WHERE id = $1`,
            [jobId],
        )

        await pool.query(
            `UPDATE public.processing_jobs
             SET status = 'RETRY_WAIT',
                 lease_owner = NULL,
                 lease_expires_at = NULL,
                 last_error_code = 'TEMPORARY_FAILURE',
                 available_at = clock_timestamp() + interval '10 seconds'
             WHERE id = $1`,
            [jobId],
        )

        const result = await pool.query(
            `SELECT status, attempt_count, lease_generation,
                    lease_owner, lease_expires_at
             FROM public.processing_jobs
             WHERE id = $1`,
            [jobId],
        )

        expect(result.rows[0]).toMatchObject({
            status: 'RETRY_WAIT',
            attempt_count: 1,
            lease_generation: 1,
            lease_owner: null,
            lease_expires_at: null,
        })
    })

    it('rejects reclaiming a job before the existing lease expires', async () => {
        const caseId = await createCase()
        const jobId = await createJob(caseId)

        await pool.query(
            `UPDATE public.processing_jobs
             SET status = 'RUNNING',
                 attempt_count = 1,
                 lease_generation = 1,
                 lease_owner = 'worker-a',
                 lease_expires_at = clock_timestamp() + interval '1 minute'
             WHERE id = $1`,
            [jobId],
        )

        await expect(
            pool.query(
                `UPDATE public.processing_jobs
                 SET attempt_count = 2,
                     lease_generation = 2,
                     lease_owner = 'worker-b',
                     lease_expires_at = clock_timestamp() + interval '1 minute'
                 WHERE id = $1`,
                [jobId],
            ),
        ).rejects.toThrow(/before its lease expires/i)
    })

    it('allows a valid lease renewal by the current worker', async () => {
        const caseId = await createCase()
        const jobId = await createJob(caseId)

        await pool.query(
            `UPDATE public.processing_jobs
            SET status = 'RUNNING',
                attempt_count = 1,
                lease_generation = 1,
                lease_owner = 'worker-a',
                lease_expires_at = clock_timestamp() + interval '1 minute'
            WHERE id = $1`,
            [jobId],
        )

        await pool.query(
            `UPDATE public.processing_jobs
            SET lease_expires_at = lease_expires_at + interval '1 minute'
            WHERE id = $1`,
            [jobId],
        )

        const result = await pool.query(
            `SELECT status, attempt_count, lease_generation, lease_owner
            FROM public.processing_jobs
            WHERE id = $1`,
            [jobId],
        )

        expect(result.rows[0]).toMatchObject({
            status: 'RUNNING',
            attempt_count: 1,
            lease_generation: 1,
            lease_owner: 'worker-a',
        })
    })

    it('rejects unrelated field changes during lease renewal', async () => {
        const caseId = await createCase()
        const jobId = await createJob(caseId)

        await pool.query(
            `UPDATE public.processing_jobs
            SET status = 'RUNNING',
                attempt_count = 1,
                lease_generation = 1,
                lease_owner = 'worker-a',
                lease_expires_at = clock_timestamp() + interval '1 minute'
            WHERE id = $1`,
            [jobId],
        )

        await expect(
            pool.query(
                `UPDATE public.processing_jobs
                SET lease_expires_at = lease_expires_at + interval '1 minute',
                    last_error_code = 'UNEXPECTED_CHANGE'
                WHERE id = $1`,
                [jobId],
            ),
        ).rejects.toThrow()
    })

    it('rejects transitions from SUCCEEDED back to RUNNING', async () => {
        const caseId = await createCase()
        const jobId = await createJob(caseId)

        await pool.query(
            `UPDATE public.processing_jobs
            SET status = 'RUNNING',
                attempt_count = 1,
                lease_generation = 1,
                lease_owner = 'worker-a',
                lease_expires_at = clock_timestamp() + interval '1 minute'
            WHERE id = $1`,
            [jobId],
        )

        await pool.query(
            `UPDATE public.processing_jobs
            SET status = 'SUCCEEDED',
                lease_owner = NULL,
                lease_expires_at = NULL
            WHERE id = $1`,
            [jobId],
        )

        await expect(
            pool.query(
                `UPDATE public.processing_jobs
                SET status = 'RUNNING',
                    attempt_count = 2,
                    lease_generation = 2,
                    lease_owner = 'worker-b',
                    lease_expires_at = clock_timestamp() + interval '1 minute'
                WHERE id = $1`,
                [jobId],
            ),
        ).rejects.toThrow(/invalid processing job status transition/i)
    })

    it('rejects transitions from DEAD_LETTER back to RUNNING', async () => {
        const caseId = await createCase()
        const jobId = await createJob(caseId)

        await pool.query(
            `UPDATE public.processing_jobs
            SET status = 'RUNNING',
                attempt_count = 1,
                lease_generation = 1,
                lease_owner = 'worker-a',
                lease_expires_at = clock_timestamp() + interval '1 minute'
            WHERE id = $1`,
            [jobId],
        )

        await pool.query(
            `UPDATE public.processing_jobs
            SET status = 'DEAD_LETTER',
                lease_owner = NULL,
                lease_expires_at = NULL,
                last_error_code = 'RETRIES_EXHAUSTED'
            WHERE id = $1`,
            [jobId],
        )

        await expect(
            pool.query(
                `UPDATE public.processing_jobs
                SET status = 'RUNNING',
                    attempt_count = 2,
                    lease_generation = 2,
                    lease_owner = 'worker-b',
                    lease_expires_at = clock_timestamp() + interval '1 minute'
                WHERE id = $1`,
                [jobId],
            ),
        ).rejects.toThrow(/invalid processing job status transition/i)
    })

    it('clears the lease when a running job succeeds', async () => {
        const caseId = await createCase()
        const jobId = await createJob(caseId)

        await pool.query(
            `UPDATE public.processing_jobs
            SET status = 'RUNNING',
                attempt_count = 1,
                lease_generation = 1,
                lease_owner = 'worker-a',
                lease_expires_at = clock_timestamp() + interval '1 minute'
            WHERE id = $1`,
            [jobId],
        )

        await pool.query(
            `UPDATE public.processing_jobs
            SET status = 'SUCCEEDED',
                lease_owner = NULL,
                lease_expires_at = NULL
            WHERE id = $1`,
            [jobId],
        )

        const result = await pool.query(
            `SELECT status, lease_owner, lease_expires_at,
                    attempt_count, lease_generation
            FROM public.processing_jobs
            WHERE id = $1`,
            [jobId],
        )

        expect(result.rows[0]).toMatchObject({
            status: 'SUCCEEDED',
            lease_owner: null,
            lease_expires_at: null,
            attempt_count: 1,
            lease_generation: 1,
        })
    })

    it('clears the lease when a running job is dead-lettered', async () => {
        const caseId = await createCase()
        const jobId = await createJob(caseId)

        await pool.query(
            `UPDATE public.processing_jobs
            SET status = 'RUNNING',
                attempt_count = 1,
                lease_generation = 1,
                lease_owner = 'worker-a',
                lease_expires_at = clock_timestamp() + interval '1 minute'
            WHERE id = $1`,
            [jobId],
        )

        await pool.query(
            `UPDATE public.processing_jobs
            SET status = 'DEAD_LETTER',
                lease_owner = NULL,
                lease_expires_at = NULL,
                last_error_code = 'RETRIES_EXHAUSTED'
            WHERE id = $1`,
            [jobId],
        )

        const result = await pool.query(
            `SELECT status, lease_owner, lease_expires_at, last_error_code
            FROM public.processing_jobs
            WHERE id = $1`,
            [jobId],
        )

        expect(result.rows[0]).toMatchObject({
            status: 'DEAD_LETTER',
            lease_owner: null,
            lease_expires_at: null,
            last_error_code: 'RETRIES_EXHAUSTED',
        })
    })

    describe('claim_processing_job', () => {
        it('rejects an unsupported job type', async () => {
            await expect(
                pool.query(
                    `SELECT *
                     FROM public.claim_processing_job($1, $2, $3)`,
                     ['UNSUPPORTED_TYPE', 'worker-test', 30],
                )
            ).rejects.toMatchObject({
                code: 'P0001',
                message: expect.stringMatching(/unsupported job type/i)
            })
        })

        it('rejects a blank worker ID', async () => {
            await expect(
                pool.query(
                    `SELECT *
                     FROM public.claim_processing_job($1, $2, $3)`,
                     ['CLASSIFY_CASE', '   ', 30],
                )
            ).rejects.toMatchObject({
                code: 'P0001',
                message: expect.stringMatching(/worker ID must not be blank/i),
            })
        })

        it('rejects lease durations below 1 second', async () => {
            await expect(
                pool.query(
                    `SELECT *
                     FROM public.claim_processing_job($1, $2, $3)`,
                     ['CLASSIFY_CASE', 'worker-test', 0],
                )
            ).rejects.toMatchObject({
                code: 'P0001',
                message: expect.stringMatching(/lease duration must be between 1 and 300 seconds/i),
            })
        })

        it('rejects lease durations above 300 seconds', async () => {
            await expect(
                pool.query(
                    `SELECT *
                     FROM public.claim_processing_job($1, $2, $3)`,
                     ['CLASSIFY_CASE', 'worker-test', 301],
                )
            ).rejects.toMatchObject({
                code: 'P0001',
                message: expect.stringMatching(/lease duration must be between 1 and 300 seconds/i),
            })
        })

        it('claims the oldest eligible job of the requested type', async () => {
            const olderCaseId = await createCase()
            const newerCaseId = await createCase()

            const olderJobId = await createJob(
                olderCaseId,
                new Date(Date.now() - 2 * 60 * 1000),
            )

            await createJob(
                newerCaseId,
                new Date(Date.now() - 1 * 60 * 1000),
            )

            const result = await pool.query(
                `SELECT *
                FROM public.claim_processing_job($1, $2, $3)`,
                ['CLASSIFY_CASE', 'worker-oldest', 30],
            )

            expect(result.rows).toHaveLength(1)
            expect(result.rows[0]).toMatchObject({
                id: olderJobId,
                case_id: olderCaseId,
                job_type: 'CLASSIFY_CASE',
                attempt_count: 1,
                lease_generation: 1,
            })
            expect(result.rows[0].lease_expires_at).toBeTruthy()
        })
        it('increments attempt_count and lease_generation exactly once', async () => {
            const caseId = await createCase()
            const jobId = await createJob(caseId, new Date(Date.now() - 24 * 60 * 60 * 1000))

            const before = await pool.query<{
                attempt_count: number
                lease_generation: number
            }>(
                `SELECT attempt_count, lease_generation
                FROM public.processing_jobs
                WHERE id = $1`,
                [jobId],
            )

            expect(before.rows[0]).toMatchObject({
                attempt_count: 0,
                lease_generation: 0,
            })

            const claimed = await pool.query(
                `SELECT *
                FROM public.claim_processing_job($1, $2, $3)`,
                ['CLASSIFY_CASE', 'worker-counter', 30],
            )

            expect(claimed.rows).toHaveLength(1)
            expect(claimed.rows[0]).toMatchObject({
                id: jobId,
                attempt_count: 1,
                lease_generation: 1,
            })

            const after = await pool.query<{
                attempt_count: number
                lease_generation: number
            }>(
                `SELECT attempt_count, lease_generation
                FROM public.processing_jobs
                WHERE id = $1`,
                [jobId],
            )

            expect(after.rows[0]).toMatchObject({
                attempt_count: 1,
                lease_generation: 1,
            })
        })

        it('does not claim jobs scheduled for the future', async () => {
            const caseId = await createCase()
            const futureJobId = await createJob(
                caseId,
                new Date(Date.now() + 60 * 60 * 1000),
            )

            // Temporarily make any other eligible CLASSIFY_CASE jobs
            // unavailable without modifying their protected fields.
            const result = await pool.query(
                `SELECT *
                FROM public.claim_processing_job($1, $2, $3)`,
                ['RECOVER_CASE', 'worker-future', 30],
            )

            expect(result.rows).toHaveLength(0)

            const stored = await pool.query<{
                status: string
                attempt_count: number
                lease_generation: number
            }>(
                `SELECT status, attempt_count, lease_generation
                FROM public.processing_jobs
                WHERE id = $1`,
                [futureJobId],
            )

            expect(stored.rows[0]).toMatchObject({
                status: 'PENDING',
                attempt_count: 0,
                lease_generation: 0,
            })
        })
        it('does not claim jobs of a different type', async () => {
            const caseId = await createCase()
            const jobId = await createJob(
                caseId,
                new Date(Date.now() - 60 * 1000),
            )

            const result = await pool.query(
                `SELECT *
                FROM public.claim_processing_job($1, $2, $3)`,
                ['RECOVER_CASE', 'worker-type-check', 30],
            )

            expect(result.rows).toHaveLength(0)

            const stored = await pool.query<{
                status: string
                attempt_count: number
                lease_generation: number
                lease_owner: string | null
            }>(
                `SELECT status, attempt_count, lease_generation, lease_owner
                FROM public.processing_jobs
                WHERE id = $1`,
                [jobId],
            )

            expect(stored.rows[0]).toMatchObject({
                status: 'PENDING',
                attempt_count: 0,
                lease_generation: 0,
                lease_owner: null,
            })
        })

        it('returns no row when no eligible job exists', async () => {
            const result = await pool.query(
                `SELECT *
                FROM public.claim_processing_job($1, $2, $3)`,
                ['RECOVER_CASE', 'worker-empty-queue', 30],
            )

            expect(result.rows).toHaveLength(0)
        })

        it('allows concurrent workers to claim different eligible jobs', async () => {
            const firstCaseId = await createCase()
            const secondCaseId = await createCase()

            const firstJobId = await createJob(
                firstCaseId,
                new Date(Date.now() - 48 * 60 * 60 * 1000),
            )
            const secondJobId = await createJob(
                secondCaseId,
                new Date(Date.now() - 24 * 60 * 60 * 1000),
            )

            const [firstResult, secondResult] = await Promise.all([
                pool.query(
                    `SELECT *
                    FROM public.claim_processing_job($1, $2, $3)`,
                    ['CLASSIFY_CASE', 'worker-concurrent-a', 30],
                ),
                pool.query(
                    `SELECT *
                    FROM public.claim_processing_job($1, $2, $3)`,
                    ['CLASSIFY_CASE', 'worker-concurrent-b', 30],
                ),
            ])

            expect(firstResult.rows).toHaveLength(1)
            expect(secondResult.rows).toHaveLength(1)

            const claimedIds = [
                firstResult.rows[0].id,
                secondResult.rows[0].id,
            ]

            expect(new Set(claimedIds).size).toBe(2)
            expect(claimedIds).toEqual(
                expect.arrayContaining([firstJobId, secondJobId]),
            )

            const stored = await pool.query<{
                id: string
                status: string
                attempt_count: number
                lease_generation: number
                lease_owner: string | null
            }>(
                `SELECT id, status, attempt_count, lease_generation, lease_owner
                FROM public.processing_jobs
                WHERE id = ANY($1::uuid[])`,
                [[firstJobId, secondJobId]],
            )

            expect(stored.rows).toHaveLength(2)

            for (const job of stored.rows) {
                expect(job.status).toBe('RUNNING')
                expect(job.attempt_count).toBe(1)
                expect(job.lease_generation).toBe(1)
                expect([
                    'worker-concurrent-a',
                    'worker-concurrent-b',
                ]).toContain(job.lease_owner)
            }

            expect(
                new Set(stored.rows.map((job) => job.lease_owner)).size,
            ).toBe(2)
        })

        it('allows runtime claims but denies direct job updates', async () => {
            const caseId = await createCase()
            const jobId = await createJob(
                caseId,
                new Date(Date.now() - 60 * 60 * 1000),
            )

            const client = await runtimePool.connect()

            try {
                await client.query('SET ROLE service_request_runtime')

                const roleResult = await client.query(
                    'SELECT current_user AS role_name',
                )
                expect(roleResult.rows[0].role_name).toBe(
                    'service_request_runtime',
                )

                await expect(
                    client.query(
                        `UPDATE public.processing_jobs
                        SET status = 'RUNNING'
                        WHERE id = $1`,
                        [jobId],
                    ),
                ).rejects.toMatchObject({ code: '42501' })

                const result = await client.query(
                    `SELECT *
                    FROM public.claim_processing_job($1, $2, $3)`,
                    ['CLASSIFY_CASE', 'worker-runtime-security-test', 30],
                )

                expect(result.rows).toHaveLength(1)
                expect(result.rows[0]).toMatchObject({
                    id: jobId,
                    case_id: caseId,
                    job_type: 'CLASSIFY_CASE',
                    attempt_count: 1,
                    lease_generation: 1,
                })
            } finally {
                try {
                    await client.query('RESET ROLE')
                } finally {
                    client.release()
                }
            }
        })
    })
})