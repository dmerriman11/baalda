-- SPDX-License-Identifier: Apache-2.0
-- Preserve access to legacy solo vaults that never recorded any ACL at all.
-- Authorship is the narrowest key the resolver already honours: items with NO
-- recorded creator in a vault whose only member is its owner can only be the
-- owner's, so they take that owner as creator. No share row is written: a
-- personal vault grant would be an absolute level reaching notes that future
-- members create, and would show up in access_audit as a self-grant nobody made
-- (files/notes/folders carry no audit trigger). Never infer intent when ANY
-- explicit share exists: private/read-only postures, item restrictions and
-- personal rules stay untouched. Multi-member vaults need their recorded
-- grants/authorship instead. Rows that already carry a creator are never
-- touched, so re-running it is a no-op.
SET LOCAL lock_timeout = '10s';

CREATE TEMP TABLE legacy_solo_owner ON COMMIT DROP AS
SELECT v.id AS vault_id, m."userId" AS owner_id
  FROM member m
  JOIN vaults v ON v.organization_id = m."organizationId"
 WHERE m.role = 'owner'
   AND NOT EXISTS (SELECT 1 FROM member other
                    WHERE other."organizationId" = m."organizationId" AND other.id <> m.id)
   AND NOT EXISTS (SELECT 1 FROM shares s WHERE s.org_id = m."organizationId");

UPDATE files f SET created_by = l.owner_id
  FROM legacy_solo_owner l
 WHERE f.vault_id = l.vault_id AND f.created_by IS NULL;

UPDATE notes n SET created_by = l.owner_id
  FROM legacy_solo_owner l
 WHERE n.vault_id = l.vault_id AND n.created_by IS NULL;

UPDATE folders d SET created_by = l.owner_id
  FROM legacy_solo_owner l
 WHERE d.vault_id = l.vault_id AND d.created_by IS NULL;
