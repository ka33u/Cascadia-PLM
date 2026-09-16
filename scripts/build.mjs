import { build as viteBuild } from 'vite'
import { build as serverBuild } from 'esbuild'
await viteBuild()
await serverBuild({
  entryPoints: {
    server: 'src/server/index.ts',
    setup: 'scripts/setup.ts',
    migrate: 'scripts/migrate.ts',
  },
  outdir: 'dist',
  outExtension: { '.js': '.mjs' },
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'esm',
  packages: 'external',
  sourcemap: true,
})
console.log('已生成独立前端与服务端：dist/client + dist/server.mjs')
