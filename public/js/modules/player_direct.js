/**
 * player_direct.js
 * * Manages the functionality for the direct stream player page.
 * This has been updated to include recent links, a stop button, direct play vs. proxy,
 * and a logging console for better error feedback.
 */

import { UIElements, guideState, appState } from './state.js';
import { showNotification } from './ui.js';
// MODIFIED: Import stopStream to explicitly kill the server process.
import { saveUserSetting, stopStream, startRedirectStream, stopRedirectStream, sendRedirectHeartbeat } from './api.js';

const MAX_RECENT_LINKS = 10;
let currentStreamUrl = null; // NEW: Track the URL of the current stream
let statisticsInterval = null; // NEW: Interval for logging stream statistics.
let currentRedirectHistoryId = null; // To track redirect streams for logging
let redirectHeartbeatInterval = null; // NEW: Heartbeat timer for direct player redirect
let currentRedirectToken = 0; // NEW: Guard against race conditions

/**
 * Starts periodic 30s heartbeat pings for an active redirect stream.
 * @param {number} historyId
 */
function startRedirectHeartbeat(historyId) {
    stopRedirectHeartbeat();
    if (!historyId) return;
    redirectHeartbeatInterval = setInterval(async () => {
        if (currentRedirectHistoryId === historyId) {
            await sendRedirectHeartbeat(historyId);
        } else {
            stopRedirectHeartbeat();
        }
    }, 30000);
}

/**
 * Stops the redirect stream heartbeat interval.
 */
function stopRedirectHeartbeat() {
    if (redirectHeartbeatInterval) {
        clearInterval(redirectHeartbeatInterval);
        redirectHeartbeatInterval = null;
    }
}

/**
 * Starts a redirect logging session with heartbeat and race condition guarding.
 */
function beginRedirectLogging(url, channelId, channelName, channelLogo) {
    if (currentRedirectHistoryId) {
        stopRedirectStream(currentRedirectHistoryId);
        currentRedirectHistoryId = null;
    }
    stopRedirectHeartbeat();

    const token = ++currentRedirectToken;

    startRedirectStream(url, channelId, channelName, channelLogo)
        .then(historyId => {
            if (!historyId) return;
            if (token !== currentRedirectToken) {
                stopRedirectStream(historyId);
                return;
            }
            currentRedirectHistoryId = historyId;
            startRedirectHeartbeat(historyId);
        })
        .catch(err => console.error('[DIRECT_PLAYER] Error logging redirect stream start:', err));
}

// --- Helper Functions ---

/**
 * Formats time in seconds to HH:MM:SS or MM:SS format
 * @param {number} seconds - Time in seconds
 * @returns {string} Formatted time string
 */
