// Pure JS XZ/LZMA2 decoder — no WebAssembly, no native bindings

// ---- Bit reader ----
class BitReader {
  constructor(buf) { this.buf = buf; this.pos = 0; }
  readByte() {
    if (this.pos >= this.buf.length) throw new Error('Unexpected end of input');
    return this.buf[this.pos++];
  }
  readUint32LE() {
    const b = this.buf, p = this.pos; this.pos += 4;
    return ((b[p]) | (b[p+1]<<8) | (b[p+2]<<16) | (b[p+3]<<24)) >>> 0;
  }
  readUint64LE() {
    const lo = this.readUint32LE(), hi = this.readUint32LE();
    if (hi > 0x1FFFFF) throw new Error('File too large');
    return hi * 0x100000000 + lo;
  }
  slice(len) { const s = this.buf.slice(this.pos, this.pos + len); this.pos += len; return s; }
}

// ---- LZMA range decoder ----
class RangeDecoder {
  constructor(buf, pos) {
    this.buf = buf; this.pos = pos;
    this.range = 0xFFFFFFFF; this.code = 0;
    this.pos++; // first byte discarded
    for (let i = 0; i < 4; i++) this.code = ((this.code << 8) | this.buf[this.pos++]) >>> 0;
  }
  normalize() {
    if (this.range < 0x1000000) {
      this.range = (this.range << 8) >>> 0;
      this.code = (((this.code << 8) | this.buf[this.pos++]) >>> 0);
    }
  }
  decodeBit(probs, idx) {
    this.normalize();
    const prob = probs[idx];
    const bound = Math.imul(this.range >>> 11, prob) >>> 0;
    if ((this.code >>> 0) < bound) {
      this.range = bound;
      probs[idx] += (2048 - prob) >> 5;
      return 0;
    }
    this.range = (this.range - bound) >>> 0;
    this.code = (this.code - bound) >>> 0;
    probs[idx] -= prob >> 5;
    return 1;
  }
  decodeBitTree(probs, off, bits) {
    let m = 1;
    for (let i = 0; i < bits; i++) m = (m << 1) | this.decodeBit(probs, off + m);
    return m - (1 << bits);
  }
  decodeReverseBitTree(probs, off, bits) {
    let m = 1, sym = 0;
    for (let i = 0; i < bits; i++) {
      const b = this.decodeBit(probs, off + m);
      m = (m << 1) | b; sym |= b << i;
    }
    return sym;
  }
  decodeDirectBits(n) {
    let r = 0;
    for (let i = 0; i < n; i++) {
      this.normalize();
      this.range = (this.range >>> 1) >>> 0;
      const t = ((this.code - this.range) >>> 31);
      this.code = (this.code - (this.range & (t - 1))) >>> 0;
      r = (r << 1) | (1 - t);
    }
    return r;
  }
}

function makeProbs(n) { return new Uint16Array(n).fill(1024); }

