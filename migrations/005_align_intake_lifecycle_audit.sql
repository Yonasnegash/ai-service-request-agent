BEGIN;

-- 1. Persist the full normalized email identity and metadata-only attachments.
ALTER TABLE public.cases
    ADD COLUMN source_type TEXT NOT NULL DEFAULT 'email'
        CONSTRAINT cases_source_type_check CHECK (source_type = 'email'),
    ADD COLUMN mailbox_id TEXT,
    ADD COLUMN thread_id TEXT,
    ADD COLUMN attachment_metadata JSONB NOT NULL DEFAULT '[]'::jsonb
        CONSTRAINT cases_attachment_metadata_array_check
        CHECK (jsonb_typeof(attachment_metadata) = 'array');

-- Existing records predate mailbox-scoped identity. Keep them addressable but
-- mark the mailbox as unknown; integrations must never use this sentinel.
UPDATE public.cases
   SET mailbox_id = '__legacy_unassigned__'
 WHERE mailbox_id IS NULL;

ALTER TABLE public.cases
    ALTER COLUMN mailbox_id SET NOT NULL,
    ADD CONSTRAINT cases_mailbox_id_nonblank
        CHECK (length(trim(mailbox_id)) > 0);

ALTER TABLE public.cases
    DROP CONSTRAINT cases_provider_message_unique,
    ADD CONSTRAINT cases_provider_message_unique
        UNIQUE (source_provider, mailbox_id, provider_message_id);

-- Intake fields remain immutable after initial registration.
CREATE OR REPLACE FUNCTION public.guard_case_update()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $function$
BEGIN
    IF NEW.id IS DISTINCT FROM OLD.id
       OR NEW.source_type IS DISTINCT FROM OLD.source_type
       OR NEW.source_provider IS DISTINCT FROM OLD.source_provider
       OR NEW.mailbox_id IS DISTINCT FROM OLD.mailbox_id
       OR NEW.provider_message_id IS DISTINCT FROM OLD.provider_message_id
       OR NEW.thread_id IS DISTINCT FROM OLD.thread_id
       OR NEW.attachment_metadata IS DISTINCT FROM OLD.attachment_metadata
       OR NEW.sender_email IS DISTINCT FROM OLD.sender_email
       OR NEW.subject IS DISTINCT FROM OLD.subject
       OR NEW.body_text IS DISTINCT FROM OLD.body_text
       OR NEW.received_at IS DISTINCT FROM OLD.received_at
       OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
        RAISE EXCEPTION 'Case identity and original intake data are immutable';
    END IF;

    IF NEW.current_processing_generation < OLD.current_processing_generation
       OR NEW.current_processing_generation > OLD.current_processing_generation + 1 THEN
        RAISE EXCEPTION 'Processing generation must stay the same or increase by one';
    END IF;

    NEW.case_version := OLD.case_version + 1;
    NEW.updated_at := pg_catalog.clock_timestamp();
    RETURN NEW;
END;
$function$;

-- 2. Align the case status constraint and transition guard with case-lifecycle.md.
ALTER TABLE public.cases DROP CONSTRAINT cases_status_check;
ALTER TABLE public.cases DROP CONSTRAINT cases_routed_status_requires_routing;
DROP TRIGGER cases_status_update_guard ON public.cases;

-- Existing QUEUED means classification/routing has already completed, so map
-- it to OPEN before introducing the canonical status constraint.
UPDATE public.cases SET status = 'OPEN' WHERE status = 'QUEUED';

ALTER TABLE public.cases
    ADD CONSTRAINT cases_status_check CHECK (status IN (
        'RECEIVED', 'PROCESSING', 'OPEN', 'IN_PROGRESS',
        'NEEDS_REVIEW', 'WAITING_FOR_CUSTOMER', 'RESOLVED', 'CLOSED'
    )),
    ADD CONSTRAINT cases_routed_status_requires_routing CHECK (
        status NOT IN ('OPEN', 'IN_PROGRESS', 'WAITING_FOR_CUSTOMER', 'RESOLVED', 'CLOSED')
        OR (
            primary_category IS NOT NULL
            AND assigned_team IS NOT NULL
            AND routing_policy_id IS NOT NULL
        )
    );

CREATE OR REPLACE FUNCTION public.guard_case_status_transition()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $function$
BEGIN
    IF TG_OP = 'INSERT' THEN
        IF NEW.status <> 'RECEIVED' THEN
            RAISE EXCEPTION 'New cases must start in RECEIVED status';
        END IF;
        RETURN NEW;
    END IF;

    IF NEW.status IS NOT DISTINCT FROM OLD.status THEN
        RETURN NEW;
    END IF;

    IF NOT (
        (OLD.status = 'RECEIVED' AND NEW.status = 'PROCESSING')
        OR (OLD.status = 'PROCESSING' AND NEW.status IN ('OPEN', 'NEEDS_REVIEW', 'RECEIVED'))
        OR (OLD.status = 'OPEN' AND NEW.status IN ('IN_PROGRESS', 'NEEDS_REVIEW'))
        OR (OLD.status = 'IN_PROGRESS' AND NEW.status IN ('WAITING_FOR_CUSTOMER', 'NEEDS_REVIEW', 'RESOLVED'))
        OR (OLD.status = 'WAITING_FOR_CUSTOMER' AND NEW.status IN ('IN_PROGRESS', 'NEEDS_REVIEW'))
        OR (OLD.status = 'NEEDS_REVIEW' AND NEW.status IN ('OPEN', 'IN_PROGRESS'))
        OR (OLD.status = 'RESOLVED' AND NEW.status IN ('CLOSED', 'IN_PROGRESS'))
    ) THEN
        RAISE EXCEPTION 'Invalid case status transition: % -> %', OLD.status, NEW.status;
    END IF;

    RETURN NEW;
