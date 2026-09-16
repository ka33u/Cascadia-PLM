import test from 'node:test'
import assert from 'node:assert/strict'
import { resolve } from 'node:path'
import { createServer } from 'vite'
import { readFileSync } from 'node:fs'
test('Issue #1: alias and relative imports resolve to one canonical context ID on every OS', async () => {
  const server = await createServer({
    server: { middlewareMode: true, hmr: false, watch: null },
  })
  try {
    const alias = await server.pluginContainer.resolveId(
      '@/lib/auth/context',
      resolve('src/App.tsx'),
    )
    const relative = await server.pluginContainer.resolveId(
      './lib/auth/context',
      resolve('src/main.tsx'),
    )
    assert.ok(alias && relative)
    assert.equal(alias.id, relative.id)
    assert.ok(!alias.id.includes('\\'))
  } finally {
    await server.close()
  }
})
test('Application and lockfile contain no removed framework workspaces or runtime dependencies', () => {
  const manifest = JSON.parse(readFileSync('package.json', 'utf8'))
  assert.equal(manifest.workspaces, undefined)
  const lock = readFileSync('package-lock.json', 'utf8')
  assert.doesNotMatch(lock, /@cascadia|apps\/cascadia|packages\/core/)
})
