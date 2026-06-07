const ByteOrder = {
  LITTLE_ENDIAN: 'littleEndian',
  BIG_ENDIAN: 'bigEndian'
};

class InputMemoryStream {
  constructor(bytes, { byteOrder = ByteOrder.LITTLE_ENDIAN, offset = 0, length = null } = {}) {
    const data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    if (length === null) {
      length = data.length - offset;
    }
    if (offset + length > data.length) {
      length = data.length - offset;
    }

    this.byteOrder = byteOrder;
    this.buffer = new Uint8Array(data.buffer, data.byteOffset + offset, length);
    this._position = 0;
    this._length = this.buffer.length;
  }

  get position() {
    return this._position;
  }

  set position(v) {
    this._position = v;
  }

  get length() {
    return this._length - this._position;
  }

  get isEOS() {
    return this._position >= this._length;
  }

  reset() {
    this._position = 0;
  }

  rewind(length = 1) {
    this._position = Math.max(0, this._position - length);
  }

  skip(count) {
    this._position = Math.min(this._position + count, this._length);
  }

  peekBytes(count, offset = 0) {
    return this.subset({ position: this._position + offset, length: count });
  }

  subset({ position = null, length = null } = {}) {
    if (!this.buffer) return InputMemoryStream.empty();

    const pos = position !== null ? position : this._position;
    const len = length !== null ? length : this._length - pos;

    return new InputMemoryStream(this.buffer, {
      byteOrder: this.byteOrder,
      offset: pos,
      length: len
    });
  }

  readByte() {
    return this.buffer[this._position++];
  }

  readUint32() {
    const b1 = this.readByte();
    const b2 = this.readByte();
    const b3 = this.readByte();
    const b4 = this.readByte();
    return this.byteOrder === ByteOrder.BIG_ENDIAN
      ? (b1 << 24) | (b2 << 16) | (b3 << 8) | b4
      : (b4 << 24) | (b3 << 16) | (b2 << 8) | b1;
  }

  readUint64() {
    if (this.byteOrder === ByteOrder.BIG_ENDIAN) {
      const high = this.readUint32();
      const low = this.readUint32();
      return high * 0x100000000 + low;
    } else {
      const low = this.readUint32();
      const high = this.readUint32();
      return high * 0x100000000 + low;
    }
  }

  readBytes(count) {
    const s = this.subset({ position: this._position, length: count });
    this._position += s.length;
    return s;
  }

  toUint8Array() {
    if (!this.buffer) return new Uint8Array(0);
    const len = this._length - this._position;
    return new Uint8Array(this.buffer.buffer, this.buffer.byteOffset + this._position, len);
  }
}

class OutputMemoryStream {
  static DEFAULT_BUFFER_SIZE = 0x8000;

  constructor({ size = OutputMemoryStream.DEFAULT_BUFFER_SIZE, byteOrder = ByteOrder.LITTLE_ENDIAN } = {}) {
    this.byteOrder = byteOrder;
    this._buffer = new Uint8Array(size);
    this._length = 0;
  }

  get length() {
    return this._length;
  }

  writeBytes(bytes, length = null) {
    const byteArray = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    const count = length !== null ? length : byteArray.length;

    while (this._length + count > this._buffer.length) {
      this.#expandBuffer(this._length + count - this._buffer.length);
    }

    this._buffer.set(byteArray.subarray(0, count), this._length);
    this._length += count;
  }

  getBytes() {
    return this._buffer.slice(0, this._length);
  }


  #expandBuffer(required = null) {
    let blockSize = OutputMemoryStream.DEFAULT_BUFFER_SIZE;
    if (required !== null && required > blockSize) {
      blockSize = required;
    }
    const newLength = (this._buffer.length + blockSize) * 2;
    const newBuffer = new Uint8Array(newLength);
    newBuffer.set(this._buffer);
    this._buffer = newBuffer;
  }
}


class RangeDecoderTable {
  constructor(length) {
    this.table = new Uint16Array(length);
    this.reset();
  }
  reset() {
    this.table.fill(1024);
  }
}

