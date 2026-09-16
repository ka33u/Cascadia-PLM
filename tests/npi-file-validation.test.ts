// SPDX-License-Identifier: AGPL-3.0-or-later
import assert from 'node:assert/strict'
import test from 'node:test'
import { strToU8, zipSync } from 'fflate'
import { validatedFile } from '../src/lib/npi/file-validation'
import { officeFixtures, wordParts } from './npi-office-fixtures'

const validate = (name: string, bytes: Uint8Array) =>
  validatedFile({ name }, Buffer.from(bytes))
const reject = (name: string, bytes: Uint8Array) =>
  assert.throws(() => validate(name, bytes), { code: 'INVALID_FILE' })

test('Accept Word and real ExcelJS packages, uppercase extension and UTF-16 manifest', async () => {
  const files = await officeFixtures()
  assert.equal(
    validate('技术要求.DOCX', files.docx).mime,
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  )
  assert.equal(
    validate('验收清单.xlsx', files.xlsx).mime,
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  )
  const parts = wordParts()
  parts['[Content_Types].xml'] = Buffer.from(
    '\ufeff' +
      new TextDecoder()
        .decode(parts['[Content_Types].xml'])
        .replace('UTF-8', 'UTF-16'),
    'utf16le',
  )
  assert.equal(validate('技术要求.docx', zipSync(parts)).ext, 'docx')
})
test('Reject renamed archives, mismatched Office families, missing parts and truncated packages', async () => {
  const files = await officeFixtures()
  reject('renamed.xlsx', files.docx)
  reject('renamed.docx', files.xlsx)
  reject('zip.docx', zipSync({ 'readme.txt': strToU8('Not an Office file') }))
  const parts = wordParts()
  delete parts['word/document.xml']
  reject('missing.docx', zipSync(parts))
  reject('cut.docx', files.docx.subarray(0, files.docx.length - 12))
  reject('short.docx', new Uint8Array([80, 75, 3, 4]))
  reject(
    'encrypted.docx',
    new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]),
  )
})
test('Reject macros, unsupported extensions and fake manifest declarations', () => {
  const parts = wordParts()
  parts['word/vbaProject.bin'] = strToU8('macro')
  reject('macro.docx', zipSync(parts))
  delete parts['word/vbaProject.bin']
  parts['[Content_Types].xml'] = strToU8(
    new TextDecoder()
      .decode(parts['[Content_Types].xml'])
      .replace(
        'wordprocessingml.document.main+xml',
        'ms-word.document.macroEnabled.main+xml',
      ),
  )
  reject('macro-type.docx', zipSync(parts))
  const commented = wordParts()
  commented['[Content_Types].xml'] = strToU8(
    '<!--' + new TextDecoder().decode(commented['[Content_Types].xml']) + '-->',
  )
  reject('comment.docx', zipSync(commented))
  reject('legacy.doc', zipSync(wordParts()))
  reject('macro.docm', zipSync(wordParts()))
})
test('Bound manifest expansion, total package size and entry count before content is inflated', () => {
  const oversized = wordParts()
  oversized['[Content_Types].xml'] = new Uint8Array(512 * 1024 + 1).fill(32)
  reject('large-manifest.docx', zipSync(oversized))
  const many = wordParts()
  for (let i = 0; i < 2000; i++) many['media/' + i] = new Uint8Array()
  reject('many.docx', zipSync(many))
  const declared = Buffer.from(zipSync(wordParts()))
  const central = declared.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]))
  assert.ok(central > 0)
  declared.writeUInt32LE(65 * 1024 * 1024, central + 24)
  reject('oversized-declaration.docx', declared)
  const encrypted = Buffer.from(zipSync(wordParts()))
  const directory = encrypted.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]))
  encrypted.writeUInt16LE(
    encrypted.readUInt16LE(directory + 8) | 1,
    directory + 8,
  )
  reject('encrypted-zip.docx', encrypted)
  const split = Buffer.from(zipSync(wordParts()))
  split.writeUInt16LE(1, split.length - 22 + 4)
  reject('split.docx', split)
})
test('Preserve PDF/image signatures, filename sanitation and the five MB cap', () => {
  assert.equal(
    validate('../技术.pdf', Buffer.from('%PDF-1.4')).name,
    '.._技术.pdf',
  )
  assert.equal(
    validate('图.png', new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])).mime,
    'image/png',
  )
  assert.equal(
    validate('照片.jpg', new Uint8Array([255, 216, 255, 0])).mime,
    'image/jpeg',
  )
  assert.equal(
    validate('照片.webp', Buffer.from('RIFF0000WEBP')).mime,
    'image/webp',
  )
  reject('fake.pdf', Buffer.from('<html/>'))
  reject('empty.docx', new Uint8Array())
  reject('too-big.xlsx', new Uint8Array(5 * 1024 * 1024 + 1))
  reject('bad.svg', Buffer.from('<svg/>'))
})
