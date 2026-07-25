/**
 * Nuvio Stream Explorer | Frontend Dashboard Logic
 * Universal stream extraction engine UI with live JSON inspector, Extracted Links table, and HLS player.
 */

// Preset Backend API Endpoints from README.md
const API_PRESETS = {
    render: "https://nuvio-stremio-addon.onrender.com",
    netlify: "https://my-nuvio-stremio-addon.netlify.app/.netlify/functions/api",
    local: "http://localhost:3000",
    custom: ""
};

// State management
let currentBackendUrl = API_PRESETS.render;
let currentStreamsData = [];
let rawJsonResponse = null;
let activeFilterBadge = "all";

document.addEventListener("DOMContentLoaded", () => {
    // 1. Initialize Lucide Icons
    if (window.lucide) {
        lucide.createIcons();
    }

    // 2. Load Saved Backend Settings from LocalStorage
    initBackendSettings();

    // 3. Setup Event Listeners
    setupFormControls();
    setupTabControls();
    setupFilterControls();
    setupModalControls();
    setupQuickChips();
});

/**
 * Backend Settings & Persistence
 */
function initBackendSettings() {
    try {
        const savedPreset = localStorage.getItem("nuvio_api_preset") || "render";
        if (savedPreset === "netlify") {
            currentBackendUrl = API_PRESETS.netlify;
        } else {
            currentBackendUrl = API_PRESETS.render;
        }
    } catch (e) {
        currentBackendUrl = API_PRESETS.render;
    }
    updateStatusIndicator();
}

function updateStatusIndicator() {
    const statusText = document.getElementById("backend-status-text");
    const statusDot = document.querySelector(".status-dot");
    if (!statusText || !statusDot) return;

    if (currentBackendUrl.includes("localhost")) {
        statusText.textContent = "Local Dev API";
        statusDot.style.backgroundColor = "#38bdf8";
        statusDot.style.boxShadow = "0 0 8px #38bdf8";
    } else if (currentBackendUrl.includes("netlify")) {
        statusText.textContent = "Netlify API (Backup)";
        statusDot.style.backgroundColor = "#a855f7";
        statusDot.style.boxShadow = "0 0 8px #a855f7";
    } else {
        statusText.textContent = "Render Cloud API";
        statusDot.style.backgroundColor = "#10b981";
        statusDot.style.boxShadow = "0 0 8px #10b981";
    }
}

/**
 * Trigger Scrape from Dual Submit Buttons (Render vs Netlify)
 */
function triggerScrape(engineType) {
    if (engineType === "render") {
        currentBackendUrl = API_PRESETS.render;
        try { localStorage.setItem("nuvio_api_preset", "render"); } catch(e){}
    } else if (engineType === "netlify") {
        currentBackendUrl = API_PRESETS.netlify;
        try { localStorage.setItem("nuvio_api_preset", "netlify"); } catch(e){}
    }
    updateStatusIndicator();

    const mediaIdInput = document.getElementById("media-id");
    if (!mediaIdInput) return;
    const id = mediaIdInput.value.trim();
    const checkedRadio = document.querySelector('input[name="media-type"]:checked');
    const type = checkedRadio ? checkedRadio.value : "movie";
    const seasonInput = document.getElementById("season-num");
    const episodeInput = document.getElementById("episode-num");
    const season = seasonInput ? seasonInput.value || 1 : 1;
    const episode = episodeInput ? episodeInput.value || 1 : 1;

    if (!id) {
        showToast("⚠️ Please enter a valid IMDb or TMDB ID");
        mediaIdInput.focus();
        return;
    }

    executeExtraction(id, type, season, episode, engineType);
}
window.triggerScrape = triggerScrape;

/**
 * Form & Input Controls
 */
