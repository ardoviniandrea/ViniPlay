/**
 * player.js
 * * Manages the video player functionality using mpegts.js and Google Cast.
 */

import { appState, guideState, UIElements } from './state.js';
// MODIFIED: Added stopStream and sendRedirectHeartbeat to the import
import { saveUserSetting, stopStream, startRedirectStream, stopRedirectStream, sendRedirectHeartbeat, saveWatchProgressApi, getWatchProgress, deleteWatchProgress, withCsrfHeaders, appendCsrfQuery } from './api.js';
import { showNotification, openModal, closeModal } from './ui.js';
import { castState, loadMedia, setLocalPlayerState } from './cast.js';
import { logToPlayerConsole } from './player_direct.js';
import { ICONS } from './icons.js'; // NEW: Import ICONS
import { getCodecName } from './codecs.js'; // NEW: Import codec utility
import { sendTelemetry, tracePlayerAction } from './telemetry.js';

let streamInfoInterval = null; // Interval to update stream stats
let currentLocalStreamUrl = null; // ADDED: Track the original URL of the currently playing local stream
let currentProfileId = null; // ADDED: Track the profile ID of the current stream
let currentRedirectHistoryId = null; // To track redirect streams for logging
let redirectHeartbeatInterval = null; // NEW: Periodic heartbeat timer for active redirect stream
let currentRedirectToken = 0; // NEW: Guard against race conditions when switching streams
let currentStreamUrlToPlay = null; // Track full stream URL for audio/video swapping
let isUserInitiatedPause = false; // Distinguishes intentional user pause from OS screen lock
let isTransitioningFromPip = false; // Prevents OS PiP docking pause from being misclassified as user pause
let isTransitioningAudioOnly = false; // Prevents OS PiP/background surface teardown from pausing VODs when entering Audio-Only
let directAudioHandoff = null; // Stores { url, duration, lastKnownTime, audioTrackIndex } when progressive VOD/DVR uses #audioElement
let playbackLockRelease = null; // Web Lock to prevent Chrome Android from discarding background tab
let isStoppingPlayer = false; // Prevents leavepictureinpicture from reopening modal during stopAndCleanupPlayer
let pipWindowCheckTimer = null;
let activePipWindowRef = null;
let activePipResizeHandler = null;

function clearPipWindowWatch() {
    if (pipWindowCheckTimer) {
        clearTimeout(pipWindowCheckTimer);
        pipWindowCheckTimer = null;
    }
    if (activePipWindowRef && activePipResizeHandler) {
        try {
            activePipWindowRef.removeEventListener('resize', activePipResizeHandler);
        } catch (e) {}
    }
    activePipWindowRef = null;
    activePipResizeHandler = null;
}

/**
 * Synchronizes #video-modal.pip-active and the desktop #pip-active-banner recovery pill.
 */
function setPipModalActive(active) {
    const banner = document.getElementById('pip-active-banner');
    const bannerTitle = document.getElementById('pip-active-banner-title');
    if (active) {
        UIElements.videoModal?.classList.add('pip-active');
        document.body.classList.remove('modal-open');
        if (banner && !window.ViniAndroid && !document.body.classList.contains('android-pip-mode')) {
            if (bannerTitle) {
                bannerTitle.textContent = currentChannelInfo?.name || UIElements.videoTitle?.textContent || 'Stream';
            }
            banner.classList.remove('hidden');
        }
    } else {
        UIElements.videoModal?.classList.remove('pip-active');
        banner?.classList.add('hidden');
    }
}

if (typeof window !== 'undefined') {
    window.__viniNativeAudioHandoffReady = true;
}

function getAudioElement() {
    return document.getElementById('audioElement') || UIElements.audioElement;
}

// --- NEW: Watch Progress Tracking State ---
let currentActiveMedia = null; // Stores { contentType, contentId, title, duration }
let progressSaveInterval = null;
let lastSavedProgressSec = -1;

// --- NEW: Auto-retry logic state ---
let currentChannelInfo = null; // Stores { url, name, channelId, logo } for retries
let retryCount = 0;
const MAX_RETRIES = 3;
let retryTimeout = null;

/**
 * Acquires a Web Lock to prevent Chromium from discarding the tab while media is playing.
 */
export function acquireTabDiscardLock() {
    if ('locks' in navigator && !playbackLockRelease) {
        navigator.locks.request('viniplay_playback_lock', () => {
            return new Promise(resolve => {
                playbackLockRelease = resolve;
            });
        }).catch(() => {});
        console.log('[PLAYER] Acquired Web Lock to prevent background tab discarding.');
    }
}

/**
 * Releases the Web Lock when playback stops.
 */
export function releaseTabDiscardLock() {
    if (playbackLockRelease) {
        playbackLockRelease();
        playbackLockRelease = null;
        console.log('[PLAYER] Released Web Lock for tab discarding.');
    }
}

/**
 * Starts periodic 30s heartbeat pings for an active redirect stream.
 * @param {number} historyId
 */
