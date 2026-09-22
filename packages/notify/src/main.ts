/**
 * Entrypoint: migrate, serve, and run the three loops — the log tail, the
 * chat tail and the bot's long poll.
 *
 * Nothing here can affect the registry. Separate process, separate database,
 * no key. Stop it and the names, the log and every root are exactly as they
 * were; the only thing that stops is mail.
 */

import { EnvError, loadSettings, type NotifySettings } from './env.js'
import { botReply } from './bot.js'
import { deliver } from './deliver.js'
import { replayEvents, type NotifyEvent } from './events.js'
import { createLogger, type Logger } from './logger.js'
import { renewalsDue } from './milestones.js'
import { createNotifyServer } from './server.js'
import { SmtpSender } from './smtp.js'
import { fetchChatSince, fetchLatestCheckpoint, fetchLog, fetchName, fetchNamesOf, type Fetcher } from './source.js'
import { Store, createPool, migrate, type Contact } from './store.js'
import { TelegramApi } from './telegram.js'
import { hashToken, randomToken } from './tokens.js'
import type { Transport } from './transport.js'

const sleep = (ms: number, signal: AbortSignal): Promise<void> =>
  new Promise((resolve) => {
    if (signal.aborted) return resolve()
    const timer = setTimeout(done, ms)
    function done(): void {
      clearTimeout(timer)
      signal.removeEventListener('abort', done)
      resolve()
    }
    signal.addEventListener('abort', done, { once: true })
  })

const fetcher: Fetcher = (url, init) => fetch(url, init)

/** A name for an address, cached for one poll: what a message calls the other party. */
function nameResolver(apiUrl: string): (address: string) => Promise<string | null> {
  const cache = new Map<string, string | null>()
  return async (address) => {
    const hit = cache.get(address)
    if (hit !== undefined) return hit
    const names = await fetchNamesOf(apiUrl, address, fetcher).catch(() => [])
    const name = names[0] ?? null
    cache.set(address, name)
    return name
  }
}

async function pollOnce(settings: NotifySettings, store: Store, transport: Transport, logger: Logger, unsubscribeUrl: (c: Contact) => string | null): Promise<void> {
  const latest = await fetchLatestCheckpoint(settings.apiUrl, fetcher)
  if (latest === null) {
    logger.info('notify.waiting', { reason: 'no checkpoint yet' })
    return
  }
  const cursor = await store.loadCursor()
  if (cursor !== null && cursor.networkId !== settings.config.networkId) {
    throw new Error(`this database was built against network ${cursor.networkId}, not ${settings.config.networkId}`)
  }

  const events: NotifyEvent[] = []
  let checkpointHeight = cursor?.checkpointHeight ?? latest
  let head = latest

  if (cursor === null || latest > cursor.checkpointHeight) {
    const log = await fetchLog(settings.apiUrl, settings.config, fetcher)
    head = log.checkpointHeight
    // A first poll narrates nothing: history before anyone subscribed is not news.
    const from = cursor?.checkpointHeight ?? log.checkpointHeight
    const replayed = replayEvents(log.txs, settings.config, from, log.checkpointHeight)
    events.push(...replayed.events)
    for (const due of renewalsDue(replayed.state, log.checkpointHeight)) {
      events.push({ kind: due.milestone, to: due.owner, name: due.name, expiry: due.expiry })
    }
    checkpointHeight = log.checkpointHeight
  }

  let chatHeight = cursor?.chatHeight ?? null
  if (settings.chatUrl !== null) {
    if (chatHeight === null) {
      chatHeight = head
    } else {
      const subscribed = await store.subscribedAddresses()
      let since = chatHeight
      for (let pages = 0; pages < 20; pages++) {
        const pageOf = await fetchChatSince(settings.chatUrl, since, fetcher)
        for (const row of pageOf.rows) {
          if (row.to === row.from || !subscribed.has(row.to)) continue
          events.push({ kind: 'chat_message', to: row.to, from: row.from, hash: row.hash, height: row.blockNumber })
        }
        if (pageOf.next === null) {
          // A short page is the end: every row of its last block was in it.
          chatHeight = pageOf.rows.reduce((max, row) => Math.max(max, row.blockNumber), since)
          break
        }
        // A full page may have split a block; re-read that block next time.
        since = pageOf.next - 1
        chatHeight = since
      }
    }
  }

  // Only what subscribers can receive is worth rendering.
  const subscribed = await store.subscribedAddresses()
  const relevant = events.filter((event) => subscribed.has(event.to))
  if (relevant.length > 0) {
    const nameOf = nameResolver(settings.apiUrl)
    const names = new Map<string, string | null>()
    for (const event of relevant) {
      const others = 'buyer' in event ? [event.buyer] : 'bidder' in event ? [event.bidder] : 'winner' in event ? [event.winner] : 'from' in event ? [event.from] : []
      for (const other of others) if (!names.has(other)) names.set(other, await nameOf(other))
    }
    const report = await deliver(relevant, {
      store,
      transport,
      logger,
      context: { head, nowMs: Date.now(), appUrl: settings.appUrl, nameOf: (address) => names.get(address) ?? null },
      unsubscribeUrl,
      maxFailures: settings.maxFailures,
    })
    logger.info('notify.delivered', { events: relevant.length, ...report })
  }

  await store.saveCursor({ checkpointHeight, chatHeight, networkId: settings.config.networkId })
  await store.sweep(new Date())
}

