/**
 * Nuvio Universal Cloudflare HLS & Stream Proxy Worker
 * Open-Source Serverless Proxy for Streaming .m3u8 Playlists and Media Chunks
 * 
 * Features:
 * - Full CORS Bypass (Access-Control-Allow-Origin: *)
 * - Custom Header Forwarding (Referer, User-Agent, Origin, Cookies, Authorization)
 * - Automatic HLS (.m3u8) Manifest Segment & Sub-playlist Rewriting
 * - Byte-Range & Binary Stream Support for .ts, .mp4, .mkv, .aac, .vtt
 */

export default {
    async fetch(request, env, ctx) {
        const url = new URL(request.url);

        // CORS Preflight Handler
        if (request.method === "OPTIONS") {
            return new Response(null, {
                status: 204,
                headers: getCorsHeaders()
            });
        }

        // Extract target URL from query parameter (?url=https://...)
        let targetUrl = url.searchParams.get("url");
        if (!targetUrl && url.pathname !== "/" && url.pathname !== "/favicon.ico") {
            targetUrl = url.pathname.slice(1) + url.search;
            if (targetUrl.startsWith("http:/") && !targetUrl.startsWith("http://")) {
                targetUrl = targetUrl.replace("http:/", "http://");
            } else if (targetUrl.startsWith("https:/") && !targetUrl.startsWith("https://")) {
                targetUrl = targetUrl.replace("https:/", "https://");
            }
        }

        // Landing Page / Documentation when no target URL is provided
        if (!targetUrl) {
            return serveLandingPage(request);
        }

        try {
            // Build Upstream Request Headers
            const upstreamHeaders = new Headers();
            
            // Forward essential headers passed via query parameters or original request
            const forwardKeys = ["referer", "user-agent", "origin", "cookie", "authorization", "range"];
            for (const [key, value] of url.searchParams.entries()) {
                if (key.toLowerCase() !== "url") {
                    upstreamHeaders.set(key, value);
                }
            }

            for (const key of forwardKeys) {
                if (!upstreamHeaders.has(key) && request.headers.has(key)) {
                    upstreamHeaders.set(key, request.headers.get(key));
                }
            }

            // Default User-Agent if none provided
            if (!upstreamHeaders.has("user-agent")) {
                upstreamHeaders.set("user-agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36");
            }

            // Fetch Upstream Media/Playlist
            const upstreamResponse = await fetch(targetUrl, {
                method: request.method,
                headers: upstreamHeaders,
                redirect: "follow"
            });

            const responseHeaders = new Headers(upstreamResponse.headers);
            const corsHeaders = getCorsHeaders();
            for (const [k, v] of Object.entries(corsHeaders)) {
                responseHeaders.set(k, v);
            }

            const contentType = (responseHeaders.get("content-type") || "").toLowerCase();
            const isHlsManifest = targetUrl.includes(".m3u8") || 
                                  contentType.includes("mpegurl") || 
                                  contentType.includes("application/x-mpegurl") || 
                                  contentType.includes("vnd.apple.mpegurl");

            // Intercept & Rewrite HLS .m3u8 Playlists
            if (isHlsManifest && upstreamResponse.ok) {
                const manifestText = await upstreamResponse.text();
                const rewrittenManifest = rewriteHlsManifest(manifestText, targetUrl, url.origin, url.searchParams);
                
                responseHeaders.set("content-type", "application/vnd.apple.mpegurl");
                responseHeaders.delete("content-length");
                responseHeaders.delete("content-encoding");

                return new Response(rewrittenManifest, {
                    status: upstreamResponse.status,
                    headers: responseHeaders
                });
            }

            // Stream binary data directly (TS segments, MP4 video chunks, subtitles, audio)
            return new Response(upstreamResponse.body, {
                status: upstreamResponse.status,
                statusText: upstreamResponse.statusText,
                headers: responseHeaders
            });

        } catch (error) {
            return new Response(JSON.stringify({
                status: "error",
                message: "Proxy Stream Error: " + error.message,
                targetUrl: targetUrl
            }, null, 2), {
                status: 502,
                headers: {
                    ...getCorsHeaders(),
                    "content-type": "application/json"
                }
            });
        }
    }
};

/**
 * Rewrite HLS .m3u8 Manifest URLs so all segments and sub-playlists pass through this proxy
 */
