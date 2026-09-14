/**
 * dvr.js
 * Manages all client-side functionality for the DVR page.
 */

import { UIElements, dvrState, guideState, appState } from './state.js';
import { apiFetch, getWatchProgress, deleteWatchProgress } from './api.js';
import { showNotification, showConfirm, openModal, closeModal, showResumePrompt } from './ui.js';
import { handleSearchAndFilter } from './guide.js';
// MODIFIED: Import the corrected navigation function from notification.js
import { navigateToProgramInGuide } from './notification.js';
import { populateChannelSelector } from './multiview.js';
import { ICONS } from './icons.js';
import { stopAndCleanupPlayer, playRecordingOrDirectVideo, setActiveMediaTracking } from './player.js';

/**
 * Initializes the DVR page by fetching all required data from the backend.
 * MODIFIED: Now handles visibility of sections based on user permissions.
 */
export async function initDvrPage() {
    console.log('[DVR] Initializing DVR page...');
    const hasDvrPermission = appState.currentUser?.isAdmin || appState.currentUser?.canUseDvr;

    // Toggle visibility of DVR controls based on user permissions
    const manualRecSection = UIElements.manualRecordingSection || document.getElementById('manual-recording-section');
    if (manualRecSection) manualRecSection.classList.add('hidden'); // default to collapsed drawer
    if (UIElements.dvrToggleManualBtn) UIElements.dvrToggleManualBtn.classList.toggle('hidden', !hasDvrPermission);
    if (UIElements.dvrTabBtnScheduled) UIElements.dvrTabBtnScheduled.classList.toggle('hidden', !hasDvrPermission);
    if (UIElements.dvrTabBtnHistory) UIElements.dvrTabBtnHistory.classList.toggle('hidden', !hasDvrPermission);

    // Initialize active tab (default to 'recordings')
    switchDvrTab(dvrState.activeTab || 'recordings');

    // Restore view mode (table vs cards)
    const savedMode = localStorage.getItem('viniplay_dvr_view_mode') || 'table';
    setRecordingViewMode(savedMode, false);

    const promises = [
        loadCompletedRecordings(),
        loadStorageInfo()
    ];

    if (hasDvrPermission) {
        promises.push(loadScheduledJobs());
    } else {
        // Explicitly hide these elements if user has no DVR permission
        if (UIElements.noDvrJobsMessage) UIElements.noDvrJobsMessage.classList.add('hidden');
        if (UIElements.dvrJobsTableContainer) UIElements.dvrJobsTableContainer.classList.add('hidden');
    }

    await Promise.all(promises);
    console.log('[DVR] DVR page initialized.');
}


/**
 * Fetches scheduled recording jobs from the server and updates the state.
 */
async function loadScheduledJobs() {
    const res = await apiFetch('/api/dvr/jobs');
    if (res && res.ok) {
        dvrState.scheduledJobs = await res.json();
        renderScheduledJobs();
    } else {
        showNotification('Could not load scheduled recordings.', true);
    }
}

/**
 * Fetches completed recordings from the server and updates the state.
 */
async function loadCompletedRecordings() {
    const res = await apiFetch('/api/dvr/recordings');
    if (res && res.ok) {
        dvrState.completedRecordings = await res.json();
        renderCompletedRecordings();
    } else {
        showNotification('Could not load completed recordings.', true);
    }
}

/**
 * NEW: Fetches storage usage information from the server.
 */
async function loadStorageInfo() {
    const res = await apiFetch('/api/dvr/storage');
    if (res && res.ok) {
        const storageData = await res.json();
        renderStorageBar(storageData);
    } else {
        // Hide the storage bar if it fails to load
        UIElements.dvrStorageBarContainer.classList.add('hidden');
        console.error('[DVR] Could not load storage information.');
    }
}

/**
 * Plays an in-progress recording using the main mpegts.js player.
 * @param {object} job - The DVR job object that is currently recording.
 */
let timeshiftUpdateInterval = null;
let timeshiftHideTimeout = null;
let isUserSeeking = false;

