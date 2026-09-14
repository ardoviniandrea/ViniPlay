/**
 * api.js
 * * Manages all communication with the backend API.
 * Provides a centralized place for fetch requests and error handling.
 */

import { showLoginScreen } from './auth.js';
import { showNotification } from './ui.js';
import { guideState } from './state.js';

/**
 * A wrapper for the fetch API to handle common tasks like error handling and auth failures.
 * @param {string} url - The API endpoint URL.
 * @param {object} options - Options for the fetch request (method, headers, body, etc.).
 * @returns {Promise<Response|null>} - The fetch Response object or null on failure.
 */
export async function apiFetch(url, options = {}) {
    console.log(`[API_FETCH] Requesting: ${options.method || 'GET'} ${url}`);
    try {
        const response = await fetch(url, options);
        console.log(`[API_FETCH] Response received for ${url}: Status ${response.status} ${response.statusText}`);

        // If the session expired, the server will return a 401 Unauthorized
        if (response.status === 401) {
            console.warn('[API_FETCH] 401 Unauthorized. Session expired or invalid.');
            showLoginScreen("Your session has expired. Please log in again.");
            return null; // Prevent further processing of this response
        }

        // Handle other non-ok responses
        if (!response.ok) {
            let errorData = {};
            try {
                errorData = await response.json(); // Try to parse error message if available
            } catch (e) {
                console.warn(`[API_FETCH] Could not parse error response as JSON for ${url}:`, e);
                errorData.error = response.statusText || 'An unknown error occurred.';
            }
            console.error(`[API_FETCH] API call failed for ${url}: Status ${response.status}, Error: ${errorData.error || 'No specific error message.'}`);
            showNotification(errorData.error || `API Error: ${response.status} ${response.statusText}`, true);
            return null;
        }

        console.log(`[API_FETCH] API call to ${url} successful.`);
        return response;
    } catch (error) {
        console.error(`[API_FETCH] Network or unexpected error during fetch for ${url}:`, error);
        showNotification("Could not connect to the server. Please check your network or server status.", true);
        return null;
    }
}

/**
 * Fetches the entire application configuration including M3U content, EPG data, and settings.
 * @returns {Promise<object|null>} The configuration object (m3uContent, epgContent, settings) or null on failure.
 */
export async function fetchConfig() {
    console.log('[API] Fetching application configuration from /api/config.');
    const response = await apiFetch(`/api/config?t=${Date.now()}`); // Add timestamp to prevent caching
    if (!response) {
        console.error('[API] Failed to fetch config: No response from apiFetch.');
        return null;
    }

    // DEBUG: Log headers to check for cache status
    console.log('[DEBUG_CLIENT] /api/config Response Headers:');
    response.headers.forEach((val, key) => console.log(`  ${key}: ${val}`));

    try {
        const config = await response.json();
        console.log('[API] Application configuration fetched successfully.');
        return config;
    } catch (e) {
        console.error('[API] Error parsing config JSON:', e);
        showNotification('Failed to parse server configuration.', true);
        return null;
    }
}

/**
 * Fetches the application version from the server.
 * @returns {Promise<string>} The version string (e.g., "1.0.0") or "Unknown" on failure.
 */
export async function fetchAppVersion() {
    console.log('[API] Fetching app version from /api/version.');
    const response = await apiFetch('/api/version');
    if (!response) return 'Unknown';

    try {
        const data = await response.json();
        return data.version || 'Unknown';
    } catch (e) {
        console.error('[API] Error parsing version JSON:', e);
        return 'Unknown';
    }
}

/**
 * Saves a user-specific setting to the backend.
 * @param {string} key - The setting key.
 * @param {*} value - The setting value.
 * @returns {Promise<object|null>} - The complete, updated settings object from the server, or null on failure.
 */
