export const STREAM_WEBHOOK_MAX_AGE_SECONDS = 5 * 60

const SIGNATURE_BYTES = 32
const encoder = new TextEncoder()

export class InvalidStreamWebhookSignatureError extends Error {
  constructor(message = 'Invalid Cloudflare Stream webhook signature') {
    super(message)
    this.name = 'InvalidStreamWebhookSignatureError'
  }
}

interface ParsedStreamWebhookSignature {
  timestamp: number
  timestampText: string
  signature: Uint8Array
}

function decodeHex(value: string): Uint8Array {
  if (!/^[a-f\d]{64}$/i.test(value)) {
    throw new InvalidStreamWebhookSignatureError()
  }

  const bytes = new Uint8Array(SIGNATURE_BYTES)
  for (let index = 0; index < SIGNATURE_BYTES; index += 1) {
    bytes[index] = Number.parseInt(value.slice(index * 2, index * 2 + 2), 16)
  }
  return bytes
}

export function parseStreamWebhookSignature(
  header: string | null | undefined,
): ParsedStreamWebhookSignature {
  if (!header) throw new InvalidStreamWebhookSignatureError()

  let timestampText: string | undefined
  let signatureText: string | undefined

  for (const component of header.split(',')) {
    const separator = component.indexOf('=')
    if (separator <= 0) continue

    const name = component.slice(0, separator).trim()
    const value = component.slice(separator + 1).trim()
    if (name === 'time') {
      if (timestampText !== undefined) {
        throw new InvalidStreamWebhookSignatureError()
      }
      timestampText = value
    } else if (name === 'sig1') {
      if (signatureText !== undefined) {
        throw new InvalidStreamWebhookSignatureError()
      }
      signatureText = value
    }
  }

  if (!timestampText || !/^\d{1,12}$/.test(timestampText) || !signatureText) {
    throw new InvalidStreamWebhookSignatureError()
  }

  const timestamp = Number(timestampText)
  if (!Number.isSafeInteger(timestamp)) {
    throw new InvalidStreamWebhookSignatureError()
  }

  return {
    timestamp,
    timestampText,
    signature: decodeHex(signatureText),
  }
}

function constantTimeEqual(left: Uint8Array, right: Uint8Array): boolean {
  // Both inputs are fixed-size SHA-256 values. Do not return early for a byte
  // mismatch, so comparison time does not reveal a matching prefix.
  let difference = left.byteLength ^ right.byteLength
  for (let index = 0; index < SIGNATURE_BYTES; index += 1) {
    difference |= (left[index] ?? 0) ^ (right[index] ?? 0)
  }
  return difference === 0
}

export async function verifyStreamWebhookSignature(options: {
  secret: string
  signatureHeader: string | null | undefined
  body: Uint8Array
  now?: number
}): Promise<void> {
  if (!options.secret) throw new InvalidStreamWebhookSignatureError()

  const parsed = parseStreamWebhookSignature(options.signatureHeader)
  const nowSeconds = Math.floor((options.now ?? Date.now()) / 1000)
  if (
    Math.abs(nowSeconds - parsed.timestamp) > STREAM_WEBHOOK_MAX_AGE_SECONDS
  ) {
    throw new InvalidStreamWebhookSignatureError()
  }

  const prefix = encoder.encode(`${parsed.timestampText}.`)
  const signatureSource = new Uint8Array(
    prefix.byteLength + options.body.byteLength,
  )
  signatureSource.set(prefix)
  signatureSource.set(options.body, prefix.byteLength)

  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(options.secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const expected = new Uint8Array(
    await crypto.subtle.sign('HMAC', key, signatureSource),
  )

  if (!constantTimeEqual(expected, parsed.signature)) {
    throw new InvalidStreamWebhookSignatureError()
  }
}
