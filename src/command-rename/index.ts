/**
 * The `/rename` command for DeepSeek Harness: labels this session.
 *
 * `/rename <title>` accepts an explicit title through `sessionTitle.rename`,
 * which lands as a durable `session/title` event carrying the `user` source —
 * the pin that supersedes automatic generation and stops later user messages
 * from scheduling one. A bare `/rename` re-derives the title through the
 * mounted provider (`sessionTitle.refresh`), which is the deliberate unpin.
 *
 * The title is log-only: it never enters the model surface. Every host that
 * lists sessions reads the same `title` projection these events fold into, so
 * the terminal, the web app, and a resumable session all agree on it.
 *
 * The service lives upstream (dsh-base mounts `session-title` and
 * `session-title-llm`); the `/rename` command itself is registered only by the
 * web host packages, so no profile carrying a non-web frontend has one. This
 * plugin is that missing entry point, and it binds no frontend.
 * @module dsh-plugins/rename
 */

import type { Context } from '@deepseek-ai/cordis'
// Pulls the commands registry's Context augmentation into this program; the
// register call itself stays structural for version tolerance.
import type {} from '@deepseek-ai/dsh-commands'
import type { CommandResultLike } from '../shared/index.ts'

/** The accepted-title snapshot this command reports; the rest of the
 *  upstream shape (seqs, source, envelope facts) is not its business. */
interface SessionTitleSnapshotLike {
  readonly title: string
}

/** The structural face of the `sessionTitle` service. */
interface SessionTitleLike {
  rename(session: unknown, title: string): SessionTitleSnapshotLike
  refresh(session: unknown, signal?: AbortSignal): Promise<SessionTitleSnapshotLike | undefined>
}

interface AgentLike {
  readonly session: unknown
}

interface CommandInvocationLike {
  agent: AgentLike
  rawInput: string
  signal: AbortSignal
}

interface CommandsLike {
  register(definition: {
    name: string
    description: string
    input?: { hint?: string }
    handler(invocation: CommandInvocationLike): Promise<CommandResultLike> | CommandResultLike
  }): unknown
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function apply(ctx: Context): void {
  // The commands registry may mount after this plugin; ctx.inject waits for
  // it the way the built-in command packages do.
  ctx.inject(['commands'], (commandCtx) => {
    const commands = commandCtx.commands as unknown as CommandsLike
    commands.register({
      name: 'rename',
      description: 'Rename this session',
      input: { hint: '[title]' },
      handler: async ({ agent, rawInput, signal }) => {
        // Read the service per invocation: it may mount after this plugin,
        // and a profile without it keeps the command discoverable (the
        // answer then says why it cannot act rather than failing silently).
        const titles = ctx.get('sessionTitle') as SessionTitleLike | undefined
        if (titles === undefined) {
          return { kind: 'error', text: 'Session titles are not available in this profile.' }
        }
        const wanted = rawInput.trim()
        if (wanted === '') {
          // Bare /rename: re-derive through the provider. Undefined is the
          // service's own answer for "nothing eligible to title yet" — a real
          // state (a fresh session), not a failure.
          const snapshot = await titles.refresh(agent.session, signal).catch(() => undefined)
          return snapshot === undefined
            ? { kind: 'success', text: 'No conversation to title yet.' }
            : { kind: 'success', text: `Session retitled: ${snapshot.title}` }
        }
        let snapshot: SessionTitleSnapshotLike
        try {
          snapshot = titles.rename(agent.session, wanted)
        } catch (error) {
          // The service rejects a title that normalizes to no visible
          // characters; that is the one failure the input owns, so it says so
          // instead of echoing a service-shaped message.
          if ((error as { name?: unknown } | undefined)?.name === 'SessionTitleInvalidError') {
            return { kind: 'error', text: 'A title needs visible characters.' }
          }
          return { kind: 'error', text: `Could not rename the session: ${messageOf(error)}` }
        }
        // Report the accepted title, not the typed one: the service collapses
        // whitespace and caps the byte length, and a reader who sees only the
        // short form needs to know the rest did not land.
        const collapsed = wanted.replace(/\s+/g, ' ')
        return {
          kind: 'success',
          text: snapshot.title === collapsed
            ? `Session renamed to: ${snapshot.title}`
            : `Session renamed to: ${snapshot.title} (shortened to ${snapshot.title.length} characters)`,
        }
      },
    })
  })
}