function setupFormControls() {
    const typeRadios = document.querySelectorAll('input[name="media-type"]');
    const episodeControls = document.getElementById("episode-controls");
    const mediaIdInput = document.getElementById("media-id");
    const btnClearId = document.getElementById("btn-clear-id");
    const scrapeForm = document.getElementById("scrape-form");
    const btnRender = document.getElementById("btn-submit-render");
    const btnNetlify = document.getElementById("btn-submit-netlify");

    if (btnRender) {
        btnRender.addEventListener("click", (e) => {
            e.preventDefault();
            triggerScrape("render");
        });
    }
    if (btnNetlify) {
        btnNetlify.addEventListener("click", (e) => {
            e.preventDefault();
            triggerScrape("netlify");
        });
    }

    // Toggle season/episode inputs based on media type
    typeRadios.forEach(radio => {
        radio.addEventListener("change", (e) => {
            document.querySelectorAll(".type-option").forEach(el => el.classList.remove("active"));
            if (e.target.closest(".type-option")) {
                e.target.closest(".type-option").classList.add("active");
            }
            if (episodeControls) {
                if (e.target.value === "series" || e.target.value === "anime") {
                    episodeControls.classList.remove("hidden");
                } else {
                    episodeControls.classList.add("hidden");
                }
            }
        });
    });

    // Clear ID button
    if (mediaIdInput && btnClearId) {
        mediaIdInput.addEventListener("input", () => {
            if (mediaIdInput.value.trim().length > 0) {
                btnClearId.classList.remove("hidden");
            } else {
                btnClearId.classList.add("hidden");
            }
        });

        btnClearId.addEventListener("click", () => {
            mediaIdInput.value = "";
            btnClearId.classList.add("hidden");
            mediaIdInput.focus();
        });
    }

    // Form Submission fallback (Enter key defaults to Render Primary)
    if (scrapeForm) {
        scrapeForm.addEventListener("submit", (e) => {
            e.preventDefault();
            triggerScrape("render");
        });
    }
}

/**
 * Execute Extraction Request against Backend API
 */
async function executeExtraction(id, type, season, episode, engineType = "render") {
    const btnRender = document.getElementById("btn-submit-render");
    const btnNetlify = document.getElementById("btn-submit-netlify");
    const activeBtn = engineType === "netlify" ? btnNetlify : btnRender;
    const spinner = activeBtn ? activeBtn.querySelector(".spinner") : null;

    const statusSection = document.getElementById("status-section");
    const resultsSection = document.getElementById("results-section");
    const progressBar = document.getElementById("progress-bar");
    const statusTitle = document.getElementById("status-title");

    // Build URL
    let apiUrl = `${currentBackendUrl}/extract?id=${encodeURIComponent(id)}&type=${type}`;
    if (type === "series" || type === "anime") {
        apiUrl += `&season=${season}&episode=${episode}`;
    }

    // UI state to Loading
    if (btnRender) btnRender.disabled = true;
    if (btnNetlify) btnNetlify.disabled = true;
    if (spinner) spinner.classList.remove("hidden");
    statusSection.classList.remove("hidden");
    resultsSection.classList.add("hidden");
    
    const serverName = engineType === "netlify" ? "Netlify Backup API" : "Render Primary API";
    statusTitle.textContent = `Crawling 61 Providers via ${serverName} for ${id.toUpperCase()}...`;

    // Smooth simulated progress bar (up to 90s)
    let progress = 5;
    progressBar.style.width = `${progress}%`;
    const progressInterval = setInterval(() => {
        if (progress < 92) {
            progress += Math.floor(Math.random() * 4) + 1;
            progressBar.style.width = `${progress}%`;
        }
    }, 1500);

    const startTime = performance.now();

    try {
        const response = await fetch(apiUrl, {
            method: "GET",
            headers: { "Accept": "application/json" }
        });

        clearInterval(progressInterval);
        progressBar.style.width = "100%";

        const elapsedSeconds = ((performance.now() - startTime) / 1000).toFixed(1);

        if (!response.ok) {
            throw new Error(`Server returned HTTP ${response.status}: ${response.statusText}`);
        }

        const data = await response.json();
        rawJsonResponse = data;

        // Flatten streams array
        let allStreams = [];
        let activeProvidersCount = 0;

        if (Array.isArray(data)) {
            data.forEach(providerObj => {
                if (providerObj.results && Array.isArray(providerObj.results) && providerObj.results.length > 0) {
                    activeProvidersCount++;
                    providerObj.results.forEach(stream => {
                        allStreams.push({
                            ...stream,
                            providerName: providerObj.provider || "Unknown"
                        });
                    });
                }
            });
        } else if (data.streams && Array.isArray(data.streams)) {
            allStreams = data.streams.map(s => ({ ...s, providerName: "Nuvio Engine" }));
            activeProvidersCount = allStreams.length > 0 ? 1 : 0;
        }

        currentStreamsData = allStreams;

        // Update Stats UI
        document.getElementById("stat-providers").textContent = activeProvidersCount;
        document.getElementById("stat-streams").textContent = allStreams.length;
        document.getElementById("stat-time").textContent = `${elapsedSeconds}s`;

        // Render Views
        renderStreamCards(allStreams);
        renderLinksTable(allStreams);
        renderRawJson(data);

        // Transition UI to Results
        setTimeout(() => {
            statusSection.classList.add("hidden");
            resultsSection.classList.remove("hidden");
            resultsSection.scrollIntoView({ behavior: "smooth", block: "start" });
            if (btnRender) btnRender.disabled = false;
            if (btnNetlify) btnNetlify.disabled = false;
            if (spinner) spinner.classList.add("hidden");
        }, 500);

        showToast(`✅ Successfully extracted ${allStreams.length} streams via ${serverName}!`);

    } catch (error) {
        clearInterval(progressInterval);
        if (btnRender) btnRender.disabled = false;
        if (btnNetlify) btnNetlify.disabled = false;
        if (spinner) spinner.classList.add("hidden");
        statusSection.classList.add("hidden");
        showToast(`❌ Extraction Failed on ${serverName}: ${error.message}`);
        console.error("Scraper Engine Error:", error);
    }
}

