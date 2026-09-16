import 'dotenv/config'
import { spawn } from 'node:child_process'
import { createServer } from 'vite'
const api = spawn(
  process.execPath,
  ['--import', 'tsx', '--watch', 'src/server/index.ts'],
  {
    stdio: 'inherit',
    env: { ...process.env, PORT: process.env.API_PORT || '3411' },
  },
)
const vite = await createServer()
await vite.listen()
vite.printUrls()
async function stop() {
  api.kill()
  await vite.close()
}
process.on('SIGINT', () => void stop())
process.on('SIGTERM', () => void stop())
api.on('exit', (code) => {
  if (code) {
    void vite.close()
    process.exitCode = code
  }
})