class LzmaDecoder {
  constructor() {
    const LengthDecoder = (input, positionCount) => {
      const formTable = new RangeDecoderTable(2);
      const shortTables = [];
      const mediumTables = [];
      const longTable = new RangeDecoderTable(256);

      const reset = (count = positionCount) => {
        formTable.reset();
        if (count !== shortTables.length) {
          shortTables.length = 0;
          mediumTables.length = 0;
          for (let i = 0; i < count; i++) {
            shortTables.push(new RangeDecoderTable(8));
            mediumTables.push(new RangeDecoderTable(8));
          }
        } else {
          shortTables.forEach(t => t.reset());
          mediumTables.forEach(t => t.reset());
        }
        longTable.reset();
      };

      const readLength = (posState) => {
        if (input.readBit(formTable, 0) === 0) {
          return 2 + input.readBittree(shortTables[posState], 3);
        } else if (input.readBit(formTable, 1) === 0) {
          return 10 + input.readBittree(mediumTables[posState], 3);
        } else {
          return 18 + input.readBittree(longTable, 8);
        }
      };

      reset(positionCount); // initialize

      return { reset, readLength };
    };

    const DistanceDecoder = (input) => {
      const slotBitCount = 6;
      const alignBitCount = 4;
      const slotSize = 1 << slotBitCount;

      const slotTables = Array.from({ length: 4 }, () => new RangeDecoderTable(slotSize));
      const shortTables = [];
      for (let slot = 4; slot < 14; slot++) {
        shortTables.push(new RangeDecoderTable(1 << ((slot >> 1) - 1)));
      }
      const longTable = new RangeDecoderTable(1 << alignBitCount);

      const reset = () => {
        slotTables.forEach(t => t.reset());
        shortTables.forEach(t => t.reset());
        longTable.reset();
      };

      const readDistance = (length) => {
        let distState = length - 2;
        if (distState >= slotTables.length) distState = slotTables.length - 1;

        const slot = input.readBittree(slotTables[distState], slotBitCount);
        if (slot < 4) return slot;

        const prefix = 0x2 | (slot & 1);
        const bitCount = (slot >> 1) - 1;

        if (slot < 14) {
          return (prefix << bitCount) | input.readBittreeReverse(shortTables[slot - 4], bitCount);
        }

        const directCount = bitCount - alignBitCount;
        const directBits = input.readDirect(directCount);
        const alignBits = input.readBittreeReverse(longTable, alignBitCount);

        return ((prefix << bitCount) | (directBits << alignBitCount) | alignBits) >>> 0;
      };

      return { reset, readDistance };
    };

    const RangeDecoder = () => {
      let range = 0xffffffff;
      let code = 0;
      let input = null;

      const setInput = (stream) => {
        input = stream;
      };

      const reset = () => {
        range = 0xffffffff;
        code = 0;
      };

      const initialize = () => {
        code = 0;
        range = 0xffffffff;
        input.skip(1);
        for (let i = 0; i < 4; i++) {
          code = ((code << 8) | input.readByte()) >>> 0;
        }
      };

      const readBit = (table, index) => {
        load();
        const p = table.table[index];
        const bound = (range >>> 11) * p;
        const moveBits = 5;
        if (code < bound) {
          range = bound >>> 0;
          table.table[index] += ((2048 - p) >>> moveBits);
          return 0;
        } else {
          range = (range - bound) >>> 0;
          code = (code - bound) >>> 0;
          table.table[index] -= p >>> moveBits;
          return 1;
        }
      };

      const readBittree = (table, count) => {
        let value = 0;
        let symbolPrefix = 1;
        for (let i = 0; i < count; i++) {
          const b = readBit(table, symbolPrefix | value);
          value = ((value << 1) | b) >>> 0;
          symbolPrefix = (symbolPrefix << 1) >>> 0;
        }
        return value;
      };

      const readBittreeReverse = (table, count) => {
        let value = 0;
        let symbolPrefix = 1;
        for (let i = 0; i < count; i++) {
          const b = readBit(table, symbolPrefix | value);
          value = (value | (b << i)) >>> 0;
          symbolPrefix = (symbolPrefix << 1) >>> 0;
        }
        return value;
      };

      const readDirect = (count) => {
        let value = 0;
        for (let i = 0; i < count; i++) {
          load();
          range >>>= 1;
          code -= range;
          value <<= 1;
          if ((code & 0x80000000) !== 0) {
            code += range;
          } else {
            value++;
          }
        }
        return value;
      };

      const load = () => {
        const topValue = 1 << 24;
        if (range < topValue) {
          range = (range << 8) >>> 0;
          code = ((code << 8) | input.readByte()) >>> 0;
        }
      };

      return {
        set input(value) { setInput(value); },
        get input() { return input; },
        reset,
        initialize,
        readBit,
        readBittree,
        readBittreeReverse,
        readDirect
      };
    };

    this._rc = RangeDecoder();
    this._positionBits = 2;
    this._literalPositionBits = 0;
    this._literalContextBits = 3;
    this._nonLiteralTables = Array.from({ length: 12 }, (_, i) => i).map(() => new RangeDecoderTable(12));
    this._repeatTable = new RangeDecoderTable(12);
    this._repeat0Table = new RangeDecoderTable(12);
    this._longRepeat0Tables = Array.from({ length: 12 }, (_, i) => i).map(() => new RangeDecoderTable(12));
    this._repeat1Table = new RangeDecoderTable(12);
    this._repeat2Table = new RangeDecoderTable(12);
    this._literalTables = [];
    this._matchLiteralTables0 = [];
    this._matchLiteralTables1 = [];
    this._matchLengthDecoder = LengthDecoder(this._rc, 1 << this._positionBits);
    this._repeatLengthDecoder = LengthDecoder(this._rc, 1 << this._positionBits);
    this._distanceDecoder = DistanceDecoder(this._rc);
    this._dictionary = new Uint8Array(0);
    this._writePosition = 0;
    this.state = 0;
    this._distance0 = this._distance1 = this._distance2 = this._distance3 = 0;
    this.reset();
  }

