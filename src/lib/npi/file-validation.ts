// SPDX-License-Identifier: AGPL-3.0-or-later
import { unzipSync } from 'fflate'
import { NpiError } from './domain'
import { validateOfficeArchive } from './office-archive'
import { MAX_NPI_FILE_BYTES, NPI_FILE_TYPES_LABEL } from './file-types'

const office = {
  docx: {
    part: 'word/document.xml',
    content:
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml',
    mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  },
  xlsx: {
    part: 'xl/workbook.xml',
    content:
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml',
    mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  },
}

// Inspect package identity, not document contents. Only the bounded content-type
// manifest is inflated; images, worksheets and embedded objects are never opened.
function officeMime(bytes: Buffer, ext: 'docx' | 'xlsx') {
  if (bytes.length < 22 || bytes.readUInt32LE(0) !== 0x04034b50) return null
  const expected = office[ext]
  try {
    validateOfficeArchive(bytes, {
      mainPart: expected.part,
      maxEntries: 2000,
      maxExpandedBytes: 64 * 1024 * 1024,
    })
    const names = new Set<string>()
    let expanded = 0
    const parts = unzipSync(bytes, {
      filter(entry) {
        expanded += entry.originalSize
        if (
          names.has(entry.name) ||
          names.size >= 2000 ||
          expanded > 64 * 1024 * 1024 ||
          entry.size > bytes.length ||
          ![0, 8].includes(entry.compression) ||
          /(?:^|\/)vbaProject\.bin$/i.test(entry.name)
        )
          throw Error('Invalid or unsupported Office package')
        names.add(entry.name)
        if (entry.name === expected.part && !entry.originalSize)
          throw Error('Empty Office document part')
        if (entry.name !== '[Content_Types].xml') return false
        if (
          !entry.originalSize ||
          entry.originalSize > 512 * 1024 ||
          entry.size > 512 * 1024
        )
          throw Error('Invalid Office manifest size')
        return true
      },
    })
    if (!names.has(expected.part) || !names.has('_rels/.rels')) return null
    const manifest = parts['[Content_Types].xml']
    if (!manifest?.length) return null
    const encoding =
      manifest[0] === 0xff && manifest[1] === 0xfe
        ? 'utf-16le'
        : manifest[0] === 0xfe && manifest[1] === 0xff
          ? 'utf-16be'
          : 'utf-8'
    const xml = new TextDecoder(encoding, { fatal: true })
      .decode(manifest)
      .replace(/<!--[\s\S]*?-->/g, '')
    if (/<!DOCTYPE|<!ENTITY|macroEnabled|vbaProject/i.test(xml)) return null
    const overrides = xml.match(/<(?:[\w.-]+:)?Override\b[^>]*>/g) || []
    const declared = overrides.some((tag) => {
      const attributes = Object.fromEntries(
        [...tag.matchAll(/\b(PartName|ContentType)\s*=\s*(["'])(.*?)\2/g)].map(
          (m) => [m[1], m[3]],
        ),
      )
      return (
        attributes.PartName === '/' + expected.part &&
        attributes.ContentType === expected.content
      )
    })
    return declared ? expected.mime : null
  } catch {
    return null
  }
}

export function validatedFile(file: Pick<File, 'name'>, bytes: Buffer) {
  // eslint-disable-next-line no-control-regex
  const name = file.name.replace(/[\\/\x00-\x1f\x7f]/g, '_').trim()
  if (
    !name ||
    name.length > 240 ||
    !bytes.length ||
    bytes.length > MAX_NPI_FILE_BYTES
  )
    throw new NpiError(
      'INVALID_FILE',
      '文件不能为空，文件名不超过240字，单个文件不超过5MB',
    )
  const ext = name.split('.').at(-1)?.toLowerCase()
  const pdf = bytes.subarray(0, 5).toString() === '%PDF-'
  const png = bytes
    .subarray(0, 8)
    .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
  const jpg =
    bytes.length > 3 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255
  const webp =
    bytes.subarray(0, 4).toString() === 'RIFF' &&
    bytes.subarray(8, 12).toString() === 'WEBP'
  const mime =
    ext === 'pdf' && pdf
      ? 'application/pdf'
      : ext === 'png' && png
        ? 'image/png'
        : ['jpg', 'jpeg'].includes(ext || '') && jpg
          ? 'image/jpeg'
          : ext === 'webp' && webp
            ? 'image/webp'
            : ext === 'docx' || ext === 'xlsx'
              ? officeMime(bytes, ext)
              : null
  if (!mime)
    throw new NpiError(
      'INVALID_FILE',
      `文件格式无效或与扩展名不符。支持${NPI_FILE_TYPES_LABEL}，Word/Excel文件须未加密且不含宏。`,
    )
  return { name, ext, mime }
}
