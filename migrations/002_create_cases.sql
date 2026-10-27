
BEGIN;

CREATE TABLE public.cases (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    -- Provider-scoped idempotency key.
    source_provider TEXT NOT NULL
        CHECK (length(trim(source_provider)) > 0),
    provider_message_id TEXT NOT NULL
        CHECK (length(trim(provider_message_id)) > 0),

    -- Original normalized email content.
    sender_email TEXT NOT NULL
        CHECK (length(trim(sender_email)) > 0),
    subject TEXT,
    body_text TEXT NOT NULL,
    received_at TIMESTAMPTZ NOT NULL,

    status TEXT NOT NULL DEFAULT 'RECEIVED'
        CHECK (status IN (
            'RECEIVED',
            'NEEDS_REVIEW',
            'QUEUED',
            'IN_PROGRESS',
            'WAITING_FOR_CUSTOMER',
            'RESOLVED',
            'CLOSED'
        )),

    -- Classification output.
    summary TEXT,
    primary_category TEXT
        CHECK (primary_category IN (
            'payment_issue',
            'account_support',
            'technical_support',
            'complaint',
            'other'
        )),
    classification_confidence NUMERIC(5,4)
        CHECK (
            classification_confidence IS NULL
            OR classification_confidence BETWEEN 0 AND 1
        ),
    review_reasons TEXT[] NOT NULL DEFAULT '{}',
    missing_information TEXT[] NOT NULL DEFAULT '{}',

    -- Deterministic routing decision.
    assigned_team TEXT
        CHECK (assigned_team IN (
            'payment_support',
            'account_support',
            'technical_support',
            'customer_care',
            'general_triage'
        )),
    assigned_employee_id TEXT,
    routing_policy_id UUID
        REFERENCES public.routing_policies(id)
        ON DELETE RESTRICT,

    -- Duplicate-content detection; distinct from message idempotency.
    duplicate_of_case_id UUID
        REFERENCES public.cases(id)
        ON DELETE SET NULL,

    -- Concurrency and stale-processing protection.
    case_version INTEGER NOT NULL DEFAULT 1
        CHECK (case_version > 0),
    current_processing_generation INTEGER NOT NULL DEFAULT 1
        CHECK (current_processing_generation > 0),

    created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),

    CONSTRAINT cases_provider_message_unique
        UNIQUE (source_provider, provider_message_id),

    CONSTRAINT cases_not_duplicate_of_self
        CHECK (duplicate_of_case_id IS NULL OR duplicate_of_case_id <> id),

    -- Routed or employee-handled cases must have a complete routing decision.
    CONSTRAINT cases_routed_status_requires_routing
        CHECK (
            status NOT IN (
                'QUEUED',
                'IN_PROGRESS',
                'WAITING_FOR_CUSTOMER',
                'RESOLVED',
                'CLOSED'
            )
            OR (
                primary_category IS NOT NULL
                AND assigned_team IS NOT NULL
                AND routing_policy_id IS NOT NULL
            )
        )
);

CREATE INDEX cases_status_received_at_idx
    ON public.cases (status, received_at);

CREATE INDEX cases_team_status_received_at_idx
    ON public.cases (assigned_team, status, received_at);

CREATE INDEX cases_duplicate_of_case_id_idx
    ON public.cases (duplicate_of_case_id);

CREATE TABLE public.case_categories (
    case_id UUID NOT NULL
        REFERENCES public.cases(id)
        ON DELETE CASCADE,
    category TEXT NOT NULL
        CHECK (category IN (
            'payment_issue',
            'account_support',
            'technical_support',
            'complaint',
            'other'
        )),
    created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),

    PRIMARY KEY (case_id, category)
);

CREATE FUNCTION public.guard_case_category_identity()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN
    IF NEW.case_id IS DISTINCT FROM OLD.case_id THEN
        RAISE EXCEPTION
            'case_id cannot be changed; delete and recreate the category association';
    END IF;

    RETURN NEW;
END;
$$;

CREATE TRIGGER case_categories_identity_guard
BEFORE UPDATE OF case_id ON public.case_categories
FOR EACH ROW
EXECUTE FUNCTION public.guard_case_category_identity();

-- Enforce allowed case-status transitions.
CREATE FUNCTION public.guard_case_status_transition()
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
        (OLD.status = 'RECEIVED'
            AND NEW.status IN ('NEEDS_REVIEW', 'QUEUED'))
        OR
        (OLD.status = 'NEEDS_REVIEW'
            AND NEW.status = 'QUEUED')
        OR
        (OLD.status = 'QUEUED'
            AND NEW.status = 'IN_PROGRESS')
        OR
        (OLD.status = 'IN_PROGRESS'
            AND NEW.status IN ('WAITING_FOR_CUSTOMER', 'RESOLVED'))
        OR
        (OLD.status = 'WAITING_FOR_CUSTOMER'
            AND NEW.status = 'IN_PROGRESS')
        OR
        (OLD.status = 'RESOLVED'
            AND NEW.status = 'CLOSED')
    ) THEN
        RAISE EXCEPTION 'Invalid case status transition: % -> %',
            OLD.status, NEW.status;
    END IF;

    RETURN NEW;
END;
$function$;

