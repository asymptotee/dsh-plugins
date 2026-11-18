/**
 * The `/context` command for DeepSeek Harness: a whole-session token report.
 *
 * `<no args>` prints the summary — a fill grid, the context window's used and
 * free shares, the session's turn/step counts and wall time. `/context all`
 * adds the per-turn breakdown. Everything is folded from the session log, so
 * paging and compaction cannot change the figures.
 *
 * The categories are the ones the harness actually measures: a model call's
 * `TokenUsage` is disjoint (uncached input, cache reads, cache writes,
 * output). There is no system-prompt/tools/skills split — no layer above the
 * adapter exposes request sections — so this report does not invent one.
 * @module dsh-plugins/context
 */

import type { Context } from '@deepseek-ai/cordis'
// Pulls the commands registry's Context augmentation into this program; the
// register call itself stays structural for version tolerance.
import type {} from '@deepseek-ai/dsh-commands'
import type { CommandResultLike } from '../shared/index.ts'
import { modelDisplayName } from '../command-model/index.ts'

/** One model call's disjoint token counts, as the adapter reports them. */
export interface UsageTotals {
  /** Uncached input tokens. */
  readonly input: number
  /** Output tokens. */
  readonly output: number
  /** Cached input read (billed input includes it). */
  readonly cacheRead: number
  /** Cached input written. */
  readonly cacheWrite: number
  /** The provider's own whole-call total, when it reported a consistent one. */
  readonly total?: number
}

/** One turn's slice of the report. */
export interface TurnUsage {
  readonly turn: number
  readonly usage: UsageTotals
  /** Wall time from the turn's first step to its last, when the log brackets it. */
  readonly wallMs: number
}

/** Everything the report renders. */
export interface ContextReport {
  /** The route in effect, when one is recorded. */
  readonly model?: string
  /** The context window the window share is measured against. */
  readonly window?: number
  /** Summed usage over the whole log. */
  readonly usage: UsageTotals
  /** The latest call's prompt size — what "used" means for the window. */
  readonly used: number
  /** Distinct turns carrying at least one closed step. */
  readonly turns: number
  /** Closed steps (`step/end`). */
  readonly steps: number
  /** Summed model wall time across steps. */
  readonly llmMs: number
  /** Summed tool wall time. */
  readonly toolMs: number
  /** Per-turn slices, oldest first. */
  readonly perTurn: readonly TurnUsage[]
}

/** The structural face of one session event this command reads. */
interface SessionEventLike {
  readonly type: string
  readonly seq: number
  readonly time?: number
  readonly data: Record<string, unknown>
}

/** The structural face of a session. */
interface SessionLike {
  snapshotEvents(): readonly SessionEventLike[]
}

interface AgentLike {
  readonly session: SessionLike
  readonly model: {
    current(): { provider: string; model: string; reasoningEffort?: string } | undefined
  }
}

interface CommandInvocationLike {
  agent: AgentLike
  rawInput: string
}

interface CommandsLike {
  register(definition: {
    name: string
    description: string
    input?: { hint?: string }
    handler(invocation: CommandInvocationLike): Promise<CommandResultLike> | CommandResultLike
  }): unknown
}

/** The pieces of a `TokenUsage` payload this report sums. */
interface UsagePayload {
  inputTokens?: unknown
  outputTokens?: unknown
  cacheReadTokens?: unknown
  cacheWriteTokens?: unknown
  totalTokens?: unknown
}

const ZERO: UsageTotals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }

function num(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0
}

function addUsage(left: UsageTotals, payload: UsagePayload | undefined): UsageTotals {
  if (payload === undefined) return left
  const total = num(payload.totalTokens)
  return {
    input: left.input + num(payload.inputTokens),
    output: left.output + num(payload.outputTokens),
    cacheRead: left.cacheRead + num(payload.cacheReadTokens),
    cacheWrite: left.cacheWrite + num(payload.cacheWriteTokens),
    ...(total === 0 && left.total === undefined ? {} : { total: (left.total ?? 0) + total }),
  }
}

