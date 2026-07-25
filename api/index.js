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
    if (typeof url === "string" && (url.includes("api.themoviedb.org") || url.includes("api.tmdb.org")) && url.includes("api_key=")) {
        url = url.replace(/api_key=[^&]+/, "api_key=" + TMDB_API_KEY);
        url = url.replace("api.themoviedb.org", "api.tmdb.org");
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

        const scrapePromises = cachedManifest.scrapers.map(async (scraperInfo) => {
            if (!scraperInfo.enabled) return;
            
            const stType = args.type === "series" ? "tv" : args.type;
            if (!scraperInfo.supportedTypes.includes(stType)) return;

            const scraperModule = await loadNuvioScraper(scraperInfo.filename);
            if (!scraperModule || typeof scraperModule.getStreams !== "function") return;

            try {
                // Wait for the scraper with a 9.2 second timeout max
                const results = await Promise.race([
                    scraperModule.getStreams(baseId, stType, season, episode).catch(err => {
                        console.error(`Error running Nuvio scraper ${scraperInfo.name}:`, err.message);
                        return [];
                    }),
                    new Promise((_, reject) => setTimeout(() => reject(new Error('Scraper timeout')), process.env.VERCEL || process.env.RENDER ? 18000 : 9200))
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

                        // Remove behaviorHints.notWebReady so streams appear in Stremio Web
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

        // Wait for all scrapers to finish concurrently
        await Promise.allSettled(scrapePromises);
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
                    title: stream.title || "Stream",
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
        res.setHeader("Access-Control-Allow-Origin", "*");
        res.setHeader("Content-Type", "application/json");
        return res.status(200).json(data);
    } catch (err) {
        return res.status(500).json({ status: "error", message: err.message });
    }
});

app.get("/extract/movie/:id", async (req, res) => {
    try {
        const data = await runUniversalExtraction(req.params.id, "movie", null, null);
        res.setHeader("Access-Control-Allow-Origin", "*");
        return res.status(200).json(data);
    } catch (err) {
        return res.status(500).json({ status: "error", message: err.message });
    }
});

app.get("/extract/series/:id/:season/:episode", async (req, res) => {
    try {
        const data = await runUniversalExtraction(req.params.id, "series", parseInt(req.params.season), parseInt(req.params.episode));
        res.setHeader("Access-Control-Allow-Origin", "*");
        return res.status(200).json(data);
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
