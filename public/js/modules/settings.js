/**
 * settings.js
 * * Manages all functionality of the Settings page, including
 * data sources, player settings, and user management.
 */

import { appState, guideState, UIElements } from './state.js';
import { apiFetch, saveGlobalSetting, saveUserSetting, fetchAppVersion, fetchConfig } from './api.js';
// MODIFIED: Import isProcessingRunning for the button logic
import { showNotification, openModal, closeModal, showConfirm, setButtonLoadingState, showProcessingModal, isProcessingRunning } from './ui.js';
import { handleGuideLoad, handleSearchAndFilter, failedLogoUrls } from './guide.js';
import { navigate } from './ui.js';
import { ICONS } from './icons.js';
import { parseM3U } from './utils.js';

let currentSourceTypeForEditor = 'url';
let hardwareChecked = false; // Flag to prevent re-checking hardware on every UI update
let detectedHardwareInfo = null; // Store detected hardware info

// --- Group Filter State ---
let tempSelectedGroups = new Set();
let currentGroupEditorContext = null; // 'source-editor' or 'user-editor'
let currentGroupSourceId = null;


/**
 * Fetches the server's public IP and displays it.
 */
async function fetchAndDisplayPublicIp() {
    const displayEl = document.getElementById('public-ip-display');
    if (!displayEl) return;

    const res = await apiFetch('/api/public-ip');
    if (res && res.ok) {
        const data = await res.json();
        displayEl.textContent = data.publicIp || 'Could not determine IP.';
    } else {
        displayEl.textContent = 'Unavailable';
    }
}

/**
 * Fetches the app version and displays it.
 */
async function fetchAndDisplayAppVersion() {
    const displayEl = document.getElementById('app-version-display');
    if (!displayEl) return;

    const version = await fetchAppVersion();
    displayEl.textContent = version;
}


// --- NEW: Hardware Acceleration ---

/**
 * Adds default GPU-based profiles to settings if they don't already exist.
 * @param {object} hardware - The hardware detection object from the backend.
 */
async function addDefaultGpuProfiles(hardware) {
    const settings = guideState.settings;
    let changesMade = false;
    let settingsToSave = {};

    const streamProfiles = settings.streamProfiles || [];
    const dvrProfiles = settings.dvr?.recordingProfiles || [];
    const castProfiles = settings.castProfiles || [];

    // NVIDIA Profiles
    if (hardware.nvidia) {
        if (!streamProfiles.some(p => p.id === 'ffmpeg-nvidia')) {
            streamProfiles.push({ id: 'ffmpeg-nvidia', name: 'ffmpeg (NVIDIA NVENC)', command: '-user_agent "{userAgent}" -re -i "{streamUrl}" -c:v h264_nvenc -preset p6 -tune hq -c:a copy -f mpegts pipe:1', isDefault: true });
            changesMade = true;
        }
        if (!dvrProfiles.some(p => p.id === 'dvr-mp4-nvidia')) {
            dvrProfiles.push({ id: 'dvr-mp4-nvidia', name: 'NVIDIA NVENC MP4 (H.264/AAC)', command: '-user_agent "{userAgent}" -i "{streamUrl}" -c:v h264_nvenc -preset p6 -tune hq -c:a aac -b:a 128k -movflags +faststart -f mp4 "{filePath}"', isDefault: true });
            changesMade = true;
        }
        if (!castProfiles.some(p => p.id === 'cast-nvidia')) {
            castProfiles.push({ id: 'cast-nvidia', name: 'Cast (NVIDIA NVENC)', command: '-user_agent "{userAgent}" -i "{streamUrl}" -c:v h264_nvenc -preset p6 -tune hq -c:a aac -b:a 128k -movflags frag_keyframe+empty_moov+default_base_moof -f mp4 pipe:1', isDefault: false });
            changesMade = true;
        }
    }

    // Intel QSV Profiles
    if (hardware.intel_qsv) {
        if (!streamProfiles.some(p => p.id === 'ffmpeg-intel')) {
            streamProfiles.push({ id: 'ffmpeg-intel', name: 'ffmpeg (Intel QSV)', command: '-hwaccel qsv -c:v h264_qsv -i "{streamUrl}" -c:v h264_qsv -preset medium -c:a aac -b:a 128k -f mpegts pipe:1', isDefault: false });
            changesMade = true;
        }
        if (!dvrProfiles.some(p => p.id === 'dvr-mp4-intel')) {
            dvrProfiles.push({ id: 'dvr-mp4-intel', name: 'Intel QSV MP4 (H.264/AAC)', command: '-hwaccel qsv -c:v h264_qsv -i "{streamUrl}" -c:v h264_qsv -preset medium -c:a aac -b:a 128k -movflags +faststart -f mp4 "{filePath}"', isDefault: false });
            changesMade = true;
        }
        if (!castProfiles.some(p => p.id === 'cast-intel')) {
            castProfiles.push({ id: 'cast-intel', name: 'Cast (Intel QSV)', command: '-hwaccel qsv -c:v h264_qsv -i "{streamUrl}" -c:v h264_qsv -preset medium -c:a aac -b:a 128k -movflags frag_keyframe+empty_moov+default_base_moof -f mp4 pipe:1', isDefault: false });
            changesMade = true;
        }
    }

    // Intel VAAPI Profiles
    if (hardware.intel_vaapi) {
        if (!streamProfiles.some(p => p.id === 'ffmpeg-vaapi')) {
            streamProfiles.push({ id: 'ffmpeg-vaapi', name: 'ffmpeg (VA-API) Intel', command: '-hwaccel vaapi -hwaccel_output_format vaapi -i "{streamUrl}" -vf "format=nv12|vaapi,hwupload" -c:v h264_vaapi -preset medium -c:a aac -b:a 128k -f mpegts pipe:1', isDefault: false });
            changesMade = true;
        }
        if (!dvrProfiles.some(p => p.id === 'dvr-mp4-vaapi')) {
            dvrProfiles.push({ id: 'dvr-mp4-vaapi', name: 'Intel VA-API MP4 (H.264/AAC)', command: '-hwaccel vaapi -hwaccel_output_format vaapi -i "{streamUrl}" -vf \'format=nv12,hwupload\' -c:v h264_vaapi -preset medium -c:a aac -b:a 128k -movflags +faststart -f mp4 "{filePath}"', isDefault: false });
            changesMade = true;
        }
        if (!castProfiles.some(p => p.id === 'cast-vaapi')) {
            castProfiles.push({ id: 'cast-vaapi', name: 'Cast (VA-API Intel)', command: '-hwaccel vaapi -hwaccel_output_format vaapi -i "{streamUrl}" -vf "format=nv12|vaapi,hwupload" -c:v h264_vaapi -c:a aac -b:a 128k -movflags frag_keyframe+empty_moov+default_base_moof -f mp4 pipe:1', isDefault: false });
            changesMade = true;
        }
    }

    // Radeon/AMD Profiles
    if (hardware.radeon_vaapi) {
        if (!streamProfiles.some(p => p.id === 'ffmpeg-vaapi-amd')) {
            streamProfiles.push({ id: 'ffmpeg-vaapi-amd', name: 'ffmpeg (VA-API) Radeon/AMD', command: '-vaapi_device /dev/dri/renderD128 -hwaccel vaapi -hwaccel_output_format vaapi -i "{streamUrl}" -c:v h264_vaapi -c:a aac -b:a 128k -f mpegts pipe:1', isDefault: false });
            changesMade = true;
        }
        if (!dvrProfiles.some(p => p.id === 'dvr-mp4-radeon-vaapi')) {
            dvrProfiles.push({ id: 'dvr-mp4-radeon-vaapi', name: 'Radeon/AMD VA-API MP4 (H.264/AAC)', command: '-vaapi_device /dev/dri/renderD128 -hwaccel vaapi -hwaccel_output_format vaapi -i "{streamUrl}" -c:v h264_vaapi -preset medium -c:a aac -b:a 128k -movflags +faststart -f mp4 "{filePath}"', isDefault: false });
            changesMade = true;
        }
        if (!castProfiles.some(p => p.id === 'cast-vaapi-amd')) {
            castProfiles.push({ id: 'cast-vaapi-amd', name: 'Cast (VA-API Radeon/AMD)', command: '-vaapi_device /dev/dri/renderD128 -hwaccel vaapi -hwaccel_output_format vaapi -i "{streamUrl}" -c:v h264_vaapi -c:a aac -b:a 128k -movflags frag_keyframe+empty_moov+default_base_moof -f mp4 pipe:1', isDefault: false });
            changesMade = true;
        }
    }

    if (changesMade) {
        console.log('[SETTINGS] New GPU profiles detected. Saving to settings...');
        settingsToSave.streamProfiles = streamProfiles;
        settingsToSave.dvr = { ...settings.dvr, recordingProfiles: dvrProfiles };
        settingsToSave.castProfiles = castProfiles;

        const updatedSettings = await saveGlobalSetting(settingsToSave);
        if (updatedSettings) {
            guideState.settings = updatedSettings;
            showNotification('Detected GPU profiles have been added!', false, 4000);
            // We don't need to call updateUIFromSettings here because the function that called this one will do it.
        }
    }
}


/**
 * Populates the hardware info modal with details and example commands.
 * @param {object} hardware - The hardware detection object from the backend.
 */
function populateHardwareInfoModal(hardware) {
    let contentHTML = `<p class="text-sm">This system has detected hardware that can be used for transcoding, which can improve performance and reduce CPU usage. To use it, select one of the pre-configured GPU profiles in the "Active Stream Profile" or "Active Recording Profile" dropdowns, or create your own profile using the example commands below.</p>`;

    if (hardware.nvidia) {
        contentHTML += `
            <div class="mt-4 pt-4 border-t border-gray-700">
                <h4 class="text-lg font-semibold text-white">NVIDIA (NVENC)</h4>
                <p class="text-xs text-gray-400 mb-2">GPU: ${hardware.nvidia}</p>
                <p class="text-sm mb-2">Uses the NVIDIA hardware encoder. This is generally the most performant option if available.</p>
                <p class="text-sm font-semibold mb-1">Example Stream Command:</p>
                <pre class="bg-gray-900 p-2 rounded-md text-xs text-gray-300 font-mono"><code>-user_agent "{userAgent}" -re -i "{streamUrl}" -c:v h264_nvenc -preset p6 -tune hq -c:a copy -f mpegts pipe:1</code></pre>
                <p class="text-sm font-semibold mb-1 mt-2">Example Recording Command:</p>
                <pre class="bg-gray-900 p-2 rounded-md text-xs text-gray-300 font-mono"><code>-user_agent "{userAgent}" -i "{streamUrl}" -c:v h264_nvenc -preset p6 -tune hq -c:a aac -b:a 128k -movflags +faststart -f mp4 "{filePath}"</code></pre>
            </div>
        `;
    }

    if (hardware.intel_qsv) {
        contentHTML += `
            <div class="mt-4 pt-4 border-t border-gray-700">
                <h4 class="text-lg font-semibold text-white">Intel (Quick Sync Video)</h4>
                <p class="text-xs text-gray-400 mb-2">GPU: ${hardware.intel_qsv}</p>
                <p class="text-sm mb-2">Uses the integrated GPU on Intel processors. A great low-power option for transcoding.</p>
                <p class="text-sm font-semibold mb-1">Example Stream Command:</p>
                <pre class="bg-gray-900 p-2 rounded-md text-xs text-gray-300 font-mono"><code>-hwaccel qsv -c:v h264_qsv -i "{streamUrl}" -c:v h264_qsv -preset medium -c:a aac -b:a 128k -f mpegts pipe:1</code></pre>
                 <p class="text-sm font-semibold mb-1 mt-2">Example Recording Command:</p>
                <pre class="bg-gray-900 p-2 rounded-md text-xs text-gray-300 font-mono"><code>-hwaccel qsv -c:v h264_qsv -i "{streamUrl}" -c:v h264_qsv -preset medium -c:a aac -b:a 128k -movflags +faststart -f mp4 "{filePath}"</code></pre>
            </div>
        `;
    }

    if (hardware.intel_vaapi) {
        contentHTML += `
            <div class="mt-4 pt-4 border-t border-gray-700">
                <h4 class="text-lg font-semibold text-white">Intel (VA-API)</h4>
                <p class="text-xs text-gray-400 mb-2">GPU: ${hardware.intel_vaapi}</p>
                <p class="text-sm mb-2">Uses the integrated GPU on Intel processors. A great low-power option for transcoding.</p>
                <p class="text-sm font-semibold mb-1">Example Stream Command:</p>
                <pre class="bg-gray-900 p-2 rounded-md text-xs text-gray-300 font-mono"><code>-hwaccel vaapi -hwaccel_output_format vaapi -i "{streamUrl}" -vf "format=nv12|vaapi,hwupload" -c:v h264_vaapi -preset medium -c:a aac -b:a 128k -f mpegts pipe:1</code></pre>
                 <p class="text-sm font-semibold mb-1 mt-2">Example Recording Command:</p>
                <pre class="bg-gray-900 p-2 rounded-md text-xs text-gray-300 font-mono"><code>-hwaccel vaapi -hwaccel_output_format vaapi -i "{streamUrl}" -vf \'format=nv12,hwupload\' -c:v h264_vaapi -preset medium -c:a aac -b:a 128k -movflags +faststart -f mp4 "{filePath}"</code></pre>
            </div>
        `;
    }

    if (hardware.radeon_vaapi) {
        contentHTML += `
            <div class="mt-4 pt-4 border-t border-gray-700">
                <h4 class="text-lg font-semibold text-white">AMD Radeon (VA-API)</h4>
                <p class="text-xs text-gray-400 mb-2">GPU: ${hardware.radeon_vaapi}</p>
                <p class="text-sm mb-2">Uses the integrated GPU on Radeon processors. A great low-power option for transcoding.</p>
                <p class="text-sm font-semibold mb-1">Example Stream Command:</p>
                <pre class="bg-gray-900 p-2 rounded-md text-xs text-gray-300 font-mono"><code>-vaapi_device /dev/dri/renderD128 -hwaccel vaapi -hwaccel_output_format vaapi -i "{streamUrl}" -c:v h264_vaapi -qp 20 -vf scale_vaapi=format=nv12 -c:a aac -ac 2 -b:a 128k -f mpegts pipe:1</code></pre>
                 <p class="text-sm font-semibold mb-1 mt-2">Example Recording Command:</p>
                <pre class="bg-gray-900 p-2 rounded-md text-xs text-gray-300 font-mono"><code>-vaapi_device /dev/dri/renderD128 -hwaccel vaapi -hwaccel_output_format vaapi -i "{streamUrl}" -c:v h264_vaapi -preset medium -vf scale_vaapi=format=nv12 -c:a aac -ac 2 -b:a 128k -movflags +faststart -f mp4 "{filePath}"</code></pre>
            </div>
        `;
    }
    UIElements.hardwareInfoModalContent.innerHTML = contentHTML;
}


/**
 * Fetches detected hardware from the backend and updates the UI.
 */
async function handleHardwareDetection() {
    if (hardwareChecked) return detectedHardwareInfo;
    console.log('[SETTINGS] Fetching hardware acceleration info...');
    const res = await apiFetch('/api/hardware');
    if (res && res.ok) {
        hardwareChecked = true; // Mark as checked to prevent re-running
        const hardware = await res.json();
        detectedHardwareInfo = hardware;
        let infoText = 'None';

        if (hardware.nvidia) {
            infoText = hardware.nvidia;
            console.log(`[SETTINGS] NVIDIA GPU found: ${hardware.nvidia}`);
        }

        if (hardware.intel_qsv) {
            if (infoText !== 'None') {
                infoText += ` & ${hardware.intel_qsv}`;
            } else {
                infoText = hardware.intel_qsv;
            }
            console.log(`[SETTINGS] Intel QSV found.`);
        }

        if (hardware.intel_vaapi) {
            if (infoText !== 'None') {
                infoText += ` & ${hardware.intel_vaapi}`;
            } else {
                infoText = hardware.intel_vaapi;
            }
            console.log(`[SETTINGS] Intel VA-API found.`);
        }

        if (hardware.radeon_vaapi) {
            if (infoText !== 'None') {
                infoText += ` & ${hardware.radeon_vaapi}`;
            } else {
                infoText = hardware.radeon_vaapi;
            }
            console.log(`[SETTINGS] Radeon/AMD VA-API found.`);
        }

        UIElements.hardwareInfoText.textContent = infoText;

        if (hardware.nvidia || hardware.intel_qsv || hardware.intel_vaapi || hardware.radeon_vaapi) {
            UIElements.hardwareInfoBtn.classList.remove('hidden');
            populateHardwareInfoModal(hardware);
            // This will check for missing profiles, save them, and trigger a UI refresh if needed.
            await addDefaultGpuProfiles(hardware);
        }
        return hardware;
    } else {
        UIElements.hardwareInfoText.textContent = 'Could not detect hardware.';
        console.error('[SETTINGS] Failed to load hardware info from backend.');
        return null;
    }
}


// --- UI Rendering ---

// --- User Access State & Channel Statistics Helpers ---
let cachedUsersList = [];
let userEditorAccessState = {};

const USER_TAB_DEFINITIONS = [
    { id: 'guide', label: 'TV Guide', short: 'Guide' },
    { id: 'multiview', label: 'Multi-View', short: 'Multi-View' },
    { id: 'player', label: 'Single Player', short: 'Player' },
    { id: 'dvr', label: 'DVR Library', short: 'DVR' },
    { id: 'vod', label: 'VODs', short: 'VOD' },
    { id: 'notifications', label: 'Notifications', short: 'Alerts' }
];

const escapeHtmlAttr = (str = '') => String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

/**
 * Builds a lookup of live channels grouped by sourceId and group name from guideState.channels.
 */
const buildChannelStatsBySource = () => {
    const m3uSources = guideState.settings.m3uSources || [];
    const stats = {};
    m3uSources.forEach(src => {
        stats[src.id] = {
            source: src,
            totalChannels: 0,
            groups: new Map() // groupName -> Array<{ id, name, chno, group }>
        };
    });

    const channels = guideState.channels || [];
    channels.forEach(ch => {
        if (!ch || !ch.id) return;
        const underscoreIdx = ch.id.indexOf('_');
        if (underscoreIdx === -1) return;
        const sourceId = ch.id.substring(0, underscoreIdx);
        if (!stats[sourceId]) return;

        const groupName = ch.group || 'Uncategorized';
        if (!stats[sourceId].groups.has(groupName)) {
            stats[sourceId].groups.set(groupName, []);
        }
        stats[sourceId].groups.get(groupName).push({
            id: ch.id,
            name: ch.displayName || ch.name || 'Unknown Channel',
            chno: ch.chno || null,
            group: groupName
        });
        stats[sourceId].totalChannels++;
    });

    return stats;
};

// Cache of categorized groups { live: [], movie: [], series: [] } per sourceId
const cachedSourceGroupsMap = new Map();
const loadingSourceGroupsSet = new Set();

/**
 * Fetches and caches categorized groups (Live, VOD Movies, VOD Series) for a source.
 */