/** Fold the whole log into the report shapes. */
export function foldReport(events: readonly SessionEventLike[], model?: string, window?: number): ContextReport {
  let usage = ZERO
  let used = 0
  let turns = 0
  let steps = 0
  let llmMs = 0
  let toolMs = 0
  const seenTurns = new Set<number>()
  const perTurn = new Map<number, { usage: UsageTotals; firstTime?: number; lastTime?: number }>()
  const stepStarts = new Map<string, number>()
  const toolCalls = new Map<string, number>()
  /** Extend a turn's bracketed window with one more event timestamp. */
  const touchTurn = (turn: number, time: number): void => {
    const slice = perTurn.get(turn) ?? { usage: ZERO }
    perTurn.set(turn, {
      usage: slice.usage,
      firstTime: slice.firstTime === undefined ? time : Math.min(slice.firstTime, time),
      lastTime: slice.lastTime === undefined ? time : Math.max(slice.lastTime, time),
    })
  }

  for (const event of events) {
    const data = event.data
    switch (event.type) {
      case 'step/start': {
        const key = `${String(data.turn)}:${String(data.step)}`
        if (typeof event.time === 'number') stepStarts.set(key, event.time)
        // A turn's wall time brackets every event it produces, so the slice's
        // first and last timestamps come from here rather than from the
        // messages that happen to carry usage.
        if (typeof data.turn === 'number' && typeof event.time === 'number') touchTurn(data.turn, event.time)
        continue
      }
      case 'step/end': {
        steps += 1
        // A step counts its turn as active once it closes.
        if (typeof data.turn === 'number') {
          seenTurns.add(data.turn)
          if (typeof event.time === 'number') touchTurn(data.turn, event.time)
        }
        continue
      }
      case 'assistant/message': {
        const payload = data.usage as UsagePayload | undefined
        if (payload === undefined) continue
        usage = addUsage(usage, payload)
        // "Used" is the latest call's prompt: uncached input plus cache reads,
        // the same figure the footer's ratio shows.
        used = num(payload.inputTokens) + num(payload.cacheReadTokens)
        const turn = typeof data.turn === 'number' ? data.turn : 0
        const slice = perTurn.get(turn) ?? { usage: ZERO }
        perTurn.set(turn, { ...slice, usage: addUsage(slice.usage, payload) })
        if (typeof event.time === 'number') touchTurn(turn, event.time)
        const time = typeof event.time === 'number' ? event.time : undefined
        // Model wall time: step start to this message, when both are timed.
        const key = `${turn}:${String(data.step)}`
        const started = stepStarts.get(key)
        if (started !== undefined && time !== undefined) llmMs += Math.max(0, time - started)
        continue
      }
      case 'tool/call': {
        const callId = typeof data.callId === 'string' ? data.callId : undefined
        if (callId !== undefined && typeof event.time === 'number') toolCalls.set(callId, event.time)
        continue
      }
      case 'tool/result': {
        const callId = typeof data.callId === 'string' ? data.callId : undefined
        const started = callId === undefined ? undefined : toolCalls.get(callId)
        if (started !== undefined && typeof event.time === 'number') toolMs += Math.max(0, event.time - started)
        continue
      }
      default:
        continue
    }
  }

  turns = seenTurns.size
  const slices: TurnUsage[] = [...perTurn.entries()]
    .sort(([left], [right]) => left - right)
    .map(([turn, slice]) => ({
      turn,
      usage: slice.usage,
      wallMs: slice.firstTime === undefined || slice.lastTime === undefined ? 0 : Math.max(0, slice.lastTime - slice.firstTime),
    }))
  return {
    ...(model === undefined ? {} : { model }),
    ...(window === undefined ? {} : { window }),
    usage,
    used,
    turns,
    steps,
    llmMs,
    toolMs,
    perTurn: slices,
  }
}

