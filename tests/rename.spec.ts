/** The /rename command plugin: the explicit title, the byte-capped short
 *  form, the empty-input regeneration, and the two absent-service paths. */

import { describe, expect, it } from 'vitest'
import { applyRename as apply } from '../src/index.ts'

interface RegisteredDef {
  name: string
  description: string
  input?: { hint?: string }
  handler(invocation: { agent: unknown; rawInput: string; signal: AbortSignal }): Promise<{ kind: string; text?: string }>
}

/** The upstream service's twin: it strips control characters, normalizes
 *  whitespace, caps the byte length, and rejects a title with no visible
 *  characters. */
const MAX_BYTES = 80

function normalize(input: string): string {
  // Whitespace collapses first (a newline becomes a space), then the
  // remaining control characters are stripped.
  const collapsed = input.replace(/\s+/g, ' ').trim()
  // eslint-disable-next-line no-control-regex -- the service strips C0/C1
  return collapsed.replace(/[\u0000-\u001f\u007f-\u009f]/g, '').slice(0, MAX_BYTES)
}

class SessionTitleInvalidError extends Error {
  readonly name = 'SessionTitleInvalidError'
}

interface Snapshot {
  title: string
}

function fakeEnv(
  opts: { service?: boolean; generated?: string | undefined; refreshFails?: boolean } = {},
) {
  const titles: Snapshot[] = []
  const registered: RegisteredDef[] = []
  let refreshes = 0
  let renameCalls: string[] = []
  const service = opts.service === false
    ? undefined
    : {
      rename: (_session: unknown, title: string) => {
        renameCalls.push(title)
        const normalized = normalize(title)
        if (normalized === '') throw new SessionTitleInvalidError('session title must contain visible characters')
        const snapshot = { title: normalized }
        titles.push(snapshot)
        return snapshot
      },
      refresh: async () => {
        refreshes += 1
        if (opts.refreshFails === true) throw new Error('provider exploded')
        return opts.generated === undefined ? undefined : { title: opts.generated }
      },
    }
  const agent = { session: { id: 's1' } }
  const ctx = {
    inject: (_deps: readonly string[], cb: (c: { commands: { register(def: RegisteredDef): void } }) => void) => {
      cb({ commands: { register: (def: RegisteredDef) => registered.push(def) } })
    },
    get: (name: string) => (name === 'sessionTitle' ? service : undefined),
  }
  apply(ctx as never)
  const invoke = (rawInput: string): Promise<{ kind: string; text?: string }> =>
    registered[0]!.handler({ agent, rawInput, signal: new AbortController().signal })
  return {
    invoke,
    def: () => registered[0]!,
    titles: () => titles,
    refreshes: () => refreshes,
    renameCalls: () => renameCalls,
  }
}

describe('/rename command plugin', () => {
  it('registers with the discovery metadata', () => {
    const env = fakeEnv()
    expect(env.def().name).toBe('rename')
    expect(env.def().description).toBe('Rename this session')
    expect(env.def().input?.hint).toBe('[title]')
  })

  it('accepts an explicit title and reports the accepted value', async () => {
    const env = fakeEnv()
    const result = await env.invoke('  terminal   work  ')
    expect(result.kind).toBe('success')
    expect(result.text).toBe('Session renamed to: terminal work')
    // The command trims its own input; the service does the rest.
    expect(env.renameCalls()).toEqual(['terminal   work'])
  })

  it('says so when the service shortened the title', async () => {
    const env = fakeEnv()
    const long = 'a'.repeat(MAX_BYTES + 40)
    const result = await env.invoke(long)
    expect(result.kind).toBe('success')
    expect(result.text).toContain(`Session renamed to: ${'a'.repeat(MAX_BYTES)}`)
    expect(result.text).toContain(`(shortened to ${MAX_BYTES} characters)`)
  })

  it('reports the collapse without claiming a shortening', async () => {
    // Whitespace collapsing changes the text but not what a reader thinks of
    // as "shortened": the accepted title is exactly the collapsed input.
    const env = fakeEnv()
    const result = await env.invoke('a\tb\nc')
    expect(result.text).toBe('Session renamed to: a b c')
  })

  it('regenerates on a bare invocation', async () => {
    const env = fakeEnv({ generated: 'terminal slash commands' })
    const result = await env.invoke('   ')
    expect(result.kind).toBe('success')
    expect(result.text).toBe('Session retitled: terminal slash commands')
    expect(env.refreshes()).toBe(1)
  })

  it('tells regeneration apart from an explicit rename', async () => {
    // A bare /rename unpins the title: the provider owns it again, so the
    // verdict says "retitled" rather than echoing a title the user typed.
    const env = fakeEnv({ generated: 'from the conversation' })
    await env.invoke('')
    expect(env.renameCalls()).toEqual([])
  })

  it('says there is nothing to title yet when refresh answers nothing', async () => {
    // A fresh session has no eligible human message: the service answers
    // undefined, which is a state, not a failure.
    const env = fakeEnv({ generated: undefined })
    const result = await env.invoke('')
    expect(result).toEqual({ kind: 'success', text: 'No conversation to title yet.' })
  })

  it('survives a failing provider on regeneration', async () => {
    const env = fakeEnv({ refreshFails: true })
    const result = await env.invoke('')
    expect(result).toEqual({ kind: 'success', text: 'No conversation to title yet.' })
  })

  it('blames the input when the title has no visible characters', async () => {
    const env = fakeEnv()
    const result = await env.invoke('\u0007\u0008')
    expect(result).toEqual({ kind: 'error', text: 'A title needs visible characters.' })
  })

  it('reports an unexpected rename failure without throwing', async () => {
    const registered: RegisteredDef[] = []
    const ctx = {
      inject: (_deps: readonly string[], cb: (c: { commands: { register(def: RegisteredDef): void } }) => void) => {
        cb({ commands: { register: (def: RegisteredDef) => registered.push(def) } })
      },
      get: () => ({
        rename: () => { throw new Error('session is not live') },
        refresh: async () => undefined,
      }),
    }
    apply(ctx as never)
    const result = await registered[0]!.handler({
      agent: { session: {} },
      rawInput: 'anything',
      signal: new AbortController().signal,
    })
    expect(result).toEqual({ kind: 'error', text: 'Could not rename the session: session is not live' })
  })

  it('stays discoverable when the profile mounts no title service', async () => {
    const env = fakeEnv({ service: false })
    expect(env.def().name).toBe('rename')
    const result = await env.invoke('anything')
    expect(result).toEqual({ kind: 'error', text: 'Session titles are not available in this profile.' })
  })
})