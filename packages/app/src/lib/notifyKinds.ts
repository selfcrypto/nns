/**
 * The four event categories the notifier offers as toggles, in the order
 * the sheet lists them. Mirrors `packages/notify`'s `CATEGORIES`; the app
 * imports nothing from that service, so the list is restated here and the
 * server refuses a preferences object that does not carry exactly these.
 */

export type Category = 'renewal' | 'market' | 'transfer' | 'chat'

export const CATEGORIES: readonly Category[] = ['renewal', 'market', 'transfer', 'chat']