function formatTimeshiftTime(seconds) {
    if (isNaN(seconds) || seconds < 0) seconds = 0;
    const totalSecs = Math.floor(seconds);
    const hrs = Math.floor(totalSecs / 3600);
    const mins = Math.floor((totalSecs % 3600) / 60);
    const secs = totalSecs % 60;
    if (hrs > 0) {
        return `${hrs}:${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
    }
    return `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
}

/**
 * Plays an in-progress recording using Hls.js with custom timeshift seekbar controls.
 * @param {object} job - The DVR job object that is currently recording.
 */
async function playTimeshiftStream(job, startTime = 0) {
    if (!job) return;

    if (startTime === 0) {
        try {
            const prog = await getWatchProgress('dvr_job', job.id);
            if (prog && prog.progress_seconds >= 15 && (!prog.duration_seconds || prog.progress_seconds < prog.duration_seconds * 0.95)) {
                showResumePrompt({
                    title: job.programTitle || 'Live Recording',
                    progressSeconds: prog.progress_seconds,
                    durationSeconds: prog.duration_seconds || 0,
                    onResume: () => playTimeshiftStream(job, prog.progress_seconds),
                    onStartOver: () => {
                        deleteWatchProgress('dvr_job', job.id);
                        playTimeshiftStream(job, -1);
                    }
                });
                return;
            }
        } catch (err) {
            console.warn('[DVR_TIMESHIFT] Error checking watch progress:', err);
        }
    }

    const seekTarget = Math.max(0, startTime);

    // Use the main player modal for timeshifting
    const playerModal = UIElements.videoModal;
    const videoElement = UIElements.videoElement;
    const videoTitle = UIElements.videoTitle;

    // 1. Stop any existing stream in the main player
    await stopAndCleanupPlayer();
    await new Promise(r => setTimeout(r, 50)); // Short micro-yield to allow browser MSE decoder to flush

    const streamUrl = `/api/dvr/timeshift/${job.id}/stream.m3u8?_t=${Date.now()}`;
    console.log(`[DVR_TIMESHIFT] Starting HLS timeshift playback for URL: ${streamUrl} at ${seekTarget}s`);
    videoTitle.textContent = `${job.programTitle} (Timeshift)`;

    appState.activeTimeshiftJobId = job.id;

    // Hide native controls so our timeshift overlay takes over without interference
    videoElement.controls = false;

    const overlay = document.getElementById('timeshift-controls-overlay') || UIElements.timeshiftControlsOverlay;
    if (overlay) {
        overlay.classList.remove('hidden');
        overlay.style.opacity = '1';
    }

    const progressBar = document.getElementById('timeshift-progress-bar') || UIElements.timeshiftProgressBar;
    const currentTimeEl = document.getElementById('timeshift-current-time') || UIElements.timeshiftCurrentTime;
    const totalTimeEl = document.getElementById('timeshift-total-time') || UIElements.timeshiftTotalTime;
    const liveEdgeBtn = document.getElementById('timeshift-live-edge-btn') || UIElements.timeshiftLiveEdgeBtn;
    const liveDot = document.getElementById('timeshift-live-dot') || UIElements.timeshiftLiveDot;
    const playPauseBtn = document.getElementById('timeshift-play-pause-btn') || UIElements.timeshiftPlayPauseBtn;
    const rewind15Btn = document.getElementById('timeshift-rewind-15-btn') || UIElements.timeshiftRewind15Btn;
    const forward15Btn = document.getElementById('timeshift-forward-15-btn') || UIElements.timeshiftForward15Btn;

    if (progressBar) {
        progressBar.value = seekTarget;
        progressBar.max = Math.max(100, seekTarget);
    }
    if (currentTimeEl) currentTimeEl.textContent = formatTimeshiftTime(seekTarget);
    if (totalTimeEl) totalTimeEl.textContent = '00:00';

    const getTotalDuration = (hlsInstance) => {
        let dur = 0;
        if (videoElement.seekable && videoElement.seekable.length > 0) {
            dur = videoElement.seekable.end(videoElement.seekable.length - 1);
        }
        if ((!dur || isNaN(dur) || dur === Infinity) && hlsInstance?.levels && hlsInstance.levels[hlsInstance.currentLevel]) {
            dur = hlsInstance.levels[hlsInstance.currentLevel].details?.totalduration || 0;
        }
        return (dur && !isNaN(dur) && dur !== Infinity) ? dur : (videoElement.currentTime || 0);
    };

    if (window.Hls && Hls.isSupported()) {
        try {
            const hls = new Hls({
                startPosition: seekTarget, // Force playback to start from seekTarget (or 00:00)
                enableWorker: true,
                lowLatencyMode: false,
                backBufferLength: Infinity, // Retain past segments in memory for seamless backward scrubbing
                maxBufferLength: 60,
                maxMaxBufferLength: 120,
            });
            appState.hlsPlayer = hls;

            hls.loadSource(streamUrl);
            hls.attachMedia(videoElement);

            // Track watch progress for live timeshift job
            setActiveMediaTracking({
                contentType: 'dvr_job',
                contentId: String(job.id),
                title: job.programTitle
            });

            hls.on(Hls.Events.MANIFEST_PARSED, () => {
                console.log(`[HLS_TIMESHIFT] Manifest parsed, opening player at ${seekTarget}s`);
                openModal(playerModal);
                if (seekTarget > 0) {
                    videoElement.currentTime = seekTarget;
                } else {
                    videoElement.currentTime = 0;
                }
                videoElement.play().catch(e => console.warn('[TIMESHIFT] Autoplay prevented:', e));
            });

            hls.on(Hls.Events.ERROR, (event, data) => {
                if (data.fatal) {
                    console.error('[HLS_TIMESHIFT] Fatal Hls.js error:', data.type, data.details);
                    switch (data.type) {
                        case Hls.ErrorTypes.NETWORK_ERROR:
                            console.log('[HLS_TIMESHIFT] Attempting network error recovery...');
                            hls.startLoad();
                            break;
                        case Hls.ErrorTypes.MEDIA_ERROR:
                            console.log('[HLS_TIMESHIFT] Attempting media error recovery...');
                            hls.recoverMediaError();
                            break;
                        default:
                            showNotification('Could not load timeshift stream. Retrying...', true);
                            stopAndCleanupPlayer();
                            break;
                    }
                }
            });

            // Start UI updater
            if (timeshiftUpdateInterval) clearInterval(timeshiftUpdateInterval);
            timeshiftUpdateInterval = setInterval(() => {
                if (!appState.activeTimeshiftJobId) {
                    clearInterval(timeshiftUpdateInterval);
                    timeshiftUpdateInterval = null;
                    return;
                }
                const total = getTotalDuration(hls);
                const cur = videoElement.currentTime || 0;

                if (totalTimeEl) totalTimeEl.textContent = formatTimeshiftTime(total);
                if (currentTimeEl && !isUserSeeking) currentTimeEl.textContent = formatTimeshiftTime(cur);

                if (progressBar && !isUserSeeking) {
                    progressBar.max = Math.max(1, total);
                    progressBar.value = cur;
                }

                // Check if user is at the live edge (within 8 seconds of latest segment)
                const isNearLive = total > 5 && (total - cur) < 8;
                if (liveDot && liveEdgeBtn) {
                    if (isNearLive) {
                        liveDot.className = 'w-2 h-2 rounded-full bg-white animate-pulse inline-block';
                        liveEdgeBtn.className = 'ml-1 px-2.5 py-1 text-xs font-bold rounded-md bg-red-600 text-white transition-colors flex items-center gap-1.5 flex-shrink-0 cursor-pointer';
                    } else {
                        liveDot.className = 'w-2 h-2 rounded-full bg-gray-400 inline-block';
                        liveEdgeBtn.className = 'ml-1 px-2.5 py-1 text-xs font-bold rounded-md bg-gray-700 text-gray-300 hover:bg-red-600 hover:text-white transition-colors flex items-center gap-1.5 flex-shrink-0 cursor-pointer';
                    }
                }

                if (playPauseBtn) {
                    playPauseBtn.innerHTML = videoElement.paused ? ICONS.play : ICONS.pause;
                }
            }, 250);

            // Scrubber interaction
            if (progressBar) {
                progressBar.oninput = (e) => {
                    isUserSeeking = true;
                    if (currentTimeEl) currentTimeEl.textContent = formatTimeshiftTime(parseFloat(e.target.value));
                };
                progressBar.onchange = (e) => {
                    isUserSeeking = false;
                    const targetSec = parseFloat(e.target.value);
                    videoElement.currentTime = targetSec;
                };
            }

            if (rewind15Btn) {
                rewind15Btn.onclick = () => {
                    videoElement.currentTime = Math.max(0, (videoElement.currentTime || 0) - 15);
                };
            }

            if (forward15Btn) {
                forward15Btn.onclick = () => {
                    const total = getTotalDuration(hls);
                    videoElement.currentTime = Math.min(total, (videoElement.currentTime || 0) + 15);
                };
            }

            if (liveEdgeBtn) {
                liveEdgeBtn.onclick = () => {
                    const total = getTotalDuration(hls);
                    if (total > 2) {
                        videoElement.currentTime = total - 2;
                    }
                };
            }

            if (playPauseBtn) {
                playPauseBtn.onclick = () => {
                    if (videoElement.paused) videoElement.play();
                    else videoElement.pause();
                };
            }

            // Auto-hide controls overlay during active playback
            const container = UIElements.videoModalContainer || document.getElementById('video-modal-container');
            const showControls = () => {
                if (overlay) overlay.style.opacity = '1';
                if (timeshiftHideTimeout) clearTimeout(timeshiftHideTimeout);
                timeshiftHideTimeout = setTimeout(() => {
                    if (!videoElement.paused && !isUserSeeking && overlay && appState.activeTimeshiftJobId) {
                        overlay.style.opacity = '0';
                    }
                }, 3500);
            };
            if (container) {
                container.onmousemove = showControls;
                container.onmouseleave = () => {
                    if (!videoElement.paused && !isUserSeeking && overlay && appState.activeTimeshiftJobId) {
                        overlay.style.opacity = '0';
                    }
                };
            }

        } catch (err) {
            console.error('[HLS_TIMESHIFT] Setup error:', err);
            showNotification('Could not start timeshift stream.', true);
            await stopAndCleanupPlayer();
        }
    } else if (videoElement.canPlayType('application/vnd.apple.mpegurl')) {
        // Native HLS fallback (Safari/iOS)
        setActiveMediaTracking({
            contentType: 'dvr_job',
            contentId: String(job.id),
            title: job.programTitle
        });
        videoElement.src = streamUrl;
        openModal(playerModal);
        videoElement.currentTime = seekTarget;
        videoElement.play().catch(e => console.warn('[TIMESHIFT] Autoplay prevented:', e));
    } else {
        showNotification('Your browser does not support HLS timeshift playback.', true);
        await stopAndCleanupPlayer();
    }
}

/**
 * Plays a completed recording file.
 * If the recording is in legacy .ts format, automatically requests on-demand remux to .mp4
 * so the browser can seek instantly via native HTTP 206 Range requests.
 * @param {object} recording - The completed recording object.
 * @param {number} [startTime=0] - Starting timestamp offset in seconds for resuming playback.
 */
async function playCompletedRecording(recording, startTime = 0) {
    if (!recording) return;

    if (startTime === 0) {
        try {
            const prog = await getWatchProgress('dvr_recording', recording.id);
            if (prog && prog.progress_seconds >= 15 && (!prog.duration_seconds || prog.progress_seconds < prog.duration_seconds * 0.95)) {
                showResumePrompt({
                    title: recording.programTitle || 'Recording',
                    progressSeconds: prog.progress_seconds,
                    durationSeconds: prog.duration_seconds || recording.duration || 0,
                    onResume: () => playCompletedRecording(recording, prog.progress_seconds),
                    onStartOver: () => {
                        deleteWatchProgress('dvr_recording', recording.id);
                        playCompletedRecording(recording, -1);
                    }
                });
                return;
            }
        } catch (err) {
            console.warn('[DVR] Error checking recording watch progress:', err);
        }
    }

    const seekTarget = Math.max(0, startTime);
    const mediaInfo = {
        contentType: 'dvr_recording',
        contentId: String(recording.id),
        title: recording.programTitle,
        duration: recording.duration || 0
    };

    // If still in .ts format, trigger fast on-demand remux to .mp4
    if (recording.filename && recording.filename.endsWith('.ts')) {
        showNotification('Optimizing recording for seekable playback...', false, 4000);
        try {
            const remuxRes = await apiFetch(`/api/dvr/recordings/${recording.id}/remux`, { method: 'POST' });
            if (remuxRes && remuxRes.success && remuxRes.filename) {
                recording.filename = remuxRes.filename;
            }
        } catch (e) {
            console.warn('[DVR] On-demand remux failed, attempting fallback play:', e);
        }
    }

    // Check if remux resulted in an MP4 (or it was already MP4)
    if (recording.filename && !recording.filename.endsWith('.ts')) {
        await playRecordingOrDirectVideo(`/dvr/${recording.filename}`, recording.programTitle, '', false, seekTarget, mediaInfo);
    } else {
        // Fallback for raw TS if remux was unsuccessful
        playCompletedTsFile(recording);
        setActiveMediaTracking(mediaInfo);
    }
}

/**
 * Stops playback of a completed recording and cleans up video resources.
 */
export const stopCompletedRecordingPlayback = async () => {
    await stopAndCleanupPlayer();
};

/**
 * Fallback: Plays a completed .ts recording file using mpegts.js if remux is unavailable.
 * @param {object} recording - The completed recording object.
 */
async function playCompletedTsFile(recording) {
    if (!recording) return;

    const playerModal = UIElements.videoModal;
    const videoElement = UIElements.videoElement;
    const videoTitle = UIElements.videoTitle;

    await stopAndCleanupPlayer();

    const streamUrl = `/dvr/${recording.filename}`;
    console.log(`[DVR_PLAYBACK] Starting fallback playback for TS file: ${streamUrl}`);
    videoTitle.textContent = recording.programTitle;

    if (mpegts.isSupported()) {
        const mpegtsConfig = {
            isLive: false,
            autoCleanupSourceBuffer: true,
            lazyLoad: true,
            seekType: 'range',
        };

        appState.player = mpegts.createPlayer({
            type: 'mse',
            isLive: false,
            url: streamUrl
        }, mpegtsConfig);

        appState.player.attachMediaElement(videoElement);
        appState.player.load();
        appState.player.play().catch((err) => {
            console.error("MPEGTS Player Error (Completed TS):", err);
            showNotification("Could not play the selected recording.", true);
            stopAndCleanupPlayer();
        });

        openModal(playerModal);
    } else {
        showNotification('Your browser does not support the technology required to play this file type.', true);
    }
}


function escapeHtml(str) {
    if (!str) return '';
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
}

let liveHeroTicker = null;

function updateLiveHeroTicker(activeJobs) {
    if (liveHeroTicker) {
        clearInterval(liveHeroTicker);
        liveHeroTicker = null;
    }
    if (!activeJobs || activeJobs.length === 0) {
        return;
    }

    const tick = () => {
        const nowMs = Date.now();
        activeJobs.forEach(job => {
            const startMs = job.startTime ? new Date(job.startTime).getTime() : nowMs;
            const endMs = job.endTime ? new Date(job.endTime).getTime() : startMs + 3600000;

            const totalSec = Math.max(1, Math.round((endMs - startMs) / 1000));
            const elapsedSec = Math.max(0, Math.round((nowMs - startMs) / 1000));
            const remainingSec = Math.max(0, Math.round((endMs - nowMs) / 1000));
            const progressPct = Math.min(100, Math.max(0, Math.round((elapsedSec / totalSec) * 100)));

            const countdownEl = document.querySelector(`.dvr-live-countdown[data-job-id="${job.id}"]`);
            if (countdownEl) {
                const minsLeft = Math.ceil(remainingSec / 60);
                countdownEl.textContent = remainingSec > 0
                    ? `Stops in ~${minsLeft} min${minsLeft === 1 ? '' : 's'} (at ${new Date(endMs).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })})`
                    : 'Finishing...';
            }

            const progressEl = document.querySelector(`.dvr-live-progress-bar[data-job-id="${job.id}"]`);
            if (progressEl) {
                progressEl.style.width = `${progressPct}%`;
            }

            const elapsedEl = document.querySelector(`.dvr-live-elapsed-text[data-job-id="${job.id}"]`);
            if (elapsedEl) {
                elapsedEl.textContent = `${formatDuration(elapsedSec)} / ${formatDuration(totalSec)}`;
            }
        });
    };

    tick();
    liveHeroTicker = setInterval(tick, 1000);
}

/**
 * Renders the table of scheduled recording jobs (filtered to upcoming, live banner, and history).
 */
function renderScheduledJobs() {
    const allJobs = dvrState.scheduledJobs || [];
    const isAdmin = appState.currentUser?.isAdmin;

    // 1. Check for all active recording jobs to display in the Live Hero Banner
    const activeJobs = allJobs.filter(j => j.status === 'recording' || j.status === 'reconnecting');
    if (activeJobs.length > 0 && UIElements.dvrLiveHeroBanner) {
        UIElements.dvrLiveHeroBanner.classList.remove('hidden');

        let headerHtml = '';
        if (activeJobs.length > 1) {
            headerHtml = `
                <div class="flex items-center justify-between px-1 pb-1">
                    <div class="flex items-center gap-2">
                        <span class="w-2.5 h-2.5 rounded-full bg-red-500 animate-pulse"></span>
                        <h2 class="text-xs font-bold uppercase tracking-wider text-red-400">
                            Active Live Recordings (${activeJobs.length})
                        </h2>
                    </div>
                    <span class="text-xs text-gray-400 font-mono">Multiple Captures Running</span>
                </div>
            `;
        }

        const cardsHtml = activeJobs.map(job => {
            const isReconnecting = job.status === 'reconnecting';
            const isTimeshiftable = job.filePath && job.filePath.endsWith('.ts');

            const startMs = job.startTime ? new Date(job.startTime).getTime() : Date.now();
            const endMs = job.endTime ? new Date(job.endTime).getTime() : startMs + 3600000;
            const nowMs = Date.now();

            const startTimeStr = new Date(startMs).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
            const endTimeStr = new Date(endMs).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });

            const totalSec = Math.max(1, Math.round((endMs - startMs) / 1000));
            const elapsedSec = Math.max(0, Math.round((nowMs - startMs) / 1000));
            const remainingSec = Math.max(0, Math.round((endMs - nowMs) / 1000));
            const progressPct = Math.min(100, Math.max(0, Math.round((elapsedSec / totalSec) * 100)));

            const minsLeft = Math.ceil(remainingSec / 60);
            const countdownText = remainingSec > 0
                ? `Stops in ~${minsLeft} min${minsLeft === 1 ? '' : 's'} (at ${new Date(endMs).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })})`
                : 'Finishing...';

            const playIcon = (ICONS.play || '').replace('class="w-5 h-5"', 'class="w-4 h-4"');
            const stopIcon = (ICONS.stopRec || '').replace('class="w-5 h-5"', 'class="w-4 h-4"');

            return `
                <div class="bg-gray-800 border-l-4 ${isReconnecting ? 'border-l-yellow-400' : 'border-l-red-500'} rounded-xl p-4 sm:p-5 shadow-lg border-t border-r border-b border-gray-700/60" data-hero-job-id="${job.id}">
                    <div class="flex flex-col md:flex-row md:items-center justify-between gap-4">
                        <div class="flex items-start gap-3.5 min-w-0 flex-grow">
                            <div class="mt-1 flex-shrink-0 relative">
                                <span class="w-3.5 h-3.5 ${isReconnecting ? 'bg-yellow-400' : 'bg-red-500'} rounded-full block animate-pulse"></span>
                            </div>
                            <div class="flex-grow min-w-0">
                                <div class="flex flex-wrap items-center gap-2">
                                    <span class="dvr-live-status-badge text-xs font-bold uppercase tracking-wider ${isReconnecting ? 'text-yellow-400 bg-yellow-950/60 border border-yellow-800/40' : 'text-red-400 bg-red-950/60 border border-red-800/40'} px-2 py-0.5 rounded">
                                        ${isReconnecting ? 'Reconnecting...' : 'Recording Live Now'}
                                    </span>
                                    <span class="dvr-live-channel-badge text-xs text-gray-200 bg-gray-700 px-2 py-0.5 rounded font-medium border border-gray-600 truncate max-w-xs">
                                        ${escapeHtml(job.channelName || 'Unknown Channel')}
                                    </span>
                                </div>
                                <h3 class="dvr-live-title text-lg font-bold text-white mt-1 truncate max-w-xl" title="${escapeHtml(job.programTitle || '')}">
                                    ${escapeHtml(job.programTitle || 'Live Capture')}
                                </h3>
                                
                                <!-- Start & Stop Timestamps + Remaining Countdown -->
                                <div class="flex flex-wrap items-center gap-3 mt-2 text-xs">
                                    <div class="dvr-live-window inline-flex items-center gap-1.5 bg-gray-900/80 px-2.5 py-1 rounded border border-gray-700 font-mono text-gray-300">
                                        <span>Start: ${startTimeStr}</span> <span class="text-gray-500">→</span> <span>Stop: ${endTimeStr}</span>
                                    </div>
                                    <span class="dvr-live-countdown text-xs text-amber-400 font-medium font-mono" data-job-id="${job.id}">
                                        ${countdownText}
                                    </span>
                                </div>

                                <!-- Elapsed Progress Bar -->
                                <div class="flex items-center gap-3 mt-2.5 max-w-md">
                                    <div class="flex-grow bg-gray-700/80 rounded-full h-1.5 overflow-hidden">
                                        <div class="dvr-live-progress-bar ${isReconnecting ? 'bg-yellow-500' : 'bg-red-500'} h-full rounded-full transition-all" data-job-id="${job.id}" style="width: ${progressPct}%"></div>
                                    </div>
                                    <span class="dvr-live-elapsed-text text-[11px] font-mono text-gray-400 flex-shrink-0" data-job-id="${job.id}">
                                        ${formatDuration(elapsedSec)} / ${formatDuration(totalSec)}
                                    </span>
                                </div>
                            </div>
                        </div>

                        <div class="flex items-center gap-2.5 self-end md:self-center flex-shrink-0">
                            ${isTimeshiftable ? `
                            <button class="dvr-live-timeshift-btn bg-blue-600 hover:bg-blue-700 text-white text-xs font-bold py-2 px-3.5 rounded-md flex items-center gap-1.5 transition-colors shadow" data-job-id="${job.id}">
                                ${playIcon}
                                <span>Watch Live (Chase Play)</span>
                            </button>` : ''}
                            <button class="dvr-live-stop-btn bg-red-600 hover:bg-red-700 text-white text-xs font-bold py-2 px-3 rounded-md flex items-center gap-1.5 transition-colors" data-job-id="${job.id}">
                                ${stopIcon}
                                <span>Stop</span>
                            </button>
                        </div>
                    </div>
                </div>
            `;
        }).join('');

        UIElements.dvrLiveHeroBanner.innerHTML = headerHtml + cardsHtml;
        updateLiveHeroTicker(activeJobs);
    } else {
        updateLiveHeroTicker([]);
        if (UIElements.dvrLiveHeroBanner) {
            UIElements.dvrLiveHeroBanner.classList.add('hidden');
            UIElements.dvrLiveHeroBanner.innerHTML = '';
        }
    }

    // 2. Separate upcoming jobs and history jobs
    const searchQuery = (dvrState.searchQuery || '').toLowerCase().trim();
    const upcomingJobs = allJobs.filter(j => j.status === 'scheduled' || j.status === 'recording' || j.status === 'reconnecting');
    const historyJobs = allJobs.filter(j => ['completed', 'error', 'cancelled'].includes(j.status));

    // Update Scheduled tab count badge
    if (UIElements.dvrScheduledCount) {
        UIElements.dvrScheduledCount.textContent = upcomingJobs.length;
    }

    // Filter by search query if any
    const filteredUpcoming = searchQuery ? upcomingJobs.filter(j =>
        (j.programTitle && j.programTitle.toLowerCase().includes(searchQuery)) ||
        (j.channelName && j.channelName.toLowerCase().includes(searchQuery))
    ) : upcomingJobs;

    const filteredHistory = searchQuery ? historyJobs.filter(j =>
        (j.programTitle && j.programTitle.toLowerCase().includes(searchQuery)) ||
        (j.channelName && j.channelName.toLowerCase().includes(searchQuery))
    ) : historyJobs;

    // 3. Render Upcoming Jobs (Scheduled Tab)
    const hasUpcoming = filteredUpcoming.length > 0;
    if (UIElements.noDvrJobsMessage) UIElements.noDvrJobsMessage.classList.toggle('hidden', hasUpcoming);
    if (UIElements.dvrJobsTableContainer) UIElements.dvrJobsTableContainer.classList.toggle('hidden', !hasUpcoming);
    if (UIElements.clearScheduledDvrBtn) UIElements.clearScheduledDvrBtn.classList.toggle('hidden', !hasUpcoming);

    const userHeaderUpcoming = UIElements.dvrJobsTableContainer?.querySelector('th.user-col');
    if (userHeaderUpcoming) userHeaderUpcoming.classList.toggle('hidden', !isAdmin);

    if (UIElements.dvrJobsTbody) {
        UIElements.dvrJobsTbody.innerHTML = '';
        filteredUpcoming.forEach(job => {
            const startTime = new Date(job.startTime).toLocaleString();
            const endTime = new Date(job.endTime).toLocaleString();
            const statusHTML = `<span class="status-badge ${job.status}">${job.status}</span>`;
            const conflictIcon = job.isConflicting ?
                `<svg class="h-5 w-5 text-yellow-400" fill="currentColor" viewBox="0 0 20 20" title="This recording conflicts with another scheduled recording."><path fill-rule="evenodd" d="M8.257 3.099c.765-1.36 2.722-1.36 3.486 0l5.58 9.92c.75 1.334-.21 3.03-1.742 3.03H4.42c-1.532 0-2.492-1.696-1.742-3.03l5.58-9.92zM10 13a1 1 0 110-2 1 1 0 010 2zm-1.75-5.25a.75.75 0 00-1.5 0v3.5a.75.75 0 001.5 0v-3.5z" clip-rule="evenodd" /></svg>` : '';
            const userColumn = isAdmin ? `<td>${job.username || 'N/A'}</td>` : '';

            const tr = document.createElement('tr');
            tr.dataset.jobId = job.id;
            tr.innerHTML = `
                <td class="max-w-xs truncate font-medium text-white" title="${job.programTitle}">${job.programTitle}</td>
                <td class="max-w-xs truncate">
                    <span class="inline-flex items-center gap-1.5 px-2 py-0.5 rounded bg-gray-700/80 text-gray-200 text-xs font-medium border border-gray-600">
                        ${job.channelName}
                    </span>
                </td>
                ${userColumn}
                <td class="font-mono text-xs text-gray-300">${startTime}</td>
                <td class="font-mono text-xs text-gray-300">${endTime}</td>
                <td>${statusHTML}</td>
                <td class="text-center">${conflictIcon}</td>
                <td class="text-right">
                    <div class="flex items-center justify-end gap-2">
                        <button class="action-btn go-to-guide-btn" title="View in TV Guide" data-channel-id="${job.channelId}" data-program-start="${job.programStart || job.startTime}">
                            ${ICONS.goToGuide}
                        </button>
                        ${job.status === 'scheduled' ? `
                            <button class="action-btn edit-job-btn" title="Edit Schedule" data-job-id="${job.id}">
                                ${ICONS.edit}
                            </button>
                        ` : ''}
                        <button class="action-btn cancel-job-btn" title="Cancel Recording" data-job-id="${job.id}">
                            ${ICONS.cancel}
                        </button>
                    </div>
                </td>
            `;
            UIElements.dvrJobsTbody.appendChild(tr);
        });
    }

    // 4. Render History Jobs (History Tab)
    const hasHistory = filteredHistory.length > 0;
    if (UIElements.noDvrHistoryMessage) UIElements.noDvrHistoryMessage.classList.toggle('hidden', hasHistory);
    if (UIElements.dvrHistoryTableContainer) UIElements.dvrHistoryTableContainer.classList.toggle('hidden', !hasHistory);
    if (UIElements.clearHistoryDvrBtn) UIElements.clearHistoryDvrBtn.classList.toggle('hidden', !hasHistory);

    const userHeaderHistory = UIElements.dvrHistoryTableContainer?.querySelector('th.user-col');
    if (userHeaderHistory) userHeaderHistory.classList.toggle('hidden', !isAdmin);

    if (UIElements.dvrHistoryTbody) {
        UIElements.dvrHistoryTbody.innerHTML = '';
        filteredHistory.forEach(job => {
            const startTime = new Date(job.startTime).toLocaleString();
            const endTime = new Date(job.endTime).toLocaleString();
            const statusHTML = job.status === 'error' && job.errorMessage
                ? `<button class="status-badge ${job.status} view-error-btn" data-job-id="${job.id}">${job.status}</button>`
                : `<span class="status-badge ${job.status}">${job.status}</span>`;
            const userColumn = isAdmin ? `<td>${job.username || 'N/A'}</td>` : '';

            const tr = document.createElement('tr');
            tr.dataset.jobId = job.id;
            tr.innerHTML = `
                <td class="max-w-xs truncate font-medium text-white" title="${job.programTitle}">${job.programTitle}</td>
                <td class="max-w-xs truncate">
                    <span class="inline-flex items-center gap-1.5 px-2 py-0.5 rounded bg-gray-700/80 text-gray-200 text-xs font-medium border border-gray-600">
                        ${job.channelName}
                    </span>
                </td>
                ${userColumn}
                <td class="font-mono text-xs text-gray-300">${startTime}</td>
                <td class="font-mono text-xs text-gray-300">${endTime}</td>
                <td>${statusHTML}</td>
                <td class="text-right">
                    <div class="flex items-center justify-end gap-2">
                        <button class="action-btn go-to-guide-btn" title="View in TV Guide" data-channel-id="${job.channelId}" data-program-start="${job.programStart || job.startTime}">
                            ${ICONS.goToGuide}
                        </button>
                        <button class="action-btn delete-history-btn" title="Remove From History" data-job-id="${job.id}">
                            ${ICONS.cancel}
                        </button>
                    </div>
                </td>
            `;
            UIElements.dvrHistoryTbody.appendChild(tr);
        });
    }
}


