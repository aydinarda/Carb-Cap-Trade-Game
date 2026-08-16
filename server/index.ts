import express from 'express'
import { existsSync } from 'node:fs'
import { createServer } from 'node:http'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { Server } from 'socket.io'
import type { ClientToServerEvents, ServerToClientEvents } from '../shared/events'
import { BotManager } from './bots/BotManager'
import { PORT } from './config'
import { broadcast, registerSockets, store } from './sockets'

const app = express()
const httpServer = createServer(app)

// When frontend and backend are deployed as separate services, set
// CLIENT_ORIGIN to the frontend URL(s) (comma-separated) so the browser's
// cross-origin socket.io handshake is allowed. Unset → reflect any origin
// (fine for the single-service deploy where they share an origin).
const clientOrigin = process.env.CLIENT_ORIGIN?.split(',').map((s) => s.trim())
const io = new Server<ClientToServerEvents, ServerToClientEvents>(httpServer, {
  cors: { origin: clientOrigin ?? true },
})

registerSockets(io)

// Backend bots (auctioning mode) run on a slow global tick.
new BotManager(io, store, broadcast).start()

app.get('/healthz', (_req, res) => {
  res.json({ ok: true })
})

// Single-service deploy: the bundle lives at dist/server/index.js and the client
// at dist/client, so serve the SPA too. In the split deploy (backend built with
// build:server only) dist/client is absent — skip static serving so requests
// don't ENOENT; the frontend is a separate service then.
const here = path.dirname(fileURLToPath(import.meta.url))
const clientDir = path.resolve(here, '../client')
if (existsSync(path.join(clientDir, 'index.html'))) {
  app.use(express.static(clientDir))
  app.get('*', (_req, res) => {
    res.sendFile(path.join(clientDir, 'index.html'))
  })
} else {
  app.get('/', (_req, res) => {
    res.json({ ok: true, service: 'carbon-cap-trade-api' })
  })
}

httpServer.listen(PORT, () => {
  console.log(`Carbon cap-and-trade game server listening on :${PORT}`)
})
