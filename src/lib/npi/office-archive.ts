// SPDX-License-Identifier: AGPL-3.0-or-later
import { NpiError } from './domain'
/** Inspect ZIP directory before the Excel library allocates expanded contents. */
export function validateOfficeArchive(
  buffer: Uint8Array,
  limits: { mainPart: string; maxEntries: number; maxExpandedBytes: number },
) {
  if (buffer.byteLength > 5 * 1024 * 1024 || buffer.byteLength < 22)
    throw new NpiError('INVALID_BOM_FORMAT', 'Excel文件须在5MB以内', 400)
  const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength)
  let end = -1
  for (let i = buffer.length - 22; i >= Math.max(0, buffer.length - 65557); i--)
    if (
      view.getUint32(i, true) === 0x06054b50 &&
      i + 22 + view.getUint16(i + 20, true) === buffer.length
    ) {
      end = i
      break
    }
  if (end < 0) throw new NpiError('INVALID_BOM_FORMAT', '不是有效xlsx文件', 400)
  const count = view.getUint16(end + 10, true),
    size = view.getUint32(end + 12, true),
    offset = view.getUint32(end + 16, true)
  if (
    count > limits.maxEntries ||
    !count ||
    size === 0xffffffff ||
    offset + size !== end ||
    view.getUint16(end + 4, true) !== 0 ||
    view.getUint16(end + 6, true) !== 0
  )
    throw new NpiError(
      'INVALID_BOM_FORMAT',
      '不支持分卷、ZIP64或超大工作簿',
      400,
    )
  let cursor = offset,
    expanded = 0
  const names = new Set<string>()
  for (let i = 0; i < count; i++) {
    if (cursor + 46 > end || view.getUint32(cursor, true) !== 0x02014b50)
      throw new NpiError('INVALID_BOM_FORMAT', '工作簿目录损坏', 400)
    const flags = view.getUint16(cursor + 8, true),
      bytes = view.getUint32(cursor + 24, true)
    const len = view.getUint16(cursor + 28, true),
      extra = view.getUint16(cursor + 30, true),
      comment = view.getUint16(cursor + 32, true)
    if (cursor + 46 + len + extra + comment > end)
      throw new NpiError('INVALID_BOM_FORMAT', '工作簿目录损坏', 400)
    const name = new TextDecoder().decode(
      buffer.subarray(cursor + 46, cursor + 46 + len),
    )
    expanded += bytes
    if (
      flags & 1 ||
      expanded > limits.maxExpandedBytes ||
      names.has(name) ||
      name.includes('..') ||
      name.startsWith('/') ||
      /vbaProject\.bin$/i.test(name)
    )
      throw new NpiError(
        'INVALID_BOM_FORMAT',
        '工作簿加密、含宏、重复条目或解压内容过大',
        400,
      )
    names.add(name)
    cursor += 46 + len + extra + comment
  }
  if (cursor !== end || !names.has(limits.mainPart))
    throw new NpiError('INVALID_BOM_FORMAT', '缺少工作簿结构', 400)
}