/**
 * Render Stream Cards into Grid
 */
function renderStreamCards(streams) {
    const grid = document.getElementById("streams-grid");
    const noResultsMsg = document.getElementById("no-streams-msg");
    grid.innerHTML = "";

    if (!streams || streams.length === 0) {
        noResultsMsg.classList.remove("hidden");
        return;
    }

    noResultsMsg.classList.add("hidden");

    streams.forEach((stream, index) => {
        const card = document.createElement("div");
        card.className = "stream-card";
        card.dataset.index = index;

        // Determine quality badge
        let qualityText = "720p / SD";
        let qualityClass = "";
        const titleStr = (stream.title || stream.name || "").toLowerCase();
        if (titleStr.includes("4k") || titleStr.includes("2160p") || titleStr.includes("uhd")) {
            qualityText = "4K • UHD";
            qualityClass = "quality-4k";
        } else if (titleStr.includes("1080p") || titleStr.includes("fhd")) {
            qualityText = "1080p • FHD";
            qualityClass = "quality-1080p";
        }

        // Meta tags
        const metaTags = [];
        if (titleStr.includes("hindi") || titleStr.includes("hin")) metaTags.push("🇮🇳 Hindi");
        if (titleStr.includes("sub") || titleStr.includes("eng")) metaTags.push("🇬🇧 Sub/Eng");
        if (titleStr.includes("bluray")) metaTags.push("💿 BluRay");
        if (titleStr.includes("10bit")) metaTags.push("✨ 10-Bit");

        // Format tags HTML
        let metaHtml = metaTags.map(tag => `<span class="meta-tag">${tag}</span>`).join("");
        if (metaTags.length === 0) metaHtml = `<span class="meta-tag">⚡ Fast Stream</span>`;

        // Extract clean display title
        let displayTitle = (stream.title || stream.name || "Direct Video Stream")
            .replace(/\\n/g, " • ")
            .replace(/\n/g, " • ");

        card.innerHTML = `
            <div class="stream-card-top">
                <span class="provider-badge">
                    <i data-lucide="shield-check" style="width: 14px; height: 14px;"></i>
                    ${escapeHtml(stream.providerName)}
                </span>
                <span class="quality-badge ${qualityClass}">${qualityText}</span>
            </div>
            <div class="stream-title">${escapeHtml(displayTitle)}</div>
            <div class="stream-meta-list">
                ${metaHtml}
            </div>
            <div class="stream-card-actions">
                <button type="button" class="btn-action-play" onclick="openPlayerModal(${index})">
                    <i data-lucide="play" style="width: 16px; height: 16px;"></i>
                    <span>Test Play</span>
                </button>
                <button type="button" class="btn-action-icon tooltip" data-tooltip="Copy URL" onclick="copyStreamUrl(${index})">
                    <i data-lucide="copy" style="width: 16px; height: 16px;"></i>
                </button>
                <a href="${stream.url}" target="_blank" rel="noopener" class="btn-action-icon tooltip" data-tooltip="Open Direct">
                    <i data-lucide="external-link" style="width: 16px; height: 16px;"></i>
                </a>
            </div>
        `;

        grid.appendChild(card);
    });

    if (window.lucide) lucide.createIcons();
}

