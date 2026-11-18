/** The /context command: the fold over a session log, the report's shaping,
 *  and the two levels of detail. */

import { describe, expect, it } from 'vitest'
import {
  applyContext as apply,
  foldReport,
  formatDuration,
  formatTokens,
  renderReport,
} from '../src/index.ts'

type Ev = { type: string; seq: number; time?: number; data: Record<string, unknown> }

let seq = 0
function ev(type: string, data: Record<string, unknown> = {}, time?: number): Ev {
  seq += 1
  return { type, seq, ...(time === undefined ? {} : { time }), data }
}

function usage(input: number, output: number, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { inputTokens: input, outputTokens: output, ...extra }
}

/** A two-turn log with cache traffic and tool wall time. */
function sampleLog(): Ev[] {
  return [
    ev('turn/start', { turn: 1 }, 1000),
    ev('step/start', { turn: 1, step: 1 }, 1000),
    ev('assistant/message', { turn: 1, step: 1, usage: usage(1000, 200, { cacheReadTokens: 400, cacheWriteTokens: 100 }) }, 3000),
    ev('tool/call', { callId: 'c1', turn: 1, step: 1 }, 3000),
    ev('tool/result', { callId: 'c1' }, 5000),
    ev('step/end', { turn: 1, step: 1 }, 5000),
    ev('step/start', { turn: 2, step: 1 }, 6000),
    ev('assistant/message', { turn: 2, step: 1, usage: usage(2000, 300, { cacheReadTokens: 500 }) }, 8000),
    ev('step/end', { turn: 2, step: 1 }, 8000),
  ]
}

describe('formatting helpers', () => {
  it('compacts token counts', () => {
    expect(formatTokens(999)).toBe('999')
    expect(formatTokens(1500)).toBe('1.5k')
    expect(formatTokens(490_000)).toBe('490k')
    expect(formatTokens(800_000)).toBe('800k')
    expect(formatTokens(1_200_000)).toBe('1.2M')
  })

  it('formats durations', () => {
    expect(formatDuration(48_000)).toBe('48s')
    expect(formatDuration(252_000)).toBe('4m12s')
    expect(formatDuration(3_720_000)).toBe('1h02m')
  })
})

describe('foldReport', () => {
  it('sums usage, activity, and per-turn slices', () => {
    const report = foldReport(sampleLog() as never, 'test-model', 800_000)
    expect(report.model).toBe('test-model')
    expect(report.window).toBe(800_000)
    // Disjoint sums: uncached input, output, cache reads and writes.
    expect(report.usage).toMatchObject({ input: 3000, output: 500, cacheRead: 900, cacheWrite: 100 })
    // "Used" is the latest call's prompt, the figure the footer shows.
    expect(report.used).toBe(2500)
    expect(report.turns).toBe(2)
    expect(report.steps).toBe(2)
    // Model wall time: 2s + 2s; tool wall time: 2s.
    expect(report.llmMs).toBe(4000)
    expect(report.toolMs).toBe(2000)
    expect(report.perTurn).toHaveLength(2)
    // Turn 1 spans its first step start (1000) to its last event (5000).
    expect(report.perTurn[0]).toMatchObject({ turn: 1, wallMs: 4000 })
  })

  it('ignores calls that reported no usage', () => {
    const report = foldReport([
      ev('step/start', { turn: 1, step: 1 }, 1000),
      ev('assistant/message', { turn: 1, step: 1 }, 2000),
      ev('step/end', { turn: 1, step: 1 }, 2000),
    ] as never)
    expect(report.usage.input).toBe(0)
    expect(report.used).toBe(0)
    expect(report.steps).toBe(1)
    // The turn exists (its step was timed) but carries no token usage.
    expect(report.perTurn).toHaveLength(1)
    expect(report.perTurn[0]?.usage.input).toBe(0)
  })

  it('measures tool wall time per call id', () => {
    const report = foldReport([
      ev('tool/call', { callId: 'a' }, 1000),
      ev('tool/call', { callId: 'b' }, 1500),
      ev('tool/result', { callId: 'a' }, 4000),
      ev('tool/result', { callId: 'b' }, 2500),
    ] as never)
    expect(report.toolMs).toBe(4000) // 3s + 1s
  })
})

