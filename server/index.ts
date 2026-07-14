import express from 'express'
import { createServer } from 'node:http'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { Server } from 'socket.io'
import type { ClientToServerEvents, ServerToClientEvents } from '../shared/events'
import { PORT } from './config'
import { registerSockets } from './sockets'

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

app.get('/healthz', (_req, res) => {
  res.json({ ok: true })
})

// In production the bundle lives at dist/server/index.js and the client at dist/client
const here = path.dirname(fileURLToPath(import.meta.url))
const clientDir = path.resolve(here, '../client')
app.use(express.static(clientDir))
app.get('*', (_req, res) => {
  res.sendFile(path.join(clientDir, 'index.html'))
})

httpServer.listen(PORT, () => {
  console.log(`Carbon cap-and-trade game server listening on :${PORT}`)
})