/**
 * Render Extracted Links Table (Copy-Paste Friendly View)
 */
function renderLinksTable(streams) {
    const tbody = document.getElementById("links-table-body");
    const btnCopyAll = document.getElementById("btn-copy-all-links");
    if (!tbody) return;
    tbody.innerHTML = "";

    if (!streams || streams.length === 0) {
        tbody.innerHTML = `<tr><td colspan="5" style="text-align: center; padding: 2rem; color: var(--text-muted);">No stream URLs extracted.</td></tr>`;
        return;
    }

    streams.forEach((stream, index) => {
        const row = document.createElement("tr");
        let displayTitle = (stream.title || stream.name || "Direct Video Stream")
            .replace(/\\n/g, " • ")
            .replace(/\n/g, " • ");

        let qualityTag = "720p/SD";
        const titleLower = displayTitle.toLowerCase();
        if (titleLower.includes("4k") || titleLower.includes("2160") || titleLower.includes("uhd")) qualityTag = "4K UHD";
        else if (titleLower.includes("1080")) qualityTag = "1080p FHD";

        row.innerHTML = `
            <td style="font-family: var(--font-mono); color: var(--text-muted);">${index + 1}</td>
            <td><strong style="color: var(--accent-primary);">${escapeHtml(stream.providerName)}</strong></td>
            <td><span class="meta-tag" style="margin:0;">${qualityTag}</span> <small style="display:block; color: var(--text-muted); margin-top: 4px;">${escapeHtml(displayTitle)}</small></td>
            <td>
                <div class="link-url-cell" onclick="copyStreamUrl(${index})" title="Click to copy this URL">
                    ${escapeHtml(stream.url)}
                </div>
            </td>
            <td>
                <div class="tbl-actions">
                    <button type="button" class="btn-secondary" style="padding: 0.4rem 0.7rem; font-size: 0.8rem;" onclick="copyStreamUrl(${index})">
                        <i data-lucide="copy" style="width:14px; height:14px;"></i> Copy
                    </button>
                    <button type="button" class="btn-primary" style="padding: 0.4rem 0.7rem; font-size: 0.8rem;" onclick="openPlayerModal(${index})">
                        <i data-lucide="play" style="width:14px; height:14px;"></i> Play
                    </button>
                    <a href="${stream.url}" target="_blank" rel="noopener" class="btn-secondary" style="padding: 0.4rem 0.7rem; font-size: 0.8rem; display:inline-flex; align-items:center;">
                        <i data-lucide="external-link" style="width:14px; height:14px;"></i>
                    </a>
                </div>
            </td>
        `;
        tbody.appendChild(row);
    });

    if (btnCopyAll) {
        btnCopyAll.onclick = () => {
            const allUrls = streams.map(s => s.url).filter(Boolean).join("\n");
            navigator.clipboard.writeText(allUrls);
            showToast(`📋 Copied all ${streams.length} stream links (one per line) to clipboard!`);
        };
    }

    if (window.lucide) lucide.createIcons();
}

/**
 * Filter Controls
 */
function setupFilterControls() {
    const searchInput = document.getElementById("stream-filter-input");
    const badgeButtons = document.querySelectorAll(".filter-badge");
    if (!searchInput) return;

    searchInput.addEventListener("input", applyFilters);

    badgeButtons.forEach(btn => {
        btn.addEventListener("click", (e) => {
            badgeButtons.forEach(b => b.classList.remove("active"));
            e.target.classList.add("active");
            activeFilterBadge = e.target.dataset.filter;
            applyFilters();
        });
    });
}

