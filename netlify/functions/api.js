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
try {
    dns.setDefaultResultOrder("ipv4first");
} catch (e) {
    // ignore if unsupported
}

// === CONFIGURATION ===
const HLS_PROXY_URL = "https://nuvio-cf-proxy.lakshman-n-hlc0596.workers.dev";
const TMDB_API_KEY = "e8f0855cbadb760c109f061e72be897a";
const NUVIO_RAW_BASE = "https://raw.githubusercontent.com/NuvioPlugin/All-in-One-Nuvio/main";
// =====================

// --- TMDB ID RESOLUTION & API KEY INTERCEPTOR ---
const tmdbIdCache = {};

async function resolveTmdbId(imdbId) {
    if (!imdbId || !imdbId.startsWith("tt")) return imdbId;
    if (tmdbIdCache[imdbId]) return tmdbIdCache[imdbId];
    try {
        const findUrl = `https://api.tmdb.org/3/find/${imdbId}?api_key=${TMDB_API_KEY}&external_source=imdb_id`;
        const res = await global.fetch(findUrl);
        if (res.ok) {
            const data = await res.json();
            let numericId = null;
            if (data.tv_results && data.tv_results.length > 0) numericId = data.tv_results[0].id;
            else if (data.movie_results && data.movie_results.length > 0) numericId = data.movie_results[0].id;
            if (numericId) {
                tmdbIdCache[imdbId] = numericId;
                return numericId;
            }
        }
    } catch (e) {
        // ignore resolution error
    }
    return imdbId;
}

async function processUrlForTmdb(url) {
    if (typeof url !== "string" || (!url.includes("themoviedb.org") && !url.includes("tmdb.org"))) {
        return url;
    }
    url = url.replace("api.themoviedb.org", "api.tmdb.org");
    if (url.includes("api_key=")) {
        url = url.replace(/api_key=[^&]+/, "api_key=" + TMDB_API_KEY);
    } else {
        const separator = url.includes("?") ? "&" : "?";
        url = `${url}${separator}api_key=${TMDB_API_KEY}`;
    }
    // Automatically resolve IMDb ID (tt...) to TMDB Numeric ID for TV and Movies
    const match = url.match(/\/3\/(?:tv|movie|tv\/seasons|tv\/episodes)\/(tt\d+)/);
    if (match && match[1]) {
        const numericId = await resolveTmdbId(match[1]);
        if (numericId && numericId !== match[1]) {
            url = url.replace(match[1], numericId);
        }
    }
    return url;
}

const originalFetch = global.fetch;
global.fetch = async (url, options = {}) => {
    url = await processUrlForTmdb(url);
    if (typeof url !== "string") return originalFetch(url, options);

    if (url.includes("workers.dev") || url.includes("localhost") || url.includes("127.0.0.1")) {
        return originalFetch(url, options);
    }

    const doProxyFetch = () => {
        const headers = options.headers || {};
        const params = new URLSearchParams();
        params.set("url", url);
        for (const [k, v] of Object.entries(headers)) {
            if (typeof v === "string" && k.toLowerCase() !== "host") {
                params.set(k, v);
            }
        }
        const proxyUrl = `${HLS_PROXY_URL}/?${params.toString()}`;
        return originalFetch(proxyUrl, {
            ...options,
            headers: {
                ...headers,
                "User-Agent": headers["User-Agent"] || "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120.0.0.0 Safari/537.36"
            }
        });
    };

    try {
        const directRes = await Promise.race([
            originalFetch(url, options),
            new Promise((_, reject) => setTimeout(() => reject(new Error("Direct fetch timeout")), 4500))
        ]);
        if ([403, 503, 520, 522, 524, 429].includes(directRes.status)) {
            return await doProxyFetch();
        }
        return directRes;
    } catch (err) {
        return await doProxyFetch();
    }
};

axios.interceptors.request.use(async (config) => {
    if (config.url) {
        config.url = await processUrlForTmdb(config.url);
    }
    return config;
});