export async function saveUserSetting(key, value) {
    console.log(`[API] Saving user setting: ${key} =`, value);
    const res = await apiFetch('/api/user/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key, value })
    });

    if (!res || !res.ok) {
        console.error(`[API] Failed to save user setting: ${key}`);
        return null; // apiFetch already showed notification
    }

    try {
        const data = await res.json();
        if (data.success && data.settings) {
            console.log(`[API] User setting "${key}" saved. Returning updated settings object.`);
            return data.settings; // Return the full settings object
        } else {
            console.error(`[API] Server responded success but did not return settings for key: ${key}`);
            showNotification(`Setting for "${key}" was saved, but the server response was incomplete.`, true);
            return null;
        }
    } catch (e) {
        console.error('[API] Error parsing response from saveUserSetting:', e);
        showNotification('Could not parse server response after saving setting.', true);
        return null;
    }
}

let deviceSettingsSyncDebounce = null;

/**
 * Retrieves or creates a persistent unique identifier for the current browser/device.
 * @returns {string} The persistent device identifier.
 */
export function getDeviceId() {
    let deviceId = localStorage.getItem('viniplay_device_id');
    if (!deviceId) {
        const rand = (Math.random().toString(36).substring(2, 10) + Date.now().toString(36)).substring(0, 16);
        deviceId = `dev_${rand}`;
        try {
            localStorage.setItem('viniplay_device_id', deviceId);
        } catch (e) {
            console.warn('[API] Could not save deviceId to localStorage:', e);
        }
    }
    return deviceId;
}

/**
 * Retrieves a device-specific setting.
 * Checks localStorage first for instant 0ms access, then falls back to server-synced
 * guideState.settings.deviceSettings[deviceId], then the provided fallback.
 * @param {string} key - Setting key
 * @param {*} fallback - Default value if not set
 * @returns {*}
 */
export function getDeviceSetting(key, fallback = null) {
    const deviceId = getDeviceId();
    const localKey = `viniplay_device_${deviceId}_${key}`;
    try {
        const localVal = localStorage.getItem(localKey);
        if (localVal !== null) {
            return JSON.parse(localVal);
        }
    } catch (e) {
        const raw = localStorage.getItem(localKey);
        if (raw !== null) return raw;
    }

    // Check server-synced deviceSettings from guideState if available
    if (guideState?.settings?.deviceSettings) {
        const devSettings = guideState.settings.deviceSettings[deviceId];
        if (devSettings && devSettings[key] !== undefined) {
            try {
                localStorage.setItem(localKey, JSON.stringify(devSettings[key]));
            } catch (e) {}
            return devSettings[key];
        }
    }

    return fallback;
}

/**
 * Saves a device-specific setting both locally (immediate synchronous persistence)
 * and syncs to the backend user settings debounced under guideState.settings.deviceSettings[deviceId].
 * @param {string} key - Setting key
 * @param {*} value - Setting value
 */
export function saveDeviceSetting(key, value) {
    const deviceId = getDeviceId();
    const localKey = `viniplay_device_${deviceId}_${key}`;
    try {
        localStorage.setItem(localKey, JSON.stringify(value));
    } catch (e) {
        console.warn('[API] Could not save device setting to localStorage:', e);
    }

    if (guideState?.settings) {
        if (!guideState.settings.deviceSettings) {
            guideState.settings.deviceSettings = {};
        }
        if (!guideState.settings.deviceSettings[deviceId]) {
            guideState.settings.deviceSettings[deviceId] = {};
        }
        guideState.settings.deviceSettings[deviceId][key] = value;
    }

    clearTimeout(deviceSettingsSyncDebounce);
    deviceSettingsSyncDebounce = setTimeout(() => {
        if (guideState?.settings?.deviceSettings) {
            saveUserSetting('deviceSettings', guideState.settings.deviceSettings);
        }
    }, 600);
}


/**
 * Saves a global (app-wide) setting to the backend.
 * @param {object} settingObject - An object containing the setting(s) to save.
 * @returns {Promise<object|null>} - The updated settings object from the server or null on failure.
 */
