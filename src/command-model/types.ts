/**
 * The `/model` command's public contract: the picker-request waterfall a
 * frontend answers, and the Cordis event declaration that publishes it.
 * @module dsh-plugins/model/types
 */

/** One selectable model route carried by the picker request. */
export interface ModelOptionInfo {
  /** The provider route that owns the model. */
  readonly provider: string
  /** The model id passed on the next request. */
  readonly model: string
  /** Human-readable name for selectors. */
  readonly name?: string
  /** The adapter's optional user-facing distinction. */
  readonly description?: string
}

/** The picker request dispatched by a bare `/model`. */
export interface ModelPickRequest {
  /** The agent whose route is being chosen. */
  readonly agent: unknown
  /** Every discovered route, in adapter-preferred order. */
  readonly models: readonly ModelOptionInfo[]
  /** The `provider/model` in effect at request time (the picker's
   *  starting point); absent when no selection is recorded. */
  readonly current?: string
  /** The dispatch's cancellation signal; aborting should close the picker. */
  readonly signal: AbortSignal
}

/** The picker's verdict: a chosen route, or an explicit cancellation. */
export type ModelPickAnswer =
  | { readonly provider: string; readonly model: string }
  | { readonly cancelled: true }

declare module '@deepseek-ai/cordis' {
  interface Events {
    /**
     * Ask a mounted frontend to pick one model route interactively. Return
     * an answer to claim the request, or call `next()` to delegate; the
     * dispatcher's terminal fallback resolves `undefined`, which the command
     * renders as a headless text report.
     * @mode waterfall
     */
    'model-picker/request'(
      req: ModelPickRequest,
      next: () => Promise<ModelPickAnswer | undefined>,
    ): Promise<ModelPickAnswer | undefined>
  }
}