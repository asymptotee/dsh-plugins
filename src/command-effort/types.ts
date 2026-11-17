/**
 * The `/effort` command's public contract: the picker-request waterfall a
 * frontend answers, and the Cordis event declaration that publishes it.
 * @module dsh-command-effort/types
 */

/** One selectable reasoning-effort level carried by the picker request. */
export interface EffortLevelInfo {
  readonly id: string
  readonly name?: string
  readonly description?: string
}

/** The picker request dispatched by a bare `/effort`. */
export interface EffortPickRequest {
  /** The agent whose effort is being chosen. */
  readonly agent: unknown
  /** The adapter-disclosed levels, ordered faster → smarter, with
   *  descriptions backfilled for well-known ids. */
  readonly levels: readonly EffortLevelInfo[]
  /** The level in effect at request time (the picker's starting point). */
  readonly current?: string
  /** The dispatch's cancellation signal; aborting should close the picker. */
  readonly signal: AbortSignal
}

/** The picker's verdict: a chosen level id, or an explicit cancellation. */
export type EffortPickAnswer = { readonly level: string } | { readonly cancelled: true }

declare module '@deepseek-ai/cordis' {
  interface Events {
    /**
     * Ask a mounted frontend to pick one reasoning-effort level
     * interactively. Return an answer to claim the request, or call `next()`
     * to delegate; the dispatcher's terminal fallback resolves `undefined`,
     * which the command renders as a headless text report.
     * @mode waterfall
     */
    'effort-picker/request'(
      req: EffortPickRequest,
      next: () => Promise<EffortPickAnswer | undefined>,
    ): Promise<EffortPickAnswer | undefined>
  }
}