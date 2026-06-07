// Custom XZ decompressor compatible with Cloudflare Workers WASM bindings
const XZ_OK = 0;
const XZ_STREAM_END = 1;

class XzContext {
  constructor(moduleInstance) {
    this.exports = moduleInstance.exports;
    this.memory = this.exports.memory;
    this.ptr = this.exports.create_context();
    this._refresh();
    this.bufSize = this.mem32[0];
    this.inStart = this.mem32[1] - this.ptr;
    this.inEnd = this.inStart + this.bufSize;
    this.outStart = this.mem32[4] - this.ptr;
  }

  supplyInput(sourceDataUint8Array) {
    this._refresh();
    const inBuffer = this.mem8.subarray(this.inStart, this.inEnd);
    inBuffer.set(sourceDataUint8Array, 0);
    this.exports.supply_input(this.ptr, sourceDataUint8Array.byteLength);
    this._refresh();
  }

  getNextOutput() {
    const result = this.exports.get_next_output(this.ptr);
    this._refresh();
    if (result !== XZ_OK && result !== XZ_STREAM_END) {
      throw new Error(`get_next_output failed with error code ${result}`);
    }
    const outChunk = this.mem8.slice(this.outStart, this.outStart + this.mem32[5]);
    return { outChunk, finished: result === XZ_STREAM_END };
  }

  needsMoreInput() {
    return this.mem32[2] === this.mem32[3];
  }

  resetOutputBuffer() {
    this.mem32[5] = 0;
  }

  dispose() {
    this.exports.destroy_context(this.ptr);
    this.exports = null;
  }

  _refresh() {
    if (this.memory.buffer !== this.mem8?.buffer) {
      this.mem8 = new Uint8Array(this.memory.buffer, this.ptr);
      this.mem32 = new Uint32Array(this.memory.buffer, this.ptr);
    }
  }
}

export async function decompressXZ(compressedData, wasmModule) {
  // Instantiate the WASM module for Cloudflare Workers
  const instance = await WebAssembly.instantiate(wasmModule, {});
  
  const xzContext = new XzContext(instance);
  const outputChunks = [];
  let inputOffset = 0;

  try {
    while (true) {
      // Supply input if needed
      if (xzContext.needsMoreInput() && inputOffset < compressedData.length) {
        const nextInputLength = Math.min(xzContext.bufSize, compressedData.length - inputOffset);
        xzContext.supplyInput(compressedData.subarray(inputOffset, inputOffset + nextInputLength));
        inputOffset += nextInputLength;
      }

      // Get output
      const nextOutputResult = xzContext.getNextOutput();
      if (nextOutputResult.outChunk.length > 0) {
        outputChunks.push(nextOutputResult.outChunk);
      }
      xzContext.resetOutputBuffer();

      if (nextOutputResult.finished) {
        break;
      }
    }

    xzContext.dispose();

    // Combine all output chunks
    const totalSize = outputChunks.reduce((sum, chunk) => sum + chunk.length, 0);
    const result = new Uint8Array(totalSize);
    let offset = 0;
    for (const chunk of outputChunks) {
      result.set(chunk, offset);
      offset += chunk.length;
    }

    return result;
  } catch (error) {
    xzContext.dispose();
    throw error;
  }
}
