/**
 * cast.js
 * Manages all Google Cast related functionality.
 */

import { showNotification } from './ui.js';
import { UIElements, guideState, appState } from './state.js';
import { stopStream } from './api.js';

const APPLICATION_ID = 'CC1AD845'; // Default Media Receiver App ID

export const castState = {
    isAvailable: false,
    isCasting: false,
    session: null,
    player: null,
    playerController: null,
    currentMedia: null,
    currentCastStreamUrl: null, // Track the current Cast stream URL for cleanup
    localPlayerState: {
        streamUrl: null,
        name: null,
        logo: null
    }
};

/**
 * Stops a Cast stream on the server by sending a stop request.
 * @param {string} streamUrl - The stream URL to stop.
 */
async function stopCastStream(streamUrl) {
    try {
        console.log(`[CAST] Sending stop request for Cast stream: ${streamUrl}`);
        const activeCastProfileId = guideState.settings?.activeCastProfileId || 'cast-default';
        const response = await fetch('/api/stream/stop', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ url: streamUrl, profileId: activeCastProfileId })
        });

        if (response.ok) {
            console.log('[CAST] Cast stream stopped successfully on server.');
        } else {
            console.warn('[CAST] Failed to stop Cast stream on server:', response.status);
        }
    } catch (error) {
        console.error('[CAST] Error stopping Cast stream:', error);
    }
}

/**
 * Stores the details of the currently playing local media.
 * This is called from player.js whenever a channel starts playing locally.
 * @param {string} streamUrl - The URL of the stream.
 * @param {string} name - The name of the channel.
 * @param {string} logo - The URL for the channel's logo.
 * @param {string} originalUrl - The original stream URL (for stopping server stream).
 * @param {string} profileId - The profile ID (for stopping server stream).
 */
export function setLocalPlayerState(streamUrl, name, logo, originalUrl = null, profileId = null) {
    castState.localPlayerState.streamUrl = streamUrl;
    castState.localPlayerState.name = name;
    castState.localPlayerState.logo = logo;
    castState.localPlayerState.originalUrl = originalUrl;
    castState.localPlayerState.profileId = profileId;
    console.log(`[CAST] Local player state updated: ${name}`);
}

/**
 * Initializes the Google Cast API and sets up listeners.
 * THIS IS NO LONGER CALLED DIRECTLY. It's wrapped in the __onGCastApiAvailable callback.
 */
function initializeCastApi() {
    console.log('[CAST] Cast SDK is available. Initializing context...');
    const castContext = cast.framework.CastContext.getInstance();
    castContext.setOptions({
        receiverApplicationId: APPLICATION_ID,
        autoJoinPolicy: chrome.cast.AutoJoinPolicy.TAB_AND_ORIGIN_SCOPED
    });

    castContext.addEventListener(
        cast.framework.CastContextEventType.SESSION_STATE_CHANGED,
        handleSessionStateChange
    );

    castState.player = new cast.framework.RemotePlayer();
    castState.playerController = new cast.framework.RemotePlayerController(castState.player);
    castState.playerController.addEventListener(
        cast.framework.RemotePlayerEventType.IS_CONNECTED_CHANGED,
        handleRemotePlayerConnectionChange
    );
}

// --- FINAL FIX ---
// This is the official callback provided by the Google Cast SDK.
// It will be executed automatically by the SDK script once it has fully loaded and is ready.
// We wrap our entire initialization logic in here to prevent timing issues.
window['__onGCastApiAvailable'] = (isAvailable) => {
    if (isAvailable) {
        castState.isAvailable = true;
        initializeCastApi();
    } else {
        console.warn('[CAST] Cast SDK is not available on this device.');
        castState.isAvailable = false;
        // Optionally hide the cast button if the SDK is not available at all
        if (UIElements.castBtn) {
            UIElements.castBtn.style.display = 'none';
        }
    }
};


/**
 * Handles changes in the Cast session state.
 * @param {chrome.cast.SessionStateEventData} event - The session state event.
 */
function handleSessionStateChange(event) {
    console.log(`[CAST] Session state changed: ${event.sessionState}`);
    const castContext = cast.framework.CastContext.getInstance();
    castState.session = castContext.getCurrentSession(); // Update session reference

    switch (event.sessionState) {
        case cast.framework.SessionState.SESSION_STARTED:
        case cast.framework.SessionState.SESSION_RESUMED:
            castState.isCasting = true;
            showNotification(`Casting to ${castState.session.getCastDevice().friendlyName}`, false, 4000);

            // Auto-cast if local player is active and not already casting
            if (castState.localPlayerState.streamUrl && !castState.currentMedia) {
                console.log('[CAST] Automatically casting local content after session start.');

                // CRITICAL FIX: Stop the server-side stream FIRST
                const { originalUrl, profileId } = castState.localPlayerState;
                if (originalUrl && profileId) {
                    console.log(`[CAST] Stopping server stream: ${originalUrl} with profile ${profileId}`);
                    stopStream(originalUrl, profileId).catch(err => {
                        console.error('[CAST] Error stopping server stream:', err);
                    });
                }

                // CRITICAL FIX: Stop the local player before casting
                if (appState.player) {
                    console.log('[CAST] Stopping local player before casting.');
                    appState.player.destroy();
                    appState.player = null;
                    // Clear the video element
                    if (UIElements.videoElement) {
                        UIElements.videoElement.src = "";
                        UIElements.videoElement.removeAttribute('src');
                        UIElements.videoElement.load();
                    }
                }

                const { streamUrl, name, logo } = castState.localPlayerState;
                // CRITICAL FIX: Convert relative URLs to absolute for Chromecast
                const absoluteUrl = streamUrl.startsWith('http')
                    ? streamUrl
                    : `${window.location.origin}${streamUrl}`;
                loadMedia(absoluteUrl, name, logo);
            }
            break;
        case cast.framework.SessionState.SESSION_ENDED:
            console.log('[CAST] Session ended, stopping Cast stream on server.');
            // Stop the Cast stream on the server
            if (castState.currentCastStreamUrl) {
                stopCastStream(castState.currentCastStreamUrl);
                castState.currentCastStreamUrl = null;
            }
            castState.session = null;
            castState.isCasting = false;
            castState.currentMedia = null;
            showNotification('Casting session ended.', false, 4000);
            updatePlayerUI();
            break;
        case cast.framework.SessionState.NO_SESSION:
            castState.session = null;
            castState.isCasting = false;
            castState.currentMedia = null;
            updatePlayerUI();
            break;
    }
}