async function botLoop(settings: NotifySettings, api: TelegramApi, store: Store, logger: Logger, signal: AbortSignal): Promise<void> {
  const deps = {
    link: (token: string, chatId: string) => store.bindTelegram(hashToken(token), chatId, randomToken(), new Date()),
    unlink: (chatId: string) => store.unlinkTelegram(chatId),
    addressesOf: (chatId: string) => store.addressesOfChat(chatId),
    namesOf: (address: string) => fetchNamesOf(settings.apiUrl, address, fetcher),
    lookup: (name: string) => fetchName(settings.apiUrl, name, fetcher),
    head: () => fetchLatestCheckpoint(settings.apiUrl, fetcher).catch(() => null),
    appUrl: settings.appUrl,
    nowMs: Date.now,
  }
  let offset: number | null = null
  while (!signal.aborted) {
    try {
      const updates = await api.updates(offset, 25)
      for (const update of updates) {
        offset = update.updateId + 1
        if (update.chatId === '' || update.text === '') continue
        try {
          await api.send(update.chatId, await botReply(update.text, update.chatId, deps))
        } catch (error) {
          logger.warn('notify.bot.reply-failed', { error })
        }
      }
    } catch (error) {
      if (signal.aborted) break
      logger.error('notify.bot.error', { error })
      await sleep(5_000, signal)
    }
  }
}

async function main(): Promise<void> {
  process.stdout.on('error', (error: NodeJS.ErrnoException) => {
    if (error.code !== 'EPIPE') throw error
  })

  let settings: NotifySettings
  try {
    settings = loadSettings()
  } catch (error) {
    if (error instanceof EnvError) {
      process.stderr.write(`configuration: ${error.message}\n`)
      process.exitCode = 2
      return
    }
    throw error
  }

  const logger = createLogger(settings.logLevel)
  const pool = createPool(settings.databaseUrl)
  const controller = new AbortController()

  try {
    await migrate(pool, logger)
    const store = new Store(pool)

    const telegram = settings.telegramToken === null ? null : new TelegramApi(settings.telegramToken)
    const telegramBot = telegram === null ? null : await telegram.username()
    const email = settings.smtp === null ? null : new SmtpSender(settings.smtp)
    const transport: Transport = { email, telegram }
    const unsubscribeUrl = (contact: Contact): string | null =>
      contact.channel === 'email' ? `${settings.publicUrl}/unsubscribe/${contact.unsubscribeToken}` : null

    const server = createNotifyServer({
      store,
      logger,
      host: settings.host,
      publicUrl: settings.publicUrl,
      appUrl: settings.appUrl,
      conventions: settings.conventions,
      sessionTtlMs: settings.sessionTtlMs,
      telegramBot,
      email,
    })
    server.listen(settings.port, () => logger.info('notify.listening', { port: settings.port }))

    const stop = (): void => {
      controller.abort()
      server.close()
    }
    process.on('SIGINT', stop)
    process.on('SIGTERM', stop)

    logger.info('notify.start', {
      apiUrl: settings.apiUrl,
      chatUrl: settings.chatUrl,
      telegram: telegramBot,
      email: email !== null,
      conventions: settings.conventions,
    })

    const bot = telegram === null ? Promise.resolve() : botLoop(settings, telegram, store, logger, controller.signal)

    while (!controller.signal.aborted) {
      try {
        await pollOnce(settings, store, transport, logger, unsubscribeUrl)
      } catch (error) {
        if (controller.signal.aborted) break
        logger.error('notify.poll.error', { error })
      }
      await sleep(settings.pollIntervalMs, controller.signal)
    }
    await bot
  } finally {
    await pool.end()
  }
}

await main()