const fetchAndCacheSourceGroups = async (source, forceRefresh = false, onComplete = null) => {
    if (!source || !source.id) return null;
    if (!forceRefresh && cachedSourceGroupsMap.has(source.id)) {
        const cached = cachedSourceGroupsMap.get(source.id);
        if (typeof onComplete === 'function') onComplete(cached);
        return cached;
    }
    if (loadingSourceGroupsSet.has(source.id)) return null;

    loadingSourceGroupsSet.add(source.id);
    try {
        const payload = {
            type: source.type,
            sourceId: source.id,
            refresh: forceRefresh
        };
        if (source.type === 'url' || source.type === 'file') {
            payload.url = source.path;
        } else if (source.type === 'xc') {
            payload.xc = source.xc_data;
        }

        const res = await apiFetch('/api/sources/fetch-groups', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });

        let rawGroups = { live: [], movie: [], series: [] };
        if (res && res.ok) {
            const data = await res.json();
            const g = data.groups !== undefined ? data.groups : data;
            if (g && typeof g === 'object' && !Array.isArray(g)) {
                rawGroups.live = Array.isArray(g.live) ? [...g.live] : [];
                rawGroups.movie = Array.isArray(g.movie) ? [...g.movie] : [];
                rawGroups.series = Array.isArray(g.series) ? [...g.series] : [];
            } else if (Array.isArray(g)) {
                g.forEach(group => {
                    if (!group) return;
                    const gLower = group.toLowerCase();
                    if (gLower.includes('series') || gLower.includes('serie') || gLower.includes('show') || gLower.includes('season') || gLower.includes('stagion')) {
                        rawGroups.series.push(group);
                    } else if (gLower.includes('movie') || gLower.includes('film') || gLower.includes('cinema') || gLower.includes('vod')) {
                        rawGroups.movie.push(group);
                    } else {
                        rawGroups.live.push(group);
                    }
                });
            }
        }

        // Filter by the source's own selectedGroups whitelist if configured on the source
        if (source.selectedGroups && source.selectedGroups.length > 0) {
            let allowedSourceGroups = source.selectedGroups;
            if (typeof allowedSourceGroups === 'string') {
                try { allowedSourceGroups = JSON.parse(allowedSourceGroups); } catch (e) { }
            }
            if (Array.isArray(allowedSourceGroups) && allowedSourceGroups.length > 0) {
                const allowedSet = new Set(allowedSourceGroups);
                rawGroups.live = rawGroups.live.filter(x => allowedSet.has(x));
                rawGroups.movie = rawGroups.movie.filter(x => allowedSet.has(x));
                rawGroups.series = rawGroups.series.filter(x => allowedSet.has(x));
            }
        }

        rawGroups.live.sort((a, b) => a.localeCompare(b));
        rawGroups.movie.sort((a, b) => a.localeCompare(b));
        rawGroups.series.sort((a, b) => a.localeCompare(b));

        cachedSourceGroupsMap.set(source.id, rawGroups);

        // Reconcile legacy shared groups (if user was saved before Live/Movie/Series were separated)
        const st = userEditorAccessState[source.id];
        if (st && st._legacySharedGroups && st._legacySharedGroups.size > 0) {
            const legacySet = st._legacySharedGroups;
            delete st._legacySharedGroups;

            const matchedLive = rawGroups.live.filter(g => legacySet.has(g));
            const matchedMovie = rawGroups.movie.filter(g => legacySet.has(g));
            const matchedSeries = rawGroups.series.filter(g => legacySet.has(g));

            if (matchedMovie.length > 0 && matchedMovie.length < rawGroups.movie.length) {
                st.allMovieGroupsMode = false;
                st.movieGroups = new Set(matchedMovie);
            }
            if (matchedSeries.length > 0 && matchedSeries.length < rawGroups.series.length) {
                st.allSeriesGroupsMode = false;
                st.seriesGroups = new Set(matchedSeries);
            }
            // If legacy groups only contained VOD categories and 0 Live groups, heal Live TV back to All Groups
            if (matchedLive.length === 0 && (matchedMovie.length > 0 || matchedSeries.length > 0)) {
                st.allGroupsMode = true;
                st.groups.clear();
            } else if (matchedLive.length > 0) {
                st.allGroupsMode = matchedLive.length >= rawGroups.live.length;
                st.groups = st.allGroupsMode ? new Set() : new Set(matchedLive);
            }
        }

        return rawGroups;
    } catch (err) {
        console.warn(`[USER_ACCESS] Failed to fetch groups for source ${source.id}:`, err);
        return null;
    } finally {
        loadingSourceGroupsSet.delete(source.id);
        if (typeof onComplete === 'function') {
            onComplete(cachedSourceGroupsMap.get(source.id) || null);
        }
    }
};

/**
 * Computes how many channels a user can access and returns source/group summary badges.
 */
const calculateUserChannelAccess = (user, statsBySource) => {
    const m3uSources = guideState.settings.m3uSources || [];
    let totalChannels = 0;
    Object.values(statsBySource).forEach(s => { totalChannels += s.totalChannels; });

    const isAdmin = Boolean(user?.isAdmin || user?.id === 1);
    let allowedSources = null;
    if (!isAdmin && user?.allowed_sources) {
        try {
            const parsed = typeof user.allowed_sources === 'string'
                ? JSON.parse(user.allowed_sources)
                : user.allowed_sources;
            if (parsed && typeof parsed === 'object' && Object.keys(parsed).length > 0) {
                allowedSources = parsed;
            }
        } catch (e) {
            allowedSources = null;
        }
    }

    if (isAdmin || !allowedSources) {
        return {
            isUnrestricted: true,
            allowedChannels: totalChannels,
            totalChannels,
            sourceBadges: [{ label: 'ALL', isAll: true }]
        };
    }

    let allowedChannels = 0;
    const sourceBadges = [];

    m3uSources.forEach(src => {
        const perm = allowedSources[src.id];
        if (!perm || !perm.allowed) return;

        const srcStats = statsBySource[src.id];
        const totalGroupsCount = srcStats ? srcStats.groups.size : 0;
        const selectedGroups = Array.isArray(perm.groups) ? perm.groups : [];
        const allLiveGroups = perm.allLiveGroups !== undefined
            ? Boolean(perm.allLiveGroups)
            : (selectedGroups.length === 0);
        const excludedSet = new Set(Array.isArray(perm.excludedChannels) ? perm.excludedChannels : []);

        let srcAllowedChannels = 0;
        if (srcStats) {
            for (const [gName, chList] of srcStats.groups.entries()) {
                if (!allLiveGroups && !selectedGroups.includes(gName)) continue;
                chList.forEach(ch => {
                    if (!excludedSet.has(ch.id)) srcAllowedChannels++;
                });
            }
        }
        allowedChannels += srcAllowedChannels;

        const subParts = [];
        if (!allLiveGroups) {
            if (totalGroupsCount > 0) {
                subParts.push(`${selectedGroups.length}/${totalGroupsCount} live`);
            } else {
                subParts.push(`${selectedGroups.length} live`);
            }
        }
        if (perm.allMovieGroups === false) {
            const mCount = Array.isArray(perm.movieGroups) ? perm.movieGroups.length : 0;
            subParts.push(`${mCount} mov`);
        }
        if (perm.allSeriesGroups === false) {
            const sCount = Array.isArray(perm.seriesGroups) ? perm.seriesGroups.length : 0;
            subParts.push(`${sCount} ser`);
        }

        sourceBadges.push({
            label: src.name,
            subLabel: subParts.join(' · '),
            isAll: false
        });
    });

    return {
        isUnrestricted: false,
        allowedChannels,
        totalChannels,
        sourceBadges
    };
};

/**
 * Updates the live channel summary badge inside the User Editor Modal.
 */
const updateUserEditorChannelSummaryBadge = () => {
    const badge = document.getElementById('user-editor-channel-summary-badge');
    if (!badge) return;

    const isAdminChecked = Boolean(UIElements.userEditorIsAdmin?.checked);
    const statsBySource = buildChannelStatsBySource();
    let totalChannels = 0;
    Object.values(statsBySource).forEach(s => { totalChannels += s.totalChannels; });

    if (isAdminChecked) {
        badge.textContent = totalChannels > 0 ? `All ${totalChannels} Channels (Admin)` : 'All Channels (Admin)';
        badge.className = 'px-2.5 py-1 text-xs font-bold rounded-full bg-purple-950/80 text-purple-300 border border-purple-700/60';
        return;
    }

    let allowedCount = 0;
    let allowedSourcesCount = 0;
    const m3uSources = guideState.settings.m3uSources || [];

    m3uSources.forEach(src => {
        const st = userEditorAccessState[src.id];
        if (!st || !st.allowed) return;
        allowedSourcesCount++;
        const srcStats = statsBySource[src.id];
        if (!srcStats) return;

        for (const [gName, chList] of srcStats.groups.entries()) {
            if (!st.allGroupsMode && !st.groups.has(gName)) continue;
            chList.forEach(ch => {
                if (!st.excludedChannels.has(ch.id)) allowedCount++;
            });
        }
    });

    if (allowedSourcesCount === 0) {
        badge.textContent = `0 / ${totalChannels} Channels`;
        badge.className = 'px-2.5 py-1 text-xs font-bold rounded-full bg-red-950/80 text-red-300 border border-red-700/60';
    } else if (allowedCount === totalChannels && allowedSourcesCount === m3uSources.length) {
        badge.textContent = `All ${totalChannels} Channels`;
        badge.className = 'px-2.5 py-1 text-xs font-bold rounded-full bg-emerald-950/80 text-emerald-300 border border-emerald-700/60';
    } else {
        badge.textContent = `${allowedCount} / ${totalChannels} Channels`;
        badge.className = 'px-2.5 py-1 text-xs font-bold rounded-full bg-blue-950/80 text-blue-300 border border-blue-700/60';
    }
};

/**
 * Renders the 3-Tier (Source -> Inline [Live TV | VOD Movies | VOD Series] Groups -> Optional Specific Channels) tree inside the User Editor Modal.
 * @param {object|null} user - The user object (null for new user).
 * @param {boolean} preserveState - If true, re-renders using existing userEditorAccessState.
 */