/**
 * Renders completed recordings in both Table and Cards views, with instant search filtering.
 */
function renderCompletedRecordings() {
    const recordings = dvrState.completedRecordings || [];
    const isAdmin = appState.currentUser?.isAdmin;

    // Update count badge
    if (UIElements.dvrRecordingsCount) {
        UIElements.dvrRecordingsCount.textContent = recordings.length;
    }

    const searchQuery = (dvrState.searchQuery || '').toLowerCase().trim();
    const filteredRecordings = searchQuery ? recordings.filter(rec =>
        (rec.programTitle && rec.programTitle.toLowerCase().includes(searchQuery)) ||
        (rec.channelName && rec.channelName.toLowerCase().includes(searchQuery))
    ) : recordings;

    const hasRecordings = filteredRecordings.length > 0;
    if (UIElements.noDvrRecordingsMessage) UIElements.noDvrRecordingsMessage.classList.toggle('hidden', hasRecordings);

    // Show/hide clear all button
    const hasDvrPermission = appState.currentUser?.isAdmin || appState.currentUser?.canUseDvr;
    if (UIElements.clearCompletedDvrBtn) {
        UIElements.clearCompletedDvrBtn.classList.toggle('hidden', !hasRecordings || !hasDvrPermission);
    }

    // 1. Render Table View
    const tbody = UIElements.dvrRecordingsTbody;
    if (tbody) {
        tbody.innerHTML = '';
        const userHeader = UIElements.dvrRecordingsTableContainer?.querySelector('th.user-col');
        if (userHeader) userHeader.classList.toggle('hidden', !isAdmin);

        filteredRecordings.forEach(rec => {
            const recordedOn = new Date(rec.startTime).toLocaleString();
            const userColumn = isAdmin ? `<td class="max-w-xs truncate" title="${rec.username}">${rec.username || 'N/A'}</td>` : '';

            const tr = document.createElement('tr');
            tr.dataset.recordingId = rec.id;
            tr.className = 'hover:bg-gray-700/30 transition-colors';
            tr.innerHTML = `
                <td class="max-w-xs truncate font-medium text-white" title="${rec.programTitle}">
                    <div class="flex items-center gap-3">
                        <button class="play-recording-btn w-7 h-7 rounded-full bg-blue-600 hover:bg-blue-500 text-white flex items-center justify-center transition-colors shadow flex-shrink-0" title="Play Recording">
                            <svg class="w-3.5 h-3.5 fill-current ml-0.5" viewBox="0 0 20 20"><polygon points="5 3 19 10 5 17 5 3"/></svg>
                        </button>
                        <span class="truncate font-semibold">${rec.programTitle}</span>
                    </div>
                </td>
                <td class="max-w-xs truncate">
                    <span class="inline-flex items-center gap-1.5 px-2 py-0.5 rounded bg-gray-700/80 text-gray-200 text-xs font-medium border border-gray-600">
                        ${rec.channelName}
                    </span>
                </td>
                ${userColumn}
                <td class="font-mono text-xs text-gray-300">${recordedOn}</td>
                <td class="font-mono text-xs font-medium">${formatDuration(rec.durationSeconds)}</td>
                <td class="font-mono text-xs text-gray-400">${formatBytes(rec.fileSizeBytes)}</td>
                <td class="text-right">
                    <div class="flex items-center justify-end gap-2">
                        <button class="action-btn play-recording-btn text-blue-400 hover:text-blue-300" title="Play Recording">
                            ${ICONS.play}
                        </button>
                        <button class="action-btn delete-recording-btn text-red-400 hover:text-red-300" title="Delete Recording">
                            ${ICONS.trash}
                        </button>
                    </div>
                </td>
            `;
            tbody.appendChild(tr);
        });
    }

    // 2. Render Cards View
    const cardsContainer = UIElements.dvrRecordingsCardsContainer;
    if (cardsContainer) {
        cardsContainer.innerHTML = '';
        filteredRecordings.forEach(rec => {
            const recordedOn = new Date(rec.startTime).toLocaleString();
            const card = document.createElement('div');
            card.dataset.recordingId = rec.id;
            card.className = 'group bg-gray-900 border border-gray-700/80 hover:border-gray-600 rounded-xl p-4 flex flex-col justify-between transition-all shadow-md';
            card.innerHTML = `
                <div>
                    <div class="flex items-center justify-between gap-2">
                        <span class="text-xs bg-gray-800 text-gray-200 px-2 py-0.5 rounded font-medium border border-gray-700 truncate max-w-[150px]">${rec.channelName}</span>
                        <span class="text-[11px] font-mono text-gray-400">${formatBytes(rec.fileSizeBytes)}</span>
                    </div>
                    <h4 class="font-bold text-white text-base mt-2.5 line-clamp-2 group-hover:text-blue-400 transition-colors" title="${rec.programTitle}">
                        ${rec.programTitle}
                    </h4>
                    <p class="text-xs text-gray-400 mt-1.5 flex items-center gap-1.5">
                        <svg class="w-3.5 h-3.5 text-gray-500" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
                        <span>${recordedOn}</span>
                    </p>
                    <div class="mt-2.5">
                        <span class="inline-block text-xs font-mono bg-blue-900/40 text-blue-300 px-2 py-0.5 rounded border border-blue-800/30">
                            Duration: ${formatDuration(rec.durationSeconds)}
                        </span>
                    </div>
                </div>

                <div class="flex items-center justify-between mt-4 pt-3 border-t border-gray-800">
                    <button class="play-recording-btn bg-blue-600 hover:bg-blue-500 text-white text-xs font-bold py-1.5 px-3 rounded flex items-center gap-1.5 transition-colors shadow">
                        <svg class="w-3.5 h-3.5 fill-current" viewBox="0 0 20 20"><polygon points="5 3 19 10 5 17 5 3"/></svg>
                        Play
                    </button>
                    <button class="delete-recording-btn text-gray-400 hover:text-red-400 p-1.5 transition-colors" title="Delete Recording">
                        ${ICONS.trash}
                    </button>
                </div>
            `;
            cardsContainer.appendChild(card);
        });
    }

    // Apply active view mode (table vs cards)
    const savedMode = dvrState.viewMode || localStorage.getItem('viniplay_dvr_view_mode') || 'table';
    setRecordingViewMode(savedMode, false);
}