axios.interceptors.response.use(
    (response) => {
        if ([403, 503, 520, 522, 524, 429].includes(response.status)) {
            const config = response.config;
            if (config && !config._retry && typeof config.url === "string" && !config.url.includes("workers.dev")) {
                config._retry = true;
                const headers = config.headers || {};
                const params = new URLSearchParams();
                params.set("url", config.url);
                for (const [k, v] of Object.entries(headers)) {
                    if (typeof v === "string" && k.toLowerCase() !== "host") {
                        params.set(k, v);
                    }
                }
                config.url = `${HLS_PROXY_URL}/?${params.toString()}`;
                return axios(config);
            }
        }
        return response;
    },
    async (error) => {
        const config = error.config;
        if (!config || config._retry || (typeof config.url === "string" && (config.url.includes("workers.dev") || config.url.includes("localhost")))) {
            return Promise.reject(error);
        }
        config._retry = true;
        const headers = config.headers || {};
        const params = new URLSearchParams();
        params.set("url", config.url);
        for (const [k, v] of Object.entries(headers)) {
            if (typeof v === "string" && k.toLowerCase() !== "host") {
                params.set(k, v);
            }
        }
        config.url = `${HLS_PROXY_URL}/?${params.toString()}`;
        return axios(config);
    }
);
// ------------------------------------------------

const addon = new addonBuilder({
    id: "org.nuvio.ultimate.port",
    version: "2.0.0",
    name: "All-in-One Nuvio Port",
    description: "Runs all Nuvio Scrapers directly inside Stremio and Standalone JSON API",
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
        const customRequire = (mod) => {
            if (mod === "cheerio-without-node-native") {
                try { return require("cheerio-without-node-native"); } catch(e) { return require("cheerio"); }
            }
            if (mod === "cheerio") return require("cheerio");
            if (mod === "crypto-js") return require("crypto-js");
            if (mod === "axios") return require("axios");
            if (mod === "node-fetch" || mod === "undici" || mod === "cross-fetch") {
                const f = async (url, opts) => global.fetch(url, opts);
                f.default = f;
                f.fetch = f;
                return f;
            }
            try {
                return require(mod);
            } catch (err) {
                if (mod.includes("cheerio")) return require("cheerio");
                throw err;
            }
        };
        const wrapper = Function("module", "exports", "require", code);
        wrapper(m, m.exports, customRequire);
        cachedModules[filename] = m.exports;
        return m.exports;
    } catch (e) {
        console.error(`Failed to load ${filename}:`, e.message);
        return null;
    }
}

