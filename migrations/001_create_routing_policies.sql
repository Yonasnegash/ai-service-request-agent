
-- Migration 001: Routing policies
-- PostgreSQL 17+
-- No production policy or precedence order is seeded.

BEGIN;

CREATE TABLE public.routing_policies (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    version INTEGER NOT NULL UNIQUE CHECK (version > 0),
    status TEXT NOT NULL DEFAULT 'DRAFT'
        CHECK (status IN ('DRAFT', 'ACTIVE', 'RETIRED')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    created_by TEXT NOT NULL CHECK (length(trim(created_by)) > 0),
    activated_at TIMESTAMPTZ,

    CONSTRAINT routing_policy_activation_timestamp_check
        CHECK (
            (status = 'DRAFT' AND activated_at IS NULL)
            OR
            (status IN ('ACTIVE', 'RETIRED') AND activated_at IS NOT NULL)
        )
);

CREATE UNIQUE INDEX routing_policies_one_active_idx
    ON public.routing_policies (status)
    WHERE status = 'ACTIVE';

CREATE TABLE public.routing_policy_rules (
    policy_id UUID NOT NULL
        REFERENCES public.routing_policies (id),
    category TEXT NOT NULL
        CHECK (
            category IN (
                'payment_issue',
                'account_support',
                'technical_support',
                'complaint',
                'other'
            )
        ),
    team_key TEXT NOT NULL
        CHECK (
            team_key IN (
                'payment_support',
                'account_support',
                'technical_support',
                'customer_care',
                'general_triage'
            )
        ),
    precedence INTEGER NOT NULL
        CHECK (precedence BETWEEN 1 AND 5),

    PRIMARY KEY (policy_id, category),
    UNIQUE (policy_id, precedence),

    CONSTRAINT routing_policy_category_team_check
        CHECK (
            (category = 'payment_issue'
                AND team_key = 'payment_support')
            OR
            (category = 'account_support'
                AND team_key = 'account_support')
            OR
            (category = 'technical_support'
                AND team_key = 'technical_support')
            OR
            (category = 'complaint'
                AND team_key = 'customer_care')
            OR
            (category = 'other'
                AND team_key = 'general_triage')
        )
);

-- Rules may only be changed while their policy is a draft.
CREATE FUNCTION public.guard_routing_policy_rule_mutation()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
DECLARE
    policy_status TEXT;
    target_policy_id UUID;
BEGIN
    IF TG_OP = 'UPDATE'
       AND NEW.policy_id IS DISTINCT FROM OLD.policy_id THEN
        RAISE EXCEPTION 'A routing rule cannot be moved to another policy';
    END IF;

    IF TG_OP = 'DELETE' THEN
        target_policy_id := OLD.policy_id;
    ELSE
        target_policy_id := NEW.policy_id;
    END IF;

    SELECT p.status
      INTO policy_status
      FROM public.routing_policies AS p
     WHERE p.id = target_policy_id
     FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Routing policy % does not exist', target_policy_id;
    END IF;

    IF policy_status <> 'DRAFT' THEN
        RAISE EXCEPTION 'Rules can only be changed while a policy is DRAFT';
    END IF;

    IF TG_OP = 'DELETE' THEN
        RETURN OLD;
    END IF;

    RETURN NEW;
END;
$function$;

CREATE TRIGGER routing_policy_rules_mutation_guard
BEFORE INSERT OR UPDATE OR DELETE
ON public.routing_policy_rules
FOR EACH ROW
EXECUTE FUNCTION public.guard_routing_policy_rule_mutation();

-- Protect policy identity, history, and permitted state transitions.
CREATE FUNCTION public.guard_routing_policy_mutation()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $function$
DECLARE
    rule_count BIGINT;
    distinct_precedence_count BIGINT;
    minimum_precedence INTEGER;
    maximum_precedence INTEGER;
BEGIN
    IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'Routing policies cannot be deleted';
    END IF;

    IF NEW.id IS DISTINCT FROM OLD.id
       OR NEW.version IS DISTINCT FROM OLD.version
       OR NEW.created_at IS DISTINCT FROM OLD.created_at
       OR NEW.created_by IS DISTINCT FROM OLD.created_by THEN
        RAISE EXCEPTION
            'Policy identity and creation metadata are immutable';
    END IF;

    IF OLD.status = 'DRAFT' AND NEW.status = 'DRAFT' THEN
        IF NEW.activated_at IS DISTINCT FROM OLD.activated_at THEN
            RAISE EXCEPTION 'A draft cannot have an activation timestamp';
        END IF;

        RETURN NEW;
    END IF;

    IF OLD.status = 'DRAFT' AND NEW.status = 'ACTIVE' THEN
        IF OLD.activated_at IS NOT NULL OR NEW.activated_at IS NULL THEN
            RAISE EXCEPTION
                'Activation requires a new activation timestamp';
        END IF;

        SELECT COUNT(*),
               COUNT(DISTINCT r.precedence),
               MIN(r.precedence),
               MAX(r.precedence)
          INTO rule_count,
               distinct_precedence_count,
               minimum_precedence,
               maximum_precedence
          FROM public.routing_policy_rules AS r
         WHERE r.policy_id = NEW.id;

        IF rule_count <> 5
           OR distinct_precedence_count <> 5
           OR minimum_precedence <> 1
           OR maximum_precedence <> 5 THEN
            RAISE EXCEPTION
                'Activation requires all five categories with precedence 1 through 5';
        END IF;

        RETURN NEW;
    END IF;

    IF OLD.status = 'ACTIVE' AND NEW.status = 'RETIRED' THEN
        IF NEW.activated_at IS DISTINCT FROM OLD.activated_at THEN
            RAISE EXCEPTION
                'Retirement cannot change the activation timestamp';
        END IF;

        RETURN NEW;
    END IF;

    RAISE EXCEPTION 'Invalid policy transition: % -> %',
        OLD.status, NEW.status;
END;
$function$;

CREATE TRIGGER routing_policies_mutation_guard
BEFORE UPDATE OR DELETE
ON public.routing_policies
FOR EACH ROW
EXECUTE FUNCTION public.guard_routing_policy_mutation();

-- Activate a draft and replace any current active policy atomically.
CREATE FUNCTION public.activate_routing_policy(p_policy_id UUID)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
DECLARE
    target_status TEXT;
    current_active_id UUID;
    rule_count BIGINT;
    distinct_precedence_count BIGINT;
    minimum_precedence INTEGER;
    maximum_precedence INTEGER;
BEGIN
    -- Serialize activations, including the first activation.
    PERFORM pg_catalog.pg_advisory_xact_lock(73421, 1);

    SELECT p.status
      INTO target_status
      FROM public.routing_policies AS p
     WHERE p.id = p_policy_id
     FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Routing policy % does not exist', p_policy_id;
    END IF;

    IF target_status <> 'DRAFT' THEN
        RAISE EXCEPTION 'Only a DRAFT policy can be activated';
    END IF;

    SELECT COUNT(*),
           COUNT(DISTINCT r.precedence),
           MIN(r.precedence),
           MAX(r.precedence)
      INTO rule_count,
           distinct_precedence_count,
           minimum_precedence,
           maximum_precedence
      FROM public.routing_policy_rules AS r
     WHERE r.policy_id = p_policy_id;

    IF rule_count <> 5
       OR distinct_precedence_count <> 5
       OR minimum_precedence <> 1
       OR maximum_precedence <> 5 THEN
        RAISE EXCEPTION
            'Policy requires five rules with precedence 1 through 5';
    END IF;

    SELECT p.id
      INTO current_active_id
      FROM public.routing_policies AS p
     WHERE p.status = 'ACTIVE'
     FOR UPDATE;

    IF current_active_id IS NOT NULL THEN
        UPDATE public.routing_policies
           SET status = 'RETIRED'
         WHERE id = current_active_id;
    END IF;

    UPDATE public.routing_policies
       SET status = 'ACTIVE',
           activated_at = pg_catalog.clock_timestamp()
     WHERE id = p_policy_id;
END;
$function$;

-- Do not allow arbitrary callers to invoke the privileged function.
REVOKE ALL
ON FUNCTION public.activate_routing_policy(UUID)
FROM PUBLIC;

-- Roles must be provisioned separately by the database administrator.
-- Keep schema ownership separate from application and policy administration.
ALTER TABLE public.routing_policies
    OWNER TO service_request_owner;

-- Allow the dedicated owner role to own and manage objects in public.
GRANT CREATE ON SCHEMA public TO service_request_owner;

ALTER TABLE public.routing_policy_rules
    OWNER TO service_request_owner;

ALTER FUNCTION public.guard_routing_policy_rule_mutation()
    OWNER TO service_request_owner;

ALTER FUNCTION public.guard_routing_policy_mutation()
    OWNER TO service_request_owner;

ALTER FUNCTION public.activate_routing_policy(UUID)
    OWNER TO service_request_owner;

-- Pin the search path for all trigger functions.
ALTER FUNCTION public.guard_routing_policy_rule_mutation()
    SET search_path = pg_catalog;

ALTER FUNCTION public.guard_routing_policy_mutation()
    SET search_path = pg_catalog;

-- Remove implicit access and grant only the required permissions.
REVOKE ALL ON TABLE
    public.routing_policies,
    public.routing_policy_rules
FROM PUBLIC;

REVOKE ALL ON FUNCTION
    public.guard_routing_policy_rule_mutation(),
    public.guard_routing_policy_mutation(),
    public.activate_routing_policy(UUID)
FROM PUBLIC;

GRANT USAGE ON SCHEMA public
    TO service_request_runtime, service_request_policy_admin;

GRANT SELECT ON
    public.routing_policies,
    public.routing_policy_rules
TO service_request_runtime, service_request_policy_admin;

-- Administrators can create draft policies, but cannot update policy status.
GRANT INSERT (version, created_by)
    ON public.routing_policies
    TO service_request_policy_admin;

GRANT INSERT, UPDATE, DELETE
    ON public.routing_policy_rules
    TO service_request_policy_admin;

GRANT EXECUTE
    ON FUNCTION public.activate_routing_policy(UUID)
    TO service_request_policy_admin;

COMMIT;