/**
 * Renders the storage usage bar.
 */
function renderStorageBar(storageData) {
    if (!storageData) return;
    const { total, used, percentage } = storageData;
    const free = Math.max(0, total - used);
    if (UIElements.dvrStorageText) {
        UIElements.dvrStorageText.innerHTML = `<strong class="text-white font-mono">${formatBytes(used)}</strong> of <span class="font-mono">${formatBytes(total)}</span> used (<span class="text-emerald-400 font-medium">${formatBytes(free)} free</span>)`;
    }
    if (UIElements.dvrStoragePercentBadge) {
        UIElements.dvrStoragePercentBadge.textContent = `${percentage}% Used`;
    }
    if (UIElements.dvrStorageBar) {
        UIElements.dvrStorageBar.style.width = `${percentage}%`;
        UIElements.dvrStorageBar.classList.toggle('bg-red-600', percentage > 90);
        UIElements.dvrStorageBar.classList.toggle('bg-yellow-500', percentage > 75 && percentage <= 90);
        UIElements.dvrStorageBar.classList.toggle('bg-blue-600', percentage <= 75);
    }
    const container = document.getElementById('dvr-storage-bar-container');
    if (container) container.classList.remove('hidden');
}


/**
 * Switches the active tab in the main DVR card.
 */
