// dsh-note-wall — image helpers shared by the Host half.
//
// Images are stored as files under the plugin data directory and referenced by
// a generated `<uuid>.<ext>` id. The id is validated everywhere it crosses a
// boundary, so a note can never point the server at an arbitrary path.

export const IMAGE_MAX_BYTES = 3 * 1024 * 1024

export const IMAGE_PATH_PREFIX = '/plugins/dsh-note-wall/image/'

export const IMAGE_UPLOAD_PATH = '/plugins/dsh-note-wall/image'

export const IMAGE_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(png|jpg|jpeg|webp|gif)$/

const MEDIA_TYPES = Object.freeze({
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
})

/** Media type for a valid image id, or undefined for anything else. */
export function mediaTypeForImage(id) {
  if (typeof id !== 'string') return undefined
  const dot = id.lastIndexOf('.')
  if (dot < 0) return undefined
  return MEDIA_TYPES[id.slice(dot + 1)] ?? undefined
}

export function isImageId(value) {
  return typeof value === 'string' && IMAGE_ID_PATTERN.test(value)
}

/**
 * Identify a supported image by its magic bytes. Returns undefined for
 * anything that is not a PNG, JPEG, WebP or GIF, regardless of its name or
 * declared content type.
 */
export function sniffImage(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 12) return undefined
  if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47) {
    return { ext: 'png', mediaType: 'image/png' }
  }
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return { ext: 'jpg', mediaType: 'image/jpeg' }
  }
  const head = buffer.subarray(0, 6).toString('ascii')
  if (head === 'GIF87a' || head === 'GIF89a') {
    return { ext: 'gif', mediaType: 'image/gif' }
  }
  if (buffer.subarray(0, 4).toString('ascii') === 'RIFF' && buffer.subarray(8, 12).toString('ascii') === 'WEBP') {
    return { ext: 'webp', mediaType: 'image/webp' }
  }
  return undefined
}
