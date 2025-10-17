/**
 * player.js
 * * Manages the video player functionality using mpegts.js and Google Cast.
 */

import { appState, guideState, UIElements } from './state.js';
// MODIFIED: Added stopStream to the import
import { saveUserSetting, stopStream, startRedirectStream, stopRedirectStream } from './api.js';
import { showNotification, openModal, closeModal } from './ui.js';
import { castState, loadMedia, setLocalPlayerState } from './cast.js';

let streamInfoInterval = null; // Interval to update stream stats
let currentLocalStreamUrl = null; // ADDED: Track the original URL of the currently playing local stream
let currentRedirectHistoryId = null; // To track redirect streams for logging

// --- NEW: Auto-retry logic state ---
let currentChannelInfo = null; // Stores { url, name, channelId } for retries
let retryCount = 0;
const MAX_RETRIES = 3;
let retryTimeout = null;

/**
 * Handles a catastrophic stream error by attempting to restart the stream.
 */
function handleStreamError() {
    if (retryCount >= MAX_RETRIES) {
        showNotification(`Stream failed after ${MAX_RETRIES} retries. Please try another channel.`, true, 5000);
        stopAndCleanupPlayer();
        return;
    }

    retryCount++;
    showNotification(`Stream interrupted. Retrying... (${retryCount}/${MAX_RETRIES})`, true, 2000);

    // Clear any previous timeout
    if (retryTimeout) {
        clearTimeout(retryTimeout);
    }

    // Attempt to restart after a short delay
    retryTimeout = setTimeout(() => {
        console.log(`[PLAYER_RETRY] Attempting to restart stream. Attempt ${retryCount}/${MAX_RETRIES}.`);
        if (currentChannelInfo) {
            // Re-call playChannel which handles the full setup
            playChannel(currentChannelInfo.url, currentChannelInfo.name, currentChannelInfo.channelId);
        } else {
            console.error("[PLAYER_RETRY] Cannot retry: current channel info is missing.");
            stopAndCleanupPlayer();
        }
    }, 2000); // 2-second delay before retrying
}


/**
 * NEW: Forcefully stops and restarts the current stream.
 * This function will be triggered by the new refresh button.
 */
export async function forceRefreshStream() {
    if (!currentChannelInfo) {
        showNotification("No active stream to refresh.", true);
        return;
    }

    showNotification("Refreshing stream...", false, 2000);
    console.log('[PLAYER] User forced stream refresh.');

    // Clear any pending retry to prevent it from interfering
    if (retryTimeout) {
        clearTimeout(retryTimeout);
        retryTimeout = null;
    }
    retryCount = 0; // Reset retry count on manual refresh

    // Stop the current player instance without closing the modal
    if (appState.player) {
        await stopStream(currentLocalStreamUrl);
        appState.player.destroy();
        appState.player = null;
    }

    // Immediately try to play the channel again
    playChannel(currentChannelInfo.url, currentChannelInfo.name, currentChannelInfo.channelId);
}


/**
 * Stops the current local stream, cleans up the mpegts.js player instance, and closes the modal.
 * This does NOT affect an active Google Cast session.
 */
export const stopAndCleanupPlayer = async () => { // MODIFIED: Made function async
    // If we were logging a redirect stream, tell the server it has stopped.
    if (currentRedirectHistoryId) {
        stopRedirectStream(currentRedirectHistoryId);
        currentRedirectHistoryId = null;
    }
    
    // NEW: Clear any scheduled retry attempt
    if (retryTimeout) {
        clearTimeout(retryTimeout);
        retryTimeout = null;
    }
    retryCount = 0;
    currentChannelInfo = null;


    // Explicitly tell the server to stop the stream process.
    if (currentLocalStreamUrl && !castState.isCasting) {
        console.log(`[PLAYER] Sending stop request to server for URL: ${currentLocalStreamUrl}`);
        await stopStream(currentLocalStreamUrl);
        currentLocalStreamUrl = null; // Clear the tracked URL after stopping
    }

    // Clear the stream info update interval
    if (streamInfoInterval) {
        clearInterval(streamInfoInterval);
        streamInfoInterval = null;
    }
    
    if (UIElements.streamInfoOverlay) {
        UIElements.streamInfoOverlay.classList.add('hidden');
    }

    if (castState.isCasting) {
        console.log('[PLAYER] Closing modal but leaving cast session active.');
        closeModal(UIElements.videoModal);
        return;
    }

    if (appState.player) {
        console.log('[PLAYER] Destroying local mpegts player.');
        appState.player.destroy();
        appState.player = null;
    }
    UIElements.videoElement.src = "";
    UIElements.videoElement.removeAttribute('src');
    UIElements.videoElement.load();

    setLocalPlayerState(null, null, null);

    if (document.pictureInPictureElement) {
        document.exitPictureInPicture().catch(console.error);
    }
    closeModal(UIElements.videoModal);
};