CREATE TRIGGER cases_status_insert_guard
BEFORE INSERT ON public.cases
FOR EACH ROW
EXECUTE FUNCTION public.guard_case_status_transition();

CREATE TRIGGER cases_status_update_guard
BEFORE UPDATE OF status ON public.cases
FOR EACH ROW
EXECUTE FUNCTION public.guard_case_status_transition();

-- Protect immutable intake data and manage concurrency fields.
CREATE FUNCTION public.guard_case_update()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $function$
BEGIN
    IF NEW.id IS DISTINCT FROM OLD.id
       OR NEW.source_provider IS DISTINCT FROM OLD.source_provider
       OR NEW.provider_message_id IS DISTINCT FROM OLD.provider_message_id
       OR NEW.sender_email IS DISTINCT FROM OLD.sender_email
       OR NEW.subject IS DISTINCT FROM OLD.subject
       OR NEW.body_text IS DISTINCT FROM OLD.body_text
       OR NEW.received_at IS DISTINCT FROM OLD.received_at
       OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
        RAISE EXCEPTION 'Case identity and original intake data are immutable';
    END IF;

    IF NEW.current_processing_generation < OLD.current_processing_generation
       OR NEW.current_processing_generation > OLD.current_processing_generation + 1 THEN
        RAISE EXCEPTION
            'Processing generation must stay the same or increase by one';
    END IF;

    -- Callers use WHERE case_version = expected_version for optimistic locking.
    NEW.case_version := OLD.case_version + 1;
    NEW.updated_at := pg_catalog.clock_timestamp();

    RETURN NEW;
END;
$function$;

CREATE TRIGGER cases_update_guard
BEFORE UPDATE ON public.cases
FOR EACH ROW
EXECUTE FUNCTION public.guard_case_update();

-- Deferred validation permits a case and its categories to be written
-- in one transaction, while checking consistency at transaction end.
CREATE FUNCTION public.check_case_classification_consistency()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
DECLARE
    target_case_id UUID;
    case_primary_category TEXT;
    case_policy_id UUID;
    case_team TEXT;
BEGIN
    IF TG_TABLE_NAME = 'cases' THEN
        IF TG_OP = 'DELETE' THEN
            RETURN NULL;
        END IF;

        target_case_id := NEW.id;
    ELSE
        IF TG_OP = 'DELETE' THEN
            target_case_id := OLD.case_id;
        ELSE
            target_case_id := NEW.case_id;
        END IF;
    END IF;

    SELECT c.primary_category, c.routing_policy_id, c.assigned_team
      INTO case_primary_category, case_policy_id, case_team
      FROM public.cases AS c
     WHERE c.id = target_case_id;

    -- The case may have been deleted in the same transaction.
    IF NOT FOUND THEN
        RETURN NULL;
    END IF;

    IF case_primary_category IS NOT NULL
       AND NOT EXISTS (
           SELECT 1
             FROM public.case_categories AS cc
            WHERE cc.case_id = target_case_id
              AND cc.category = case_primary_category
       ) THEN
        RAISE EXCEPTION
            'Primary category must exist in case_categories for case %',
            target_case_id;
    END IF;

    IF case_primary_category IS NOT NULL
       AND case_policy_id IS NOT NULL
       AND case_team IS NOT NULL
       AND NOT EXISTS (
           SELECT 1
             FROM public.routing_policy_rules AS r
            WHERE r.policy_id = case_policy_id
              AND r.category = case_primary_category
              AND r.team_key = case_team
       ) THEN
        RAISE EXCEPTION
            'Assigned team does not match the routing policy for case %',
            target_case_id;
    END IF;

    RETURN NULL;
END;
$function$;

CREATE CONSTRAINT TRIGGER cases_classification_consistency
AFTER INSERT OR UPDATE ON public.cases
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION public.check_case_classification_consistency();

CREATE CONSTRAINT TRIGGER case_categories_consistency
AFTER INSERT OR UPDATE OR DELETE ON public.case_categories
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION public.check_case_classification_consistency();

-- Assign ownership to the dedicated non-login schema owner.
ALTER TABLE public.cases OWNER TO service_request_owner;
ALTER TABLE public.case_categories OWNER TO service_request_owner;

ALTER FUNCTION public.guard_case_status_transition()
    OWNER TO service_request_owner;
ALTER FUNCTION public.guard_case_update()
    OWNER TO service_request_owner;
ALTER FUNCTION public.check_case_classification_consistency()
    OWNER TO service_request_owner;
ALTER FUNCTION public.guard_case_category_identity()
    OWNER TO service_request_owner;

-- Remove implicit access; grant the runtime role only the application
-- permissions needed for case processing. Case deletion is not granted.
REVOKE ALL ON TABLE public.cases, public.case_categories FROM PUBLIC;

REVOKE ALL ON FUNCTION public.guard_case_status_transition() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.guard_case_update() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.check_case_classification_consistency() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.guard_case_category_identity() FROM PUBLIC;

GRANT USAGE ON SCHEMA public TO service_request_runtime;

GRANT SELECT, INSERT, UPDATE
    ON TABLE public.cases
    TO service_request_runtime;

GRANT SELECT, INSERT, UPDATE, DELETE
    ON TABLE public.case_categories
    TO service_request_runtime;

COMMIT;