describe('renderReport', () => {
  it('lays the grid beside the headline facts and categories', () => {
    const report = foldReport(sampleLog() as never, 'test-model', 10_000)
    const lines = renderReport(report)
    expect(lines[0]).toBe('Context Usage')
    // The grid is ten cells per row, five rows deep.
    const gridRows = lines.filter(line => line.includes('⛁') || line.includes('⛶'))
    expect(gridRows.length).toBeGreaterThanOrEqual(5)
    expect(lines.join('\n')).toContain('test-model')
    expect(lines.join('\n')).toContain('/10k tokens')
    expect(lines.join('\n')).toContain('Messages:')
    expect(lines.join('\n')).toContain('Free space:')
    expect(lines.join('\n')).toContain('turns · ')
  })

  it('always carries the per-turn breakdown', () => {
    const report = foldReport(sampleLog() as never, 'test-model', 10_000)
    const text = renderReport(report).join('\n')
    expect(text).toContain('Per turn')
    expect(text).toContain('turn 1')
    expect(text).toContain('turn 2')
  })

  it('fills the grid in proportion to the window', () => {
    const gridOf = (inputTokens: number): string[] => {
      const report = foldReport([
        ev('step/start', { turn: 1, step: 1 }, 1000),
        ev('assistant/message', { turn: 1, step: 1, usage: usage(inputTokens, 100) }, 2000),
        ev('step/end', { turn: 1, step: 1 }, 2000),
      ] as never, 'm', 10_000)
      // Grid rows are the ten-cell runs; take the leading run of each so a
      // category glyph beside the grid is never counted as a cell.
      return renderReport(report)
        .filter(row => /^ (?:[⛁⛶] ){9}[⛁⛶]/.test(row))
        .map(row => row.slice(0, 20))
    }
    const count = (rows: string[]): number => rows.reduce((sum, row) => sum + (row.match(/⛁/g) ?? []).length, 0)
    expect(gridOf(0)).toHaveLength(5)
    // 50 cells: half the window fills 25, the whole window fills all 50.
    expect(count(gridOf(5000))).toBe(25)
    expect(count(gridOf(10_000))).toBe(50)
  })
})

describe('/context command', () => {
  function fakeEnv(events: Ev[], window?: number, model = 'test-model', catalogName?: string) {
    const registered: { name: string; handler(i: { agent: unknown; rawInput: string }): Promise<{ kind: string; text?: string }> }[] = []
    const agent = {
      session: { snapshotEvents: () => events },
      model: { current: () => ({ provider: 'p', model }) },
    }
    const ctx = {
      inject: (_deps: readonly string[], cb: (c: { commands: { register(d: never): void } }) => void) => {
        cb({ commands: { register: (d: never) => registered.push(d) } })
      },
      get: (name: string) => (name === 'llm'
        ? {
          resolveModelInfo: async () => (window === undefined ? {} : { context: { contextWindow: window } }),
          listModels: async () => (catalogName === undefined
            ? []
            : [{ provider: 'p', id: model, name: catalogName }]),
        }
        : undefined),
    }
    apply(ctx as never)
    const run = (rawInput: string) => Promise.resolve(registered[0]!.handler({ agent, rawInput }))
    return { run, def: () => registered[0]! }
  }

  it('registers with its hint', () => {
    const env = fakeEnv([])
    expect(env.def().name).toBe('context')
  })

  it('reports the summary for a session with model calls', async () => {
    const result = await fakeEnv(sampleLog(), 10_000).run('')
    expect(result.kind).toBe('success')
    expect(result.text).toContain('Context Usage')
    expect(result.text).toContain('test-model')
    // The whole report arrives at once: no expand hint, the per-turn block
    // included.
    expect(result.text).toContain('Per turn')
    expect(result.text).not.toContain('to expand')
  })

  it('names the route by its catalog name, not its opaque id', async () => {
    // A gateway's id is a routing hash; the catalog carries the legible name.
    const result = await fakeEnv(sampleLog(), 10_000, 'mode-7f5c1e7c45b6', 'Deepseek-v4.1-flash-1017').run('')
    expect(result.text).toContain('Deepseek-v4.1-flash-1017')
    expect(result.text).not.toContain('mode-7f5c1e7c45b6')
  })

  it('falls back to the id when no catalog is reachable', async () => {
    const result = await fakeEnv(sampleLog(), 10_000, 'mode-7f5c1e7c45b6').run('')
    expect(result.text).toContain('mode-7f5c1e7c45b6')
  })

  it('says so when nothing has called the model yet', async () => {
    const result = await fakeEnv([], 10_000).run('')
    expect(result.text).toBe('Context Usage\n No model calls yet')
  })

  it('measures without a window when the adapter discloses none', async () => {
    const result = await fakeEnv(sampleLog(), undefined).run('')
    expect(result.text).toContain('Context Usage')
    // No percentage and no free-space category without a capacity to compare to.
    expect(result.text).not.toContain('Free space')
    expect(result.text).not.toContain('%')
  })
})