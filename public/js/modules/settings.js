/**
 * settings.js
 * * Manages all functionality of the Settings page, including
 * data sources, player settings, and user management.
 */

import { appState, guideState, UIElements } from './state.js';
import { apiFetch, saveGlobalSetting, saveUserSetting, fetchAppVersion } from './api.js';
// MODIFIED: Import isProcessingRunning for the button logic
import { showNotification, openModal, closeModal, showConfirm, setButtonLoadingState, showProcessingModal, isProcessingRunning } from './ui.js';
import { handleGuideLoad } from './guide.js';
import { navigate } from './ui.js';
import { ICONS } from './icons.js';

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

/**
 * Renders the source list for the User Editor Modal.
 * @param {object|null} user - The user object (null for new user).
 */
const renderUserSourceList = (user) => {
    const listEl = UIElements.userEditorSourceList;
    if (!listEl) return;
    listEl.innerHTML = '';

    const m3uSources = guideState.settings.m3uSources || [];
    // Only M3U sources act as content providers we filter. EPG sources are just metadata.
    // If strict EPG filtering is needed, we can add them, but usually they are 1-1 with M3U or global.
    // Focusing on M3U sources for access control.

    if (m3uSources.length === 0) {
        listEl.innerHTML = `<tr><td colspan="3" class="text-center text-gray-500 py-4">No sources available.</td></tr>`;
        return;
    }

    let allowedSources = null;
    if (user && user.allowed_sources) {
        try {
            allowedSources = JSON.parse(user.allowed_sources);
        } catch (e) {
            console.error("Error parsing user allowed_sources:", e);
        }
    }

    m3uSources.forEach(source => {
        // PERMISSION LOGIC:
        // If allowedSources is null (legacy or admin-like), default to ALLOWED.
        // If allowedSources exists, check if this source is in it.
        // For NEW users (user is null), default to ALLOWED (or user choice, but UI defaults to checked).

        let isAllowed = true;
        let groupCount = 0;
        let selectedGroups = [];

        if (allowedSources) {
            // If permissions exist, strict whitelist.
            if (allowedSources[source.id] && allowedSources[source.id].allowed) {
                isAllowed = true;
                selectedGroups = allowedSources[source.id].groups || [];
                groupCount = selectedGroups.length;
            } else {
                isAllowed = false;
            }
        }
        // If !allowedSources, we assume full access, so isAllowed=true, groupCount=0 (all).

        const tr = document.createElement('tr');
        tr.className = "hover:bg-gray-700/30 transition-colors";
        tr.dataset.sourceId = source.id;
        tr.innerHTML = `
            <td class="px-3 py-2 text-center">
                <input type="checkbox" class="user-source-checkbox h-4 w-4 text-blue-600 bg-gray-700 border-gray-600 rounded focus:ring-blue-500" ${isAllowed ? 'checked' : ''}>
            </td>
            <td class="px-3 py-2 text-gray-300 font-medium">${source.name}</td>
            <td class="px-3 py-2 text-right">
                <button type="button" class="user-group-filter-btn text-xs font-bold py-1 px-3 rounded-full transition-colors ${isAllowed ? 'bg-blue-600 hover:bg-blue-500 text-white' : 'bg-gray-600 text-gray-400 cursor-not-allowed'}" ${isAllowed ? '' : 'disabled'}>
                    ${groupCount > 0 ? `${groupCount} Groups` : 'All Groups'}
                </button>
            </td>
        `;

        // Store current groups on the button or row for easy access
        // We'll attach it to the DOM element property to avoid parsing JSON in attributes
        const btn = tr.querySelector('.user-group-filter-btn');
        btn.dataset.sourceId = source.id;
        btn._selectedGroups = selectedGroups; // Direct property assignment

        // Checkbox listener to toggle button state
        const checkbox = tr.querySelector('.user-source-checkbox');
        checkbox.addEventListener('change', (e) => {
            const checked = e.target.checked;
            btn.disabled = !checked;
            btn.classList.toggle('bg-blue-600', checked);
            btn.classList.toggle('hover:bg-blue-500', checked);
            btn.classList.toggle('text-white', checked);
            btn.classList.toggle('bg-gray-600', !checked);
            btn.classList.toggle('text-gray-400', !checked);
            btn.classList.toggle('cursor-not-allowed', !checked);
        });

        // Button listener
        btn.addEventListener('click', () => {
            openUserGroupFilterModal(source.id, btn._selectedGroups, source.name, btn);
        });

        listEl.appendChild(tr);
    });
};