/** Compact token counts: `1.5k`, `490k`, `7.2k`. */
export function formatTokens(value: number): string {
  if (value < 1000) return String(Math.round(value))
  if (value < 1_000_000) return `${(value / 1000).toFixed(1).replace(/\.0$/, '')}k`
  return `${(value / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`
}

/** A duration as `4m12s` / `48s` / `1h02m`. */
export function formatDuration(ms: number): string {
  const totalSeconds = Math.round(ms / 1000)
  const hours = Math.floor(totalSeconds / 3600)
  const minutes = Math.floor((totalSeconds % 3600) / 60)
  const seconds = totalSeconds % 60
  if (hours > 0) return `${hours}h${String(minutes).padStart(2, '0')}m`
  if (minutes > 0) return `${minutes}m${String(seconds).padStart(2, '0')}s`
  return `${seconds}s`
}

/** The categories the report lists, with their share of the whole usage. */
interface Category {
  readonly label: string
  readonly tokens: number
}

function categoriesOf(usage: UsageTotals, used: number, window: number | undefined): Category[] {
  // The prompt currently in the window is the headline figure; the rest of
  // the log's consumption is reported alongside it rather than double-counted.
  const list: Category[] = [
    { label: 'Messages', tokens: used },
    { label: 'Cache read', tokens: usage.cacheRead },
    { label: 'Cache write', tokens: usage.cacheWrite },
    { label: 'Output', tokens: usage.output },
  ]
  if (window !== undefined) {
    list.push({ label: 'Free space', tokens: Math.max(0, window - used) })
  }
  return list.filter(category => category.tokens > 0)
}

/** The 10-column fill grid: one cell per tenth of the window. */
const GRID_ROWS = 5

function gridCells(filledRatio: number): boolean[] {
  const total = GRID_ROWS * 10
  const filled = Math.min(total, Math.round(Math.max(0, Math.min(1, filledRatio)) * total))
  return Array.from({ length: total }, (_, index) => index < filled)
}

/** Render the whole report: the summary grid, the categories, the session's
 *  activity, and the per-turn breakdown. */
