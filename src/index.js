import { unzipSync } from 'fflate';
import lzma from 'lzma-purejs';

export default {
  async fetch(request, env, ctx) {
    const urlObj = new URL(request.url);
    const urlPath = urlObj.pathname.toLowerCase();
    const targetUrl = urlObj.searchParams.get('url');

    const corsHeaders = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    };

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders });
    }

    let fileDataBuffer = null;
    let contentType = request.headers.get('content-type') || '';
    let processingPath = urlPath;

    // Fetch or receive file content
    if (request.method === 'GET') {
      if (!targetUrl) {
        return new Response('Missing ?url= parameter.', { status: 400, headers: corsHeaders });
      }
      try {
        const remoteRes = await fetch(targetUrl);
        if (!remoteRes.ok) throw new Error(`Target returned status ${remoteRes.status}`);
        
        fileDataBuffer = await remoteRes.arrayBuffer();
        contentType = remoteRes.headers.get('content-type') || '';
        processingPath = new URL(targetUrl).pathname.toLowerCase();
      } catch (e) {
        return new Response(`Failed fetching remote file: ${e.message}`, { status: 502, headers: corsHeaders });
      }
    } 
    else if (request.method === 'POST') {
      if (!request.body) {
        return new Response('Empty request body.', { status: 400, headers: corsHeaders });
      }
      fileDataBuffer = await request.arrayBuffer();
    } else {
      return new Response('Method not allowed.', { status: 405, headers: corsHeaders });
    }

    try {
      const byteArray = new Uint8Array(fileDataBuffer);

      // 1. HANDLE .XZ FILES (Pure JS Engine)
      if (processingPath.endsWith('.xz') || contentType.includes('xz')) {
        // lzma-purejs expects a Uint8Array or Node Buffer
        const decompressedData = lzma.decompress(byteArray);
        
        return new Response(decompressedData, {
          headers: {
            ...corsHeaders,
            'Content-Type': 'text/plain; charset=utf-8',
            'Content-Disposition': 'inline; filename="subtitle.srt"'
          }
        });
      }

      // 2. HANDLE .ZIP FILES
      if (processingPath.endsWith('.zip') || contentType.includes('zip')) {
        const unzipped = unzipSync(byteArray);
        const subFileKey = Object.keys(unzipped).find(name => 
          name.endsWith('.srt') || name.endsWith('.vtt') || name.endsWith('.ass')
        );

        if (!subFileKey) {
          return new Response('No subtitle file found inside ZIP.', { status: 404, headers: corsHeaders });
        }

        const textDecoder = new TextDecoder('utf-8');
        const subtitleText = textDecoder.decode(unzipped[subFileKey]);

        return new Response(subtitleText, {
          headers: {
            ...corsHeaders,
            'Content-Type': 'text/plain; charset=utf-8',
            'Content-Disposition': `inline; filename="${subFileKey}"`
          }
        });
      }

      // 3. FALLBACK FOR UNCOMPRESSED TEXT
      return new Response(fileDataBuffer, {
        headers: { ...corsHeaders, 'Content-Type': 'text/plain; charset=utf-8' }
      });

    } catch (error) {
      return new Response(`Extraction failed: ${error.message}`, { status: 500, headers: corsHeaders });
    }
  }
};
