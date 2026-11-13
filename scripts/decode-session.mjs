import fs from 'node:fs'
import zlib from 'node:zlib'

const file = process.argv[2]
const out = process.argv[3]
const buf = fs.readFileSync(file)
const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])
const starts = []
for (let i = 0; i + 4 <= buf.length; i += 1) {
  if (buf[i] === MAGIC[0] && buf[i + 1] === MAGIC[1] && buf[i + 2] === MAGIC[2] && buf[i + 3] === MAGIC[3]) starts.push(i)
}
const chunks = []
let frames = 0
let failed = 0
for (let i = 0; i < starts.length; i += 1) {
  const end = i + 1 < starts.length ? starts[i + 1] : buf.length
  const slice = buf.subarray(starts[i], end)
  try {
    chunks.push(zlib.zstdDecompressSync(slice))
    frames += 1
  } catch {
    failed += 1
  }
}
fs.writeFileSync(out, Buffer.concat(chunks))
console.log(JSON.stringify({ bytes: buf.length, starts: starts.length, frames, failed, outBytes: fs.statSync(out).size }))
