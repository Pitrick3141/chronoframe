export interface ResolvedByteRange {
  offset: number
  length: number
}

export class RangeNotSatisfiableError extends Error {
  readonly statusCode = 416
  readonly size: number
  readonly rangeHeader: string

  constructor(size: number, rangeHeader: string) {
    super(`Range ${rangeHeader} is not satisfiable for a ${size} byte object`)
    this.name = 'RangeNotSatisfiableError'
    this.size = size
    this.rangeHeader = rangeHeader
  }
}

function safeInteger(value: string): number | null {
  if (!/^\d+$/.test(value)) return null
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) ? parsed : null
}

/** Parses and normalizes one RFC 9110 byte range against an object size. */
export function resolveByteRange(
  rangeHeader: string,
  size: number,
): ResolvedByteRange {
  const match = /^bytes=(\d*)-(\d*)$/i.exec(rangeHeader.trim())
  if (!match || rangeHeader.includes(',') || size <= 0) {
    throw new RangeNotSatisfiableError(size, rangeHeader)
  }

  const [, startText, endText] = match
  if (!startText && !endText) {
    throw new RangeNotSatisfiableError(size, rangeHeader)
  }

  if (!startText) {
    const suffix = safeInteger(endText ?? '')
    if (suffix === null || suffix <= 0) {
      throw new RangeNotSatisfiableError(size, rangeHeader)
    }
    const length = Math.min(suffix, size)
    return { offset: size - length, length }
  }

  const start = safeInteger(startText)
  const requestedEnd = endText ? safeInteger(endText) : size - 1
  if (
    start === null ||
    requestedEnd === null ||
    start >= size ||
    requestedEnd < start
  ) {
    throw new RangeNotSatisfiableError(size, rangeHeader)
  }

  const end = Math.min(requestedEnd, size - 1)
  return { offset: start, length: end - start + 1 }
}