/**
 * Opens the Group Filter Modal for a User.
 */
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
            if (Array.isArray(data)) {
                allGroups = data;
            } else if (data.groups) {
                allGroups = data.groups;
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
            // Ensure strict type check (it should be an array)
            if (typeof source.selectedGroups === 'string') {
                try { source.selectedGroups = JSON.parse(source.selectedGroups); } catch (e) { }
            }
            if (Array.isArray(source.selectedGroups)) {
                allGroups = allGroups.filter(g => source.selectedGroups.includes(g));
            }
        }

        // If we still have no groups, maybe just show the passed selected groups?
        if (allGroups.length === 0 && selectedGroups.length > 0) {
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
        btnElement.textContent = selectedGroups.length > 0 ? `${selectedGroups.length} Groups` : 'All Groups';
        btnElement.disabled = false;
    }
};

// --- Reusable Group Filter Logic ---

const populateGroupFilterModal = (allGroups, selectedGroups) => {
    tempSelectedGroups.clear();
    selectedGroups.forEach(group => tempSelectedGroups.add(group));
    const groups = { live: [], movie: [], series: [] };

    allGroups.forEach(group => {
        const gLower = group.toLowerCase();
        if (gLower.includes('movie') || gLower.includes('film') || gLower.includes('vod')) {
            groups.movie.push(group);
        } else if (gLower.includes('series') || gLower.includes('show') || gLower.includes('tv')) {
            groups.series.push(group);
        } else {
            groups.live.push(group);
        }
    });

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
    selectedGroups.forEach(group => tempSelectedGroups.add(group));
    const groups = { live: [], movie: [], series: [] };

    allGroups.forEach(group => {
        const gLower = group.toLowerCase();
        if (gLower.includes('movie') || gLower.includes('film') || gLower.includes('vod')) {
            groups.movie.push(group);
        } else if (gLower.includes('series') || gLower.includes('show') || gLower.includes('tv')) {
            groups.series.push(group);
        } else {
            groups.live.push(group);
        }
    });

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

    // Run hardware detection which may add new profiles to the state
    const hardware = await handleHardwareDetection();

    // One-time timezone auto-detection and setting.
    const timezoneSetFlag = localStorage.getItem('vini_timezone_auto_set');
    if (!timezoneSetFlag) {
        const browserOffset = Math.round(-(new Date().getTimezoneOffset() / 60));
        settings.timezoneOffset = browserOffset;
        console.log(`[SETTINGS] First-run timezone detection. Setting to browser offset: ${browserOffset} and saving.`);
        saveGlobalSetting({ timezoneOffset: browserOffset });
        localStorage.setItem('vini_timezone_auto_set', 'true');
    } else {
        settings.timezoneOffset = settings.timezoneOffset ?? Math.round(-(new Date().getTimezoneOffset() / 60));
    }

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

    // Fetch and display log info (admin only)
    if (appState.currentUser?.isAdmin) {
        refreshLogInfo();
    }

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

    // --- OIDC Settings UI ---
    loadOidcSettingsUI(settings);

    // FIX: Only refresh the user list if the current user is an admin.
    // This prevents errors for non-admin users during the initial app load.
    if (appState.currentUser?.isAdmin) {
        refreshUserList();
    }
};


// --- User Management (Admin) ---

/**
 * Fetches the user list from the server and renders it.
 */
