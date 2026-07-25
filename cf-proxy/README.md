# ⚡ Nuvio Open-Source Cloudflare HLS & Stream Proxy

An open-source, serverless **Cloudflare Worker** designed to proxy HLS (`.m3u8`) playlists, video segments, subtitles, and direct video streams. It automatically handles CORS bypass, forwards custom headers (`Referer`, `User-Agent`, `Origin`), and rewrites `.m3u8` playlists so that every segment goes through the proxy seamlessly.

---

## 🌟 Why Do You Need This?
Many streaming servers protect their `.m3u8` video streams with:
1. **CORS (Cross-Origin Resource Sharing)** restrictions (blocking playback on web browsers or Stremio Web).
2. **Referer Verification** (requiring the exact origin domain in the HTTP headers).

By routing requests through this serverless Cloudflare Worker, your media player receives clean CORS headers (`Access-Control-Allow-Origin: *`) while the upstream streaming server receives the exact spoofed headers it expects!

---

## 🚀 One-Command Deployment (Free on Cloudflare)

You can host your own private instance of this proxy on Cloudflare Workers for free (up to 100,000 requests/day):

### 1. Install Wrangler CLI
Make sure you have Node.js installed, then install Cloudflare's official CLI:
```bash
npm install -g wrangler
```

### 2. Login to Cloudflare
```bash
wrangler login
```

### 3. Deploy the Worker
Navigate into this folder and run:
```bash
cd cf-proxy
npx wrangler deploy
```

Once deployed, terminal will print your live proxy URL, e.g.:
`https://nuvio-cf-proxy.<your-username>.workers.dev`

---

## 📖 How to Use

Simply append your target stream URL to the `url` query parameter of your worker:

```http
GET https://nuvio-cf-proxy.<your-username>.workers.dev/?url=https://example.com/movie.m3u8&Referer=https://example.com
```

### Supported Query Parameters:
| Parameter | Description | Required |
|---|---|---|
| `url` | The target media URL or `.m3u8` playlist | ✅ **Yes** |
| `Referer` | Custom upstream Referer header | ❌ No |
| `User-Agent` | Custom upstream User-Agent header | ❌ No |
| `Origin` | Custom upstream Origin header | ❌ No |
| `Cookie` | Forward custom cookies | ❌ No |
| `Authorization` | Forward token / auth headers | ❌ No |

---

## 🔧 Integrating with Nuvio / Stremio Addons
In your scraper or backend API (`api/index.js` / `netlify/functions/api.js`), point the `HLS_PROXY_URL` constant to your new Cloudflare Worker URL:

```javascript
const HLS_PROXY_URL = "https://nuvio-cf-proxy.<your-username>.workers.dev";
```

Now, all proxied streams in your web UI will automatically route through your personal high-speed Cloudflare Edge server! ⚡🛡️
