/**
 * Capability tokens: what a session, a confirmation link, a deep link and an
 * unsubscribe link carry. 32 random bytes as base64url, and only the SHA-256
 * of one ever reaches the database, so a database read is not a session.
 */

import { createHash, randomBytes } from 'node:crypto'

export const randomToken = (): string => randomBytes(32).toString('base64url')

export const hashToken = (token: string): string => createHash('sha256').update(token).digest('hex')

/** A nonce is a token too; the name says what it is for. */
export const randomNonce = (): string => randomBytes(16).toString('base64url')

const TOKEN = /^[A-Za-z0-9_-]{16,64}$/

/** Refuse anything that could not have come from {@link randomToken}. */
export const isToken = (value: unknown): value is string => typeof value === 'string' && TOKEN.test(value)
