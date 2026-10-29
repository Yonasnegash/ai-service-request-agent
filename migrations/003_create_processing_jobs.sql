
BEGIN;

CREATE TABLE public.processing_jobs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    case_id UUID NOT NULL
        REFERENCES public.cases (id)
        ON DELETE RESTRICT,

    job_type TEXT NOT NULL
        CONSTRAINT processing_jobs_job_type_check
        CHECK (job_type IN ('CLASSIFY_CASE', 'RECOVER_CASE')),

    status TEXT NOT NULL DEFAULT 'PENDING'
        CONSTRAINT processing_jobs_status_check
        CHECK (
            status IN (
                'PENDING',
                'RUNNING',
                'RETRY_WAIT',
                'SUCCEEDED',
                'DEAD_LETTER'
            )
        ),

    attempt_count INTEGER NOT NULL DEFAULT 0
        CONSTRAINT processing_jobs_attempt_count_check
        CHECK (attempt_count >= 0),

    available_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),

    lease_owner TEXT,
    lease_expires_at TIMESTAMPTZ,

    lease_generation INTEGER NOT NULL DEFAULT 0
        CONSTRAINT processing_jobs_lease_generation_check
        CHECK (lease_generation >= 0),

    last_error_code TEXT,

    created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),

    CONSTRAINT processing_jobs_lease_consistency_check
        CHECK (
            (
                status = 'RUNNING'
                AND lease_owner IS NOT NULL
                AND btrim(lease_owner) <> ''
                AND lease_expires_at IS NOT NULL
            )
            OR
            (
                status <> 'RUNNING'
                AND lease_owner IS NULL
                AND lease_expires_at IS NULL
            )
        )
);

CREATE INDEX processing_jobs_case_id_idx
    ON public.processing_jobs (case_id);

CREATE UNIQUE INDEX processing_jobs_one_active_job_idx
    ON public.processing_jobs (case_id, job_type)
    WHERE status IN ('PENDING', 'RUNNING', 'RETRY_WAIT');

CREATE INDEX processing_jobs_claim_idx
    ON public.processing_jobs (available_at, created_at, id)
    WHERE status IN ('PENDING', 'RETRY_WAIT');

CREATE INDEX processing_jobs_expired_lease_idx
    ON public.processing_jobs (lease_expires_at, id)
    WHERE status = 'RUNNING';


