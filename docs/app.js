/**
 * Nuvio Stream Explorer | Frontend Dashboard Logic
 * Universal stream extraction engine UI with live JSON inspector and HLS player.
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
    const savedPreset = localStorage.getItem("nuvio_api_preset") || "render";
    const savedCustomUrl = localStorage.getItem("nuvio_custom_url") || "";

    const presetRadio = document.querySelector(`input[name="api-preset"][value="${savedPreset}"]`);
    if (presetRadio) presetRadio.checked = true;

    if (savedPreset === "custom" && savedCustomUrl) {
        document.getElementById("custom-api-url").value = savedCustomUrl;
        document.getElementById("custom-url-group").classList.remove("hidden");
        currentBackendUrl = savedCustomUrl.replace(/\/$/, "");
    } else {
        currentBackendUrl = API_PRESETS[savedPreset] || API_PRESETS.render;
    }

    updateStatusIndicator();
}

function updateStatusIndicator() {
    const statusText = document.getElementById("backend-status-text");
    const statusDot = document.querySelector(".status-dot");

    if (currentBackendUrl.includes("localhost")) {
        statusText.textContent = "Local Dev API";
        statusDot.style.backgroundColor = "#38bdf8";
        statusDot.style.boxShadow = "0 0 8px #38bdf8";
    } else if (currentBackendUrl.includes("netlify")) {
        statusText.textContent = "Netlify API";
        statusDot.style.backgroundColor = "#a855f7";
        statusDot.style.boxShadow = "0 0 8px #a855f7";
    } else {
        statusText.textContent = "Render Cloud API";
        statusDot.style.backgroundColor = "#10b981";
        statusDot.style.boxShadow = "0 0 8px #10b981";
    }
}

/**
 * Form & Input Controls
 */
function setupFormControls() {
    const typeRadios = document.querySelectorAll('input[name="media-type"]');
    const episodeControls = document.getElementById("episode-controls");
    const mediaIdInput = document.getElementById("media-id");
    const btnClearId = document.getElementById("btn-clear-id");
    const scrapeForm = document.getElementById("scrape-form");

    // Toggle season/episode inputs based on media type
    typeRadios.forEach(radio => {
        radio.addEventListener("change", (e) => {
            document.querySelectorAll(".type-option").forEach(el => el.classList.remove("active"));
            e.target.closest(".type-option").classList.add("active");

            if (e.target.value === "series" || e.target.value === "anime") {
                episodeControls.classList.remove("hidden");
            } else {
                episodeControls.classList.add("hidden");
            }
        });
    });

    // Clear ID button
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

    // Form Submission
    scrapeForm.addEventListener("submit", async (e) => {
        e.preventDefault();
        const id = mediaIdInput.value.trim();
        const type = document.querySelector('input[name="media-type"]:checked').value;
        const season = document.getElementById("season-num").value || 1;
        const episode = document.getElementById("episode-num").value || 1;

        if (!id) {
            showToast("⚠️ Please enter a valid IMDb or TMDB ID");
            return;
        }

        executeExtraction(id, type, season, episode);
    });
}

/**
 * Execute Extraction Request against Backend API
 */
async function executeExtraction(id, type, season, episode) {
    const btnSubmit = document.getElementById("btn-submit");
    const spinner = btnSubmit.querySelector(".spinner");
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
    btnSubmit.disabled = true;
    spinner.classList.remove("hidden");
    statusSection.classList.remove("hidden");
    resultsSection.classList.add("hidden");
    statusTitle.textContent = `Crawling 61 Providers for ${id.toUpperCase()}...`;

    // Smooth simulated progress bar (up to 90s)
    let progress = 5;
    progressBar.style.width = `${progress}%`;
    const progressInterval = setInterval(() => {
        if (progress < 90) {
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
        renderRawJson(data);

        // Transition UI to Results
        setTimeout(() => {
            statusSection.classList.add("hidden");
            resultsSection.classList.remove("hidden");
            resultsSection.scrollIntoView({ behavior: "smooth", block: "start" });
            btnSubmit.disabled = false;
            spinner.classList.add("hidden");
        }, 500);

        showToast(`✅ Successfully extracted ${allStreams.length} streams!`);

    } catch (error) {
        clearInterval(progressInterval);
        btnSubmit.disabled = false;
        spinner.classList.add("hidden");
        statusSection.classList.add("hidden");
        showToast(`❌ Extraction Failed: ${error.message}`);
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
 * Filter Controls
 */
function setupFilterControls() {
    const searchInput = document.getElementById("stream-filter-input");
    const badgeButtons = document.querySelectorAll(".filter-badge");

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
 * Raw JSON Inspector
 */
function renderRawJson(data) {
    const codeDisplay = document.getElementById("json-code-display");
    const jsonStr = JSON.stringify(data, null, 2);
    codeDisplay.textContent = jsonStr;

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

            // Trigger submit automatically
            document.getElementById("scrape-form").dispatchEvent(new Event("submit"));
        });
    });
}

/**
 * Modal Player & Settings
 */
function setupModalControls() {
    // Player modal close
    document.getElementById("btn-close-player").addEventListener("click", closePlayerModal);
    document.getElementById("video-modal").addEventListener("click", (e) => {
        if (e.target.id === "video-modal") closePlayerModal();
    });

    // Settings modal open/close
    document.getElementById("btn-settings").addEventListener("click", () => {
        document.getElementById("settings-modal").classList.remove("hidden");
    });
    document.getElementById("btn-close-settings").addEventListener("click", () => {
        document.getElementById("settings-modal").classList.add("hidden");
    });

    // Custom API URL toggle in settings
    const presetRadios = document.querySelectorAll('input[name="api-preset"]');
    presetRadios.forEach(radio => {
        radio.addEventListener("change", (e) => {
            if (e.target.value === "custom") {
                document.getElementById("custom-url-group").classList.remove("hidden");
            } else {
                document.getElementById("custom-url-group").classList.add("hidden");
            }
        });
    });

    // Save Settings
    document.getElementById("btn-save-settings").addEventListener("click", () => {
        const selectedPreset = document.querySelector('input[name="api-preset"]:checked').value;
        localStorage.setItem("nuvio_api_preset", selectedPreset);

        if (selectedPreset === "custom") {
            const customVal = document.getElementById("custom-api-url").value.trim();
            if (!customVal) {
                showToast("⚠️ Please specify a valid custom API URL");
                return;
            }
            localStorage.setItem("nuvio_custom_url", customVal);
            currentBackendUrl = customVal.replace(/\/$/, "");
        } else {
            currentBackendUrl = API_PRESETS[selectedPreset] || API_PRESETS.render;
        }

        updateStatusIndicator();
        document.getElementById("settings-modal").classList.add("hidden");
        showToast("⚙️ API backend endpoint updated successfully!");
    });
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