const renderUserSourceList = (user, preserveState = false) => {
    const listEl = UIElements.userEditorSourceList;
    if (!listEl) return;
    listEl.innerHTML = '';

    const m3uSources = guideState.settings.m3uSources || [];
    const statsBySource = buildChannelStatsBySource();
    const searchInput = document.getElementById('user-editor-source-search');
    const searchTerm = (searchInput?.value || '').trim().toLowerCase();
    const isAdminChecked = Boolean(UIElements.userEditorIsAdmin?.checked);

    if (!preserveState) {
        userEditorAccessState = {};
        let allowedSources = null;
        if (user && user.allowed_sources && !user.isAdmin && user.id !== 1) {
            try {
                const parsed = typeof user.allowed_sources === 'string'
                    ? JSON.parse(user.allowed_sources)
                    : user.allowed_sources;
                if (parsed && typeof parsed === 'object' && Object.keys(parsed).length > 0) {
                    allowedSources = parsed;
                }
            } catch (e) {
                console.error("Error parsing user allowed_sources:", e);
            }
        }

        m3uSources.forEach(source => {
            let isAllowed = true;
            let allGroupsMode = true;
            let selectedGroups = [];
            let excludedChannels = [];
            let allMovieGroupsMode = true;
            let selectedMovieGroups = [];
            let allSeriesGroupsMode = true;
            let selectedSeriesGroups = [];
            let legacySharedGroups = null;

            if (allowedSources) {
                const perm = allowedSources[source.id];
                if (perm && perm.allowed) {
                    isAllowed = true;
                    selectedGroups = Array.isArray(perm.groups) ? perm.groups : [];
                    allGroupsMode = perm.allLiveGroups !== undefined
                        ? Boolean(perm.allLiveGroups)
                        : (selectedGroups.length === 0);
                    excludedChannels = Array.isArray(perm.excludedChannels) ? perm.excludedChannels : [];

                    if (perm.allMovieGroups !== undefined || Array.isArray(perm.movieGroups)) {
                        selectedMovieGroups = Array.isArray(perm.movieGroups) ? perm.movieGroups : [];
                        allMovieGroupsMode = perm.allMovieGroups !== undefined
                            ? Boolean(perm.allMovieGroups)
                            : (selectedMovieGroups.length === 0);
                    } else if (selectedGroups.length > 0) {
                        legacySharedGroups = new Set(selectedGroups);
                    }

                    if (perm.allSeriesGroups !== undefined || Array.isArray(perm.seriesGroups)) {
                        selectedSeriesGroups = Array.isArray(perm.seriesGroups) ? perm.seriesGroups : [];
                        allSeriesGroupsMode = perm.allSeriesGroups !== undefined
                            ? Boolean(perm.allSeriesGroups)
                            : (selectedSeriesGroups.length === 0);
                    } else if (selectedGroups.length > 0) {
                        legacySharedGroups = new Set(selectedGroups);
                    }
                } else {
                    isAllowed = false;
                }
            }

            userEditorAccessState[source.id] = {
                allowed: isAllowed,
                activeSubTab: 'live',
                allGroupsMode,
                groups: new Set(selectedGroups),
                excludedChannels: new Set(excludedChannels),
                allMovieGroupsMode,
                movieGroups: new Set(selectedMovieGroups),
                allSeriesGroupsMode,
                seriesGroups: new Set(selectedSeriesGroups),
                _legacySharedGroups: legacySharedGroups,
                expandedGroups: false,
                expandedChannelGroups: new Set()
            };

            // If we already have cached provider groups, reconcile legacy groups immediately
            if (legacySharedGroups && cachedSourceGroupsMap.has(source.id)) {
                fetchAndCacheSourceGroups(source, false);
            }
        });
    }

    if (m3uSources.length === 0) {
        listEl.innerHTML = `<div class="text-center text-gray-500 py-8 text-sm">No M3U or Xtream Codes sources configured yet.</div>`;
        updateUserEditorChannelSummaryBadge();
        return;
    }

    m3uSources.forEach(source => {
        const state = userEditorAccessState[source.id] || {
            allowed: true,
            activeSubTab: 'live',
            allGroupsMode: true,
            groups: new Set(),
            excludedChannels: new Set(),
            allMovieGroupsMode: true,
            movieGroups: new Set(),
            allSeriesGroupsMode: true,
            seriesGroups: new Set(),
            expandedGroups: false,
            expandedChannelGroups: new Set()
        };
        userEditorAccessState[source.id] = state;

        const srcStats = statsBySource[source.id] || { totalChannels: 0, groups: new Map() };
        const cachedCats = cachedSourceGroupsMap.get(source.id) || null;
        const isFetchingCats = loadingSourceGroupsSet.has(source.id);

        // Merge live groups from guideState.channels and cached provider categories
        const liveGroupSet = new Set(srcStats.groups.keys());
        if (cachedCats && Array.isArray(cachedCats.live)) {
            cachedCats.live.forEach(g => liveGroupSet.add(g));
        }
        const allLiveGroupNames = Array.from(liveGroupSet).sort((a, b) => a.localeCompare(b));
        const allMovieGroupNames = cachedCats ? cachedCats.movie : [];
        const allSeriesGroupNames = cachedCats ? cachedCats.series : [];

        // Calculate allowed live channels for this source
        let srcAllowedChannels = 0;
        let srcAllowedLiveGroupsCount = 0;
        if (state.allowed || isAdminChecked) {
            allLiveGroupNames.forEach(gName => {
                const groupAllowed = isAdminChecked || state.allGroupsMode || state.groups.has(gName);
                if (!groupAllowed) return;
                srcAllowedLiveGroupsCount++;
                const chList = srcStats.groups.get(gName) || [];
                chList.forEach(ch => {
                    if (isAdminChecked || !state.excludedChannels.has(ch.id)) {
                        srcAllowedChannels++;
                    }
                });
            });
        }

        // Filter items by searchTerm
        const matchingLiveGroupNames = searchTerm
            ? allLiveGroupNames.filter(gName => {
                if (source.name.toLowerCase().includes(searchTerm)) return true;
                if (gName.toLowerCase().includes(searchTerm)) return true;
                const chs = srcStats.groups.get(gName) || [];
                return chs.some(c => c.name.toLowerCase().includes(searchTerm) || (c.chno && String(c.chno).includes(searchTerm)));
            })
            : allLiveGroupNames;

        const matchingMovieGroupNames = searchTerm
            ? allMovieGroupNames.filter(gName => source.name.toLowerCase().includes(searchTerm) || gName.toLowerCase().includes(searchTerm))
            : allMovieGroupNames;

        const matchingSeriesGroupNames = searchTerm
            ? allSeriesGroupNames.filter(gName => source.name.toLowerCase().includes(searchTerm) || gName.toLowerCase().includes(searchTerm))
            : allSeriesGroupNames;

        if (searchTerm &&
            !source.name.toLowerCase().includes(searchTerm) &&
            matchingLiveGroupNames.length === 0 &&
            matchingMovieGroupNames.length === 0 &&
            matchingSeriesGroupNames.length === 0
        ) {
            return;
        }

        const isSourceEnabled = isAdminChecked || state.allowed;
        const showGroupsPanel = !isAdminChecked && isSourceEnabled && (state.expandedGroups || Boolean(searchTerm));

        // Automatically trigger category fetch when panel is expanded (or if legacy groups need reconciliation)
        if ((showGroupsPanel || state._legacySharedGroups) && !cachedCats && !isFetchingCats) {
            fetchAndCacheSourceGroups(source, false, () => {
                renderUserSourceList(user, true);
            });
        }

        const card = document.createElement('div');
        card.className = `rounded-xl border transition-all ${isSourceEnabled ? 'bg-gray-900/90 border-gray-700/80' : 'bg-gray-900/40 border-gray-800/70 opacity-70'}`;
        card.dataset.sourceId = source.id;

        const isAllUnrestricted = state.allGroupsMode && state.allMovieGroupsMode && state.allSeriesGroupsMode;
        const summaryParts = [];
        if (!state.allGroupsMode) {
            summaryParts.push(`Live ${state.groups.size}/${allLiveGroupNames.length || state.groups.size}`);
        }
        if (!state.allMovieGroupsMode) {
            summaryParts.push(`Movies ${state.movieGroups.size}${cachedCats ? `/${allMovieGroupNames.length}` : ''}`);
        }
        if (!state.allSeriesGroupsMode) {
            summaryParts.push(`Series ${state.seriesGroups.size}${cachedCats ? `/${allSeriesGroupNames.length}` : ''}`);
        }

        const groupSummaryLabel = isAdminChecked
            ? 'All Groups & VOD'
            : (!state.allowed
                ? 'Blocked'
                : (isAllUnrestricted
                    ? `All Groups & VOD`
                    : summaryParts.join(' · ')));

        const excludedCount = state.excludedChannels.size;
        const activeSubTab = state.activeSubTab || 'live';

        const liveTabBadgeText = state.allGroupsMode
            ? `All ${allLiveGroupNames.length}`
            : `${ srcAllowedLiveGroupsCount }/${allLiveGroupNames.length}`;
        const movieTabBadgeText = !cachedCats
            ? (state.allMovieGroupsMode ? 'All' : `${state.movieGroups.size}`)
            : (state.allMovieGroupsMode ? `All ${allMovieGroupNames.length}` : `${allMovieGroupNames.filter(g => state.movieGroups.has(g)).length}/${allMovieGroupNames.length}`);
        const seriesTabBadgeText = !cachedCats
            ? (state.allSeriesGroupsMode ? 'All' : `${state.seriesGroups.size}`)
            : (state.allSeriesGroupsMode ? `All ${allSeriesGroupNames.length}` : `${allSeriesGroupNames.filter(g => state.seriesGroups.has(g)).length}/${allSeriesGroupNames.length}`);

        card.innerHTML = `
            <div class="p-3 flex flex-wrap items-center justify-between gap-2">
                <label class="flex items-center gap-3 cursor-pointer min-w-0 flex-grow">
                    <input type="checkbox" class="user-source-checkbox h-4 w-4 text-blue-600 bg-gray-700 border-gray-600 rounded focus:ring-blue-500"
                        ${isSourceEnabled ? 'checked' : ''} ${isAdminChecked ? 'disabled' : ''}>
                    <div class="min-w-0">
                        <div class="flex items-center gap-2 flex-wrap">
                            <span class="text-sm font-bold text-white truncate">${escapeHtmlAttr(source.name)}</span>
                            <span class="px-1.5 py-0.5 text-[10px] font-bold uppercase rounded bg-gray-800 text-gray-300 border border-gray-700">${escapeHtmlAttr(source.type || 'm3u')}</span>
                            <span class="px-2 py-0.5 text-[11px] font-semibold rounded-full ${isSourceEnabled ? 'bg-blue-950/80 text-blue-300 border border-blue-700/50' : 'bg-gray-800 text-gray-500 border border-gray-700'}">
                                ${srcAllowedChannels} / ${srcStats.totalChannels} ch
                            </span>
                            ${excludedCount > 0 && !isAdminChecked && state.allowed ? `<span class="px-2 py-0.5 text-[10px] font-semibold rounded-full bg-amber-950/80 text-amber-300 border border-amber-700/50">${excludedCount} ch excluded</span>` : ''}
                            ${!isAdminChecked && state.allowed && (!state.allMovieGroupsMode || !state.allSeriesGroupsMode) ? `<span class="px-2 py-0.5 text-[10px] font-semibold rounded-full bg-purple-950/80 text-purple-300 border border-purple-700/50">VOD Filtered</span>` : ''}
                        </div>
                    </div>
                </label>

                <div class="flex items-center gap-1.5 flex-shrink-0">
                    <button type="button" class="user-toggle-groups-btn text-xs font-semibold py-1.5 px-3 rounded-lg border transition-colors flex items-center gap-1.5 ${isSourceEnabled && !isAdminChecked ? 'bg-gray-800 hover:bg-gray-700 text-gray-200 border-gray-600' : 'bg-gray-800/50 text-gray-500 border-gray-800 cursor-not-allowed'}"
                        ${isSourceEnabled && !isAdminChecked ? '' : 'disabled'}>
                        <span>${escapeHtmlAttr(groupSummaryLabel)}</span>
                        <svg class="w-3.5 h-3.5 transition-transform ${showGroupsPanel ? 'rotate-180' : ''}" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 9l-7 7-7-7"></path></svg>
                    </button>
                </div>
            </div>
            <div class="user-source-groups-panel ${showGroupsPanel ? '' : 'hidden'} border-t border-gray-800 bg-gray-950/50 px-3 py-2.5 space-y-2.5 rounded-b-xl">
                <div class="flex flex-wrap items-center justify-between gap-2 pb-2 border-b border-gray-800/80">
                    <div class="inline-flex items-center bg-gray-900 p-1 rounded-lg border border-gray-800 gap-1">
                        <button type="button" data-subtab="live" class="user-src-subtab-btn px-2.5 py-1 rounded-md text-xs font-semibold transition-colors flex items-center gap-1.5 ${activeSubTab === 'live' ? 'bg-blue-600 text-white shadow' : 'text-gray-400 hover:text-gray-200'}">
                            <span>Live TV</span>
                            <span class="px-1.5 py-0.2 text-[10px] rounded-full ${activeSubTab === 'live' ? 'bg-blue-800/80 text-blue-100' : 'bg-gray-800 text-gray-400'}">${liveTabBadgeText}</span>
                        </button>
                        <button type="button" data-subtab="movie" class="user-src-subtab-btn px-2.5 py-1 rounded-md text-xs font-semibold transition-colors flex items-center gap-1.5 ${activeSubTab === 'movie' ? 'bg-blue-600 text-white shadow' : 'text-gray-400 hover:text-gray-200'}">
                            <span>VOD Movies</span>
                            <span class="px-1.5 py-0.2 text-[10px] rounded-full ${activeSubTab === 'movie' ? 'bg-blue-800/80 text-blue-100' : 'bg-gray-800 text-gray-400'}">${isFetchingCats && !cachedCats ? '...' : movieTabBadgeText}</span>
                        </button>
                        <button type="button" data-subtab="series" class="user-src-subtab-btn px-2.5 py-1 rounded-md text-xs font-semibold transition-colors flex items-center gap-1.5 ${activeSubTab === 'series' ? 'bg-blue-600 text-white shadow' : 'text-gray-400 hover:text-gray-200'}">
                            <span>VOD Series</span>
                            <span class="px-1.5 py-0.2 text-[10px] rounded-full ${activeSubTab === 'series' ? 'bg-blue-800/80 text-blue-100' : 'bg-gray-800 text-gray-400'}">${isFetchingCats && !cachedCats ? '...' : seriesTabBadgeText}</span>
                        </button>
                    </div>
                    <div class="flex items-center gap-2 text-[11px]">
                        <button type="button" class="user-src-all-groups-btn text-blue-400 hover:text-blue-300 font-semibold">Select All</button>
                        <span class="text-gray-700">·</span>
                        <button type="button" class="user-src-no-groups-btn text-gray-400 hover:text-gray-200 font-semibold">Deselect All</button>
                        ${activeSubTab === 'live' && excludedCount > 0 ? `<span class="text-gray-700">·</span><button type="button" class="user-src-reset-channels-btn text-amber-400 hover:text-amber-300 font-semibold">Reset Channel Exclusions</button>` : ''}
                        <span class="text-gray-700">·</span>
                        <button type="button" class="user-src-refresh-cats-btn text-gray-400 hover:text-white font-semibold flex items-center gap-1" title="Force refresh categories from provider">
                            <svg class="w-3 h-3 ${isFetchingCats ? 'animate-spin text-blue-400' : ''}" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"></path></svg>
                            <span>Refresh</span>
                        </button>
                    </div>
                </div>
                <div class="user-source-groups-list space-y-1.5 max-h-64 overflow-y-auto custom-scrollbar pr-1"></div>
            </div>
        `;

        // Sub-tab switching (Live TV | VOD Movies | VOD Series)
        card.querySelectorAll('.user-src-subtab-btn').forEach(tabBtn => {
            tabBtn.addEventListener('click', () => {
                state.activeSubTab = tabBtn.dataset.subtab || 'live';
                renderUserSourceList(user, true);
            });
        });

        // Force refresh categories button
        card.querySelector('.user-src-refresh-cats-btn')?.addEventListener('click', () => {
            if (loadingSourceGroupsSet.has(source.id)) return;
            fetchAndCacheSourceGroups(source, true, () => {
                renderUserSourceList(user, true);
            });
            renderUserSourceList(user, true);
        });

        // Populate body according to activeSubTab
        const groupsListEl = card.querySelector('.user-source-groups-list');
        if (showGroupsPanel && groupsListEl) {
            if (activeSubTab === 'live') {
                if (matchingLiveGroupNames.length === 0) {
                    groupsListEl.innerHTML = `<div class="text-xs text-gray-500 py-3 text-center">${isFetchingCats ? 'Loading Live TV groups...' : 'No Live TV groups found for this source.'}</div>`;
                } else {
                    matchingLiveGroupNames.forEach(groupName => {
                        const chList = srcStats.groups.get(groupName) || [];
                        const isGroupChecked = state.allGroupsMode || state.groups.has(groupName);
                        const allowedInGroup = isGroupChecked
                            ? chList.filter(ch => !state.excludedChannels.has(ch.id)).length
                            : 0;

                        const isChannelsExpanded = state.expandedChannelGroups.has(groupName) ||
                            (Boolean(searchTerm) && !groupName.toLowerCase().includes(searchTerm) && chList.some(c => c.name.toLowerCase().includes(searchTerm)));

                        const groupWrap = document.createElement('div');
                        groupWrap.className = 'rounded-lg bg-gray-900/80 border border-gray-800/90 overflow-hidden';

                        const hasExcludedInGroup = chList.some(ch => state.excludedChannels.has(ch.id));

                        groupWrap.innerHTML = `
                            <div class="px-2.5 py-1.5 flex items-center justify-between gap-2 hover:bg-gray-800/50 transition-colors">
                                <label class="flex items-center gap-2.5 cursor-pointer min-w-0 flex-grow">
                                    <input type="checkbox" class="user-group-checkbox h-3.5 w-3.5 text-blue-600 bg-gray-700 border-gray-600 rounded focus:ring-blue-500"
                                        data-group-name="${escapeHtmlAttr(groupName)}" ${isGroupChecked ? 'checked' : ''}>
                                    <span class="text-xs font-medium ${isGroupChecked ? 'text-gray-200' : 'text-gray-500 line-through'} truncate">${escapeHtmlAttr(groupName)}</span>
                                </label>
                                ${chList.length > 0 ? `
                                <button type="button" class="user-expand-channels-btn text-[11px] font-semibold px-2 py-0.5 rounded border transition-colors flex items-center gap-1 flex-shrink-0 ${hasExcludedInGroup ? 'bg-amber-950/60 text-amber-300 border-amber-700/50' : 'bg-gray-800/80 hover:bg-gray-700 text-gray-400 hover:text-gray-200 border-gray-700/70'}"
                                    title="Expand to include/exclude specific channels in this group">
                                    <span>${allowedInGroup}/${chList.length} ch</span>
                                    <svg class="w-3 h-3 transition-transform ${isChannelsExpanded ? 'rotate-180' : ''}" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 9l-7 7-7-7"></path></svg>
                                </button>` : ''}
                            </div>
                            <div class="user-group-channels-panel ${isChannelsExpanded && chList.length > 0 ? '' : 'hidden'} border-t border-gray-800/80 bg-gray-950/80 px-3 py-2">
                                <div class="flex items-center justify-between text-[10px] text-gray-400 mb-1.5">
                                    <span>Specific channels in <strong>${escapeHtmlAttr(groupName)}</strong>:</span>
                                    <div class="flex gap-2">
                                        <button type="button" class="user-grp-ch-all text-blue-400 hover:text-blue-300 font-semibold">All</button>
                                        <span>·</span>
                                        <button type="button" class="user-grp-ch-none text-gray-400 hover:text-gray-200 font-semibold">None</button>
                                    </div>
                                </div>
                                <div class="user-group-channels-grid grid grid-cols-1 sm:grid-cols-2 gap-1 max-h-44 overflow-y-auto custom-scrollbar pr-1"></div>
                            </div>
                        `;

                        // Live Group checkbox toggle (strictly affects Live TV groups)
                        const grpCheckbox = groupWrap.querySelector('.user-group-checkbox');
                        grpCheckbox.addEventListener('change', (e) => {
                            const checked = e.target.checked;
                            if (state.allGroupsMode) {
                                state.allGroupsMode = false;
                                state.groups = new Set(allLiveGroupNames);
                            }
                            if (checked) {
                                state.groups.add(groupName);
                                if (allLiveGroupNames.length > 0 && state.groups.size >= allLiveGroupNames.length) {
                                    state.allGroupsMode = true;
                                    state.groups.clear();
                                }
                            } else {
                                state.groups.delete(groupName);
                            }
                            renderUserSourceList(user, true);
                        });

                        // Expand channels button (Tier 3)
                        const expandChBtn = groupWrap.querySelector('.user-expand-channels-btn');
                        expandChBtn?.addEventListener('click', () => {
                            if (state.expandedChannelGroups.has(groupName)) {
                                state.expandedChannelGroups.delete(groupName);
                            } else {
                                state.expandedChannelGroups.add(groupName);
                            }
                            renderUserSourceList(user, true);
                        });

                        // Populate Tier 3 Channels if expanded
                        if (isChannelsExpanded && chList.length > 0) {
                            const chGrid = groupWrap.querySelector('.user-group-channels-grid');
                            const visibleChannels = searchTerm && !groupName.toLowerCase().includes(searchTerm)
                                ? chList.filter(c => c.name.toLowerCase().includes(searchTerm) || (c.chno && String(c.chno).includes(searchTerm)))
                                : chList;

                            visibleChannels.forEach(ch => {
                                const isChAllowed = isGroupChecked && !state.excludedChannels.has(ch.id);
                                const chLabel = document.createElement('label');
                                chLabel.className = 'flex items-center gap-2 px-2 py-1 rounded hover:bg-gray-800/70 cursor-pointer text-[11px]';
                                chLabel.innerHTML = `
                                    <input type="checkbox" class="user-channel-checkbox h-3 w-3 text-blue-600 bg-gray-700 border-gray-600 rounded focus:ring-blue-500"
                                        ${isChAllowed ? 'checked' : ''} ${isGroupChecked ? '' : 'disabled'}>
                                    <span class="truncate ${isChAllowed ? 'text-gray-300' : 'text-gray-500 line-through'}">
                                        ${ch.chno ? `<strong class="text-gray-400 font-mono mr-1">${escapeHtmlAttr(ch.chno)}</strong>` : ''}${escapeHtmlAttr(ch.name)}
                                    </span>
                                `;
                                chLabel.querySelector('.user-channel-checkbox').addEventListener('change', (ev) => {
                                    if (ev.target.checked) {
                                        state.excludedChannels.delete(ch.id);
                                    } else {
                                        state.excludedChannels.add(ch.id);
                                    }
                                    renderUserSourceList(user, true);
                                });
                                chGrid.appendChild(chLabel);
                            });

                            groupWrap.querySelector('.user-grp-ch-all')?.addEventListener('click', () => {
                                chList.forEach(ch => state.excludedChannels.delete(ch.id));
                                renderUserSourceList(user, true);
                            });
                            groupWrap.querySelector('.user-grp-ch-none')?.addEventListener('click', () => {
                                chList.forEach(ch => state.excludedChannels.add(ch.id));
                                renderUserSourceList(user, true);
                            });
                        }

                        groupsListEl.appendChild(groupWrap);
                    });
                }
            } else if (activeSubTab === 'movie' || activeSubTab === 'series') {
                const isMovieTab = activeSubTab === 'movie';
                const allVodCats = isMovieTab ? allMovieGroupNames : allSeriesGroupNames;
                const matchingVodCats = isMovieTab ? matchingMovieGroupNames : matchingSeriesGroupNames;
                const allVodModeKey = isMovieTab ? 'allMovieGroupsMode' : 'allSeriesGroupsMode';
                const vodSetKey = isMovieTab ? 'movieGroups' : 'seriesGroups';

                if (isFetchingCats && !cachedCats) {
                    groupsListEl.innerHTML = `<div class="text-xs text-gray-400 py-4 text-center flex items-center justify-center gap-2"><svg class="w-4 h-4 animate-spin text-blue-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"></path></svg><span>Loading ${isMovieTab ? 'VOD Movie' : 'VOD Series'} categories...</span></div>`;
                } else if (matchingVodCats.length === 0) {
                    groupsListEl.innerHTML = `<div class="text-xs text-gray-500 py-3 text-center">No ${isMovieTab ? 'VOD Movie' : 'VOD Series'} categories found for this source.</div>`;
                } else {
                    const gridWrap = document.createElement('div');
                    gridWrap.className = 'grid grid-cols-1 sm:grid-cols-2 gap-1.5';

                    matchingVodCats.forEach(catName => {
                        const isCatChecked = state[allVodModeKey] || state[vodSetKey].has(catName);
                        const itemLabel = document.createElement('label');
                        itemLabel.className = 'px-2.5 py-1.5 rounded-lg bg-gray-900/80 border border-gray-800/90 hover:bg-gray-800/50 transition-colors flex items-center gap-2.5 cursor-pointer min-w-0';
                        itemLabel.innerHTML = `
                            <input type="checkbox" class="user-vod-group-checkbox h-3.5 w-3.5 text-blue-600 bg-gray-700 border-gray-600 rounded focus:ring-blue-500"
                                data-group-name="${escapeHtmlAttr(catName)}" ${isCatChecked ? 'checked' : ''}>
                            <span class="text-xs font-medium ${isCatChecked ? 'text-gray-200' : 'text-gray-500 line-through'} truncate">${escapeHtmlAttr(catName)}</span>
                        `;
                        itemLabel.querySelector('.user-vod-group-checkbox').addEventListener('change', (ev) => {
                            const checked = ev.target.checked;
                            if (state[allVodModeKey]) {
                                state[allVodModeKey] = false;
                                state[vodSetKey] = new Set(allVodCats);
                            }
                            if (checked) {
                                state[vodSetKey].add(catName);
                                if (allVodCats.length > 0 && state[vodSetKey].size >= allVodCats.length) {
                                    state[allVodModeKey] = true;
                                    state[vodSetKey].clear();
                                }
                            } else {
                                state[vodSetKey].delete(catName);
                            }
                            renderUserSourceList(user, true);
                        });
                        gridWrap.appendChild(itemLabel);
                    });

                    groupsListEl.appendChild(gridWrap);
                }
            }
        }

        // Source checkbox listener
        const srcCheckbox = card.querySelector('.user-source-checkbox');
        srcCheckbox.addEventListener('change', (e) => {
            state.allowed = e.target.checked;
            renderUserSourceList(user, true);
        });

        // Toggle inline groups panel button
        const toggleGroupsBtn = card.querySelector('.user-toggle-groups-btn');
        toggleGroupsBtn.addEventListener('click', () => {
            state.expandedGroups = !state.expandedGroups;
            renderUserSourceList(user, true);
        });

        // Select All / Deselect All inside the currently active sub-tab ONLY
        card.querySelector('.user-src-all-groups-btn')?.addEventListener('click', () => {
            if (activeSubTab === 'movie') {
                state.allMovieGroupsMode = true;
                state.movieGroups.clear();
            } else if (activeSubTab === 'series') {
                state.allSeriesGroupsMode = true;
                state.seriesGroups.clear();
            } else {
                state.allGroupsMode = true;
                state.groups.clear();
            }
            renderUserSourceList(user, true);
        });
        card.querySelector('.user-src-no-groups-btn')?.addEventListener('click', () => {
            if (activeSubTab === 'movie') {
                state.allMovieGroupsMode = false;
                state.movieGroups.clear();
            } else if (activeSubTab === 'series') {
                state.allSeriesGroupsMode = false;
                state.seriesGroups.clear();
            } else {
                state.allGroupsMode = false;
                state.groups.clear();
            }
            renderUserSourceList(user, true);
        });
        card.querySelector('.user-src-reset-channels-btn')?.addEventListener('click', () => {
            state.excludedChannels.clear();
            renderUserSourceList(user, true);
        });

        listEl.appendChild(card);
    });

    updateUserEditorChannelSummaryBadge();
};
const openUserGroupFilterModal = async (sourceId, selectedGroups, sourceName, btnElement) => {
    currentGroupEditorContext = 'user-editor';
    currentGroupSourceId = sourceId;

    // We need to fetch ALL groups for this source validation

    UIElements.groupFilterModal.querySelector('h3').textContent = `Select Groups for ${sourceName}`;

    // Show loading state
    btnElement.textContent = 'Loading...';
    btnElement.disabled = true;

    try {
        // We need the Source Object to send to /api/sources/fetch-groups
        const source = guideState.settings.m3uSources.find(s => s.id === sourceId);
        if (!source) throw new Error("Source not found");

        const payload = {
            type: source.type,
            sourceId: source.id
        };

        if (source.type === 'url') {
            payload.url = source.path;
        } else if (source.type === 'xc') {
            payload.xc = source.xc_data;
        } else if (source.type === 'file') {
            // For existing file sources, pass the path as 'url' (as per server logic)
            payload.url = source.path;
        }

        const res = await apiFetch('/api/sources/fetch-groups', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });

        let allGroups = [];
        if (res && res.ok) {
            const data = await res.json();
            if (data.groups) {
                allGroups = data.groups;
            } else if (Array.isArray(data)) {
                allGroups = data;
            }
        } else {
            // Fallback: extract from client state if available
            const sourceChannels = guideState.channels.filter(c => c.sourceId === sourceId);
            if (sourceChannels.length > 0) {
                allGroups = [...new Set(sourceChannels.map(c => c.group))];
            }
        }

        // --- FIX: Filter by Source's Own Whitelist ---
        // If the source itself is configured to only import specific groups,
        // we should only offer those groups to the user.
        console.log(`[DEBUG_USER_FILTER] Type of selectedGroups: ${typeof source.selectedGroups}`, source.selectedGroups);
        if (source.selectedGroups && source.selectedGroups.length > 0) {
            let allowedSourceGroups = source.selectedGroups;
            if (typeof allowedSourceGroups === 'string') {
                try { allowedSourceGroups = JSON.parse(allowedSourceGroups); } catch (e) { }
            }
            if (Array.isArray(allowedSourceGroups) && allowedSourceGroups.length > 0) {
                const allowedSet = new Set(allowedSourceGroups);
                if (allGroups && typeof allGroups === 'object' && !Array.isArray(allGroups)) {
                    allGroups = {
                        live: (allGroups.live || []).filter(g => allowedSet.has(g)),
                        movie: (allGroups.movie || []).filter(g => allowedSet.has(g)),
                        series: (allGroups.series || []).filter(g => allowedSet.has(g))
                    };
                } else if (Array.isArray(allGroups)) {
                    allGroups = allGroups.filter(g => allowedSet.has(g));
                }
            }
        }

        const totalCount = Array.isArray(allGroups)
            ? allGroups.length
            : ((allGroups?.live?.length || 0) + (allGroups?.movie?.length || 0) + (allGroups?.series?.length || 0));

        // If we still have no groups, maybe just show the passed selected groups?
        if (totalCount === 0 && selectedGroups.length > 0) {
            allGroups = [...selectedGroups];
        }

        populateUserGroupFilterModal(allGroups, selectedGroups);
        const modal = document.getElementById('user-group-filter-modal');
        openModal(modal);

        // Attach the btnElement to the modal so we can update it on save
        modal._triggerBtn = btnElement;

    } catch (e) {
        showNotification("Failed to fetch groups: " + e.message, true);
    } finally {
        btnElement.textContent = 'VOD / Modal';
        btnElement.disabled = false;
    }
};

// --- Reusable Group Filter Logic ---

const populateGroupFilterModal = (allGroups, selectedGroups) => {
    tempSelectedGroups.clear();
    (selectedGroups || []).forEach(group => tempSelectedGroups.add(group));
    const groups = { live: [], movie: [], series: [] };

    if (allGroups && typeof allGroups === 'object' && !Array.isArray(allGroups)) {
        groups.live = Array.isArray(allGroups.live) ? [...allGroups.live] : [];
        groups.movie = Array.isArray(allGroups.movie) ? [...allGroups.movie] : [];
        groups.series = Array.isArray(allGroups.series) ? [...allGroups.series] : [];
    } else if (Array.isArray(allGroups)) {
        allGroups.forEach(group => {
            if (!group) return;
            const gLower = group.toLowerCase();
            // Check series keywords FIRST so series containing 'vod' aren't wrongly categorized as movies
            if (gLower.includes('series') || gLower.includes('serie') || gLower.includes('show') || gLower.includes('season') || gLower.includes('stagion')) {
                groups.series.push(group);
            } else if (gLower.includes('movie') || gLower.includes('film') || gLower.includes('cinema') || gLower.includes('vod')) {
                groups.movie.push(group);
            } else {
                groups.live.push(group);
            }
        });
    }

    UIElements.groupFilterModal.dataset.groups = JSON.stringify(groups);
    UIElements.groupFilterTabLive.textContent = `Live (${groups.live.length})`;
    UIElements.groupFilterTabMovies.textContent = `VOD - Movies (${groups.movie.length})`;
    UIElements.groupFilterTabSeries.textContent = `VOD - Series (${groups.series.length})`;

    updateGroupFilterList('live', Array.from(tempSelectedGroups));
    UIElements.groupFilterTabLive.classList.add('active');
    UIElements.groupFilterTabMovies.classList.remove('active');
    UIElements.groupFilterTabSeries.classList.remove('active');
    UIElements.groupFilterSearch.value = '';
};

// --- NEW: Dedicated Helper Functions for User Group Filter to ensure isolation ---