export async function saveGlobalSetting(settingObject) {
    console.log('[API] Saving global setting(s):', settingObject);
    const res = await apiFetch('/api/save/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(settingObject)
    });
    if (!res) return null; // apiFetch already handled notification

    const data = await res.json();
    if (res.ok && data.settings) {
        console.log('[API] Global settings saved successfully. New settings:', data.settings);
        return data.settings;
    } else {
        console.error('[API] Failed to save global setting:', data.error || 'Unknown server error.');
        // showNotification(data.error || 'A global setting could not be saved.', true); // apiFetch already shows this
        return null;
    }
}

// --- REFACTORED/NEW Notification API functions ---

/**
 * Fetches the VAPID public key from the server.
 * @returns {Promise<string|null>} The VAPID public key or null on failure.
 */
export async function getVapidKey() {
    console.log('[API] Fetching VAPID public key.');
    const res = await apiFetch('/api/notifications/vapid-public-key');
    if (!res || !res.ok) {
        console.error('[API] Failed to get VAPID public key from server.');
        return null;
    }
    const key = await res.text();
    console.log('[API] VAPID public key fetched successfully.');
    return key;
}

/**
 * Sends the push subscription object to the server to be saved.
 * @param {PushSubscription} subscription - The subscription object from the PushManager.
 * @returns {Promise<boolean>} True on success, false on failure.
 */
export async function subscribeToPush(subscription) {
    console.log('[API] Sending push subscription to server.');
    const res = await apiFetch('/api/notifications/subscribe', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(subscription)
    });
    if (res && res.ok) {
        console.log('[API] Push subscription saved on server.');
    } else {
        console.error('[API] Failed to save push subscription on server.');
    }
    return res && res.ok;
}

/**
 * Tells the server to remove a push subscription.
 * @param {PushSubscription} subscription - The subscription object to remove.
 * @returns {Promise<boolean>} True on success, false on failure.
 */
export async function unsubscribeFromPush(subscription) {
    console.log('[API] Sending unsubscribe request to server.');
    const res = await apiFetch('/api/notifications/unsubscribe', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ endpoint: subscription.endpoint })
    });
    if (res && res.ok) {
        console.log('[API] Push subscription removed from server.');
    } else {
        console.error('[API] Failed to remove push subscription from server.');
    }
    return res && res.ok;
}


/**
 * Requests the server to schedule a program notification.
 * @param {object} notificationData - Object containing notification details.
 * @returns {Promise<object|null>} - The added notification object with its ID, or null on failure.
 */
export async function addProgramNotification(notificationData) {
    console.log('[API] Requesting to add program notification:', notificationData.programTitle);
    const res = await apiFetch('/api/notifications', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(notificationData)
    });
    if (!res) return null;

    const data = await res.json();
    if (res.ok && data.success) {
        console.log(`[API] Program notification added successfully. ID: ${data.id}`);
        return { id: data.id, ...notificationData };
    } else {
        console.error('[API] Failed to add notification:', data.error);
        // showNotification(data.error || 'Could not add notification.', true); // apiFetch already shows this
        return null;
    }
}

/**
 * Fetches all scheduled program notifications for the current user from the backend.
 * @returns {Promise<Array<object>>} - An array of notification objects, or empty array on failure.
 */
export async function getProgramNotifications() {
    console.log('[API] Fetching all program notifications.');
    const res = await apiFetch('/api/notifications');
    if (!res) return [];

    const data = await res.json();
    if (res.ok) {
        console.log(`[API] Fetched ${data.length} program notifications.`);
        return data;
    } else {
        console.error('[API] Failed to get notifications:', data.error);
        // showNotification(data.error || 'Could not retrieve notifications.', true); // apiFetch already shows this
        return [];
    }
}

/**
 * Deletes a scheduled program notification from the backend.
 * @param {string|number} notificationId - The ID of the notification to delete.
 * @returns {Promise<boolean>} - True on success, false on failure.
 */
