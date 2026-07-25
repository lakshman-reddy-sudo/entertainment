const { addonBuilder, getRouter } = require("stremio-addon-sdk");
const express = require("express");
const serverless = require("serverless-http");
const axios = require("axios");
const dns = require("dns");
const fs = require("fs");
const path = require("path");

// Inject globals for Nuvio scrapers
global.cheerio = require("cheerio");
global.CryptoJS = require("crypto-js");
global.axios = axios;

// Fix for Node 18+ fetch timeouts (UND_ERR_CONNECT_TIMEOUT) on Netlify IPv6
dns.setDefaultResultOrder("ipv4first");

// === UPDATE THESE VARIABLES ONCE DEPLOYED ===
const HLS_PROXY_URL = "https://nuvio-cf-proxy.lakshman-n-hlc0596.workers.dev"; // e.g. https://nuvio-proxy.username.workers.dev
const TMDB_API_KEY = "e8f0855cbadb760c109f061e72be897a"; // Change this if scrapers need it
// ============================================

// Intercept TMDB API requests and inject our API key
const originalFetch = global.fetch;
global.fetch = async (url, options) => {
    if (typeof url === "string" && url.includes("api.themoviedb.org") && url.includes("api_key=")) {
        url = url.replace(/api_key=[^&]+/, "api_key=" + TMDB_API_KEY);
    }
    return originalFetch(url, options);
};

const NUVIO_RAW_BASE = "https://raw.githubusercontent.com/D3adlyRocket/All-in-One-Nuvio/main";

const addon = new addonBuilder({
    id: "org.nuvio.ultimate.port",
    version: "2.0.0",
    name: "All-in-One Nuvio Port",
    description: "Runs all Nuvio Scrapers directly inside Stremio",
    resources: ["stream"],
    types: ["movie", "series", "anime"],
    idPrefixes: ["tt"],
    catalogs: []
});

let cachedManifest = null;
let cachedModules = {};

async function loadNuvioScraper(filename) {
    if (cachedModules[filename]) return cachedModules[filename];
    try {
        const scraperPath = path.join(process.cwd(), "scrapers", "providers", filename.replace("providers/", ""));
        let code = fs.readFileSync(scraperPath, "utf8");

        const m = { exports: {} };
        const wrapper = Function("module", "exports", "require", code);
        wrapper(m, m.exports, require);
        cachedModules[filename] = m.exports;
        return m.exports;
    } catch (e) {
        console.error(`Failed to load ${filename}:`, e.message);
        return null;
    }
}

addon.defineStreamHandler(async (args) => {
    const idParts = args.id.split(":");
    const baseId = idParts[0]; 
    const season = idParts.length > 1 ? parseInt(idParts[1]) : null;
    const episode = idParts.length > 2 ? parseInt(idParts[2]) : null;
    
    let allStreams = [];

    try {
        if (!cachedManifest) {
            const manifestRes = await axios.get(`${NUVIO_RAW_BASE}/manifest.json`);
            cachedManifest = manifestRes.data;
        }

        const tasks = [];
        cachedManifest.scrapers.forEach((scraperInfo) => {
            if (!scraperInfo.enabled) return;
            
            const stType = args.type === "series" ? "tv" : args.type;
            if (!scraperInfo.supportedTypes.includes(stType)) return;

            tasks.push(async () => {
                const scraperModule = await loadNuvioScraper(scraperInfo.filename);
                if (!scraperModule || typeof scraperModule.getStreams !== "function") return;

                try {
                    const results = await Promise.race([
                        scraperModule.getStreams(baseId, stType, season, episode).catch(err => {
                            console.error(`Error running Nuvio scraper ${scraperInfo.name}:`, err.message);
                            return [];
                        }),
                        new Promise((_, reject) => setTimeout(() => reject(new Error('Scraper timeout')), 45000))
                    ]);
                    
                    if (results && Array.isArray(results)) {
                        results.forEach(stream => {
                            let streamUrl = stream.url;
                            
                            const isM3U8 = streamUrl.includes(".m3u8");
                            const hasHeaders = stream.headers && Object.keys(stream.headers).length > 0;
                            
                            if (isM3U8 || hasHeaders) {
                                const headerParams = hasHeaders ? `&${new URLSearchParams(stream.headers).toString()}` : "";
                                streamUrl = `${HLS_PROXY_URL}/?url=${encodeURIComponent(streamUrl)}${headerParams}`;
                            }

                            let behaviorHints = stream.behaviorHints || {};
                            if (behaviorHints.notWebReady !== undefined) {
                                delete behaviorHints.notWebReady;
                            }

                            allStreams.push({
                                name: `Nuvio | ${scraperInfo.name}`,
                                title: `${stream.quality || 'Auto'} - ${stream.title || 'Stream'}`,
                                url: streamUrl,
                                behaviorHints: behaviorHints
                            });
                        });
                    }
                } catch (err) {
                    console.error(`Error running Nuvio scraper ${scraperInfo.name}:`, err.message);
                }
            });
        });

        const executing = [];
        const poolResults = [];
        for (const task of tasks) {
            const p = Promise.resolve().then(() => task());
            poolResults.push(p);
            if (6 <= tasks.length) {
                const e = p.then(() => executing.splice(executing.indexOf(e), 1));
                executing.push(e);
                if (executing.length >= 6) {
                    await Promise.race(executing);
                }
            }
        }
        await Promise.allSettled(poolResults);
    } catch (e) {
        console.error("Failed to fetch Nuvio manifest:", e.message);
    }

    return { streams: allStreams };
});