const populateUserGroupFilterModal = (allGroups, selectedGroups) => {
    tempSelectedGroups.clear();
    (selectedGroups || []).forEach(group => tempSelectedGroups.add(group));
    const groups = { live: [], movie: [], series: [] };

    if (allGroups && typeof allGroups === 'object' && !Array.isArray(allGroups)) {
        groups.live = Array.isArray(allGroups.live) ? [...allGroups.live] : [];
        groups.movie = Array.isArray(allGroups.movie) ? [...allGroups.movie] : [];
        groups.series = Array.isArray(allGroups.series) ? [...allGroups.series] : [];
    } else if (Array.isArray(allGroups)) {
        allGroups.forEach(group => {
            if (!group) return;
            const gLower = group.toLowerCase();
            // Check series keywords FIRST so series containing 'vod' aren't wrongly categorized as movies
            if (gLower.includes('series') || gLower.includes('serie') || gLower.includes('show') || gLower.includes('season') || gLower.includes('stagion')) {
                groups.series.push(group);
            } else if (gLower.includes('movie') || gLower.includes('film') || gLower.includes('cinema') || gLower.includes('vod')) {
                groups.movie.push(group);
            } else {
                groups.live.push(group);
            }
        });
    }

    const modal = document.getElementById('user-group-filter-modal');
    modal.dataset.groups = JSON.stringify(groups);

    // Update User Modal Tabs
    document.getElementById('user-group-filter-tab-live').textContent = `Live (${groups.live.length})`;
    document.getElementById('user-group-filter-tab-movies').textContent = `VOD - Movies (${groups.movie.length})`;
    document.getElementById('user-group-filter-tab-series').textContent = `VOD - Series (${groups.series.length})`;

    updateUserGroupFilterList('live', Array.from(tempSelectedGroups));

    // Reset Tab State
    document.getElementById('user-group-filter-tab-live').classList.add('active', 'bg-blue-600', 'text-white');
    document.getElementById('user-group-filter-tab-movies').classList.remove('active', 'bg-blue-600', 'text-white');
    document.getElementById('user-group-filter-tab-series').classList.remove('active', 'bg-blue-600', 'text-white');
    document.getElementById('user-group-filter-search').value = '';
};