export const refreshUserList = async () => {
    // No admin check needed here as the whole page is admin-only.
    try {
        const res = await apiFetch('/api/users');
        if (!res) return;
        const users = await res.json();
        UIElements.userList.innerHTML = users.map(user => `
            <tr data-user-id="${user.id}">
                <td class="px-4 py-3 whitespace-nowrap text-sm text-white">${user.username}</td>
                <td class="px-4 py-3 whitespace-nowrap text-sm">${user.isAdmin ? '<span class="px-2 inline-flex text-xs leading-5 font-semibold rounded-full bg-green-200 text-green-800">Admin</span>' : '<span class="px-2 inline-flex text-xs leading-5 font-semibold rounded-full bg-gray-200 text-gray-800">User</span>'}</td>
                <td class="px-4 py-3 whitespace-nowrap text-sm">${user.canUseDvr ? '<span class="px-2 inline-flex text-xs leading-5 font-semibold rounded-full bg-blue-200 text-blue-800">Yes</span>' : '<span class="px-2 inline-flex text-xs leading-5 font-semibold rounded-full bg-gray-200 text-gray-800">No</span>'}</td>
                <td class="px-4 py-3 whitespace-nowrap text-right text-sm font-medium">
                    <button class="text-blue-400 hover:text-blue-600 edit-user-btn">Edit</button>
                    <button class="text-red-400 hover:text-red-600 ml-4 delete-user-btn" ${appState.currentUser.username === user.username ? 'disabled' : ''}>Delete</button>
                </td>
            </tr>
        `).join('');
    } catch (error) {
        console.error("Failed to refresh user list:", error);
        UIElements.userList.innerHTML = `<tr><td colspan="4" class="text-center text-red-400 py-4">Failed to load users.</td></tr>`;
    }
};

/**
 * Opens the user editor modal, optionally pre-filled with user data.
 * @param {object|null} user - The user object to edit, or null to add a new user.
 */
