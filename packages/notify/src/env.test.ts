import { describe, expect, it } from 'vitest'

import { EnvError, loadSettings } from './env.js'

const BASE = {
  NNS_NOTIFY_DATABASE_URL: 'postgres://nns:nns@localhost/nns_notify',
  NNS_NOTIFY_API_URL: 'https://api.nimiqnames.com/',
  NNS_NOTIFY_PUBLIC_URL: 'https://nimiqnames.com/notify',
}

describe('loadSettings', () => {
  it('runs with no channel configured, and derives the app URL and host from the public one', () => {
    const settings = loadSettings(BASE)
    expect(settings.apiUrl).toBe('https://api.nimiqnames.com')
    expect(settings.appUrl).toBe('https://nimiqnames.com')
    expect(settings.host).toBe('nimiqnames.com')
    expect(settings.telegramToken).toBeNull()
    expect(settings.smtp).toBeNull()
    expect(settings.chatUrl).toBeNull()
    expect(settings.conventions).toEqual(['nimiq'])
    expect(settings.port).toBe(8638)
  })

  it('reads SMTP, picking implicit TLS on 465', () => {
    const smtp = { NNS_NOTIFY_SMTP_HOST: 'mail.example.com', NNS_NOTIFY_SMTP_USER: 'notify@example.com', NNS_NOTIFY_SMTP_PASSWORD: 'p', NNS_NOTIFY_SMTP_FROM: 'Nimiq Names <notify@example.com>' }
    expect(loadSettings({ ...BASE, ...smtp })?.smtp).toMatchObject({ port: 587, secure: 'starttls' })
    expect(loadSettings({ ...BASE, ...smtp, NNS_NOTIFY_SMTP_PORT: '465' })?.smtp).toMatchObject({ port: 465, secure: 'tls' })
    expect(() => loadSettings({ ...BASE, NNS_NOTIFY_SMTP_HOST: 'mail.example.com' })).toThrow(EnvError)
    // A relay on the compose network: no TLS on the hop, no AUTH.
    expect(loadSettings({ ...BASE, NNS_NOTIFY_SMTP_HOST: 'mailer', NNS_NOTIFY_SMTP_SECURE: 'plain', NNS_NOTIFY_SMTP_FROM: 'n@x.io' })?.smtp).toMatchObject({ secure: 'plain', user: '' })
    expect(() => loadSettings({ ...BASE, NNS_NOTIFY_SMTP_HOST: 'mailer', NNS_NOTIFY_SMTP_SECURE: 'maybe', NNS_NOTIFY_SMTP_FROM: 'n@x.io' })).toThrow(EnvError)
  })

  it('pins the signature conventions when told to', () => {
    expect(loadSettings({ ...BASE, NNS_NOTIFY_SIGN_CONVENTIONS: 'nimiq' }).conventions).toEqual(['nimiq'])
    expect(() => loadSettings({ ...BASE, NNS_NOTIFY_SIGN_CONVENTIONS: 'magic' })).toThrow(EnvError)
  })

  it('refuses a missing database or API', () => {
    expect(() => loadSettings({ ...BASE, NNS_NOTIFY_API_URL: '' })).toThrow(/NNS_NOTIFY_API_URL/)
    expect(() => loadSettings({ ...BASE, NNS_NOTIFY_PUBLIC_URL: 'nimiqnames.com' })).toThrow(/http/)
  })
})