// Decode a raw LZMA1 bitstream into output buffer
// propsByte: encoded as lc + lp*9 + pb*45 (LZMA2 style) already decoded
function decodeLZMAStream(buf, startPos, unpackSize, lc, lp, pb, dictSize) {
  dictSize = Math.max(dictSize, 4096);
  const rd = new RangeDecoder(buf, startPos);
  const out = new Uint8Array(unpackSize);
  let outPos = 0;

  const litProbs = makeProbs(0x300 << (lc + lp));
  const isMatch = makeProbs(12 << 4);
  const isRep = makeProbs(12);
  const isRepG0 = makeProbs(12);
  const isRepG1 = makeProbs(12);
  const isRepG2 = makeProbs(12);
  const isRep0Long = makeProbs(12 << 4);
  const posSlot = [makeProbs(64), makeProbs(64), makeProbs(64), makeProbs(64)];
  const posDecoders = makeProbs(114);
  const alignProbs = makeProbs(16);
  const lenDec = { c: makeProbs(1), c2: makeProbs(1), low: makeProbs(4*8), mid: makeProbs(4*8), high: makeProbs(256) };
  const repLen = { c: makeProbs(1), c2: makeProbs(1), low: makeProbs(4*8), mid: makeProbs(4*8), high: makeProbs(256) };

  const decodeLen = (ld, ps) => {
    if (!rd.decodeBit(ld.c, 0)) return rd.decodeBitTree(ld.low, ps << 3, 3);
    if (!rd.decodeBit(ld.c2, 0)) return 8 + rd.decodeBitTree(ld.mid, ps << 3, 3);
    return 16 + rd.decodeBitTree(ld.high, 0, 8);
  };

  const dict = new Uint8Array(dictSize);
  let dictPos = 0;
  const dictGet = (dist) => { let p = dictPos - 1 - dist; if (p < 0) p += dictSize; return dict[p]; };
  const dictPut = (b) => { out[outPos++] = b; dict[dictPos] = b; dictPos = (dictPos + 1) % dictSize; };

  let state = 0, rep0 = 1, rep1 = 1, rep2 = 1, rep3 = 1;

  while (outPos < unpackSize) {
    const ps = outPos & ((1 << pb) - 1);
    if (!rd.decodeBit(isMatch, (state << 4) | ps)) {
      // Literal
      const litCtx = ((outPos & ((1 << lp) - 1)) << lc) | ((outPos > 0 ? out[outPos-1] : 0) >> (8 - lc));
      const base = litCtx * 0x300;
      let sym = 1;
      if (state >= 7) {
        const mb = dictGet(rep0);
        let off = 0x100;
        do {
          const mbit = (mb >> (7 - Math.floor(Math.log2(sym)))) & 1;
          const bit = rd.decodeBit(litProbs, base + off + (mbit << 8) + sym);
          sym = (sym << 1) | bit;
          if (mbit !== bit) off = 0;
        } while (sym < 0x100);
      } else {
        do { sym = (sym << 1) | rd.decodeBit(litProbs, base + sym); } while (sym < 0x100);
      }
      dictPut(sym & 0xFF);
      state = state < 4 ? 0 : state < 10 ? state - 3 : state - 6;
    } else {
      let len;
      if (rd.decodeBit(isRep, state)) {
        if (!rd.decodeBit(isRepG0, state)) {
          if (!rd.decodeBit(isRep0Long, (state << 4) | ps)) {
            dictPut(dictGet(rep0));
            state = state < 7 ? 9 : 11;
            continue;
          }
        } else {
          let dist;
          if (!rd.decodeBit(isRepG1, state)) { dist = rep1; }
          else {
            if (!rd.decodeBit(isRepG2, state)) { dist = rep2; }
            else { dist = rep3; rep3 = rep2; }
            rep2 = rep1;
          }
          rep1 = rep0; rep0 = dist;
        }
        len = 2 + decodeLen(repLen, ps);
        state = state < 7 ? 8 : 11;
      } else {
        rep3 = rep2; rep2 = rep1; rep1 = rep0;
        len = 2 + decodeLen(lenDec, ps);
        state = state < 7 ? 7 : 10;
        const slot = rd.decodeBitTree(posSlot[Math.min(len - 2, 3)], 0, 6);
        if (slot >= 4) {
          const numDirect = (slot >> 1) - 1;
          rep0 = (2 | (slot & 1)) << numDirect;
          if (slot < 14) {
            rep0 += rd.decodeReverseBitTree(posDecoders, rep0 - slot - 1, numDirect);
          } else {
            rep0 += rd.decodeDirectBits(numDirect - 4) << 4;
            rep0 += rd.decodeReverseBitTree(alignProbs, 0, 4);
          }
        } else { rep0 = slot; }
      }
      for (let i = 0; i < len && outPos < unpackSize; i++) dictPut(dictGet(rep0));
    }
  }
  return out;
}

