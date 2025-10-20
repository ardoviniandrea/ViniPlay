/**
 * player_direct.js
 * * Manages the functionality for the direct stream player page.
 * This has been updated to include recent links, a stop button, direct play vs. proxy,
 * and a logging console for better error feedback.
 */

import { UIElements, guideState, appState } from './state.js';
import { showNotification } from './ui.js';
// MODIFIED: Import stopStream to explicitly kill the server process.
import { saveUserSetting, stopStream, startRedirectStream, stopRedirectStream } from './api.js';

const MAX_RECENT_LINKS = 10;
let currentStreamUrl = null; // NEW: Track the URL of the current stream
let statisticsInterval = null; // NEW: Interval for logging stream statistics.
let currentRedirectHistoryId = null; // To track redirect streams for logging

// --- Helper Functions ---

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
            console.log('[DEBUG] stopAndCleanupDirectPlayer: Pausing player.');
            appState.player.pause();
            console.log('[DEBUG] stopAndCleanupDirectPlayer: Unloading player.');
            appState.player.unload();
            console.log('[DEBUG] stopAndCleanupDirectPlayer: Detaching media element.');
            appState.player.detachMediaElement();
            console.log('[DEBUG] stopAndCleanupDirectPlayer: Destroying player.');
            appState.player.destroy();
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
 * Initializes mpegts.js and plays the provided stream URL.
 * @param {string} url The URL of the .ts or .m3u8 stream.
 */
function playDirectStream(url) {
    console.log(`[DEBUG] playDirectStream: Called with URL: ${url}`);
    
    // First, stop any existing stream
    stopAndCleanupDirectPlayer();

    const consoleEl = UIElements.directPlayerConsole;
    if (consoleEl) {
        consoleEl.innerHTML = ''; // Clear previous logs
    }
    UIElements.directPlayerConsoleContainer.classList.remove('hidden');
    logToPlayerConsole(`Attempting to play: ${url}`);

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
        // --- Activity Logging for Redirect Streams ---
        if (currentRedirectHistoryId) {
            stopRedirectStream(currentRedirectHistoryId);
            currentRedirectHistoryId = null;
        }
        const allChannels = guideState.channels || [];
        const channel = allChannels.find(c => c.url === url);
        const channelId = channel ? channel.id : null;
        const channelName = channel ? (channel.displayName || channel.name) : 'Direct Stream';
        const channelLogo = channel ? channel.logo : null;

        startRedirectStream(url, channelId, channelName, channelLogo)
            .then(historyId => {
                if (historyId) {
                    currentRedirectHistoryId = historyId;
                }
            });
        // --- End Activity Logging ---
    }
    
    // Set the current stream URL for tracking and stopping purposes.
    currentStreamUrl = url;

    addRecentLink(url);
    renderRecentLinks();

    if (mpegts.isSupported()) {
        try {
            console.log(`[DEBUG] playDirectStream: Creating new mpegts.js player for URL: ${streamUrlToPlay}`);

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
            console.log('[DEBUG] playDirectStream: New player instance created and assigned to appState.player.');

            UIElements.directPlayerContainer.classList.remove('hidden');
            UIElements.directStopBtn.classList.remove('hidden');
            UIElements.directPlayBtn.classList.add('hidden');
            
            console.log('[DEBUG] playDirectStream: Attaching media element.');
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

            console.log('[DEBUG] playDirectStream: Calling player.load().');
            appState.player.load();
            
            console.log('[DEBUG] playDirectStream: Calling player.play().');
            appState.player.play().catch((err) => {
                if (err.name === 'AbortError') {
                    console.warn('[DEBUG] playDirectStream: Playback was aborted. This is expected if the user clicks stop or navigates away very quickly.');
                    return;
                }
                const errorMsg = `Could not play the stream. Please check the URL and console log for details.`;
                console.error("[DEBUG] playDirectStream: player.play() caught an error:", err);
                logToPlayerConsole(errorMsg, true);
                showNotification(errorMsg, true);
                stopAndCleanupDirectPlayer();
            });
            logToPlayerConsole('Player instance created and attempting to load stream.');

        } catch (e) {
            const errorMsg = 'Failed to create player instance. Check stream URL.';
            console.error('[DEBUG] playDirectStream: Critical error during player creation:', e);
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
}
