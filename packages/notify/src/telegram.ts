/**
 * The Telegram Bot API, the three calls this service makes: `getMe` for the
 * bot's name (the deep link needs it), `sendMessage`, and `getUpdates` with
 * long polling — no webhook, so no inbound route and no secret in a URL.
 */

import { DeliveryRefused, type TelegramSender } from './transport.js'

export class TelegramError extends Error {
  override readonly name = 'TelegramError'
  readonly code: number
  constructor(code: number, message: string) {
    super(message)
    this.code = code
  }
}

export interface TelegramUpdate {
  readonly updateId: number
  readonly chatId: string
  readonly text: string
}

export type TelegramFetch = (url: string, init: { method: string; headers: Record<string, string>; body: string }) => Promise<{
  readonly status: number
  text(): Promise<string>
}>

export class TelegramApi implements TelegramSender {
  private readonly token: string
  private readonly fetcher: TelegramFetch

  constructor(token: string, fetcher: TelegramFetch = (url, init) => fetch(url, init)) {
    this.token = token
    this.fetcher = fetcher
  }

  async call(method: string, params: Record<string, unknown>): Promise<unknown> {
    const response = await this.fetcher(`https://api.telegram.org/bot${this.token}/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(params),
    })
    const text = await response.text()
    let body: { ok?: boolean; result?: unknown; description?: string; error_code?: number } = {}
    try {
      body = JSON.parse(text) as typeof body
    } catch {
      throw new TelegramError(response.status, `${method}: non-JSON answer (${response.status})`)
    }
    if (body.ok !== true) throw new TelegramError(body.error_code ?? response.status, `${method}: ${body.description ?? 'failed'}`)
    return body.result
  }

  /** The bot's username, for `https://t.me/<username>?start=<token>`. */
  async username(): Promise<string> {
    const me = (await this.call('getMe', {})) as { username?: unknown }
    if (typeof me.username !== 'string') throw new TelegramError(0, 'getMe carried no username')
    return me.username
  }

  async send(chatId: string, text: string): Promise<void> {
    try {
      await this.call('sendMessage', { chat_id: chatId, text, disable_web_page_preview: true })
    } catch (error) {
      // 403: the user blocked the bot or deleted the chat. 400 "chat not
      // found": the same. Neither will ever succeed for this chat id.
      if (error instanceof TelegramError && (error.code === 403 || (error.code === 400 && /chat not found/i.test(error.message)))) {
        throw new DeliveryRefused(error.message)
      }
      throw error
    }
  }

  /** Long poll: blocks up to `timeoutSeconds` server-side, then answers whatever arrived. */
  async updates(offset: number | null, timeoutSeconds: number): Promise<readonly TelegramUpdate[]> {
    const result = (await this.call('getUpdates', {
      ...(offset === null ? {} : { offset }),
      timeout: timeoutSeconds,
      allowed_updates: ['message'],
    })) as unknown
    if (!Array.isArray(result)) return []
    const updates: TelegramUpdate[] = []
    for (const entry of result) {
      const { update_id, message } = (entry ?? {}) as { update_id?: unknown; message?: { text?: unknown; chat?: { id?: unknown } } }
      if (typeof update_id !== 'number') continue
      const chatId = message?.chat?.id
      const text = message?.text
      updates.push({
        updateId: update_id,
        chatId: typeof chatId === 'number' || typeof chatId === 'string' ? String(chatId) : '',
        text: typeof text === 'string' ? text : '',
      })
    }
    return updates
  }
}
