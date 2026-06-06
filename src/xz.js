// Pure JS XZ decoder - handles the .xz container + LZMA2 decompression
// Based on the XZ file format spec and LZMA2 algorithm

// ---- Bit reader ----
class BitReader {
  constructor(buf) {
    this.buf = buf;
    this.pos = 0;
    this.bitBuf = 0;
    this.bitLen = 0;
  }
  readByte() {
    if (this.pos >= this.buf.length) throw new Error('Unexpected end of input');
    return this.buf[this.pos++];
  }
  readUint16LE() {
    const a = this.readByte(), b = this.readByte();
    return a | (b << 8);
  }
  readUint32LE() {
    const a = this.readByte(), b = this.readByte(), c = this.readByte(), d = this.readByte();
    return (a | (b << 8) | (c << 16) | (d << 24)) >>> 0;
  }
  readUint32BE() {
    const a = this.readByte(), b = this.readByte(), c = this.readByte(), d = this.readByte();
    return ((a << 24) | (b << 16) | (c << 8) | d) >>> 0;
  }
  readUint64LE() {
    // JS can't represent full uint64; for file sizes of subtitles this is fine
    const lo = this.readUint32LE();
    const hi = this.readUint32LE();
    if (hi > 0x1FFFFF) throw new Error('File too large for JS number');
    return hi * 0x100000000 + lo;
  }
  slice(len) {
    const s = this.buf.slice(this.pos, this.pos + len);
    this.pos += len;
    return s;
  }
  remaining() {
    return this.buf.length - this.pos;
  }
}

// ---- CRC32 ----
const crc32Table = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let j = 0; j < 8; j++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    t[i] = c;
  }
  return t;
})();

