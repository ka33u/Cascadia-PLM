// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

/**
 * The GLB rewriter behind `scripts/fix-glb-up-axis.mjs`.
 *
 * This one earns tests on the data-integrity gate: it rewrites CAD assets in
 * the vault in place, and the two ways it can go wrong are both silent. A sign
 * error in the quaternion still produces a file that loads — just rotated to
 * some other wrong orientation, which is exactly the bug being fixed and just
 * as hard to notice. And a mistake in the GLB chunk framing corrupts the vertex
 * buffer of every part it touches, with no original left to compare against.
 *
 * So the assertions are on what must be true of the output, not on how it is
 * produced: the rotation carries model +Z to world +Y, the binary chunk comes
 * back byte-identical, and a file that is not ours is never touched.
 *
 * Run: npx vitest run scripts/fix-glb-up-axis.test.ts
 */

import { describe, expect, it } from 'vitest'

import {
  Z_UP_TO_Y_UP_ROTATION,
  addUpAxisRotation,
  parseGlb,
  serializeGlb,
} from './fix-glb-up-axis.mjs'

/** Rotate a vector by a glTF quaternion (x, y, z, w), as a consumer would. */
function rotate(
  quaternion: Array<number>,
  point: Array<number>,
): Array<number> {
  const [x = 0, y = 0, z = 0, w = 1] = quaternion
  const [px = 0, py = 0, pz = 0] = point
  // v + 2 * cross(q.xyz, cross(q.xyz, v) + w * v)
  const tx = 2 * (y * pz - z * py)
  const ty = 2 * (z * px - x * pz)
  const tz = 2 * (x * py - y * px)
  return [
    px + w * tx + (y * tz - z * ty),
    py + w * ty + (z * tx - x * tz),
    pz + w * tz + (x * ty - y * tx),
  ]
}

/** Round to 6dp, folding -0 into 0 so a sign of zero is not a failure. */
const round = (v: Array<number>) =>
  v.map((n) => {
    const r = Math.round(n * 1e6) / 1e6
    return Object.is(r, -0) ? 0 : r
  })

const CHUNK_JSON = 0x4e4f534a
const CHUNK_BIN = 0x004e4942

/** A minimal but structurally valid GLB, as the converter used to write them. */
function makeGlb(json: object, bin = Buffer.from([1, 2, 3, 4, 5, 6, 7, 8])) {
  return serializeGlb(
    [
      { type: CHUNK_JSON, data: Buffer.from('{}') },
      { type: CHUNK_BIN, data: bin },
    ],
    json,
  ) as Buffer
}

interface GltfNode {
  mesh?: number
  rotation?: Array<number>
  children?: Array<number>
}

interface GltfJson {
  asset: { version?: string; generator?: string }
  scene: number
  scenes: Array<{ nodes: Array<number> }>
  nodes: Array<GltfNode>
  meshes: Array<{ primitives: Array<unknown> }>
}

const converterJson = (): GltfJson => ({
  asset: { version: '2.0', generator: 'Cascadia CAD Converter' },
  scene: 0,
  scenes: [{ nodes: [0] }],
  nodes: [{ mesh: 0 }],
  meshes: [{ primitives: [] }],
})

describe('Z_UP_TO_Y_UP_ROTATION', () => {
  it('carries the CAD up axis to the glTF up axis', () => {
    expect(round(rotate(Z_UP_TO_Y_UP_ROTATION, [0, 0, 1]))).toEqual([0, 1, 0])
  })

  it('leaves the shared X axis alone and sends +Y to the back', () => {
    expect(round(rotate(Z_UP_TO_Y_UP_ROTATION, [1, 0, 0]))).toEqual([1, 0, 0])
    expect(round(rotate(Z_UP_TO_Y_UP_ROTATION, [0, 1, 0]))).toEqual([0, 0, -1])
  })
})

describe('addUpAxisRotation', () => {
  it('wraps the scene root without disturbing existing node indices', () => {
    const json = converterJson()

    expect(addUpAxisRotation(json)).toBe('rewritten')
    expect(json.nodes[0]).toEqual({ mesh: 0 })

    // Appended, not spliced in at 0 — so the wrapper lands last.
    expect(json.scenes[0]?.nodes).toEqual([1])
    const root = json.nodes[1]
    expect(root?.children).toEqual([0])
    expect(root?.rotation).toEqual(Z_UP_TO_Y_UP_ROTATION)
  })

  it('is a no-op on a file it has already rewritten', () => {
    const json = converterJson()
    addUpAxisRotation(json)
    const once = structuredClone(json)

    expect(addUpAxisRotation(json)).toBe('already-correct')
    expect(json).toEqual(once)
  })

  it('refuses to touch a GLB this converter did not write', () => {
    const json = {
      ...converterJson(),
      asset: { generator: 'Blender glTF 2.0' },
    }
    const before = structuredClone(json)

    expect(addUpAxisRotation(json)).toBe('foreign')
    expect(json).toEqual(before)
  })
})

describe('GLB round-trip', () => {
  it('returns the binary chunk byte-for-byte', () => {
    const bin = Buffer.from(Float32Array.of(0, 0, 1, 12.5, -3.25, 7).buffer)
    const parsed = parseGlb(makeGlb(converterJson(), bin))
    addUpAxisRotation(parsed.json)
    const after = parseGlb(serializeGlb(parsed.chunks, parsed.json))

    const binChunk = after.chunks.find(
      (c: { type: number }) => c.type === CHUNK_BIN,
    )
    if (!binChunk) throw new Error('round-trip dropped the BIN chunk')
    expect(Buffer.from(binChunk.data)).toEqual(bin)
  })

  it('keeps every chunk 4-byte aligned when the JSON length is not', () => {
    // 'x'.repeat(3) makes the JSON payload an odd length before padding.
    const json = { ...converterJson(), extras: { pad: 'xxx' } }
    const bytes = serializeGlb(parseGlb(makeGlb(json)).chunks, json) as Buffer

    expect(bytes.readUInt32LE(8)).toBe(bytes.length)
    let off = 12
    while (off + 8 <= bytes.length) {
      const length = bytes.readUInt32LE(off)
      expect(length % 4).toBe(0)
      off += 8 + length
    }
    expect(off).toBe(bytes.length)
  })
})
