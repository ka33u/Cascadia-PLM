// SPDX-License-Identifier: AGPL-3.0-or-later
// Runs only against a newly restored isolation database; never starts a listener.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import type postgres from 'postgres'

if (
  !process.env.DATABASE_URL ||
  !/^\/cascadia_npi_restore_[a-z0-9_]{8,32}$/.test(
    new URL(process.env.DATABASE_URL).pathname,
  )
)
  throw new Error('Probe requires an isolated restore database')
const [actorId, projectId, fileId, expectedHash] = process.argv.slice(2)
if (!actorId || !projectId || !fileId || !expectedHash)
  throw new Error('Missing probe arguments')
const { projectDetail } = await import('../packages/core/src/lib/npi/service')
const { downloadFile } =
  await import('../packages/core/src/lib/npi/file-service')
try {
  const project = await projectDetail(actorId, projectId)
  assert.equal(project.motorModel, 'RECOVERY-160')
  assert.equal(project.imports.length, 1)
  assert.equal(project.history.length, 1)
  const file = await downloadFile(actorId, fileId)
  assert.equal(
    createHash('sha256').update(file.bytes).digest('hex'),
    expectedHash,
  )
  console.log(
    'PASS: restored project, BOM, promise history and authenticated Vault bytes',
  )
} finally {
  const database = await import('../packages/core/src/lib/db')
  await (database.db as unknown as { $client: postgres.Sql }).$client.end({
    timeout: 5,
  })
  await database.migrationClient.end({ timeout: 5 })
}