/**
 * Updates the stream info overlay with the latest stats from mpegts.js.
 */
function updateStreamInfo() {
    if (!appState.player || !appState.player.statisticsInfo) return;

    const stats = appState.player.statisticsInfo;
    const video = UIElements.videoElement;

    const resolution = (video.videoWidth && video.videoHeight) ? `${video.videoWidth}x${video.videoHeight}` : 'N/A';
    const speed = `${(stats.speed / 1024).toFixed(2)} KB/s`;
    const fps = (stats.decodedFrames > 0 && typeof stats.fps === 'number') ? stats.fps.toFixed(2) : '0.00';
    const buffer = video.buffered.length > 0 ? `${(video.buffered.end(0) - video.currentTime).toFixed(2)}s` : '0.00s';

    UIElements.streamInfoResolution.textContent = `Resolution: ${resolution}`;
    UIElements.streamInfoBandwidth.textContent = `Bandwidth: ${speed}`;
    UIElements.streamInfoFps.textContent = `FPS: ${fps}`;
    UIElements.streamInfoBuffer.textContent = `Buffer: ${buffer}`;
}


/**
 * Initializes and starts playing a channel stream, either locally or on a Cast device.
 * @param {string} url - The URL of the channel stream.
 * @param {string} name - The name of the channel to display.
 * @param {string} channelId - The unique ID of the channel.
 */
export const playChannel = (url, name, channelId) => {
    // On a fresh play request (not a retry), reset the retry counter
    if (!retryTimeout) {
        retryCount = 0;
    }
    
    // Store current channel info for potential retries
    currentChannelInfo = { url, name, channelId };

    // Update and save recent channels regardless of playback target
    if (channelId) {
        const recentChannels = [channelId, ...(guideState.settings.recentChannels || []).filter(id => id !== channelId)].slice(0, 15);
        guideState.settings.recentChannels = recentChannels;
        saveUserSetting('recentChannels', recentChannels);
    }

    const profileId = guideState.settings.activeStreamProfileId;
    const userAgentId = guideState.settings.activeUserAgentId;
    if (!profileId || !userAgentId) {
        showNotification("Active stream profile or user agent not set. Please check settings.", true);
        return;
    }
    // --- Activity Logging for Redirect Streams ---
    // First, ensure any previous redirect logging session is stopped.
    if (currentRedirectHistoryId) {
        stopRedirectStream(currentRedirectHistoryId);
        currentRedirectHistoryId = null;
    }
    const profile = (guideState.settings.streamProfiles || []).find(p => p.id === profileId);
    // If the selected profile is redirect, start a new logging session.
    if (profile.command === 'redirect') {
        const channel = guideState.channels.find(c => c.id === channelId);
        startRedirectStream(url, channelId, name, channel ? channel.logo : '')
            .then(historyId => {
                if (historyId) {
                    currentRedirectHistoryId = historyId;
                }
            });
    }
    // --- End Activity Logging ---

    
    if (!profile) {
        return showNotification("Stream profile not found.", true);
    }
    
    const streamUrlToPlay = profile.command === 'redirect' ? url : `/stream?url=${encodeURIComponent(url)}&profileId=${profileId}&userAgentId=${userAgentId}`;
    const channel = guideState.channels.find(c => c.id === channelId);
    const logo = channel ? channel.logo : '';

    if (castState.isCasting) {
        console.log(`[PLAYER] Already casting. Loading new channel "${name}" to remote device.`);
        loadMedia(streamUrlToPlay, name, logo);
        openModal(UIElements.videoModal);
        return;
    }

    // --- Local Playback Logic ---
    currentLocalStreamUrl = url; 
    console.log(`[PLAYER] Playing channel "${name}" locally. Tracking URL for cleanup: ${currentLocalStreamUrl}`);
    
    setLocalPlayerState(streamUrlToPlay, name, logo);
    
    if (appState.player) {
        appState.player.destroy();
        appState.player = null;
    }
    if (streamInfoInterval) {
        clearInterval(streamInfoInterval);
        streamInfoInterval = null;
    }

    if (mpegts.isSupported()) {
        const mpegtsConfig = {
            enableStashBuffer: true,
            stashInitialSize: 4096,
            liveBufferLatency: 2.0,
        };

        appState.player = mpegts.createPlayer({
            type: 'mse',
            isLive: true,
            url: streamUrlToPlay
        }, mpegtsConfig);

        // --- NEW: Robust Error Handling ---
        appState.player.on(mpegts.Events.ERROR, (errorType, errorDetail) => {
            console.error(`[PLAYER] MPEGTS Player Error: Type=${errorType}, Detail=${errorDetail}`);
            // We only want to auto-retry on unrecoverable network/media errors.
            if (errorType === 'NetworkError' || errorType === 'MediaError') {
                // To prevent a retry loop if the user has manually closed the player
                if (appState.player) { 
                    handleStreamError();
                }
            } else {
                 showNotification(`Player Error: ${errorDetail}`, true);
                 stopAndCleanupPlayer();
            }
        });
        
        // When playback starts successfully, reset the retry counter.
        appState.player.on(mpegts.Events.MEDIA_INFO, () => {
            console.log('[PLAYER] Media info received, playback started successfully.');
            retryCount = 0;
            if (retryTimeout) {
                clearTimeout(retryTimeout);
                retryTimeout = null;
            }
        });
        
        openModal(UIElements.videoModal);
        UIElements.videoTitle.textContent = name;
        appState.player.attachMediaElement(UIElements.videoElement);
        appState.player.load();
        
        UIElements.videoElement.volume = parseFloat(localStorage.getItem('iptvPlayerVolume') || 0.5);
        
        appState.player.play().catch((err) => {
            console.error("MPEGTS Player play() caught an error:", err);
            // This initial play error is often critical, so we start the retry process.
            handleStreamError();
        });

        streamInfoInterval = setInterval(updateStreamInfo, 2000);

    } else {
        showNotification('Your browser does not support Media Source Extensions (MSE).', true);
    }
};