/**
 * Handles changes in the remote player's connection status and updates the UI.
 */
function handleRemotePlayerConnectionChange() {
    updatePlayerUI();
}

/**
 * Updates the local player modal UI based on the casting state.
 */
function updatePlayerUI() {
    const videoElement = UIElements.videoElement;
    const castStatusDiv = UIElements.castStatus;
    const castBtn = UIElements.castBtn;

    if (castState.isCasting && castState.player.isConnected) {
        videoElement.classList.add('hidden');
        castStatusDiv.classList.remove('hidden');
        castStatusDiv.classList.add('flex');

        UIElements.castStatusText.textContent = `Casting to ${castState.session.getCastDevice().friendlyName}`;
        UIElements.castStatusChannel.textContent = castState.player.mediaInfo ? castState.player.mediaInfo.metadata.title : 'No media loaded.';

        // Add class to our custom button to indicate connected state
        if (castBtn) castBtn.classList.add('cast-connected');

    } else {
        videoElement.classList.remove('hidden');
        castStatusDiv.classList.add('hidden');
        castStatusDiv.classList.remove('flex');

        // Remove connected state class
        if (castBtn) castBtn.classList.remove('cast-connected');
    }
}


/**
 * Loads a media stream onto the connected Cast device.
 * @param {string} url - The URL of the stream.
 * @param {string} name - The name of the channel.
 * @param {string} logo - The URL of the channel's logo.
 */
export async function loadMedia(url, name, logo) {
    if (!castState.session) {
        showNotification('Not connected to a Cast device.', true);
        return;
    }

    console.log(`[CAST] Loading media: "${name}" from URL: ${url}`);

    // ONLY modify URL to use cast profile if NOT already using it
    // This ensures we switch to the active cast profile for Chromecast
    const activeCastProfileId = guideState.settings?.activeCastProfileId || 'cast-default';
    let castUrl = url;
    if (!url.includes(`profileId=${activeCastProfileId}`)) {
        if (url.includes('profileId=')) {
            // Replace existing profileId with active cast profile
            castUrl = url.replace(/profileId=[^&]+/, `profileId=${activeCastProfileId}`);
            console.log(`[CAST] Replaced profile with ${activeCastProfileId}`);
        } else {
            // Add cast profile
            const separator = url.includes('?') ? '&' : '?';
            castUrl = `${url}${separator}profileId=${activeCastProfileId}`;
            console.log(`[CAST] Added ${activeCastProfileId} profile`);
        }
    }

    // Generate and append cast authentication token
    try {
        console.log('[CAST] Requesting authentication token...');
        const response = await fetch('/api/cast/generate-token', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ streamUrl: url })
        });

        if (!response.ok) {
            throw new Error(`Token generation failed: ${response.status}`);
        }

        const { token } = await response.json();
        const separator = castUrl.includes('?') ? '&' : '?';
        castUrl = `${castUrl}${separator}castToken=${token}`;

        console.log('[CAST] Authentication token added to URL');
    } catch (error) {
        console.error('[CAST] Failed to generate cast token:', error);
        showNotification('Failed to generate cast authentication token', true);
        return;
    }

    console.log(`[CAST] Cast URL ready for Chromecast`);

    // Use video/mp4 instead of video/mp2t for Chromecast compatibility
    const mediaInfo = new chrome.cast.media.MediaInfo(castUrl, 'video/mp4');
    mediaInfo.streamType = chrome.cast.media.StreamType.LIVE;
    mediaInfo.metadata = new chrome.cast.media.TvShowMediaMetadata();
    mediaInfo.metadata.title = name;
    if (logo) {
        mediaInfo.metadata.images = [new chrome.cast.Image(logo)];
    }

    const request = new chrome.cast.media.LoadRequest(mediaInfo);

    castState.session.loadMedia(request).then(
        () => {
            console.log('[CAST] Media loaded successfully.');
            castState.currentMedia = castState.session.getMediaSession();
            castState.currentCastStreamUrl = url; // Track for cleanup
            updatePlayerUI();
        },
        (errorCode) => {
            console.error('[CAST] Error loading media:', errorCode);
            showNotification('Failed to load media on Cast device. Check console.', true);
        }
    );
}

/**
 * Ends the entire Cast session, disconnecting from the device.
 */
export function endCastSession() {
    if (castState.session) {
        castState.session.endSession(true); // true to stop any playing media
    }
}