  reset({ positionBits, literalPositionBits, literalContextBits, resetDictionary = false } = {}) {
    this._positionBits = positionBits ?? this._positionBits;
    this._literalPositionBits = literalPositionBits ?? this._literalPositionBits;
    this._literalContextBits = literalContextBits ?? this._literalContextBits;
    this.state = 0;
    this._distance0 = this._distance1 = this._distance2 = this._distance3 = 0;
    const maxLiteralStates = 1 << (this._literalPositionBits + this._literalContextBits);
    while (this._literalTables.length < maxLiteralStates) {
      this._literalTables.push(new RangeDecoderTable(256));
      this._matchLiteralTables0.push(new RangeDecoderTable(256));
      this._matchLiteralTables1.push(new RangeDecoderTable(256));
    }
    [...this._nonLiteralTables, this._repeatTable, this._repeat0Table, ...this._longRepeat0Tables, this._repeat1Table, this._repeat2Table, ...this._literalTables, ...this._matchLiteralTables0, ...this._matchLiteralTables1].forEach(t => t.reset());
    const positionCount = 1 << this._positionBits;
    this._matchLengthDecoder.reset(positionCount);
    this._repeatLengthDecoder.reset(positionCount);
    this._distanceDecoder.reset();
    if (resetDictionary) {
      this._dictionary = new Uint8Array(0);
      this._writePosition = 0;
    }
  }

  decode(input, uncompressedLength) {
    this._rc.input = input;
    this._rc.initialize();
    const initialSize = this._dictionary.length;
    const finalSize = initialSize + uncompressedLength;
    const newDict = new Uint8Array(finalSize);
    newDict.set(this._dictionary);
    this._dictionary = newDict;
    while (this._writePosition < finalSize) {
      const posState = this._writePosition & ((1 << this._positionBits) - 1);
      if (this._rc.readBit(this._nonLiteralTables[this.state], posState) === 0) {
        this.#decodeLiteral();
      } else if (this._rc.readBit(this._repeatTable, this.state) === 0) {
        this.#decodeMatch(posState);
      } else {
        this.#decoderepeat(posState);
      }
    }
    return this._dictionary.slice(initialSize);
  }

