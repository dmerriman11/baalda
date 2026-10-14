-- Access history is separate from current shares: removing a member or grant
-- must not erase the evidence. No note content, tokens or credentials are logged.
CREATE TABLE access_audit (
  id BIGSERIAL PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  actor_user_id TEXT,
  actor_name TEXT,
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  action TEXT NOT NULL,
  before_state JSONB,
  after_state JSONB
);
CREATE INDEX access_audit_org_cursor ON access_audit (organization_id, id DESC);

CREATE FUNCTION record_access_audit() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  prior JSONB;
  later JSONB;
  org TEXT;
  entity TEXT;
  actor TEXT := nullif(current_setting('baalda.audit_actor', true), '');
  label TEXT;
BEGIN
  IF TG_TABLE_NAME = 'shares' THEN
    IF TG_OP <> 'INSERT' THEN
      prior := jsonb_build_object('resourceType', OLD.resource_type, 'resourceId', OLD.resource_id,
        'principalType', OLD.principal_type, 'principalId', OLD.principal_id, 'permission', OLD.permission);
      org := OLD.org_id; entity := OLD.id;
    END IF;
    IF TG_OP <> 'DELETE' THEN
      later := jsonb_build_object('resourceType', NEW.resource_type, 'resourceId', NEW.resource_id,
        'principalType', NEW.principal_type, 'principalId', NEW.principal_id, 'permission', NEW.permission);
      org := NEW.org_id; entity := NEW.id;
      IF TG_OP = 'INSERT' THEN actor := coalesce(actor, NEW.created_by); END IF;
    END IF;
  ELSIF TG_TABLE_NAME = 'member' THEN
    IF TG_OP <> 'INSERT' THEN
      prior := jsonb_build_object('userId', OLD."userId", 'role', OLD.role);
      org := OLD."organizationId"; entity := OLD.id;
    END IF;
    IF TG_OP <> 'DELETE' THEN
      later := jsonb_build_object('userId', NEW."userId", 'role', NEW.role);
      org := NEW."organizationId"; entity := NEW.id;
    END IF;
  ELSE
    IF TG_OP <> 'INSERT' THEN
      prior := jsonb_build_object('joinDefault', OLD.join_default);
      org := OLD.organization_id; entity := org;
    END IF;
    IF TG_OP <> 'DELETE' THEN
      later := jsonb_build_object('joinDefault', NEW.join_default);
      org := NEW.organization_id; entity := org;
    END IF;
  END IF;
  -- Ignore last-seen/ACL revision bookkeeping and cascades from vault deletion.
  IF prior IS NOT DISTINCT FROM later OR NOT EXISTS (SELECT 1 FROM organization WHERE id = org) THEN
    RETURN NULL;
  END IF;
  SELECT name INTO label FROM "user" WHERE id = actor;
  INSERT INTO access_audit (organization_id, actor_user_id, actor_name, entity_type, entity_id, action, before_state, after_state)
    VALUES (org, actor, label, TG_TABLE_NAME, entity, lower(TG_OP), prior, later);
  RETURN NULL;
END;
$$;
CREATE TRIGGER audit_shares AFTER INSERT OR UPDATE OR DELETE ON shares FOR EACH ROW EXECUTE FUNCTION record_access_audit();
CREATE TRIGGER audit_members AFTER INSERT OR UPDATE OR DELETE ON member FOR EACH ROW EXECUTE FUNCTION record_access_audit();
CREATE TRIGGER audit_join_default AFTER INSERT OR UPDATE OR DELETE ON organization_access_settings FOR EACH ROW EXECUTE FUNCTION record_access_audit();