function applyFilters() {
    const query = document.getElementById("stream-filter-input").value.toLowerCase();
    const cards = document.querySelectorAll(".stream-card");
    let visibleCount = 0;

    cards.forEach(card => {
        const index = card.dataset.index;
        const stream = currentStreamsData[index];
        if (!stream) return;

        const combinedStr = `${stream.providerName} ${stream.title || ""} ${stream.name || ""}`.toLowerCase();
        
        let matchesQuery = combinedStr.includes(query);
        let matchesBadge = true;

        if (activeFilterBadge === "4k") {
            matchesBadge = combinedStr.includes("4k") || combinedStr.includes("2160") || combinedStr.includes("uhd");
        } else if (activeFilterBadge === "1080p") {
            matchesBadge = combinedStr.includes("1080");
        } else if (activeFilterBadge === "720p") {
            matchesBadge = combinedStr.includes("720");
        } else if (activeFilterBadge === "hindi") {
            matchesBadge = combinedStr.includes("hindi") || combinedStr.includes("hin") || combinedStr.includes("multi");
        }

        if (matchesQuery && matchesBadge) {
            card.style.display = "flex";
            visibleCount++;
        } else {
            card.style.display = "none";
        }
    });

    const noResultsMsg = document.getElementById("no-streams-msg");
    if (visibleCount === 0 && currentStreamsData.length > 0) {
        noResultsMsg.classList.remove("hidden");
    } else {
        noResultsMsg.classList.add("hidden");
    }
}

/**
 * Raw JSON Inspector with Colorful Syntax Highlighting
 */
function renderRawJson(data) {
    const codeDisplay = document.getElementById("json-code-display");
    const jsonStr = JSON.stringify(data, null, 2);

    // Apply color-coded syntax highlighting
    codeDisplay.innerHTML = syntaxHighlightJson(jsonStr);

    document.getElementById("btn-copy-json").onclick = () => {
        navigator.clipboard.writeText(jsonStr);
        showToast("📋 Raw JSON copied to clipboard!");
    };

    document.getElementById("btn-download-json").onclick = () => {
        const blob = new Blob([jsonStr], { type: "application/json" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = `nuvio-streams-${Date.now()}.json`;
        a.click();
        URL.revokeObjectURL(url);
        showToast("💾 JSON file download started!");
    };
}

/**
 * Helper: Syntax Highlight JSON strings for vibrant display
 */
function syntaxHighlightJson(json) {
    json = json.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    return json.replace(/("(\\u[a-zA-Z0-9]{4}|\\[^u]|[^\\"])*"(\s*:)?|\b(true|false|null)\b|-?\d+(?:\.\d*)?(?:[eE][+\-]?\d+)?)/g, function (match) {
        let cls = 'json-number';
        if (/^"/.test(match)) {
            if (/:$/.test(match)) {
                cls = 'json-key';
            } else {
                if (match.includes('http://') || match.includes('https://')) {
                    cls = 'json-url';
                } else {
                    cls = 'json-string';
                }
            }
        } else if (/true|false/.test(match)) {
            cls = 'json-boolean';
        } else if (/null/.test(match)) {
            cls = 'json-null';
        }
        return '<span class="' + cls + '">' + match + '</span>';
    });
}

/**
 * Tab Toggling
 */
function setupTabControls() {
    const tabButtons = document.querySelectorAll(".tab-btn");
    tabButtons.forEach(btn => {
        btn.addEventListener("click", (e) => {
            const targetTab = e.target.closest(".tab-btn").dataset.tab;
            document.querySelectorAll(".tab-btn").forEach(b => b.classList.remove("active"));
            e.target.closest(".tab-btn").classList.add("active");

            document.querySelectorAll(".tab-pane").forEach(pane => pane.classList.add("hidden"));
            document.getElementById(targetTab).classList.remove("hidden");
        });
    });
}

/**
 * Quick Test Chips
 */
function setupQuickChips() {
    const chips = document.querySelectorAll(".quick-chips .chip");
    chips.forEach(chip => {
        chip.addEventListener("click", () => {
            const id = chip.dataset.id;
            const type = chip.dataset.type;
            const s = chip.dataset.s;
            const e = chip.dataset.e;

            document.getElementById("media-id").value = id;
            document.getElementById("btn-clear-id").classList.remove("hidden");

            const typeRadio = document.querySelector(`input[name="media-type"][value="${type}"]`);
            if (typeRadio) {
                typeRadio.checked = true;
                typeRadio.dispatchEvent(new Event("change"));
            }

            if (s && e) {
                document.getElementById("season-num").value = s;
                document.getElementById("episode-num").value = e;
            }

            // Trigger scrape using Render Primary by default
            triggerScrape("render");
        });
    });
}