export function switchDvrTab(tab) {
    dvrState.activeTab = tab;

    if (UIElements.dvrRecordingsContent) UIElements.dvrRecordingsContent.classList.toggle('hidden', tab !== 'recordings');
    if (UIElements.dvrScheduledContent) UIElements.dvrScheduledContent.classList.toggle('hidden', tab !== 'scheduled');
    if (UIElements.dvrHistoryContent) UIElements.dvrHistoryContent.classList.toggle('hidden', tab !== 'history');

    // Only display Table/Cards switcher on the Recordings tab
    const viewSwitcher = document.getElementById('dvr-view-switcher') || UIElements.dvrViewSwitcher;
    if (viewSwitcher) viewSwitcher.classList.toggle('hidden', tab !== 'recordings');

    const activeClasses = ['active', 'bg-blue-600', 'text-white'];
    const inactiveClasses = ['text-gray-300', 'hover:bg-gray-700'];

    const updateBtn = (btn, isActive) => {
        if (!btn) return;
        if (isActive) {
            btn.classList.add(...activeClasses);
            btn.classList.remove(...inactiveClasses);
        } else {
            btn.classList.remove(...activeClasses);
            btn.classList.add(...inactiveClasses);
        }
    };

    updateBtn(UIElements.dvrTabBtnRecordings, tab === 'recordings');
    updateBtn(UIElements.dvrTabBtnScheduled, tab === 'scheduled');
    updateBtn(UIElements.dvrTabBtnHistory, tab === 'history');
}


