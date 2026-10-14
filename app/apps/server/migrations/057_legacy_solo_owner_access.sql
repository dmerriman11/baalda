-- SPDX-License-Identifier: Apache-2.0
-- Preserve access to legacy solo vaults that never recorded any ACL at all.
-- A personal owner grant restores the old owner's access without making the
-- vault readable to future members. Never infer intent when ANY explicit share
-- exists: private/read-only postures, item restrictions and personal rules stay
-- untouched. Multi-member vaults need their recorded grants/authorship instead.
SET LOCAL lock_timeout = '10s';

INSERT INTO shares
  (id, org_id, resource_type, resource_id, principal_type, principal_id, permission, created_by)
SELECT gen_random_uuid()::text, m."organizationId", 'vault', m."organizationId",
       'user', m."userId", 'edit', m."userId"
  FROM member m
 WHERE m.role = 'owner'
   AND EXISTS (SELECT 1 FROM vaults v WHERE v.organization_id = m."organizationId")
   AND NOT EXISTS (SELECT 1 FROM member other
                    WHERE other."organizationId" = m."organizationId" AND other.id <> m.id)
   AND NOT EXISTS (SELECT 1 FROM shares s WHERE s.org_id = m."organizationId")
ON CONFLICT (resource_type, resource_id, principal_type, principal_id) DO NOTHING;