export async function deleteProgramNotification(notificationId) {
    console.log(`[API] Requesting to delete notification ID: ${notificationId}.`);
    const res = await apiFetch(`/api/notifications/${notificationId}`, {
        method: 'DELETE',
    });
    if (!res) return false;

    const data = await res.json();
    if (res.ok && data.success) {
        console.log(`[API] Notification ID ${notificationId} deleted successfully.`);
        // showNotification('Notification removed.'); // This is called in notification.js now
        return true;
    } else {
        console.error(`[API] Failed to delete notification ${notificationId}:`, data.error);
        // showNotification(data.error || 'Could not remove notification.', true); // apiFetch already shows this
        return false;
    }
}

/**
 * Deletes all past (sent or expired) notifications for the user.
 * @returns {Promise<boolean>} - True on success, false on failure.
 */
export async function clearPastNotifications() {
    console.log(`[API] Requesting to delete all past notifications.`);
    const res = await apiFetch(`/api/notifications/past`, {
        method: 'DELETE',
    });
    // Return true if the request was successful (res is not null and res.ok is true)
    return res && res.ok;
}

/**
 * NEW: Sends a request to the server to explicitly stop a stream.
 * @param {string} streamUrl - The URL of the stream to stop.
 * @returns {Promise<boolean>} - True on success, false on failure.
 */
export async function stopStream(streamUrl, profileId = null) {
    console.log(`[API] Sending request to stop the current stream on the server. ProfileID: ${profileId || 'N/A'}`);
    const res = await apiFetch('/api/stream/stop', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: streamUrl, profileId })
    });
    return res && res.ok;
}

/**
 * NEW: Notifies the server that a "Redirect" stream has started.
 * @param {string} streamUrl - The URL of the stream.
 * @param {string} channelId - The ID of the channel.
 * @param {string} channelName - The name of the channel.
 * @param {string} channelLogo - The URL for the channel's logo.
 * @returns {Promise<number|null>} - The history ID for this session, or null on failure.
 */
export async function startRedirectStream(streamUrl, channelId, channelName, channelLogo) {
    console.log('[API] Notifying server of REDIRECT stream start.');
    const res = await apiFetch('/api/activity/start-redirect', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ streamUrl, channelId, channelName, channelLogo })
    });

    if (res && res.ok) {
        const data = await res.json();
        return data.historyId;
    }
    return null;
}

/**
 * Sends a periodic heartbeat for an active redirect stream.
 * @param {number} historyId - The history ID of the active redirect session.
 * @returns {Promise<boolean>}
 */
export async function sendRedirectHeartbeat(historyId) {
    if (!historyId) return false;
    try {
        const res = await fetch('/api/activity/heartbeat', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ historyId })
        });
        return res && res.ok;
    } catch (e) {
        console.warn(`[API] Failed to send heartbeat for history ID ${historyId}:`, e);
        return false;
    }
}

/**
 * NEW: Notifies the server that a "Redirect" stream has stopped.
 * Supports keepalive: true so browser delivers request even during page unload.
 * @param {number} historyId - The history ID of the stream session to stop.
 * @param {boolean} useKeepalive - If true, uses keepalive: true for unload/pagehide.
 * @returns {Promise<boolean>} - True on success, false on failure.
 */
export async function stopRedirectStream(historyId, useKeepalive = false) {
    if (!historyId) return false;
    console.log(`[API] Notifying server of REDIRECT stream stop for history ID: ${historyId} (keepalive=${useKeepalive}).`);
    if (useKeepalive) {
        try {
            fetch('/api/activity/stop-redirect', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ historyId }),
                keepalive: true
            }).catch(() => {});
            return true;
        } catch (e) {
            return false;
        }
    }
    const res = await apiFetch('/api/activity/stop-redirect', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ historyId })
    });
    return res && res.ok;
}

/**
 * Fetches the structured VOD library (movies and series) from the server.
 * @returns {Promise<object|null>} An object like { movies: [], series: [] } or null on failure.
 */