async function scrapeAllProviders(baseId, stType, season, episode) {
    if (!cachedManifest) {
        try {
            const localManifestPath = path.join(process.cwd(), "scrapers", "manifest.json");
            if (fs.existsSync(localManifestPath)) {
                cachedManifest = JSON.parse(fs.readFileSync(localManifestPath, "utf8"));
            }
        } catch (err) {
            console.warn("Could not load local manifest:", err.message);
        }
        if (!cachedManifest) {
            const manifestRes = await axios.get(`${NUVIO_RAW_BASE}/manifest.json`);
            cachedManifest = manifestRes.data;
        }
    }

    // Normalize anime/series type so scrapers and TMDB work properly
    let normalizedType = stType === "series" ? "tv" : stType;
    if (normalizedType === "anime") {
        normalizedType = (season !== null && episode !== null) ? "tv" : "movie";
    }

    // Resolve IMDb ID to numeric TMDB ID so providers expecting numeric ID or IMDb ID both work
    let numericId = baseId;
    if (typeof baseId === "string" && baseId.startsWith("tt")) {
        const resId = await resolveTmdbId(baseId);
        if (resId && resId !== baseId) numericId = resId;
    }

    const tasks = [];
    cachedManifest.scrapers.forEach(scraperInfo => {
        if (!scraperInfo.enabled) return;
        const supportsType = scraperInfo.supportedTypes.includes(stType) || 
                             scraperInfo.supportedTypes.includes(normalizedType) ||
                             (stType === "anime" && (scraperInfo.supportedTypes.includes("tv") || scraperInfo.supportedTypes.includes("movie")));
        if (!supportsType) return;

        tasks.push(async () => {
            const scraperModule = await loadNuvioScraper(scraperInfo.filename);
            if (!scraperModule || typeof scraperModule.getStreams !== "function") return { provider: scraperInfo.name, results: [] };

            try {
                // Use 240s (4 minutes) timeout for all environments to allow deep scrapers ample time
                const timeoutMs = 240000;
                const runScraper = async (idToUse) => {
                    try {
                        const res = await scraperModule.getStreams(idToUse, normalizedType, season, episode);
                        return Array.isArray(res) ? res : [];
                    } catch (e) {
                        return [];
                    }
                };
                const resultsPromise = (async () => {
                    const res1 = await runScraper(numericId);
                    if (res1.length > 0 || numericId === baseId) return res1;
                    return await runScraper(baseId);
                })();

                const results = await Promise.race([
                    resultsPromise,
                    new Promise((_, reject) => setTimeout(() => reject(new Error('Scraper timeout')), timeoutMs))
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
    const CONCURRENCY_LIMIT = 61; // High concurrency so all 61 scrapers run simultaneously
    for (const task of tasks) {
        const p = Promise.resolve().then(() => task());
        poolResults.push(p);
        if (CONCURRENCY_LIMIT <= tasks.length) {
            const e = p.then(() => executing.splice(executing.indexOf(e), 1));
            executing.push(e);
            if (executing.length >= CONCURRENCY_LIMIT) {
                await Promise.race(executing);
            }
        }
    }

    const settled = await Promise.allSettled(poolResults);
    const providerData = [];
    settled.forEach(res => {
        if (res.status === "fulfilled" && res.value) {
            providerData.push(res.value);
        }
    });
    return providerData;
}

addon.defineStreamHandler(async (args) => {
    const idParts = args.id.split(":");
    const baseId = idParts[0];
    const season = idParts.length > 1 ? parseInt(idParts[1]) : null;
    const episode = idParts.length > 2 ? parseInt(idParts[2]) : null;
    const stType = args.type === "series" ? "tv" : args.type;

    let allStreams = [];
    try {
        const providerData = await scrapeAllProviders(baseId, stType, season, episode);
        providerData.forEach(({ provider, results }) => {
            results.forEach(stream => {
                if (!stream || !stream.url || typeof stream.url !== "string" || !stream.url.startsWith("http")) return;

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
                    name: `Nuvio | ${provider}`,
                    title: `${stream.quality || 'Auto'} - ${(stream.title || 'Stream').replace(/\r?\n|\r/g, " | ")}`,
                    url: streamUrl,
                    behaviorHints: behaviorHints
                });
            });
        });
    } catch (err) {
        console.error("Error in defineStreamHandler:", err.message);
    }
    return { streams: allStreams };
});

async function runUniversalExtraction(id, type, season, episode) {
    const startTime = Date.now();
    const stType = type === "series" ? "tv" : type;
    const baseId = id.split(":")[0];

    const providerData = await scrapeAllProviders(baseId, stType, season, episode);

    const extractedLinks = [];
    const providerStats = {};

    providerData.forEach(({ provider, results }) => {
        const validResults = results.filter(stream => stream && stream.url && typeof stream.url === "string" && stream.url.startsWith("http"));
        providerStats[provider] = validResults.length;

        validResults.forEach(stream => {
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

const app = express();

// Clean JSON formatting middleware - outputs pure, formatted JSON without HTML wrappers
app.use((req, res, next) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Requested-With");
    if (req.method === "OPTIONS") {
        return res.status(200).end();
    }
    const originalEnd = res.end.bind(res);
    res.end = function (chunk, encoding) {
        if (chunk) {
            let strChunk = null;
            if (typeof chunk === "string") strChunk = chunk;
            else if (Buffer.isBuffer(chunk)) strChunk = chunk.toString("utf8");

            if (strChunk) {
                const contentType = res.getHeader("Content-Type") || "";
                if (contentType.includes("application/json") || strChunk.trim().startsWith("{") || strChunk.trim().startsWith("[")) {
                    try {
                        const data = JSON.parse(strChunk);
                        res.setHeader("Content-Type", "application/json; charset=utf-8");
                        if (!res.headersSent) res.removeHeader("Content-Length");
                        return originalEnd(JSON.stringify(data, null, 2), encoding);
                    } catch (e) {
                        // pass through if parsing fails
                    }
                }
            }
        }
        return originalEnd(chunk, encoding);
    };
    next();
});

function sendExtractedResponse(req, res, data) {
    if (req.query.format === "json" || (req.headers.accept && req.headers.accept.includes("application/json") && !req.headers.accept.includes("text/html"))) {
        return res.json(data);
    }
    if (req.headers.accept && req.headers.accept.includes("text/html") || req.query.view === "html" || req.query.format === "html") {
        const jsonStr = JSON.stringify(data, null, 2);
        const html = `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Extract Results: ${data.query?.id || "Media"}</title>
    <style>
        :root { --bg: #0b0f19; --card: #131b2e; --text: #f1f5f9; --accent: #6366f1; --border: #222f4e; }
        body { background: var(--bg); color: var(--text); font-family: system-ui, -apple-system, sans-serif; margin: 0; padding: 2rem; }
        .container { max-width: 1200px; margin: 0 auto; }
        .header { display: flex; justify-content: space-between; align-items: center; border-bottom: 1px solid var(--border); padding-bottom: 1rem; margin-bottom: 1.5rem; flex-wrap: wrap; gap: 1rem; }
        h1 { margin: 0; font-size: 1.5rem; color: #fff; }
        .stats { display: flex; gap: 1.5rem; background: var(--card); padding: 0.8rem 1.2rem; border-radius: 8px; border: 1px solid var(--border); font-size: 0.9rem; flex-wrap: wrap; }
        .stat-item b { color: #a5b4fc; }
        .tabs { display: flex; gap: 0.5rem; margin-bottom: 1rem; }
        .tab-btn { background: var(--card); border: 1px solid var(--border); color: #94a3b8; padding: 0.6rem 1.2rem; border-radius: 6px; cursor: pointer; font-weight: 600; transition: all 0.2s; }
        .tab-btn.active { background: var(--accent); color: #fff; border-color: var(--accent); }
        .tab-content { display: none; }
        .tab-content.active { display: block; }
        pre { background: var(--card); padding: 1.5rem; border-radius: 8px; border: 1px solid var(--border); overflow-x: auto; color: #e2e8f0; font-size: 0.85rem; line-height: 1.5; }
        table { width: 100%; border-collapse: collapse; background: var(--card); border-radius: 8px; overflow: hidden; border: 1px solid var(--border); }
        th, td { padding: 0.8rem 1rem; text-align: left; border-bottom: 1px solid var(--border); font-size: 0.9rem; }
        th { background: rgba(99, 102, 241, 0.1); color: #a5b4fc; font-weight: 600; }
        .badge { background: #334155; padding: 0.2rem 0.6rem; border-radius: 4px; font-size: 0.75rem; font-weight: 600; display: inline-block; }
        .btn { background: #4f46e5; color: #fff; border: none; padding: 0.4rem 0.8rem; border-radius: 4px; cursor: pointer; font-size: 0.8rem; font-weight: 600; text-decoration: none; display: inline-block; }
        .btn:hover { background: #4338ca; }
        .btn-outline { background: transparent; border: 1px solid var(--border); color: #cbd5e1; }
        .btn-outline:hover { background: rgba(255,255,255,0.05); }
        .actions-cell { display: flex; gap: 0.5rem; flex-wrap: wrap; }
        .url-text { max-width: 280px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; font-family: monospace; font-size: 0.8rem; color: #94a3b8; }
        @media (max-width: 768px) {
            body { padding: 1rem; }
            th, td { padding: 0.5rem; font-size: 0.8rem; }
            .url-text { max-width: 120px; }
            .stats { gap: 0.8rem; }
        }
    </style>
</head>
<body>
    <div class="container">
        <div class="header">
            <div>
                <h1>⚡ Nuvio Extractor: ${data.query?.id?.toUpperCase() || ""} (${data.query?.type || ""})</h1>
                <p style="color: #64748b; margin: 0.4rem 0 0 0; font-size: 0.85rem;">Universal Multi-Provider Stream Scraping Engine</p>
            </div>
            <div style="display: flex; gap: 1rem; align-items: center;">
                <a href="?format=json" class="btn btn-outline">📄 View Raw JSON API</a>
            </div>
        </div>
        <div class="stats">
            <div class="stat-item">Time Taken: <b>${((data.timeTakenMs || 0)/1000).toFixed(1)}s</b></div>
            <div class="stat-item">Total Links: <b>${data.totalLinks || 0}</b></div>
            <div class="stat-item">Active Providers: <b>${data.activeProviders || 0}</b></div>
        </div>
        <div class="tabs">
            <button class="tab-btn active" onclick="showTab('table')">📋 Extracted Links (${data.totalLinks || 0})</button>
            <button class="tab-btn" onclick="showTab('json')">{} Formatted JSON</button>
        </div>
        <div id="tab-table" class="tab-content active">
            ${(data.streams && data.streams.length > 0) ? `
            <div style="overflow-x: auto;">
            <table>
                <thead>
                    <tr>
                        <th>Provider</th>
                        <th>Quality</th>
                        <th>Title / Info</th>
                        <th>Direct URL</th>
                        <th>Actions</th>
                    </tr>
                </thead>
                <tbody>
                    ${data.streams.map((s) => `
                    <tr>
                        <td><span class="badge">${s.provider || "Unknown"}</span></td>
                        <td><b>${s.quality || "Auto"}</b></td>
                        <td style="max-width: 250px;">${s.title || "Stream"}</td>
                        <td><div class="url-text" title="${s.directUrl || s.url || ""}">${s.directUrl || s.url || ""}</div></td>
                        <td class="actions-cell">
                            <button class="btn" onclick="copyText('${(s.directUrl || s.url || "").replace(/'/g, "\\'")}')">Copy Link</button>
                            ${s.proxyUrl ? `<button class="btn btn-outline" onclick="copyText('${s.proxyUrl.replace(/'/g, "\\'")}')">Copy Proxy</button>` : ""}
                            <a href="${s.directUrl || s.url || "#"}" target="_blank" class="btn btn-outline">Open</a>
                        </td>
                    </tr>`).join("")}
                </tbody>
            </table>
            </div>` : `<div style="padding: 2rem; text-align: center; background: var(--card); border-radius: 8px;">No streams found for this query.</div>`}
        </div>
        <div id="tab-json" class="tab-content">
            <div style="margin-bottom: 0.5rem; text-align: right;">
                <button class="btn" onclick="copyJson()">Copy All JSON</button>
            </div>
            <pre id="json-pre">${jsonStr.replace(/&/g, "&amp;").replace(/</g, "&gt;").replace(/>/g, "&gt;")}</pre>
        </div>
    </div>
    <script>
        function showTab(tab) {
            document.querySelectorAll('.tab-btn').forEach((b, i) => b.classList.toggle('active', (tab==='table' && i===0) || (tab==='json' && i===1)));
            document.getElementById('tab-table').classList.toggle('active', tab === 'table');
            document.getElementById('tab-json').classList.toggle('active', tab === 'json');
        }
        function copyText(val) {
            navigator.clipboard.writeText(val).then(() => alert('Copied to clipboard!'));
        }
        function copyJson() {
            const txt = document.getElementById('json-pre').innerText;
            navigator.clipboard.writeText(txt).then(() => alert('JSON copied to clipboard!'));
        }
    </script>
</body>
</html>`;
        return res.send(html);
    }
    return res.json(data);
}

const extRouter = express.Router();

extRouter.get("/extract", async (req, res) => {
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
        return sendExtractedResponse(req, res, data);
    } catch (err) {
        return res.status(500).json({ status: "error", message: err.message });
    }
});

extRouter.get("/extract/:type/:id", async (req, res) => {
    try {
        let { type, id } = req.params;
        let season = null;
        let episode = null;

        if (id.includes(":")) {
            const parts = id.split(":");
            id = parts[0];
            if (parts.length > 1) season = parseInt(parts[1]);
            if (parts.length > 2) episode = parseInt(parts[2]);
        }

        const data = await runUniversalExtraction(id, type, season, episode);
        return sendExtractedResponse(req, res, data);
    } catch (err) {
        return res.status(500).json({ status: "error", message: err.message });
    }
});

extRouter.get("/extract/series/:id/:season/:episode", async (req, res) => {
    try {
        const data = await runUniversalExtraction(req.params.id, "series", parseInt(req.params.season), parseInt(req.params.episode));
        return sendExtractedResponse(req, res, data);
    } catch (err) {
        return res.status(500).json({ status: "error", message: err.message });
    }
});

extRouter.get("/extract/anime/:id/:season/:episode", async (req, res) => {
    try {
        const data = await runUniversalExtraction(req.params.id, "anime", parseInt(req.params.season), parseInt(req.params.episode));
        return sendExtractedResponse(req, res, data);
    } catch (err) {
        return res.status(500).json({ status: "error", message: err.message });
    }
});

app.use("/ui", express.static(path.join(process.cwd(), "docs")));
app.use("/explorer", express.static(path.join(process.cwd(), "docs")));
app.use("/.netlify/functions/api", extRouter);
app.use("/api", extRouter);
app.use("/", extRouter);
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
