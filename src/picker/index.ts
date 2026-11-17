/**
 * The shared picker contract: one waterfall that any frontend can answer for
 * any command that asks the user to choose from a list or along a scale.
 *
 * A plugin owns what the choices mean; the frontend owns how they are shown
 * and which keys move the selection. Everything the two need to agree on
 * lives here, so a new picker-capable command needs no frontend change beyond
 * the popup it already has.
 * @module dsh-plugins/picker
 */

/** How a frontend should lay the options out. `scale` is an ordered track
 *  the user walks along (capability levels, intensities); `list` is an
 *  unordered set of named rows (models, routes, directories). */
export type PickerKind = 'scale' | 'list'

/** One choice the picker offers. */
export interface PickerOption {
  /** Opaque value the owning command interprets; never shown. */
  readonly value: string
  /** The row's primary text. */
  readonly label: string
  /** An optional short right-column note (a unit, a qualifier). */
  readonly note?: string
  /** An optional longer explanation of the focused choice. */
  readonly description?: string
}

/** The picker request dispatched over the waterfall. */
export interface PickerRequest {
  /** Discriminates concurrent pickers: the frontend keys its popup state
   *  and the answering promise by this id, and settles only its own. */
  readonly pickerId: string
  /** Which layout the choices suit. */
  readonly kind: PickerKind
  /** The popup's title line (e.g. `Effort`, `Model`). */
  readonly title: string
  /** The choices, in the order the owning command wants them shown. */
  readonly options: readonly PickerOption[]
  /** The index of the choice in effect, when there is one. */
  readonly currentIndex?: number
  /** Names for the scale layout's two ends; ignored by `list`. */
  readonly scaleEnds?: { readonly low: string; readonly high: string }
  /** The dispatch's cancellation signal. */
  readonly signal: AbortSignal
}

/** The picker's verdict: a chosen option, or an explicit cancellation. */
export type PickerAnswer =
  | { readonly value: string }
  | { readonly cancelled: true }

declare module '@deepseek-ai/cordis' {
  interface Events {
    /**
     * Ask a mounted frontend to present choices and report the pick. Return
     * an answer to claim the request, or call `next()` to delegate; the
     * dispatcher's terminal fallback resolves `undefined`, which the owning
     * command renders as a headless text report.
     * @mode waterfall
     */
    'picker/request'(
      req: PickerRequest,
      next: () => Promise<PickerAnswer | undefined>,
    ): Promise<PickerAnswer | undefined>
  }
}
/** Dispatch a picker request and resolve the outcome.
 *  `unanswered` means no frontend claimed it (the caller renders a headless
 *  text report), `cancelled` means the user dismissed the popup. */
export async function askPicker(
  ctx: { waterfall(name: string, req: PickerRequest, next: () => Promise<undefined>): Promise<PickerAnswer | undefined> },
  request: Omit<PickerRequest, 'signal'> & { signal?: AbortSignal },
): Promise<{ kind: 'picked'; value: string } | { kind: 'cancelled' } | { kind: 'unanswered' }> {
  const answer = await ctx.waterfall(
    'picker/request',
    { ...request, signal: request.signal ?? new AbortController().signal },
    () => Promise.resolve(undefined),
  )
  if (answer === undefined) return { kind: 'unanswered' }
  if ('cancelled' in answer) return { kind: 'cancelled' }
  return { kind: 'picked', value: answer.value }
}

/** Mint a picker id that is unique per dispatch within one process: the
 *  owning command's name plus a monotonic counter. */
let pickerSeq = 0
export function nextPickerId(owner: string): string {
  pickerSeq += 1
  return `${owner}:${pickerSeq}`
}