const openUserEditor = (user = null) => {
    UIElements.userEditorId.value = user ? user.id : '';
    UIElements.userEditorUsername.value = user ? user.username : '';
    UIElements.userEditorPassword.value = '';
    UIElements.userEditorIsAdmin.checked = user ? user.isAdmin : false;
    UIElements.userEditorCanUseDvr.checked = user ? user.canUseDvr : false;
    UIElements.userEditorTitle.textContent = user ? 'Edit User' : 'Add New User';
    UIElements.userEditorError.classList.add('hidden');
    renderUserSourceList(user);
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
                    let allGroups = [];
                    if (Array.isArray(data)) allGroups = data;
                    else if (data.groups) allGroups = data.groups;

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
                    } catch (e) {
                        console.error("Could not parse XC data for editing:", e);
                        // Clear fields if data is corrupt
                        UIElements.sourceEditorXcUrl.value = '';
                        UIElements.sourceEditorXcUsername.value = '';
                        UIElements.sourceEditorXcPassword.value = '';
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
        // FINAL FIX: Replace the local state completely, don't merge it.
        guideState.settings = updatedSettings;
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

/**
 * Sets up all event listeners for the settings page.
 */
export function setupSettingsEventListeners() {

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
    UIElements.userEditorForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        const id = UIElements.userEditorId.value;
        const body = {
            username: UIElements.userEditorUsername.value,
            password: UIElements.userEditorPassword.value,
            isAdmin: UIElements.userEditorIsAdmin.checked,
            canUseDvr: UIElements.userEditorCanUseDvr.checked,
            // Capture allowed sources
            allowed_sources: (() => {
                const map = {};
                // Iterate through source list
                const rows = UIElements.userEditorSourceList.querySelectorAll('tr');
                rows.forEach(row => {
                    const sourceId = row.dataset.sourceId;
                    const checkbox = row.querySelector('.user-source-checkbox');
                    const btn = row.querySelector('.user-group-filter-btn');

                    if (checkbox && checkbox.checked) {
                        map[sourceId] = {
                            allowed: true,
                            groups: btn._selectedGroups || []
                        };
                    } else {
                        // Implicitly not allowed, but if we want to save "blocked", we can.
                        // For now, if not in map, it's not allowed.
                    }
                });
                return map;
            })()
        };
        if (!body.password) delete body.password; // Don't send empty password if not changing

        const url = id ? `/api/users/${id}` : '/api/users';
        const method = id ? 'PUT' : 'POST';

        const res = await apiFetch(url, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
        // apiFetch handles errors, but we need the success case
        if (res && res.ok) {
            closeModal(UIElements.userEditorModal);
            refreshUserList(); // Refresh the list on success
            showNotification(`User ${id ? 'updated' : 'added'} successfully.`);

            // --- FIX: Auto-refresh if current user was updated ---
            console.log('[DEBUG_REFRESH] Checking for auto-refresh...');
            console.log('[DEBUG_REFRESH] Edited User ID:', id);
            console.log('[DEBUG_REFRESH] Current User State:', appState.currentUser);
            if (appState.currentUser) console.log('[DEBUG_REFRESH] Current User ID:', appState.currentUser.id);

            if (id && appState.currentUser && String(appState.currentUser.id) === String(id)) {
                console.log('[DEBUG_REFRESH] User match! Triggering reload.');
                showNotification('Your settings have changed. Reloading application...', 'info', 2000);
                setTimeout(() => window.location.reload(), 2000);
            } else {
                console.log('[DEBUG_REFRESH] User mismatch or missing data. No reload.');
            }
        } else if (res) {
            // Display specific error from backend if available
            const data = await res.json().catch(() => ({ error: 'An unknown error occurred.' }));
            UIElements.userEditorError.textContent = data.error;
            UIElements.userEditorError.classList.remove('hidden');
        }
    });
    // User List Click Handler (Edit/Delete)
    UIElements.userList.addEventListener('click', async (e) => {
        const target = e.target;
        if (target.disabled) return; // Ignore clicks on disabled buttons (like delete self)
        const row = target.closest('tr');
        if (!row) return;
        const userId = row.dataset.userId;

        if (target.classList.contains('edit-user-btn')) {
            // Fetch the specific user's details again before opening the editor
            // This ensures we have the latest data, though refreshUserList usually covers it.
            // For simplicity, we can rely on the data used to render the table if refreshUserList is called often.
            // Let's assume refreshUserList keeps the UI consistent for now.
            const res = await apiFetch(`/api/users?t=${Date.now()}`); // Re-fetch all users to find the one clicked
            if (!res) return;
            const users = await res.json();
            const user = users.find(u => u.id == userId); // Use == for potential type difference
            if (user) {
                openUserEditor(user);
            } else {
                showNotification('Could not find user data to edit.', true);
            }
        }

        if (target.classList.contains('delete-user-btn')) {
            showConfirm('Delete User?', 'Are you sure? This action cannot be undone.', async () => {
                const res = await apiFetch(`/api/users/${userId}`, { method: 'DELETE' });
                if (res?.ok) { // Check for ok status explicitly
                    refreshUserList();
                    showNotification('User deleted.');
                }
                // apiFetch handles error notification
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
            const count = finalSelectedGroups.length;
            triggerBtn.textContent = count > 0 ? `${count} Groups` : 'All Groups';
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
                        showNotification(`Groups refreshed successfully (${data.groups.length} found).`, false);
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

    // --- OIDC Settings Event Listeners ---
    setupOidcSettingsListeners();

}; // Closing brace for setupSettingsEventListeners (ensure this matches your file structure)

// --- OIDC Settings Functions ---

/**
 * Loads OIDC settings into the UI elements
 * @param {object} settings - The current settings object
 */
function loadOidcSettingsUI(settings) {
    const oidc = settings.oidc || {};
    
    const enabledToggle = document.getElementById('oidc-enabled-toggle');
    const configFields = document.getElementById('oidc-config-fields');
    const issuerUrl = document.getElementById('oidc-issuer-url');
    const clientId = document.getElementById('oidc-client-id');
    const clientSecret = document.getElementById('oidc-client-secret');
    const redirectUri = document.getElementById('oidc-redirect-uri');
    const scopes = document.getElementById('oidc-scopes');
    const buttonText = document.getElementById('oidc-button-text-input');
    const usernameClaim = document.getElementById('oidc-username-claim');
    const autoCreateToggle = document.getElementById('oidc-auto-create-toggle');
    const defaultAdminToggle = document.getElementById('oidc-default-admin-toggle');
    const defaultDvrToggle = document.getElementById('oidc-default-dvr-toggle');
    
    if (!enabledToggle) return; // OIDC elements not present
    
    // Set values - use explicit boolean check for enabled
    enabledToggle.checked = oidc.enabled === true;
    if (issuerUrl) issuerUrl.value = oidc.issuerUrl || '';
    if (clientId) clientId.value = oidc.clientId || '';
    if (clientSecret) clientSecret.value = oidc.clientSecret || '';
    if (redirectUri) {
        // Auto-populate redirect URI if empty
        if (!oidc.redirectUri) {
            redirectUri.value = `${window.location.origin}/api/auth/oidc/callback`;
        } else {
            redirectUri.value = oidc.redirectUri;
        }
    }
    if (scopes) scopes.value = oidc.scopes || 'openid profile email';
    if (buttonText) buttonText.value = oidc.buttonText || 'Login with SSO';
    if (usernameClaim) usernameClaim.value = oidc.claimMapping?.username || 'preferred_username';
    if (autoCreateToggle) autoCreateToggle.checked = oidc.autoCreateUsers !== false; // Default true
    if (defaultAdminToggle) defaultAdminToggle.checked = oidc.defaultIsAdmin || false;
    if (defaultDvrToggle) defaultDvrToggle.checked = oidc.defaultCanUseDvr !== false; // Default true
    
    // Show/hide config fields based on enabled state
    if (configFields) {
        configFields.classList.toggle('hidden', !enabledToggle.checked);
    }
}

/**
 * Sets up event listeners for OIDC settings
 */
function setupOidcSettingsListeners() {
    const enabledToggle = document.getElementById('oidc-enabled-toggle');
    const configFields = document.getElementById('oidc-config-fields');
    const saveBtn = document.getElementById('oidc-save-btn');
    
    if (!enabledToggle) return; // OIDC elements not present
    
    // Toggle config fields visibility and auto-save when disabling
    enabledToggle.addEventListener('change', async () => {
        if (configFields) {
            configFields.classList.toggle('hidden', !enabledToggle.checked);
        }
        
        // Auto-save when disabling OIDC (no validation needed)
        if (!enabledToggle.checked) {
            try {
                const oidcSettings = {
                    ...guideState.settings.oidc,
                    enabled: false
                };
                const success = await saveGlobalSetting({ oidc: oidcSettings });
                if (success) {
                    showNotification('OIDC disabled.');
                    guideState.settings.oidc = oidcSettings;
                }
            } catch (err) {
                console.error('[OIDC] Error disabling:', err);
                showNotification('Failed to disable OIDC.', true);
                // Revert toggle on error
                enabledToggle.checked = true;
                if (configFields) configFields.classList.remove('hidden');
            }
        }
    });
    
    // Save OIDC settings
    if (saveBtn) {
        saveBtn.addEventListener('click', async () => {
            const oidcSettings = {
                enabled: document.getElementById('oidc-enabled-toggle')?.checked === true,
                issuerUrl: document.getElementById('oidc-issuer-url')?.value?.trim() || '',
                clientId: document.getElementById('oidc-client-id')?.value?.trim() || '',
                clientSecret: document.getElementById('oidc-client-secret')?.value || '',
                redirectUri: document.getElementById('oidc-redirect-uri')?.value?.trim() || '',
                scopes: document.getElementById('oidc-scopes')?.value?.trim() || 'openid profile email',
                buttonText: document.getElementById('oidc-button-text-input')?.value?.trim() || 'Login with SSO',
                autoCreateUsers: document.getElementById('oidc-auto-create-toggle')?.checked === true,
                defaultIsAdmin: document.getElementById('oidc-default-admin-toggle')?.checked === true,
                defaultCanUseDvr: document.getElementById('oidc-default-dvr-toggle')?.checked === true,
                claimMapping: {
                    username: document.getElementById('oidc-username-claim')?.value || 'preferred_username',
                    email: 'email'
                }
            };
            
            // Validation
            if (oidcSettings.enabled) {
                if (!oidcSettings.issuerUrl) {
                    showNotification('Issuer URL is required when OIDC is enabled.', true);
                    return;
                }
                if (!oidcSettings.clientId) {
                    showNotification('Client ID is required when OIDC is enabled.', true);
                    return;
                }
                if (!oidcSettings.clientSecret) {
                    showNotification('Client Secret is required when OIDC is enabled.', true);
                    return;
                }
                if (!oidcSettings.redirectUri) {
                    showNotification('Redirect URI is required when OIDC is enabled.', true);
                    return;
                }
            }
            
            try {
                const success = await saveGlobalSetting({ oidc: oidcSettings });
                if (success) {
                    showNotification('OIDC settings saved successfully.');
                    // Update local state
                    guideState.settings.oidc = oidcSettings;
                }
            } catch (err) {
                console.error('[OIDC] Error saving settings:', err);
                showNotification('Failed to save OIDC settings.', true);
            }
        });
    }
}
