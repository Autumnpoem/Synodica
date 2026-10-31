// The shared live stream for every connected client (browsers, phones, desktop windows). Each event
// gets a sequence number within this server run (`epoch`); every connection, and every reconnection,
// starts with the authoritative snapshot and the position it is valid at, so a client that missed
// events (sleep, network change, server restart) never keeps stale messages, busy rounds or typing
// indicators. A disconnecting client only unsubscribes: server work never depends on a connection.
import { randomBytes } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { SyncFrame, TypingMap } from '../shared/sync.js'
import type { AppState, ServerEvent } from '../shared/types.js'

/** A stream whose client stopped reading is closed beyond this many buffered bytes; it reconnects and resyncs. */
const MAX_BUFFERED = 8 * 1024 * 1024

export interface EventHubOptions {
  subscribe: (fn: (event: ServerEvent) => void) => () => void
  /** The authoritative state at this instant (conversations, busy rounds, approvals, projects…). */
  snapshot: () => AppState
  heartbeatMs?: number
}

interface Client {
  res: ServerResponse
  ping: NodeJS.Timeout
}

export class EventHub {
  readonly epoch = randomBytes(8).toString('hex')
  private seq = 0
  private readonly typing = new Map<string, Set<string>>()
  private readonly clients = new Set<Client>()
  private readonly unsubscribe: () => void
  private closed = false

  constructor(private readonly opts: EventHubOptions) {
    this.unsubscribe = opts.subscribe((event) => this.publish(event))
  }

  /** Current position on the stream. */
  position(): { epoch: string; seq: number } {
    return { epoch: this.epoch, seq: this.seq }
  }

  /** Who is typing, by conversation (part of every snapshot). */
  typingMap(): TypingMap {
    const out: TypingMap = {}
    for (const [c, set] of this.typing) if (set.size) out[c] = [...set]
    return out
  }

  /** Connected stream count (health and tests). */
  size(): number {
    return this.clients.size
  }

  /** The sync frame a (re)connecting client starts from. */
  frame(): SyncFrame {
    // Taken in one synchronous step: no event can slip between the snapshot and its position.
    return { epoch: this.epoch, seq: this.seq, state: { ...this.opts.snapshot(), typing: this.typingMap() } }
  }

  /** Serve one event stream: the sync frame, then every later event with its sequence number. */
  serve(req: IncomingMessage, res: ServerResponse): void {
    if (this.closed) {
      res.statusCode = 503
      res.setHeader('Retry-After', '2')
      res.end()
      return
    }
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8')
    res.setHeader('Cache-Control', 'no-cache, no-store, no-transform')
    res.setHeader('Connection', 'keep-alive')
    // Reverse proxies (nginx) must not buffer the stream.
    res.setHeader('X-Accel-Buffering', 'no')
    res.flushHeaders()
    const f = this.frame()
    res.write(`retry: 2000\nevent: sync\nid: ${f.epoch}:${f.seq}\ndata: ${JSON.stringify(f)}\n\n`)
    const client: Client = {
      res,
      ping: setInterval(() => this.write(client, ': ping\n\n'), this.opts.heartbeatMs ?? 15_000),
    }
    client.ping.unref?.()
    this.clients.add(client)
    const drop = () => this.drop(client)
    req.on('close', drop)
    res.on('close', drop)
  }

  /** Server shutdown: tell every client, then end every stream (clients reconnect and resync). */
  closeAll(): void {
    this.closed = true
    for (const c of [...this.clients]) {
      this.write(c, `data: ${JSON.stringify({ type: 'server', state: 'draining', seq: this.seq })}\n\n`)
      this.drop(c)
      c.res.end()
    }
  }

  dispose(): void {
    this.closeAll()
    this.unsubscribe()
  }

  private publish(event: ServerEvent): void {
    if (event.type === 'typing') {
      const set = this.typing.get(event.conversationId) ?? new Set<string>()
      if (event.on) set.add(event.agentId)
      else set.delete(event.agentId)
      this.typing.set(event.conversationId, set)
    } else if (event.type === 'round' && !event.running) this.typing.delete(event.conversationId)
    const seq = ++this.seq
    const frame = `id: ${this.epoch}:${seq}\ndata: ${JSON.stringify({ ...event, seq })}\n\n`
    for (const c of this.clients) this.write(c, frame)
  }

  private write(c: Client, chunk: string): void {
    if (c.res.writableEnded || c.res.destroyed) return this.drop(c)
    if (c.res.writableLength > MAX_BUFFERED) {
      this.drop(c)
      c.res.destroy()
      return
    }
    c.res.write(chunk)
  }

  private drop(c: Client): void {
    clearInterval(c.ping)
    this.clients.delete(c)
  }
}
