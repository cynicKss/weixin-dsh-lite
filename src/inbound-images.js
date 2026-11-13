/**
 * Inbound images as real attachments.
 *
 * The original pipeline saved every Weixin image to a local file and put its
 * path into the prompt, so the model only saw a path it had to open with a
 * tool. When the host exposes the `attachments` service the bytes can be
 * committed as a durable image reference and sent as an image content block
 * instead: the model sees the picture directly and the GUI renders it in the
 * session log.
 *
 * Everything here degrades to the path-based prompt: a refused format, an
 * oversized image, a missing service or a disabled setting only moves that
 * image back into the set that `describeInboundMedia` describes.
 *
 * @module dsh-weixin/inbound-images
 */

/** Formats the host attachment service accepts as an image. */
export const NATIVE_IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif'])

/**
 * Build the `content` array for `createUserMessage`.
 *
 * The text block is always present when there are no images so the existing
 * prompt path is byte-identical; an image-only message still gets a caption so
 * reply attribution has a text to match on.
 *
 * @param {{ text?: string, images?: readonly any[] }} params
 * @returns {Array<{ type: 'image', attachment: any } | { type: 'text', text: string }>}
 */
export function buildPromptContent({ text, images }) {
  const refs = Array.isArray(images) ? images : []
  if (refs.length === 0) return [{ type: 'text', text: String(text ?? '') }]
  const content = refs.map((attachment) => ({ type: 'image', attachment }))
  const caption = String(text ?? '')
  content.push({ type: 'text', text: caption === '' ? '（图片）' : caption })
  return content
}

/**
 * The text the user message will carry after {@link buildPromptContent}.
 *
 * Bound turns attribute a reply by the text of the prompt they sent, so an
 * image-only message must be matched by its rendered caption (`（图片）`), not
 * by the empty prompt string.
 *
 * @param {{ text?: string, images?: readonly any[] }} params
 * @returns {string}
 */
export function promptTextFor({ text, images }) {
  const caption = String(text ?? '')
  const refs = Array.isArray(images) ? images : []
  return refs.length > 0 && caption === '' ? '（图片）' : caption
}

/**
 * Commit inbound image files through the host attachment service.
 *
 * @param {object} params
 * @param {Array<Record<string, any>>} params.saved results from the media download step
 * @param {any} params.attachments the host `attachments` service, or undefined
 * @param {(file: string) => Promise<Uint8Array>} params.readFile reads one saved file
 * @param {boolean} [params.enabled] the `nativeImageInput` setting
 * @param {(line: string) => void} [params.warn]
 * @returns {Promise<{ images: any[], fallback: Array<Record<string, any>> }>}
 *   `images` are durable refs in message order; `fallback` are the saved image
 *   entries that still need a path description.
 */
export async function saveNativeImages({ saved, attachments, readFile, enabled = true, warn = () => {} }) {
  const images = []
  const fallback = []
  const items = Array.isArray(saved) ? saved : []
  const imageItems = items.filter((item) => item?.kind === 'image')
  if (enabled !== true || typeof attachments?.saveImage !== 'function') {
    return { images, fallback: imageItems }
  }
  for (const item of imageItems) {
    const mediaType = String(item.mime ?? '').toLowerCase()
    if (!NATIVE_IMAGE_TYPES.has(mediaType)) {
      fallback.push(item)
      warn(`native image skipped for ${item.path}: unsupported media type ${mediaType || '(none)'}`)
      continue
    }
    try {
      const data = await readFile(item.path)
      const ref = await attachments.saveImage({ data, mediaType, name: item.name })
      images.push(ref)
    } catch (error) {
      fallback.push(item)
      warn(`native image skipped for ${item.path}: ${String(error?.message ?? error)}`)
    }
  }
  return { images, fallback }
}