/**
 * Sets the view mode (table vs cards) for completed recordings.
 */
export function setRecordingViewMode(mode, save = true) {
    dvrState.viewMode = mode;
    if (save) localStorage.setItem('viniplay_dvr_view_mode', mode);

    const searchQuery = (dvrState.searchQuery || '').toLowerCase().trim();
    const recordings = dvrState.completedRecordings || [];
    const filteredRecordings = searchQuery ? recordings.filter(rec =>
        (rec.programTitle && rec.programTitle.toLowerCase().includes(searchQuery)) ||
        (rec.channelName && rec.channelName.toLowerCase().includes(searchQuery))
    ) : recordings;
    const hasRecordings = filteredRecordings.length > 0;

    const isTable = mode === 'table';
    if (UIElements.dvrRecordingsTableContainer) {
        UIElements.dvrRecordingsTableContainer.classList.toggle('hidden', !hasRecordings || !isTable);
    }
    if (UIElements.dvrRecordingsCardsContainer) {
        UIElements.dvrRecordingsCardsContainer.classList.toggle('hidden', !hasRecordings || isTable);
    }

    if (UIElements.dvrViewTableBtn && UIElements.dvrViewCardsBtn) {
        if (isTable) {
            UIElements.dvrViewTableBtn.className = 'px-2 py-1 rounded text-xs font-medium bg-blue-600 text-white flex items-center gap-1';
            UIElements.dvrViewCardsBtn.className = 'px-2 py-1 rounded text-xs font-medium text-gray-300 hover:text-white flex items-center gap-1';
        } else {
            UIElements.dvrViewTableBtn.className = 'px-2 py-1 rounded text-xs font-medium text-gray-300 hover:text-white flex items-center gap-1';
            UIElements.dvrViewCardsBtn.className = 'px-2 py-1 rounded text-xs font-medium bg-blue-600 text-white flex items-center gap-1';
        }
    }
}


/**
 * Toggles the collapsible manual timer recording drawer.
 */
export function toggleManualRecordingForm(force) {
    if (!UIElements.manualRecordingSection) return;
    const shouldShow = typeof force === 'boolean' ? force : UIElements.manualRecordingSection.classList.contains('hidden');
    UIElements.manualRecordingSection.classList.toggle('hidden', !shouldShow);
}

const toISOStringLocal = (localDateTimeString) => new Date(localDateTimeString).toISOString();
const fromISOStringToLocalDateTime = (isoString) => {
    const date = new Date(isoString);
    date.setMinutes(date.getMinutes() - date.getTimezoneOffset());
    return date.toISOString().slice(0, 16);
};

/**
 * NEW: Handles the channel selection logic specifically for the DVR page.
 * This function is exported and called by the central event listener in main.js.
 * @param {HTMLElement} channelItem - The clicked channel item element from the modal list.
 */
export function handleDvrChannelClick(channelItem) {
    const channelName = channelItem.dataset.name;
    const channelId = channelItem.dataset.id;

    // Update the UI and hidden form fields
    UIElements.manualRecSelectedChannelName.textContent = channelName;
    UIElements.manualRecChannelId.value = channelId;
    UIElements.manualRecChannelName.value = channelName;

    closeModal(UIElements.multiviewChannelSelectorModal);
}