/**
 * UPDATED: Plays a VOD (Movie or Episode) in the main player modal.
 * Uses native playback for supported formats (e.g., mp4) and mpegts.js
 * with server-side transcoding for unsupported formats (e.g., mkv).
 * @param {string} url - The direct URL to the VOD file.
 * @param {string} title - The title of the VOD to display.
 */
export const playVOD = async (url, title) => {
    console.log(`[VOD_PLAYER] Attempting to play VOD: "${title}" URL: ${url}`);

    // Ensure any previous mpegts player is stopped and cleaned up
    if (appState.player) {
        console.log('[VOD_PLAYER] Destroying active mpegts player before playing VOD.');
        if (currentLocalStreamUrl) {
            // Stop potential server stream if mpegts player was active
            await stopStream(currentLocalStreamUrl);
            currentLocalStreamUrl = null;
        }
        appState.player.destroy();
        appState.player = null;
        if (streamInfoInterval) clearInterval(streamInfoInterval); streamInfoInterval = null;
        if (UIElements.streamInfoOverlay) UIElements.streamInfoOverlay.classList.add('hidden');
    } else {
        // If no mpegts player was active, ensure the native video element is reset
        UIElements.videoElement.pause();
        UIElements.videoElement.removeAttribute('src'); // Use removeAttribute for cleaner reset
        UIElements.videoElement.load();
    }

    // Set up the player modal title
    UIElements.videoTitle.textContent = title;
    openModal(UIElements.videoModal);

    // Determine playback method based on file extension
    const lowerUrl = url.toLowerCase();
    const useNativePlayer = lowerUrl.endsWith('.mp4') || lowerUrl.endsWith('.webm') || lowerUrl.endsWith('.ogg');

    try {
        UIElements.videoElement.volume = parseFloat(localStorage.getItem('iptvPlayerVolume') || 0.5);

        if (useNativePlayer) {
            console.log(`[VOD_PLAYER] Using NATIVE playback for: "${title}"`);
            UIElements.videoElement.src = url;
            UIElements.videoElement.load();
            await UIElements.videoElement.play();

        } else {
            console.log(`[VOD_PLAYER] Using MPEGTS.js (transcoding) for: "${title}"`);
            // Use mpegts.js via the /stream endpoint
            const settings = guideState.settings;
            const profileId = settings.activeStreamProfileId;
            const userAgentId = settings.activeUserAgentId;
            const profile = (settings.streamProfiles || []).find(p => p.id === profileId);

            if (!profileId || !userAgentId || !profile || profile.command === 'redirect') {
                // Cannot use redirect profile for transcoding
                const errorMsg = "A valid transcoding stream profile and user agent must be selected in Settings to play this file type.";
                console.error(`[VOD_PLAYER] Error: ${errorMsg}`);
                showNotification(errorMsg, true);
                closeModal(UIElements.videoModal); // Close modal on config error
                return;
            }

            const streamUrlToPlay = `/stream?url=${encodeURIComponent(url)}&profileId=${profileId}&userAgentId=${userAgentId}`;
            currentLocalStreamUrl = url; // Track original URL for potential stop later

            if (!mpegts.isSupported()) {
                throw new Error('MPEGTS.js is not supported by your browser.');
            }

            // Configure mpegts.js for VOD playback (seeking enabled)
            const mpegtsConfig = {
                isLive: false,
                autoCleanupSourceBuffer: true,
                lazyLoad: false,
                seekType: 'range',
                stashInitialSize: 128 * 1024 * 1024, // 128MB buffer
            };

            appState.player = mpegts.createPlayer({
                type: 'mse',
                isLive: false,
                url: streamUrlToPlay
            }, mpegtsConfig);

            // Add error handling for mpegts player
            appState.player.on(mpegts.Events.ERROR, (errorType, errorDetail) => {
                console.error(`[VOD_PLAYER] MPEGTS Player Error: Type=${errorType}, Detail=${errorDetail}`);
                showNotification(`Player Error: ${errorDetail}`, true);
                // Use the main stop function which handles server stop and player destroy
                stopAndCleanupPlayer();
            });

            appState.player.attachMediaElement(UIElements.videoElement);
            appState.player.load();
            await appState.player.play();

            // Start stream info polling if needed (optional for VOD)
            // streamInfoInterval = setInterval(updateStreamInfo, 2000);
        }

        console.log(`[VOD_PLAYER] Playback started for: "${title}"`);
        // Ensure live stream tracking state is cleared when playing VOD
        setLocalPlayerState(null, null, null);
        // currentLocalStreamUrl is set above only if using mpegts

    } catch (err) {
        console.error("[VOD_PLAYER] Error trying to play VOD:", err);
        showNotification(`Could not play the selected video: ${err.message}`, true);
        // Clean up on failure
        if (appState.player) {
            appState.player.destroy();
            appState.player = null;
        }
        UIElements.videoElement.removeAttribute('src');
        UIElements.videoElement.load();
        closeModal(UIElements.videoModal); // Close modal on failure
    }
};