/**
 * Modal Player & Settings
 */
function setupModalControls() {
    // Player modal close
    const btnClosePlayer = document.getElementById("btn-close-player");
    if (btnClosePlayer) {
        btnClosePlayer.addEventListener("click", closePlayerModal);
    }
    const videoModal = document.getElementById("video-modal");
    if (videoModal) {
        videoModal.addEventListener("click", (e) => {
            if (e.target.id === "video-modal") closePlayerModal();
        });
    }
}

function openPlayerModal(index) {
    const stream = currentStreamsData[index];
    if (!stream) return;

    const modal = document.getElementById("video-modal");
    const videoPlayer = document.getElementById("video-player");
    const playerError = document.getElementById("player-error");
    const playerTitle = document.getElementById("player-title");
    const playerMeta = document.getElementById("player-meta-info");
    const externalLink = document.getElementById("player-external-link");
    const btnCopyPlayerUrl = document.getElementById("btn-copy-player-url");

    playerTitle.textContent = `${stream.providerName} • Preview`;
    playerMeta.textContent = stream.title || stream.name || "Video Stream";
    externalLink.href = stream.url;
    btnCopyPlayerUrl.onclick = () => copyStreamUrl(index);

    modal.classList.remove("hidden");
    playerError.classList.add("hidden");
    videoPlayer.style.display = "block";

    // Playback via HLS.js or native HTML5 video
    if (Hls.isSupported() && stream.url && (stream.url.includes(".m3u8") || stream.url.includes("m3u8") || stream.url.includes("playlist"))) {
        if (window.hlsInstance) window.hlsInstance.destroy();
        const hls = new Hls();
        window.hlsInstance = hls;
        hls.loadSource(stream.url);
        hls.attachMedia(videoPlayer);
        hls.on(Hls.Events.MANIFEST_PARSED, () => {
            videoPlayer.play().catch(() => {});
        });
        hls.on(Hls.Events.ERROR, (event, data) => {
            if (data.fatal) {
                showPlayerError();
            }
        });
    } else if (videoPlayer.canPlayType("application/vnd.apple.mpegurl") && stream.url && stream.url.includes(".m3u8")) {
        // Apple Safari native HLS
        videoPlayer.src = stream.url;
        videoPlayer.addEventListener("loadedmetadata", () => {
            videoPlayer.play().catch(() => {});
        });
    } else {
        // Standard MP4/Direct stream
        videoPlayer.src = stream.url;
        videoPlayer.play().catch(() => {
            showPlayerError();
        });
    }

    videoPlayer.onerror = () => {
        showPlayerError();
    };
}

function showPlayerError() {
    const videoPlayer = document.getElementById("video-player");
    const playerError = document.getElementById("player-error");
    videoPlayer.style.display = "none";
    playerError.classList.remove("hidden");
}

function closePlayerModal() {
    const modal = document.getElementById("video-modal");
    const videoPlayer = document.getElementById("video-player");
    modal.classList.add("hidden");
    videoPlayer.pause();
    videoPlayer.src = "";
    if (window.hlsInstance) {
        window.hlsInstance.destroy();
        window.hlsInstance = null;
    }
}

function copyStreamUrl(index) {
    const stream = currentStreamsData[index];
    if (!stream) return;
    navigator.clipboard.writeText(stream.url);
    showToast(`📋 Copied ${stream.providerName} link to clipboard!`);
}

/**
 * Toast Notification Helper
 */
function showToast(message, duration = 3500) {
    const container = document.getElementById("toast-container");
    const toast = document.createElement("div");
    toast.className = "toast";
    toast.innerHTML = `<span>${message}</span>`;
    container.appendChild(toast);

    setTimeout(() => {
        toast.style.opacity = "0";
        toast.style.transform = "translateX(100%)";
        toast.style.transition = "all 0.3s ease";
        setTimeout(() => toast.remove(), 300);
    }, duration);
}

/**
 * Helper: Escape HTML string to prevent XSS in dynamic cards
 */
function escapeHtml(str) {
    if (!str) return "";
    return str
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#039;");
}