function rewriteHlsManifest(manifestText, baseUrl, proxyOrigin, originalParams) {
    const lines = manifestText.split(/\r?\n/);
    const baseUri = new URL(baseUrl);
    const baseDir = baseUri.href.substring(0, baseUri.href.lastIndexOf("/") + 1);

    // Prepare header parameters to preserve across all segments
    const preservedParams = new URLSearchParams();
    for (const [k, v] of originalParams.entries()) {
        if (k.toLowerCase() !== "url") {
            preservedParams.set(k, v);
        }
    }
    const paramSuffix = preservedParams.toString() ? `&${preservedParams.toString()}` : "";

    return lines.map(line => {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith("#")) {
            // Handle URI inside tags like #EXT-X-KEY:METHOD=AES-128,URI="https://..."
            if (trimmed.startsWith("#EXT-X-KEY:") && trimmed.includes("URI=")) {
                return trimmed.replace(/URI="([^"]+)"/, (_, keyUrl) => {
                    const resolvedKeyUrl = new URL(keyUrl, baseDir).href;
                    const proxiedKeyUrl = `${proxyOrigin}/?url=${encodeURIComponent(resolvedKeyUrl)}${paramSuffix}`;
                    return `URI="${proxiedKeyUrl}"`;
                });
            }
            return line;
        }

        // This line is a segment URL or sub-playlist URL
        const resolvedUrl = new URL(trimmed, baseDir).href;
        return `${proxyOrigin}/?url=${encodeURIComponent(resolvedUrl)}${paramSuffix}`;
    }).join("\n");
}

/**
 * Standard CORS Headers for Universal Playback
 */
function getCorsHeaders() {
    return {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, HEAD, POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type, Range, User-Agent, Referer, Authorization, X-Requested-With",
        "Access-Control-Expose-Headers": "Content-Length, Content-Range, Content-Type, Accept-Ranges, Date, Server",
        "Access-Control-Max-Age": "86400"
    };
}

/**
 * Serve Documentation / Landing Page
 */
function serveLandingPage(request) {
    const origin = new URL(request.url).origin;
    const html = `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>⚡ Nuvio Cloudflare HLS Proxy</title>
    <style>
        body { background: #0b0f19; color: #f1f5f9; font-family: system-ui, -apple-system, sans-serif; padding: 2rem; line-height: 1.6; max-width: 800px; margin: 0 auto; }
        h1 { color: #818cf8; font-size: 1.8rem; margin-bottom: 0.5rem; }
        .card { background: #131b2e; border: 1px solid #222f4e; padding: 1.5rem; border-radius: 8px; margin-top: 1.5rem; }
        code { background: #0f172a; padding: 0.2rem 0.5rem; border-radius: 4px; color: #38bdf8; font-family: monospace; }
        pre { background: #0f172a; padding: 1rem; border-radius: 6px; overflow-x: auto; border: 1px solid #1e293b; color: #e2e8f0; font-size: 0.9rem; }
        .badge { background: #4f46e5; color: #fff; padding: 0.2rem 0.6rem; border-radius: 9999px; font-size: 0.75rem; font-weight: bold; }
    </style>
</head>
<body>
    <h1>⚡ Nuvio Open-Source Cloudflare HLS Proxy</h1>
    <span class="badge">Serverless Stream Proxy</span>
    <p>This is an open-source Cloudflare Worker designed to proxy HLS (<code>.m3u8</code>) playlists, video segments, and headers to bypass CORS restrictions and Referer blocks.</p>
    
    <div class="card">
        <h3>🚀 Usage Syntax</h3>
        <p>Pass your target stream URL as the <code>url</code> query parameter:</p>
        <pre><code>GET ${origin}/?url=https://example.com/stream.m3u8&Referer=https://example.com</code></pre>
        
        <h4>Supported Parameters:</h4>
        <ul>
            <li><code>url</code> : The target media URL or .m3u8 playlist (Required)</li>
            <li><code>Referer</code> : Upstream referer header to spoof</li>
            <li><code>User-Agent</code> : Custom User-Agent header</li>
            <li><code>Origin</code> : Custom Origin header</li>
        </ul>
    </div>

    <div class="card">
        <h3>📦 Deploy Your Own</h3>
        <p>You can deploy this worker for free to your own Cloudflare account:</p>
        <pre><code>git clone https://github.com/lakshman-reddy-sudo/entertainment
cd entertainment/cf-proxy
npx wrangler deploy</code></pre>
    </div>
</body>
</html>`;
    return new Response(html, {
        status: 200,
        headers: {
            "content-type": "text/html; charset=utf-8",
            ...getCorsHeaders()
        }
    });
}
