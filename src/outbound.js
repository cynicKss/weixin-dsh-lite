// Outbound delivery for the lite plugin: strip markdown, chunk to the Weixin
// limit, and fall back to the durable outbox when a send fails.
import { channelFor } from './channel.js'
import { chunkText } from './message/chunker.js'
import { markdownToPlainText, resolveMarkdownMode } from './message/markdown.js'

const runtime = {
  outbox: undefined,
  warn: () => {},
}

/** Hand the send path its collaborators (outbox, logger). */
export function configureOutbound(deps = {}) {
  if ('outbox' in deps) runtime.outbox = deps.outbox
  if (typeof deps.warn === 'function') runtime.warn = deps.warn
}

/**
 * Send one reply body, converted to plain text and split to fit Weixin.
 *
 * @param {{ accountId?: string, cdnBaseUrl?: string }} transport
 * @param {{ maxMessageLength?: number, markdownMode?: 'strip'|'off' }} config
 * @param {{ conversationId: string, text: string, contextToken?: string }} message
 */
export async function sendChunked(transport, config, message) {
  const text = markdownToPlainText(String(message.text ?? ''), resolveMarkdownMode(config))
  if (text.trim() === '') return
  const chunks = chunkText(text, Number(config.maxMessageLength ?? 1500))
  const channel = channelFor(transport)
  for (const chunk of chunks) {
    try {
      await channel.sendText({
        conversationId: message.conversationId,
        text: chunk,
        ...(message.contextToken === undefined ? {} : { contextToken: message.contextToken }),
      })
    } catch (error) {
      runtime.warn(`sending a reply failed: ${String(error?.message ?? error)}`)
      try {
        runtime.outbox?.enqueue?.({
          accountId: String(transport.accountId ?? ''),
          conversationId: message.conversationId,
          text: chunk,
          ...(message.contextToken === undefined ? {} : { contextToken: message.contextToken }),
        })
      } catch {
        // parking the text is best-effort
      }
      return
    }
  }
}

/**
 * Send one file (used by `/file`).
 *
 * @param {{ sendMedia: (params: any) => Promise<any>, cdnBaseUrl?: string }} transport
 * @param {{ conversationId: string, filePath: string, caption?: string }} params
 */
export async function sendFile(transport, params) {
  return channelFor(transport).sendMedia({
    filePath: params.filePath,
    conversationId: params.conversationId,
    ...(params.caption === undefined ? {} : { text: params.caption }),
    ...(transport.cdnBaseUrl === undefined ? {} : { cdnBaseUrl: transport.cdnBaseUrl }),
  })
}
