/**
 * telemetry.js
 * Client-to-server log telemetry for mobile and desktop diagnostics.
 * Buffers client diagnostics and streams them to /api/logs/client so they appear in server log files.
 */

import { guideState } from './state.js';
import { getDeviceId } from './api.js';

let telemetryBuffer = [];
let flushTimer = null;
const FLUSH_INTERVAL = 2000;
const MAX_BUFFER_SIZE = 40;

/**
 * Checks whether client debug telemetry is enabled in global settings.
 * @returns {boolean}
 */
export function isTelemetryEnabled() {
    return guideState?.settings?.clientTelemetryEnabled === true;
}

/**
 * Sends a telemetry entry to the buffer, triggering a flush if needed.
 * @param {string} tag - Category tag (e.g. 'PLAYER', 'TOUCH', 'OS', 'ERROR')
 * @param {string} message - Primary log description
 * @param {any} [data=null] - Supplementary metadata, coordinates, or error stack
 * @param {boolean} [immediate=false] - If true, flushes immediately (e.g. on unload)
 */
export function sendTelemetry(tag, message, data = null, immediate = false) {
    if (!isTelemetryEnabled()) return;

    const entry = {
        timestamp: new Date().toISOString(),
        tag: tag || 'CLIENT',
        message: message || '',
        data: data || null,
        screen: `${window.innerWidth}x${window.innerHeight}`,
        visibility: document.visibilityState
    };

    telemetryBuffer.push(entry);

    if (immediate) {
        flushTelemetry(true);
    } else if (telemetryBuffer.length >= MAX_BUFFER_SIZE) {
        flushTelemetry(false);
    } else if (!flushTimer) {
        flushTimer = setTimeout(() => flushTelemetry(false), FLUSH_INTERVAL);
    }
}

/**
 * Flushes buffered logs to /api/logs/client.
 * @param {boolean} [useBeacon=false]
 */
export function flushTelemetry(useBeacon = false) {
    if (flushTimer) {
        clearTimeout(flushTimer);
        flushTimer = null;
    }

    if (telemetryBuffer.length === 0) return;

    const logsToSend = [...telemetryBuffer];
    telemetryBuffer = [];

    const deviceId = typeof getDeviceId === 'function' ? getDeviceId() : 'unknown';
    const payload = JSON.stringify({ deviceId, logs: logsToSend });

    if (useBeacon && typeof navigator.sendBeacon === 'function') {
        try {
            const blob = new Blob([payload], { type: 'application/json' });
            const sent = navigator.sendBeacon('/api/logs/client', blob);
            if (sent) return;
        } catch (e) {
            // Fall back to keepalive fetch
        }
    }

    fetch('/api/logs/client', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: payload,
        keepalive: true
    }).catch(() => {
        // Silently swallow network errors during telemetry delivery to avoid feedback loops
    });
}

/**
 * Helper to trace a player action with caller stack trace.
 * @param {string} actionName
 * @param {any} [details=null]
 */
export function tracePlayerAction(actionName, details = null) {
    if (!isTelemetryEnabled()) return;
    const stack = (new Error().stack || '')
        .split('\n')
        .slice(2, 6)
        .map(s => s.trim())
        .join(' -> ');
    sendTelemetry('PLAYER_ACTION', actionName, { stack, ...details }, true);
}

/**
 * Initializes global browser listeners for uncaught errors, visibility changes, and page unloading.
 */
export function initTelemetry() {
    window.addEventListener('error', (e) => {
        sendTelemetry('WINDOW_ERROR', e.message || 'Uncaught Script Error', {
            filename: e.filename,
            lineno: e.lineno,
            colno: e.colno,
            stack: e.error?.stack
        }, true);
    });

    window.addEventListener('unhandledrejection', (e) => {
        sendTelemetry('PROMISE_REJECTION', e.reason?.message || String(e.reason), {
            stack: e.reason?.stack
        }, true);
    });

    document.addEventListener('visibilitychange', () => {
        sendTelemetry('VISIBILITY', `Document visibility changed to ${document.visibilityState}`, {
            visibilityState: document.visibilityState
        });
    });

    const handleUnload = (e) => {
        sendTelemetry('LIFECYCLE', `Page unloading: ${e.type}`, {
            persisted: e.persisted
        }, true);
    };
    window.addEventListener('pagehide', handleUnload);
    window.addEventListener('beforeunload', handleUnload);
}