/**
 * Sets up event listeners for the video player.
 */
export function setupPlayerEventListeners() {
    UIElements.closeModal.addEventListener('click', stopAndCleanupPlayer);

    // NEW: Add event listener for the refresh button
    const refreshBtn = document.getElementById('refresh-stream-btn');
    if (refreshBtn) {
        refreshBtn.addEventListener('click', forceRefreshStream);
    }


    UIElements.pipBtn.addEventListener('click', () => {
        if (document.pictureInPictureEnabled && UIElements.videoElement.readyState >= 3) {
            UIElements.videoElement.requestPictureInPicture().catch(() => showNotification("Could not enter Picture-in-Picture.", true));
        }
    });

    UIElements.streamInfoToggleBtn.addEventListener('click', () => {
        UIElements.streamInfoOverlay.classList.toggle('hidden');
    });

    if (UIElements.castBtn) {
        UIElements.castBtn.addEventListener('click', () => {
            console.log('[PLAYER] Custom cast button clicked. Requesting session...');
            try {
                const castContext = cast.framework.CastContext.getInstance();
                castContext.requestSession().catch((error) => {
                    console.error('Error requesting cast session:', error);
                    if (error !== "cancel") { 
                        showNotification('Could not initiate Cast session. See console for details.', true);
                    }
                });
            } catch (e) {
                console.error('Fatal Error: Cast framework is not available.', e);
                showNotification('Cast functionality is not available. Please try reloading.', true);
            }
        });
    } else {
        console.error('[PLAYER] CRITICAL: Cast button #cast-btn NOT FOUND.');
    }

    UIElements.videoElement.addEventListener('enterpictureinpicture', () => closeModal(UIElements.videoModal));
    UIElements.videoElement.addEventListener('leavepictureinpicture', () => {
        if (appState.player && !UIElements.videoElement.paused) {
            openModal(UIElements.videoModal);
        } else {
            stopAndCleanupPlayer();
        }
    });
    
    UIElements.videoElement.addEventListener('volumechange', () => {
        localStorage.setItem('iptvPlayerVolume', UIElements.videoElement.volume);
    });
}