const updateUserGroupFilterList = (type, selectedGroups, searchTerm = '') => {
    const listEl = document.getElementById('user-group-filter-list');
    const modal = document.getElementById('user-group-filter-modal');
    const allCategorizedGroups = JSON.parse(modal.dataset.groups || '{}');
    const groupsForType = allCategorizedGroups[type] || [];
    const re = new RegExp(searchTerm.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    const filteredGroups = groupsForType.filter(g => re.test(g));
    const currentSelectedSet = new Set(selectedGroups);

    if (filteredGroups.length === 0) {
        listEl.innerHTML = `<p class="text-gray-500 col-span-full text-center">No groups found.</p>`;
        return;
    }

    listEl.innerHTML = filteredGroups.map(group => `
        <div class="group-filter-item ${currentSelectedSet.has(group) ? 'selected' : ''}" data-group-name="${group.replace(/"/g, '&quot;')}">
            ${group}
        </div>
    `).join('');
};

const switchUserGroupFilterTab = (type) => {
    // Sync current selection first
    const listEl = document.getElementById('user-group-filter-list');
    const currentListItems = listEl.querySelectorAll('.group-filter-item');
    currentListItems.forEach(item => {
        const groupName = item.dataset.groupName;
        if (item.classList.contains('selected')) {
            tempSelectedGroups.add(groupName);
        } else {
            tempSelectedGroups.delete(groupName);
        }
    });

    const tabs = {
        'live': document.getElementById('user-group-filter-tab-live'),
        'movie': document.getElementById('user-group-filter-tab-movies'),
        'series': document.getElementById('user-group-filter-tab-series')
    };

    Object.keys(tabs).forEach(t => {
        const tab = tabs[t];
        if (type === t) {
            tab.classList.add('active', 'bg-blue-600', 'text-white');
            tab.classList.remove('bg-gray-700', 'text-gray-400');
        } else {
            tab.classList.remove('active', 'bg-blue-600', 'text-white');
            tab.classList.add('bg-gray-700', 'text-gray-400');
        }
    });

    updateUserGroupFilterList(type, Array.from(tempSelectedGroups), document.getElementById('user-group-filter-search').value);
};


const updateGroupFilterList = (type, selectedGroups, searchTerm = '') => {
    const listEl = UIElements.groupFilterList;
    const allCategorizedGroups = JSON.parse(UIElements.groupFilterModal.dataset.groups || '{}');
    const groupsForType = allCategorizedGroups[type] || [];
    const re = new RegExp(searchTerm.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'); // Safe regex
    const filteredGroups = groupsForType.filter(g => re.test(g));
    const currentSelectedSet = new Set(selectedGroups);

    if (filteredGroups.length === 0) {
        listEl.innerHTML = `<p class="text-gray-500 col-span-full text-center">No groups found.</p>`;
        return;
    }

    listEl.innerHTML = filteredGroups.map(group => `
        <div class="group-filter-item ${currentSelectedSet.has(group) ? 'selected' : ''}" data-group-name="${group.replace(/"/g, '&quot;')}">
            ${group}
        </div>
    `).join('');
};

const switchGroupFilterTab = (type) => {
    const currentListItems = UIElements.groupFilterList.querySelectorAll('.group-filter-item');
    currentListItems.forEach(item => {
        const groupName = item.dataset.groupName;
        if (item.classList.contains('selected')) {
            tempSelectedGroups.add(groupName);
        } else {
            tempSelectedGroups.delete(groupName);
        }
    });
    UIElements.groupFilterTabLive.classList.toggle('active', type === 'live');
    UIElements.groupFilterTabMovies.classList.toggle('active', type === 'movie');
    UIElements.groupFilterTabSeries.classList.toggle('active', type === 'series');

    updateGroupFilterList(type, Array.from(tempSelectedGroups), UIElements.groupFilterSearch.value);

    UIElements.groupFilterTabLive.className = `group-filter-tab-btn tab-button ${type === 'live' ? 'active bg-blue-600 text-white' : 'bg-gray-700 text-gray-400'}`;
    UIElements.groupFilterTabMovies.className = `group-filter-tab-btn tab-button ${type === 'movie' ? 'active bg-blue-600 text-white' : 'bg-gray-700 text-gray-400'}`;
    UIElements.groupFilterTabSeries.className = `group-filter-tab-btn tab-button ${type === 'series' ? 'active bg-blue-600 text-white' : 'bg-gray-700 text-gray-400'}`;
};



/**
 * Populates the timezone selector dropdown.
 */
export const populateTimezoneSelector = () => {
    UIElements.timezoneOffsetSelect.innerHTML = '';
    for (let i = 14; i >= -12; i--) {
        UIElements.timezoneOffsetSelect.innerHTML += `<option value="${i}">UTC${i >= 0 ? '+' : ''}${i}:00</option>`;
    }
};

/**
 * Renders the M3U or EPG source table.
 * @param {('m3u'|'epg')} sourceType - The type of source to render.
 */
const renderSourceTable = (sourceType) => {
    const tbody = UIElements[`${sourceType}SourcesTbody`];
    const sources = guideState.settings[`${sourceType}Sources`] || [];
    tbody.innerHTML = '';

    if (sources.length === 0) {
        tbody.innerHTML = `<tr><td colspan="8" class="text-center text-gray-500 py-4">No ${sourceType.toUpperCase()} sources added.</td></tr>`;
        return;
    }

    sources.forEach(source => {
        const pathDisplay = source.type === 'file' ? (source.path.split('/').pop() || source.path.split('\\').pop()) : source.path;
        const lastUpdated = new Date(source.lastUpdated).toLocaleString();
        const refreshText = (source.type === 'url' || source.type === 'xc') && source.refreshHours > 0 ? `Every ${source.refreshHours}h` : 'Disabled';
        const tr = document.createElement('tr');
        tr.dataset.sourceId = source.id;
        tr.innerHTML = `
            <td>${source.name}</td>
            <td><span class="px-2 inline-flex text-xs leading-5 font-semibold rounded-full ${source.type === 'file' ? 'bg-blue-200 text-blue-800' : 'bg-purple-200 text-purple-800'}">${source.type}</span></td>
            <td class="max-w-xs truncate" title="${pathDisplay}">${pathDisplay}</td>
            <td><span class="text-xs font-medium text-gray-400">${source.statusMessage || 'N/A'}</span></td>
            <td>${lastUpdated}</td>
            <td>${refreshText}</td>
            <td>
                <label class="switch">
                    <input type="checkbox" class="activate-switch" ${source.isActive ? 'checked' : ''}>
                    <span class="slider"></span>
                </label>
            </td>
            <td class="text-right">
                <div class="flex items-center justify-end gap-3">
                    <button class="action-btn edit-source-btn" title="Edit Source">
                        ${ICONS.edit}
                    </button>
                     <button class="action-btn delete-source-btn" title="Delete Source">
                        ${ICONS.trash}
                    </button>
                </div>
            </td>
        `;
        tbody.appendChild(tr);
    });
};

/**
 * Updates all settings UI elements based on the current state.
 * MODIFIED: Removed redundant admin checks as this page is now admin-only.
 */
export const updateUIFromSettings = async () => {
    const settings = guideState.settings;

    // One-time timezone auto-detection and setting MUST run synchronously before any await
    // so that initial guide rendering does not race with /api/hardware and render in UTC+0.
    const timezoneSetFlag = localStorage.getItem('vini_timezone_auto_set');
    const browserOffset = Math.round(-(new Date().getTimezoneOffset() / 60));
    if (!timezoneSetFlag) {
        settings.timezoneOffset = browserOffset;
        console.log(`[SETTINGS] First-run timezone detection. Setting to browser offset: ${browserOffset} and saving.`);
        if (appState.currentUser?.isAdmin) {
            saveGlobalSetting({ timezoneOffset: browserOffset });
        }
        localStorage.setItem('vini_timezone_auto_set', 'true');
    } else if (settings.timezoneOffset === undefined || settings.timezoneOffset === null || Number.isNaN(Number(settings.timezoneOffset))) {
        settings.timezoneOffset = browserOffset;
    } else {
        settings.timezoneOffset = Number(settings.timezoneOffset);
    }

    // Run hardware detection which may add new profiles to the state
    const hardware = await handleHardwareDetection();

    try {
        const userTimezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
        if (userTimezone && UIElements.detectedTimezoneInfo) {
            UIElements.detectedTimezoneInfo.textContent = `We've pre-selected your browser's timezone (${userTimezone}).`;
            UIElements.detectedTimezoneInfo.classList.remove('hidden');
        }
    } catch (e) {
        console.warn("Could not detect user's IANA timezone.", e);
    }

    settings.searchScope = settings.searchScope || 'all_channels_unfiltered';
    settings.playerLogLevel = settings.playerLogLevel || 'warning';
    settings.dvrLogLevel = settings.dvrLogLevel || 'warning';
    settings.notificationLeadTime = settings.notificationLeadTime ?? 10;

    settings.dvr = settings.dvr || {};
    settings.dvr.preBufferMinutes = settings.dvr.preBufferMinutes ?? 1;
    settings.dvr.postBufferMinutes = settings.dvr.postBufferMinutes ?? 2;
    settings.dvr.maxConcurrentRecordings = settings.dvr.maxConcurrentRecordings ?? 1;
    settings.dvr.autoDeleteDays = settings.dvr.autoDeleteDays ?? 0;

    // Update dropdowns and inputs
    UIElements.timezoneOffsetSelect.value = settings.timezoneOffset;
    fetchAndDisplayPublicIp();
    fetchAndDisplayAppVersion();
    UIElements.searchScopeSelect.value = settings.searchScope;
    UIElements.playerLogLevelSelect.value = settings.playerLogLevel;
    UIElements.dvrLogLevelSelect.value = settings.dvrLogLevel;
    if (UIElements.clientTelemetryToggle) {
        UIElements.clientTelemetryToggle.checked = settings.clientTelemetryEnabled === true;
    }
    UIElements.notificationLeadTimeInput.value = settings.notificationLeadTime;

    // Update DVR inputs
    if (UIElements.dvrPreBufferInput) UIElements.dvrPreBufferInput.value = settings.dvr.preBufferMinutes;
    if (UIElements.dvrPostBufferInput) UIElements.dvrPostBufferInput.value = settings.dvr.postBufferMinutes;
    if (UIElements.dvrMaxStreamsInput) UIElements.dvrMaxStreamsInput.value = settings.dvr.maxConcurrentRecordings;
    if (UIElements.dvrStorageDeleteDays) UIElements.dvrStorageDeleteDays.value = settings.dvr.autoDeleteDays;

    // Update Log Management inputs
    settings.logs = settings.logs || { maxFiles: 5, maxFileSizeBytes: 5 * 1024 * 1024, autoDeleteDays: 7 };
    if (UIElements.logMaxFilesInput) UIElements.logMaxFilesInput.value = settings.logs.maxFiles;
    if (UIElements.logMaxSizeInput) UIElements.logMaxSizeInput.value = Math.round(settings.logs.maxFileSizeBytes / (1024 * 1024));
    if (UIElements.logAutoDeleteDaysInput) UIElements.logAutoDeleteDaysInput.value = settings.logs.autoDeleteDays;

    // Update Logo & Image Cache Management toggles and stats
    if (UIElements.storeLogosInternallyToggle) {
        UIElements.storeLogosInternallyToggle.checked = settings.storeLogosInternally !== false;
    }
    if (UIElements.smartLogoMatchingToggle) {
        UIElements.smartLogoMatchingToggle.checked = settings.smartLogoMatching !== false;
    }
    refreshLogoCacheInfo();

    // Fetch and display log info
    refreshLogInfo();

    // Render tables
    renderSourceTable('m3u');
    renderSourceTable('epg');

    // Helper to populate select elements
    const populateSelect = (selectId, items, activeId) => {
        const selectEl = UIElements[selectId];
        if (!selectEl) return;
        selectEl.innerHTML = '';
        (items || []).forEach(item => {
            const option = document.createElement('option');
            option.value = item.id;
            option.textContent = item.name;
            selectEl.appendChild(option);
        });
        if (activeId) selectEl.value = activeId;
    };

    populateSelect('userAgentSelect', settings.userAgents || [], settings.activeUserAgentId);

    // Filter stream profiles based on detected hardware
    const allProfiles = settings.streamProfiles || [];
    const filteredProfiles = allProfiles.filter(p => {
        // Always show default/basic profiles (but NOT ffmpeg-cast or fMP4 profiles)
        if (['redirect', 'ffmpeg-default'].includes(p.id)) return true;

        // Show NVIDIA profiles only if NVIDIA GPU detected
        if (p.id.includes('nvidia') && hardware?.nvidia) return true;

        // Show Intel QSV profiles only if Intel QSV detected
        if (p.id === 'ffmpeg-intel' && hardware?.intel_qsv) return true;

        // Show Intel VAAPI profiles only if Intel VAAPI detected
        if (p.id === 'ffmpeg-vaapi' && hardware?.intel_vaapi) return true;

        // Show AMD/Radeon VAAPI profiles only if Radeon VAAPI detected
        if (p.id === 'ffmpeg-vaapi-amd' && hardware?.radeon_vaapi) return true;

        // Hide hardware profiles and auto-selected Direct Player profiles (fMP4)
        const knownHardwareIds = ['ffmpeg-nvidia', 'ffmpeg-nvidia-reconnect', 'ffmpeg-intel', 'ffmpeg-vaapi', 'ffmpeg-vaapi-amd', 'ffmpeg-fmp4', 'ffmpeg-fmp4-nvidia'];
        if (knownHardwareIds.includes(p.id)) return false;

        return true; // Show custom profiles
    });

    populateSelect('streamProfileSelect', filteredProfiles, settings.activeStreamProfileId);
    populateSelect('streamProfileSelect', filteredProfiles, settings.activeStreamProfileId);

    // Filter DVR profiles based on detected hardware
    const allDvrProfiles = settings.dvr?.recordingProfiles || [];
    const filteredDvrProfiles = allDvrProfiles.filter(p => {
        // Always show default/basic profiles
        if (['dvr-ts-default', 'dvr-mp4-default'].includes(p.id)) return true;

        // Show NVIDIA profiles only if NVIDIA GPU detected
        if (p.id.includes('nvidia') && hardware?.nvidia) return true;

        // Show Intel QSV profiles only if Intel QSV detected
        if (p.id === 'dvr-mp4-intel' && hardware?.intel_qsv) return true;

        // Show Intel VAAPI profiles only if Intel VAAPI detected
        if (p.id === 'dvr-mp4-vaapi' && hardware?.intel_vaapi) return true;

        // Show AMD/Radeon VAAPI profiles only if Radeon VAAPI detected
        if (p.id === 'dvr-mp4-radeon-vaapi' && hardware?.radeon_vaapi) return true;

        // Hide others by default if they look like hardware profiles but hardware not found
        const knownHardwareIds = ['dvr-ts-nvidia', 'dvr-ts-nvidia-reconnect', 'dvr-mp4-nvidia', 'dvr-mp4-intel', 'dvr-mp4-vaapi', 'dvr-mp4-radeon-vaapi'];
        if (knownHardwareIds.includes(p.id)) return false;

        return true; // Show custom profiles
    });

    populateSelect('dvrRecordingProfileSelect', filteredDvrProfiles, settings.dvr?.activeRecordingProfileId);

    // Filter Cast profiles based on detected hardware
    const allCastProfiles = settings.castProfiles || [];
    const filteredCastProfiles = allCastProfiles.filter(p => {
        // Always show default cast profile
        if (p.id === 'cast-default') return true;

        // Show NVIDIA cast profiles only if NVIDIA GPU detected
        if (p.id === 'cast-nvidia' && hardware?.nvidia) return true;

        // Show Intel QSV cast profiles only if Intel QSV detected
        if (p.id === 'cast-intel' && hardware?.intel_qsv) return true;

        // Show Intel VAAPI cast profiles only if Intel VAAPI detected
        if (p.id === 'cast-vaapi' && hardware?.intel_vaapi) return true;

        // Show AMD/Radeon VAAPI cast profiles only if Radeon VAAPI detected
        if (p.id === 'cast-vaapi-amd' && hardware?.radeon_vaapi) return true;

        // Hide others by default if they look like hardware profiles but hardware not found
        const knownHardwareIds = ['cast-nvidia', 'cast-intel', 'cast-vaapi', 'cast-vaapi-amd'];
        if (knownHardwareIds.includes(p.id)) return false;

        return true; // Show custom profiles
    });

    populateSelect('castProfileSelect', filteredCastProfiles, settings.activeCastProfileId);

    // Update button states based on selection
    const selectedProfile = (settings.streamProfiles || []).find(p => p.id === UIElements.streamProfileSelect.value);
    UIElements.editStreamProfileBtn.disabled = !selectedProfile;
    UIElements.deleteStreamProfileBtn.disabled = !selectedProfile || selectedProfile.isDefault;

    const selectedUA = (settings.userAgents || []).find(ua => ua.id === UIElements.userAgentSelect.value);
    UIElements.editUserAgentBtn.disabled = !selectedUA;
    UIElements.deleteUserAgentBtn.disabled = !selectedUA || selectedUA.isDefault;

    const selectedRecordingProfile = (settings.dvr?.recordingProfiles || []).find(p => p.id === UIElements.dvrRecordingProfileSelect.value);
    UIElements.editDvrProfileBtn.disabled = !selectedRecordingProfile;
    UIElements.deleteDvrProfileBtn.disabled = !selectedRecordingProfile || selectedRecordingProfile?.isDefault;

    const selectedCastProfile = (settings.castProfiles || []).find(p => p.id === UIElements.castProfileSelect.value);
    UIElements.editCastProfileBtn.disabled = !selectedCastProfile;
    UIElements.deleteCastProfileBtn.disabled = !selectedCastProfile || selectedCastProfile?.isDefault;

    // FIX: Only refresh the user list if the current user is an admin.
    // This prevents errors for non-admin users during the initial app load.
    if (appState.currentUser?.isAdmin) {
        refreshUserList();
    }
};


// --- User Management (Admin) ---

let currentEditingUser = null;

const formatUserTimestamp = (rawTs, includeTime = false) => {
    if (!rawTs) return null;
    let normalized = String(rawTs).trim();
    if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(normalized)) {
        normalized = normalized.replace(' ', 'T') + 'Z';
    }
    const dt = new Date(normalized);
    if (isNaN(dt.getTime())) return rawTs;
    const pad = (n) => String(n).padStart(2, '0');
    const datePart = `${pad(dt.getDate())}/${pad(dt.getMonth() + 1)}/${dt.getFullYear()}`;
    if (!includeTime) return datePart;
    const timePart = `${pad(dt.getHours())}:${pad(dt.getMinutes())}:${pad(dt.getSeconds())}`;
    return `${datePart}, ${timePart}`;
};

const syncUserEditorAdminLockState = () => {
    const isAdminChecked = Boolean(UIElements.userEditorIsAdmin?.checked);
    if (UIElements.userEditorCanUseDvr) {
        if (isAdminChecked) UIElements.userEditorCanUseDvr.checked = true;
        UIElements.userEditorCanUseDvr.disabled = isAdminChecked;
    }
    const tabCheckboxes = document.querySelectorAll('#user-editor-tabs-grid .user-tab-checkbox');
    tabCheckboxes.forEach(cb => {
        if (isAdminChecked) cb.checked = true;
        cb.disabled = isAdminChecked;
    });
    const tabsCard = document.getElementById('user-editor-tabs-card');
    if (tabsCard) {
        tabsCard.classList.toggle('opacity-60', isAdminChecked);
    }
    renderUserSourceList(currentEditingUser, true);
};

/**
 * Renders the filtered user rows into #user-list.
 */
export const renderUserTableRows = () => {
    if (!UIElements.userList) return;
    const searchInput = document.getElementById('user-search-input');
    const countBadge = document.getElementById('user-count-badge');
    const tableContainer = document.getElementById('user-table-container');
    const noUsersMsg = document.getElementById('no-users-message');

    if (countBadge) {
        countBadge.textContent = String(cachedUsersList.length);
    }

    const query = (searchInput?.value || '').trim().toLowerCase();
    const filteredUsers = query
        ? cachedUsersList.filter(u =>
            (u.username || '').toLowerCase().includes(query) ||
            (u.isAdmin ? 'admin administrator' : 'user streamer').includes(query)
        )
        : cachedUsersList;

    if (filteredUsers.length === 0) {
        UIElements.userList.innerHTML = '';
        tableContainer?.classList.add('hidden');
        noUsersMsg?.classList.remove('hidden');
        return;
    }

    tableContainer?.classList.remove('hidden');
    noUsersMsg?.classList.add('hidden');

    const statsBySource = buildChannelStatsBySource();

    UIElements.userList.innerHTML = filteredUsers.map(user => {
        const isUserAdmin = Boolean(user.isAdmin || user.id === 1);
        const isCurrentUser = appState.currentUser && String(appState.currentUser.id) === String(user.id);
        const createdStr = formatUserTimestamp(user.created_at, false) || '—';
        const lastLoginStr = formatUserTimestamp(user.last_login, true);

        // Role / User Level cell
        const roleBadgeHtml = isUserAdmin
            ? `<div class="flex items-center gap-1.5">
                   <span class="px-2.5 py-1 inline-flex items-center gap-1.5 text-xs font-bold rounded-lg bg-purple-950/80 text-purple-300 border border-purple-700/60">
                       <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z"></path></svg>
                       Admin
                   </span>
               </div>`
            : `<div class="flex items-center gap-1.5 flex-wrap">
                   <span class="px-2.5 py-1 inline-flex items-center gap-1.5 text-xs font-semibold rounded-lg bg-gray-800 text-gray-300 border border-gray-600/80">
                       <svg class="w-3.5 h-3.5 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z"></path></svg>
                       Streamer
                   </span>
                   ${user.canUseDvr ? '<span class="px-2 py-0.5 text-[10px] font-bold uppercase rounded-md bg-blue-950/80 text-blue-300 border border-blue-700/50" title="Can schedule & record DVR">DVR Rec</span>' : ''}
               </div>`;

        // Password cell
        const hasPlainPassword = Boolean(user.password_plain);
        const passwordCellHtml = hasPlainPassword
            ? `<div class="flex items-center gap-1.5">
                   <span class="user-pwd-mask font-mono text-xs text-gray-400 tracking-widest select-all" data-plain="${escapeHtmlAttr(user.password_plain)}" data-shown="false">••••••••</span>
                   <button type="button" class="toggle-user-pwd-btn p-1 text-gray-400 hover:text-white rounded-md hover:bg-gray-700/60 transition-colors" title="Show / Hide Password">
                       <svg class="w-4 h-4 pointer-events-none" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                           <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"></path>
                           <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z"></path>
                       </svg>
                   </button>
                   <button type="button" class="copy-user-pwd-btn p-1 text-gray-400 hover:text-blue-400 rounded-md hover:bg-gray-700/60 transition-colors" data-plain="${escapeHtmlAttr(user.password_plain)}" data-username="${escapeHtmlAttr(user.username)}" title="Copy Password">
                       <svg class="w-3.5 h-3.5 pointer-events-none" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                           <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z"></path>
                       </svg>
                   </button>
               </div>`
            : `<div class="flex items-center gap-1.5">
                   <span class="font-mono text-xs text-gray-500 tracking-widest">••••••••</span>
                   <button type="button" class="edit-user-btn text-[11px] text-blue-400 hover:text-blue-300 underline" title="Log in as this user or set a password in Edit to make it viewable">Set/Cache</button>
               </div>`;

        // Visible Tabs cell
        let allowedTabsArr = null;
        if (!isUserAdmin && user.allowed_tabs) {
            try {
                const parsed = typeof user.allowed_tabs === 'string' ? JSON.parse(user.allowed_tabs) : user.allowed_tabs;
                if (Array.isArray(parsed)) allowedTabsArr = parsed;
            } catch (e) { }
        }
        let tabsCellHtml = '';
        if (isUserAdmin || !allowedTabsArr || allowedTabsArr.length >= USER_TAB_DEFINITIONS.length) {
            tabsCellHtml = `<span class="px-2 py-0.5 text-xs font-bold rounded-md bg-blue-950/70 text-blue-300 border border-blue-700/50">ALL</span>`;
        } else if (allowedTabsArr.length === 0) {
            tabsCellHtml = `<span class="px-2 py-0.5 text-xs font-semibold rounded-md bg-red-950/70 text-red-300 border border-red-700/50">None</span>`;
        } else {
            const pills = USER_TAB_DEFINITIONS
                .filter(t => allowedTabsArr.includes(t.id))
                .map(t => `<span class="px-2 py-0.5 text-[11px] font-medium rounded-md bg-gray-800 text-gray-300 border border-gray-700">${t.short}</span>`)
                .join('');
            tabsCellHtml = `<div class="flex flex-wrap gap-1 max-w-[210px]">${pills}</div>`;
        }

        // Channels & Sources cell
        const chAccess = calculateUserChannelAccess(user, statsBySource);
        const badgesHtml = chAccess.sourceBadges.length > 0
            ? chAccess.sourceBadges.map(b => b.isAll
                ? `<span class="px-2 py-0.5 text-xs font-bold rounded-md bg-emerald-950/80 text-emerald-300 border border-emerald-700/50">ALL</span>`
                : `<span class="px-2 py-0.5 text-xs font-medium rounded-md bg-gray-800 text-gray-200 border border-gray-700">${escapeHtmlAttr(b.label)}${b.subLabel ? ` <span class="text-gray-400 text-[10px]">(${escapeHtmlAttr(b.subLabel)})</span>` : ''}</span>`
            ).join('')
            : `<span class="px-2 py-0.5 text-xs font-semibold rounded-md bg-red-950/70 text-red-300 border border-red-700/50">No Sources</span>`;

        const chCountBadge = chAccess.totalChannels > 0
            ? `<span class="text-xs font-mono font-semibold ${chAccess.allowedChannels > 0 ? 'text-blue-300' : 'text-red-400'}">${chAccess.allowedChannels}${chAccess.isUnrestricted ? '' : `/${chAccess.totalChannels}`} ch</span>`
            : '';

        const channelsCellHtml = `<div class="flex flex-wrap items-center gap-1.5">${badgesHtml}${chCountBadge}</div>`;

        return `
            <tr data-user-id="${user.id}" class="hover:bg-gray-800/50 transition-colors">
                <td class="px-5 py-4 whitespace-nowrap text-sm">${roleBadgeHtml}</td>
                <td class="px-5 py-4 whitespace-nowrap text-sm font-bold text-white">
                    <div class="flex items-center gap-2">
                        <span>${escapeHtmlAttr(user.username)}</span>
                        ${isCurrentUser ? '<span class="px-1.5 py-0.5 text-[10px] font-semibold rounded bg-blue-600/20 text-blue-300 border border-blue-500/30">You</span>' : ''}
                    </div>
                </td>
                <td class="px-5 py-4 whitespace-nowrap text-xs text-gray-300 font-mono">${escapeHtmlAttr(createdStr)}</td>
                <td class="px-5 py-4 whitespace-nowrap text-xs ${lastLoginStr ? 'text-gray-300 font-mono' : 'text-gray-500 italic'}">${lastLoginStr ? escapeHtmlAttr(lastLoginStr) : 'Never'}</td>
                <td class="px-5 py-4 whitespace-nowrap text-sm">${passwordCellHtml}</td>
                <td class="px-5 py-4 text-sm">${tabsCellHtml}</td>
                <td class="px-5 py-4 text-sm">${channelsCellHtml}</td>
                <td class="px-5 py-4 whitespace-nowrap text-right text-sm font-medium">
                    <div class="inline-flex items-center justify-end gap-1">
                        <button type="button" class="edit-user-btn p-2 text-gray-300 hover:text-blue-400 hover:bg-gray-700/60 rounded-lg transition-colors" title="Edit User">
                            <svg class="w-4 h-4 pointer-events-none" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z"></path></svg>
                        </button>
                        <button type="button" class="delete-user-btn p-2 text-gray-400 hover:text-red-400 hover:bg-gray-700/60 rounded-lg transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
                            title="${isCurrentUser ? 'Cannot delete your own account' : 'Delete User'}"
                            ${isCurrentUser || user.id === 1 ? 'disabled' : ''}>
                            <svg class="w-4 h-4 pointer-events-none" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"></path></svg>
                        </button>
                    </div>
                </td>
            </tr>
        `;
    }).join('');
};

/**
 * Fetches the user list from the server and renders it.
 */
export const refreshUserList = async () => {
    try {
        const res = await apiFetch('/api/users');
        if (!res) return;
        cachedUsersList = await res.json();
        renderUserTableRows();
    } catch (error) {
        console.error("Failed to refresh user list:", error);
        if (UIElements.userList) {
            UIElements.userList.innerHTML = `<tr><td colspan="8" class="text-center text-red-400 py-6">Failed to load users.</td></tr>`;
        }
    }
};

/**
 * Opens the user editor modal, optionally pre-filled with user data.
 * @param {object|null} user - The user object to edit, or null to add a new user.
 */
const openUserEditor = (user = null) => {
    currentEditingUser = user;
    UIElements.userEditorId.value = user ? user.id : '';
    UIElements.userEditorUsername.value = user ? user.username : '';

    // Password setup: pre-fill stored password_plain if editing an existing user so admin can view or edit it
    const pwdInput = UIElements.userEditorPassword;
    const pwdStatus = document.getElementById('user-editor-password-status');
    const pwdHint = document.getElementById('user-editor-password-hint');
    if (pwdInput) {
        pwdInput.type = 'password';
        pwdInput.required = !user;
        if (user) {
            pwdInput.value = user.password_plain || '';
            pwdInput.placeholder = user.password_plain ? 'Enter password...' : 'Leave blank to keep current password';
            if (pwdStatus) {
                pwdStatus.textContent = user.password_plain ? 'Stored (click eye to reveal)' : 'Not cached yet';
                pwdStatus.className = user.password_plain ? 'text-[11px] text-emerald-400' : 'text-[11px] text-gray-500';
            }
            if (pwdHint) {
                pwdHint.textContent = user.password_plain
                    ? 'Click the eye icon to view the current password, or type a new one to change it.'
                    : 'Leave blank to keep current password, or type a new password to update and cache it.';
            }
        } else {
            pwdInput.value = '';
            pwdInput.placeholder = 'Enter password for new user...';
            if (pwdStatus) pwdStatus.textContent = 'Required';
            if (pwdHint) pwdHint.textContent = 'Use the dice icon to generate a strong password.';
        }
    }

    const isUserAdmin = Boolean(user && (user.isAdmin || user.id === 1));
    UIElements.userEditorIsAdmin.checked = isUserAdmin;
    UIElements.userEditorIsAdmin.disabled = Boolean(user && user.id === 1);
    UIElements.userEditorCanUseDvr.checked = user ? Boolean(user.canUseDvr || isUserAdmin) : false;

    // Populate Visible Navigation Tabs checkboxes
    let allowedTabs = null;
    if (user && user.allowed_tabs && !isUserAdmin) {
        try {
            const parsed = typeof user.allowed_tabs === 'string' ? JSON.parse(user.allowed_tabs) : user.allowed_tabs;
            if (Array.isArray(parsed)) allowedTabs = parsed;
        } catch (e) { }
    }
    const tabCheckboxes = document.querySelectorAll('#user-editor-tabs-grid .user-tab-checkbox');
    tabCheckboxes.forEach(cb => {
        cb.checked = isUserAdmin || !allowedTabs || allowedTabs.includes(cb.value);
    });

    // Modal Title & Subtitle with Creation / Last Login metadata
    UIElements.userEditorTitle.textContent = user ? `Edit User: ${user.username}` : 'Add New User';
    const metaSubtitle = document.getElementById('user-editor-meta-subtitle');
    if (metaSubtitle) {
        if (user) {
            const created = formatUserTimestamp(user.created_at, false) || 'Unknown';
            const lastLogin = formatUserTimestamp(user.last_login, true) || 'Never';
            metaSubtitle.textContent = `Date Joined: ${created}  ·  Last Login: ${lastLogin}`;
        } else {
            metaSubtitle.textContent = 'Configure account credentials, visible navigation tabs, and channel access.';
        }
    }

    const srcSearch = document.getElementById('user-editor-source-search');
    if (srcSearch) srcSearch.value = '';

    UIElements.userEditorError.classList.add('hidden');
    renderUserSourceList(user, false);
    syncUserEditorAdminLockState();
    openModal(UIElements.userEditorModal);
};

// --- Modals and Editors ---

/**
 * Opens the source editor modal.
 * @param {('m3u'|'epg')} sourceType - The type of source.
 * @param {object|null} source - The source object to edit, or null for a new one.
 */
const openSourceEditor = (sourceType, source = null) => {
    UIElements.sourceEditorTitle.textContent = `${source ? 'Edit' : 'Add'} ${sourceType.toUpperCase()} Source`;
    UIElements.sourceEditorForm.reset();
    UIElements.sourceEditorId.value = source ? source.id : '';
    UIElements.sourceEditorType.value = sourceType;
    UIElements.sourceEditorName.value = source ? source.name : '';
    UIElements.sourceEditorIsActive.checked = source ? source.isActive : true;
    UIElements.sourceEditorRefreshInterval.value = source ? (source.refreshHours || 0) : 0;

    const preDownloadLogosContainer = document.getElementById('source-editor-predownload-logos-container');
    const preDownloadLogosCheckbox = document.getElementById('source-editor-preDownloadLogos');
    if (preDownloadLogosContainer) {
        preDownloadLogosContainer.classList.toggle('hidden', sourceType !== 'm3u');
    }
    if (preDownloadLogosCheckbox) {
        preDownloadLogosCheckbox.checked = source ? (source.preDownloadLogos !== false) : true;
    }

    // Default to 'url' tab unless source dictates otherwise
    let activeTab = 'url';

    // Determine the initial tab based on the source type
    if (source) {
        if (source.type === 'file') {
            activeTab = 'file';
        } else if (source.type === 'xc') {
            activeTab = 'xc';
        } else { // 'url' or other types
            activeTab = 'url';
        }
    }

    // Set the global state for which tab is active
    currentSourceTypeForEditor = activeTab;

    // Toggle tab visibility based on the active tab
    UIElements.sourceEditorTypeBtnUrl.classList.toggle('bg-blue-600', activeTab === 'url');
    UIElements.sourceEditorTypeBtnFile.classList.toggle('bg-blue-600', activeTab === 'file');
    UIElements.sourceEditorTypeBtnXc.classList.toggle('bg-blue-600', activeTab === 'xc');

    UIElements.sourceEditorUrlContainer.classList.toggle('hidden', activeTab !== 'url');
    UIElements.sourceEditorFileContainer.classList.toggle('hidden', activeTab !== 'file');
    UIElements.sourceEditorXcContainer.classList.toggle('hidden', activeTab !== 'xc');

    // --- NEW: Add "Filter Groups" button and hidden input ---
    const filterGroupBtnHTML = `
        <div id="source-editor-filter-groups-container" class="mt-4 ${activeTab === 'file' ? 'hidden' : ''}">
            <label class="block text-sm font-medium text-gray-400">Group Filtering</label>
            <p class="text-xs text-gray-500 mb-2">Select which groups to import. If none are selected, all groups will be imported.</p>
            <div class="flex gap-2">
                <button type="button" id="source-editor-filter-groups-btn" class="flex-grow bg-gray-600 hover:bg-gray-500 text-white font-bold py-2 px-4 rounded-md">
                    <span>Select Groups</span>
                </button>
                <button type="button" id="source-editor-refresh-groups-btn" class="flex-shrink-0 bg-blue-600 hover:bg-blue-700 text-white font-bold py-2 px-2 rounded-md" title="Refresh groups from source">
                     ${ICONS.refresh}
                </button>
            </div>
            <input type="hidden" id="source-editor-selected-groups" value="[]">
        </div>
    `;
    // Remove old button if it exists, then add the new one
    const oldBtnContainer = document.getElementById('source-editor-filter-groups-container');
    if (oldBtnContainer) {
        oldBtnContainer.remove();
    }
    UIElements.sourceEditorRefreshContainer.insertAdjacentHTML('beforebegin', filterGroupBtnHTML);

    // Populate hidden input with existing selected groups if editing
    if (source && source.selectedGroups) {
        document.getElementById('source-editor-selected-groups').value = JSON.stringify(source.selectedGroups);
        const count = source.selectedGroups.length;
        // MODIFIED: Target the inner span now
        const btnSpan = document.querySelector('#source-editor-filter-groups-btn span');
        if (btnSpan) {
            btnSpan.textContent = count > 0 ? `${count} Groups Selected` : 'Select Groups';
        }
    }

    // Attach listener for the new button
    const filterGroupsBtn = document.getElementById('source-editor-filter-groups-btn');
    if (filterGroupsBtn) {
        filterGroupsBtn.addEventListener('click', async () => {
            const selectedGroupsInput = document.getElementById('source-editor-selected-groups');
            const currentSelected = JSON.parse(selectedGroupsInput.value || '[]');
            const sourceName = UIElements.sourceEditorName.value || 'Source';

            // Initial UI state
            const originalText = filterGroupsBtn.querySelector('span').textContent;
            filterGroupsBtn.querySelector('span').textContent = 'Loading...';
            filterGroupsBtn.disabled = true;

            currentGroupEditorContext = 'source-editor';
            currentGroupSourceId = null; // Not needed for source editor as we read from form

            try {
                const payload = {
                    type: currentSourceTypeForEditor, // Use 'type' not 'sourceType'
                };

                if (currentSourceTypeForEditor === 'url') {
                    payload.url = UIElements.sourceEditorUrl.value;
                } else if (currentSourceTypeForEditor === 'xc') {
                    payload.xc = JSON.stringify({
                        server: UIElements.sourceEditorXcUrl.value,
                        username: UIElements.sourceEditorXcUsername.value,
                        password: UIElements.sourceEditorXcPassword.value,
                        liveFormat: UIElements.sourceEditorXcLiveFormat.value,
                    });
                }
                // File sources: fetch-groups only works if file is already on server (has ID or path knewn)
                if (source && source.id) {
                    payload.sourceId = source.id;
                    if (currentSourceTypeForEditor === 'file' && source.path) {
                        payload.url = source.path; // Server expects path in 'url' field for file type
                    }
                }

                const res = await apiFetch('/api/sources/fetch-groups', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(payload)
                });

                if (res && res.ok) {
                    const data = await res.json();
                    let allGroups = data.groups || data || [];

                    UIElements.groupFilterModal.querySelector('h3').textContent = `Select Groups for ${sourceName}`;
                    populateGroupFilterModal(allGroups, currentSelected);
                    openModal(UIElements.groupFilterModal);
                } else {
                    showNotification("Failed to fetch groups. Ensure URL/Source is valid.", true);
                }
            } catch (e) {
                console.error("Group fetch error:", e);
                showNotification("Error fetching groups: " + e.message, true);
            } finally {
                filterGroupsBtn.querySelector('span').textContent = originalText;
                filterGroupsBtn.disabled = false;
            }
        });
    }

    // Hide refresh interval for file-based sources
    UIElements.sourceEditorRefreshContainer.classList.toggle('hidden', activeTab === 'file');
    UIElements.sourceEditorFileInfo.classList.add('hidden'); // Hide file info by default
    document.getElementById('source-editor-filter-groups-container').classList.toggle('hidden', activeTab === 'file');



    // Populate the form fields based on the source data
    if (source) {
        switch (source.type) {
            case 'url':
                UIElements.sourceEditorUrl.value = source.path;
                break;
            case 'file':
                UIElements.sourceEditorFileInfo.textContent = `Current file: ${source.path.split('/').pop()}`;
                UIElements.sourceEditorFileInfo.classList.remove('hidden');
                break;
            case 'xc':
                // FIX: Correctly parse xc_data and populate the fields
                if (source.xc_data) {
                    try {
                        const xcData = JSON.parse(source.xc_data);
                        UIElements.sourceEditorXcUrl.value = xcData.server || '';
                        UIElements.sourceEditorXcUsername.value = xcData.username || '';
                        UIElements.sourceEditorXcPassword.value = xcData.password || '';
                        UIElements.sourceEditorXcLiveFormat.value = xcData.liveFormat === 'm3u8' ? 'm3u8' : 'ts';
                    } catch (e) {
                        console.error("Could not parse XC data for editing:", e);
                        // Clear fields if data is corrupt
                        UIElements.sourceEditorXcUrl.value = '';
                        UIElements.sourceEditorXcUsername.value = '';
                        UIElements.sourceEditorXcPassword.value = '';
                        UIElements.sourceEditorXcLiveFormat.value = 'ts';
                    }
                }
                break;
        }
    }

    openModal(UIElements.sourceEditorModal);
};

/**
 * Opens the generic editor modal for User Agents or Stream Profiles.
 * @param {('userAgent'|'streamProfile'|'recordingProfile')} type - The type of item to edit.
 * @param {object|null} item - The item to edit, or null for a new one.
 */
