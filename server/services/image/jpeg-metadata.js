// Recovered from Cloudflare Worker version 01356fea-0f5e-45a7-82fb-ee79b2263d09.
// The deployed JPEG/TIFF/XMP parser is preserved here without build wrappers.
const h18 = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 7: 1, 9: 4, 10: 8, 11: 4, 12: 8 }
const w17 = new Set([
  192, 193, 194, 195, 197, 198, 199, 201, 202, 203, 205, 206, 207,
])
const S10 = new TextDecoder('utf-8', { fatal: false })
const y16 = {
  0: 'Not Defined',
  1: 'Manual',
  2: 'Program AE',
  3: 'Aperture-priority AE',
  4: 'Shutter speed priority AE',
  5: 'Creative (Slow speed)',
  6: 'Action (High speed)',
  7: 'Portrait',
  8: 'Landscape',
  9: 'Bulb',
}
const v14 = {
  0: 'Unknown',
  1: 'Average',
  2: 'Center-weighted average',
  3: 'Spot',
  4: 'Multi-spot',
  5: 'Multi-segment',
  6: 'Partial',
  255: 'Other',
}
const b21 = { 0: 'Auto', 1: 'Manual', 2: 'Auto bracket' }
const I11 = { 0: 'Auto', 1: 'Manual' }
const x17 = { 0: 'Standard', 1: 'Landscape', 2: 'Portrait', 3: 'Night' }
const E12 = {
  1: 'Not Defined',
  2: 'One-chip color area',
  3: 'Two-chip color area',
  4: 'Three-chip color area',
  5: 'Color sequential area',
  7: 'Trilinear',
  8: 'Color sequential linear',
}
const P14 = {
  0: 'No Flash',
  1: 'Fired',
  5: 'Fired, Return not detected',
  7: 'Fired, Return detected',
  8: 'On, Did not fire',
  9: 'On, Fired',
  13: 'On, Return not detected',
  15: 'On, Return detected',
  16: 'Off, Did not fire',
  24: 'Auto, Did not fire',
  25: 'Auto, Fired',
  29: 'Auto, Fired, Return not detected',
  31: 'Auto, Fired, Return detected',
  32: 'No flash function',
  65: 'Fired, Red-eye reduction',
  69: 'Fired, Red-eye reduction, Return not detected',
  71: 'Fired, Red-eye reduction, Return detected',
  73: 'On, Red-eye reduction',
  77: 'On, Red-eye reduction, Return not detected',
  79: 'On, Red-eye reduction, Return detected',
  80: 'Off, Red-eye reduction',
  88: 'Auto, Did not fire, Red-eye reduction',
  89: 'Auto, Fired, Red-eye reduction',
  93: 'Auto, Fired, Red-eye reduction, Return not detected',
  95: 'Auto, Fired, Red-eye reduction, Return detected',
}
function decodeBytes(e12) {
  return S10.decode(e12)
}
function decodeUtf16Le(e12) {
  try {
    return new TextDecoder('utf-16le', { fatal: false }).decode(e12)
  } catch {
    const t29 = []
    for (let i21 = 0; i21 + 1 < e12.length; i21 += 2) {
      const o13 = e12[i21] | (e12[i21 + 1] << 8)
      0 !== o13 && t29.push(String.fromCharCode(o13))
    }
    return t29.join('')
  }
}
function cleanText(e12) {
  const t29 = e12.replace(/\0+$/g, '').trim()
  return t29.length > 0 ? t29 : void 0
}
function readUint16BE(e12, t29) {
  return (e12[t29] << 8) | e12[t29 + 1]
}
function readUint162(e12, t29) {
  if (!(t29 < 0 || t29 + 2 > e12.view.byteLength))
    return e12.view.getUint16(t29, e12.littleEndian)
}
function readUint322(e12, t29) {
  if (!(t29 < 0 || t29 + 4 > e12.view.byteLength))
    return e12.view.getUint32(t29, e12.littleEndian)
}
function readInt32(e12, t29) {
  if (!(t29 < 0 || t29 + 4 > e12.view.byteLength))
    return e12.view.getInt32(t29, e12.littleEndian)
}
function sliceTiffBytes(e12, t29, i21) {
  if (
    !(
      !Number.isSafeInteger(t29) ||
      !Number.isSafeInteger(i21) ||
      t29 < 0 ||
      i21 < 0 ||
      t29 + i21 > e12.bytes.byteLength
    )
  )
    return e12.bytes.slice(t29, t29 + i21)
}
function readRational(e12, t29, i21 = false) {
  const o13 = i21 ? readInt32(e12, t29) : readUint322(e12, t29),
    a26 = i21 ? readInt32(e12, t29 + 4) : readUint322(e12, t29 + 4)
  if (void 0 !== o13 && void 0 !== a26 && 0 !== a26)
    return { numerator: o13, denominator: a26, value: o13 / a26 }
}
function normalizeTiffValue(e12) {
  return Array.isArray(e12) && 1 === e12.length ? e12[0] : e12
}
function readTiffValue(e12, t29, i21, o13) {
  const a26 = h18[t29]
  if (!a26 || !Number.isSafeInteger(i21) || i21 < 0) return
  const n24 = a26 * i21
  if (!Number.isSafeInteger(n24)) return
  const r19 = o13 + 8,
    s16 = n24 <= 4 ? r19 : readUint322(e12, r19)
  if (void 0 !== s16) {
    if (2 === t29) {
      const t30 = sliceTiffBytes(e12, s16, n24)
      return t30 ? cleanText(decodeBytes(t30)) : void 0
    }
    if (1 === t29 || 7 === t29)
      return 1 === n24 ? e12.view.getUint8(s16) : sliceTiffBytes(e12, s16, n24)
    if (3 === t29) {
      const t30 = []
      for (let o14 = 0; o14 < i21; o14++) {
        const i22 = readUint162(e12, s16 + 2 * o14)
        if (void 0 === i22) return
        t30.push(i22)
      }
      return normalizeTiffValue(t30)
    }
    if (4 === t29 || 9 === t29) {
      const o14 = []
      for (let a27 = 0; a27 < i21; a27++) {
        const i22 =
          9 === t29
            ? readInt32(e12, s16 + 4 * a27)
            : readUint322(e12, s16 + 4 * a27)
        if (void 0 === i22) return
        o14.push(i22)
      }
      return normalizeTiffValue(o14)
    }
    if (5 === t29 || 10 === t29) {
      const o14 = []
      for (let a27 = 0; a27 < i21; a27++) {
        const i22 = readRational(e12, s16 + 8 * a27, 10 === t29)
        if (!i22) return
        o14.push(i22)
      }
      return normalizeTiffValue(o14)
    }
    if (11 === t29 || 12 === t29) {
      const o14 = []
      for (let n25 = 0; n25 < i21; n25++) {
        const i22 = s16 + n25 * a26
        if (i22 + a26 > e12.view.byteLength) return
        o14.push(
          11 === t29
            ? e12.view.getFloat32(i22, e12.littleEndian)
            : e12.view.getFloat64(i22, e12.littleEndian),
        )
      }
      return normalizeTiffValue(o14)
    }
  }
}
function readIfd(e12, t29) {
  const i21 = new Map(),
    o13 = readUint162(e12, t29)
  if (void 0 === o13 || o13 > 2048) return i21
  for (let a26 = 0; a26 < o13; a26++) {
    const o14 = t29 + 2 + 12 * a26
    if (o14 + 12 > e12.view.byteLength) break
    const n24 = readUint162(e12, o14),
      r19 = readUint162(e12, o14 + 2),
      s16 = readUint322(e12, o14 + 4)
    if (void 0 === n24 || void 0 === r19 || void 0 === s16) continue
    const l19 = readTiffValue(e12, r19, s16, o14)
    void 0 !== l19 && i21.set(n24, l19)
  }
  return i21
}
function isRational(e12) {
  return (
    Boolean(e12) &&
    'object' == typeof e12 &&
    !(e12 instanceof Uint8Array) &&
    'value' in e12
  )
}
function stringValue(e12) {
  return 'string' == typeof e12
    ? cleanText(e12)
    : e12 instanceof Uint8Array
      ? cleanText(decodeBytes(e12))
      : 'number' == typeof e12
        ? String(e12)
        : void 0
}
function numberValue(e12) {
  return 'number' == typeof e12
    ? Number.isFinite(e12)
      ? e12
      : void 0
    : isRational(e12)
      ? e12.value
      : void 0
}
function numberArray(e12) {
  if (Array.isArray(e12))
    return e12
      .map((e13) => ('number' == typeof e13 ? e13 : e13.value))
      .filter((e13) => Number.isFinite(e13))
  const t29 = numberValue(e12)
  return void 0 === t29 ? [] : [t29]
}
function rationalValue(e12) {
  return isRational(e12) ? e12 : void 0
}
function roundedNumber(e12, t29 = 6) {
  if (void 0 === e12 || !Number.isFinite(e12)) return
  const i21 = 10 ** t29
  return Math.round(e12 * i21) / i21
}
function setExif(e12, t29, i21) {
  null != i21 &&
    '' !== i21 &&
    ((Array.isArray(i21) && 0 === i21.length) || (e12[t29] = i21))
}
function compactExif(e12) {
  const t29 = {}
  for (const [i21, o13] of Object.entries(e12))
    null != o13 &&
      '' !== o13 &&
      ((Array.isArray(o13) && 0 === o13.length) || (t29[i21] = o13))
  return Object.keys(t29).length > 0 ? t29 : null
}
function formatMillimeters(e12) {
  const t29 = roundedNumber(numberValue(e12), 2)
  return void 0 === t29 ? void 0 : `${t29} mm`
}
function formatExifDateTime(e12, t29) {
  const i21 = stringValue(e12)
  if (!i21) return
  const o13 = stringValue(t29),
    a26 = i21.match(
      /^(\d{4}):(\d{2}):(\d{2})[ T](\d{2}):(\d{2}):(\d{2})(?:\.\d+)?$/,
    ),
    n24 = a26
      ? `${a26[1]}-${a26[2]}-${a26[3]}T${a26[4]}:${a26[5]}:${a26[6]}${o13 || ''}`
      : i21,
    r19 = new Date(n24)
  return Number.isNaN(r19.getTime()) ? void 0 : r19.toISOString()
}
function xpString(e12) {
  return e12 instanceof Uint8Array
    ? cleanText(decodeUtf16Le(e12))
    : stringValue(e12)
}
function gpsCoordinate(e12) {
  const t29 = (function (e13) {
    if (Array.isArray(e13)) return e13.filter(isRational)
    const t30 = rationalValue(e13)
    return t30 ? [t30] : []
  })(e12)
  if (t29.length >= 3)
    return roundedNumber(t29[0].value + t29[1].value / 60 + t29[2].value / 3600)
  const i21 = numberArray(e12)
  return i21.length >= 3
    ? roundedNumber(i21[0] + i21[1] / 60 + i21[2] / 3600)
    : roundedNumber(numberValue(e12))
}
function mappedValue(e12, t29) {
  var i21
  const o13 = numberValue(e12)
  if (void 0 !== o13) return null != (i21 = t29[o13]) ? i21 : o13
}
function inferColorSpaceFromIcc(e12) {
  const t29 = decodeBytes(e12)
  return t29.includes('sRGB') || t29.includes('IEC61966-2.1')
    ? 'sRGB'
    : t29.includes('Adobe RGB') || t29.includes('ADOBERGB')
      ? 'Adobe RGB'
      : t29.includes('Display P3') || t29.includes(' P3')
        ? 'Display P3'
        : t29.includes('Wide Gamut') || t29.includes('WideGamut')
          ? 'Wide Gamut RGB'
          : t29.includes('RGB ')
            ? 'RGB'
            : void 0
}
function parseXmpPacket(e12) {
  var t29
  const i21 = {},
    textTag = (t30) => {
      const i22 = new RegExp(`<${t30}[^>]*>([\\s\\S]*?)<\\/${t30}>`, 'i'),
        o14 = e12.match(i22)
      return o14 ? cleanText(o14[1].replace(/<[^>]+>/g, ' ')) : void 0
    },
    o13 = textTag('dc:title'),
    a26 = textTag('dc:description'),
    n24 = ((t30) => {
      var i22
      const o14 = new RegExp(`<${t30}[^>]*>[\\s\\S]*?<\\/${t30}>`, 'i'),
        a27 = null == (i22 = e12.match(o14)) ? void 0 : i22[0]
      return a27
        ? [...a27.matchAll(/<rdf:li[^>]*>([\s\S]*?)<\/rdf:li>/gi)]
            .map((e13) => cleanText(e13[1].replace(/<[^>]+>/g, ' ')))
            .filter((e13) => Boolean(e13))
        : []
    })('dc:subject'),
    r19 = Number(
      null !=
        (t29 = ((t30) => {
          var i22, o14
          const a27 = new RegExp(`${t30}="([^"]+)"`, 'i')
          return cleanText(
            null != (o14 = null == (i22 = e12.match(a27)) ? void 0 : i22[1])
              ? o14
              : '',
          )
        })('xmp:Rating'))
        ? t29
        : textTag('xmp:Rating'),
    )
  return (
    o13 && (i21.Title = o13),
    a26 && (i21.Description = a26),
    n24.length > 0 && (i21.Subject = n24),
    Number.isFinite(r19) && (i21.Rating = r19),
    i21
  )
}
function parseExifSegment(e12, t29, i21) {
  if (t29 + 8 > i21) return null
  const o13 = decodeBytes(e12.slice(t29, t29 + 2)),
    a26 = 'II' === o13
  if (!a26 && 'MM' !== o13) return null
  const n24 = {
    view: new DataView(e12.buffer, e12.byteOffset + t29, i21 - t29),
    bytes: e12.slice(t29, i21),
    littleEndian: a26,
  }
  if (42 !== readUint162(n24, 2)) return null
  const r19 = readUint322(n24, 4)
  if (void 0 === r19) return null
  const s16 = readIfd(n24, r19),
    l19 = numberValue(s16.get(34665)),
    u19 = numberValue(s16.get(34853)),
    d22 = l19 ? readIfd(n24, l19) : new Map(),
    c22 = u19 ? readIfd(n24, u19) : new Map(),
    f23 = {},
    m27 = stringValue(s16.get(270)),
    p29 = xpString(s16.get(40091)),
    g26 = xpString(s16.get(40092)),
    h21 = xpString(s16.get(40094)),
    w21 = xpString(s16.get(40095))
  ;(setExif(f23, 'ImageDescription', m27),
    setExif(f23, 'Title', p29),
    setExif(f23, 'XPTitle', p29),
    setExif(f23, 'XPComment', g26),
    setExif(f23, 'XPKeywords', h21),
    setExif(f23, 'Subject', w21 ? [w21] : void 0),
    setExif(f23, 'Make', stringValue(s16.get(271))),
    setExif(f23, 'Model', stringValue(s16.get(272))),
    setExif(f23, 'Orientation', numberValue(s16.get(274))),
    setExif(f23, 'Software', stringValue(s16.get(305))),
    setExif(f23, 'Artist', stringValue(s16.get(315))),
    setExif(f23, 'Copyright', stringValue(s16.get(33432))),
    setExif(f23, 'Rating', numberValue(s16.get(18246))),
    setExif(
      f23,
      'DateTimeOriginal',
      formatExifDateTime(d22.get(36867), d22.get(36881)),
    ),
    setExif(
      f23,
      'DateTimeDigitized',
      formatExifDateTime(d22.get(36868), d22.get(36882)),
    ),
    setExif(f23, 'OffsetTime', stringValue(d22.get(36880))),
    setExif(f23, 'OffsetTimeOriginal', stringValue(d22.get(36881))),
    setExif(f23, 'OffsetTimeDigitized', stringValue(d22.get(36882))),
    setExif(
      f23,
      'ExposureTime',
      (function (e13) {
        const t30 = rationalValue(e13)
        return t30
          ? 1 === t30.numerator && t30.denominator > 1
            ? `1/${t30.denominator}`
            : t30.value
          : numberValue(e13)
      })(d22.get(33434)),
    ),
    setExif(f23, 'FNumber', roundedNumber(numberValue(d22.get(33437)), 2)),
    setExif(f23, 'ExposureProgram', mappedValue(d22.get(34850), y16)),
    setExif(f23, 'ISO', numberValue(d22.get(34855))),
    setExif(
      f23,
      'ShutterSpeedValue',
      roundedNumber(numberValue(d22.get(37377)), 4),
    ),
    setExif(
      f23,
      'ApertureValue',
      roundedNumber(numberValue(d22.get(37378)), 4),
    ),
    setExif(
      f23,
      'BrightnessValue',
      roundedNumber(numberValue(d22.get(37379)), 4),
    ),
    setExif(
      f23,
      'ExposureCompensation',
      roundedNumber(numberValue(d22.get(37380)), 4),
    ),
    setExif(
      f23,
      'MaxApertureValue',
      roundedNumber(numberValue(d22.get(37381)), 2),
    ),
    setExif(f23, 'MeteringMode', mappedValue(d22.get(37383), v14)),
    setExif(f23, 'LightSource', numberValue(d22.get(37384))),
    setExif(f23, 'Flash', mappedValue(d22.get(37385), P14)),
    setExif(f23, 'FocalLength', formatMillimeters(d22.get(37386))),
    setExif(
      f23,
      'UserComment',
      (function (e13) {
        if (!(e13 instanceof Uint8Array)) return stringValue(e13)
        if (e13.byteLength <= 8) return
        const t30 = decodeBytes(e13.slice(0, 8)),
          i22 = e13.slice(8)
        return t30.startsWith('UNICODE')
          ? cleanText(decodeUtf16Le(i22))
          : cleanText(decodeBytes(i22))
      })(d22.get(37510)),
    ),
    setExif(
      f23,
      'ColorSpace',
      (function (e13) {
        const t30 = numberValue(e13)
        return 1 === t30 ? 'sRGB' : 65535 === t30 ? 'Uncalibrated' : void 0
      })(d22.get(40961)),
    ),
    setExif(f23, 'ImageWidth', numberValue(d22.get(40962))),
    setExif(f23, 'ImageHeight', numberValue(d22.get(40963))),
    setExif(f23, 'SensingMethod', mappedValue(d22.get(41495), E12)),
    setExif(
      f23,
      'FocalPlaneXResolution',
      roundedNumber(numberValue(d22.get(41486)), 2),
    ),
    setExif(
      f23,
      'FocalPlaneYResolution',
      roundedNumber(numberValue(d22.get(41487)), 2),
    ),
    setExif(f23, 'ExposureMode', mappedValue(d22.get(41986), b21)),
    setExif(f23, 'WhiteBalance', mappedValue(d22.get(41987), I11)),
    setExif(f23, 'FocalLengthIn35mmFormat', formatMillimeters(d22.get(41989))),
    setExif(f23, 'SceneCaptureType', mappedValue(d22.get(41990), x17)),
    setExif(f23, 'LensMake', stringValue(d22.get(42035))),
    setExif(f23, 'LensModel', stringValue(d22.get(42036))))
  const S12 = gpsCoordinate(c22.get(2)),
    $14 = gpsCoordinate(c22.get(4)),
    V11 = stringValue(c22.get(1)),
    T13 = stringValue(c22.get(3))
  if (
    (setExif(f23, 'GPSLatitude', S12),
    setExif(f23, 'GPSLatitudeRef', V11),
    setExif(f23, 'GPSLongitude', $14),
    setExif(f23, 'GPSLongitudeRef', T13),
    setExif(f23, 'GPSAltitude', numberValue(c22.get(6))),
    setExif(f23, 'GPSAltitudeRef', numberValue(c22.get(5))),
    setExif(f23, 'GPSDateStamp', stringValue(c22.get(29))),
    setExif(
      f23,
      'GPSTimeStamp',
      (function (e13) {
        const t30 = numberArray(e13)
        if (t30.length < 3) return
        const [i22, o14, a27] = t30
        return `${String(Math.trunc(i22)).padStart(2, '0')}:${String(Math.trunc(o14)).padStart(2, '0')}:${String(Math.round(a27)).padStart(2, '0')}`
      })(c22.get(7)),
    ),
    setExif(f23, 'GPSImgDirectionRef', stringValue(c22.get(16))),
    setExif(f23, 'GPSImgDirection', roundedNumber(numberValue(c22.get(17)), 4)),
    setExif(f23, 'GPSDestBearingRef', stringValue(c22.get(24))),
    setExif(f23, 'GPSDestBearing', roundedNumber(numberValue(c22.get(25)), 4)),
    void 0 !== S12 && void 0 !== $14)
  ) {
    const e13 = 'S' === V11 ? -Math.abs(S12) : Math.abs(S12),
      t30 = 'W' === T13 ? -Math.abs($14) : Math.abs($14)
    ;(setExif(f23, 'GPSPosition', `${e13} ${t30}`),
      setExif(f23, 'GPSCoordinates', `${e13}, ${t30}`))
  }
  return compactExif(f23)
}
function segmentStartsWith(e12, t29, i21, o13) {
  if (t29 + o13.length > i21) return false
  for (let i22 = 0; i22 < o13.length; i22++)
    if (e12[t29 + i22] !== o13.charCodeAt(i22)) return false
  return true
}
function parseJpegMetadata(e12) {
  var t29
  if (e12.byteLength < 4 || 255 !== e12[0] || 216 !== e12[1]) return null
  const i21 = {}
  let o13 = 2
  for (; o13 + 4 <= e12.byteLength; ) {
    for (; o13 < e12.byteLength && 255 === e12[o13]; ) o13++
    if (o13 >= e12.byteLength) break
    const a26 = e12[o13]
    if ((o13++, 217 === a26 || 218 === a26)) break
    if (1 === a26 || (a26 >= 208 && a26 <= 215)) continue
    if (o13 + 2 > e12.byteLength) break
    const n24 = readUint16BE(e12, o13),
      r19 = o13 + 2,
      s16 = o13 + n24
    if (n24 < 2 || s16 > e12.byteLength) break
    if (
      (w17.has(a26) &&
        r19 + 5 < s16 &&
        !i21.width &&
        !i21.height &&
        ((i21.height = readUint16BE(e12, r19 + 1)),
        (i21.width = readUint16BE(e12, r19 + 3))),
      225 === a26 && segmentStartsWith(e12, r19, s16, 'Exif\0\0'))
    )
      i21.exif =
        null != (t29 = parseExifSegment(e12, r19 + 6, s16)) ? t29 : void 0
    else if (
      225 === a26 &&
      segmentStartsWith(e12, r19, s16, 'http://ns.adobe.com/xap/1.0/\0')
    ) {
      const t30 = r19 + 29
      i21.xmp = parseXmpPacket(decodeBytes(e12.slice(t30, s16)))
    } else
      226 === a26 &&
        segmentStartsWith(e12, r19, s16, 'ICC_PROFILE\0') &&
        (i21.colorSpace = inferColorSpaceFromIcc(e12.slice(r19, s16)))
    o13 = s16
  }
  return i21.exif || i21.xmp || i21.width || i21.height ? i21 : null
}
export { parseJpegMetadata, setExif, compactExif }
