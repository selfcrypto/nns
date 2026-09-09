import { yesterdayLabel } from './wording'

/**
 * The Inbox's two timestamps, off an injected clock so a test can stand at
 * one minute past midnight. Calendar days, not 24-hour windows: a message
 * from 23:50 is "Yesterday" at 00:10, as every messenger says it.
 */

function sameDay(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate()
}

function timeOf(date: Date): string {
  return date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
}

function dayOf(date: Date): string {
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

/** A thread row: "9:42 AM" today, "Yesterday", else "Sep 9". */
export function formatThreadDate(timestampMs: number, nowMs: number): string {
  const date = new Date(timestampMs)
  const now = new Date(nowMs)
  if (sameDay(date, now)) return timeOf(date)
  const yesterday = new Date(now)
  yesterday.setDate(now.getDate() - 1)
  if (sameDay(date, yesterday)) return yesterdayLabel()
  return dayOf(date)
}

/** A bubble: "4:14 AM" today, else "Sep 9, 4:14 AM". */
export function formatBubbleTimestamp(timestampMs: number, nowMs: number): string {
  const date = new Date(timestampMs)
  const time = timeOf(date)
  return sameDay(date, new Date(nowMs)) ? time : `${dayOf(date)}, ${time}`
}
