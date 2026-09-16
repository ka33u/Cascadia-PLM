// SPDX-License-Identifier: AGPL-3.0-or-later
import { strToU8, zipSync } from 'fflate'
import ExcelJS from 'exceljs'

export function wordParts(): Record<string, Uint8Array> {
  return Object.fromEntries(
    Object.entries({
      '[Content_Types].xml':
        '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
      '_rels/.rels':
        '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
      'word/document.xml':
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>合成技术要求：样机验收前核对尺寸。</w:t></w:r></w:p><w:sectPr/></w:body></w:document>',
    }).map(([name, xml]) => [name, strToU8(xml)]),
  )
}
export async function officeFixtures() {
  const workbook = new ExcelJS.Workbook()
  const sheet = workbook.addWorksheet('到货资料')
  sheet.addRows([
    ['物料', '数量', '验收说明'],
    ['合成采购件', 2, '包装完好'],
  ])
  return {
    docx: Buffer.from(zipSync(wordParts())),
    xlsx: Buffer.from(await workbook.xlsx.writeBuffer()),
  }
}