async function runUniversalExtraction(baseId, type = "movie", season = null, episode = null) {
    const stType = type === "series" || type === "tv" ? "tv" : type;
    const startTime = Date.now();
    
    if (!cachedManifest) {
        const manifestRes = await axios.get(`${NUVIO_RAW_BASE}/manifest.json`);
        cachedManifest = manifestRes.data;
    }

    const tasks = [];
    cachedManifest.scrapers.forEach(scraperInfo => {
        if (!scraperInfo.enabled) return;
        if (!scraperInfo.supportedTypes.includes(stType)) return;

        tasks.push(async () => {
            const scraperModule = await loadNuvioScraper(scraperInfo.filename);
            if (!scraperModule || typeof scraperModule.getStreams !== "function") return [];

            try {
                const results = await Promise.race([
                    scraperModule.getStreams(baseId, stType, season, episode).catch(err => {
                        console.error(`[Extractor] Error in ${scraperInfo.name}:`, err.message);
                        return [];
                    }),
                    new Promise((_, reject) => setTimeout(() => reject(new Error('Scraper timeout')), 45000))
                ]);
                return { provider: scraperInfo.name, results: Array.isArray(results) ? results : [] };
            } catch (err) {
                console.error(`[Extractor] Timeout/Error in ${scraperInfo.name}:`, err.message);
                return { provider: scraperInfo.name, results: [] };
            }
        });
    });

    const executing = [];
    const poolResults = [];
    for (const task of tasks) {
        const p = Promise.resolve().then(() => task());
        poolResults.push(p);
        if (6 <= tasks.length) {
            const e = p.then(() => executing.splice(executing.indexOf(e), 1));
            executing.push(e);
            if (executing.length >= 6) {
                await Promise.race(executing);
            }
        }
    }

    const settled = await Promise.allSettled(poolResults);
    
    const extractedLinks = [];
    const providerStats = {};

    settled.forEach(res => {
        if (res.status === "fulfilled" && res.value && res.value.results) {
            const { provider, results } = res.value;
            providerStats[provider] = results.length;
            
            results.forEach(stream => {
                let proxyUrl = stream.url;
                const isM3U8 = proxyUrl.includes(".m3u8");
                const hasHeaders = stream.headers && Object.keys(stream.headers).length > 0;
                if (isM3U8 || hasHeaders) {
                    const headerParams = hasHeaders ? `&${new URLSearchParams(stream.headers).toString()}` : "";
                    proxyUrl = `${HLS_PROXY_URL}/?url=${encodeURIComponent(stream.url)}${headerParams}`;
                }

                extractedLinks.push({
                    provider: provider,
                    quality: stream.quality || "Auto",
                    title: (stream.title || "Stream").replace(/\r?\n|\r/g, " | "),
                    directUrl: stream.url,
                    proxyUrl: proxyUrl,
                    headers: stream.headers || {},
                    behaviorHints: stream.behaviorHints || {}
                });
            });
        }
    });

    return {
        status: "success",
        query: { id: baseId, type: stType, season: season, episode: episode },
        timeTakenMs: Date.now() - startTime,
        totalLinks: extractedLinks.length,
        activeProviders: Object.keys(providerStats).filter(p => providerStats[p] > 0).length,
        providerStats: providerStats,
        links: extractedLinks
    };
}