const openEditorModal = (type, item = null) => {
    const isUserAgent = type === 'userAgent';
    let title, valueLabel, helpText;

    if (type === 'userAgent') {
        title = item ? 'Edit User Agent' : 'Create New User Agent';
        valueLabel = 'User Agent String';
        helpText = 'The User-Agent string to send with stream requests.';
    } else if (type === 'streamProfile') {
        title = item ? 'Edit Stream Profile' : 'Create New Stream Profile';
        valueLabel = 'FFmpeg Command';
        helpText = 'For ffmpeg commands, use {userAgent} and {streamUrl} as placeholders.';
    } else if (type === 'recordingProfile') {
        title = item ? 'Edit Recording Profile' : 'Create New Recording Profile';
        valueLabel = 'FFmpeg Command';
        helpText = 'Use {streamUrl} and {filePath} as placeholders. Example: -i "{streamUrl}" -c copy "{filePath}.ts"';
    } else { // castProfile
        title = item ? 'Edit Cast Profile' : 'Create New Cast Profile';
        valueLabel = 'FFmpeg Command';
        helpText = 'For Chromecast, use MP4 fragmented format with {userAgent} and {streamUrl} placeholders.';
    }


    UIElements.editorTitle.textContent = title;
    UIElements.editorType.value = type;
    UIElements.editorId.value = item ? item.id : `custom-${Date.now()}`;
    UIElements.editorName.value = item ? item.name : '';
    UIElements.editorValueLabel.textContent = valueLabel;
    UIElements.editorValue.value = item ? item.command || item.value : '';
    UIElements.editorValue.nextElementSibling.textContent = helpText;

    const isDefault = item && item.isDefault;
    UIElements.editorName.disabled = isDefault;

    // NEW LOGIC: Make the textarea readonly for default profiles so users can copy the command.
    UIElements.editorValue.readOnly = isDefault;
    UIElements.editorValue.classList.toggle('bg-gray-600', isDefault); // Visual cue for readonly
    UIElements.editorValue.classList.toggle('cursor-not-allowed', isDefault);

    // If it's a default profile, still show the actual command for copying.
    if (item) {
        UIElements.editorValue.value = item.command || item.value || '';
    }

    UIElements.editorSaveBtn.disabled = isDefault;
    openModal(UIElements.editorModal);
};

// --- Event Listeners ---

/**
 * A wrapper to save a setting and show a notification on success.
 * @param {Function} saveFunction - The async function that saves the setting.
 * @param  {...any} args - Arguments to pass to the save function.
 */
const saveSettingAndNotify = async (saveFunction, ...args) => {
    const updatedSettings = await saveFunction(...args);
    if (updatedSettings) {
        // Merge updated global settings into guideState.settings so device-local settings
        // (channelColumnWidth, activeGroupFilter, activeSourceFilter) and user settings (favorites) are preserved.
        Object.assign(guideState.settings, updatedSettings);
        showNotification('Setting saved.');
    }
    return !!updatedSettings;
};

// --- LOG MANAGEMENT FUNCTIONS ---

/**
 * Fetches and displays log statistics.
 */
async function refreshLogInfo() {
    try {
        const res = await apiFetch('/api/logs/info');
        if (res && res.ok) {
            const data = await res.json();

            if (UIElements.logFileCount) {
                UIElements.logFileCount.textContent = data.fileCount;
            }
            if (UIElements.logTotalSize) {
                const sizeMB = (data.totalSize / (1024 * 1024)).toFixed(2);
                UIElements.logTotalSize.textContent = `${sizeMB} MB`;
            }
            if (UIElements.logOldestDate) {
                if (data.oldestDate) {
                    const date = new Date(data.oldestDate);
                    UIElements.logOldestDate.textContent = date.toLocaleDateString();
                } else {
                    UIElements.logOldestDate.textContent = 'N/A';
                }
            }
        }
    } catch (error) {
        console.error('[SETTINGS] Error fetching log info:', error);
    }
}

/**
 * Triggers download of all log files.
 */
async function handleDownloadLogs() {
    try {
        window.location.href = '/api/logs/download';
        showNotification('Downloading logs...', false, 3000);
    } catch (error) {
        console.error('[SETTINGS] Error downloading logs:', error);
        showNotification('Failed to download logs.', true);
    }
}

/**
 * Clears all log files after confirmation.
 */
function handleClearLogs() {
    console.log('[SETTINGS] Clear logs button clicked');

    showConfirm(
        'Clear All Logs',
        'Are you sure you want to delete all log files? This action cannot be undone.',
        async () => {
            console.log('[SETTINGS] User confirmed log cleanup');
            console.log('[SETTINGS] Proceeding with log cleanup...');

            try {
                const res = await apiFetch('/api/logs/cleanup', { method: 'POST' });
                console.log('[SETTINGS] Cleanup API response:', res);
                if (res && res.ok) {
                    const data = await res.json();
                    console.log('[SETTINGS] Cleanup successful, deleted:', data.deletedCount);
                    showNotification(`Cleared ${data.deletedCount} log file(s).`, false, 3000);
                    refreshLogInfo();
                } else {
                    console.error('[SETTINGS] Cleanup API returned non-OK response');
                    showNotification('Failed to clear logs.', true);
                }
            } catch (error) {
                console.error('[SETTINGS] Error clearing logs:', error);
                showNotification('Failed to clear logs.', true);
            }
        }
    );
}

// --- LOGO & IMAGE CACHE MANAGEMENT FUNCTIONS ---