// ---- LZMA2 chunk stream decoder ----
function decodeLZMA2(buf, unpackSize) {
  const out = new Uint8Array(unpackSize);
  let inPos = 0, outPos = 0;
  // Current LZMA properties
  let lc = 3, lp = 0, pb = 2, dictSize = 1 << 23;

  while (inPos < buf.length) {
    const control = buf[inPos++];
    if (control === 0x00) break; // end marker

    if (control <= 0x02) {
      // Uncompressed chunk: 0x01 = reset dict, 0x02 = no reset
      const size = ((buf[inPos] << 8) | buf[inPos+1]) + 1; inPos += 2;
      out.set(buf.subarray(inPos, inPos + size), outPos);
      inPos += size; outPos += size;
      continue;
    }

    if (control < 0x80) throw new Error(`Bad LZMA2 control: 0x${control.toString(16)}`);

    // LZMA chunk
    // Bits [4:0] of control = bits [20:16] of uncompressed size - 1
    const unpackHi = control & 0x1F;
    const unpackSize2 = (((unpackHi << 8) | buf[inPos++]) << 8 | buf[inPos++]) + 1;
    const packSize = ((buf[inPos] << 8) | buf[inPos+1]) + 1; inPos += 2;

    // Reset flags: bits [6:5] of control
    const resetFlags = (control >> 5) & 0x3;
    // 0 = nothing, 1 = state reset, 2 = state+props reset, 3 = state+props+dict reset

    if (resetFlags >= 2) {
      // Read new properties byte
      const propsByte = buf[inPos++];
      // Decode: pb = propsByte / 45, remainder / 9 = lp, remainder % 9 = lc
      pb = Math.floor(propsByte / 45);
      const rem = propsByte % 45;
      lp = Math.floor(rem / 9);
      lc = rem % 9;
      if (lc + lp > 4) throw new Error(`Bad LZMA props: lc=${lc} lp=${lp}`);
    }

    const chunk = buf.subarray(inPos, inPos + packSize);
    inPos += packSize;

    const decoded = decodeLZMAStream(chunk, 0, unpackSize2, lc, lp, pb, dictSize);
    out.set(decoded, outPos);
    outPos += unpackSize2;
  }
  return out.subarray(0, outPos);
}

// ---- XZ container parser ----
const XZ_MAGIC = [0xFD, 0x37, 0x7A, 0x58, 0x5A, 0x00];

export function decodeXZ(buf) {
  for (let i = 0; i < 6; i++)
    if (buf[i] !== XZ_MAGIC[i]) throw new Error('Not an XZ file');

  // Stream header: 12 bytes (magic[6] + stream flags[2] + CRC32[4])
  let pos = 12;

  // Block header
  const blockHeaderSizeByte = buf[pos];
  const blockHeaderSize = (blockHeaderSizeByte + 1) * 4;
  const blockHeaderEnd = pos + blockHeaderSize;
  pos++;

  const blockFlags = buf[pos++];
  const numFilters = (blockFlags & 0x03) + 1;

  // Optional sizes
  let uncompressedSize = -1;
  if (blockFlags & 0x40) { // has compressed size
    const r = new BitReader(buf); r.pos = pos;
    r.readUint64LE(); pos = r.pos; // skip it
  }
  if (blockFlags & 0x80) { // has uncompressed size
    const r = new BitReader(buf); r.pos = pos;
    uncompressedSize = r.readUint64LE(); pos = r.pos;
  }

  // Filter flags: filter ID (varint) + size + props
  // For LZMA2: filter ID = 0x21, props size = 1
  let filterId = buf[pos++];
  // Handle multibyte varint (filter IDs > 0x7F would need this, but 0x21 is fine)
  const propsSize = buf[pos++];
  // dict size prop (we use it only to pick dictSize)
  const dictProp = buf[pos++];

  // Skip to block data (past header padding + CRC32)
  pos = blockHeaderEnd;

  // Find end of compressed data: XZ stream footer is last 12 bytes
  // Index starts at (stream_end - 12 - index_size)
  const footerPos = buf.length - 12;
  const backwardSize = ((buf[footerPos+4]) | (buf[footerPos+5]<<8) | (buf[footerPos+6]<<16) | (buf[footerPos+7]<<24)) >>> 0;
  const indexSize = (backwardSize + 1) * 4;
  const dataEnd = buf.length - 12 - indexSize;

  const compressedData = buf.subarray(pos, dataEnd);

  if (uncompressedSize === -1) {
    // Estimate: subtitles compress very well, 20x is safe
    uncompressedSize = compressedData.length * 20;
  }

  return decodeLZMA2(compressedData, uncompressedSize);
}
