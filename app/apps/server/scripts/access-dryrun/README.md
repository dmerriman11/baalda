# Access dry run (old vs new resolver)

A one-off, read-only harness that answers, for a COPY of a database:

> For every (vault member, live note / file / folder) pair, does this branch's
> permission resolver answer the same as origin/main's, and which deletes would
> the new creator-only rule refuse?

It is not part of the build (`tsconfig.json` includes only `src/`) or the test
suite (`vitest.config.ts` includes only `tests/` and `src/**/*.test.ts`).

## Files

| File | What it is |
| --- | --- |
| `old-resolver/permissions/{resolver,vault-docs,http-gates,lookup}.ts` | Verbatim `git show origin/main:app/apps/server/src/permissions/<f>.ts` |
| `old-resolver/db/pool.ts` | Two-line shim: re-exports the server pool so both resolvers share one `pg` pool. The only adaptation. |
| `run.ts` | The harness |
| `seed-synthetic.ts` | Synthetic validation data. Refuses any DB whose name does not end in `_dryrun_dev`. |
| `out/` | JSON reports (git-ignored) |

Old resolver source: **origin/main @ `2789c0949aca3ffa2430fc5dfd6ca2ed47ddc1f4`**.
To refresh it: `for f in resolver vault-docs http-gates lookup; do git show origin/main:app/apps/server/src/permissions/$f.ts > old-resolver/permissions/$f.ts; done` and update the sha here.

## Run against a copy

The copy MUST first have this branch's migrations applied (046 to 049 add
`files.created_by`, `member.last_seen_at`, checkpoint blob pins and
`blobs.pending_register`; `canDeleteItem` reads `files.created_by`). There is
no `--apply-migrations` flag on purpose: run the normal migrator, from
`app/apps/server`, against the COPY only:

```bash
DATABASE_URL=<copy-url> pnpm run migrate
DATABASE_URL=<copy-url> pnpm exec tsx scripts/access-dryrun/run.ts
```

Options:

| Flag | Default | Meaning |
| --- | --- | --- |
| `--org <id>` | all orgs | One organization (vault) only |
| `--limit N` | none | First N notes, N files and N folders per org (by id) |
| `--out <file>` | `out/dryrun-<db>-<ts>.json` | Report path |
| `--exact-sample N` | 500 | Per org, the first N (member, note/file) pairs are ALSO resolved through each side's per-doc `effectivePermission` and compared with the indexed answer |
| `--no-folder-gates` | on | Skip the per-pair `canEditFolder` comparison (the slowest part) |
| `--no-readable-sets` | on | Skip the `listReadableDocsInVault` cross-check |
| `--no-delete` | on | Skip the `canDeleteItem` pass |
| `--pairs` | off | Write every pair into the JSON (small DBs only) |

Exit code is always 0. Output contains ids and counts only, never names,
emails, paths or text. The script only issues SELECTs.

## What is compared

Per org:

- **Access** for every member x every live note, file and folder: OLD vs NEW
  `resolveAccessForUser` over `loadAccessIndex` (the batch path the "who can
  access" list uses, documented to mirror `effectivePermission` branch for
  branch). Counted as same / lost (NEW < OLD) / gained, by kind and by
  transition, with up to 20 examples carrying a `why` string (role, personal
  vault level, posture, join snapshot, authorship, and the share rows on the
  item's chain visible to that user).
- **Folder edit gate**: OLD vs NEW `canEditFolder` for every member x folder.
- **Cross-checks** (each resolver against itself): indexed vs per-doc
  `effectivePermission` on a sample, and `listReadableDocsInVault` membership vs
  resolver != none for every note/file pair.
- **Delete policy**: NEW `canDeleteItem` for every plain member who can edit the
  item under OLD or NEW (folders: `canEditFolder`). An item is flagged when at
  least one plain member who can edit it TODAY (old resolver) is refused, with
  the reason split into `created_by_null`, `other_creator` and
  `folder_has_others_items`.
- **Org facts**: the Everyone row the new UI would show (`open`/`readonly`/
  `private`, same `modeOf` as `GET team-access`) and the stored posture;
  `join_default`; the count of per-folder/per-file ORG-principal rows (invisible
  in the new UI, cleared when the Everyone row changes); the per-user
  vault-level rows by permission and role (now absolute levels); join snapshots
  by mode; soft-deleted notes excluded.

## Approximations

- Notes and files are both resolved as resource type `file` in both resolvers
  (their own convention); a file's `AccessContext.createdBy` is null on both
  sides, so file authorship never grants access in either. Only the delete
  gate reads `files.created_by`.
- A folder's "access" is `resolveAccessForUser` on a folder context, which has
  no creator. The folder-creator rule appears only in the `canEditFolder`
  comparison, reported separately.
- "Can edit today" for the delete pass means the OLD resolver says edit (OLD
  `canEditFolder` for folders). Admin/owner candidates are skipped because
  `canDeleteItem` short-circuits on role.
- Soft-deleted notes are excluded (the Trash `includeDeleted` path is not
  compared). Blob gates, `GET /vaults/:id/locks` and MCP are not compared.
- Migration 049 does not backfill `files.created_by`, so on a copy every
  pre-existing file has a null creator and counts as non-deletable by plain
  members. That is the rule as written, not a harness artefact.

## Validation (synthetic, `context_dryrun_dev`)

```bash
DATABASE_URL=<.../context_dryrun_dev> pnpm exec tsx scripts/access-dryrun/seed-synthetic.ts
DATABASE_URL=<.../context_dryrun_dev> pnpm exec tsx scripts/access-dryrun/run.ts --pairs
```

Note: the m032 member INSERT trigger snapshots every new member; the seed keeps
only `dr-m5`'s snapshot so the posture branch is exercised like pre-m032
members in production.

| Case | OLD | NEW | Matches the rule |
| --- | --- | --- | --- |
| Org A Shared, member with personal vault `view` | edit everywhere | view everywhere, edit in the folder with an org `edit` override | personal level caps; org item grant lifts above `view` |
| Org A, admin with personal vault `view` | edit | view (same f1 lift) | no role exemption |
| Org A, member with personal vault `denied` | edit everywhere, own note included | none everywhere, own note included | old resolver ignored a per-user vault deny |
| Org A, per-user folder `readonly` + per-user file `edit` inside | view on both notes | view, and edit on that file | deepest per-user row wins |
| Org A, org `locked` folder | view for everyone | view (none for the denied member) | lock caps both |
| Org A, member joined Private (snapshot) | none on prior notes | none | unchanged |
| Org B sealed: own note | none | none | sealed withdraws authorship in both |
| Org B sealed, personal vault `edit` | edit | edit | unchanged |
| Org C never shared | creator edit, owner none on others | same | unchanged |
| Org D Read-only, personal vault `edit` | edit | edit | unchanged |
| Delete: member's own note / file | | ok | creator rule |
| Delete: file with null `created_by` | | refused for every member | null counts as someone else's |
| Delete: member-created folder holding the owner's note | | `folder_has_others_items` | subtree rule |
| Indexed vs `effectivePermission` | 0 mismatches / 102 | 0 / 102 | |
| Readable set vs resolver | 0 / 102 | 0 / 102 | |