END;
$function$;

CREATE TRIGGER cases_status_update_guard
BEFORE UPDATE OF status ON public.cases
FOR EACH ROW EXECUTE FUNCTION public.guard_case_status_transition();

-- 3. Processing jobs carry the generation they were created to process.
ALTER TABLE public.processing_jobs
    ADD COLUMN generation INTEGER;

-- Backfill under the migration transaction. The existing queue guard is
-- designed for runtime state transitions, not a schema backfill.
ALTER TABLE public.processing_jobs DISABLE TRIGGER USER;
UPDATE public.processing_jobs AS j
   SET generation = c.current_processing_generation
  FROM public.cases AS c
 WHERE c.id = j.case_id;
ALTER TABLE public.processing_jobs ENABLE TRIGGER USER;

ALTER TABLE public.processing_jobs
    ALTER COLUMN generation SET NOT NULL,
    ALTER COLUMN generation SET DEFAULT 1,
    ADD CONSTRAINT processing_jobs_generation_positive CHECK (generation > 0);

CREATE FUNCTION public.guard_processing_job_generation()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $function$
BEGIN
    IF NEW.generation IS DISTINCT FROM OLD.generation THEN
        RAISE EXCEPTION 'Processing job generation is immutable';
    END IF;
    RETURN NEW;
END;
$function$;

CREATE TRIGGER processing_jobs_generation_immutable
BEFORE UPDATE OF generation ON public.processing_jobs
FOR EACH ROW EXECUTE FUNCTION public.guard_processing_job_generation();

-- 4. Append-only audit events. Case creation and status transitions are written
-- automatically in the same transaction as the corresponding case change.
CREATE TABLE public.case_audit_events (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    case_id UUID NOT NULL REFERENCES public.cases(id) ON DELETE RESTRICT,
    event_type TEXT NOT NULL CHECK (event_type IN (
        'CASE_CREATED', 'CASE_STATUS_CHANGED', 'INTAKE_IDENTITY_PAYLOAD_CONFLICT',
        'PROCESSING_GENERATION_INCREMENTED'
    )),
    actor_type TEXT NOT NULL CHECK (actor_type IN ('system', 'worker', 'user', 'admin')),
    actor_id TEXT,
    details JSONB NOT NULL DEFAULT '{}'::jsonb
        CHECK (jsonb_typeof(details) = 'object'),
    created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);

CREATE INDEX case_audit_events_case_created_idx
    ON public.case_audit_events (case_id, created_at, id);

CREATE FUNCTION public.reject_case_audit_event_mutation()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $function$
BEGIN
    RAISE EXCEPTION 'Case audit events are append-only';
END;
$function$;

CREATE TRIGGER case_audit_events_no_update
BEFORE UPDATE OR DELETE ON public.case_audit_events
FOR EACH ROW EXECUTE FUNCTION public.reject_case_audit_event_mutation();

CREATE FUNCTION public.audit_case_created()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
BEGIN
    INSERT INTO public.case_audit_events (case_id, event_type, actor_type, details)
    VALUES (
        NEW.id, 'CASE_CREATED', 'system',
        jsonb_build_object(
            'sourceType', NEW.source_type,
            'provider', NEW.source_provider,
            'mailboxId', NEW.mailbox_id,
            'providerMessageId', NEW.provider_message_id
        )
    );
    RETURN NEW;
END;
$function$;

CREATE TRIGGER cases_audit_insert
AFTER INSERT ON public.cases
FOR EACH ROW EXECUTE FUNCTION public.audit_case_created();

CREATE FUNCTION public.audit_case_status_change()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
BEGIN
    IF NEW.status IS DISTINCT FROM OLD.status THEN
        INSERT INTO public.case_audit_events (case_id, event_type, actor_type, details)
        VALUES (
            NEW.id, 'CASE_STATUS_CHANGED', 'system',
            jsonb_build_object('from', OLD.status, 'to', NEW.status,
                               'caseVersion', NEW.case_version)
        );
    END IF;
    RETURN NEW;
END;
$function$;

CREATE TRIGGER cases_audit_status_change
AFTER UPDATE OF status ON public.cases
FOR EACH ROW EXECUTE FUNCTION public.audit_case_status_change();

-- Keep ownership and runtime permissions explicit.
ALTER TABLE public.case_audit_events OWNER TO service_request_owner;
ALTER FUNCTION public.guard_case_status_transition() OWNER TO service_request_owner;
ALTER FUNCTION public.guard_case_update() OWNER TO service_request_owner;
ALTER FUNCTION public.guard_processing_job_generation() OWNER TO service_request_owner;
ALTER FUNCTION public.reject_case_audit_event_mutation() OWNER TO service_request_owner;
ALTER FUNCTION public.audit_case_created() OWNER TO service_request_owner;
ALTER FUNCTION public.audit_case_status_change() OWNER TO service_request_owner;

REVOKE ALL ON TABLE public.case_audit_events FROM PUBLIC;
REVOKE ALL ON FUNCTION public.guard_processing_job_generation() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.reject_case_audit_event_mutation() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.audit_case_created() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.audit_case_status_change() FROM PUBLIC;

GRANT SELECT, INSERT ON TABLE public.case_audit_events TO service_request_runtime;

COMMIT;