CREATE FUNCTION public.guard_processing_job_update()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $function$
BEGIN
    IF NEW.id IS DISTINCT FROM OLD.id
       OR NEW.case_id IS DISTINCT FROM OLD.case_id
       OR NEW.job_type IS DISTINCT FROM OLD.job_type
       OR NEW.created_at IS DISTINCT FROM OLD.created_at
    THEN
        RAISE EXCEPTION 'Processing job identity fields are immutable';
    END IF;

    IF NEW.status IS DISTINCT FROM OLD.status THEN
        IF NOT (
            (OLD.status IN ('PENDING', 'RETRY_WAIT')
                AND NEW.status = 'RUNNING')
            OR
            (OLD.status = 'RUNNING'
                AND NEW.status IN (
                    'RETRY_WAIT',
                    'SUCCEEDED',
                    'DEAD_LETTER'
                ))
        ) THEN
            RAISE EXCEPTION
                'Invalid processing job status transition: % -> %',
                OLD.status, NEW.status;
        END IF;
    ELSIF OLD.status <> 'RUNNING' THEN
        RAISE EXCEPTION
            'Updates without a status transition are not allowed for % jobs',
            OLD.status;
    END IF;

    IF NEW.status = 'RUNNING'
       AND OLD.status IN ('PENDING', 'RETRY_WAIT')
    THEN
        IF NEW.attempt_count <> OLD.attempt_count + 1
           OR NEW.lease_generation <> OLD.lease_generation + 1
        THEN
            RAISE EXCEPTION
                'A successful claim must increment attempt_count and lease_generation by one';
        END IF;

        IF NEW.lease_expires_at <= clock_timestamp() THEN
            RAISE EXCEPTION
                'A claimed job must have a future lease expiry';
        END IF;



    ELSIF OLD.status = 'RUNNING'
          AND NEW.status = 'RUNNING'
    THEN
        IF NEW.attempt_count = OLD.attempt_count + 1
           AND NEW.lease_generation = OLD.lease_generation + 1
        THEN
            -- Reclaim only after expiry, with a new owner and future lease.
            IF OLD.lease_expires_at > clock_timestamp() THEN
                RAISE EXCEPTION
                    'Cannot reclaim a job before its lease expires';
            END IF;

            IF NEW.lease_owner IS NOT DISTINCT FROM OLD.lease_owner
               OR NEW.lease_expires_at <= clock_timestamp()
               OR NEW.available_at IS DISTINCT FROM OLD.available_at
               OR NEW.last_error_code IS DISTINCT FROM OLD.last_error_code
            THEN
                RAISE EXCEPTION
                    'Reclaim requires a new owner, future lease expiry, and unchanged unrelated fields';
            END IF;

        ELSIF NEW.attempt_count = OLD.attempt_count
              AND NEW.lease_generation = OLD.lease_generation
              AND NEW.lease_owner IS NOT DISTINCT FROM OLD.lease_owner
              AND NEW.lease_expires_at > OLD.lease_expires_at
              AND OLD.lease_expires_at > clock_timestamp()
        THEN
            -- Renewal may only extend the current, unexpired lease.
            IF NEW.available_at IS DISTINCT FROM OLD.available_at
               OR NEW.last_error_code IS DISTINCT FROM OLD.last_error_code
            THEN
                RAISE EXCEPTION
                    'Lease renewal cannot modify unrelated fields';
            END IF;

        ELSE
            RAISE EXCEPTION
                'RUNNING job updates must be a valid reclaim or lease renewal';
        END IF;

    ELSE
        IF NEW.attempt_count <> OLD.attempt_count
           OR NEW.lease_generation <> OLD.lease_generation
        THEN
            RAISE EXCEPTION
                'Attempts and lease generation cannot change outside a claim';
        END IF;
    END IF;

    NEW.updated_at := clock_timestamp();

    RETURN NEW;
END;
$function$;

CREATE TRIGGER processing_jobs_update_guard
BEFORE UPDATE ON public.processing_jobs
FOR EACH ROW
EXECUTE FUNCTION public.guard_processing_job_update();


CREATE FUNCTION public.guard_processing_job_insert()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $function$
BEGIN
    IF NEW.status <> 'PENDING'
       OR NEW.attempt_count <> 0
       OR NEW.lease_generation <> 0
       OR NEW.lease_owner IS NOT NULL
       OR NEW.lease_expires_at IS NOT NULL
    THEN
        RAISE EXCEPTION
            'New processing jobs must start PENDING with zero attempts and no lease';
    END IF;

    RETURN NEW;
END;
$function$;

CREATE TRIGGER processing_jobs_insert_guard
BEFORE INSERT ON public.processing_jobs
FOR EACH ROW
EXECUTE FUNCTION public.guard_processing_job_insert();


ALTER TABLE public.processing_jobs
    OWNER TO service_request_owner;

ALTER FUNCTION public.guard_processing_job_update()
    OWNER TO service_request_owner;

ALTER FUNCTION public.guard_processing_job_insert()
    OWNER TO service_request_owner;

REVOKE ALL ON TABLE public.processing_jobs FROM PUBLIC;
REVOKE ALL ON FUNCTION public.guard_processing_job_update() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.guard_processing_job_insert() FROM PUBLIC;

GRANT SELECT, INSERT, UPDATE
    ON TABLE public.processing_jobs
    TO service_request_runtime;

COMMIT;
