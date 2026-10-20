/** RFC 1321 MD5, used only for the Bilibili Android request signature. */
export function md5(text: string): string {
  const input = new TextEncoder().encode(text)
  const length = Math.ceil((input.length + 9) / 64) * 64
  const bytes = new Uint8Array(length)
  bytes.set(input)
  bytes[input.length] = 0x80
  const view = new DataView(bytes.buffer)
  view.setUint32(length - 8, (input.length * 8) >>> 0, true)
  view.setUint32(length - 4, Math.floor(input.length / 0x20000000), true)
  const shift = [7, 12, 17, 22, 5, 9, 14, 20, 4, 11, 16, 23, 6, 10, 15, 21]
  const constants = Array.from({ length: 64 }, (_, i) => Math.floor(Math.abs(Math.sin(i + 1)) * 0x100000000))
  let a0 = 0x67452301
  let b0 = 0xefcdab89
  let c0 = 0x98badcfe
  let d0 = 0x10325476
  for (let offset = 0; offset < length; offset += 64) {
    let a = a0,
      b = b0,
      c = c0,
      d = d0
    for (let i = 0; i < 64; i++) {
      let f: number, index: number
      if (i < 16) {
        f = (b & c) | (~b & d)
        index = i
      } else if (i < 32) {
        f = (d & b) | (~d & c)
        index = (5 * i + 1) % 16
      } else if (i < 48) {
        f = b ^ c ^ d
        index = (3 * i + 5) % 16
      } else {
        f = c ^ (b | ~d)
        index = (7 * i) % 16
      }
      const sum = (a + f + constants[i]! + view.getUint32(offset + index * 4, true)) >>> 0
      const bits = shift[Math.floor(i / 16) * 4 + (i % 4)]!
      const rotated = (sum << bits) | (sum >>> (32 - bits))
      a = d
      d = c
      c = b
      b = (b + rotated) >>> 0
    }
    a0 = (a0 + a) >>> 0
    b0 = (b0 + b) >>> 0
    c0 = (c0 + c) >>> 0
    d0 = (d0 + d) >>> 0
  }
  return [a0, b0, c0, d0]
    .map((value) =>
      Array.from({ length: 4 }, (_, i) => ((value >>> (i * 8)) & 255).toString(16).padStart(2, '0')).join(''),
    )
    .join('')
}