  #prevPacketIsLiteral() {
    return [0, 1, 2, 3, 4, 5, 6].includes(this.state);
  }

  #decodeLiteral() {
    let prevByte = this._writePosition > 0 ? this._dictionary[this._writePosition - 1] : 0;
    const low = prevByte >> (8 - this._literalContextBits);
    const high = (this._writePosition & ((1 << this._literalPositionBits) - 1)) << this._literalContextBits;
    const hash = low + high;
    const table = this._literalTables[hash];
    let value;
    if (this.#prevPacketIsLiteral()) {
      value = this._rc.readBittree(table, 8);
    } else {
      prevByte = this._dictionary[this._writePosition - this._distance0 - 1];
      value = 0;
      let symbolPrefix = 1;
      let matched = true;
      const table0 = this._matchLiteralTables0[hash];
      const table1 = this._matchLiteralTables1[hash];
      for (let i = 0; i < 8; i++) {
        let b;
        if (matched) {
          const matchBit = (prevByte >> 7) & 1;
          prevByte = (prevByte << 1) & 0xff;
          b = this._rc.readBit(matchBit === 0 ? table0 : table1, symbolPrefix | value);
          matched = b === matchBit;
        } else {
          b = this._rc.readBit(table, symbolPrefix | value);
        }
        value = (value << 1) | b;
        symbolPrefix <<= 1;
      }
    }
    this._dictionary[this._writePosition++] = value;
    const transitions = {
      0: 0, 1: 0, 2: 0, 3: 0,
      4: 1, 5: 2, 6: 3,
      7: 4, 8: 5, 9: 6,
      10: 4, 11: 5
    };
    this.state = transitions[this.state];
  }

  #decodeMatch(posState) {
    const length = this._matchLengthDecoder.readLength(posState);
    const distance = this._distanceDecoder.readDistance(length);
    this.#repeatData(distance, length);
    [this._distance3, this._distance2, this._distance1, this._distance0] = [this._distance2, this._distance1, this._distance0, distance];
    this.state = this.#prevPacketIsLiteral() ? 7 : 10;
  }

  #decoderepeat(posState) {
    let distance;
    if (this._rc.readBit(this._repeat0Table, this.state) === 0) {
      if (this._rc.readBit(this._longRepeat0Tables[this.state], posState) === 0) {
        this.#repeatData(this._distance0, 1);
        this.state = this.#prevPacketIsLiteral() ? 9 : 11;
        return;
      } else {
        distance = this._distance0;
      }
    } else if (this._rc.readBit(this._repeat1Table, this.state) === 0) {
      distance = this._distance1;
      [this._distance1, this._distance0] = [this._distance0, distance];
    } else if (this._rc.readBit(this._repeat2Table, this.state) === 0) {
      distance = this._distance2;
      [this._distance2, this._distance1, this._distance0] = [this._distance1, this._distance0, distance];
    } else {
      distance = this._distance3;
      [this._distance3, this._distance2, this._distance1, this._distance0] = [this._distance2, this._distance1, this._distance0, distance];
    }
    const length = this._repeatLengthDecoder.readLength(posState);
    this.#repeatData(distance, length);
    this.state = this.#prevPacketIsLiteral() ? 8 : 11;
  }

  #repeatData(distance, length) {
    const start = this._writePosition - distance - 1;
    for (let i = 0; i < length; i++) {
      if (start + i < 0 || this._writePosition >= this._dictionary.length) break;
      this._dictionary[this._writePosition++] = this._dictionary[start + i];
    }
  }
}

export class XZDecoder {
  #decoder = new LzmaDecoder();
  #streamFlags = 0;
  #blockSizes = [];