function sendFormattedResponse(req, res, data) {
    res.setHeader("Access-Control-Allow-Origin", "*");
    const isBrowser = req.headers.accept && req.headers.accept.includes("text/html") && !req.query.raw;
    if (isBrowser) {
        res.setHeader("Content-Type", "text/html; charset=utf-8");
        const jsonStr = JSON.stringify(data, null, 2);
        return res.status(200).send(`<!DOCTYPE html>
<html>
<head>
    <title>Nuvio Universal Extractor - ${data.query.id}</title>
    <meta charset="utf-8">
    <style>
        body { background: #0f172a; color: #f8fafc; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, monospace; padding: 25px; margin: 0; }
        .header { background: #1e293b; padding: 20px; border-radius: 12px; border: 1px solid #334155; margin-bottom: 20px; box-shadow: 0 4px 6px -1px rgba(0,0,0,0.1); }
        h1 { color: #38bdf8; margin: 0 0 10px 0; font-size: 24px; }
        .stats { font-size: 14px; color: #94a3b8; }
        .stats b { color: #f8fafc; }
        pre { background: #1e293b; padding: 20px; border-radius: 12px; overflow-x: auto; font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace; font-size: 13px; line-height: 1.6; border: 1px solid #334155; }
        .string { color: #86efac; }
        .number { color: #fba94c; }
        .boolean { color: #93c5fd; }
        .null { color: #f87171; }
        .key { color: #38bdf8; font-weight: 600; }
        .url-link { color: #60a5fa; text-decoration: underline; }
    </style>
</head>
<body>
    <div class="header">
        <h1>🎬 Nuvio Universal Link Extractor</h1>
        <div class="stats">
            Query: <b>${data.query.type.toUpperCase()} (${data.query.id})</b> &nbsp;|&nbsp; 
            Total Direct Links: <b>${data.totalLinks}</b> &nbsp;|&nbsp; 
            Active Providers: <b>${data.activeProviders}</b> &nbsp;|&nbsp; 
            Time Taken: <b>${(data.timeTakenMs / 1000).toFixed(1)}s</b>
        </div>
    </div>
    <pre id="json"></pre>
    <script>
        const rawJson = ${JSON.stringify(jsonStr)};
        function syntaxHighlight(json) {
            json = json.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
            return json.replace(/("(\\u[a-zA-Z0-9]{4}|\\[^u]|[^\\"])*"(\\s*:)?|\\b(true|false|null)\\b|-?\\d+(?:\\.\\d*)?(?:[eE][+\\-]?\\d+)?)/g, function (match) {
                var cls = 'number';
                if (/^"/.test(match)) {
                    if (/:$/.test(match)) {
                        cls = 'key';
                    } else {
                        cls = 'string';
                        if (match.indexOf('http') === 1) {
                            var cleanUrl = match.slice(1, -1);
                            return '<span class="string">"<a href="' + cleanUrl + '" target="_blank" class="url-link">' + cleanUrl + '</a>"</span>';
                        }
                    }
                } else if (/true|false/.test(match)) {
                    cls = 'boolean';
                } else if (/null/.test(match)) {
                    cls = 'null';
                }
                return '<span class="' + cls + '">' + match + '</span>';
            });
        }
        document.getElementById('json').innerHTML = syntaxHighlight(rawJson);
    </script>
</body>
</html>`);
    } else {
        res.setHeader("Content-Type", "application/json; charset=utf-8");
        return res.status(200).send(JSON.stringify(data, null, 2));
    }
}

const app = express();

app.get("/api/extract", async (req, res) => {
    try {
        let id = req.query.id || req.query.imdbId;
        if (!id) return res.status(400).json({ status: "error", message: "Missing 'id' query parameter (e.g. ?id=tt0816692)" });

        let type = req.query.type || "movie";
        let season = req.query.season ? parseInt(req.query.season) : null;
        let episode = req.query.episode ? parseInt(req.query.episode) : null;

        if (id.includes(":")) {
            const parts = id.split(":");
            id = parts[0];
            type = "series";
            if (parts.length > 1) season = parseInt(parts[1]);
            if (parts.length > 2) episode = parseInt(parts[2]);
        }

        const data = await runUniversalExtraction(id, type, season, episode);
        return sendFormattedResponse(req, res, data);
    } catch (err) {
        return res.status(500).json({ status: "error", message: err.message });
    }
});

app.get("/extract/movie/:id", async (req, res) => {
    try {
        const data = await runUniversalExtraction(req.params.id, "movie", null, null);
        return sendFormattedResponse(req, res, data);
    } catch (err) {
        return res.status(500).json({ status: "error", message: err.message });
    }
});

app.get("/extract/series/:id/:season/:episode", async (req, res) => {
    try {
        const data = await runUniversalExtraction(req.params.id, "series", parseInt(req.params.season), parseInt(req.params.episode));
        return sendFormattedResponse(req, res, data);
    } catch (err) {
        return res.status(500).json({ status: "error", message: err.message });
    }
});

app.use("/", getRouter(addon.getInterface()));

module.exports = app;
module.exports.handler = serverless(app);

// For Render / standalone node
if (require.main === module || process.env.RENDER) {
    const port = process.env.PORT || 3000;
    app.listen(port, () => {
        console.log(`Addon running on port ${port}`);
    });
}