function startRedirectHeartbeat(historyId) {
    stopRedirectHeartbeat();
    if (!historyId) return;
    redirectHeartbeatInterval = setInterval(async () => {
        if (currentRedirectHistoryId === historyId) {
            const ok = await sendRedirectHeartbeat(historyId);
            if (!ok) {
                console.warn(`[PLAYER] Heartbeat failed or stream was closed by server for history ID ${historyId}.`);
            }
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
 * Starts a redirect logging session and initiates periodic heartbeats.
 * Guards against race conditions if user switches streams before promise resolves.
 */
function beginRedirectLogging(url, channelOrVodId, name, logo, mediaType = null) {
    if (currentRedirectHistoryId) {
        stopRedirectStream(currentRedirectHistoryId);
        currentRedirectHistoryId = null;
    }
    stopRedirectHeartbeat();

    const token = ++currentRedirectToken;

    startRedirectStream(url, channelOrVodId, name, logo, mediaType)
        .then(historyId => {
            if (!historyId) return;
            // If the user already switched channels or closed player, immediately stop this session
            if (token !== currentRedirectToken) {
                console.log(`[PLAYER] Redirect stream ${historyId} was superseded. Stopping orphaned session.`);
                stopRedirectStream(historyId);
                return;
            }
            currentRedirectHistoryId = historyId;
            startRedirectHeartbeat(historyId);
        })
        .catch(err => console.error('[PLAYER] Error starting redirect stream logging:', err));
}

/**
 * Calculates current playback progress and duration for active media.
 * @returns {{ contentType: string, contentId: string, progressSeconds: number, durationSeconds: number } | null}
 */
export function getCurrentPlaybackProgress() {
    if (!currentActiveMedia) return null;
    let progress = 0;
    let duration = 0;
    const audioEl = getAudioElement();

    if (currentVodTranscodeSession) {
        const curElapsed = UIElements.videoElement?.currentTime || 0;
        progress = (currentVodTranscodeSession.currentSeekTime || 0) + curElapsed;
        duration = currentVodTranscodeSession.duration || currentActiveMedia.duration || 0;
    } else if (directAudioHandoff && audioEl) {
        progress = audioEl.currentTime > 0 ? audioEl.currentTime : (directAudioHandoff.lastKnownTime || 0);
        const audDur = audioEl.duration;
        duration = (isFinite(audDur) && audDur > 0) ? audDur : (directAudioHandoff.duration || currentActiveMedia.duration || 0);
    } else if (UIElements.videoElement) {
        progress = UIElements.videoElement.currentTime || 0;
        const vidDur = UIElements.videoElement.duration;
        duration = (isFinite(vidDur) && vidDur > 0) ? vidDur : (currentActiveMedia.duration || 0);
    }

    return {
        contentType: currentActiveMedia.contentType,
        contentId: currentActiveMedia.contentId,
        progressSeconds: Math.floor(progress),
        durationSeconds: Math.floor(duration)
    };
}

/**
 * Sets active media for tracking watch progress and starts periodic saving.
 * @param {{ contentType: string, contentId: string|number, title?: string, duration?: number } | null} mediaInfo
 */
export function setActiveMediaTracking(mediaInfo) {
    flushWatchProgress();

    if (!mediaInfo || !mediaInfo.contentType || !mediaInfo.contentId) {
        currentActiveMedia = null;
        if (progressSaveInterval) {
            clearInterval(progressSaveInterval);
            progressSaveInterval = null;
        }
        return;
    }

    currentActiveMedia = {
        contentType: mediaInfo.contentType,
        contentId: String(mediaInfo.contentId),
        title: mediaInfo.title || '',
        duration: mediaInfo.duration || 0
    };
    lastSavedProgressSec = -1;

    if (progressSaveInterval) clearInterval(progressSaveInterval);
    // Auto-save every 10 seconds during active playback
    progressSaveInterval = setInterval(() => {
        saveCurrentWatchProgress(false);
    }, 10000);
    console.log(`[PLAYER] Active media tracking started for ${currentActiveMedia.contentType}:${currentActiveMedia.contentId}`);
}

/**
 * Saves current watch progress to the backend if threshold met.
 * @param {boolean} [force=false]
 */
export function saveCurrentWatchProgress(force = false) {
    if (!currentActiveMedia) return;
    const prog = getCurrentPlaybackProgress();
    if (!prog) return;

    if (!force && Math.abs(prog.progressSeconds - lastSavedProgressSec) < 3) {
        return;
    }
    if (prog.progressSeconds < 5 && !force) {
        return;
    }

    lastSavedProgressSec = prog.progressSeconds;
    saveWatchProgressApi(prog.contentType, prog.contentId, prog.progressSeconds, prog.durationSeconds);
}

/**
 * Immediately flushes watch progress to the server (e.g. on unload/cleanup).
 */
export function flushWatchProgress() {
    if (!currentActiveMedia) return;
    const prog = getCurrentPlaybackProgress();
    if (prog && prog.progressSeconds >= 5) {
        const payload = JSON.stringify({
            contentType: prog.contentType,
            contentId: prog.contentId,
            progressSeconds: prog.progressSeconds,
            durationSeconds: prog.durationSeconds
        });
        if (navigator.sendBeacon) {
            const blob = new Blob([payload], { type: 'application/json' });
            navigator.sendBeacon(appendCsrfQuery('/api/progress'), blob);
        } else {
            saveWatchProgressApi(prog.contentType, prog.contentId, prog.progressSeconds, prog.durationSeconds);
        }
    }
    currentActiveMedia = null;
    if (progressSaveInterval) {
        clearInterval(progressSaveInterval);
        progressSaveInterval = null;
    }
    lastSavedProgressSec = -1;
}

// --- NEW: Screen Wake Lock & Mobile State ---
let screenWakeLock = null;
let isPlayerLocked = false;
let isAudioOnly = false;
let noSleepVideo = null;
let keepAwakeAudioCtx = null;
let userGesturePrimed = false;

// Dual-track MP4 video with AAC audio encoded as data URI (universal mobile compatibility, keeps mobile OS audio/video session awake)
const NO_SLEEP_MP4 = "data:video/mp4;base64,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";

function getNoSleepVideo() {
    if (!noSleepVideo) {
        noSleepVideo = document.createElement('video');
        noSleepVideo.setAttribute('title', 'NoSleep');
        noSleepVideo.setAttribute('playsinline', '');
        noSleepVideo.setAttribute('webkit-playsinline', '');
        noSleepVideo.setAttribute('muted', '');
        noSleepVideo.muted = true;
        // Keep in active viewport so mobile battery saver doesn't pause it
        noSleepVideo.style.position = 'fixed';
        noSleepVideo.style.bottom = '0px';
        noSleepVideo.style.right = '0px';
        noSleepVideo.style.width = '2px';
        noSleepVideo.style.height = '2px';
        noSleepVideo.style.opacity = '0.01';
        noSleepVideo.style.pointerEvents = 'none';
        noSleepVideo.style.zIndex = '1';
        noSleepVideo.src = NO_SLEEP_MP4;

        // NoSleep seek loop to prevent loop boundary sleep
        noSleepVideo.addEventListener('timeupdate', () => {
            if (noSleepVideo.currentTime > 0.5) {
                noSleepVideo.currentTime = Math.random() * 0.4;
            }
        });

        document.body.appendChild(noSleepVideo);
    }
    return noSleepVideo;
}

function startAudioKeepAwake() {
    try {
        if (!keepAwakeAudioCtx) {
            const AudioCtx = window.AudioContext || window.webkitAudioContext;
            if (AudioCtx) {
                keepAwakeAudioCtx = new AudioCtx();
                const osc = keepAwakeAudioCtx.createOscillator();
                const gain = keepAwakeAudioCtx.createGain();
                gain.gain.value = 0.00001; // virtually silent
                osc.connect(gain);
                gain.connect(keepAwakeAudioCtx.destination);
                osc.start();
            }
        }
        if (keepAwakeAudioCtx && keepAwakeAudioCtx.state === 'suspended') {
            keepAwakeAudioCtx.resume();
        }
    } catch (e) {
        console.warn('[PLAYER] Audio keep-awake failed:', e);
    }
}

/**
 * Prime wake lock and audio session synchronously on ANY first user touch or click.
 * This unlocks the browser's media autoplay policy with user activation authority.
 */
export function primeMobileKeepAwake() {
    if (userGesturePrimed) return;
    userGesturePrimed = true;
    startAudioKeepAwake();
    try {
        const vid = getNoSleepVideo();
        if (vid && vid.paused) {
            vid.play().then(() => {
                if (!appState.player && (!UIElements.videoElement || UIElements.videoElement.paused)) {
                    vid.pause();
                }
            }).catch(() => {});
        }
    } catch (e) {}
}

document.addEventListener('touchstart', primeMobileKeepAwake, { passive: true, once: true });
document.addEventListener('click', primeMobileKeepAwake, { passive: true, once: true });

/**
 * Helper to bind touch and click events on mobile and desktop without 300ms delays or double-firing.
 * @param {HTMLElement} element
 * @param {Function} handler
 */
export function bindTap(element, handler) {
    if (!element) return;
    let handled = false;
    element.addEventListener('touchend', (e) => {
        e.preventDefault();
        e.stopPropagation();
        handled = true;
        handler(e);
        setTimeout(() => { handled = false; }, 400);
    }, { passive: false });

    element.addEventListener('click', (e) => {
        if (handled) return;
        e.stopPropagation();
        handler(e);
    });
}

/**
 * Requests a screen wake lock to keep the mobile device screen awake during playback (including PiP).
 * Automatically uses the native W3C Screen Wake Lock API in Secure Contexts (HTTPS),
 * and falls back to a looping keepalive video and silent Web Audio on plain HTTP (LAN IP).
 */
export async function requestScreenWakeLock() {
    // 0. Screen wake lock is only valid when document is visible (W3C Screen Wake Lock API spec)
    // Never attempt wake lock or fallback keepalive when the screen is off or app is in background
    if (document.visibilityState === 'hidden') {
        return;
    }

    // 1. Try native Screen Wake Lock API if in Secure Context (HTTPS or localhost)
    if ('wakeLock' in navigator && window.isSecureContext) {
        try {
            if (screenWakeLock !== null) return;
            screenWakeLock = await navigator.wakeLock.request('screen');
            console.log('[PLAYER] Native Screen Wake Lock acquired.');
            screenWakeLock.addEventListener('release', () => {
                console.log('[PLAYER] Native Screen Wake Lock released.');
                screenWakeLock = null;
            });
            return;
        } catch (err) {
            console.warn('[PLAYER] Native Screen Wake Lock failed, falling back to NoSleep keepalive:', err.name, err.message);
            screenWakeLock = null;
        }
    }

    // 2. Fallback for plain HTTP (e.g. mobile accessing local IP) or unsupported browsers
    // IMPORTANT: If a primary stream is active, it already keeps the screen awake natively;
    // running noSleepVideo concurrently would steal audio focus on mobile OS.
    const isPrimaryStreamActive = UIElements.videoElement && (!UIElements.videoElement.paused || UIElements.videoElement.src || appState.player || appState.hlsPlayer);
    if (isPrimaryStreamActive) {
        return;
    }

    startAudioKeepAwake();
    try {
        const vid = getNoSleepVideo();
        if (vid && vid.paused) {
            await vid.play();
            console.log('[PLAYER] NoSleep fallback video playing to prevent mobile screen auto-lock.');
        }
    } catch (e) {
        console.warn('[PLAYER] NoSleep video fallback playback failed:', e);
    }
}

/**
 * Releases the active screen wake lock and pauses fallback video if active.
 */
export async function releaseScreenWakeLock() {
    if (screenWakeLock !== null) {
        try {
            await screenWakeLock.release();
            console.log('[PLAYER] Native Screen Wake Lock explicitly released.');
        } catch (err) {
            console.warn('[PLAYER] Error releasing Screen Wake Lock:', err);
        }
        screenWakeLock = null;
    }

    if (noSleepVideo && !noSleepVideo.paused) {
        try {
            noSleepVideo.pause();
            console.log('[PLAYER] NoSleep fallback video paused.');
        } catch (e) {
            console.warn('[PLAYER] Error pausing NoSleep fallback video:', e);
        }
    }

    if (keepAwakeAudioCtx && keepAwakeAudioCtx.state === 'running') {
        try {
            keepAwakeAudioCtx.suspend();
        } catch (e) {}
    }
}

/**
 * Resolves a descriptive subtitle (current EPG program or VOD/DVR category) for MediaSession & Android player card.
 */
function resolveMediaSessionSubtitle() {
    let base = 'ViniPlay';
    if (currentChannelInfo?.channelId && guideState.programs?.[currentChannelInfo.channelId]) {
        const nowMs = Date.now();
        const liveProg = guideState.programs[currentChannelInfo.channelId].find(
            p => new Date(p.start).getTime() <= nowMs && new Date(p.stop).getTime() > nowMs
        );
        if (liveProg?.title) {
            base = liveProg.title;
        } else {
            base = 'Live TV • ViniPlay';
        }
    } else if (currentActiveMedia?.contentType === 'vod_episode') {
        base = 'Series • ViniPlay';
    } else if (currentActiveMedia?.contentType === 'vod_movie') {
        base = 'Movie • ViniPlay';
    } else if (currentActiveMedia?.contentType === 'dvr_recording' || appState.activeTimeshiftJobId) {
        base = 'DVR • ViniPlay';
    } else if (currentVodTranscodeSession) {
        base = 'VOD • ViniPlay';
    }
    if (isAudioOnly && !base.includes('Audio Only')) {
        return `${base} • Audio Only`;
    }
    return base;
}

/**
 * Updates navigator.mediaSession metadata and action handlers for background/lock-screen controls.
 */
function updateMediaSession(title, logo, subtitle = '') {
    if ('mediaSession' in navigator) {
        try {
            const resolvedLogo = logo
                ? (logo.startsWith('http') || logo.startsWith('data:') ? logo : `${window.location.origin}${logo.startsWith('/') ? '' : '/'}${logo}`)
                : `${window.location.origin}/viniplay.png`;
            const artistText = subtitle || resolveMediaSessionSubtitle();
            navigator.mediaSession.metadata = new MediaMetadata({
                title: title || 'ViniPlay Stream',
                artist: artistText,
                artwork: [{ src: resolvedLogo, sizes: '512x512', type: 'image/png' }]
            });
            const getActiveMediaEl = () => (directAudioHandoff && getAudioElement()) ? getAudioElement() : UIElements.videoElement;
            const audioTarget = directAudioHandoff ? getAudioElement() : null;
            navigator.mediaSession.playbackState = (audioTarget && audioTarget.paused && isUserInitiatedPause) ? 'paused' : 'playing';

            navigator.mediaSession.setActionHandler('play', () => {
                isUserInitiatedPause = false;
                if (typeof window !== 'undefined') window.__viniExplicitlyPausedByUser = false;
                if (noSleepVideo && !noSleepVideo.paused) {
                    try { noSleepVideo.pause(); } catch (e) {}
                }
                const target = getActiveMediaEl();
                if (target) {
                    target.play().then(() => {
                        navigator.mediaSession.playbackState = 'playing';
                    }).catch(console.error);
                }
            });
            navigator.mediaSession.setActionHandler('pause', () => {
                isUserInitiatedPause = true;
                if (typeof window !== 'undefined') {
                    window.__viniSuppressPauseUntil = 0;
                    window.__viniExplicitlyPausedByUser = true;
                }
                getActiveMediaEl()?.pause();
                navigator.mediaSession.playbackState = 'paused';
            });
            navigator.mediaSession.setActionHandler('stop', () => {
                isUserInitiatedPause = true;
                if (typeof window !== 'undefined') {
                    window.__viniSuppressPauseUntil = 0;
                    window.__viniExplicitlyPausedByUser = false;
                }
                stopAndCleanupPlayer();
            });
            navigator.mediaSession.setActionHandler('seekto', (details) => {
                if (details && typeof details.seekTime === 'number') {
                    if (currentVodTranscodeSession) {
                        performVodSeek(details.seekTime);
                    } else {
                        const target = getActiveMediaEl();
                        if (target && isFinite(target.duration) && target.duration > 0) {
                            target.currentTime = details.seekTime;
                            if (directAudioHandoff && target === getAudioElement()) {
                                directAudioHandoff.lastKnownTime = target.currentTime;
                            }
                        }
                    }
                }
            });
        } catch (e) {
            console.warn('[PLAYER] MediaSession configuration failed:', e);
        }
    }
}

/**
 * Toggles touch-lock overlay on the player to prevent accidental touches.
 * Functional in both modal window and fullscreen modes.
 * @param {boolean|null} forceState
 */
export function togglePlayerLock(forceState = null) {
    isPlayerLocked = forceState !== null ? forceState : !isPlayerLocked;
    const lockOverlay = document.getElementById('player-lock-overlay') || UIElements.playerLockOverlay;
    const videoModal = document.getElementById('video-modal') || UIElements.videoModal;
    const lockBtn = document.getElementById('player-lock-btn') || UIElements.playerLockBtn;
    const videoEl = UIElements.videoElement;

    // Dismiss options dropdown if open
    document.getElementById('player-more-options-menu')?.classList.add('hidden');

    if (isPlayerLocked) {
        videoModal?.classList.add('player-locked');
        lockOverlay?.classList.remove('hidden');
        if (videoEl) videoEl.controls = false;
        if (lockBtn) {
            lockBtn.classList.add('text-yellow-400');
            lockBtn.classList.remove('text-gray-400');
        }
        showNotification('Player locked. Tap unlock button to restore controls.', false, 2000);
    } else {
        videoModal?.classList.remove('player-locked');
        lockOverlay?.classList.add('hidden');
        if (videoEl && !isAudioOnly && !currentVodTranscodeSession && !appState.activeTimeshiftJobId) {
            videoEl.controls = true;
        }
        if (lockBtn) {
            lockBtn.classList.remove('text-yellow-400');
            lockBtn.classList.add('text-gray-400');
        }
        showNotification('Player unlocked.', false, 1500);
    }
}

function canUseDirectAudioHandoff(videoEl) {
    if (!videoEl || appState.player || appState.hlsPlayer || appState.shakaPlayer || currentVodTranscodeSession || appState.activeTimeshiftJobId) {
        return false;
    }
    const rawUrl = videoEl.currentSrc || videoEl.getAttribute('src') || currentStreamUrlToPlay || '';
    if (!rawUrl || rawUrl.startsWith('blob:') || rawUrl.startsWith('data:') || rawUrl.includes('/stream?')) {
        return false;
    }
    return true;
}

function enterDirectAudioHandoff(videoEl) {
    const audioEl = getAudioElement();
    if (!audioEl || !canUseDirectAudioHandoff(videoEl) || directAudioHandoff) {
        return false;
    }

    const savedUrl = videoEl.currentSrc || videoEl.getAttribute('src') || currentStreamUrlToPlay;
    const savedTime = videoEl.currentTime || 0;
    const savedDuration = (isFinite(videoEl.duration) && videoEl.duration > 0)
        ? videoEl.duration
        : (currentActiveMedia?.duration || 0);
    const savedVolume = videoEl.volume;
    const savedMuted = videoEl.muted;
    const wasExplicitlyPaused = videoEl.paused && (isUserInitiatedPause || (typeof window !== 'undefined' && window.__viniExplicitlyPausedByUser));

    let selectedTrackIdx = -1;
    if (videoEl.audioTracks && videoEl.audioTracks.length > 1) {
        for (let i = 0; i < videoEl.audioTracks.length; i++) {
            if (videoEl.audioTracks[i].enabled) {
                selectedTrackIdx = i;
                break;
            }
        }
    }

    directAudioHandoff = {
        url: savedUrl,
        duration: savedDuration,
        lastKnownTime: savedTime,
        audioTrackIndex: selectedTrackIdx
    };

    // Detach <videoElement> first so only 1 HTTP connection is open to the IPTV/VOD provider
    videoEl.pause();
    videoEl.removeAttribute('src');
    videoEl.load();

    audioEl.volume = savedVolume;
    audioEl.muted = savedMuted;
    audioEl.src = savedUrl;
    audioEl.load();

    const applyHandoffMetadata = () => {
        if (!directAudioHandoff) return;
        if (selectedTrackIdx >= 0 && audioEl.audioTracks && audioEl.audioTracks[selectedTrackIdx]) {
            for (let i = 0; i < audioEl.audioTracks.length; i++) {
                audioEl.audioTracks[i].enabled = (i === selectedTrackIdx);
            }
        }
        if (savedTime > 0) {
            try {
                audioEl.currentTime = savedTime;
            } catch (e) {}
        }
    };

    if (audioEl.readyState >= 1) {
        applyHandoffMetadata();
    } else {
        audioEl.addEventListener('loadedmetadata', applyHandoffMetadata, { once: true });
    }

    if (!wasExplicitlyPaused) {
        audioEl.play().catch(err => console.warn('[PLAYER] Audio-Only element play warning:', err));
    }
    return true;
}

function exitDirectAudioHandoff(restoreVideo = true) {
    const audioEl = getAudioElement();
    const videoEl = UIElements.videoElement;
    const handoff = directAudioHandoff;
    directAudioHandoff = null;

    if (!handoff) {
        if (audioEl && (audioEl.currentSrc || audioEl.getAttribute('src'))) {
            audioEl.pause();
            audioEl.removeAttribute('src');
            audioEl.load();
        }
        return false;
    }

    const resumeTime = (audioEl && audioEl.currentTime > 0) ? audioEl.currentTime : (handoff.lastKnownTime || 0);
    const resumeVolume = audioEl ? audioEl.volume : (videoEl ? videoEl.volume : 1);
    const resumeMuted = audioEl ? audioEl.muted : false;

    if (audioEl) {
        audioEl.pause();
        audioEl.removeAttribute('src');
        audioEl.load();
    }

    if (restoreVideo && videoEl && handoff.url) {
        isUserInitiatedPause = false;
        if (typeof window !== 'undefined') window.__viniExplicitlyPausedByUser = false;
        videoEl.volume = resumeVolume;
        videoEl.muted = resumeMuted;
        videoEl.src = handoff.url;
        videoEl.load();

        const applyVideoRestore = () => {
            if (handoff.audioTrackIndex >= 0 && videoEl.audioTracks && videoEl.audioTracks[handoff.audioTrackIndex]) {
                for (let i = 0; i < videoEl.audioTracks.length; i++) {
                    videoEl.audioTracks[i].enabled = (i === handoff.audioTrackIndex);
                }
            }
            if (resumeTime > 0) {
                try {
                    videoEl.currentTime = resumeTime;
                } catch (e) {}
            }
        };

        if (videoEl.readyState >= 1) {
            applyVideoRestore();
        } else {
            videoEl.addEventListener('loadedmetadata', applyVideoRestore, { once: true });
        }

        videoEl.play().catch(err => console.warn('[PLAYER] Video restore play warning:', err));
        return true;
    }
    return false;
}

/**
 * Toggles Audio-Only mode. Keeps the active media feed running seamlessly without disconnecting,
 * displays the dark glassmorphic overlay with channel info, and releases screen wake lock so the mobile display can sleep.
 * @param {boolean|null} forceState
 * @param {{ restoreVideo?: boolean }} [options]
 */
export function toggleAudioOnly(forceState = null, { restoreVideo = true } = {}) {
    isAudioOnly = forceState !== null ? forceState : !isAudioOnly;
    const overlay = document.getElementById('audio-only-overlay') || UIElements.audioOnlyOverlay;
    const audioOnlyBtn = document.getElementById('audio-only-btn') || UIElements.audioOnlyBtn;
    const audioBadge = document.getElementById('audio-only-badge');
    const logoEl = document.getElementById('audio-only-logo') || UIElements.audioOnlyLogo;
    const titleEl = document.getElementById('audio-only-title') || UIElements.audioOnlyTitle;
    const videoEl = UIElements.videoElement;

    // Dismiss options dropdown if open
    document.getElementById('player-more-options-menu')?.classList.add('hidden');

    if (isAudioOnly) {
        isTransitioningAudioOnly = true;
        isUserInitiatedPause = false;
        if (typeof window !== 'undefined') window.__viniExplicitlyPausedByUser = false;
        setTimeout(() => {
            isTransitioningAudioOnly = false;
        }, 6000);

        if (titleEl) {
            titleEl.textContent = currentChannelInfo?.name || UIElements.videoTitle?.textContent || 'Audio Playback';
        }
        if (logoEl) {
            const logoSrc = currentChannelInfo?.logo || '/viniplay.png';
            logoEl.src = logoSrc;
            logoEl.classList.remove('hidden');
        }
        overlay?.classList.remove('hidden');

        if (videoEl) {
            videoEl.style.opacity = '0';
            videoEl.style.pointerEvents = 'none';
            // Hand progressive Direct Play VOD/DVR audio over to #audioElement so Chromium never pauses when hidden
            const handedOff = enterDirectAudioHandoff(videoEl);
            if (!handedOff && videoEl.paused && !videoEl.ended && (videoEl.src || videoEl.currentSrc || appState.player || appState.hlsPlayer)) {
                videoEl.play().catch(() => {});
            }
        }
        if (audioOnlyBtn) {
            audioOnlyBtn.classList.add('text-blue-400');
            audioOnlyBtn.classList.remove('text-gray-400');
        }
        if (audioBadge) {
            audioBadge.classList.remove('hidden');
        }

        // Release screen wake lock so display can turn off to save battery
        releaseScreenWakeLock();
        updateMediaSession(currentChannelInfo?.name || UIElements.videoTitle?.textContent, currentChannelInfo?.logo);
        showNotification('Audio Only mode active. Screen can be locked.', false, 2500);
    } else {
        isTransitioningAudioOnly = false;
        overlay?.classList.add('hidden');
        const restoredFromAudio = exitDirectAudioHandoff(restoreVideo);
        if (videoEl) {
            videoEl.style.opacity = '1';
            videoEl.style.pointerEvents = 'auto';
            if (!isPlayerLocked && !currentVodTranscodeSession && !appState.activeTimeshiftJobId) {
                videoEl.controls = true;
            }
            if (restoreVideo && !restoredFromAudio && videoEl.paused && !videoEl.ended && (videoEl.src || videoEl.currentSrc || appState.player || appState.hlsPlayer)) {
                isUserInitiatedPause = false;
                if (typeof window !== 'undefined') window.__viniExplicitlyPausedByUser = false;
                videoEl.play().catch(() => {});
            }
        }
        if (audioOnlyBtn) {
            audioOnlyBtn.classList.remove('text-blue-400');
            audioOnlyBtn.classList.add('text-gray-400');
        }
        if (audioBadge) {
            audioBadge.classList.add('hidden');
        }

        if (restoreVideo) {
            requestScreenWakeLock();
            updateMediaSession(currentChannelInfo?.name || UIElements.videoTitle?.textContent, currentChannelInfo?.logo);
            showNotification('Resumed video playback.', false, 1500);
        }
    }
}

/**
 * Toggles fullscreen on the #video-modal-container element so overlays remain visible and functional.
 */
export function toggleContainerFullscreen() {
    const container = document.getElementById('video-modal-container') || UIElements.videoModalContainer;
    if (!container) return;

    const isFs = document.fullscreenElement || document.webkitFullscreenElement;
    if (!isFs) {
        if (container.requestFullscreen) {
            container.requestFullscreen().catch(err => {
                console.warn('[PLAYER] Container fullscreen request failed:', err);
                UIElements.videoElement?.requestFullscreen?.().catch(console.error);
            });
        } else if (container.webkitRequestFullscreen) {
            container.webkitRequestFullscreen();
        } else if (UIElements.videoElement?.webkitEnterFullscreen) {
            UIElements.videoElement.webkitEnterFullscreen();
        }
    } else {
        if (document.exitFullscreen) {
            document.exitFullscreen().catch(console.error);
        } else if (document.webkitExitFullscreen) {
            document.webkitExitFullscreen().catch(console.error);
        }
    }
}

/**
 * Updates fullscreen button style when fullscreen state changes.
 */
function updateFullscreenButtonState() {
    const fsBtn = document.getElementById('player-fullscreen-btn') || UIElements.playerFullscreenBtn;
    if (!fsBtn) return;
    const isFs = !!(document.fullscreenElement || document.webkitFullscreenElement);
    if (isFs) {
        fsBtn.classList.add('text-blue-500');
        fsBtn.classList.remove('text-gray-400');
    } else {
        fsBtn.classList.remove('text-blue-500');
        fsBtn.classList.add('text-gray-400');
    }
}

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
        await stopStream(currentLocalStreamUrl, currentProfileId);
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
    isStoppingPlayer = true;
    clearPipWindowWatch();
    try {
        tracePlayerAction('stopAndCleanupPlayer() invoked', {
            currentLocalStreamUrl,
            currentRedirectHistoryId,
            isUserInitiatedPause,
            visibilityState: document.visibilityState
        });

        // Flush watch progress before tearing down players
        flushWatchProgress();

        // NEW: Stop redirect heartbeat and invalidate in-flight promises
        stopRedirectHeartbeat();
        currentRedirectToken++;

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
            console.log(`[PLAYER] Sending stop request to server for URL: ${currentLocalStreamUrl} with Profile ID: ${currentProfileId}`);
            await stopStream(currentLocalStreamUrl, currentProfileId);
            currentLocalStreamUrl = null; // Clear the tracked URL after stopping
            currentProfileId = null; // Clear the profile ID
        }

        // Clear the stream info update interval
        if (streamInfoInterval) {
            clearInterval(streamInfoInterval);
            streamInfoInterval = null;
        }

        if (UIElements.streamInfoOverlay) {
            UIElements.streamInfoOverlay.classList.add('hidden');
        }

        // CRITICAL FIX: Always destroy the local player first, regardless of cast state
        // This ensures local playback stops when switching to cast or closing the modal
        if (appState.player) {
            console.log('[PLAYER] Destroying local mpegts player.');
            appState.player.destroy();
            appState.player = null;
        }

        // Destroy Hls.js player if active (e.g. timeshift playback)
        if (appState.hlsPlayer) {
            console.log('[PLAYER] Destroying Hls.js instance.');
            try {
                appState.hlsPlayer.destroy();
            } catch (e) {
                console.warn('[PLAYER] Error destroying Hls.js player:', e);
            }
            appState.hlsPlayer = null;
        }
        if (appState.shakaPlayer) {
            try {
                await appState.shakaPlayer.destroy();
            } catch (e) { }
            appState.shakaPlayer = null;
        }

        // Hide timeshift controls overlay if visible
        const timeshiftOverlay = document.getElementById('timeshift-controls-overlay') || UIElements.timeshiftControlsOverlay;
        if (timeshiftOverlay) {
            timeshiftOverlay.classList.add('hidden');
        }

        // Hide VOD controls overlay if visible
        const vodOverlay = document.getElementById('vod-controls-overlay');
        if (vodOverlay) {
            vodOverlay.classList.add('hidden');
            vodOverlay.style.opacity = '0';
        }
        if (vodTimeUpdateInterval) {
            clearInterval(vodTimeUpdateInterval);
            vodTimeUpdateInterval = null;
        }
        if (vodHideControlsTimeout) {
            clearTimeout(vodHideControlsTimeout);
            vodHideControlsTimeout = null;
        }
        if (seekDebounceTimeout) {
            clearTimeout(seekDebounceTimeout);
            seekDebounceTimeout = null;
        }
        pendingSeekTarget = null;
        isVodSeeking = false;

        // Stop active timeshift session on server if running
        if (appState.activeTimeshiftJobId) {
            console.log(`[PLAYER] Sending stop beacon for timeshift job ${appState.activeTimeshiftJobId}`);
            try {
                navigator.sendBeacon(appendCsrfQuery(`/api/dvr/timeshift/${appState.activeTimeshiftJobId}/stop`));
            } catch (e) { }
            appState.activeTimeshiftJobId = null;
        }

        isUserInitiatedPause = true;
        releaseTabDiscardLock();

        if (!castState.isCasting && document.pictureInPictureElement) {
            try {
                await document.exitPictureInPicture();
            } catch (e) {}
        }

        if (UIElements.videoElement) {
            UIElements.videoElement.pause();
            UIElements.videoElement.src = "";
            UIElements.videoElement.removeAttribute('src');
            UIElements.videoElement.load();
        }
        exitDirectAudioHandoff(false);

        currentStreamUrlToPlay = null;
        currentVodTranscodeSession = null;

        setLocalPlayerState(null, null, null);

        // If we're casting, just close the modal and keep the cast session active
        if (castState.isCasting) {
            console.log('[PLAYER] Closing modal but leaving cast session active.');
            closeModal(UIElements.videoModal);
            return;
        }

        // NEW: Release screen wake lock
        releaseScreenWakeLock();

        // NEW: Reset Audio-Only and Touch-Lock states if active
        if (isAudioOnly) {
            toggleAudioOnly(false, { restoreVideo: false });
        }
        if (isPlayerLocked) {
            togglePlayerLock(false);
        }

        if (UIElements.videoElement) {
            UIElements.videoElement.style.opacity = '1';
            UIElements.videoElement.style.pointerEvents = 'auto';
            UIElements.videoElement.controls = true;
        }

        // NEW: Exit fullscreen if container was in fullscreen mode
        if (document.fullscreenElement || document.webkitFullscreenElement) {
            if (document.exitFullscreen) {
                document.exitFullscreen().catch(() => {});
            } else if (document.webkitExitFullscreen) {
                document.webkitExitFullscreen().catch(() => {});
            }
        }

        // Unhide refresh button for future live playback
        const refreshBtn = document.getElementById('refresh-stream-btn');
        if (refreshBtn) refreshBtn.classList.remove('hidden');

        document.getElementById('player-more-options-menu')?.classList.add('hidden');
        setPipModalActive(false);
        closeModal(UIElements.videoModal);
    } finally {
        setTimeout(() => {
            isStoppingPlayer = false;
        }, 150);
    }
};

/**
 * Updates the stream info overlay with the latest stats from mpegts.js.
 * mpegts.js reports speed in KB/s so divide by 1024 for MB/s.
 */
function updateStreamInfo() {
    if (!appState.player || !appState.player.statisticsInfo) return;

    const stats = appState.player.statisticsInfo;
    const video = UIElements.videoElement;

    const resolution = (video.videoWidth && video.videoHeight) ? `${video.videoWidth}x${video.videoHeight}` : 'N/A';
    const speed = `${(stats.speed / 1024).toFixed(2)} MB/s`;
    const dropped = (stats.droppedFrames >= 0 && typeof stats.droppedFrames === 'number') ? stats.droppedFrames : 'N/A'
    const buffer = video.buffered.length > 0 ? `${(video.buffered.end(0) - video.currentTime).toFixed(2)}s` : '0.00s';
    const mediaInfo = appState.player.mediaInfo;
    const fps = mediaInfo.fps;
    const videoCodec = mediaInfo.videoCodec;
    const audioCodec = mediaInfo.audioCodec;

    UIElements.streamInfoResolution.textContent = `Resolution: ${resolution}`;
    UIElements.streamInfoBandwidth.textContent = `Bandwidth: ${speed}`;
    UIElements.streamInfoFps.textContent = `FPS: ${fps}`;
    UIElements.streamInfoDropped.textContent = `Dropped: ${dropped}`;
    UIElements.streamInfoBuffer.textContent = `Buffer: ${buffer}`;
    UIElements.streamInfoVideo.textContent = `V Codec: ${getCodecName(videoCodec)}`;
    UIElements.streamInfoAudio.textContent = `A Codec: ${getCodecName(audioCodec)}`;
}


/**
 * Initializes and starts playing a channel stream, either locally or on a Cast device.
 * @param {string} url - The URL of the channel stream.
 * @param {string} name - The name of the channel to display.
 * @param {string} channelId - The unique ID of the channel.
 */
export const playChannel = (url, name, channelId) => {
    // Unhide refresh button for live channel streams
    const refreshBtn = document.getElementById('refresh-stream-btn');
    if (refreshBtn) refreshBtn.classList.remove('hidden');

    isUserInitiatedPause = false;
    // Prime / request wake lock immediately inside user click gesture
    requestScreenWakeLock();

    const isAutoRetry = Boolean(retryTimeout);
    // On a fresh play request (not a retry), reset the retry counter
    if (!retryTimeout) {
        retryCount = 0;
    }

    const channel = guideState.channels.find(c => c.id === channelId);
    const logo = channel ? channel.logo : '';

    // Store current channel info for potential retries and overlays
    currentChannelInfo = { url, name, channelId, logo };
    sendTelemetry('PLAYER_PLAY_CHANNEL', `playChannel initiated for "${name}" (${channelId})`, {
        url,
        profileId: guideState.settings.activeStreamProfileId
    });

    // Update and save recent channels regardless of playback target
    if (channelId) {
        const recentChannels = [channelId, ...(guideState.settings.recentChannels || []).filter(id => id !== channelId)].slice(0, 15);
        guideState.settings.recentChannels = recentChannels;
        saveUserSetting('recentChannels', recentChannels);
        window.dispatchEvent(new CustomEvent('viniplay:recents-updated'));
    }

    const profileId = guideState.settings.activeStreamProfileId;
    const userAgentId = guideState.settings.activeUserAgentId;
    if (!profileId || !userAgentId) {
        showNotification("Active stream profile or user agent not set. Please check settings.", true);
        return;
    }
    const profile = (guideState.settings.streamProfiles || []).find(p => p.id === profileId);
    if (!profile) {
        return showNotification("Stream profile not found.", true);
    }

    const streamUrlToPlay = profile.command === 'redirect' ? url : `/stream?url=${encodeURIComponent(url)}&profileId=${profileId}&userAgentId=${userAgentId}&mediaType=live`;
    currentStreamUrlToPlay = streamUrlToPlay;
    if (isAudioOnly) {
        toggleAudioOnly(false, { restoreVideo: false });
    }

    // --- Activity Logging for Redirect Streams ---
    if (profile.command === 'redirect') {
        const channel = guideState.channels.find(c => c.id === channelId);
        beginRedirectLogging(url, channelId, name, channel ? channel.logo : '', 'live');
    }
    // --- End Activity Logging ---

    if (castState.isCasting) {
        console.log(`[PLAYER] Already casting. Loading new channel "${name}" to remote device.`);
        // CRITICAL FIX: Chromecast needs absolute URLs, not relative
        const absoluteStreamUrl = streamUrlToPlay.startsWith('http')
            ? streamUrlToPlay
            : `${window.location.origin}${streamUrlToPlay}`;
        loadMedia(absoluteStreamUrl, name, logo);
        openModal(UIElements.videoModal);
        return;
    }

    // --- Local Playback Logic ---
    currentLocalStreamUrl = url;
    currentProfileId = profileId; // Store the profile ID
    console.log(`[PLAYER] Playing channel "${name}" locally. Tracking URL for cleanup: ${currentLocalStreamUrl}, Profile: ${currentProfileId}`);

    setLocalPlayerState(streamUrlToPlay, name, logo, url, profileId);

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

        if (document.pictureInPictureElement) {
            if (!isAutoRetry) {
                document.exitPictureInPicture().catch(() => {});
                setPipModalActive(false);
                openModal(UIElements.videoModal);
            } else {
                const bannerTitle = document.getElementById('pip-active-banner-title');
                if (bannerTitle) bannerTitle.textContent = name;
            }
        } else {
            setPipModalActive(false);
            openModal(UIElements.videoModal);
        }
        UIElements.videoTitle.textContent = name;
        updateMediaSession(name, logo);
        requestScreenWakeLock();
        appState.player.attachMediaElement(UIElements.videoElement);
        appState.player.load();

        // NEW: Enforce aspect ratio when metadata is loaded to ensure controls are visible (desktop only)
        UIElements.videoElement.addEventListener('loadedmetadata', () => {
            if (window.innerWidth >= 768 && isAspectRatioLocked && UIElements.videoElement.videoWidth) {
                const videoRatio = UIElements.videoElement.videoWidth / UIElements.videoElement.videoHeight;
                const currentWidth = UIElements.videoModalContainer.offsetWidth;

                // Calculate header height
                const header = UIElements.videoModalContainer.querySelector('.flex.justify-between');
                const headerHeight = header ? header.offsetHeight : 0;

                const targetHeight = (currentWidth / videoRatio) + headerHeight;
                UIElements.videoModalContainer.style.height = `${targetHeight}px`;
            }
        }, { once: true });

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
 * Plays a local video or recording file using the unified video modal and native HTML5 video player.
 * Supports Picture-in-Picture, Audio-Only mode, Touch Lock, Aspect-Ratio locking, and Container Fullscreen.
 * @param {string} url - The video URL or file path (e.g. /dvr/file.mp4).
 * @param {string} title - The display title for the video.
 * @param {string} [logo] - Optional logo URL.
 * @param {boolean} [isVod=false] - Whether the video is a VOD item.
 * @param {number} [startTime=0] - Starting timestamp offset in seconds for resuming playback.
 * @param {object|null} [mediaInfo=null] - Media tracking metadata { contentType, contentId, title, duration }.
 */
export const playRecordingOrDirectVideo = async (url, title, logo = '', isVod = false, startTime = 0, mediaInfo = null) => {
    console.log(`[PLAYER] Playing direct/recording video: "${title}" from ${url} (isVod: ${isVod}, startTime: ${startTime})`);

    // 1. Cleanly stop any existing active stream
    await stopAndCleanupPlayer();
    isUserInitiatedPause = false;
    currentStreamUrlToPlay = url;
    if (isAudioOnly) {
        toggleAudioOnly(false, { restoreVideo: false });
    }

    // 2. Setup title, channel info, and media session
    if (UIElements.videoTitle) {
        UIElements.videoTitle.textContent = title;
    }
    currentChannelInfo = { url, name: title, channelId: null, logo };
    updateMediaSession(title, logo || '/viniplay.png');

    // 3. Hide live-only buttons (like refresh-stream-btn)
    const refreshBtn = document.getElementById('refresh-stream-btn');
    if (refreshBtn) refreshBtn.classList.add('hidden');

    // 4. Activity logging for Direct VOD and DVR sessions
    if (isVod) {
        const vodItem = (guideState.vodMovies || []).find(m => m.url === url) || (guideState.vodSeries || []).find(s => s.url === url);
        const vodId = vodItem ? vodItem.id : (mediaInfo?.contentId || null);
        const vodType = (mediaInfo?.contentType === 'vod_episode' || vodItem?.type === 'series' || /S\d{1,2}\s*E\d{1,3}/i.test(title)) ? 'series' : 'movie';
        beginRedirectLogging(url, vodId, title, logo, vodType);
    } else if (url.startsWith('/dvr/') || mediaInfo?.contentType === 'dvr_recording') {
        beginRedirectLogging(url, mediaInfo?.contentId || null, title, logo, 'dvr');
    }

    // 5. Watch Progress Tracking
    if (mediaInfo) {
        setActiveMediaTracking(mediaInfo);
    } else if (isVod) {
        const vodItem = (guideState.vodMovies || []).find(m => m.url === url) || (guideState.vodSeries || []).find(s => s.url === url);
        if (vodItem) {
            setActiveMediaTracking({
                contentType: vodItem.type === 'series' ? 'vod_episode' : 'vod_movie',
                contentId: vodItem.id,
                title: title,
                duration: vodItem.duration || 0
            });
        }
    }
    updateMediaSession(title, logo || '/viniplay.png');

    // 6. Configure video element
    if (UIElements.videoElement) {
        UIElements.videoElement.src = url;
        UIElements.videoElement.load();
        UIElements.videoElement.volume = parseFloat(localStorage.getItem('iptvPlayerVolume') || 0.5);

        if (startTime > 0) {
            const applyStartTime = () => {
                try {
                    if (UIElements.videoElement) {
                        UIElements.videoElement.currentTime = startTime;
                        console.log(`[PLAYER] Direct video seeked to start time: ${startTime}s`);
                    }
                } catch (e) {
                    console.warn('[PLAYER] Error seeking direct video to startTime:', e);
                }
            };
            if (UIElements.videoElement.readyState >= 1) {
                applyStartTime();
            } else {
                UIElements.videoElement.addEventListener('loadedmetadata', applyStartTime, { once: true });
            }
        }
    }

    // 7. Open unified video modal
    if (document.pictureInPictureElement) {
        document.exitPictureInPicture().catch(() => {});
    }
    setPipModalActive(false);
    openModal(UIElements.videoModal);
    requestScreenWakeLock();

    try {
        await UIElements.videoElement.play();
        console.log(`[PLAYER] Direct playback started successfully for: "${title}"`);
    } catch (err) {
        console.warn("[PLAYER] Autoplay prevented or playback error:", err);
    }
};

// State tracking for transcoded VOD seeking via -ss on /stream
let currentVodTranscodeSession = null;
let vodTimeUpdateInterval = null;
let vodHideControlsTimeout = null;
let isVodSeeking = false;
let pendingSeekTarget = null;
let seekDebounceTimeout = null;

function formatTimeSeconds(seconds) {
    const s = Math.max(0, Math.floor(seconds));
    const hrs = Math.floor(s / 3600);
    const mins = Math.floor((s % 3600) / 60);
    const secs = s % 60;
    if (hrs > 0) {
        return `${hrs}:${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
    }
    return `${mins}:${secs.toString().padStart(2, '0')}`;
}

export function seekVodRelative(delta) {
    if (!currentVodTranscodeSession) return;
    const curElapsed = UIElements.videoElement?.currentTime || 0;
    const baseTime = pendingSeekTarget !== null 
        ? pendingSeekTarget 
        : (currentVodTranscodeSession.currentSeekTime + curElapsed);
    
    const maxTime = currentVodTranscodeSession.duration || 86400;
    pendingSeekTarget = Math.max(0, Math.min(maxTime, baseTime + delta));
    
    const currentTimeEl = document.getElementById('vod-current-time');
    const progressBar = document.getElementById('vod-progress-bar');
    if (currentTimeEl) currentTimeEl.textContent = formatTimeSeconds(pendingSeekTarget);
    if (progressBar) progressBar.value = pendingSeekTarget;

    showNotification(`Seeking to ${formatTimeSeconds(pendingSeekTarget)}...`, false, 1200);

    if (seekDebounceTimeout) clearTimeout(seekDebounceTimeout);
    seekDebounceTimeout = setTimeout(() => {
        const target = pendingSeekTarget;
        pendingSeekTarget = null;
        performVodSeek(target);
    }, 350);
}

export function performVodSeek(targetTime) {
    if (!currentVodTranscodeSession) return;
    const session = currentVodTranscodeSession;
    const safeTarget = Math.max(0, Math.floor(targetTime));
    playVOD(session.url, session.title, session.logo, safeTarget, session.duration);
}

function updateVodControlsUI() {
    const video = UIElements.videoElement;
    if (!video || !currentVodTranscodeSession) return;

    if (isVodSeeking || pendingSeekTarget !== null) return;

    const curElapsed = video.currentTime || 0;
    const curTotalTime = currentVodTranscodeSession.currentSeekTime + curElapsed;

    const currentTimeEl = document.getElementById('vod-current-time');
    const totalTimeEl = document.getElementById('vod-total-time');
    const progressBar = document.getElementById('vod-progress-bar');
    const playPauseBtn = document.getElementById('vod-play-pause-btn');

    if (currentTimeEl) currentTimeEl.textContent = formatTimeSeconds(curTotalTime);
    
    const duration = currentVodTranscodeSession.duration;
    if (duration && duration > 0) {
        if (progressBar) {
            progressBar.max = duration;
            progressBar.value = Math.min(duration, curTotalTime);
        }
        if (totalTimeEl) totalTimeEl.textContent = formatTimeSeconds(duration);
    } else {
        if (progressBar) {
            progressBar.max = Math.max(curTotalTime + 60, parseFloat(progressBar.max) || 100);
            progressBar.value = curTotalTime;
        }
        if (totalTimeEl) totalTimeEl.textContent = '--:--';
    }

    if (playPauseBtn) {
        playPauseBtn.innerHTML = video.paused ? ICONS.play : ICONS.pause;
    }
}

function setupVodControlsOverlay(profileName) {
    const overlay = document.getElementById('vod-controls-overlay');
    if (!overlay) return;

    overlay.classList.remove('hidden');
    overlay.style.opacity = '1';

    const progressBar = document.getElementById('vod-progress-bar');
    const currentTimeEl = document.getElementById('vod-current-time');
    const totalTimeEl = document.getElementById('vod-total-time');
    const playPauseBtn = document.getElementById('vod-play-pause-btn');
    const rewind60Btn = document.getElementById('vod-rewind-60-btn');
    const rewind15Btn = document.getElementById('vod-rewind-15-btn');
    const forward15Btn = document.getElementById('vod-forward-15-btn');
    const forward60Btn = document.getElementById('vod-forward-60-btn');
    const volumeBtn = document.getElementById('vod-volume-btn');
    const volumeBar = document.getElementById('vod-volume-bar');
    const fullscreenBtn = document.getElementById('vod-fullscreen-btn');
    const profileBadge = document.getElementById('vod-profile-badge');

    if (profileBadge) profileBadge.textContent = profileName || 'Transcoding';

    const initialSeek = currentVodTranscodeSession?.currentSeekTime || 0;
    const initialDur = currentVodTranscodeSession?.duration || 0;

    if (currentTimeEl) currentTimeEl.textContent = formatTimeSeconds(initialSeek);
    if (totalTimeEl) totalTimeEl.textContent = initialDur > 0 ? formatTimeSeconds(initialDur) : '--:--';
    if (progressBar) {
        progressBar.min = 0;
        progressBar.max = initialDur > 0 ? initialDur : Math.max(100, initialSeek + 60);
        progressBar.value = initialSeek;
    }

    if (playPauseBtn) {
        playPauseBtn.innerHTML = ICONS.pause;
        playPauseBtn.onclick = () => {
            if (UIElements.videoElement) {
                if (UIElements.videoElement.paused) UIElements.videoElement.play();
                else UIElements.videoElement.pause();
                playPauseBtn.innerHTML = UIElements.videoElement.paused ? ICONS.play : ICONS.pause;
            }
        };
    }

    if (rewind60Btn) rewind60Btn.onclick = () => seekVodRelative(-60);
    if (rewind15Btn) rewind15Btn.onclick = () => seekVodRelative(-15);
    if (forward15Btn) forward15Btn.onclick = () => seekVodRelative(15);
    if (forward60Btn) forward60Btn.onclick = () => seekVodRelative(60);

    if (progressBar) {
        progressBar.oninput = (e) => {
            isVodSeeking = true;
            if (currentTimeEl) currentTimeEl.textContent = formatTimeSeconds(parseFloat(e.target.value));
        };
        progressBar.onchange = (e) => {
            isVodSeeking = false;
            const targetSec = parseFloat(e.target.value);
            performVodSeek(targetSec);
        };
    }

    if (volumeBar && UIElements.videoElement) {
        volumeBar.value = UIElements.videoElement.volume;
        volumeBar.oninput = (e) => {
            const val = parseFloat(e.target.value);
            UIElements.videoElement.volume = val;
            UIElements.videoElement.muted = val === 0;
            localStorage.setItem('iptvPlayerVolume', val);
        };
    }

    if (volumeBtn && UIElements.videoElement) {
        volumeBtn.onclick = () => {
            UIElements.videoElement.muted = !UIElements.videoElement.muted;
            if (volumeBar) {
                volumeBar.value = UIElements.videoElement.muted ? 0 : UIElements.videoElement.volume;
            }
        };
    }

    if (fullscreenBtn) {
        fullscreenBtn.onclick = () => {
            const fsBtn = document.getElementById('player-fullscreen-btn');
            if (fsBtn) fsBtn.click();
        };
    }

    // Auto-hide controls overlay during active playback
    const container = UIElements.videoModalContainer || document.getElementById('video-modal-container');
    const showControls = () => {
        if (overlay) overlay.style.opacity = '1';
        if (vodHideControlsTimeout) clearTimeout(vodHideControlsTimeout);
        vodHideControlsTimeout = setTimeout(() => {
            const video = UIElements.videoElement;
            if (video && !video.paused && !isVodSeeking && pendingSeekTarget === null) {
                if (overlay) overlay.style.opacity = '0';
            }
        }, 3500);
    };

    if (container) {
        container.onmousemove = showControls;
        container.ontouchstart = showControls;
    }
    showControls();

    // Start interval
    if (vodTimeUpdateInterval) clearInterval(vodTimeUpdateInterval);
    vodTimeUpdateInterval = setInterval(updateVodControlsUI, 500);
}

/**
 * Plays a VOD (Movie or Episode) using either the native <video> element (Direct Play)
 * or the server's /stream endpoint with fast input seeking (-ss).
 * @param {string} url - The direct URL to the VOD file (e.g., .mp4, .mkv).
 * @param {string} title - The title of the VOD to display.
 * @param {string} [logo] - Channel / poster logo URL.
 * @param {number} [startTime=0] - Starting timestamp offset in seconds for seeking.
 * @param {number|null} [knownDuration=null] - Preserved total duration in seconds.
 * @param {object|null} [mediaInfo=null] - Media tracking metadata { contentType, contentId, title, duration }.
 */
export const playVOD = async (url, title, logo = '', startTime = 0, knownDuration = null, mediaInfo = null) => {
    const useDirectPlay = guideState.settings.vodDirectPlayEnabled === true;
    console.log(`[VOD_PLAYER] Attempting to play VOD: "${title}" | Direct Play: ${useDirectPlay} | StartTime: ${startTime}`);

    const preservedDuration = knownDuration !== null ? knownDuration : (currentVodTranscodeSession?.url === url ? currentVodTranscodeSession?.duration : (mediaInfo?.duration || null));

    // 1. Stop any existing player (live or VOD), regardless of play method chosen
    await stopAndCleanupPlayer();
    await new Promise(r => setTimeout(r, 50)); // Short micro-yield to allow browser MSE decoder to flush

    // 2. Get necessary settings
    const settings = guideState.settings;
    let profileId = settings.activeStreamProfileId;
    const userAgentId = settings.activeUserAgentId;
    let profile = (settings.streamProfiles || []).find(p => p.id === profileId);

    // Hide VOD controls overlay if not transcoding
    const vodOverlay = document.getElementById('vod-controls-overlay');

    // --- DIRECT PLAY / REDIRECT LOGIC ---
    // If Direct Play is enabled OR the selected profile is 'redirect', use the native <video> element.
    // Also fallback to this if the selected profile cannot be found.
    if (useDirectPlay || !profile || profile.command === 'redirect') {
        currentVodTranscodeSession = null;
        if (vodOverlay) {
            vodOverlay.classList.add('hidden');
            vodOverlay.style.opacity = '0';
        }
        await playRecordingOrDirectVideo(url, title, logo, true, startTime, mediaInfo);
        return;
    }

    // --- PROFILE / TRANSCODED PLAY Logic via /stream endpoint ---
    console.log(`[VOD_PLAYER] Using FFmpeg transcode profile: ${profile.name} (ID=${profileId}) via /stream endpoint.`);
    logToPlayerConsole(`Attempting VOD playback via Profile: ${title} (${profile.name})`);

    // Store session info so user can seek/skip in transcoded mode
    currentVodTranscodeSession = {
        url,
        title,
        logo,
        profileId,
        userAgentId,
        currentSeekTime: startTime || 0,
        duration: preservedDuration
    };

    const vodMediaType = (mediaInfo?.contentType === 'vod_episode' || /S\d{1,2}\s*E\d{1,3}/i.test(title)) ? 'series' : 'movie';
    let streamUrlToPlay = `/stream?url=${encodeURIComponent(url)}&profileId=${profileId}&userAgentId=${userAgentId}&vodName=${encodeURIComponent(title)}&vodLogo=${encodeURIComponent(logo)}&mediaType=${vodMediaType}`;
    if (startTime > 0) {
        streamUrlToPlay += `&startTime=${Math.floor(startTime)}`;
    }

    isUserInitiatedPause = false;
    currentStreamUrlToPlay = streamUrlToPlay;
    currentLocalStreamUrl = url;
    currentProfileId = profileId;

    if (isAudioOnly) {
        toggleAudioOnly(false, { restoreVideo: false });
    }

    console.log(`[VOD_PLAYER] Final stream URL: ${streamUrlToPlay}`);
    logToPlayerConsole(`Final stream URL: ${streamUrlToPlay}`);

    // If profile outputs MP4 container (fMP4), play directly via native video element
    if (profile.command && profile.command.includes('-f mp4')) {
        console.log(`[VOD_PLAYER] Profile uses fMP4. Playing via native video element: ${streamUrlToPlay}`);
        await playRecordingOrDirectVideo(streamUrlToPlay, title, logo, false, 0, mediaInfo);
        return;
    }

    // Profile outputs MPEG-TS: use mpegts.js
    if (mpegts.isSupported()) {
        const mpegtsConfig = {
            enableStashBuffer: true,
            stashInitialSize: 4096,
            liveSync: false, // For VOD, do not drop frames to chase live edge!
            lazyLoad: false,
        };
        logToPlayerConsole(`mpegts.js config: enableStashBuffer=${mpegtsConfig.enableStashBuffer}, stashInitialSize=${mpegtsConfig.stashInitialSize}KB`);

        try {
            appState.player = mpegts.createPlayer({
                type: 'mse',
                isLive: true,
                url: streamUrlToPlay
            }, mpegtsConfig);

            // Track watch progress for mpegts stream
            if (mediaInfo) {
                setActiveMediaTracking(mediaInfo);
            }

            // Setup error handling
            appState.player.on(mpegts.Events.ERROR, (errorType, errorDetail) => {
                const errorMsg = `Player Error: ${errorType} - ${errorDetail}`;
                console.error(`[VOD_PLAYER] MPEGTS Player Error: ${errorMsg}`);
                logToPlayerConsole(errorMsg, true);
                showNotification(errorMsg, true);
                stopAndCleanupPlayer();
            });

            appState.player.on(mpegts.Events.MEDIA_INFO, () => {
                console.log('[VOD_PLAYER] Media info received, playback starting.');
                logToPlayerConsole('Playback started.');
            });

            // Open modal and set title
            if (document.pictureInPictureElement) {
                document.exitPictureInPicture().catch(() => {});
            }
            setPipModalActive(false);
            openModal(UIElements.videoModal);
            UIElements.videoTitle.textContent = title;
            currentChannelInfo = { url, name: title, channelId: null, logo };
            updateMediaSession(title, logo);
            requestScreenWakeLock();

            // Hide native controls so our VOD overlay takes over without "LIVE" scrubber locking
            if (UIElements.videoElement) {
                UIElements.videoElement.controls = false;
            }

            // Setup and display VOD controls overlay
            setupVodControlsOverlay(profile.name);

            // Fetch duration in background if not known
            if (!currentVodTranscodeSession.duration) {
                fetch('/api/vod/duration', {
                    method: 'POST',
                    headers: withCsrfHeaders({ 'Content-Type': 'application/json' }),
                    body: JSON.stringify({ url })
                })
                    .then(res => res.ok ? res.json() : null)
                    .then(data => {
                        if (data && data.duration && currentVodTranscodeSession && currentVodTranscodeSession.url === url) {
                            currentVodTranscodeSession.duration = data.duration;
                            if (currentActiveMedia) currentActiveMedia.duration = data.duration;
                            const totalTimeEl = document.getElementById('vod-total-time');
                            const progressBar = document.getElementById('vod-progress-bar');
                            if (totalTimeEl) totalTimeEl.textContent = formatTimeSeconds(data.duration);
                            if (progressBar) progressBar.max = data.duration;
                            console.log(`[VOD_PLAYER] Probed duration for "${title}": ${data.duration}s`);
                        }
                    })
                    .catch(e => console.warn('[VOD_PLAYER] Could not fetch duration:', e));
            }

            // Attach and play
            appState.player.attachMediaElement(UIElements.videoElement);
            appState.player.load();

            // Set volume from storage
            UIElements.videoElement.volume = parseFloat(localStorage.getItem('iptvPlayerVolume') || 0.5);

            try {
                const playPromise = appState.player.play();
                if (playPromise !== undefined) {
                    await playPromise;
                }
            } catch (playErr) {
                if (playErr.name !== 'AbortError') {
                    console.warn('[VOD_PLAYER] play() interrupted:', playErr);
                }
            }

            console.log(`[VOD_PLAYER] Transcoded playback started for: "${title}"`);
            setLocalPlayerState(streamUrlToPlay, title, null);

            // Start stream info interval if needed
            if (streamInfoInterval) clearInterval(streamInfoInterval);
            streamInfoInterval = setInterval(updateStreamInfo, 2000);

        } catch (err) {
            const errorMsg = `Failed to initialize mpegts.js player: ${err.message}`;
            console.error("[VOD_PLAYER] Error initializing mpegts.js player:", err);
            logToPlayerConsole(errorMsg, true);
            showNotification(errorMsg, true);
            await stopAndCleanupPlayer();
        }

    } else {
        const errorMsg = 'Your browser does not support Media Source Extensions (MSE), required for playback via profiles.';
        showNotification(errorMsg, true);
        logToPlayerConsole(errorMsg, true);
        console.error("[VOD_PLAYER] MSE not supported.");
    }
};

/**
 * Detects and populates available audio tracks in the menu.
 */
function updateAudioTrackList() {
    const video = UIElements.videoElement;
    const audioTracks = video.audioTracks;
    const listEl = document.getElementById('audio-track-list');
    const btnEl = document.getElementById('audio-track-btn');

    console.log('[AUDIO_TRACKS] Checking for audio tracks...');
    console.log('[AUDIO_TRACKS] audioTracks object:', audioTracks);
    console.log('[AUDIO_TRACKS] Number of tracks:', audioTracks ? audioTracks.length : 0);

    if (!audioTracks || audioTracks.length <= 1) {
        // Hide button if no multiple tracks
        console.log('[AUDIO_TRACKS] Not enough tracks, hiding button');
        btnEl?.classList.add('hidden');
        return;
    }

    console.log('[AUDIO_TRACKS] Multiple tracks found! Showing button and populating menu');
    btnEl?.classList.remove('hidden');
    if (!listEl) return;

    listEl.innerHTML = '';

    for (let i = 0; i < audioTracks.length; i++) {
        const track = audioTracks[i];
        console.log(`[AUDIO_TRACKS] Track ${i}:`, { label: track.label, language: track.language, enabled: track.enabled });
        const item = document.createElement('div');
        item.className = `px-4 py-2 cursor-pointer hover:bg-gray-700 transition-colors ${track.enabled ? 'bg-blue-600 font-semibold' : ''}`;
        item.textContent = track.label || track.language || `Track ${i + 1}`;
        item.onclick = () => selectAudioTrack(i);
        listEl.appendChild(item);
    }
}

/**
 * Selects an audio track by index.
 */
function selectAudioTrack(index) {
    const audioTracks = UIElements.videoElement.audioTracks;
    if (!audioTracks) return;

    for (let i = 0; i < audioTracks.length; i++) {
        audioTracks[i].enabled = (i === index);
    }
    updateAudioTrackList();
    document.getElementById('audio-track-menu')?.classList.add('hidden');
    showNotification(`Audio track switched`, false, 1500);
}

/**
 * Detects and populates available subtitle tracks in the menu.
 */
function updateSubtitleTrackList() {
    const video = UIElements.videoElement;
    const textTracks = video.textTracks;
    const listEl = document.getElementById('subtitle-track-list');
    const btnEl = document.getElementById('subtitle-track-btn');

    console.log('[SUBTITLES] Checking for subtitle tracks...');
    console.log('[SUBTITLES] textTracks object:', textTracks);
    console.log('[SUBTITLES] Number of tracks:', textTracks ? textTracks.length : 0);

    if (!textTracks || textTracks.length === 0) {
        console.log('[SUBTITLES] No subtitle tracks found, hiding button');
        btnEl?.classList.add('hidden');
        return;
    }

    console.log('[SUBTITLES] Subtitle tracks found! Showing button and populating menu');
    btnEl?.classList.remove('hidden');
    if (!listEl) return;

    listEl.innerHTML = '';

    // Add "Off" option
    const offItem = document.createElement('div');
    const anyShowing = Array.from(textTracks).some(t => t.mode === 'showing');
    offItem.className = `px-4 py-2 cursor-pointer hover:bg-gray-700 transition-colors ${!anyShowing ? 'bg-blue-600 font-semibold' : ''}`;
    offItem.textContent = 'Off';
    offItem.onclick = () => selectSubtitleTrack(-1);
    listEl.appendChild(offItem);

    // Add each track
    for (let i = 0; i < textTracks.length; i++) {
        const track = textTracks[i];
        console.log(`[SUBTITLES] Track ${i}:`, { label: track.label, language: track.language, kind: track.kind, mode: track.mode });
        const item = document.createElement('div');
        item.className = `px-4 py-2 cursor-pointer hover:bg-gray-700 transition-colors ${track.mode === 'showing' ? 'bg-blue-600 font-semibold' : ''}`;
        item.textContent = track.label || track.language || `Subtitle ${i + 1}`;
        item.onclick = () => selectSubtitleTrack(i);
        listEl.appendChild(item);
    }
}

/**
 * Selects a subtitle track by index (-1 for off).
 */
function selectSubtitleTrack(index) {
    const textTracks = UIElements.videoElement.textTracks;
    if (!textTracks) return;

    for (let i = 0; i < textTracks.length; i++) {
        textTracks[i].mode = (i === index) ? 'showing' : 'hidden';
    }
    updateSubtitleTrackList();
    document.getElementById('subtitle-track-menu')?.classList.add('hidden');
    showNotification(index === -1 ? 'Subtitles off' : 'Subtitle track switched', false, 1500);
}

/**
 * Sets up event listeners for the video player.
 */
export function setupPlayerEventListeners() {
    bindTap(UIElements.closeModal, stopAndCleanupPlayer);

    // Auto Picture-in-Picture on mobile swipe-up / tab switch
    if (UIElements.videoElement) {
        try {
            UIElements.videoElement.autoPictureInPicture = true;
        } catch (e) {}
    }

    // NEW: Add event listener for the refresh button
    const refreshBtn = document.getElementById('refresh-stream-btn');
    if (refreshBtn) {
        bindTap(refreshBtn, forceRefreshStream);
    }

    bindTap(UIElements.pipBtn, async () => {
        if (document.pictureInPictureElement) {
            document.exitPictureInPicture().catch(console.error);
            return;
        }
        const wasAudioOnly = isAudioOnly;
        if (wasAudioOnly) {
            toggleAudioOnly(false);
        }
        if (document.pictureInPictureEnabled && UIElements.videoElement) {
            // Exit HTML5 Container/Element Fullscreen first so macOS Chrome never attaches
            // the PiP NSWindow to a disappearing temporary Fullscreen Space.
            if (document.fullscreenElement || document.webkitFullscreenElement) {
                try {
                    if (document.exitFullscreen) {
                        await document.exitFullscreen();
                    } else if (document.webkitExitFullscreen) {
                        await document.webkitExitFullscreen();
                    }
                    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
                } catch (err) {
                    console.warn('[PLAYER] Failed to exit fullscreen before PiP:', err);
                }
            }

            if (UIElements.videoElement.readyState >= 1 || !UIElements.videoElement.paused) {
                requestScreenWakeLock();
                UIElements.videoElement.requestPictureInPicture().catch(() => showNotification("Could not enter Picture-in-Picture.", true));
            } else if (wasAudioOnly && (UIElements.videoElement.getAttribute('src') || currentStreamUrlToPlay)) {
                UIElements.videoElement.addEventListener('loadedmetadata', () => {
                    requestScreenWakeLock();
                    UIElements.videoElement.requestPictureInPicture().catch(() => showNotification("Could not enter Picture-in-Picture.", true));
                }, { once: true });
            }
        }
    });

    // Desktop / Browser PiP Recovery Mini-Bar Buttons
    const pipBannerRestoreBtn = document.getElementById('pip-banner-restore-btn');
    if (pipBannerRestoreBtn) {
        bindTap(pipBannerRestoreBtn, async () => {
            if (document.pictureInPictureElement) {
                try {
                    await document.exitPictureInPicture();
                    return;
                } catch (err) {
                    console.warn('[PLAYER] exitPictureInPicture failed, restoring modal directly:', err);
                }
            }
            setPipModalActive(false);
            openModal(UIElements.videoModal);
            if (UIElements.videoElement && UIElements.videoElement.paused && !isUserInitiatedPause) {
                UIElements.videoElement.play().catch(() => {});
            }
        });
    }

    const pipBannerStopBtn = document.getElementById('pip-banner-stop-btn');
    if (pipBannerStopBtn) {
        bindTap(pipBannerStopBtn, () => {
            stopAndCleanupPlayer();
        });
    }

    // More Options Dropdown Toggle & Outside Click
    const moreOptionsBtn = document.getElementById('player-more-options-btn');
    const moreOptionsMenu = document.getElementById('player-more-options-menu');
    if (moreOptionsBtn && moreOptionsMenu) {
        bindTap(moreOptionsBtn, (e) => {
            if (e && e.stopPropagation) e.stopPropagation();
            moreOptionsMenu.classList.toggle('hidden');
        });

        // Close on outside click
        document.addEventListener('click', (e) => {
            if (!moreOptionsBtn.contains(e.target) && !moreOptionsMenu.contains(e.target)) {
                moreOptionsMenu.classList.add('hidden');
            }
        });

        // Close on Escape key or seek transcoded VOD on ArrowLeft/Right
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape' && !moreOptionsMenu.classList.contains('hidden')) {
                moreOptionsMenu.classList.add('hidden');
                return;
            }

            // Keyboard seeking for transcoded VOD streams via -ss
            if (currentVodTranscodeSession && UIElements.videoModal && !UIElements.videoModal.classList.contains('hidden')) {
                // Ignore if typing in an input (except if it's the vod-progress-bar)
                if (['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement?.tagName) && document.activeElement?.id !== 'vod-progress-bar') return;

                if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
                    e.preventDefault();
                    const delta = (e.shiftKey ? 60 : 15) * (e.key === 'ArrowRight' ? 1 : -1);
                    seekVodRelative(delta);
                } else if (e.key === ' ' || e.code === 'Space') {
                    e.preventDefault();
                    if (UIElements.videoElement) {
                        if (UIElements.videoElement.paused) UIElements.videoElement.play();
                        else UIElements.videoElement.pause();
                    }
                }
            }
        });
    }

    bindTap(UIElements.streamInfoToggleBtn, () => {
        UIElements.streamInfoOverlay.classList.toggle('hidden');
        document.getElementById('player-more-options-menu')?.classList.add('hidden');
    });

    // NEW: Aspect Ratio Lock Toggle
    const aspectRatioLockBtn = document.getElementById('aspect-ratio-lock-btn');
    if (aspectRatioLockBtn) {
        bindTap(aspectRatioLockBtn, toggleAspectRatioLock);
        // Initialize button state
        updateAspectRatioLockButton();
    }

    if (UIElements.castBtn) {
        bindTap(UIElements.castBtn, () => {
            document.getElementById('player-more-options-menu')?.classList.add('hidden');
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

    // NEW: Audio-Only toggle
    const audioOnlyBtn = document.getElementById('audio-only-btn') || UIElements.audioOnlyBtn;
    if (audioOnlyBtn) {
        bindTap(audioOnlyBtn, () => toggleAudioOnly());
    }
    const resumeVideoBtn = document.getElementById('resume-video-btn') || UIElements.resumeVideoBtn;
    if (resumeVideoBtn) {
        bindTap(resumeVideoBtn, () => toggleAudioOnly(false));
    }

    // NEW: Touch-Lock toggle
    const playerLockBtn = document.getElementById('player-lock-btn') || UIElements.playerLockBtn;
    if (playerLockBtn) {
        bindTap(playerLockBtn, () => togglePlayerLock());
    }
    const playerUnlockBtn = document.getElementById('player-unlock-btn') || UIElements.playerUnlockBtn;
    if (playerUnlockBtn) {
        bindTap(playerUnlockBtn, () => togglePlayerLock(false));
    }

    // NEW: Container Fullscreen toggle
    const playerFullscreenBtn = document.getElementById('player-fullscreen-btn') || UIElements.playerFullscreenBtn;
    if (playerFullscreenBtn) {
        bindTap(playerFullscreenBtn, toggleContainerFullscreen);
    }
    document.addEventListener('fullscreenchange', updateFullscreenButtonState);
    document.addEventListener('webkitfullscreenchange', updateFullscreenButtonState);

    // Screen Wake Lock & Background Playback listeners
    UIElements.videoElement.addEventListener('play', () => {
        isUserInitiatedPause = false;
        acquireTabDiscardLock();
        if (noSleepVideo && !noSleepVideo.paused) {
            try { noSleepVideo.pause(); } catch (e) {}
        }
        if (!isAudioOnly && document.visibilityState === 'visible') {
            requestScreenWakeLock();
        }
        if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'playing';
    });
    UIElements.videoElement.addEventListener('playing', () => {
        isUserInitiatedPause = false;
        acquireTabDiscardLock();
        if (noSleepVideo && !noSleepVideo.paused) {
            try { noSleepVideo.pause(); } catch (e) {}
        }
        if (!isAudioOnly && document.visibilityState === 'visible') {
            requestScreenWakeLock();
        }
        if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'playing';
        sendTelemetry('MEDIA_PLAYING', 'Video element entered playing state', {
            currentTime: UIElements.videoElement?.currentTime,
            visibilityState: document.visibilityState
        });
    });
    UIElements.videoElement.addEventListener('pause', () => {
        // When progressive VOD/DVR audio has been handed off to #audioElement, ignore detached <videoElement> pause
        if (directAudioHandoff) {
            return;
        }

        saveCurrentWatchProgress(true);

        if (!document.pictureInPictureElement) {
            releaseScreenWakeLock();
        }
        if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'paused';
        sendTelemetry('MEDIA_PAUSE', `Video element paused event (visibility: ${document.visibilityState})`, {
            currentTime: UIElements.videoElement?.currentTime,
            visibilityState: document.visibilityState,
            isUserInitiatedPause,
            pipActive: !!document.pictureInPictureElement
        });

        // Ignore internal OS pause event fired when leaving/docking Picture-in-Picture or during background Audio-Only
        const explicitlyPaused = isUserInitiatedPause || (typeof window !== 'undefined' && window.__viniExplicitlyPausedByUser);
        const suppressAudioOnlyPause = (isAudioOnly && !explicitlyPaused) ||
            isTransitioningAudioOnly ||
            (typeof window !== 'undefined' && window.__viniSuppressPauseUntil > Date.now());
        if (isTransitioningFromPip || suppressAudioOnlyPause) {
            console.log('[PLAYER] Ignored browser pause event during PiP / Audio-Only transition.');
            if (suppressAudioOnlyPause) {
                const resumeIfNeeded = () => {
                    const nowExplicit = isUserInitiatedPause || (typeof window !== 'undefined' && window.__viniExplicitlyPausedByUser);
                    if (!directAudioHandoff && UIElements.videoElement && UIElements.videoElement.paused && !UIElements.videoElement.ended && !nowExplicit) {
                        UIElements.videoElement.play().catch(() => {});
                    }
                };
                setTimeout(resumeIfNeeded, 40);
                setTimeout(resumeIfNeeded, 200);
            }
            return;
        }

        if (document.visibilityState === 'visible') {
            // User intentionally pressed pause on player controls while viewing
            isUserInitiatedPause = true;
        }
    });
    UIElements.videoElement.addEventListener('ended', () => {
        if (currentActiveMedia) {
            saveWatchProgressApi(currentActiveMedia.contentType, currentActiveMedia.contentId, 0, currentActiveMedia.duration || 0);
            currentActiveMedia = null;
        }
        releaseScreenWakeLock();
        releaseTabDiscardLock();
        if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'none';
    });

    // Dedicated #audioElement listeners for uninterrupted Direct Play VOD/DVR Audio-Only playback
    const dedicatedAudioEl = getAudioElement();
    if (dedicatedAudioEl) {
        dedicatedAudioEl.addEventListener('timeupdate', () => {
            if (directAudioHandoff && dedicatedAudioEl.currentTime > 0) {
                directAudioHandoff.lastKnownTime = dedicatedAudioEl.currentTime;
            }
        });
        dedicatedAudioEl.addEventListener('play', () => {
            if (!directAudioHandoff) return;
            isUserInitiatedPause = false;
            acquireTabDiscardLock();
            if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'playing';
        });
        dedicatedAudioEl.addEventListener('playing', () => {
            if (!directAudioHandoff) return;
            isUserInitiatedPause = false;
            acquireTabDiscardLock();
            if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'playing';
        });
        dedicatedAudioEl.addEventListener('pause', () => {
            if (!directAudioHandoff) return;
            saveCurrentWatchProgress(true);
            if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'paused';
        });
        dedicatedAudioEl.addEventListener('ended', () => {
            if (!directAudioHandoff) return;
            if (currentActiveMedia) {
                saveWatchProgressApi(currentActiveMedia.contentType, currentActiveMedia.contentId, 0, currentActiveMedia.duration || 0);
                currentActiveMedia = null;
            }
            exitDirectAudioHandoff(false);
            releaseScreenWakeLock();
            releaseTabDiscardLock();
            if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'none';
        });
    }

    // Handle tab visibility changes: restore video playback when returning to foreground if not paused by user
    document.addEventListener('visibilitychange', () => {
        const audioEl = getAudioElement();
        if (directAudioHandoff && audioEl) {
            if (document.visibilityState === 'visible' && audioEl.paused && !audioEl.ended && !isUserInitiatedPause) {
                audioEl.play().catch(() => {});
            }
            return;
        }

        const hasActiveStream = !!(appState.player || appState.hlsPlayer || currentLocalStreamUrl || (UIElements.videoElement && (UIElements.videoElement.src || UIElements.videoElement.currentSrc)));

        if (document.visibilityState === 'visible') {
            if (hasActiveStream && UIElements.videoElement && UIElements.videoElement.paused && !isUserInitiatedPause) {
                console.log('[PLAYER] Tab returned to foreground. Resuming playback...');
                UIElements.videoElement.play().then(() => {
                    if (!isAudioOnly) requestScreenWakeLock();
                    if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'playing';
                }).catch(err => console.log('[PLAYER] Foreground resume play error:', err));
            } else if (UIElements.videoElement && !UIElements.videoElement.paused && !UIElements.videoElement.ended && !isAudioOnly) {
                requestScreenWakeLock();
            }
        }
    });

    UIElements.videoElement.addEventListener('enterpictureinpicture', (e) => {
        clearPipWindowWatch();
        requestScreenWakeLock();

        // If PiP was triggered via native <video> controls while #video-modal-container was in Fullscreen,
        // exit Fullscreen immediately so #video-modal.pip-active doesn't hold an invisible Fullscreen Space.
        if (document.fullscreenElement || document.webkitFullscreenElement) {
            if (document.exitFullscreen) {
                document.exitFullscreen().catch(() => {});
            } else if (document.webkitExitFullscreen) {
                document.webkitExitFullscreen().catch(() => {});
            }
        }

        const activatePipModalHide = () => {
            requestAnimationFrame(() => {
                if (document.pictureInPictureElement === UIElements.videoElement && !isStoppingPlayer) {
                    // Keep video element active in document so browser does not release wake lock or suspend audio
                    setPipModalActive(true);
                }
            });
        };

        const pipWin = e && e.pictureInPictureWindow;
        if (!pipWin || (pipWin.width > 0 && pipWin.height > 0)) {
            activatePipModalHide();
            return;
        }

        // Wait briefly for OS PiP window dimensions; if it remains 0x0 in foreground (e.g. responsive emulation),
        // exit phantom PiP instead of hiding #video-modal and trapping the user with audio only.
        activePipWindowRef = pipWin;
        activePipResizeHandler = () => {
            if (pipWin.width > 0 && pipWin.height > 0) {
                clearPipWindowWatch();
                activatePipModalHide();
            }
        };
        pipWin.addEventListener('resize', activePipResizeHandler);

        pipWindowCheckTimer = setTimeout(() => {
            const stillZero = (!pipWin.width || !pipWin.height);
            clearPipWindowWatch();
            if (stillZero && document.pictureInPictureElement === UIElements.videoElement && document.visibilityState === 'visible') {
                setPipModalActive(false);
                document.exitPictureInPicture().catch(() => {});
                showNotification("Picture-in-Picture window is unavailable in this view.", true, 2500);
            }
        }, 500);
    });
    UIElements.videoElement.addEventListener('leavepictureinpicture', () => {
        clearPipWindowWatch();
        if (isStoppingPlayer) {
            setPipModalActive(false);
            return;
        }

        isTransitioningFromPip = true;
        isUserInitiatedPause = false; // User returning to player indicates intention to view
        setTimeout(() => {
            isTransitioningFromPip = false;
        }, 800);

        const wasModalPipHidden = Boolean(UIElements.videoModal?.classList.contains('pip-active'));
        setPipModalActive(false);
        const hasDirectSrc = Boolean(UIElements.videoElement && UIElements.videoElement.getAttribute('src'));
        const hasActiveStream = Boolean(appState.player || appState.hlsPlayer || appState.shakaPlayer || currentLocalStreamUrl || currentStreamUrlToPlay || directAudioHandoff || hasDirectSrc);
        if (hasActiveStream) {
            openModal(UIElements.videoModal);
            if (!isAudioOnly) {
                requestScreenWakeLock();
            }
            if (wasModalPipHidden) {
                // Android / iOS PiP enlargement animation momentarily pauses the video.
                // Stagger multiple resume attempts so playback continues smoothly as soon as the OS window transition ends.
                const tryPlay = () => {
                    if (!isStoppingPlayer && UIElements.videoElement && UIElements.videoElement.paused && !isUserInitiatedPause) {
                        UIElements.videoElement.play().catch(e => console.log('[PLAYER] PiP resume play promise:', e));
                    }
                };
                tryPlay();
                setTimeout(tryPlay, 150);
                setTimeout(tryPlay, 350);
                setTimeout(tryPlay, 650);
            }
        } else {
            stopAndCleanupPlayer();
        }
    });

    window.addEventListener('focus', () => {
        const videoModal = document.getElementById('video-modal') || UIElements.videoModal;
        if (videoModal && !videoModal.classList.contains('hidden')) {
            const audioEl = getAudioElement();
            if (directAudioHandoff && audioEl) {
                if (audioEl.paused && !audioEl.ended && !isUserInitiatedPause) {
                    audioEl.play().catch(() => {});
                }
                return;
            }
            if (UIElements.videoElement && UIElements.videoElement.paused && !isUserInitiatedPause) {
                UIElements.videoElement.play().catch(() => {});
            }
        }
    });

    // Audio track button
    const audioTrackBtn = document.getElementById('audio-track-btn');
    if (audioTrackBtn) {
        audioTrackBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            document.getElementById('player-more-options-menu')?.classList.add('hidden');
            const menu = document.getElementById('audio-track-menu');
            menu?.classList.toggle('hidden');
            document.getElementById('subtitle-track-menu')?.classList.add('hidden');
        });
    }

    // Subtitle track button
    const subtitleTrackBtn = document.getElementById('subtitle-track-btn');
    if (subtitleTrackBtn) {
        subtitleTrackBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            document.getElementById('player-more-options-menu')?.classList.add('hidden');
            const menu = document.getElementById('subtitle-track-menu');
            menu?.classList.toggle('hidden');
            document.getElementById('audio-track-menu')?.classList.add('hidden');
        });
    }

    // Close menus when clicking outside
    document.addEventListener('click', () => {
        document.getElementById('audio-track-menu')?.classList.add('hidden');
        document.getElementById('subtitle-track-menu')?.classList.add('hidden');
    });

    // Update track lists when stream loads
    UIElements.videoElement.addEventListener('loadedmetadata', () => {
        console.log('[PLAYER] Media metadata loaded, checking for audio/subtitle tracks...');
        // Small delay to ensure tracks are fully loaded
        setTimeout(() => {
            updateAudioTrackList();
            updateSubtitleTrackList();
        }, 500);
    });

    // Also check when tracks change
    UIElements.videoElement.addEventListener('addtrack', () => {
        console.log('[PLAYER] Track added, updating lists...');
        updateAudioTrackList();
        updateSubtitleTrackList();
    });

    // Unload handlers to cleanly notify the server and close active redirect stream session on tab/browser close
    const handleUnload = (e) => {
        // Flush active watch progress to preserve playback state
        if (currentActiveMedia) {
            flushWatchProgress();
        }

        // If page is entering background cache (persisted), do not stop stream!
        if (e && e.persisted) {
            return;
        }
        // If stream is active and not an intentional user pause, this is mobile pagehide on screen-lock/home swipe - do NOT stop the stream!
        const hasActiveStream = !!(appState.player || appState.hlsPlayer || currentLocalStreamUrl || currentStreamUrlToPlay || currentRedirectHistoryId);
        if (hasActiveStream && !isUserInitiatedPause) {
            return;
        }
        if (currentRedirectHistoryId) {
            stopRedirectStream(currentRedirectHistoryId, true);
        }
    };
    window.addEventListener('pagehide', handleUnload);
    window.addEventListener('beforeunload', handleUnload);
}

// --- Aspect Ratio Logic ---
let isAspectRatioLocked = true; // Default to locked

export const toggleAspectRatioLock = () => {
    isAspectRatioLocked = !isAspectRatioLocked;
    updateAspectRatioLockButton();
    document.getElementById('player-more-options-menu')?.classList.add('hidden');
    showNotification(isAspectRatioLocked ? 'Aspect ratio locked to 16:9' : 'Aspect ratio free resize enabled', false, 1500);
};

const updateAspectRatioLockButton = () => {
    const btn = document.getElementById('aspect-ratio-lock-btn');
    if (!btn) return;

    const statusBadge = document.getElementById('aspect-ratio-status');
    const iconContainer = btn.querySelector('.aspect-ratio-icon-container');

    if (isAspectRatioLocked) {
        btn.classList.add('text-blue-400');
        btn.classList.remove('text-gray-400');
        if (statusBadge) {
            statusBadge.textContent = '16:9 Locked';
            statusBadge.className = 'text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded-full bg-blue-500/20 text-blue-400 border border-blue-500/30';
        }
        if (iconContainer) {
            iconContainer.className = 'p-1.5 rounded-md bg-blue-600/30 text-blue-400 transition-colors flex-shrink-0 aspect-ratio-icon-container';
        }
    } else {
        btn.classList.remove('text-blue-400');
        btn.classList.add('text-gray-400');
        if (statusBadge) {
            statusBadge.textContent = 'Free Resize';
            statusBadge.className = 'text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded-full bg-gray-800 text-gray-400 border border-gray-700';
        }
        if (iconContainer) {
            iconContainer.className = 'p-1.5 rounded-md bg-gray-800/80 text-gray-400 transition-colors flex-shrink-0 aspect-ratio-icon-container';
        }
    }
};

export const shouldMaintainAspectRatio = () => {
    return isAspectRatioLocked;
};

export const getVideoAspectRatio = () => {
    if (UIElements.videoElement && UIElements.videoElement.videoWidth && UIElements.videoElement.videoHeight) {
        return UIElements.videoElement.videoWidth / UIElements.videoElement.videoHeight;
    }
    return 16 / 9; // Default fallback
};