  // Precomputed CRC table for faster calculations.
  #crc32Table = [
    0,
    1996959894,
    3993919788,
    2567524794,
    124634137,
    1886057615,
    3915621685,
    2657392035,
    249268274,
    2044508324,
    3772115230,
    2547177864,
    162941995,
    2125561021,
    3887607047,
    2428444049,
    498536548,
    1789927666,
    4089016648,
    2227061214,
    450548861,
    1843258603,
    4107580753,
    2211677639,
    325883990,
    1684777152,
    4251122042,
    2321926636,
    335633487,
    1661365465,
    4195302755,
    2366115317,
    997073096,
    1281953886,
    3579855332,
    2724688242,
    1006888145,
    1258607687,
    3524101629,
    2768942443,
    901097722,
    1119000684,
    3686517206,
    2898065728,
    853044451,
    1172266101,
    3705015759,
    2882616665,
    651767980,
    1373503546,
    3369554304,
    3218104598,
    565507253,
    1454621731,
    3485111705,
    3099436303,
    671266974,
    1594198024,
    3322730930,
    2970347812,
    795835527,
    1483230225,
    3244367275,
    3060149565,
    1994146192,
    31158534,
    2563907772,
    4023717930,
    1907459465,
    112637215,
    2680153253,
    3904427059,
    2013776290,
    251722036,
    2517215374,
    3775830040,
    2137656763,
    141376813,
    2439277719,
    3865271297,
    1802195444,
    476864866,
    2238001368,
    4066508878,
    1812370925,
    453092731,
    2181625025,
    4111451223,
    1706088902,
    314042704,
    2344532202,
    4240017532,
    1658658271,
    366619977,
    2362670323,
    4224994405,
    1303535960,
    984961486,
    2747007092,
    3569037538,
    1256170817,
    1037604311,
    2765210733,
    3554079995,
    1131014506,
    879679996,
    2909243462,
    3663771856,
    1141124467,
    855842277,
    2852801631,
    3708648649,
    1342533948,
    654459306,
    3188396048,
    3373015174,
    1466479909,
    544179635,
    3110523913,
    3462522015,
    1591671054,
    702138776,
    2966460450,
    3352799412,
    1504918807,
    783551873,
    3082640443,
    3233442989,
    3988292384,
    2596254646,
    62317068,
    1957810842,
    3939845945,
    2647816111,
    81470997,
    1943803523,
    3814918930,
    2489596804,
    225274430,
    2053790376,
    3826175755,
    2466906013,
    167816743,
    2097651377,
    4027552580,
    2265490386,
    503444072,
    1762050814,
    4150417245,
    2154129355,
    426522225,
    1852507879,
    4275313526,
    2312317920,
    282753626,
    1742555852,
    4189708143,
    2394877945,
    397917763,
    1622183637,
    3604390888,
    2714866558,
    953729732,
    1340076626,
    3518719985,
    2797360999,
    1068828381,
    1219638859,
    3624741850,
    2936675148,
    906185462,
    1090812512,
    3747672003,
    2825379669,
    829329135,
    1181335161,
    3412177804,
    3160834842,
    628085408,
    1382605366,
    3423369109,
    3138078467,
    570562233,
    1426400815,
    3317316542,
    2998733608,
    733239954,
    1555261956,
    3268935591,
    3050360625,
    752459403,
    1541320221,
    2607071920,
    3965973030,
    1969922972,
    40735498,
    2617837225,
    3943577151,
    1913087877,
    83908371,
    2512341634,
    3803740692,
    2075208622,
    213261112,
    2463272603,
    3855990285,
    2094854071,
    198958881,
    2262029012,
    4057260610,
    1759359992,
    534414190,
    2176718541,
    4139329115,
    1873836001,
    414664567,
    2282248934,
    4279200368,
    1711684554,
    285281116,
    2405801727,
    4167216745,
    1634467795,
    376229701,
    2685067896,
    3608007406,
    1308918612,
    956543938,
    2808555105,
    3495958263,
    1231636301,
    1047427035,
    2932959818,
    3654703836,
    1088359270,
    936918000,
    2847714899,
    3736837829,
    1202900863,
    817233897,
    3183342108,
    3401237130,
    1404277552,
    615818150,
    3134207493,
    3453421203,
    1423857449,
    601450431,
    3009837614,
    3294710456,
    1567103746,
    711928724,
    3020668471,
    3272380065,
    1510334235,
    755167117
  ];

  // Calcola il checksum CRC-32 di un array di byte.
  // Puoi passare un valore `crc` già calcolato per aggiornare.
  #getCrc32(array, crc = 0) {
    let len = array.length;
    crc = crc ^ 0xffffffff;
    let ip = 0;

    while (len >= 8) {
      crc = this.#crc32Table[(crc ^ array[ip++]) & 0xff] ^ (crc >>> 8);
      crc = this.#crc32Table[(crc ^ array[ip++]) & 0xff] ^ (crc >>> 8);
      crc = this.#crc32Table[(crc ^ array[ip++]) & 0xff] ^ (crc >>> 8);
      crc = this.#crc32Table[(crc ^ array[ip++]) & 0xff] ^ (crc >>> 8);
      crc = this.#crc32Table[(crc ^ array[ip++]) & 0xff] ^ (crc >>> 8);
      crc = this.#crc32Table[(crc ^ array[ip++]) & 0xff] ^ (crc >>> 8);
      crc = this.#crc32Table[(crc ^ array[ip++]) & 0xff] ^ (crc >>> 8);
      crc = this.#crc32Table[(crc ^ array[ip++]) & 0xff] ^ (crc >>> 8);
      len -= 8;
    }

    while (len-- > 0) {
      crc = this.#crc32Table[(crc ^ array[ip++]) & 0xff] ^ (crc >>> 8);
    }

    return crc ^ 0xffffffff;
  }

  decodeBytes(data) {
    this.#decoder = new LzmaDecoder();
    this.#streamFlags = 0;
    this.#blockSizes = [];

    const input = new InputMemoryStream(data);
    const output = new OutputMemoryStream();

    if (!this.#decode(input, output)) {
      throw new Error("Failed to decode XZ stream");
    }

    return output.getBytes();
  }

  #decode(input, output) {
    if (!this.#readStreamHeader(input)) return false;

    while (!input.isEOS) {
      const blockHeader = input.peekBytes(1).readByte();
      if (blockHeader === 0) {
        const indexSize = this.#readStreamIndex(input);
        if (indexSize < 0) return false;
        return this.#readStreamFooter(input, indexSize);
      }

      const blockLength = (blockHeader + 1) * 4;
      if (!this.#readBlock(input, output, blockLength)) return false;
    }

    return true;
  }

  #readStreamHeader(input) {
    const magic = input.readBytes(6).toUint8Array();
    const expected = [253, 55, 122, 88, 90, 0];
    if (!expected.every((v, i) => v === magic[i])) return false;

    const header = input.readBytes(2);
    if (header.readByte() !== 0) return false;
    this.#streamFlags = header.readByte();
    header.reset();

    const crc = input.readUint32();
    return this.#getCrc32(header.toUint8Array()) === crc;
  }

  #readBlock(input, output, headerLength) {
    const blockStart = input.position;
    const header = input.readBytes(headerLength - 4);
    header.skip(1);

    const blockFlags = header.readByte();
    const nFilters = (blockFlags & 0x3) + 1;
    const hasCompressedLength = (blockFlags & 0x40) !== 0;
    const hasUncompressedLength = (blockFlags & 0x80) !== 0;

    let compressedLength = null;
    if (hasCompressedLength) compressedLength = this.#readMBI(header);

    let uncompressedLength = null;
    if (hasUncompressedLength) uncompressedLength = this.#readMBI(header);

    const filters = [];

    for (let i = 0; i < nFilters; i++) {
      const id = this.#readMBI(header);
      const propLen = this.#readMBI(header);
      const props = header.readBytes(propLen).toUint8Array();
      if (id === 0x21) {
        const v = props[0];
        if (v > 40) return false;
      }
      filters.push(id);
    }

    if (this.#readPadding(header) < 0) return false;
    header.reset();

    const crc = input.readUint32();
    if (this.#getCrc32(header.toUint8Array()) !== crc) return false;
    if (filters.length !== 1 || filters[0] !== 0x21) return false;

    const start = input.position;
    const startOut = output.length;

    this.#readLZMA2(input, output);
    const actualCompressedLength = input.position - start;
    const actualUncompressedLength = output.length - startOut;

    if (compressedLength !== null && compressedLength !== actualCompressedLength) return false;
    if (uncompressedLength === null) uncompressedLength = actualUncompressedLength;
    if (uncompressedLength !== actualUncompressedLength) return false;

    const paddingSize = this.#readPadding(input);
    if (paddingSize < 0) return false;

    const checkType = this.#streamFlags & 0xf;
    switch (checkType) {
      case 0: break;
      case 0x1: input.readUint32(); break;
      case 0x2: case 0x3: input.skip(4); break;
      case 0x4: input.readUint64(); break;
      case 0x5: case 0x6: input.skip(8); break;
      case 0x7: case 0x8: case 0x9: input.skip(16); break;
      case 0xA: case 0xB: case 0xC: input.skip(32); break;
      case 0xD: case 0xE: case 0xF: input.skip(64); break;
      default: return false;
    }

    this.#blockSizes.push({
      unpaddedLength: input.position - blockStart - paddingSize,
      uncompressedLength,
    });
    return true;
  }

  #readLZMA2(input, output) {
    while (!input.isEOS) {
      const control = input.readByte();
      if ((control & 0x80) === 0) {
        if (control === 0) {
          this.#decoder.reset({ resetDictionary: true });
          return true;
        } else if (control === 1 || control === 2) {
          const len = ((input.readByte() << 8) | input.readByte()) + 1;
          const data = input.readBytes(len);
          output.writeBytes(control === 1
            ? data.toUint8Array()
            : this.#decoder.decodeUncompressed(data, len));
        } else {
          return false;
        }
      } else {
        const reset = (control >> 5) & 0x3;
        const ulen = (((control & 0x1f) << 16) | (input.readByte() << 8) | input.readByte()) + 1;
        const clen = ((input.readByte() << 8) | input.readByte()) + 1;

        let lc = null, lp = null, pb = null;
        if (reset >= 2) {
          const props = input.readByte();
          pb = Math.floor(props / 45);
          const rest = props - pb * 45;
          lp = Math.floor(rest / 9);
          lc = rest - lp * 9;
        }

        if (reset > 0) {
          this.#decoder.reset({
            literalContextBits: lc,
            literalPositionBits: lp,
            positionBits: pb,
            resetDictionary: reset === 3,
          });
        }

        const bytes = input.readBytes(clen);
        output.writeBytes(this.#decoder.decode(bytes, ulen));
      }
    }

    return true;
  }

  #readStreamIndex(input) {
    const start = input.position;
    input.skip(1);

    const nRecords = this.#readMBI(input);
    if (nRecords !== this.#blockSizes.length) return -1;

    for (let i = 0; i < nRecords; i++) {
      const unpadded = this.#readMBI(input);
      const uncompressed = this.#readMBI(input);
      const record = this.#blockSizes[i];
      if (record.unpaddedLength !== unpadded || record.uncompressedLength !== uncompressed) {
        return -1;
      }
    }

    if (this.#readPadding(input) < 0) return -1;

    const indexLen = input.position - start;
    input.rewind(indexLen);
    const bytes = input.readBytes(indexLen);
    const crc = input.readUint32();

    return this.#getCrc32(bytes.toUint8Array()) === crc ? indexLen + 4 : -1;
  }

  #readStreamFooter(input, indexSize) {
    const crc = input.readUint32();
    const footer = input.readBytes(6);
    const backSize = (footer.readUint32() + 1) * 4;
    if (backSize !== indexSize) return false;
    if (footer.readByte() !== 0) return false;
    const flags = footer.readByte();
    if (flags !== this.#streamFlags) return false;
    footer.reset();
    if (this.#getCrc32(footer.toUint8Array()) !== crc) return false;

    const magic = input.readBytes(2).toUint8Array();
    return magic[0] === 89 && magic[1] === 90;
  }

  #readMBI(input) {
    let value = 0, shift = 0;
    while (true) {
      const b = input.readByte();
      value |= (b & 0x7f) << shift;
      if ((b & 0x80) === 0) return value;
      shift += 7;
    }
  }

  #readPadding(input) {
    let count = 0;
    while (input.position % 4 !== 0) {
      if (input.readByte() !== 0) return -1;
      count++;
    }
    return count;
  }
}
