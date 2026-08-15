/**
 * The labels file, held in memory and reloaded without a restart.
 *
 * **Polling `stat`, not `fs.watch`.** An editor's atomic save replaces the
 * inode and takes the watch with it, and a bind mount under WSL or Docker
 * Desktop delivers no events at all — so a watch is a mechanism that works on
 * the machine it was written on and silently stops working in the compose
 * profile. mtime and size, every `reloadSec`, plus `SIGHUP` to force one.
 *
 * **A reload never degrades service.** The new file is parsed and validated in
 * full before anything is swapped; on failure the previous map keeps serving
 * and the error is logged with the offending key. An owner's typo must not
 * take their subdomains down.
 *
 * Boot is the exception: an invalid file at startup is fatal, because there is
 * no good state to keep serving and a delegate answering 404 for every label
 * is indistinguishable — to a client, by design — from one that is merely
 * misconfigured.
 */

import { stat, readFile } from 'node:fs/promises'

import { readLabelFile, LabelFileError, type LabelFile } from './labels.js'
import type { Logger } from './logger.js'

/** What the routes read. An interface so they can be tested without a file. */
export interface LabelSource {
  current(): LabelFile
  /** Unix ms at which the served file was loaded. */
  loadedAt(): number
}

export interface StoreOptions {
  readonly path: string
  readonly fallbackTtl: number
  readonly reloadSec: number
  readonly logger: Logger
  readonly now?: () => number
}

interface Stamp {
  readonly mtimeMs: number
  readonly size: number
}

async function load(path: string, fallbackTtl: number): Promise<{ file: LabelFile; stamp: Stamp }> {
  const info = await stat(path)
  const text = await readFile(path, 'utf8')
  return { file: readLabelFile(text, fallbackTtl), stamp: { mtimeMs: info.mtimeMs, size: info.size } }
}

export class LabelStore implements LabelSource {
  readonly #options: StoreOptions
  readonly #now: () => number
  #file: LabelFile
  #stamp: Stamp
  #loadedAt: number
  #timer: NodeJS.Timeout | null = null
  #reloading = false

  private constructor(options: StoreOptions, file: LabelFile, stamp: Stamp) {
    this.#options = options
    this.#now = options.now ?? Date.now
    this.#file = file
    this.#stamp = stamp
    this.#loadedAt = this.#now()
  }

  /** Read and validate the file. Throws {@link LabelFileError} — boot is fatal. */
  static async open(options: StoreOptions): Promise<LabelStore> {
    const { file, stamp } = await load(options.path, options.fallbackTtl)
    return new LabelStore(options, file, stamp)
  }

  current(): LabelFile {
    return this.#file
  }

  loadedAt(): number {
    return this.#loadedAt
  }

  /** Begin polling. Unrefed: the HTTP server, not this timer, keeps the process up. */
  start(): void {
    if (this.#timer !== null) return
    this.#timer = setInterval(() => {
      void this.poll()
    }, this.#options.reloadSec * 1_000)
    this.#timer.unref()
  }

  stop(): void {
    if (this.#timer === null) return
    clearInterval(this.#timer)
    this.#timer = null
  }

  /** One poll: reload only if mtime or size moved. */
  async poll(): Promise<boolean> {
    if (this.#reloading) return false
    try {
      const info = await stat(this.#options.path)
      if (info.mtimeMs === this.#stamp.mtimeMs && info.size === this.#stamp.size) return false
    } catch (error) {
      this.#logFailure(error)
      return false
    }
    return await this.reload()
  }

  /**
   * Reload unconditionally — the `SIGHUP` path, and what `poll` calls once it
   * has seen the file move. Returns whether the served map was replaced.
   */
  async reload(): Promise<boolean> {
    if (this.#reloading) return false
    this.#reloading = true
    try {
      const { file, stamp } = await load(this.#options.path, this.#options.fallbackTtl)
      this.#file = file
      this.#stamp = stamp
      this.#loadedAt = this.#now()
      this.#options.logger.info('delegate.labels.loaded', {
        path: this.#options.path,
        name: file.name,
        labels: file.labels.size,
      })
      return true
    } catch (error) {
      this.#logFailure(error)
      return false
    } finally {
      this.#reloading = false
    }
  }

  /**
   * The key is the whole point of the line: an owner with a hundred labels
   * needs to know which one, and whole-file rejection is what makes it the
   * only thing they need to know.
   */
  #logFailure(error: unknown): void {
    this.#options.logger.error('delegate.labels.rejected', {
      path: this.#options.path,
      key: error instanceof LabelFileError ? error.key : null,
      error: error instanceof Error ? error.message : String(error),
      serving: 'previous',
      labels: this.#file.labels.size,
    })
  }
}
