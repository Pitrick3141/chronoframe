import { deflateSync } from 'node:zlib'

export function exifTiff({ camera = false, people = false, gps = false } = {}) {
  const buffer = Buffer.alloc(2048)
  buffer.write('II')
  buffer.writeUInt16LE(42, 2)
  buffer.writeUInt32LE(8, 4)
  const tags = [
    ...(camera
      ? [
          [0x010f, 'Canon'],
          [0x0110, 'Metadata Test Camera'],
        ]
      : []),
    ...(people
      ? [
          [0x013b, 'Test Photographer'],
          [0x8298, 'Copyright Example'],
        ]
      : []),
    ...(gps ? [[0x8825, null]] : []),
  ]
  let end = 8 + 2 + tags.length * 12 + 4
  buffer.writeUInt16LE(tags.length, 8)
  tags.forEach(([id, text], index) => {
    const offset = 10 + index * 12
    buffer.writeUInt16LE(id, offset)
    if (text === null) {
      buffer.writeUInt16LE(4, offset + 2)
      buffer.writeUInt32LE(1, offset + 4)
      buffer.writeUInt32LE(end, offset + 8)
      const gpsOffset = end
      buffer.writeUInt16LE(4, gpsOffset)
      end += 2 + 4 * 12 + 4
      for (const [entry, tagId] of [1, 2, 3, 4].entries()) {
        const pos = gpsOffset + 2 + entry * 12
        buffer.writeUInt16LE(tagId, pos)
        if (tagId === 1 || tagId === 3) {
          buffer.writeUInt16LE(2, pos + 2)
          buffer.writeUInt32LE(2, pos + 4)
          buffer.write(tagId === 1 ? 'N\0' : 'E\0', pos + 8)
        } else {
          buffer.writeUInt16LE(5, pos + 2)
          buffer.writeUInt32LE(3, pos + 4)
          buffer.writeUInt32LE(end, pos + 8)
          for (let part = 0; part < 3; part++) {
            buffer.writeUInt32LE(0, end)
            buffer.writeUInt32LE(1, end + 4)
            end += 8
          }
        }
      }
    } else {
      const value = Buffer.from(text + '\0')
      buffer.writeUInt16LE(2, offset + 2)
      buffer.writeUInt32LE(value.length, offset + 4)
      buffer.writeUInt32LE(end, offset + 8)
      value.copy(buffer, end)
      end += value.length
    }
  })
  return buffer.subarray(0, end)
}

function crc32(data) {
  let crc = 0xffffffff
  for (const byte of data) {
    crc ^= byte
    for (let bit = 0; bit < 8; bit++)
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0)
  }
  return (crc ^ 0xffffffff) >>> 0
}

function pngChunk(type, value) {
  const name = Buffer.from(type)
  const chunk = Buffer.alloc(value.length + 12)
  chunk.writeUInt32BE(value.length)
  name.copy(chunk, 4)
  value.copy(chunk, 8)
  chunk.writeUInt32BE(crc32(Buffer.concat([name, value])), value.length + 8)
  return chunk
}

export function metadataPng({ exif, xmp, late = false, size = 64 } = {}) {
  const header = Buffer.alloc(13)
  header.writeUInt32BE(size)
  header.writeUInt32BE(size, 4)
  header[8] = 8
  header[9] = 2
  const pixels = Buffer.alloc((1 + size * 3) * size)
  for (let row = 0; row < size; row++) {
    for (let col = 0; col < size; col++) {
      const offset = row * (1 + size * 3) + 1 + col * 3
      pixels[offset] = 70
      pixels[offset + 1] = 150
      pixels[offset + 2] = 210
    }
  }
  const metadata = [
    ...(exif ? [pngChunk('eXIf', exif)] : []),
    ...(xmp
      ? [pngChunk('iTXt', Buffer.from('XML:com.adobe.xmp\0\0\0\0\0' + xmp))]
      : []),
  ]
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk('IHDR', header),
    ...(!late ? metadata : []),
    pngChunk('IDAT', deflateSync(pixels, { level: late ? 0 : 6 })),
    ...(late ? metadata : []),
    pngChunk('IEND', Buffer.alloc(0)),
  ])
}

export function metadataJpeg(exif) {
  const data = Buffer.concat([Buffer.from('Exif\0\0'), exif])
  const marker = Buffer.from([255, 216, 255, 225, 0, 0])
  marker.writeUInt16BE(data.length + 2, 4)
  return Buffer.concat([marker, data, Buffer.from([255, 217])])
}

export const peopleXmp = `<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description xmlns:Iptc4xmpExt="http://iptc.org/std/Iptc4xmpExt/2008-02-29/"><Iptc4xmpExt:PersonInImage><rdf:Bag><rdf:li>Alice</rdf:li></rdf:Bag></Iptc4xmpExt:PersonInImage></rdf:Description></rdf:RDF></x:xmpmeta>`
