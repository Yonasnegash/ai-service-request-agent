BEGIN;

CREATE OR REPLACE FUNCTION public.claim_processing_job(
    p_job_type TEXT,
    p_worker_id TEXT,
    p_lease_seconds INTEGER
)
RETURNS TABLE (
    id UUID,
    case_id UUID,
    job_type TEXT,
    attempt_count INTEGER,
    lease_generation INTEGER,
    lease_expires_at TIMESTAMPTZ
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
DECLARE
    v_job_id UUID;
BEGIN
    IF p_job_type IS NULL
       OR p_job_type NOT IN ('CLASSIFY_CASE', 'RECOVER_CASE') THEN
        RAISE EXCEPTION USING
            ERRCODE = 'P0001',
            MESSAGE = 'Unsupported job type';
    END IF;

    IF p_worker_id IS NULL OR btrim(p_worker_id) = '' THEN
        RAISE EXCEPTION USING
            ERRCODE = 'P0001',
            MESSAGE = 'Worker ID must not be blank';
    END IF;

    IF p_lease_seconds IS NULL
       OR p_lease_seconds < 1
       OR p_lease_seconds > 300 THEN
        RAISE EXCEPTION USING
            ERRCODE = 'P0001',
            MESSAGE = 'Lease duration must be between 1 and 300 seconds';
    END IF;

    SELECT j.id
    INTO v_job_id
    FROM public.processing_jobs AS j
    WHERE j.job_type = p_job_type
      AND j.status IN ('PENDING', 'RETRY_WAIT')
      AND j.available_at <= clock_timestamp()
    ORDER BY j.available_at, j.created_at, j.id
    FOR UPDATE OF j SKIP LOCKED
    LIMIT 1;

    IF v_job_id IS NULL THEN
        RETURN;
    END IF;

    RETURN QUERY
    UPDATE public.processing_jobs AS j
    SET status = 'RUNNING',
        lease_owner = p_worker_id,
        lease_expires_at =
            clock_timestamp() + make_interval(secs => p_lease_seconds),
        attempt_count = j.attempt_count + 1,
        lease_generation = j.lease_generation + 1
    WHERE j.id = v_job_id
    RETURNING
        j.id,
        j.case_id,
        j.job_type,
        j.attempt_count,
        j.lease_generation,
        j.lease_expires_at;
END;
$function$;

ALTER FUNCTION public.claim_processing_job(TEXT, TEXT, INTEGER)
    OWNER TO service_request_owner;

REVOKE ALL ON FUNCTION
    public.claim_processing_job(TEXT, TEXT, INTEGER)
    FROM PUBLIC;

GRANT EXECUTE ON FUNCTION
    public.claim_processing_job(TEXT, TEXT, INTEGER)
    TO service_request_runtime;

REVOKE UPDATE ON TABLE public.processing_jobs
    FROM service_request_runtime;

COMMIT;
