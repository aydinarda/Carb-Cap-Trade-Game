import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { Server } from 'socket.io'
import { io as connectClient, type Socket as ClientSocket } from 'socket.io-client'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { IO } from '../broadcaster'
import { HOST_KEY } from '../config'
import { connLogSettings, describePacket, formatEvents } from '../connLog'
import { registerSockets } from '../sockets'

/**
 * The connection log (2026-11-17): a drop is logged with its reason, heartbeat and last events,
 * and the identity coming back with how long it was away and its first events. Logging only.
 */
describe('connection log', () => {
  const httpServer = createServer()
  const io: IO = new Server(httpServer)
  let url = ''
  const clients: ClientSocket[] = []

  beforeAll(async () => {
    registerSockets(io)
    await new Promise<void>((r) => httpServer.listen(0, r))
    url = `http://localhost:${(httpServer.address() as AddressInfo).port}`
  })
  afterAll(async () => {
    for (const c of clients) c.close()
    await new Promise<void>((r) => io.close(() => r()))
  })

  const client = (auth: object = {}) => {
    const c = connectClient(url, { transports: ['websocket'], auth, reconnectionDelay: 50, reconnectionDelayMax: 50 })
    clients.push(c)
    return c
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const request = (c: ClientSocket, event: string, payload: object) => new Promise<any>((r) => c.emit(event, payload, r))
  const until = async (ok: () => boolean, ms = 3000) => {
    for (const end = Date.now() + ms; !ok(); ) {
      if (Date.now() > end) throw new Error('timed out')
      await new Promise((r) => setTimeout(r, 20))
    }
  }

  it('logs a drop with its reason and last events, then the return and the first events after it', async () => {
    connLogSettings.afterMs = 300
    const lines: string[] = []
    const spy = vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => void lines.push(a.join(' ')))
    try {
      const host = client()
      const created = await request(host, 'host:createSession', { hostKey: HOST_KEY, capMode: 'hybrid' })
      expect(created.ok).toBe(true)
      const fresh = client()
      const joined = await request(fresh, 'player:join', { roomCode: created.roomCode, name: 'Ada', industry: 'Transport' })
      expect(joined.ok).toBe(true)
      fresh.close()

      // The browser reconnects with the identity it stored at join.
      const player = client({ role: 'player', roomCode: created.roomCode, token: joined.token })
      await until(() => player.connected)
      await request(player, 'player:setBorrow', { on: false }) // refused in the lobby; still an event
      lines.length = 0

      player.io.engine.close() // the connection is cut; socket.io-client reconnects on its own
      await until(() => lines.some((l) => l.includes('[conn]   after:')))

      const drop = lines.find((l) => l.startsWith('[conn] drop'))
      expect(drop).toMatch(/lobby · "Ada" \(Transport\) · transport close · connected [\d.]+ s · last packet in [\d.]+ s ago/)
      expect(drop).toMatch(/unsent packets \d+/)
      expect(lines.find((l) => l.startsWith('[conn]   before:'))).toContain('in player:setBorrow')
      expect(lines.find((l) => l.startsWith('[conn] back'))).toMatch(/"Ada" \(Transport\) · after [\d.]+ s \(dropped: transport close\)/)
      expect(lines.find((l) => l.startsWith('[conn]   after:'))).toMatch(/out snapshot \d+ KB/)
    } finally {
      spy.mockRestore()
      connLogSettings.afterMs = 10_000
    }
  })

  it('reads what a packet was from its first characters', () => {
    expect(describePacket('2["player:placeOrder",{"side":"buy"}]')).toBe('player:placeOrder')
    expect(describePacket('27["player:abate",{}]')).toBe('player:abate')
    expect(describePacket(`2["session:snapshot",{"x":"${'a'.repeat(3000)}"}]`)).toBe('snapshot 3 KB')
    expect(describePacket('31[{"ok":true}]')).toBe('ack')
  })

  it('folds nothing it is not given and shows times relative to the drop', () => {
    expect(formatEvents([], 0)).toBe('none')
    expect(formatEvents([{ start: 1000, end: 4000, text: 'out snapshot 22 KB', n: 12 }, { start: 4500, end: 4500, text: 'in pong', n: 1 }], 5000))
      .toBe('-4.0…-1.0 out snapshot 22 KB ×12 · -0.5 in pong')
  })
})
