import { preview } from 'vite'
const server = await preview({
  preview: { host: '127.0.0.1', port: 3498, strictPort: true },
})
for (const signal of ['SIGINT', 'SIGTERM'])
  process.on(signal, () => server.httpServer.close())