function formatCacheBytes(bytes) {
    const b = Number(bytes) || 0;
    if (b < 1024) return `${b} B`;
    if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`;
    if (b < 1024 * 1024 * 1024) return `${(b / (1024 * 1024)).toFixed(2)} MB`;
    return `${(b / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function updateLogoSyncBadgeUI(syncState) {
    const badge = UIElements.logoSyncStatusBadge;
    if (!badge) return;
    if (syncState && syncState.inProgress) {
        const pct = syncState.total > 0 ? Math.round((syncState.processed / syncState.total) * 100) : 0;
        badge.textContent = `Syncing logos: ${syncState.processed}/${syncState.total} (${pct}%)`;
        badge.className = 'text-xs font-medium px-2.5 py-1 rounded-full bg-blue-900/60 text-blue-300 border border-blue-700/50 animate-pulse';
        badge.classList.remove('hidden');
    } else if (syncState && syncState.lastCompletedAt) {
        badge.textContent = `Verified • ${syncState.updated || 0} updated, ${syncState.matched || 0} smart, ${syncState.keptSafe || 0} kept`;
        badge.className = 'text-xs font-medium px-2.5 py-1 rounded-full bg-emerald-900/50 text-emerald-300 border border-emerald-700/50';
        badge.classList.remove('hidden');
    } else {
        badge.classList.add('hidden');
    }
}

/**
 * Reloads the M3U channel list from the server into memory and IndexedDB after logo changes.
 */
async function reloadChannelsInMemoryAfterLogoChange() {
    try {
        if (failedLogoUrls && typeof failedLogoUrls.clear === 'function') {
            failedLogoUrls.clear();
        }
        const config = await fetchConfig();
        if (config) {
            Object.assign(guideState.settings, config.settings || {});
            if (config.m3uContent) {
                guideState.channels = parseM3U(config.m3uContent);
                if (Array.isArray(guideState.settings.favoriteChannels)) {
                    guideState.channels.forEach(channel => {
                        channel.isFavorite = guideState.settings.favoriteChannels.includes(channel.id);
                    });
                }
                if (appState.db) {
                    const tx = appState.db.transaction(['guideData'], 'readwrite');
                    tx.objectStore('guideData').put(guideState.channels, 'channels');
                    if (config.settings?.sourcesLastUpdated) {
                        tx.objectStore('guideData').put(config.settings.sourcesLastUpdated, 'sourcesLastUpdated');
                    }
                }
                const path = window.location.pathname;
                if (path === '/' || path.startsWith('/tvguide')) {
                    handleSearchAndFilter(false, true);
                }
            }
        }
    } catch (err) {
        console.warn('[SETTINGS] Could not reload channels in memory after logo change:', err);
    }
}

/**
 * Fetches and displays statistics for both Stored Channel Logos and Cached VOD Posters.
 */
export async function refreshLogoCacheInfo() {
    try {
        const res = await apiFetch('/api/logos/stats');
        if (res && res.ok) {
            const data = await res.json();
            if (data.logos) {
                if (UIElements.logoCacheCount) {
                    UIElements.logoCacheCount.textContent = `${data.logos.fileCount} files`;
                }
                if (UIElements.logoCacheSize) {
                    UIElements.logoCacheSize.textContent = formatCacheBytes(data.logos.totalSize);
                }
                if (UIElements.logoChannelCoverage) {
                    const total = data.logos.totalChannels || 0;
                    const stored = data.logos.storedChannels || 0;
                    const smart = data.logos.smartMatches || 0;
                    UIElements.logoChannelCoverage.textContent = total > 0
                        ? `${stored} / ${total} (${smart} smart)`
                        : '0 / 0';
                }
                updateLogoSyncBadgeUI(data.logos.syncState);
            }
            if (data.posters) {
                if (UIElements.posterCacheCount) {
                    UIElements.posterCacheCount.textContent = `${data.posters.fileCount} files`;
                }
                if (UIElements.posterCacheSize) {
                    UIElements.posterCacheSize.textContent = formatCacheBytes(data.posters.totalSize);
                }
            }
        }
    } catch (error) {
        console.error('[SETTINGS] Error fetching logo/poster cache stats:', error);
    }
}

/**
 * Handles real-time SSE 'logo-sync-status' events from the server.
 */
export function handleLogoSyncStatusUpdate(syncState) {
    updateLogoSyncBadgeUI(syncState);
    if (syncState && !syncState.inProgress) {
        refreshLogoCacheInfo();
        reloadChannelsInMemoryAfterLogoChange();
    }
}

/**
 * Triggers a manual verification and update check of all channel logos against upstream sources.
 */
async function handleSyncLogosNow() {
    const btn = UIElements.syncLogosNowBtn;
    if (!btn) return;
    const originalHTML = btn.innerHTML;
    setButtonLoadingState(btn, true, 'Checking Logos...');

    try {
        const res = await apiFetch('/api/logos/sync', { method: 'POST' });
        if (res && res.ok) {
            const data = await res.json();
            if (data.completed) {
                const st = data.syncState || {};
                showNotification(
                    `Logo check complete: ${st.updated || 0} updated, ${st.matched || 0} smart-matched, ${st.keptSafe || 0} kept.`,
                    false,
                    4500
                );
                await refreshLogoCacheInfo();
                await reloadChannelsInMemoryAfterLogoChange();
            } else if (data.runningInBackground) {
                showNotification('Checking & updating channel logos in the background...', false, 4000);
                updateLogoSyncBadgeUI(data.syncState);
            }
        } else {
            showNotification('Failed to start channel logo check.', true);
        }
    } catch (error) {
        console.error('[SETTINGS] Error syncing logos:', error);
        showNotification('Error checking channel logos.', true);
    } finally {
        setButtonLoadingState(btn, false, originalHTML);
    }
}

/**
 * Clears all stored channel logos (/data/logos) and resets the channel logo index after confirmation.
 */
function handleClearChannelLogos() {
    showConfirm(
        'Reset Channel Logos',
        'Are you sure you want to delete all stored channel logo files (/data/logos)? You can click "Check & Update Logos Now" afterward to download fresh logos from your sources.',
        async () => {
            try {
                const res = await apiFetch('/api/logos/cache', { method: 'DELETE' });
                if (res && res.ok) {
                    const data = await res.json();
                    showNotification(data.message || `Cleared ${data.deletedFiles} stored channel logo files.`, false, 3500);
                    await refreshLogoCacheInfo();
                    await reloadChannelsInMemoryAfterLogoChange();
                } else {
                    showNotification('Failed to reset channel logos.', true);
                }
            } catch (error) {
                console.error('[SETTINGS] Error clearing channel logos:', error);
                showNotification('Failed to reset channel logos.', true);
            }
        }
    );
}

/**
 * Clears all cached VOD poster images (/data/image_cache) after confirmation.
 */
function handleClearVodPosters() {
    showConfirm(
        'Clear VOD Poster Cache',
        'Are you sure you want to delete all cached movie and series poster images (/data/image_cache)? Posters will be re-downloaded automatically as you browse VOD.',
        async () => {
            try {
                const res = await apiFetch('/api/image-cache', { method: 'DELETE' });
                if (res && res.ok) {
                    const data = await res.json();
                    if (guideState && guideState.settings) {
                        guideState.settings.posterCacheClearedAt = data.posterCacheClearedAt || Date.now();
                    }
                    showNotification(data.message || `Cleared ${data.deletedFiles} cached VOD posters.`, false, 3500);
                    await refreshLogoCacheInfo();
                } else {
                    showNotification('Failed to clear VOD poster cache.', true);
                }
            } catch (error) {
                console.error('[SETTINGS] Error clearing VOD poster cache:', error);
                showNotification('Failed to clear VOD poster cache.', true);
            }
        }
    );
}

const VALID_SETTINGS_TABS = ['sources', 'logos', 'playback', 'dvr', 'users', 'logs', 'system'];

/**
 * Switches the active category pane inside the Settings page.
 * @param {string} tabId - One of VALID_SETTINGS_TABS
 */
export function switchSettingsSection(tabId) {
    const targetTab = VALID_SETTINGS_TABS.includes(tabId) ? tabId : 'sources';
    const navButtons = document.querySelectorAll('#settings-sidebar-nav .settings-nav-btn[data-settings-tab]');
    const panes = document.querySelectorAll('#page-settings .settings-pane[data-settings-pane]');

    navButtons.forEach(btn => {
        const isActive = btn.dataset.settingsTab === targetTab;
        btn.classList.toggle('active', isActive);
        btn.classList.toggle('bg-blue-600/20', isActive);
        btn.classList.toggle('text-blue-400', isActive);
        btn.classList.toggle('border-blue-500/40', isActive);
        btn.classList.toggle('shadow-sm', isActive);

        btn.classList.toggle('text-gray-300', !isActive);
        btn.classList.toggle('hover:bg-gray-700/60', !isActive);
        btn.classList.toggle('hover:text-white', !isActive);
        btn.classList.toggle('border-transparent', !isActive);
    });

    panes.forEach(pane => {
        const isMatch = pane.dataset.settingsPane === targetTab;
        pane.classList.toggle('hidden', !isMatch);
    });

    if (UIElements.pageSettings) {
        UIElements.pageSettings.scrollTop = 0;
    }

    if (targetTab === 'logos') {
        refreshLogoCacheInfo();
    } else if (targetTab === 'logs') {
        refreshLogInfo();
    } else if (targetTab === 'users' && appState.currentUser?.isAdmin) {
        refreshUserList();
    }
}

/**
 * Sets up all event listeners for the settings page.
 */
export function setupSettingsEventListeners() {

    // --- Settings Sidebar Navigation ---
    const settingsNavButtons = document.querySelectorAll('#settings-sidebar-nav .settings-nav-btn[data-settings-tab]');
    settingsNavButtons.forEach(btn => {
        btn.addEventListener('click', () => {
            switchSettingsSection(btn.dataset.settingsTab);
        });
    });

    try {
        sessionStorage.removeItem('viniplay_settings_tab');
    } catch (e) { }
    switchSettingsSection('sources');

    // --- Source Management ---
    if (UIElements.processSourcesBtn) {
        UIElements.processSourcesBtn.addEventListener('click', async () => {
            if (isProcessingRunning && UIElements.processingStatusModal.classList.contains('hidden')) {
                // Process is running in the background, just reopen the modal
                openModal(UIElements.processingStatusModal);
                return;
            }

            // 1. Open the processing modal (this sets isProcessingRunning = true)
            showProcessingModal();

            // 2. Trigger the backend process.
            const res = await apiFetch('/api/process-sources', { method: 'POST' });

            // 3. Handle initial request failure
            if (!res || !res.ok) {
                const data = res ? await res.json() : { error: 'Could not connect to server.' };
                updateProcessingStatus(`Failed to start process: ${data.error}`, 'error');
            }
        });
    }

    UIElements.addM3uBtn.addEventListener('click', () => openSourceEditor('m3u'));
    UIElements.addEpgBtn.addEventListener('click', () => openSourceEditor('epg'));
    UIElements.sourceEditorCancelBtn.addEventListener('click', () => closeModal(UIElements.sourceEditorModal));

    // --- Source Editor Tabs ---
    const switchSourceEditorTab = (tabType) => {
        currentSourceTypeForEditor = tabType;
        const isUrl = tabType === 'url';
        const isFile = tabType === 'file';
        const isXc = tabType === 'xc';

        UIElements.sourceEditorTypeBtnUrl.classList.toggle('bg-blue-600', isUrl);
        UIElements.sourceEditorTypeBtnFile.classList.toggle('bg-blue-600', isFile);
        UIElements.sourceEditorTypeBtnXc.classList.toggle('bg-blue-600', isXc);

        UIElements.sourceEditorUrlContainer.classList.toggle('hidden', !isUrl);
        UIElements.sourceEditorFileContainer.classList.toggle('hidden', !isFile);
        UIElements.sourceEditorXcContainer.classList.toggle('hidden', !isXc);

        // Refresh interval is shown for URL and XC, but not for File
        UIElements.sourceEditorRefreshContainer.classList.toggle('hidden', isFile);
        // Also toggle visibility of the group filter button container based on file type
        const filterGroupsContainer = document.getElementById('source-editor-filter-groups-container');
        if (filterGroupsContainer) {
            filterGroupsContainer.classList.toggle('hidden', isFile);
            const refreshBtn = filterGroupsContainer.querySelector('#source-editor-refresh-groups-btn');
            if (refreshBtn) {
                refreshBtn.classList.toggle('hidden', isFile);
            }
        }
    };

    UIElements.sourceEditorTypeBtnUrl.addEventListener('click', () => switchSourceEditorTab('url'));
    UIElements.sourceEditorTypeBtnFile.addEventListener('click', () => switchSourceEditorTab('file'));
    UIElements.sourceEditorTypeBtnXc.addEventListener('click', () => switchSourceEditorTab('xc'));

    // --- Source Editor Form Submission ---
    UIElements.sourceEditorForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        const id = UIElements.sourceEditorId.value;
        const sourceType = UIElements.sourceEditorType.value;

        const formData = new FormData();
        formData.append('sourceType', sourceType);
        formData.append('name', UIElements.sourceEditorName.value);
        formData.append('isActive', UIElements.sourceEditorIsActive.checked);
        const preDownloadLogosCheckbox = document.getElementById('source-editor-preDownloadLogos');
        if (sourceType === 'm3u' && preDownloadLogosCheckbox) {
            formData.append('preDownloadLogos', preDownloadLogosCheckbox.checked);
        }

        if (currentSourceTypeForEditor === 'url') {
            formData.append('url', UIElements.sourceEditorUrl.value);
            formData.append('refreshHours', UIElements.sourceEditorRefreshInterval.value);
        } else if (currentSourceTypeForEditor === 'file') {
            if (UIElements.sourceEditorFile.files[0]) {
                formData.append('sourceFile', UIElements.sourceEditorFile.files[0]);
            } else if (!id) {
                showNotification('A file must be selected for new file-based sources.', true);
                return;
            }
        } else if (currentSourceTypeForEditor === 'xc') {
            formData.append('xc', JSON.stringify({
                server: UIElements.sourceEditorXcUrl.value,
                username: UIElements.sourceEditorXcUsername.value,
                password: UIElements.sourceEditorXcPassword.value,
                liveFormat: UIElements.sourceEditorXcLiveFormat.value,
            }));
            formData.append('refreshHours', UIElements.sourceEditorRefreshInterval.value);
        }

        const selectedGroupsInput = document.getElementById('source-editor-selected-groups');
        if (selectedGroupsInput) {
            formData.append('selectedGroups', selectedGroupsInput.value || '[]');
        }

        if (id) formData.append('id', id);

        const res = await apiFetch('/api/sources', { method: 'POST', body: formData });

        if (res && res.ok) {
            const data = await res.json();
            Object.assign(guideState.settings, data.settings); // Merge settings
            updateUIFromSettings();
            closeModal(UIElements.sourceEditorModal);
            showNotification(`Source ${id ? 'updated' : 'added'} successfully.`);
        } else {
            const data = res ? await res.json() : { error: 'An unknown error occurred.' };
            showNotification(`Error: ${data.error}`, true);
        }
    });

    // --- Source Editor URL Test Button ---
    UIElements.testSourceUrlBtn.addEventListener('click', async () => {
        const url = UIElements.sourceEditorUrl.value.trim();
        if (!url) {
            return showNotification('Please enter a URL to test.', true);
        }
        const originalContent = UIElements.testSourceUrlBtn.innerHTML; // Note: using innerHTML for spinner
        setButtonLoadingState(UIElements.testSourceUrlBtn, true, 'Testing...'); // Pass original innerHTML

        const res = await apiFetch('/api/validate-url', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ url })
        });

        if (res && res.ok) {
            const data = await res.json();
            if (data.success) {
                showNotification('URL is reachable and valid!', false);
            }
        }
        // apiFetch handles error notifications automatically
        setButtonLoadingState(UIElements.testSourceUrlBtn, false, originalContent); // Restore original innerHTML
    });

    // --- Source Table Clicks (Edit, Delete, Activate) ---
    const handleSourceTableClick = async (e, sourceType) => {
        const target = e.target;
        const row = target.closest('tr');
        if (!row) return;
        const sourceId = row.dataset.sourceId;
        const source = guideState.settings[`${sourceType}Sources`].find(s => s.id === sourceId);
        if (!source) return;

        if (target.closest('.edit-source-btn')) {
            openSourceEditor(sourceType, source);
        } else if (target.closest('.delete-source-btn')) {
            showConfirm('Delete Source?', 'This will delete the source configuration. The downloaded file (if any) will also be removed.', async () => {
                const res = await apiFetch(`/api/sources/${sourceType}/${sourceId}`, { method: 'DELETE' });
                if (res?.ok) {
                    const data = await res.json();
                    Object.assign(guideState.settings, data.settings); // Merge settings
                    updateUIFromSettings();
                    showNotification('Source deleted.');
                }
                // Error handled by apiFetch
            });
        } else if (target.classList.contains('activate-switch')) {
            const isActive = target.checked;
            const res = await apiFetch(`/api/sources/${sourceType}/${sourceId}`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ ...source, isActive }) // Send full source object for potential future use
            });
            if (res?.ok) {
                const data = await res.json();
                Object.assign(guideState.settings, data.settings); // Merge settings
                updateUIFromSettings();
                showNotification('Source updated.');
            } else {
                target.checked = !isActive; // Revert on failure
            }
        }
    };
    UIElements.m3uSourcesTbody.addEventListener('click', (e) => handleSourceTableClick(e, 'm3u'));
    UIElements.epgSourcesTbody.addEventListener('click', (e) => handleSourceTableClick(e, 'epg'));

    // --- General Settings Inputs ---
    UIElements.timezoneOffsetSelect.addEventListener('change', (e) => saveSettingAndNotify(saveGlobalSetting, { timezoneOffset: parseInt(e.target.value, 10) }));
    UIElements.searchScopeSelect.addEventListener('change', (e) => saveSettingAndNotify(saveGlobalSetting, { searchScope: e.target.value }));
    UIElements.playerLogLevelSelect.addEventListener('change', (e) => saveSettingAndNotify(saveGlobalSetting, { playerLogLevel: e.target.value }));
    UIElements.dvrLogLevelSelect.addEventListener('change', (e) => saveSettingAndNotify(saveGlobalSetting, { dvrLogLevel: e.target.value }));
    if (UIElements.clientTelemetryToggle) {
        UIElements.clientTelemetryToggle.addEventListener('change', (e) => {
            saveSettingAndNotify(saveGlobalSetting, { clientTelemetryEnabled: e.target.checked });
        });
    }
    UIElements.notificationLeadTimeInput.addEventListener('change', async (e) => {
        const value = parseInt(e.target.value, 10);
        if (isNaN(value) || value < 1) {
            showNotification('Notification lead time must be a positive number.', true);
            e.target.value = guideState.settings.notificationLeadTime; // Revert
            return;
        }
        await saveSettingAndNotify(saveGlobalSetting, { notificationLeadTime: value });
    });

    // --- Hardware Info Modal ---
    UIElements.hardwareInfoBtn.addEventListener('click', () => openModal(UIElements.hardwareInfoModal));
    UIElements.hardwareInfoModalCloseBtn.addEventListener('click', () => closeModal(UIElements.hardwareInfoModal));

    // --- DVR Settings Inputs ---
    const handleDvrSettingChange = (key, value) => {
        const newDvrSettings = { ...guideState.settings.dvr, [key]: value };
        saveSettingAndNotify(saveGlobalSetting, { dvr: newDvrSettings });
    };

    if (UIElements.dvrPreBufferInput) {
        UIElements.dvrPreBufferInput.addEventListener('change', (e) => handleDvrSettingChange('preBufferMinutes', parseInt(e.target.value, 10)));
    }
    if (UIElements.dvrPostBufferInput) {
        UIElements.dvrPostBufferInput.addEventListener('change', (e) => handleDvrSettingChange('postBufferMinutes', parseInt(e.target.value, 10)));
    }
    if (UIElements.dvrMaxStreamsInput) {
        UIElements.dvrMaxStreamsInput.addEventListener('change', (e) => handleDvrSettingChange('maxConcurrentRecordings', parseInt(e.target.value, 10)));
    }
    if (UIElements.dvrStorageDeleteDays) {
        UIElements.dvrStorageDeleteDays.addEventListener('change', (e) => handleDvrSettingChange('autoDeleteDays', parseInt(e.target.value, 10)));
    }
    UIElements.dvrRecordingProfileSelect.addEventListener('change', (e) => handleDvrSettingChange('activeRecordingProfileId', e.target.value));

    // --- Player Settings (User Agents & Stream Profiles) Buttons ---
    UIElements.addUserAgentBtn.addEventListener('click', () => openEditorModal('userAgent'));
    UIElements.editUserAgentBtn.addEventListener('click', () => {
        const agent = guideState.settings.userAgents.find(ua => ua.id === UIElements.userAgentSelect.value);
        if (agent) openEditorModal('userAgent', agent);
    });
    UIElements.deleteUserAgentBtn.addEventListener('click', () => {
        const selectedId = UIElements.userAgentSelect.value;
        const agentToDelete = guideState.settings.userAgents.find(ua => ua.id === selectedId);
        if (!agentToDelete || agentToDelete.isDefault) {
            showNotification("Cannot delete the default User Agent.", true);
            return;
        }
        showConfirm('Delete User Agent?', 'Are you sure?', async () => {
            const updatedList = guideState.settings.userAgents.filter(ua => ua.id !== selectedId);
            const newActiveId = (guideState.settings.activeUserAgentId === selectedId) ? (guideState.settings.userAgents.find(ua => ua.isDefault)?.id || updatedList[0]?.id || null) : guideState.settings.activeUserAgentId;
            const settings = await saveGlobalSetting({ userAgents: updatedList, activeUserAgentId: newActiveId });
            if (settings) {
                guideState.settings = settings;
                updateUIFromSettings();
                showNotification('User Agent deleted.');
            }
        });
    });
    UIElements.addStreamProfileBtn.addEventListener('click', () => openEditorModal('streamProfile'));
    UIElements.editStreamProfileBtn.addEventListener('click', () => {
        const profile = guideState.settings.streamProfiles.find(p => p.id === UIElements.streamProfileSelect.value);
        if (profile) openEditorModal('streamProfile', profile);
    });
    UIElements.deleteStreamProfileBtn.addEventListener('click', () => {
        const selectedId = UIElements.streamProfileSelect.value;
        const profileToDelete = guideState.settings.streamProfiles.find(p => p.id === selectedId);
        if (!profileToDelete || profileToDelete.isDefault) {
            showNotification("Cannot delete a default Stream Profile.", true);
            return;
        }
        showConfirm('Delete Stream Profile?', 'Are you sure?', async () => {
            const updatedList = guideState.settings.streamProfiles.filter(p => p.id !== selectedId);
            const newActiveId = (guideState.settings.activeStreamProfileId === selectedId) ? (guideState.settings.streamProfiles.find(p => p.isDefault)?.id || updatedList[0]?.id || null) : guideState.settings.activeStreamProfileId;
            const settings = await saveGlobalSetting({ streamProfiles: updatedList, activeStreamProfileId: newActiveId });
            if (settings) {
                guideState.settings = settings;
                updateUIFromSettings();
                showNotification('Stream Profile deleted.'); // Corrected notification
            }
        });
    });

    // --- Player Settings Dropdown Changes ---
    UIElements.userAgentSelect.addEventListener('change', (e) => saveSettingAndNotify(saveGlobalSetting, { activeUserAgentId: e.target.value }));
    UIElements.streamProfileSelect.addEventListener('change', (e) => saveSettingAndNotify(saveGlobalSetting, { activeStreamProfileId: e.target.value }));

    // --- Recording Profiles Buttons ---
    UIElements.addDvrProfileBtn.addEventListener('click', () => openEditorModal('recordingProfile'));
    UIElements.editDvrProfileBtn.addEventListener('click', () => {
        const profile = (guideState.settings.dvr?.recordingProfiles || []).find(p => p.id === UIElements.dvrRecordingProfileSelect.value);
        if (profile) openEditorModal('recordingProfile', profile);
    });
    UIElements.deleteDvrProfileBtn.addEventListener('click', () => {
        const selectedId = UIElements.dvrRecordingProfileSelect.value;
        const profileToDelete = (guideState.settings.dvr?.recordingProfiles || []).find(p => p.id === selectedId);
        if (!profileToDelete || profileToDelete.isDefault) {
            showNotification("Cannot delete a default Recording Profile.", true);
            return;
        }
        showConfirm('Delete Recording Profile?', 'Are you sure?', async () => {
            const updatedList = (guideState.settings.dvr?.recordingProfiles || []).filter(p => p.id !== selectedId);
            const newActiveId = (guideState.settings.dvr?.activeRecordingProfileId === selectedId) ? ((guideState.settings.dvr?.recordingProfiles || []).find(p => p.isDefault)?.id || updatedList[0]?.id || null) : guideState.settings.dvr?.activeRecordingProfileId;
            const settingsToSave = {
                dvr: {
                    ...guideState.settings.dvr,
                    recordingProfiles: updatedList,
                    activeRecordingProfileId: newActiveId
                }
            };
            const settings = await saveGlobalSetting(settingsToSave);
            if (settings) {
                guideState.settings = settings;
                updateUIFromSettings();
                showNotification('Recording Profile deleted.');
            }
        });
    });

    // --- Cast Profile Dropdown and Buttons ---
    UIElements.castProfileSelect.addEventListener('change', (e) => saveSettingAndNotify(saveGlobalSetting, { activeCastProfileId: e.target.value }));
    UIElements.addCastProfileBtn.addEventListener('click', () => openEditorModal('castProfile'));
    UIElements.editCastProfileBtn.addEventListener('click', () => {
        const profile = (guideState.settings.castProfiles || []).find(p => p.id === UIElements.castProfileSelect.value);
        if (profile) openEditorModal('castProfile', profile);
    });
    UIElements.deleteCastProfileBtn.addEventListener('click', () => {
        const selectedId = UIElements.castProfileSelect.value;
        const profileToDelete = (guideState.settings.castProfiles || []).find(p => p.id === selectedId);
        if (!profileToDelete || profileToDelete.isDefault) {
            showNotification("Cannot delete a default Cast Profile.", true);
            return;
        }
        showConfirm('Delete Cast Profile?', 'Are you sure?', async () => {
            const updatedList = (guideState.settings.castProfiles || []).filter(p => p.id !== selectedId);
            const newActiveId = (guideState.settings.activeCastProfileId === selectedId) ? ((guideState.settings.castProfiles || []).find(p => p.isDefault)?.id || updatedList[0]?.id || null) : guideState.settings.activeCastProfileId;
            const settingsToSave = {
                castProfiles: updatedList,
                activeCastProfileId: newActiveId
            };
            const settings = await saveGlobalSetting(settingsToSave);
            if (settings) {
                guideState.settings = settings;
                updateUIFromSettings();
                showNotification('Cast Profile deleted.');
            }
        });
    });

    // --- Editor Modal (User Agent/Stream Profile/Recording Profile/Cast Profile) ---
    UIElements.editorCancelBtn.addEventListener('click', () => closeModal(UIElements.editorModal));
    UIElements.editorForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        const id = UIElements.editorId.value, type = UIElements.editorType.value, name = UIElements.editorName.value.trim(), value = UIElements.editorValue.value.trim();
        if (!name || !value) return showNotification('Name and value cannot be empty.', true);

        let settingsToSave = {};
        const newItem = { id, name, isDefault: false };
        let listKey, valueKey, activeIdKey;

        if (type === 'userAgent') {
            listKey = 'userAgents';
            valueKey = 'value';
            activeIdKey = 'activeUserAgentId';
        } else if (type === 'streamProfile') {
            listKey = 'streamProfiles';
            valueKey = 'command';
            activeIdKey = 'activeStreamProfileId';
        } else if (type === 'recordingProfile') {
            listKey = 'recordingProfiles'; // Will be nested under 'dvr'
            valueKey = 'command';
            activeIdKey = 'activeRecordingProfileId'; // Will be nested under 'dvr'
        } else if (type === 'castProfile') {
            listKey = 'castProfiles';
            valueKey = 'command';
            activeIdKey = 'activeCastProfileId';
        } else {
            return showNotification('Invalid editor type.', true);
        }

        newItem[valueKey] = value;

        if (type === 'recordingProfile') {
            const list = [...(guideState.settings.dvr?.[listKey] || [])];
            const existingIndex = list.findIndex(item => item.id === id);
            if (existingIndex > -1) {
                // Cannot edit default items' core properties
                if (list[existingIndex].isDefault) return showNotification('Cannot edit default profiles.', true);
                list[existingIndex] = { ...list[existingIndex], ...newItem };
            } else {
                list.push(newItem);
            }
            settingsToSave.dvr = { ...guideState.settings.dvr, [listKey]: list };
        } else {
            const list = [...(guideState.settings[listKey] || [])];
            const existingIndex = list.findIndex(item => item.id === id);
            if (existingIndex > -1) {
                // Cannot edit default items' core properties
                if (list[existingIndex].isDefault) return showNotification('Cannot edit default items.', true);
                list[existingIndex] = { ...list[existingIndex], ...newItem };
            } else {
                list.push(newItem);
            }
            settingsToSave[listKey] = list;
        }


        const settings = await saveGlobalSetting(settingsToSave);
        if (settings) {
            guideState.settings = settings;
            updateUIFromSettings();
            closeModal(UIElements.editorModal);
            showNotification(`${type.replace(/([A-Z])/g, ' $1').replace(/^./, str => str.toUpperCase())} saved.`);
        }
    });

    // --- User Management ---
    UIElements.addUserBtn.addEventListener('click', () => openUserEditor());
    UIElements.userEditorCancelBtn.addEventListener('click', () => closeModal(UIElements.userEditorModal));
    document.getElementById('user-editor-close-btn')?.addEventListener('click', () => closeModal(UIElements.userEditorModal));

    // Real-time search in Users & Access table
    document.getElementById('user-search-input')?.addEventListener('input', () => {
        renderUserTableRows();
    });

    // User Editor Password Controls (Show/Hide, Copy, Random Generator)
    document.getElementById('user-editor-toggle-password-btn')?.addEventListener('click', () => {
        const pwdInput = UIElements.userEditorPassword;
        if (!pwdInput) return;
        pwdInput.type = pwdInput.type === 'password' ? 'text' : 'password';
    });

    document.getElementById('user-editor-copy-password-btn')?.addEventListener('click', async () => {
        const val = UIElements.userEditorPassword?.value || '';
        if (!val) {
            return showNotification('No password entered to copy.', true);
        }
        try {
            await navigator.clipboard.writeText(val);
            showNotification('Password copied to clipboard!');
        } catch (e) {
            showNotification('Could not copy password to clipboard.', true);
        }
    });

    document.getElementById('user-editor-generate-password-btn')?.addEventListener('click', () => {
        const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789!@#$%&*';
        let generated = '';
        for (let i = 0; i < 12; i++) {
            generated += chars.charAt(Math.floor(Math.random() * chars.length));
        }
        if (UIElements.userEditorPassword) {
            UIElements.userEditorPassword.value = generated;
            UIElements.userEditorPassword.type = 'text';
            showNotification('Generated new password (visible in field).');
        }
    });

    // Admin checkbox toggles tab/DVR/source locks
    UIElements.userEditorIsAdmin?.addEventListener('change', () => {
        syncUserEditorAdminLockState();
    });

    // Quick Select All / Minimal Navigation Tabs
    document.getElementById('user-editor-tabs-all-btn')?.addEventListener('click', () => {
        if (UIElements.userEditorIsAdmin?.checked) return;
        document.querySelectorAll('#user-editor-tabs-grid .user-tab-checkbox').forEach(cb => { cb.checked = true; });
    });
    document.getElementById('user-editor-tabs-minimal-btn')?.addEventListener('click', () => {
        if (UIElements.userEditorIsAdmin?.checked) return;
        document.querySelectorAll('#user-editor-tabs-grid .user-tab-checkbox').forEach(cb => {
            cb.checked = (cb.value === 'guide');
        });
    });

    // Search & Allow All / Block All in 3-Tier Source/Group/Channel tree
    document.getElementById('user-editor-source-search')?.addEventListener('input', () => {
        renderUserSourceList(currentEditingUser, true);
    });
    document.getElementById('user-editor-sources-all-btn')?.addEventListener('click', () => {
        if (UIElements.userEditorIsAdmin?.checked) return;
        Object.values(userEditorAccessState).forEach(st => {
            st.allowed = true;
            st.allGroupsMode = true;
            st.groups.clear();
            st.excludedChannels.clear();
            st.allMovieGroupsMode = true;
            st.movieGroups.clear();
            st.allSeriesGroupsMode = true;
            st.seriesGroups.clear();
        });
        renderUserSourceList(currentEditingUser, true);
    });
    document.getElementById('user-editor-sources-none-btn')?.addEventListener('click', () => {
        if (UIElements.userEditorIsAdmin?.checked) return;
        Object.values(userEditorAccessState).forEach(st => {
            st.allowed = false;
        });
        renderUserSourceList(currentEditingUser, true);
    });

    UIElements.userEditorForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        const id = UIElements.userEditorId.value;
        const isAdminChecked = Boolean(UIElements.userEditorIsAdmin.checked);

        // Capture visible tabs
        const selectedTabs = Array.from(document.querySelectorAll('#user-editor-tabs-grid .user-tab-checkbox'))
            .filter(cb => cb.checked)
            .map(cb => cb.value);

        if (!isAdminChecked && selectedTabs.length === 0) {
            UIElements.userEditorError.textContent = 'Please enable at least one navigation tab for this user.';
            UIElements.userEditorError.classList.remove('hidden');
            return;
        }

        // Capture 3-tier allowed_sources (independent Live TV, VOD Movies, and VOD Series groups)
        const allowedSourcesPayload = (() => {
            if (isAdminChecked) return null;
            const map = {};
            const m3uSources = guideState.settings.m3uSources || [];
            m3uSources.forEach(src => {
                const st = userEditorAccessState[src.id];
                if (st && st.allowed) {
                    const entry = {
                        allowed: true,
                        allLiveGroups: Boolean(st.allGroupsMode),
                        groups: st.allGroupsMode ? [] : Array.from(st.groups),
                        allMovieGroups: Boolean(st.allMovieGroupsMode),
                        movieGroups: st.allMovieGroupsMode ? [] : Array.from(st.movieGroups),
                        allSeriesGroups: Boolean(st.allSeriesGroupsMode),
                        seriesGroups: st.allSeriesGroupsMode ? [] : Array.from(st.seriesGroups)
                    };
                    if (st.excludedChannels && st.excludedChannels.size > 0) {
                        entry.excludedChannels = Array.from(st.excludedChannels);
                    }
                    map[src.id] = entry;
                }
            });
            return map;
        })();

        const body = {
            username: UIElements.userEditorUsername.value.trim(),
            password: UIElements.userEditorPassword.value,
            isAdmin: isAdminChecked,
            canUseDvr: isAdminChecked ? true : UIElements.userEditorCanUseDvr.checked,
            allowed_tabs: (isAdminChecked || selectedTabs.length >= USER_TAB_DEFINITIONS.length) ? null : selectedTabs,
            allowed_sources: allowedSourcesPayload
        };

        // Don't send empty password or unchanged pre-filled password if not needed,
        // though sending pre-filled password is also safe; if blank on edit, omit it.
        if (!body.password) {
            delete body.password;
        }

        const url = id ? `/api/users/${id}` : '/api/users';
        const method = id ? 'PUT' : 'POST';

        const res = await apiFetch(url, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
        if (res && res.ok) {
            closeModal(UIElements.userEditorModal);
            refreshUserList();
            showNotification(`User ${id ? 'updated' : 'added'} successfully.`);

            if (id && appState.currentUser && String(appState.currentUser.id) === String(id)) {
                showNotification('Your settings have changed. Reloading application...', 'info', 2000);
                setTimeout(() => window.location.reload(), 2000);
            }
        } else if (res) {
            const data = await res.json().catch(() => ({ error: 'An unknown error occurred.' }));
            UIElements.userEditorError.textContent = data.error;
            UIElements.userEditorError.classList.remove('hidden');
        }
    });

    // User List Click Handler (Reveal Password, Copy Password, Edit, Delete)
    UIElements.userList.addEventListener('click', async (e) => {
        const btn = e.target.closest('button');
        if (!btn || btn.disabled) return;
        const row = btn.closest('tr');
        if (!row) return;
        const userId = row.dataset.userId;

        // 1. Toggle Password Visibility in Table Row
        if (btn.classList.contains('toggle-user-pwd-btn')) {
            const maskEl = row.querySelector('.user-pwd-mask');
            if (!maskEl) return;
            const isShown = maskEl.dataset.shown === 'true';
            if (isShown) {
                maskEl.textContent = '••••••••';
                maskEl.dataset.shown = 'false';
                maskEl.className = 'user-pwd-mask font-mono text-xs text-gray-400 tracking-widest select-all';
            } else {
                maskEl.textContent = maskEl.dataset.plain || '';
                maskEl.dataset.shown = 'true';
                maskEl.className = 'user-pwd-mask font-mono text-xs text-emerald-300 font-semibold select-all';
            }
            return;
        }

        // 2. Copy Password from Table Row
        if (btn.classList.contains('copy-user-pwd-btn')) {
            const plain = btn.dataset.plain || '';
            const uname = btn.dataset.username || 'user';
            if (!plain) return;
            try {
                await navigator.clipboard.writeText(plain);
                showNotification(`Copied password for "${uname}"`);
            } catch (err) {
                showNotification('Failed to copy password.', true);
            }
            return;
        }

        // 3. Edit User
        if (btn.classList.contains('edit-user-btn')) {
            const res = await apiFetch(`/api/users?t=${Date.now()}`);
            if (!res) return;
            const users = await res.json();
            cachedUsersList = users;
            const user = users.find(u => String(u.id) === String(userId));
            if (user) {
                openUserEditor(user);
            } else {
                showNotification('Could not find user data to edit.', true);
            }
            return;
        }

        // 4. Delete User
        if (btn.classList.contains('delete-user-btn')) {
            showConfirm('Delete User?', 'Are you sure? Active streams for this user will be terminated immediately and this action cannot be undone.', async () => {
                const res = await apiFetch(`/api/users/${userId}`, { method: 'DELETE' });
                if (res?.ok) {
                    refreshUserList();
                    showNotification('User deleted.');
                }
            });
        }
    });

    // --- Danger Zone ---
    UIElements.clearDataBtn.addEventListener('click', () => {
        showConfirm('Clear All Data?', 'This will permanently delete ALL settings and files from the server and your browser cache. The page will reload.', async () => {
            const res = await apiFetch('/api/data', { method: 'DELETE' }); // Use apiFetch
            if (res?.ok) { // Check for ok status
                if (appState.db) {
                    try {
                        await new Promise((resolve, reject) => {
                            const transaction = appState.db.transaction(['guideData'], 'readwrite');
                            const store = transaction.objectStore('guideData');
                            const req = store.clear();
                            req.onsuccess = resolve;
                            req.onerror = (event) => reject(event.target.error);
                        });
                        console.log('[SETTINGS] IndexedDB cleared successfully.');
                    } catch (dbError) {
                        console.error('[SETTINGS] Failed to clear IndexedDB:', dbError);
                        showNotification('Server data cleared, but failed to clear browser cache. Manual clearing might be needed.', true);
                    }
                }
                showNotification('All data cleared. Reloading...');
                setTimeout(() => window.location.reload(), 1500);
            }
            // apiFetch handles error notification
        });
    });

    // --- Backup & Restore ---
    UIElements.exportSettingsBtn.addEventListener('click', () => {
        // Trigger download via direct link
        window.location.href = '/api/settings/export';
    });

    UIElements.importSettingsBtn.addEventListener('click', () => {
        // Trigger the hidden file input
        UIElements.importSettingsFileInput.click();
    });

    UIElements.importSettingsFileInput.addEventListener('change', async (e) => {
        const file = e.target.files[0];
        if (!file) return;

        showConfirm('Import Settings?', 'This will overwrite ALL current application settings. Are you sure you want to proceed?', async () => {
            const formData = new FormData();
            formData.append('settingsFile', file);

            const res = await apiFetch('/api/settings/import', {
                method: 'POST',
                body: formData
                // Content-Type is set automatically by browser for FormData
            });

            if (res && res.ok) {
                showNotification('Settings imported successfully. The application will now reload to apply them.', false, 4000);
                setTimeout(() => window.location.reload(), 4000);
            }
            // apiFetch handles error notification
        });

        // Reset the file input so the 'change' event fires again if the same file is selected
        e.target.value = '';
    });

    // --- Group Filter Modal Interaction Logic ---
    // Note: Helper functions are now in module scope.

    // Listeners FOR the Group Filter Modal itself
    UIElements.groupFilterModal.addEventListener('click', (e) => {
        const item = e.target.closest('.group-filter-item');
        if (item) {
            item.classList.toggle('selected');
        }
    });

    UIElements.groupFilterTabLive.addEventListener('click', () => switchGroupFilterTab('live'));
    UIElements.groupFilterTabMovies.addEventListener('click', () => switchGroupFilterTab('movie'));
    UIElements.groupFilterTabSeries.addEventListener('click', () => switchGroupFilterTab('series'));

    UIElements.groupFilterSearch.addEventListener('input', () => {
        // Safe check for active tab
        const activeTabEl = document.querySelector('#group-filter-list').previousElementSibling?.querySelector('.active');
        // Actually we can infer active tab from known state or DOM classes.
        // The implementation of switchGroupFilterTab updates classes on UIElements.groupFilterTab*.
        let activeTab = 'live';
        if (UIElements.groupFilterTabMovies.classList.contains('active')) activeTab = 'movie';
        else if (UIElements.groupFilterTabSeries.classList.contains('active')) activeTab = 'series';

        // We need to pass the CURRENT selections to updateGroupFilterList to maintain 'selected' class
        updateGroupFilterList(activeTab, Array.from(tempSelectedGroups), UIElements.groupFilterSearch.value);
    });

    UIElements.groupFilterSelectAll.addEventListener('click', () => {
        UIElements.groupFilterList.querySelectorAll('.group-filter-item').forEach(el => {
            el.classList.add('selected');
            tempSelectedGroups.add(el.dataset.groupName);
        });
    });
    UIElements.groupFilterDeselectAll.addEventListener('click', () => {
        UIElements.groupFilterList.querySelectorAll('.group-filter-item').forEach(el => {
            el.classList.remove('selected');
            tempSelectedGroups.delete(el.dataset.groupName);
        });
    });

    UIElements.groupFilterCancelBtn.addEventListener('click', () => closeModal(UIElements.groupFilterModal));
    UIElements.groupFilterCloseBtn.addEventListener('click', () => closeModal(UIElements.groupFilterModal));

    UIElements.groupFilterSaveBtn.addEventListener('click', () => {
        // Sync final state from DOM to Set
        const currentListItems = UIElements.groupFilterList.querySelectorAll('.group-filter-item');
        currentListItems.forEach(item => {
            const groupName = item.dataset.groupName;
            if (item.classList.contains('selected')) {
                tempSelectedGroups.add(groupName);
            } else {
                tempSelectedGroups.delete(groupName);
            }
        });

        const finalSelectedGroups = Array.from(tempSelectedGroups);
        if (currentGroupEditorContext === 'user-editor') {
            const triggerBtn = UIElements.groupFilterModal._triggerBtn;
            if (triggerBtn) {
                triggerBtn._selectedGroups = finalSelectedGroups;
                const count = finalSelectedGroups.length;
                triggerBtn.textContent = count > 0 ? `${count} Groups` : 'All Groups';
            }
        } else {
            // Source Editor Context
            const sourceEditorInput = document.getElementById('source-editor-selected-groups');
            if (sourceEditorInput) {
                sourceEditorInput.value = JSON.stringify(finalSelectedGroups);
            }

            const btnSpan = document.querySelector('#source-editor-filter-groups-btn span');
            if (btnSpan) {
                const count = finalSelectedGroups.length;
                btnSpan.textContent = count > 0 ? `${count} Groups Selected` : 'Select Groups';
            }
        }

        // Close the group filter modal
        closeModal(UIElements.groupFilterModal);
    });


    // --- NEW: User Group Filter Modal Listeners ---
    // These are parallel to the source editor group filter listeners but target the dedicated user modal
    const userGroupFilterTabs = {
        'live': document.getElementById('user-group-filter-tab-live'),
        'movie': document.getElementById('user-group-filter-tab-movies'),
        'series': document.getElementById('user-group-filter-tab-series')
    };

    Object.keys(userGroupFilterTabs).forEach(type => {
        const tab = userGroupFilterTabs[type];
        if (tab) {
            tab.addEventListener('click', () => {
                switchUserGroupFilterTab(type);
            });
        }
    });

    const userGroupSearch = document.getElementById('user-group-filter-search');
    if (userGroupSearch) {
        userGroupSearch.addEventListener('input', (e) => {
            const activeTab = document.querySelector('.user-group-filter-tab-btn.active');
            let type = 'live';
            if (activeTab) type = activeTab.dataset.type;
            updateUserGroupFilterList(type, Array.from(tempSelectedGroups), e.target.value);
        });
    }

    const userSelectAllBtn = document.getElementById('user-group-filter-select-all');
    if (userSelectAllBtn) {
        userSelectAllBtn.addEventListener('click', () => {
            const currentListItems = document.getElementById('user-group-filter-list').querySelectorAll('.group-filter-item');
            currentListItems.forEach(item => {
                item.classList.add('selected');
                tempSelectedGroups.add(item.dataset.groupName);
            });
        });
    }

    const userDeselectAllBtn = document.getElementById('user-group-filter-deselect-all');
    if (userDeselectAllBtn) {
        userDeselectAllBtn.addEventListener('click', () => {
            const currentListItems = document.getElementById('user-group-filter-list').querySelectorAll('.group-filter-item');
            currentListItems.forEach(item => {
                item.classList.remove('selected');
                tempSelectedGroups.delete(item.dataset.groupName);
            });
        });
    }

    const userGroupList = document.getElementById('user-group-filter-list');
    if (userGroupList) {
        userGroupList.addEventListener('click', (e) => {
            const item = e.target.closest('.group-filter-item');
            if (item) {
                item.classList.toggle('selected');
                const groupName = item.dataset.groupName;
                if (item.classList.contains('selected')) {
                    tempSelectedGroups.add(groupName);
                } else {
                    tempSelectedGroups.delete(groupName);
                }
            }
        });
    }

    document.getElementById('user-group-filter-close-btn')?.addEventListener('click', () => closeModal(document.getElementById('user-group-filter-modal')));
    document.getElementById('user-group-filter-cancel-btn')?.addEventListener('click', () => closeModal(document.getElementById('user-group-filter-modal')));

    document.getElementById('user-group-filter-save-btn')?.addEventListener('click', () => {
        // Sync final state from DOM to Set (User Context)
        // Although we updated tempSelectedGroups on click, we can do a final pass or just trust the Set.
        // We'll trust the Set as we maintained it.
        const finalSelectedGroups = Array.from(tempSelectedGroups);

        // This is ONLY for User Editor
        const modal = document.getElementById('user-group-filter-modal');
        const triggerBtn = modal._triggerBtn;
        if (triggerBtn) {
            triggerBtn._selectedGroups = finalSelectedGroups;
            if (typeof triggerBtn._onSaveGroups === 'function') {
                triggerBtn._onSaveGroups(finalSelectedGroups);
            } else {
                const count = finalSelectedGroups.length;
                triggerBtn.textContent = count > 0 ? `${count} Groups` : 'All Groups';
            }
        }

        closeModal(modal);
    });
    // --- END NEW LISTENERS ---

    // --- CORRECTED: Group Filter Button Listener (Attached on Modal Open) ---
    // Store the original function if it exists (assuming openSourceEditor is defined globally or imported)
    const originalOpenSourceEditor = typeof openSourceEditor !== 'undefined' ? openSourceEditor : null;

    // Redefine openSourceEditor to add our listener logic.
    // NOTE: This assumes openSourceEditor is defined in the same scope or imported.
    // If it's defined INSIDE setupSettingsEventListeners, this wrapping won't work easily.
    // For now, let's assume it's defined outside or imported.
    // If this causes issues, we'll need to refactor where openSourceEditor is defined.
    // --- CORRECTED DELEGATED LISTENER for Source Editor Modals ---
    // Handles clicks within the source editor, including the dynamic group filter button
    if (UIElements.sourceEditorModal) {
        UIElements.sourceEditorModal.addEventListener('click', async (e) => {
            // Check if the "Select Groups" button was clicked
            if (e.target.closest('#source-editor-filter-groups-btn')) {
                console.log('[SETTINGS] "Select Groups" button clicked (via delegation).');
                const btn = e.target;
                // Store the original HTML content (using innerHTML as setButtonLoadingState uses it)
                const originalContent = btn.innerHTML;


                // Use setButtonLoadingState ---
                // Show loading state *before* making the API call
                setButtonLoadingState(btn, true, 'Fetching...');


                const sourceType = currentSourceTypeForEditor; // Use state variable
                const sourceId = UIElements.sourceEditorId.value; // Get source ID from the hidden input
                const body = {
                    type: sourceType,
                    url: UIElements.sourceEditorUrl.value,
                    xc: sourceType === 'xc' ? JSON.stringify({
                        server: UIElements.sourceEditorXcUrl.value,
                        username: UIElements.sourceEditorXcUsername.value,
                        password: UIElements.sourceEditorXcPassword.value,
                        liveFormat: UIElements.sourceEditorXcLiveFormat.value,
                    }) : null,
                    sourceId: sourceId // <-- ADD THIS LINE
                };

                if (sourceType === 'file') {
                    showNotification('Group filtering is not available for local file sources.', true);

                    setButtonLoadingState(btn, false, originalContent);
                    return;
                }
                // Added check for file path when type is 'file' ---
                if ((sourceType === 'url' && !body.url) ||
                    (sourceType === 'xc' && (!body.xc || !JSON.parse(body.xc).server)) ||
                    (sourceType === 'file' && !UIElements.sourceEditorFileInfo.textContent) // Check if file info is present
                ) {
                    showNotification('Please enter a valid URL, XC server address, or ensure a file is selected before fetching groups.', true);
                    // --- MODIFIED: Restore button state on early exit ---
                    setButtonLoadingState(btn, false, originalContent);

                    return;
                }



                console.log('[SETTINGS] Fetching groups with body:', body);

                try {
                    const res = await apiFetch('/api/sources/fetch-groups', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        // Body now correctly includes sourceId
                        body: JSON.stringify(body)
                    });

                    if (res && res.ok) {
                        const data = await res.json();
                        console.log('[SETTINGS] Groups fetched successfully:', data.groups); // 
                        const selectedGroupsInput = document.getElementById('source-editor-selected-groups');
                        const currentlySelected = selectedGroupsInput ? JSON.parse(selectedGroupsInput.value || '[]') : [];

                        // Ensure helper function exists before calling
                        if (typeof populateGroupFilterModal === 'function') {
                            populateGroupFilterModal(data.groups || [], currentlySelected);
                            openModal(UIElements.groupFilterModal);
                        } else {
                            console.error('[SETTINGS] populateGroupFilterModal function not found!');
                            showNotification('UI Error: Cannot display group filter.', true);
                        }
                    } else {
                        console.error('[SETTINGS] Failed to fetch groups. Response:', res); // 
                        // apiFetch shows notification
                    }
                } catch (fetchError) {
                    console.error('[SETTINGS] Error during fetch-groups API call:', fetchError);
                    showNotification('An error occurred while trying to fetch groups.', true);
                } finally {
                    // Restore button state regardless of success or failure
                    setButtonLoadingState(btn, false, originalContent);
                }

            }
            // Handle Refresh Groups button ---
            else if (e.target.closest('#source-editor-refresh-groups-btn')) { // Use closest for icon clicks
                console.log('[SETTINGS] "Refresh Groups" button clicked.');
                const btn = e.target.closest('#source-editor-refresh-groups-btn'); // Get the button element
                const originalContent = btn.innerHTML; // Store original icon HTML
                setButtonLoadingState(btn, true, ''); // Show spinner (no text needed for icon button)

                const sourceType = currentSourceTypeForEditor;
                const sourceId = UIElements.sourceEditorId.value; // Get source ID being edited
                const body = {
                    type: sourceType,
                    url: UIElements.sourceEditorUrl.value,
                    xc: sourceType === 'xc' ? JSON.stringify({
                        server: UIElements.sourceEditorXcUrl.value,
                        username: UIElements.sourceEditorXcUsername.value,
                        password: UIElements.sourceEditorXcPassword.value,
                        liveFormat: UIElements.sourceEditorXcLiveFormat.value,
                    }) : null,
                    refresh: true, // Tell the backend to force refresh
                    sourceId: sourceId // Pass sourceId for cache update
                };

                if (sourceType === 'file') {
                    showNotification('Cannot refresh groups for local file sources.', true);
                    setButtonLoadingState(btn, false, originalContent);
                    return;
                }
                if ((sourceType === 'url' && !body.url) || (sourceType === 'xc' && (!body.xc || !JSON.parse(body.xc).server))) {
                    showNotification('Please enter a valid URL or XC server address before refreshing groups.', true);
                    setButtonLoadingState(btn, false, originalContent);
                    return;
                }

                console.log('[SETTINGS] Refreshing groups with body:', body);

                try {
                    const res = await apiFetch('/api/sources/fetch-groups', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        // Body now correctly includes sourceId and refresh flag
                        body: JSON.stringify(body)
                    });

                    if (res && res.ok) {
                        const data = await res.json();
                        const groupCount = Array.isArray(data.groups)
                            ? data.groups.length
                            : ((data.groups?.live?.length || 0) + (data.groups?.movie?.length || 0) + (data.groups?.series?.length || 0));
                        showNotification(`Groups refreshed successfully (${groupCount} found).`, false);
                        // Optionally, auto-open the select modal after refresh:
                        // const selectedGroupsInput = document.getElementById('source-editor-selected-groups');
                        // const currentlySelected = selectedGroupsInput ? JSON.parse(selectedGroupsInput.value || '[]') : [];
                        // populateGroupFilterModal(data.groups || [], currentlySelected);
                        // openModal(UIElements.groupFilterModal);
                    } // apiFetch handles errors
                } catch (fetchError) {
                    console.error('[SETTINGS] Error during group refresh API call:', fetchError);
                    showNotification('An error occurred while refreshing groups.', true);
                } finally {
                    setButtonLoadingState(btn, false, originalContent); // Restore icon
                }
            }

        });
        console.log('[SETTINGS] Added delegated click listener to source editor modal.');
    } else {
        console.error('[SETTINGS] Cannot add delegated listener: Source Editor Modal element not found.');
    }

    // Add other delegated click handlers for the source editor modal here if needed

    // Make sure helper functions are defined outside or properly imported/accessible
    // Assuming populateGroupFilterModal and updateGroupFilterList are defined elsewhere in settings.js

    // --- LOG MANAGEMENT EVENT LISTENERS ---

    // Log settings inputs
    if (UIElements.logMaxFilesInput) {
        UIElements.logMaxFilesInput.addEventListener('change', async () => {
            const maxFiles = parseInt(UIElements.logMaxFilesInput.value, 10);
            if (maxFiles >= 1 && maxFiles <= 50) {
                await saveSettingAndNotify(saveGlobalSetting, {
                    logs: { ...guideState.settings.logs, maxFiles }
                });
            }
        });
    }

    if (UIElements.logMaxSizeInput) {
        UIElements.logMaxSizeInput.addEventListener('change', async () => {
            const maxSizeMB = parseInt(UIElements.logMaxSizeInput.value, 10);
            if (maxSizeMB >= 1 && maxSizeMB <= 100) {
                await saveSettingAndNotify(saveGlobalSetting, {
                    logs: { ...guideState.settings.logs, maxFileSizeBytes: maxSizeMB * 1024 * 1024 }
                });
            }
        });
    }

    if (UIElements.logAutoDeleteDaysInput) {
        UIElements.logAutoDeleteDaysInput.addEventListener('change', async () => {
            const autoDeleteDays = parseInt(UIElements.logAutoDeleteDaysInput.value, 10);
            if (autoDeleteDays >= 0) {
                await saveSettingAndNotify(saveGlobalSetting, {
                    logs: { ...guideState.settings.logs, autoDeleteDays }
                });
            }
        });
    }

    // Download logs button
    if (UIElements.downloadLogsBtn) {
        console.log('[SETTINGS] Attaching download logs button listener');
        UIElements.downloadLogsBtn.addEventListener('click', handleDownloadLogs);
    } else {
        console.warn('[SETTINGS] Download logs button element not found!');
    }

    // Clear logs button
    if (UIElements.clearLogsBtn) {
        console.log('[SETTINGS] Attaching clear logs button listener');
        UIElements.clearLogsBtn.addEventListener('click', handleClearLogs);
    } else {
        console.warn('[SETTINGS] Clear logs button element not found!');
    }

    // --- LOGO & IMAGE CACHE MANAGEMENT EVENT LISTENERS ---
    if (UIElements.storeLogosInternallyToggle) {
        UIElements.storeLogosInternallyToggle.addEventListener('change', async (e) => {
            const enabled = e.target.checked;
            const ok = await saveSettingAndNotify(saveGlobalSetting, { storeLogosInternally: enabled });
            if (ok) {
                await refreshLogoCacheInfo();
                await reloadChannelsInMemoryAfterLogoChange();
            }
        });
    }

    if (UIElements.smartLogoMatchingToggle) {
        UIElements.smartLogoMatchingToggle.addEventListener('change', async (e) => {
            const enabled = e.target.checked;
            const ok = await saveSettingAndNotify(saveGlobalSetting, { smartLogoMatching: enabled });
            if (ok) {
                await refreshLogoCacheInfo();
                await reloadChannelsInMemoryAfterLogoChange();
            }
        });
    }

    if (UIElements.syncLogosNowBtn) {
        UIElements.syncLogosNowBtn.addEventListener('click', handleSyncLogosNow);
    }

    if (UIElements.clearChannelLogosBtn) {
        UIElements.clearChannelLogosBtn.addEventListener('click', handleClearChannelLogos);
    }

    if (UIElements.clearVodPostersBtn) {
        UIElements.clearVodPostersBtn.addEventListener('click', handleClearVodPosters);
    }

}; // Closing brace for setupSettingsEventListeners (ensure this matches your file structure)
