import { unzipSync } from 'fflate';
import { decompress } from 'any-xz';

export default {
  async fetch(request, env, ctx) {
    const urlObj = new URL(request.url);
    const urlPath = urlObj.pathname.toLowerCase();
    const targetUrl = urlObj.searchParams.get('url');
    const forceFormat = urlObj.searchParams.get('format');
    const corsHeaders = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    };

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders });
    }

    let fileSourceStream = null;
    let contentType = request.headers.get('content-type') || '';
    let processingPath = urlPath;

    if (request.method === 'GET') {
      if (!targetUrl) {
        return new Response('Missing ?url= parameter.', { status: 400, headers: corsHeaders });
      }
      try {
        const remoteRes = await fetch(targetUrl);
        if (!remoteRes.ok) throw new Error(`Target returned status ${remoteRes.status}`);
        fileSourceStream = remoteRes.body;
        contentType = remoteRes.headers.get('content-type') || '';
        processingPath = new URL(targetUrl).pathname.toLowerCase();
      } catch (e) {
        return new Response(`Failed fetching remote file: ${e.message}`, { status: 502, headers: corsHeaders });
      }
    } else if (request.method === 'POST') {
      if (!request.body) {
        return new Response('Empty request body.', { status: 400, headers: corsHeaders });
      }
      fileSourceStream = request.body;
    } else {
      return new Response('Method not allowed.', { status: 405, headers: corsHeaders });
    }

    try {
      if (processingPath.endsWith('.xz') || contentType.includes('xz') || forceFormat === 'xz') {
        const arrayBuffer = await new Response(fileSourceStream).arrayBuffer();
        const bytes = new Uint8Array(arrayBuffer);

        // Decompress the modern XZ container directly using pure vanilla JS mechanics
        const decompressed = decompress(bytes);
        
        return new Response(decompressed, {
          headers: {
            ...corsHeaders,
            'Content-Type': 'text/plain; charset=utf-8',
            'Content-Disposition': 'inline; filename="subtitle.srt"'
          }
        });
      }

      if (processingPath.endsWith('.zip') || contentType.includes('zip') || forceFormat === 'zip') {
        const arrayBuffer = await new Response(fileSourceStream).arrayBuffer();
        const buffer = new Uint8Array(arrayBuffer);
        const unzipped = unzipSync(buffer);
        const subFileKey = Object.keys(unzipped).find(name =>
          name.endsWith('.srt') || name.endsWith('.vtt') || name.endsWith('.ass')
        );
        if (!subFileKey) {
          return new Response('No subtitle file found inside ZIP.', { status: 404, headers: corsHeaders });
        }
        const subtitleText = new TextDecoder('utf-8').decode(unzipped[subFileKey]);
        return new Response(subtitleText, {
          headers: {
            ...corsHeaders,
            'Content-Type': 'text/plain; charset=utf-8',
            'Content-Disposition': `inline; filename="${subFileKey}"`
          }
        });
      }

      return new Response(fileSourceStream, {
        headers: { ...corsHeaders, 'Content-Type': 'text/plain; charset=utf-8' }
      });

    } catch (error) {
      return new Response(`Extraction failed: ${error.message}`, { status: 500, headers: corsHeaders });
    }
  }
};