function crc32(buf, start = 0, end = buf.length) {
  let c = 0xFFFFFFFF;
  for (let i = start; i < end; i++) c = crc32Table[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}

// ---- LZMA2 decoder ----
// Range decoder
class RangeDecoder {
  constructor(buf, pos) {
    this.buf = buf;
    this.pos = pos;
    this.range = 0xFFFFFFFF;
    this.code = 0;
    // init: read 5 bytes
    this.pos++; // first byte ignored
    for (let i = 0; i < 4; i++) this.code = ((this.code << 8) | buf[this.pos++]) >>> 0;
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
    const bound = (((this.range >>> 11) >>> 0) * prob) >>> 0;
    if ((this.code >>> 0) < bound) {
      this.range = bound;
      probs[idx] += (2048 - prob) >> 5;
      return 0;
    } else {
      this.range = (this.range - bound) >>> 0;
      this.code = (this.code - bound) >>> 0;
      probs[idx] -= prob >> 5;
      return 1;
    }
  }
  decodeBitTree(probs, offset, numBits) {
    let m = 1;
    for (let i = 0; i < numBits; i++) m = (m << 1) | this.decodeBit(probs, offset + m);
    return m - (1 << numBits);
  }
  decodeReverseBitTree(probs, offset, numBits) {
    let m = 1, symbol = 0;
    for (let i = 0; i < numBits; i++) {
      const bit = this.decodeBit(probs, offset + m);
      m = (m << 1) | bit;
      symbol |= bit << i;
    }
    return symbol;
  }
  decodeDirectBits(numBits) {
    let result = 0;
    for (let i = 0; i < numBits; i++) {
      this.normalize();
      this.range = (this.range >>> 1) >>> 0;
      const t = (((this.code - this.range) >>> 0) >> 31);
      this.code = (this.code - (this.range & (t - 1))) >>> 0;
      result = (result << 1) | (1 - t);
    }
    return result;
  }
}

const LZMA_PROB_INIT = 1024;
function makeProbs(n) { return new Uint16Array(n).fill(LZMA_PROB_INIT); }

function decodeLZMA(buf, startPos, unpackSize) {
  // Read LZMA properties
  const props = buf[startPos];
  const lc = props % 9, rem = (props / 9) | 0;
  const lp = rem % 5, pb = (rem / 5) | 0;
  if (lc + lp > 4) throw new Error('Bad LZMA props');
  const dictSize = Math.max(
    ((buf[startPos+1] | (buf[startPos+2]<<8) | (buf[startPos+3]<<16) | (buf[startPos+4]<<24)) >>> 0),
    4096
  );

  const rd = new RangeDecoder(buf, startPos + 5);
  const out = new Uint8Array(unpackSize);
  let outPos = 0;

  const numStates = 12;
  const litProbs = makeProbs(0x300 << (lc + lp));
  const isMatch = makeProbs(numStates << 4);
  const isRep = makeProbs(numStates);
  const isRepG0 = makeProbs(numStates);
  const isRepG1 = makeProbs(numStates);
  const isRepG2 = makeProbs(numStates);
  const isRep0Long = makeProbs(numStates << 4);
  const posSlotDecoder = [makeProbs(64), makeProbs(64), makeProbs(64), makeProbs(64)];
  const posDecoders = makeProbs(114);
  const alignDecoder = makeProbs(16);
  const lenDecoder = { choice: makeProbs(1), choice2: makeProbs(1), low: makeProbs(4*8), mid: makeProbs(4*8), high: makeProbs(256) };
  const repLenDecoder = { choice: makeProbs(1), choice2: makeProbs(1), low: makeProbs(4*8), mid: makeProbs(4*8), high: makeProbs(256) };

  function decodeLen(ld, posState) {
    if (rd.decodeBit(ld.choice, 0) === 0) return rd.decodeBitTree(ld.low, posState << 3, 3);
    if (rd.decodeBit(ld.choice2, 0) === 0) return 8 + rd.decodeBitTree(ld.mid, posState << 3, 3);
    return 16 + rd.decodeBitTree(ld.high, 0, 8);
  }

  let state = 0, rep0 = 1, rep1 = 1, rep2 = 1, rep3 = 1;
  const dict = new Uint8Array(dictSize);
  let dictPos = 0;

  function dictByte(dist) {
    let p = dictPos - 1 - dist;
    if (p < 0) p += dictSize;
    return dict[p];
  }

  while (outPos < unpackSize) {
    const posState = outPos & ((1 << pb) - 1);
    if (rd.decodeBit(isMatch, (state << 4) | posState) === 0) {
      // Literal
      const litState = ((outPos & ((1 << lp) - 1)) << lc) | ((outPos > 0 ? out[outPos-1] : 0) >> (8 - lc));
      let prob = litState * 0x300;
      let sym = 1;
      if (state >= 7) {
        const matchByte = dictByte(rep0);
        let offset = 0x100;
        do {
          const matchBit = (matchByte >> (7 - (31 - Math.clz32(sym)))) & 1;
          const bit = rd.decodeBit(litProbs, prob + offset + (matchBit << 8) + sym);
          sym = (sym << 1) | bit;
          if (matchBit !== bit) offset = 0;
        } while (sym < 0x100);
      } else {
        do { sym = (sym << 1) | rd.decodeBit(litProbs, prob + sym); } while (sym < 0x100);
      }
      const byte = sym & 0xFF;
      out[outPos++] = byte;
      dict[dictPos++ % dictSize] = byte;
      state = state < 4 ? 0 : state < 10 ? state - 3 : state - 6;
    } else {
      let len;
      if (rd.decodeBit(isRep, state) === 1) {
        if (rd.decodeBit(isRepG0, state) === 0) {
          if (rd.decodeBit(isRep0Long, (state << 4) | posState) === 0) {
            const byte = dictByte(rep0);
            out[outPos++] = byte;
            dict[dictPos++ % dictSize] = byte;
            state = state < 7 ? 9 : 11;
            continue;
          }
        } else {
          let dist;
          if (rd.decodeBit(isRepG1, state) === 0) { dist = rep1; }
          else { if (rd.decodeBit(isRepG2, state) === 0) { dist = rep2; } else { dist = rep3; rep3 = rep2; } rep2 = rep1; }
          rep1 = rep0; rep0 = dist;
        }
        len = 2 + decodeLen(repLenDecoder, posState);
        state = state < 7 ? 8 : 11;
      } else {
        rep3 = rep2; rep2 = rep1; rep1 = rep0;
        len = 2 + decodeLen(lenDecoder, posState);
        state = state < 7 ? 7 : 10;
        const posSlot = rd.decodeBitTree(posSlotDecoder[Math.min(len - 2, 3)], 0, 6);
        if (posSlot >= 4) {
          const numDirectBits = (posSlot >> 1) - 1;
          rep0 = (2 | (posSlot & 1)) << numDirectBits;
          if (posSlot < 14) {
            rep0 += rd.decodeReverseBitTree(posDecoders, rep0 - posSlot - 1, numDirectBits);
          } else {
            rep0 += rd.decodeDirectBits(numDirectBits - 4) << 4;
            rep0 += rd.decodeReverseBitTree(alignDecoder, 0, 4);
          }
        } else { rep0 = posSlot; }
      }
      if (rep0 >= outPos && outPos < dictSize) throw new Error('Rep0 out of range');
      for (let i = 0; i < len && outPos < unpackSize; i++) {
        const byte = dictByte(rep0);
        out[outPos++] = byte;
        dict[dictPos++ % dictSize] = byte;
      }
    }
  }
  return out;
}

// ---- LZMA2 chunk decoder ----
function decodeLZMA2(buf, unpackSize) {
  const out = new Uint8Array(unpackSize);
  let inPos = 0, outPos = 0;
  let lzmaProps = 0;

  while (inPos < buf.length) {
    const control = buf[inPos++];
    if (control === 0x00) break; // end of LZMA2 stream
    if (control === 0x01 || control === 0x02) {
      // Uncompressed chunk
      const size = ((buf[inPos] << 8) | buf[inPos+1]) + 1; inPos += 2;
      if (control === 0x01) {
        // reset dict - nothing to do in this simple impl
      }
      out.set(buf.subarray(inPos, inPos + size), outPos);
      inPos += size; outPos += size;
      continue;
    }
    if (control < 0x80) throw new Error(`Bad LZMA2 control byte: 0x${control.toString(16)}`);
    // LZMA chunk
    const unpackHi = (control & 0x1F);
    const unpackLo = buf[inPos++];
    const chunkUnpack = ((unpackHi << 8) | unpackLo) + 1;
    const packHi = buf[inPos++];
    const packLo = buf[inPos++];
    const chunkPack = ((packHi << 8) | packLo) + 1;
    const resetState = (control >> 5) & 0x03;
    if (resetState === 3) {
      lzmaProps = buf[inPos++];
    } else if (resetState === 2) {
      inPos++; // skip props (reuse)
    }
    const chunk = buf.subarray(inPos, inPos + chunkPack);
    inPos += chunkPack;
    // Build a proper LZMA stream: props(5) + chunk data
    // We already have props byte; need to build the 5-byte props header
    const lzmaStream = new Uint8Array(5 + chunk.length);
    lzmaStream[0] = lzmaProps;
    // dict size = 8MB (safe default for LZMA2)
    const ds = 1 << 23;
    lzmaStream[1] = ds & 0xFF;
    lzmaStream[2] = (ds >> 8) & 0xFF;
    lzmaStream[3] = (ds >> 16) & 0xFF;
    lzmaStream[4] = (ds >> 24) & 0xFF;
    lzmaStream.set(chunk, 5);
    const decoded = decodeLZMA(lzmaStream, 0, chunkUnpack);
    out.set(decoded, outPos);
    outPos += chunkUnpack;
  }
  return out.subarray(0, outPos);
}

// ---- XZ container parser ----
const XZ_MAGIC = [0xFD, 0x37, 0x7A, 0x58, 0x5A, 0x00];

export function decodeXZ(buf) {
  // Validate stream header magic
  for (let i = 0; i < 6; i++) {
    if (buf[i] !== XZ_MAGIC[i]) throw new Error('Not an XZ file');
  }
  const r = new BitReader(buf);
  // Skip stream header (12 bytes)
  r.pos = 12;

  // Parse block header
  const blockHeaderSizeByte = r.readByte();
  if (blockHeaderSizeByte === 0) throw new Error('Index record instead of block');
  const blockHeaderSize = (blockHeaderSizeByte + 1) * 4;
  const blockHeaderStart = r.pos - 1;

  const blockFlags = r.readByte();
  const numFilters = (blockFlags & 0x03) + 1;
  if (numFilters !== 1) throw new Error('Only single-filter XZ supported');

  // Compressed/uncompressed size fields (optional)
  let compressedSize = -1, uncompressedSize = -1;
  if (blockFlags & 0x40) compressedSize = r.readUint64LE();
  if (blockFlags & 0x80) uncompressedSize = r.readUint64LE();

  // Filter: must be LZMA2 (filter ID 0x21)
  const filterId = r.readByte();
  if (filterId !== 0x21) throw new Error(`Unsupported filter ID: 0x${filterId.toString(16)}`);
  const filterPropsSize = r.readByte(); // should be 1
  const dictSizeProp = r.readByte();

  // Skip to end of block header (pad + CRC32)
  r.pos = blockHeaderStart + blockHeaderSize;

  // The rest (until index) is the compressed LZMA2 data
  // Find the index: scan backwards from end for stream footer
  // Stream footer is last 12 bytes: CRC32(4) + backward_size(4) + flags(2) + magic(2)
  const footerMagic = [0x59, 0x5A];
  const footerEnd = buf.length;
  // Footer starts at buf.length - 12
  const footerPos = footerEnd - 12;
  const backwardSize = (buf[footerPos + 4] | (buf[footerPos+5]<<8) | (buf[footerPos+6]<<16) | (buf[footerPos+7]<<24)) >>> 0;
  const indexSize = (backwardSize + 1) * 4;
  const indexPos = footerEnd - 12 - indexSize;

  // Compressed data is from r.pos to indexPos
  const compressedData = buf.subarray(r.pos, indexPos);

  if (uncompressedSize === -1) {
    // No uncompressed size stored; use a generous estimate (16x for subtitles)
    uncompressedSize = compressedData.length * 16;
  }

  return decodeLZMA2(compressedData, uncompressedSize);
}
