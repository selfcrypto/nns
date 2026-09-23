import { describe, expect, it } from 'vitest'

import { emailBody, greetingFor } from './email.js'

describe('emailBody', () => {
  const body = emailBody('https://nimiqnames.com', {
    greeting: 'Hi rico,',
    paragraphs: ['riconame is yours until 2027-09-22. <Renewal> is open.', 'See https://x.io/p'],
    cta: { label: 'Renew riconame', url: 'https://nimiqnames.com/#/names/riconame' },
    reason: 'You receive this because notifications for NQ57 … were set up in the Nimiq Names app.',
    unsubscribeUrl: 'https://nimiqnames.com/notify/unsubscribe/t0k',
  })

  it('says the same thing in text and in HTML', () => {
    expect(body.text).toBe(
      [
        'Hi rico,',
        '',
        'riconame is yours until 2027-09-22. <Renewal> is open.',
        '',
        'See https://x.io/p',
        '',
        'Renew riconame: https://nimiqnames.com/#/names/riconame',
        '',
        'You receive this because notifications for NQ57 … were set up in the Nimiq Names app.',
        'Stop these messages: https://nimiqnames.com/notify/unsubscribe/t0k',
        '',
        'Nimiq Names',
        'https://nimiqnames.com',
      ].join('\n'),
    )
    expect(body.html).toContain('src="https://nimiqnames.com/brand/nns-mark.png"')
    expect(body.html).toContain('>Hi rico,</p>')
    expect(body.html).toContain('&lt;Renewal&gt;')
    expect(body.html).toContain('<a href="https://x.io/p"')
    expect(body.html).toContain('<a href="https://nimiqnames.com/#/names/riconame" style="display:inline-block')
    expect(body.html).toContain('Renew riconame</a>')
    expect(body.html).toContain('href="https://nimiqnames.com/notify/unsubscribe/t0k"')
  })

  it('leaves the button and the unsubscribe out when there is none', () => {
    const plain = emailBody('https://nimiqnames.com', { greeting: 'Hi,', paragraphs: ['p'], cta: null, reason: 'r', unsubscribeUrl: null })
    expect(plain.html).not.toContain('display:inline-block')
    expect(plain.html).not.toContain('Stop these messages')
    expect(plain.text).not.toContain('Stop these messages')
  })

  it('greets by name when there is one', () => {
    expect(greetingFor('rico')).toBe('Hi rico,')
    expect(greetingFor(null)).toBe('Hi,')
  })
})