function formatTime(seconds) {
    if (isNaN(seconds) || seconds === Infinity) return '--:--';
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const secs = Math.floor(seconds % 60);

    if (hours > 0) {
        return `${hours}:${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
    }
    return `${minutes}:${String(secs).padStart(2, '0')}`;
}

/**
 * Logs a message to the on-screen player console.
 * @param {string} message - The message to display.
 * @param {boolean} isError - If true, styles the message as an error.
 */
export function logToPlayerConsole(message, isError = false) {
    const consoleEl = UIElements.directPlayerConsole;
    if (!consoleEl) return;

    const timestamp = new Date().toLocaleTimeString();
    const logEntry = document.createElement('p');
    logEntry.innerHTML = `<span class="text-gray-500">${timestamp}:</span> <span class="${isError ? 'text-red-400' : 'text-gray-300'}">${message}</span>`;

    consoleEl.appendChild(logEntry);
    consoleEl.scrollTop = consoleEl.scrollHeight; // Auto-scroll to the bottom
}

/**
 * Retrieves the list of recent links from the central guideState object.
 * @returns {Array<string>} An array of URLs.
 */
function getRecentLinks() {
    return guideState.settings.recentDirectLinks || [];
}

/**
 * Saves the list of recent links to the server via the API.
 * @param {Array<string>} links - The array of URLs to save.
 */
function saveRecentLinks(links) {
    guideState.settings.recentDirectLinks = links;
    saveUserSetting('recentDirectLinks', links);
}

/**
 * Adds a new URL to the recent links list.
 * @param {string} url - The URL to add.
 */
function addRecentLink(url) {
    let links = getRecentLinks();
    links = links.filter(link => link !== url);
    links.unshift(url);
    links = links.slice(0, MAX_RECENT_LINKS);
    saveRecentLinks(links);
}

/**
 * Renders the recent links table in the UI.
 */
function renderRecentLinks() {
    const links = getRecentLinks();
    const tbody = UIElements.recentLinksTbody;

    UIElements.noRecentLinksMessage.classList.toggle('hidden', links.length > 0);
    UIElements.recentLinksTableContainer.classList.toggle('hidden', links.length === 0);

    if (!tbody) return;
    tbody.innerHTML = '';

    links.forEach(link => {
        const tr = document.createElement('tr');
        tr.innerHTML = `
            <td class="max-w-md truncate" title="${link}">
                <a href="#" class="replay-link text-blue-400 hover:underline" data-url="${link}">${link}</a>
            </td>
            <td class="text-right">
                <button class="action-btn delete-recent-link-btn p-1" title="Delete Link" data-url="${link}">
                    <svg class="w-5 h-5" fill="currentColor" viewBox="0 0 20 20"><path fill-rule="evenodd" d="M9 2a1 1 0 00-.894.553L7.382 4H4a1 1 0 000 2v10a2 2 0 002 2h8a2 2 0 002-2V6a1 1 0 100-2h-3.382l-.724-1.447A1 1 0 0011 2H9zM7 8a1 1 0 012 0v6a1 1 0 11-2 0V8zm5-1a1 1 0 00-1 1v6a1 1 0 102 0V8a1 1 0 00-1-1z" clip-rule="evenodd" /></svg>
                </button>
            </td>
        `;
        tbody.appendChild(tr);
    });
}

/**
 * Detects if a URL is a video file or a live stream based on extension.
 * Used by Direct Player to determine playback method.
 * @param {string} url - The URL to analyze
 * @returns {object} - { isVOD: boolean, extension: string, type: 'vod'|'stream' }
 */
function detectStreamType(url) {
    const vodExtensions = ['.mkv', '.mp4', '.avi', '.mov', '.webm', '.m4v', '.flv', '.wmv', '.mpg', '.mpeg'];
    const streamExtensions = ['.ts', '.m3u8'];

    const urlLower = url.toLowerCase();

    for (const ext of vodExtensions) {
        if (urlLower.includes(ext)) {
            return { isVOD: true, extension: ext, type: 'vod' };
        }
    }

    for (const ext of streamExtensions) {
        if (urlLower.includes(ext)) {
            return { isVOD: false, extension: ext, type: 'stream' };
        }
    }

    // Default to stream if unknown
    return { isVOD: false, extension: 'unknown', type: 'stream' };
}

// --- Player Lifecycle Functions ---

/**
 * Initializes the Direct Player page.
 */
export function initDirectPlayer() {
    console.log('[DEBUG] initDirectPlayer: Initializing Direct Player page.');
    // Check if the player is active and perform cleanup if necessary
    if (isDirectPlayerActive()) {
        console.log('[DEBUG] initDirectPlayer: An active player was found. Cleaning it up.');
        stopAndCleanupDirectPlayer();
    }
    if (UIElements.directPlayerForm) {
        UIElements.directPlayerForm.reset();
    }

    const savedDirectPlayState = guideState.settings.directPlayEnabled === true;
    UIElements.directPlayCheckbox.checked = savedDirectPlayState;

    renderRecentLinks();
}

/**
 * Stops the current stream and cleans up the player instance and UI.
 */
async function stopAndCleanupDirectPlayer() {
    console.log('[DEBUG] stopAndCleanupDirectPlayer: Function called.');

    // NEW: Stop redirect heartbeat and invalidate token
    stopRedirectHeartbeat();
    currentRedirectToken++;

    // If we were logging a redirect stream, tell the server it has stopped.
    if (currentRedirectHistoryId) {
        stopRedirectStream(currentRedirectHistoryId);
        currentRedirectHistoryId = null;
    }

    // NEW: Clear the statistics logging interval.
    if (statisticsInterval) {
        clearInterval(statisticsInterval);
        statisticsInterval = null;
    }

    // If a stream is active, explicitly tell the server to stop it
    if (currentStreamUrl) {
        console.log(`[DEBUG] stopAndCleanupDirectPlayer: Calling stopStream() API for URL: ${currentStreamUrl}.`);
        await stopStream(currentStreamUrl);
        console.log('[DEBUG] stopAndCleanupDirectPlayer: stopStream() API call complete.');
    } else {
        console.log('[DEBUG] stopAndCleanupDirectPlayer: No currentStreamUrl to stop.');
    }

    if (appState.player) {
        console.log('[DEBUG] stopAndCleanupDirectPlayer: appState.player exists. Proceeding with client-side cleanup.');
        try {
            // Check if it's an mpegts.js player instance (for live streams)
            if (appState.player.pause && appState.player.unload && appState.player.detachMediaElement) {
                console.log('[DEBUG] stopAndCleanupDirectPlayer: Cleaning up mpegts.js player.');
                appState.player.pause();
                appState.player.unload();
                appState.player.detachMediaElement();
                appState.player.destroy();
            }
            // Note: Native video cleanup is handled by clearing video.src below
        } catch (e) {
            console.error('[DEBUG] stopAndCleanupDirectPlayer: Error during local player cleanup:', e);
        } finally {
            appState.player = null;
            currentStreamUrl = null; // Clear the tracked URL
            console.log('[DEBUG] stopAndCleanupDirectPlayer: Set appState.player and currentStreamUrl to null.');
        }
    } else {
        console.log('[DEBUG] stopAndCleanupDirectPlayer: No appState.player instance to clean up.');
    }
    if (UIElements.directVideoElement) {
        UIElements.directVideoElement.src = "";
        UIElements.directVideoElement.removeAttribute('src');
        UIElements.directVideoElement.load();
    }
    UIElements.directPlayerContainer.classList.add('hidden');
    UIElements.directPlayerConsoleContainer.classList.add('hidden');
    UIElements.directStopBtn.classList.add('hidden');
    UIElements.directPlayBtn.classList.remove('hidden');
    console.log('[DEBUG] stopAndCleanupDirectPlayer: UI has been reset.');
}

/**
 * Cleans up the direct player when the user navigates away from the tab.
 */
export function cleanupDirectPlayer() {
    console.log('[DEBUG] cleanupDirectPlayer: Cleaning up direct player due to navigation.');
    stopAndCleanupDirectPlayer();
}

/**
 * Checks if a stream is currently active on the direct player page.
 * @returns {boolean} True if a player instance exists in the global state.
 */
export function isDirectPlayerActive() {
    // Check if both the client-side player instance and the tracked URL exist
    const isActive = !!appState.player && !!currentStreamUrl;
    console.log(`[DEBUG] isDirectPlayerActive check: ${isActive}`);
    return isActive;
}

/**
 * Main dispatcher function that detects stream type and routes to appropriate player.
 * @param {string} url The URL of the stream or video file.
 */
function playDirectStream(url) {
    console.log(`[DEBUG] playDirectStream: Called with URL: ${url}`);

    // Only stop the current stream if we're playing a different URL
    if (currentStreamUrl && currentStreamUrl !== url) {
        console.log(`[DEBUG] playDirectStream: Stopping previous stream (different URL).`);
        stopAndCleanupDirectPlayer();
    } else if (!currentStreamUrl) {
        console.log(`[DEBUG] playDirectStream: No active stream to stop.`);
        stopAndCleanupDirectPlayer();
    } else {
        console.log(`[DEBUG] playDirectStream: Same URL already playing, not stopping.`);
    }

    const consoleEl = UIElements.directPlayerConsole;
    if (consoleEl) {
        consoleEl.innerHTML = ''; // Clear previous logs
    }
    UIElements.directPlayerConsoleContainer.classList.remove('hidden');
    logToPlayerConsole(`Attempting to play: ${url}`);

    // Detect the stream type
    const streamType = detectStreamType(url);
    logToPlayerConsole(`Detected format: ${streamType.extension} (Type: ${streamType.type})`);
    console.log(`[DEBUG] playDirectStream: Detected stream type:`, streamType);

    // Set the current stream URL for tracking
    currentStreamUrl = url;

    // Add to recent links
    addRecentLink(url);
    renderRecentLinks();

    // Route to appropriate playback function
    if (streamType.isVOD) {
        playVODStream(url, streamType);
    } else {
        playLiveStream(url, streamType);
    }
}

/**
 * Plays a Direct Player video file (e.g., .mkv, .mp4, .avi) using either native HTML5 video or server transcoding.
 * Note: This is NOT related to the VOD library in vod.js - this handles individual URLs pasted in Direct Player.
 * @param {string} url The URL of the video file.
 * @param {object} streamType The stream type object from detectStreamType.
 */
function playVODStream(url, streamType) {
    console.log(`[DEBUG] playVODStream: Playing VOD file with extension ${streamType.extension}`);

    const isDirectPlay = UIElements.directPlayCheckbox.checked;

    if (isDirectPlay) {
        // --- NATIVE / DIRECT PLAY Logic ---
        logToPlayerConsole('Direct Play is ON. Using native HTML5 <video> element.');
        console.log('[DEBUG] playVODStream: Using native HTML5 video element for direct playback.');

        // Start activity logging for redirect streams with heartbeat
        beginRedirectLogging(url, null, 'Direct Player Video', null);

        // Show player container
        UIElements.directPlayerContainer.classList.remove('hidden');
        UIElements.directStopBtn.classList.remove('hidden');
        UIElements.directPlayBtn.classList.add('hidden');

        // Set the video source directly
        UIElements.directVideoElement.src = url;
        UIElements.directVideoElement.load();

        // Set volume from localStorage
        UIElements.directVideoElement.volume = parseFloat(localStorage.getItem('iptvPlayerVolume') || 0.5);

        // Try to play
        UIElements.directVideoElement.play().then(() => {
            logToPlayerConsole(`Direct Player: Video loaded successfully for: ${url}`);
            console.log('[DEBUG] playVODStream: Native playback started.');
        }).catch((err) => {
            const errorMsg = `Cannot play ${streamType.extension} files in Direct Play mode. Browser does not support this format natively. Try unchecking Direct Play to use server transcoding.`;
            console.error('[DEBUG] playVODStream: Native playback error:', err);
            logToPlayerConsole(errorMsg, true);
            showNotification(errorMsg, true);
            stopAndCleanupDirectPlayer();
        });

    } else {
        // --- PROFILE / SERVER TRANSCODING Logic ---
        logToPlayerConsole('Direct Play is OFF. Using server transcoding via /stream endpoint.');
        console.log('[DEBUG] playVODStream: Using server /stream endpoint for transcoding.');

        const settings = guideState.settings;
        const userAgentId = settings.activeUserAgentId;

        // Auto-select the best fMP4 profile for Direct Player video files based on hardware
        // This is hidden from users for simplicity
        let profileId;
        if (guideState.hardware?.nvidia) {
            profileId = 'ffmpeg-fmp4-nvidia';
            console.log('[DEBUG] playVODStream: Auto-selected NVIDIA fMP4 profile for Direct Player video.');
        } else {
            profileId = 'ffmpeg-fmp4';
            console.log('[DEBUG] playVODStream: Auto-selected CPU fMP4 profile for Direct Player video.');
        }

        const profile = (settings.streamProfiles || []).find(p => p.id === profileId);

        if (!profileId || !userAgentId || !profile) {
            const errorMsg = "Direct Player profile not available or user agent not set. Please check settings.";
            logToPlayerConsole(errorMsg, true);
            showNotification(errorMsg, true);
            console.error(`[DEBUG] playVODStream: ${errorMsg}`);
            return;
        }

        logToPlayerConsole(`Using Profile: ${profile.name} (auto-selected for Direct Player)`);

        // For the direct player with Direct Play OFF, ALWAYS use /stream endpoint
        // This allows the server to handle transcoding and avoids CORS issues
        const streamUrlToPlay = `/stream?url=${encodeURIComponent(url)}&profileId=${profileId}&userAgentId=${userAgentId}`;

        console.log(`[DEBUG] playVODStream: Stream URL: ${streamUrlToPlay}`);
        logToPlayerConsole(`Stream URL: ${streamUrlToPlay}`);

        // Use native HTML5 video for fMP4 progressive streams
        // This is simpler and works better than Shaka Player for progressive downloads
        try {
            const video = UIElements.directVideoElement;

            console.log('[DEBUG] playVODStream: Using native HTML5 video for fMP4 stream.');
            logToPlayerConsole('Using native HTML5 video for playback.');

            // Show player container
            UIElements.directPlayerContainer.classList.remove('hidden');
            UIElements.directStopBtn.classList.remove('hidden');
            UIElements.directPlayBtn.classList.add('hidden');

            // Set volume
            video.volume = parseFloat(localStorage.getItem('iptvPlayerVolume') || 0.5);

            // Error handling
            video.addEventListener('error', (e) => {
                const error = video.error;
                let errorMsg = 'Failed to load video.';
                if (error) {
                    switch (error.code) {
                        case error.MEDIA_ERR_ABORTED:
                            errorMsg = 'Video load aborted.';
                            break;
                        case error.MEDIA_ERR_NETWORK:
                            errorMsg = 'Network error while loading video.';
                            break;
                        case error.MEDIA_ERR_DECODE:
                            errorMsg = 'Video decoding failed.';
                            break;
                        case error.MEDIA_ERR_SRC_NOT_SUPPORTED:
                            errorMsg = 'Video format not supported.';
                            break;
                    }
                }
                console.error('[DEBUG] playVODStream: Video error:', error);
                logToPlayerConsole(errorMsg, true);
                showNotification(errorMsg, true);
                stopAndCleanupDirectPlayer();
            }, { once: true });

            // Wait for metadata to be loaded before starting playback
            video.addEventListener('loadedmetadata', () => {
                console.log('[DEBUG] playVODStream: Metadata loaded. Video ready.');
                logToPlayerConsole('Video loaded. Starting playback...');

                // Start playback
                video.play().then(() => {
                    console.log('[DEBUG] playVODStream: Playback started successfully.');
                    logToPlayerConsole('Playback started successfully.');

                    // Start statistics logging
                    if (statisticsInterval) {
                        clearInterval(statisticsInterval);
                    }
                    statisticsInterval = setInterval(() => {
                        if (video.buffered.length > 0 && !video.paused) {
                            const bufferEnd = video.buffered.end(0);
                            const buffer = bufferEnd - video.currentTime;
                            const currentTime = formatTime(video.currentTime);
                            const duration = formatTime(video.duration);

                            const logMsg = `Time: ${currentTime}/${duration} --- Buffer: ${buffer.toFixed(2)}s --- Resolution: ${video.videoWidth}x${video.videoHeight}`;
                            logToPlayerConsole(logMsg);
                        }
                    }, 2000);

                }).catch((error) => {
                    if (error.name === 'AbortError') {
                        console.warn('[DEBUG] playVODStream: Playback was aborted.');
                        return;
                    }
                    const errorMsg = `Failed to start playback: ${error.message}`;
                    console.error('[DEBUG] playVODStream: Play error:', error);
                    logToPlayerConsole(errorMsg, true);
                    showNotification(errorMsg, true);
                    stopAndCleanupDirectPlayer();
                });
            }, { once: true });

            // Set the video source (this will trigger loading)
            video.src = streamUrlToPlay;

        } catch (e) {
            const errorMsg = `Failed to initialize video player: ${e.message}`;
            console.error('[DEBUG] playVODStream: Critical error:', e);
            logToPlayerConsole(errorMsg, true);
            showNotification(errorMsg, true);
            stopAndCleanupDirectPlayer();
        }
    }
}

/**
 * Plays a live stream (e.g., .ts, .m3u8) using mpegts.js.
 * @param {string} url The URL of the live stream.
 * @param {object} streamType The detected stream type object.
 */
function playLiveStream(url, streamType) {
    console.log(`[DEBUG] playLiveStream: Playing live stream with extension ${streamType.extension}`);

    const isDirectPlay = UIElements.directPlayCheckbox.checked;
    let streamUrlToPlay = url;

    if (!isDirectPlay) {
        logToPlayerConsole('Direct Play is OFF. Using server proxy.');

        const settings = guideState.settings;
        const profileIdToUse = settings.activeStreamProfileId;
        const userAgentId = settings.activeUserAgentId;

        logToPlayerConsole(`Using active stream profile from settings: ${profileIdToUse}`);

        if (!profileIdToUse || !userAgentId) {
            const errorMsg = "Active stream profile or user agent not set. Please check settings.";
            logToPlayerConsole(errorMsg, true);
            showNotification(errorMsg, true);
            return;
        }
        streamUrlToPlay = `/stream?url=${encodeURIComponent(url)}&profileId=${profileIdToUse}&userAgentId=${userAgentId}`;
        logToPlayerConsole(`Proxy URL: ${streamUrlToPlay}`);

    } else {
        logToPlayerConsole('Direct Play is ON. Connecting directly to stream.');

        // Activity Logging for Redirect Streams with heartbeat
        const allChannels = guideState.channels || [];
        const channel = allChannels.find(c => c.url === url);
        const channelId = channel ? channel.id : null;
        const channelName = channel ? (channel.displayName || channel.name) : 'Direct Stream';
        const channelLogo = channel ? channel.logo : null;
        beginRedirectLogging(url, channelId, channelName, channelLogo);
    }

    if (mpegts.isSupported()) {
        try {
            console.log(`[DEBUG] playLiveStream: Creating new mpegts.js player for URL: ${streamUrlToPlay}`);

            const mpegtsConfig = {
                enableStashBuffer: true,
                stashInitialSize: 4096,
                liveBufferLatency: 2.0,
            };
            logToPlayerConsole(`Player config: stashInitialSize=${mpegtsConfig.stashInitialSize}KB, liveBufferLatency=${mpegtsConfig.liveBufferLatency}s`);

            const newPlayer = mpegts.createPlayer({
                type: 'mse',
                isLive: true,
                url: streamUrlToPlay
            }, mpegtsConfig);

            appState.player = newPlayer;
            console.log('[DEBUG] playLiveStream: New player instance created and assigned to appState.player.');

            UIElements.directPlayerContainer.classList.remove('hidden');
            UIElements.directStopBtn.classList.remove('hidden');
            UIElements.directPlayBtn.classList.add('hidden');

            console.log('[DEBUG] playLiveStream: Attaching media element.');
            appState.player.attachMediaElement(UIElements.directVideoElement);

            appState.player.on(mpegts.Events.ERROR, (errorType, errorDetail) => {
                console.error('[DirectPlayer] MPEGTS Error:', errorType, errorDetail);
                logToPlayerConsole(`Error: ${errorType} - ${errorDetail}`, true);
                stopAndCleanupDirectPlayer();
            });

            if (statisticsInterval) {
                clearInterval(statisticsInterval);
            }
            statisticsInterval = setInterval(() => {
                if (appState.player && appState.player.statisticsInfo) {
                    const stats = appState.player.statisticsInfo;
                    const video = UIElements.directVideoElement;
                    const bufferEnd = video.buffered.length > 0 ? video.buffered.end(0) : 0;
                    const buffer = bufferEnd - video.currentTime;

                    const logMsg = `Speed: ${(stats.speed / 1024).toFixed(1)} KB/s --- Buffer: ${buffer.toFixed(2)}s --- Decoded Frames: ${stats.decodedFrames}`;
                    logToPlayerConsole(logMsg);
                }
            }, 2000);

            console.log('[DEBUG] playLiveStream: Calling player.load().');
            appState.player.load();

            console.log('[DEBUG] playLiveStream: Calling player.play().');
            appState.player.play().catch((err) => {
                if (err.name === 'AbortError') {
                    console.warn('[DEBUG] playLiveStream: Playback was aborted. This is expected if the user clicks stop or navigates away very quickly.');
                    return;
                }
                const errorMsg = `Could not play the stream. Please check the URL and console log for details.`;
                console.error("[DEBUG] playLiveStream: player.play() caught an error:", err);
                logToPlayerConsole(errorMsg, true);
                showNotification(errorMsg, true);
                stopAndCleanupDirectPlayer();
            });
            logToPlayerConsole('Player instance created and attempting to load stream.');

        } catch (e) {
            const errorMsg = 'Failed to create player instance. Check stream URL.';
            console.error('[DEBUG] playLiveStream: Critical error during player creation:', e);
            logToPlayerConsole(`${errorMsg} Details: ${e.message}`, true);
            stopAndCleanupDirectPlayer();
        }
    } else {
        const errorMsg = 'Your browser does not support the necessary technology to play this stream (Media Source Extensions).';
        logToPlayerConsole(errorMsg, true);
        showNotification(errorMsg, true);
    }
}
// --- Event Listener Setup ---

/**
 * Sets up the event listeners for the Direct Player page controls.
 */
export function setupDirectPlayerEventListeners() {
    UIElements.directPlayerForm.addEventListener('submit', (e) => {
        e.preventDefault();
        const streamUrl = UIElements.directStreamUrl.value.trim();
        if (streamUrl) {
            playDirectStream(streamUrl);
        } else {
            showNotification('Please enter a stream URL.', true);
        }
    });

    UIElements.directStopBtn.addEventListener('click', stopAndCleanupDirectPlayer);

    UIElements.directPlayCheckbox.addEventListener('change', () => {
        const isEnabled = UIElements.directPlayCheckbox.checked;
        guideState.settings.directPlayEnabled = isEnabled;
        saveUserSetting('directPlayEnabled', isEnabled);
        showNotification(`Direct Play ${isEnabled ? 'enabled' : 'disabled'}.`, false, 2000);
    });

    // Use event delegation for recent links table
    UIElements.recentLinksTbody.addEventListener('click', (e) => {
        const replayLink = e.target.closest('.replay-link');
        const deleteBtn = e.target.closest('.delete-recent-link-btn');

        if (replayLink) {
            e.preventDefault();
            const url = replayLink.dataset.url;
            UIElements.directStreamUrl.value = url;
            playDirectStream(url);
        } else if (deleteBtn) {
            const urlToDelete = deleteBtn.dataset.url;
            let links = getRecentLinks();
            links = links.filter(link => link !== urlToDelete);
            saveRecentLinks(links);
            renderRecentLinks();
            showNotification('Link removed from recents.');
        }
    });

    // Unload handlers to cleanly stop redirect stream when closing tab/browser
    const handleUnload = (e) => {
        if (e && e.persisted) {
            return;
        }
        const hasActiveStream = !!(appState.player || currentStreamUrl || currentRedirectHistoryId);
        if (hasActiveStream && document.visibilityState === 'hidden') {
            return;
        }
        if (UIElements.directVideoElement && (!UIElements.directVideoElement.paused || document.pictureInPictureElement)) {
            return;
        }
        if (currentRedirectHistoryId) {
            stopRedirectStream(currentRedirectHistoryId, true);
        }
    };
    window.addEventListener('pagehide', handleUnload);
    window.addEventListener('beforeunload', handleUnload);
}
