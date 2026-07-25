# 🎬 Nuvio & Entertainment Stream Extraction Suite

[![GitHub Pages](https://img.shields.io/badge/GitHub%20Pages-Live%20UI-38bdf8?style=for-the-badge&logo=github)](https://lakshman-reddo-sudo.github.io/entertainment/)
[![Render API](https://img.shields.io/badge/Render-Primary%20API-4f46e5?style=for-the-badge&logo=render)](https://nuvio-stremio-addon.onrender.com)
[![Netlify API](https://img.shields.io/badge/Netlify-Backup%20API-00c7b7?style=for-the-badge&logo=netlify)](https://my-nuvio-stremio-addon.netlify.app)
[![Cloudflare Workers](https://img.shields.io/badge/Cloudflare-HLS%20Proxy-f38020?style=for-the-badge&logo=cloudflare)](./cf-proxy)

An all-in-one open-source **High-Performance Stream Extraction Engine**, featuring a responsive dark-mode Web UI, dual cloud backend APIs (Render Node.js + Netlify Serverless), 61 parallel stream scrapers, and an open-source Cloudflare Worker HLS/CORS Proxy.

---

## 🌟 Live Architecture & Endpoints

| Component | Technology | Live URL / Directory | Description |
|---|---|---|---|
| **🌐 Web UI** | GitHub Pages (Vanilla JS + CSS) | [Live Web App](https://lakshman-reddo-sudo.github.io/entertainment/) | Enter TMDB/IMDb IDs for Movies, TV Series, or Anime and instantly open extracted stream links in a new tab. |
| **⚡ Primary API** | Render (Node.js Express) | `https://nuvio-stremio-addon.onrender.com` | High-concurrency scraping server with 240s timeout for deep mirror resolution. |
| **🛡️ Backup API** | Netlify Serverless Functions | `https://my-nuvio-stremio-addon.netlify.app` | Auto-scaling backup API equipped with 22s scraper timeouts and a 24s safety race to guarantee zero crashes on AWS Lambda. |
| **⚡ HLS Proxy** | Cloudflare Workers | [`./cf-proxy`](./cf-proxy) | Open-source serverless stream proxy for bypassing CORS restrictions, spoofing Referer headers, and rewriting `.m3u8` manifests. |
| **📂 Scrapers** | Node.js Scraper Suite | [`./scrapers`](./scrapers) | 61 specialized local stream scrapers (movies, shows, anime, 4K/1080p). |

---

## 🚀 Key Features

- **⚡ Instant 1-Click Extraction**: Enter any TMDB or IMDb ID, choose your backend (Primary Render or Backup Netlify), and click! The extraction URL opens cleanly in a new tab with a sleek dark-mode HTML table or JSON format.
- **⚡ Open-Source Cloudflare HLS Proxy**: Included in the `/cf-proxy` directory. Route any `.m3u8` playlist or stream through Cloudflare Edge Workers to bypass CORS blocks and forward required headers (`Referer`, `User-Agent`, `Origin`).
- **🛡️ Bulletproof Serverless Execution**: Our Netlify backend features an intelligent 24-second global safety race that automatically gathers completed scraper results before AWS Lambda's 30-second hard execution limit.
- **🎬 61 Parallel Scrapers**: Supports premium sources including 4KHDHub, AnimeKai, CineFreak, HDHub4U, Movix, ShowBox, VidSrc, VidLink, UHDMovies, and more.
- **🌍 Universal Media Support**: Seamless extraction for Movies, TV Series (with Season & Episode selectors), and Anime.

---

## ⚡ Hosting Your Own Cloudflare HLS Proxy

Want to host your own private Edge proxy for streaming without CORS or Referer issues? We made our Cloudflare Worker proxy 100% open source!

1. Navigate to the proxy directory:
   ```bash
   cd cf-proxy
   ```
2. Install Cloudflare Wrangler CLI and deploy:
   ```bash
   npm install -g wrangler
   wrangler login
   npx wrangler deploy
   ```
3. Use your new Edge proxy URL anywhere:
   ```http
   GET https://nuvio-cf-proxy.<your-username>.workers.dev/?url=https://example.com/stream.m3u8&Referer=https://example.com
   ```

[👉 Read the full HLS Proxy Documentation](./cf-proxy/README.md)

---

## 🛠️ Local Development & Setup

1. **Clone the repository**:
   ```bash
   git clone https://github.com/lakshman-reddy-sudo/entertainment.git
   cd entertainment
   ```
2. **Install dependencies**:
   ```bash
   npm install
   ```
3. **Run local development server**:
   ```bash
   npm start
   # Server running on http://localhost:3000
   ```
4. **Test an extraction locally**:
   ```http
   GET http://localhost:3000/extract/movie/tt0816692
   ```

---

## 📜 License & Disclaimer

This project is open-source and licensed under the GNU General Public License v3.0.
**Disclaimer**: This project is for educational and testing purposes only. Users are responsible for ensuring their usage complies with applicable laws and regulations in their jurisdiction.

---

**Built with ❤️ for High-Performance Stream Extraction**