export async function fetchVodLibrary() {
    console.log('[API] Fetching VOD library from /api/vod/library.');
    // Add timestamp to prevent caching
    const response = await apiFetch(`/api/vod/library?t=${Date.now()}`);
    if (!response) {
        console.error('[API] Failed to fetch VOD library: No response from apiFetch.');
        return null;
    }

    try {
        const library = await response.json();
        console.log('[API] VOD library fetched successfully.');

        // We expect the server to send { movies: [...], series: [...], categories: [...] }
        if (library.movies && library.series && library.categories) {
            return library;
        } else {
            console.error('[API] VOD library format is incorrect. Expected { movies: [], series: [], categories: [] }');
            showNotification('Failed to parse VOD library from server.', true);
            return null;
        }
    } catch (e) {
        console.error('[API] Error parsing VOD library JSON:', e);
        showNotification('Failed to parse VOD library.', true);
        return null;
    }
}

/**
 * Fetches the detailed information for a specific series, including episodes (lazy loading).
 * @param {string|number} seriesId - The ID of the series to fetch.
 * @returns {Promise<object|null>} A series object with seasons and episodes, or null on failure.
 */
export async function fetchSeriesDetails(seriesId) {
    console.log(`[API] Fetching details for Series ID: ${seriesId} from /api/vod/series/${seriesId}.`);
    // Add timestamp to prevent caching
    const response = await apiFetch(`/api/vod/series/${seriesId}?t=${Date.now()}`);
    if (!response) {
        console.error(`[API] Failed to fetch details for Series ID ${seriesId}: No response from apiFetch.`);
        showNotification('Could not load series details.', true); // Use showNotification
        return null;
    }

    try {
        const seriesData = await response.json();
        console.log(`[API] Series details for ID ${seriesId} fetched successfully.`);
        // We expect the server to send the full series object including 'seasons'
        if (seriesData && seriesData.seasons) {
            return seriesData;
        } else {
            console.error(`[API] Series details format is incorrect for ID ${seriesId}. Expected 'seasons' property.`);
            showNotification('Failed to parse series details from server.', true); // Use showNotification
            return null;
        }
    } catch (e) {
        console.error(`[API] Error parsing series details JSON for ID ${seriesId}:`, e);
        showNotification('Failed to parse series details.', true); // Use showNotification
        return null;
    }
}

/**
 * Fetches stored watch progress for a given media content.
 * @param {string} contentType - 'vod_movie', 'vod_episode', 'dvr_recording', 'dvr_job'
 * @param {string|number} contentId
 * @returns {Promise<{progress_seconds: number, duration_seconds: number, updated_at: string}|null>}
 */
export async function getWatchProgress(contentType, contentId) {
    if (!contentType || !contentId) return null;
    try {
        const response = await apiFetch(`/api/progress/${encodeURIComponent(contentType)}/${encodeURIComponent(contentId)}?_t=${Date.now()}`);
        if (response && response.ok) {
            return await response.json();
        }
    } catch (e) {
        console.warn(`[WATCH_PROGRESS] Error fetching progress for ${contentType}/${contentId}:`, e);
    }
    return null;
}

/**
 * Saves current watch progress for a given media content.
 * @param {string} contentType
 * @param {string|number} contentId
 * @param {number} progressSeconds
 * @param {number} durationSeconds
 */
export async function saveWatchProgressApi(contentType, contentId, progressSeconds, durationSeconds) {
    if (!contentType || !contentId) return null;
    try {
        await apiFetch('/api/progress', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                contentType,
                contentId: String(contentId),
                progressSeconds: Math.floor(progressSeconds),
                durationSeconds: Math.floor(durationSeconds)
            })
        });
    } catch (e) {
        console.warn(`[WATCH_PROGRESS] Error saving progress for ${contentType}/${contentId}:`, e);
    }
}

/**
 * Deletes stored watch progress for a given media content.
 * @param {string} contentType
 * @param {string|number} contentId
 */
export async function deleteWatchProgress(contentType, contentId) {
    if (!contentType || !contentId) return;
    try {
        await apiFetch(`/api/progress/${encodeURIComponent(contentType)}/${encodeURIComponent(contentId)}`, {
            method: 'DELETE'
        });
    } catch (e) {
        console.warn(`[WATCH_PROGRESS] Error deleting progress for ${contentType}/${contentId}:`, e);
    }
}
