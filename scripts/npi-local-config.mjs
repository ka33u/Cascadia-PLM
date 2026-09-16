import fs from 'node:fs'
import { randomBytes } from 'node:crypto'
import { execFileSync } from 'node:child_process'
if (fs.existsSync('.env'))
  throw new Error('Existing environment file preserved; configure explicitly.')
const password = randomBytes(24).toString('hex')
execFileSync(
  'psql',
  [
    '-h',
    '/tmp',
    '-p',
    '55441',
    '-U',
    'npi_local',
    '-d',
    'postgres',
    '-v',
    'ON_ERROR_STOP=1',
  ],
  {
    input: `ALTER ROLE npi_local PASSWORD '${password}';\nCREATE DATABASE cascadia_npi;\nCREATE DATABASE cascadia_npi_test;\n`,
    stdio: ['pipe', 'pipe', 'pipe'],
  },
)
fs.writeFileSync(
  '.env',
  `DATABASE_URL=postgresql://npi_local:${password}@127.0.0.1:55441/cascadia_npi\nTEST_DATABASE_URL=postgresql://npi_local:${password}@127.0.0.1:55441/cascadia_npi_test\nDATABASE_SSL=disable\nBASE_URL=http://localhost:3410\nCLIENT_PORT=3410\nAPI_PORT=3411\nNODE_ENV=development\nVAULT_ROOT=../runtime/vault\nVAULT_TYPE=local\n`,
  { mode: 0o600 },
)
console.log(
  'Independent NPI development and test databases configured on port 55441.',
)
