/**
 * The one email layout: the mark and the name at the top, a greeting, the
 * paragraphs, one button, and a footer that says why the mail came and how
 * to stop it. Every mail the service sends goes through here, so a
 * confirmation and a renewal reminder look like the same sender, which is
 * what a mail client and a person both use to decide whether to trust one
 * (Rico, 2026-09-23: the plain-text version "clearly looks like spam").
 *
 * Tables and inline styles, because that is what mail clients render; the
 * mark is the app's own `/brand/nns-mark.png`, served from the site. The
 * text part carries the same words, with the button as a line.
 */

const escape = (value: string): string =>
  value.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] ?? c)

export interface EmailContent {
  /** "Hi rico," or "Hi," */
  readonly greeting: string
  readonly paragraphs: readonly string[]
  readonly cta: { readonly label: string; readonly url: string } | null
  /** Why this mail came: one sentence, in the footer. */
  readonly reason: string
  readonly unsubscribeUrl: string | null
}

export interface EmailBody {
  readonly text: string
  readonly html: string
}

const INK = '#1f2348'
const SOFT = '#6b7089'
const BLUE = '#0582ca'

export function emailBody(appUrl: string, content: EmailContent): EmailBody {
  const lines = [content.greeting, '', ...content.paragraphs.flatMap((p) => [p, ''])]
  if (content.cta !== null) lines.push(`${content.cta.label}: ${content.cta.url}`, '')
  lines.push(content.reason)
  if (content.unsubscribeUrl !== null) lines.push(`Stop these messages: ${content.unsubscribeUrl}`)
  lines.push('', 'Nimiq Names', appUrl)
  const text = lines.join('\n')

  const paragraph = (p: string) =>
    `<p style="margin:0 0 16px;font-size:15px;line-height:1.55;color:${INK}">${escape(p).replace(/(https?:\/\/[^\s<]+)/g, `<a href="$1" style="color:${BLUE}">$1</a>`)}</p>`
  const button =
    content.cta === null
      ? ''
      : `<table role="presentation" cellspacing="0" cellpadding="0" border="0" style="margin:8px 0 24px"><tr><td style="border-radius:12px;background:${BLUE}">` +
        `<a href="${escape(content.cta.url)}" style="display:inline-block;padding:13px 22px;font-size:15px;font-weight:600;color:#ffffff;text-decoration:none;border-radius:12px">${escape(content.cta.label)}</a>` +
        `</td></tr></table>`
  const unsubscribe =
    content.unsubscribeUrl === null
      ? ''
      : ` <a href="${escape(content.unsubscribeUrl)}" style="color:${SOFT}">Stop these messages</a>.`

  const html =
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Nimiq Names</title></head>` +
    `<body style="margin:0;padding:0;background:#f4f5f9">` +
    `<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="background:#f4f5f9"><tr><td align="center" style="padding:32px 16px">` +
    `<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="max-width:520px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif">` +
    `<tr><td style="padding:0 4px 18px"><table role="presentation" cellspacing="0" cellpadding="0" border="0"><tr>` +
    `<td style="padding-right:10px"><img src="${escape(appUrl)}/brand/nns-mark.png" width="36" height="36" alt="" style="display:block;border:0;border-radius:8px"></td>` +
    `<td style="font-size:18px;font-weight:700;color:${INK}">Nimiq Names</td></tr></table></td></tr>` +
    `<tr><td style="background:#ffffff;border-radius:16px;padding:28px 28px 12px;border:1px solid #e1e5ee">` +
    `<p style="margin:0 0 16px;font-size:16px;font-weight:600;color:${INK}">${escape(content.greeting)}</p>` +
    content.paragraphs.map(paragraph).join('') +
    button +
    `</td></tr>` +
    `<tr><td style="padding:18px 8px 0;font-size:12.5px;line-height:1.5;color:${SOFT}">${escape(content.reason)}${unsubscribe}<br>` +
    `<a href="${escape(appUrl)}" style="color:${SOFT}">${escape(appUrl.replace(/^https?:\/\//, ''))}</a></td></tr>` +
    `</table></td></tr></table></body></html>`

  return { text, html }
}

/** "Hi rico," when the address holds a name, else "Hi,". */
export const greetingFor = (name: string | null): string => (name === null ? 'Hi,' : `Hi ${name},`)