export function renderReport(report: ContextReport): string[] {
  const window = report.window
  const ratio = window === undefined || window === 0 ? 0 : report.used / window
  const cells = gridCells(ratio)
  const lines: string[] = []
  lines.push('Context Usage')

  const modelLabel = report.model ?? 'unknown model'
  const gridWidth = 10
  // The grid and the facts sit side by side: ten cells per row, the first two
  // rows carrying the headline figures, then the category list.
  const facts: string[] = []
  facts.push(modelLabel)
  facts.push(window === undefined
    ? `${formatTokens(report.used)} tokens`
    : `${formatTokens(report.used)}/${formatTokens(window)} tokens (${Math.round(ratio * 100)}%)`)
  facts.push('')

  const categories = categoriesOf(report.usage, report.used, window)
  if (categories.length > 0) {
    facts.push('Estimated usage by category')
    for (const category of categories) {
      const share = window === undefined || window === 0
        ? undefined
        : `${((category.tokens / window) * 100).toFixed(1)}%`
      facts.push(`⛁ ${category.label}: ${formatTokens(category.tokens)} tokens${share === undefined ? '' : ` (${share})`}`)
    }
  }
  if (window !== undefined) {
    facts.push('')
    facts.push(`Context window: ${formatTokens(window)} tokens`)
  }

  // Every row shares one gutter so the facts column stays aligned whether or
  // not a grid row sits beside it.
  const gutter = ' '.repeat(gridWidth * 2 - 1)
  const rendered = Math.max(GRID_ROWS, facts.length)
  for (let row = 0; row < rendered; row++) {
    const cellRow = row < GRID_ROWS
      ? cells.slice(row * gridWidth, row * gridWidth + gridWidth)
        .map(filled => (filled ? '⛁' : '⛶'))
        .join(' ')
      : ''
    const fact = facts[row] ?? ''
    if (cellRow === '' && fact === '') {
      lines.push('')
      continue
    }
    lines.push(` ${cellRow === '' ? gutter : cellRow}   ${fact}`.trimEnd())
  }

  // The session's own activity, which the categories above do not cover.
  lines.push('')
  const activity = `${report.turns} turns · ${report.steps} steps`
  const spent = report.llmMs + report.toolMs
  lines.push(spent === 0 ? ` ${activity}` : ` ${activity} · ${formatDuration(spent)} spent`)
  if (spent > 0) {
    // One bar per phase, each filled to its own share of the total — two
    // identical bars would say nothing about where the time went.
    const barWidth = 20
    const barFor = (ms: number): string => {
      const filled = Math.round((ms / spent) * barWidth)
      return `${'⛁'.repeat(filled)}${'⛶'.repeat(Math.max(0, barWidth - filled))}`
    }
    lines.push(` ${barFor(report.llmMs)} Model ${formatDuration(report.llmMs)}`)
    lines.push(` ${barFor(report.toolMs)} Tools ${formatDuration(report.toolMs)}`)
  }

  lines.push('')
  lines.push('Per turn')
  if (report.perTurn.length === 0) {
    lines.push(' ├ no model calls recorded')
  } else {
    for (const slice of report.perTurn) {
      const parts = [
        `turn ${slice.turn}`,
        `${formatTokens(slice.usage.input)} in`,
        `${formatTokens(slice.usage.output)} out`,
      ]
      if (slice.usage.cacheRead > 0) parts.push(`${formatTokens(slice.usage.cacheRead)} cache`)
      if (slice.wallMs > 0) parts.push(formatDuration(slice.wallMs))
      lines.push(` ├ ${parts.join(' · ')}`)
    }
  }
  return lines
}

export function apply(ctx: Context): void {
  ctx.inject(['commands'], (commandCtx) => {
    const commands = commandCtx.commands as unknown as CommandsLike
    commands.register({
      name: 'context',
      description: 'Show this session\'s context usage',
      handler: ({ agent }) => {
        const current = agent.model.current()
        // The window comes from the adapter's own disclosure, so a report
        // never measures against a guessed capacity; the readable name comes
        // from the same catalog (a gateway's id is a routing hash).
        const llm = ctx.get('llm') as
          | {
            resolveModelInfo(provider: string, model: string): Promise<unknown>
            listModels?(provider: string): Promise<readonly { id: string; name: string }[]>
          }
          | undefined
        return (async (): Promise<CommandResultLike> => {
          let window: number | undefined
          let model: string | undefined
          if (current !== undefined && llm !== undefined) {
            const info = (await llm.resolveModelInfo(current.provider, current.model).catch(() => undefined)) as
              | { context?: { contextWindow?: number } }
              | undefined
            const size = info?.context?.contextWindow
            if (typeof size === 'number' && size > 0) window = size
            if (typeof llm.listModels === 'function') {
              const catalog = await llm.listModels(current.provider).catch(() => [])
              const entry = catalog.find(option => option.id === current.model)
              model = modelDisplayName({
                provider: current.provider,
                model: current.model,
                ...(entry?.name === undefined ? {} : { name: entry.name }),
              })
            }
          }
          // The id stands in when no catalog is reachable: a report that names
          // nothing is worse than one naming the route as the log spells it.
          const report = foldReport(agent.session.snapshotEvents(), model ?? current?.model, window)
          // An honest empty case: nothing has called the model yet, so there
          // is no usage to report rather than a page of zeros.
          if (report.turns === 0 && report.usage.input === 0) {
            return { kind: 'success', text: 'Context Usage\n No model calls yet' }
          }
          return { kind: 'success', text: renderReport(report).join('\n') }
        })()
      },
    })
  })
}