export function setupDvrEventListeners() {
    // 1. Tab Switching
    UIElements.dvrTabBtnRecordings?.addEventListener('click', () => switchDvrTab('recordings'));
    UIElements.dvrTabBtnScheduled?.addEventListener('click', () => switchDvrTab('scheduled'));
    UIElements.dvrTabBtnHistory?.addEventListener('click', () => switchDvrTab('history'));

    // 2. View Mode Switcher (Table vs Cards)
    UIElements.dvrViewTableBtn?.addEventListener('click', () => setRecordingViewMode('table'));
    UIElements.dvrViewCardsBtn?.addEventListener('click', () => setRecordingViewMode('cards'));

    // 3. Collapsible Manual Recording Form Drawer
    UIElements.dvrToggleManualBtn?.addEventListener('click', () => toggleManualRecordingForm());
    UIElements.closeManualRecBtn?.addEventListener('click', () => toggleManualRecordingForm(false));

    // 4. Real-time Search Input
    UIElements.dvrSearchInput?.addEventListener('input', (e) => {
        dvrState.searchQuery = e.target.value;
        renderCompletedRecordings();
        renderScheduledJobs();
    });

    // 5. Live Hero Banner Actions (Event delegation for all active live recording cards)
    UIElements.dvrLiveHeroBanner?.addEventListener('click', async (e) => {
        const timeshiftBtn = e.target.closest('.dvr-live-timeshift-btn');
        if (timeshiftBtn) {
            const jobId = timeshiftBtn.dataset.jobId;
            const job = dvrState.scheduledJobs?.find(j => j.id == jobId);
            if (job) playTimeshiftStream(job);
            return;
        }

        const stopBtn = e.target.closest('.dvr-live-stop-btn');
        if (stopBtn) {
            const jobId = stopBtn.dataset.jobId;
            const job = dvrState.scheduledJobs?.find(j => j.id == jobId);
            const title = job ? ` "${job.programTitle}"` : '';
            showConfirm('Stop Recording?', `Are you sure you want to stop the live capture${title}?`, async () => {
                if (await apiFetch(`/api/dvr/jobs/${jobId}/stop`, { method: 'POST' })) {
                    showNotification('Recording stopped.');
                    await Promise.all([loadScheduledJobs(), loadCompletedRecordings()]);
                }
            });
            return;
        }
    });

    // 6. Scheduled Jobs Table click delegation
    UIElements.dvrJobsTbody?.addEventListener('click', async (e) => {
        const button = e.target.closest('button');
        if (!button) return;

        if (button.classList.contains('timeshift-play-btn')) {
            const jobId = button.dataset.jobId;
            const job = dvrState.scheduledJobs.find(j => j.id == jobId);
            if (job) {
                playTimeshiftStream(job);
            }
        } else if (button.classList.contains('go-to-guide-btn')) {
            const channelId = button.dataset.channelId;
            const bufferedStartIso = button.dataset.programStart;

            const jobId = button.closest('tr')?.dataset.jobId;
            const job = dvrState.scheduledJobs.find(j => j.id == jobId);

            if (!job) {
                console.error(`[DVR_DEBUG] Could not find job with ID ${jobId} in state.`);
                showNotification('An error occurred trying to find the program.', true);
                return;
            }

            let originalProgramStartIso = job.programStart;
            if (!originalProgramStartIso) {
                const preBufferMs = (job.preBufferMinutes || 0) * 60 * 1000;
                const originalProgramStart = new Date(new Date(bufferedStartIso).getTime() + preBufferMs);
                originalProgramStartIso = originalProgramStart.toISOString();
            }

            navigateToProgramInGuide(channelId, originalProgramStartIso);

        } else if (button.classList.contains('cancel-job-btn')) {
            const jobId = button.dataset.jobId;
            showConfirm('Cancel Recording?', 'Are you sure?', async () => {
                if (await apiFetch(`/api/dvr/jobs/${jobId}`, { method: 'DELETE' })) {
                    showNotification('Recording cancelled.');
                    await loadScheduledJobs();
                }
            });
        } else if (button.classList.contains('stop-recording-btn')) {
            const jobId = button.dataset.jobId;
            showConfirm('Stop Recording?', 'Are you sure?', async () => {
                if (await apiFetch(`/api/dvr/jobs/${jobId}/stop`, { method: 'POST' })) {
                    showNotification('Recording stopped.');
                    await Promise.all([loadScheduledJobs(), loadCompletedRecordings()]);
                }
            });
        } else if (button.classList.contains('view-error-btn')) {
            const jobId = button.dataset.jobId;
            const job = dvrState.scheduledJobs.find(j => j.id == jobId);
            if (job) {
                UIElements.dvrErrorModalTitle.textContent = `Error for: ${job.programTitle}`;
                UIElements.dvrErrorModalContent.textContent = job.errorMessage || 'No details.';
                openModal(UIElements.dvrErrorModal);
            }
        } else if (button.classList.contains('edit-job-btn')) {
            const jobId = button.dataset.jobId;
            const job = dvrState.scheduledJobs.find(j => j.id == jobId);
            if (job) {
                UIElements.dvrEditModalTitle.textContent = `Edit: ${job.programTitle}`;
                UIElements.dvrEditId.value = job.id;
                UIElements.dvrEditStart.value = fromISOStringToLocalDateTime(job.startTime);
                UIElements.dvrEditEnd.value = fromISOStringToLocalDateTime(job.endTime);
                openModal(UIElements.dvrEditModal);
            }
        } else if (button.classList.contains('delete-history-btn')) {
            const jobId = button.dataset.jobId;
            showConfirm('Remove From History?', 'This will not delete the file.', async () => {
                if (await apiFetch(`/api/dvr/jobs/${jobId}/history`, { method: 'DELETE' })) {
                    showNotification('Job removed from history.');
                    await loadScheduledJobs();
                }
            });
        }
    });

    // 7. Completed Recordings Table click delegation
    UIElements.dvrRecordingsTbody?.addEventListener('click', async (e) => {
        const row = e.target.closest('tr');
        if (!row) return;
        const recordingId = row.dataset.recordingId;
        const recording = dvrState.completedRecordings.find(r => r.id == recordingId);
        if (!recording) return;

        if (e.target.closest('.play-recording-btn')) {
            playCompletedRecording(recording);
        } else if (e.target.closest('.delete-recording-btn')) {
            showConfirm('Delete Recording?', `This will permanently delete the file.`, async () => {
                if (await apiFetch(`/api/dvr/recordings/${recordingId}`, { method: 'DELETE' })) {
                    showNotification('Recording deleted.');
                    loadCompletedRecordings();
                }
            });
        }
    });

    // 8. Completed Recordings Cards click delegation
    UIElements.dvrRecordingsCardsContainer?.addEventListener('click', async (e) => {
        const card = e.target.closest('[data-recording-id]');
        if (!card) return;
        const recordingId = card.dataset.recordingId;
        const recording = dvrState.completedRecordings.find(r => r.id == recordingId);
        if (!recording) return;

        if (e.target.closest('.play-recording-btn')) {
            playCompletedRecording(recording);
        } else if (e.target.closest('.delete-recording-btn')) {
            showConfirm('Delete Recording?', `This will permanently delete the file.`, async () => {
                if (await apiFetch(`/api/dvr/recordings/${recordingId}`, { method: 'DELETE' })) {
                    showNotification('Recording deleted.');
                    loadCompletedRecordings();
                }
            });
        }
    });

    // 9. History Table click delegation
    UIElements.dvrHistoryTbody?.addEventListener('click', async (e) => {
        const button = e.target.closest('button');
        if (!button) return;

        if (button.classList.contains('go-to-guide-btn')) {
            const channelId = button.dataset.channelId;
            const bufferedStartIso = button.dataset.programStart;
            const jobId = button.closest('tr')?.dataset.jobId;
            const job = dvrState.scheduledJobs.find(j => j.id == jobId);
            if (!job) return;

            let originalProgramStartIso = job.programStart;
            if (!originalProgramStartIso) {
                const preBufferMs = (job.preBufferMinutes || 0) * 60 * 1000;
                const originalProgramStart = new Date(new Date(bufferedStartIso).getTime() + preBufferMs);
                originalProgramStartIso = originalProgramStart.toISOString();
            }
            navigateToProgramInGuide(channelId, originalProgramStartIso);
        } else if (button.classList.contains('view-error-btn')) {
            const jobId = button.dataset.jobId;
            const job = dvrState.scheduledJobs.find(j => j.id == jobId);
            if (job) {
                UIElements.dvrErrorModalTitle.textContent = `Error for: ${job.programTitle}`;
                UIElements.dvrErrorModalContent.textContent = job.errorMessage || 'No details.';
                openModal(UIElements.dvrErrorModal);
            }
        } else if (button.classList.contains('delete-history-btn')) {
            const jobId = button.dataset.jobId;
            showConfirm('Remove From History?', 'This will not delete the file.', async () => {
                if (await apiFetch(`/api/dvr/jobs/${jobId}/history`, { method: 'DELETE' })) {
                    showNotification('Job removed from history.');
                    await loadScheduledJobs();
                }
            });
        }
    });

    UIElements.dvrErrorModalCloseBtn.addEventListener('click', () => closeModal(UIElements.dvrErrorModal));
    UIElements.dvrEditCancelBtn.addEventListener('click', () => closeModal(UIElements.dvrEditModal));

    UIElements.dvrEditForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        const jobId = UIElements.dvrEditId.value;
        const body = {
            startTime: toISOStringLocal(UIElements.dvrEditStart.value),
            endTime: toISOStringLocal(UIElements.dvrEditEnd.value)
        };
        const res = await apiFetch(`/api/dvr/jobs/${jobId}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body)
        });
        if (res && res.ok) {
            showNotification('Schedule updated.');
            closeModal(UIElements.dvrEditModal);
            await loadScheduledJobs();
        }
    });

    UIElements.manualRecordingForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        const channelId = UIElements.manualRecChannelId.value;
        const channelName = UIElements.manualRecChannelName.value;
        const startTime = UIElements.manualRecStart.value;
        const endTime = UIElements.manualRecEnd.value;

        if (!channelId || !startTime || !endTime) {
            return showNotification('Please fill out all fields for manual recording.', true);
        }
        if (new Date(endTime) <= new Date(startTime)) {
            return showNotification('End time must be after the start time.', true);
        }

        const body = {
            channelId,
            channelName,
            startTime: toISOStringLocal(startTime),
            endTime: toISOStringLocal(endTime),
        };

        const res = await apiFetch('/api/dvr/schedule/manual', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body)
        });

        if (res) {
            if (res.ok) {
                showNotification('Manual recording scheduled successfully.');
                UIElements.manualRecordingForm.reset();
                UIElements.manualRecSelectedChannelName.textContent = 'No channel selected';
                UIElements.manualRecChannelId.value = '';
                UIElements.manualRecChannelName.value = '';
                toggleManualRecordingForm(false);
                await loadScheduledJobs();
            } else if (res.status === 409) {
                const conflictData = await res.json();
                showConflictModal(conflictData);
            }
        }
    });

    if (UIElements.manualRecChannelSelectBtn) {
        UIElements.manualRecChannelSelectBtn.addEventListener('click', () => {
            document.body.dataset.channelSelectorContext = 'dvr';
            populateChannelSelector();
            openModal(UIElements.multiviewChannelSelectorModal);
        });
    }

    // 10. Clear All / History Buttons
    UIElements.clearScheduledDvrBtn?.addEventListener('click', () => {
        showConfirm(
            'Clear Scheduled Jobs?',
            'This will cancel all upcoming scheduled recordings. This action cannot be undone.',
            async () => {
                const upcomingJobs = (dvrState.scheduledJobs || []).filter(j => j.status === 'scheduled');
                if (upcomingJobs.length === 0) return;
                const promises = upcomingJobs.map(j => apiFetch(`/api/dvr/jobs/${j.id}`, { method: 'DELETE' }));
                await Promise.all(promises);
                showNotification('All upcoming scheduled jobs have been cancelled.');
                await loadScheduledJobs();
            }
        );
    });

    UIElements.clearHistoryDvrBtn?.addEventListener('click', () => {
        showConfirm(
            'Clear History?',
            'This will delete all completed, error, and cancelled jobs from your history log. This action cannot be undone and will not delete recorded files.',
            async () => {
                const historyJobs = (dvrState.scheduledJobs || []).filter(j => ['completed', 'error', 'cancelled'].includes(j.status));
                if (historyJobs.length === 0) return;
                const promises = historyJobs.map(j => apiFetch(`/api/dvr/jobs/${j.id}/history`, { method: 'DELETE' }));
                await Promise.all(promises);
                showNotification('DVR history has been cleared.');
                await loadScheduledJobs();
            }
        );
    });

    UIElements.clearCompletedDvrBtn?.addEventListener('click', () => {
        showConfirm(
            'Clear All Recordings?',
            'This will permanently delete all completed recording files and remove them from your history. This action cannot be undone.',
            async () => {
                const res = await apiFetch('/api/dvr/recordings/all', { method: 'DELETE' });
                if (res && res.ok) {
                    showNotification('All completed recordings have been deleted.');
                    await loadCompletedRecordings();
                }
            }
        );
    });
}

export function findDvrJobForProgram(program) {
    const programStart = new Date(program.start).getTime();
    const programStop = new Date(program.stop).getTime();
    return dvrState.scheduledJobs.find(job => {
        if (job.channelId !== program.channelId) return false;
        if (job.programStart) {
            return Math.abs(new Date(job.programStart).getTime() - programStart) < 60000;
        }
        const jobProgramStart = new Date(job.startTime).getTime() + ((job.preBufferMinutes || 0) * 60000);
        const jobProgramStop = new Date(job.endTime).getTime() - ((job.postBufferMinutes || 0) * 60000);
        return Math.abs(jobProgramStart - programStart) < 60000 &&
            Math.abs(jobProgramStop - programStop) < 60000;
    });
}

export async function addOrRemoveDvrJob(programData) {
    const existingJob = findDvrJobForProgram(programData);

    if (existingJob && existingJob.status === 'scheduled') {
        showConfirm('Cancel Recording?', 'Are you sure?', async () => {
            if (await apiFetch(`/api/dvr/jobs/${existingJob.id}`, { method: 'DELETE' })) {
                showNotification('Recording cancelled.');
                await loadScheduledJobs();
                handleSearchAndFilter(false, true);
            }
        });
    } else if (!existingJob) {
        const body = {
            channelId: programData.channelId,
            channelName: guideState.channels.find(c => c.id === programData.channelId)?.name || 'Unknown',
            programTitle: programData.title,
            programStart: programData.start,
            programStop: programData.stop
        };
        const res = await apiFetch('/api/dvr/schedule', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body)
        });

        if (res) {
            if (res.ok) {
                showNotification(`"${programData.title}" scheduled to record.`);
                await loadScheduledJobs();
                handleSearchAndFilter(false, true);
            } else if (res.status === 409) {
                const conflictData = await res.json();
                showConflictModal(conflictData);
            }
        }
    }
}

/**
 * NEW: Displays a modal showing recording conflicts.
 * @param {object} conflictData - The conflict data from the server.
 */
function showConflictModal(conflictData) {
    const { newJob, conflictingJobs } = conflictData;
    let conflictList = '';
    conflictingJobs.forEach(job => {
        conflictList += `<li class="text-sm">- ${job.programTitle} on ${job.channelName}</li>`;
    });

    const message = `
        Could not schedule "${newJob.programTitle}".
        <br><br>
        Your maximum number of simultaneous recordings would be exceeded.
        It conflicts with the following scheduled recording(s):
        <ul class="list-disc list-inside mt-2 text-gray-400">
            ${conflictList}
        </ul>
    `;

    // A simple confirm modal will be used for now. A more complex modal could be added later.
    showConfirm('Recording Conflict', message, () => { });
}

function formatBytes(bytes) {
    if (!bytes || bytes === 0) return '0 Bytes';
    const k = 1024;
    const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

function formatDuration(totalSeconds) {
    if (!totalSeconds || totalSeconds <= 0) return '0s';
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = Math.floor(totalSeconds % 60);
    let result = '';
    if (hours > 0) result += `${hours}h `;
    if (minutes > 0) result += `${minutes}m `;
    if (seconds > 0 && hours === 0) result += `${seconds}s`;
    return result.trim() || '0s';
}
