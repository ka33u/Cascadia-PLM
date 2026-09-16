// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

/**
 * Repair partial-index predicates that `drizzle-kit push` leaves behind.
 *
 * `push` diffs the schema against the live database and applies what differs —
 * except an index's `WHERE` predicate, which it does not diff at all. Add a
 * predicate to an index that already exists and push reports "Changes applied"
 * having changed nothing. The database keeps the old, non-partial index and
 * nothing anywhere says so.
 *
 * That is silent in the worst way, because a wrong predicate does not fail like
 * a missing column does. `signing_credentials_thumbprint_idx` went partial in
 * `0001_remediation` — `WHERE revoked_at IS NULL`, so a revoked enrollment and
 * a re-enrollment of the same card can coexist. In a database still holding the
 * non-partial index, `SignatureService.enrollCredential`'s
 * `ON CONFLICT (cert_thumbprint) WHERE revoked_at IS NULL DO NOTHING` infers
 * that index as its arbiter — Postgres accepts a non-partial index for a
 * partial `ON CONFLICT`, since its predicate is trivially implied — collides
 * with the *revoked* row, and drops the insert without an error. Every card
 * replacement then silently fails to record a binding, which quietly retires
 * the one-card-one-account guarantee the index exists to enforce. It surfaced
 * as one enrollment row where a test expected two.
 *
 * CI never sees this: it builds a fresh database on every run, and an index
 * created from scratch carries its predicate. Only a database that predates the
 * change drifts — which is every developer's, and the demo stack's.
 *
 * The repair is to drop the drifted index and let push rebuild it from the
 * schema, rather than hand-writing a `CREATE INDEX` here that would have to
 * re-derive columns, operator classes and collations correctly.
 *
 * **Presence, not text.** The comparison asks whether an index has a predicate,
 * not what it says. Postgres rewrites what it stores — `status = 'In Progress'`
 * comes back as `((status)::text = 'In Progress'::text)` — so comparing
 * predicate text against the snapshot's would report drift on indexes that are
 * perfectly correct, and this module *drops indexes*. A false positive is worth
 * more caution than the case it would buy: editing an existing predicate's text
 * rather than adding or removing one. Drop that index by hand and push.
 *
 * Only indexes the committed snapshot names are ever touched. An index the
 * schema does not declare is left exactly where it is.
 */

import { readFileSync, readdirSync } from 'node:fs'
import { resolve } from 'node:path'
import postgres from 'postgres'

/**
 * Every index in the app's newest migration snapshot, and whether it is partial.
 *
 * The snapshot rather than the schema module because this runs from a plain
 * node script with no TypeScript loader, and CI's drift gate already pins the
 * two together — a snapshot that disagrees with `modules.schema.ts` fails Lint
 * before it can mislead anything here.
 */
export function declaredIndexes(appDir) {
  const metaDir = resolve(appDir, 'drizzle', 'meta')
  const snapshots = readdirSync(metaDir)
    .filter((file) => /^\d+_snapshot\.json$/.test(file))
    .sort()
  const latest = snapshots.at(-1)
  if (!latest) return new Map()

  const snapshot = JSON.parse(readFileSync(resolve(metaDir, latest), 'utf8'))
  const declared = new Map()
  for (const table of Object.values(snapshot.tables ?? {})) {
    for (const index of Object.values(table.indexes ?? {})) {
      declared.set(index.name, {
        table: table.name,
        partial: Boolean(index.where),
      })
    }
  }
  return declared
}

/**
 * Indexes whose partial-ness in the database disagrees with the snapshot.
 *
 * An index the snapshot declares but the database does not have is not drift —
 * push creates it, correctly, predicate and all. An index the database has but
 * the snapshot does not declare is not ours to judge, and never dropped.
 */
export function predicateDrift(declared, live) {
  const drift = []
  for (const row of live) {
    const expected = declared.get(row.indexname)
    if (!expected) continue
    // A predicate is the only thing `CREATE INDEX` renders after WHERE.
    const isPartial = / WHERE /.test(row.indexdef)
    if (isPartial !== expected.partial) {
      drift.push({
        name: row.indexname,
        table: expected.table,
        expected: expected.partial ? 'partial' : 'full',
        actual: isPartial ? 'partial' : 'full',
      })
    }
  }
  return drift.sort((a, b) => a.name.localeCompare(b.name))
}

/** `predicateDrift` against a live database and the app's newest snapshot. */
export async function findPredicateDrift(databaseUrl, appDir) {
  const declared = declaredIndexes(appDir)
  const sql = postgres(databaseUrl, { max: 1, onnotice: () => {} })
  try {
    const live = await sql`
      select indexname, indexdef
        from pg_indexes
       where schemaname = 'public'
    `
    return predicateDrift(declared, live)
  } finally {
    await sql.end()
  }
}

async function dropIndexes(databaseUrl, names) {
  const sql = postgres(databaseUrl, { max: 1, onnotice: () => {} })
  try {
    for (const name of names) {
      // `sql(name)` renders a quoted identifier. The names come from the
      // committed snapshot, but the typed form is the one that stays correct if
      // an index is ever named something that needs quoting.
      await sql`drop index if exists ${sql(name)}`
    }
  } finally {
    await sql.end()
  }
}

/**
 * Bring index predicates back in line, by dropping what drifted and asking the
 * caller to push again so drizzle-kit rebuilds it.
 *
 * Returns the indexes that were repaired. Throws if a second pass still
 * disagrees — a database left without an index it is supposed to have is worse
 * than the drift, so it must not pass quietly.
 */
export async function reconcileIndexPredicates({ databaseUrl, appDir, push }) {
  const drift = await findPredicateDrift(databaseUrl, appDir)
  if (drift.length === 0) return []

  for (const index of drift) {
    console.log(
      `Index ${index.name} on ${index.table} is ${index.actual} where the ` +
        `schema declares ${index.expected} — rebuilding it.`,
    )
  }

  await dropIndexes(
    databaseUrl,
    drift.map((index) => index.name),
  )
  push()

  const remaining = await findPredicateDrift(databaseUrl, appDir)
  if (remaining.length > 0) {
    throw new Error(
      'Index predicates are still wrong after a rebuild: ' +
        remaining.map((index) => index.name).join(', ') +
        '. Either the database is missing an index it should have, or the ' +
        'snapshot is ahead of the schema and `npm run db:generate` has not ' +
        'run. Check which, and recreate the index by hand if it is the first.',
    )
  }

  return drift
}
