/**
 * The dsh-plugins package root: the plugin family's composition layer. Each
 * plugin owns its own loader row in `cordis.patch.yml`; this entry only
 * re-exports the family's public surfaces so consumers and tests can reach
 * them without deep paths.
 * @module dsh-plugins
 */

export { apply as applyEffort } from './command-effort/index.ts'
export type { EffortLevelInfo, EffortPickAnswer, EffortPickRequest } from './command-effort/types.ts'
export { apply as applyModel, routeLabel } from './command-model/index.ts'
export type { ModelOptionInfo, ModelPickAnswer, ModelPickRequest } from './command-model/types.ts'
export type {
  AgentModelLike,
  CommandResultLike,
  EffortLevelInfo as SharedEffortLevelInfo,
  LlmLike,
  ModelInfoLike,
} from './shared/index.ts'
export { EFFORT_DESCRIPTION_FALLBACKS, nearestLowerEffort, STANDARD_EFFORT_LADDER, withDescription } from './shared/index.ts'