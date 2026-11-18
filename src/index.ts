/**
 * The dsh-plugins package root: the plugin family's composition layer. Each
 * plugin owns its own loader row in `cordis.patch.yml`; this entry only
 * re-exports the family's public surfaces so consumers and tests can reach
 * them without deep paths.
 * @module dsh-plugins
 */

export { apply as applyEffort } from './command-effort/index.ts'
export { apply as applyModel, modelDisplayName, routeLabel } from './command-model/index.ts'
export { apply as applyContext, foldReport, formatDuration, formatTokens, renderReport } from './command-context/index.ts'
export type { ContextReport, TurnUsage, UsageTotals } from './command-context/index.ts'
export type { PickerAnswer, PickerKind, PickerOption, PickerRequest } from './picker/index.ts'
export { askPicker, nextPickerId } from './picker/index.ts'
export type {
  AgentModelLike,
  CommandResultLike,
  LlmLike,
  ModelInfoLike,
} from './shared/index.ts'
export { EFFORT_DESCRIPTION_FALLBACKS, nearestLowerEffort, STANDARD_EFFORT_LADDER, withDescription } from './shared/index.ts'
