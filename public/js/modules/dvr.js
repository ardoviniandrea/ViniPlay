/**
 * dvr.js
 * Manages all client-side functionality for the DVR page.
 */

import { UIElements, dvrState, guideState, appState } from './state.js';
import { apiFetch } from './api.js';
import { showNotification, showConfirm, openModal, closeModal } from './ui.js';
import { handleSearchAndFilter } from './guide.js';
// MODIFIED: Import the corrected navigation function from notification.js
import { navigateToProgramInGuide } from './notification.js';
// MODIFIED: Import channel selector populator from multiview
import { populateChannelSelector } from './multiview.js';
import { ICONS } from './icons.js'; // MODIFIED: Import the new icon library
import { stopAndCleanupPlayer } from './player.js'; // **NEW: Import main player cleanup function**

/**
 * Initializes the DVR page by fetching all required data from the backend.
 * MODIFIED: Now handles visibility of sections based on user permissions.
 */
export async function initDvrPage() {
    console.log('[DVR] Initializing DVR page...');
    const hasDvrPermission = appState.currentUser?.isAdmin || appState.currentUser?.canUseDvr;

    // Toggle visibility of DVR sections based on user permissions
    const manualRecSection = document.getElementById('manual-recording-section');
    const scheduledSection = document.getElementById('scheduled-recordings-section');

    if (manualRecSection) manualRecSection.classList.toggle('hidden', !hasDvrPermission);
    if (scheduledSection) scheduledSection.classList.toggle('hidden', !hasDvrPermission);

    const promises = [
        loadCompletedRecordings(),
        loadStorageInfo()
    ];

    if (hasDvrPermission) {
        promises.push(loadScheduledJobs());
    } else {
        // Explicitly hide these elements if user has no DVR permission
        UIElements.noDvrJobsMessage.classList.add('hidden');
        UIElements.dvrJobsTableContainer.classList.add('hidden');
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
async function playTimeshiftStream(job) {
    if (!job) return;

    // Use the main player modal for timeshifting
    const playerModal = UIElements.videoModal;
    const videoElement = UIElements.videoElement;
    const videoTitle = UIElements.videoTitle;

    // 1. Stop any existing stream in the main player
    await stopAndCleanupPlayer();

    const streamUrl = `/api/dvr/timeshift/${job.id}`;
    console.log(`[DVR_TIMESHIFT] Starting playback for URL: ${streamUrl}`);
    videoTitle.textContent = `${job.programTitle} (Recording...)`;

    if (mpegts.isSupported()) {
        // 2. Create and configure the mpegts.js player
        const mpegtsConfig = {
            enableStashBuffer: true,
            stashInitialSize: 4096,
            isLive: true, // Treat it as a live stream
        };

        appState.player = mpegts.createPlayer({
            type: 'mse',
            isLive: true,
            url: streamUrl
        }, mpegtsConfig);

        // 3. Attach and play
        appState.player.attachMediaElement(videoElement);
        appState.player.load();
        appState.player.play().catch((err) => {
            console.error("MPEGTS Player Error (Timeshift):", err);
            showNotification("Could not play timeshift stream.", true);
            stopAndCleanupPlayer();
        });

        // 4. Open the main player modal
        openModal(playerModal);

    } else {
        showNotification('Your browser does not support MSE, which is required for timeshifting.', true);
    }
}

/**
 * Plays a completed .ts recording file using the main mpegts.js player.
 * @param {object} recording - The completed recording object.
 */
async function playCompletedTsFile(recording) {
    if (!recording) return;

    // Use the main player modal for TS files for a consistent experience
    const playerModal = UIElements.videoModal;
    const videoElement = UIElements.videoElement;
    const videoTitle = UIElements.videoTitle;

    await stopAndCleanupPlayer(); // Clean up main player first

    const streamUrl = `/dvr/${recording.filename}`;
    console.log(`[DVR_PLAYBACK] Starting playback for completed TS file: ${streamUrl}`);
    videoTitle.textContent = recording.programTitle;

    if (mpegts.isSupported()) {
        // --- FIX FOR VOD SEEKING & BUFFERING ---
        // This configuration is optimized for playing back large, static .ts files (VOD).
        const mpegtsConfig = {
            isLive: false,
            // Automatically clean up the source buffer as the video plays.
            // This is the most critical setting to prevent "SourceBuffer is full" errors.
            autoCleanupSourceBuffer: true,
            // Disable lazy loading to build a complete seek table upfront. This makes seeking reliable.
            lazyLoad: false,
            // Use HTTP Range requests for seeking, which is ideal for static files.
            seekType: 'range',
            // Increase the initial buffer size significantly to handle high-bitrate files
            // and allow for immediate seeking without buffering issues.
            stashInitialSize: 128 * 1024 * 1024, // 128MB buffer
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


/**
 * Renders the table of scheduled and in-progress recording jobs.
 * MODIFIED: Now includes a "User" column for admins.
 */
function renderScheduledJobs() {
    const jobs = dvrState.scheduledJobs || [];
    const hasJobs = jobs.length > 0;
    const isAdmin = appState.currentUser?.isAdmin;

    // Toggle visibility of the entire table container vs the message
    UIElements.noDvrJobsMessage.classList.toggle('hidden', hasJobs);
    UIElements.dvrJobsTableContainer.classList.toggle('hidden', !hasJobs);

    // Show/hide the "Clear All" button
    UIElements.clearScheduledDvrBtn.classList.toggle('hidden', !hasJobs);

    // MODIFIED: Show/hide the user column header
    const userHeader = UIElements.dvrJobsTableContainer.querySelector('th.user-col');
    if (userHeader) userHeader.classList.toggle('hidden', !isAdmin);

    const tbody = UIElements.dvrJobsTbody;
    tbody.innerHTML = '';

    jobs.forEach(job => {
        const startTime = new Date(job.startTime).toLocaleString();
        const endTime = new Date(job.endTime).toLocaleString();

        const statusHTML = job.status === 'error' && job.errorMessage
            ? `<button class="status-badge ${job.status} view-error-btn" data-job-id="${job.id}">${job.status}</button>`
            : `<span class="status-badge ${job.status}">${job.status}</span>`;

        const conflictIcon = job.isConflicting ?
            `<svg class="h-5 w-5 text-yellow-400" fill="currentColor" viewBox="0 0 20 20" title="This recording conflicts with another scheduled recording."><path fill-rule="evenodd" d="M8.257 3.099c.765-1.36 2.722-1.36 3.486 0l5.58 9.92c.75 1.334-.21 3.03-1.742 3.03H4.42c-1.532 0-2.492-1.696-1.742-3.03l5.58-9.92zM10 13a1 1 0 110-2 1 1 0 010 2zm-1.75-5.25a.75.75 0 00-1.5 0v3.5a.75.75 0 001.5 0v-3.5z" clip-rule="evenodd" /></svg>` : '';

        const isTimeshiftable = job.filePath && job.filePath.endsWith('.ts');
        const playButtonHTML = (job.status === 'recording' && isTimeshiftable) ? `
            <button class="action-btn timeshift-play-btn text-blue-400 hover:text-blue-300" title="Play Recording (Timeshift)" data-job-id="${job.id}">
                ${ICONS.play}
            </button>
        ` : '';

        // MODIFIED: Add user column conditionally for admins
        const userColumn = isAdmin ? `<td>${job.username || 'N/A'}</td>` : '';

        const tr = document.createElement('tr');
        tr.dataset.jobId = job.id;
        tr.innerHTML = `
            <td class="max-w-xs truncate" title="${job.programTitle}">${job.programTitle}</td>
            <td class="max-w-xs truncate" title="${job.channelName}">${job.channelName}</td>
            ${userColumn}
            <td>${startTime}</td>
            <td>${endTime}</td>
            <td>${statusHTML}</td>
            <td class="text-center">${conflictIcon}</td>
            <td class="text-right">
                <div class="flex items-center justify-end gap-3">
                    ${playButtonHTML}
                    ${job.status === 'recording' ? `
                        <button class="action-btn stop-recording-btn text-red-500 hover:text-red-400" title="Stop Recording" data-job-id="${job.id}">
                            ${ICONS.stopRec}
                        </button>
                    ` : ''}
                     <button class="action-btn go-to-guide-btn" title="View in TV Guide" data-channel-id="${job.channelId}" data-program-start="${job.startTime}">
                        ${ICONS.goToGuide}
                    </button>
                    ${job.status === 'scheduled' ? `
                        <button class="action-btn edit-job-btn" title="Edit Schedule" data-job-id="${job.id}">
                            ${ICONS.edit}
                        </button>
                    ` : ''}
                    <button class="action-btn ${['error', 'cancelled', 'completed'].includes(job.status) ? 'delete-history-btn' : 'cancel-job-btn'}" title="${['error', 'cancelled', 'completed'].includes(job.status) ? 'Remove From History' : 'Cancel Recording'}" data-job-id="${job.id}" ${job.status === 'recording' ? 'disabled' : ''}>
                        ${ICONS.cancel}
                    </button>
                </div>
            </td>
        `;
        tbody.appendChild(tr);
    });
}



/**
 * Renders the table of completed recordings.
 * MODIFIED: Now includes a "User" column visible to everyone.
 */
function renderCompletedRecordings() {
    const recordings = dvrState.completedRecordings || [];
    const hasRecordings = recordings.length > 0;
    const isAdmin = appState.currentUser?.isAdmin;

    // Toggle visibility of the entire table container vs the message
    UIElements.noDvrRecordingsMessage.classList.toggle('hidden', hasRecordings);
    UIElements.dvrRecordingsTableContainer.classList.toggle('hidden', !hasRecordings);

    // Show/hide the "Clear All" button only if user has DVR permission
    const hasDvrPermission = appState.currentUser?.isAdmin || appState.currentUser?.canUseDvr;
    UIElements.clearCompletedDvrBtn.classList.toggle('hidden', !hasRecordings || !hasDvrPermission);

    const tbody = UIElements.dvrRecordingsTbody;
    tbody.innerHTML = '';

    recordings.forEach(rec => {
        const recordedOn = new Date(rec.startTime).toLocaleString();

        // MODIFIED: Admins can see who made the recording
        const userColumn = isAdmin ? `<td class="max-w-xs truncate" title="${rec.username}">${rec.username}</td>` : '';

        const tr = document.createElement('tr');
        tr.dataset.recordingId = rec.id;
        tr.innerHTML = `
            <td class="max-w-xs truncate" title="${rec.programTitle}">${rec.programTitle}</td>
            <td class="max-w-xs truncate" title="${rec.channelName}">${rec.channelName}</td>
            ${userColumn}
            <td>${recordedOn}</td>
            <td>${formatDuration(rec.durationSeconds)}</td>
            <td>${formatBytes(rec.fileSizeBytes)}</td>
            <td class="text-right">
                <div class="flex items-center justify-end gap-3">
                    <button class="action-btn play-recording-btn" title="Play Recording">
                        ${ICONS.play}
                    </button>
                    <button class="action-btn delete-recording-btn" title="Delete Recording">
                        ${ICONS.trash}
                    </button>
                </div>
            </td>
        `;
        tbody.appendChild(tr);
    });
}


/**
 * NEW: Renders the storage usage bar.
 * @param {object} storageData - Object with total, used, and percentage properties.
 */
function renderStorageBar(storageData) {
    const { total, used, percentage } = storageData;
    UIElements.dvrStorageText.textContent = `${formatBytes(used)} of ${formatBytes(total)} used`;
    UIElements.dvrStorageBar.style.width = `${percentage}%`;
    UIElements.dvrStorageBar.classList.toggle('bg-red-600', percentage > 90);
    UIElements.dvrStorageBar.classList.toggle('bg-yellow-500', percentage > 75 && percentage <= 90);
    UIElements.dvrStorageBar.classList.toggle('bg-blue-600', percentage <= 75);
    UIElements.dvrStorageBarContainer.classList.remove('hidden');
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
    UIElements.dvrJobsTbody.addEventListener('click', async (e) => {
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

            const preBufferMs = (job.preBufferMinutes || 0) * 60 * 1000;
            const originalProgramStart = new Date(new Date(bufferedStartIso).getTime() + preBufferMs);
            const originalProgramStartIso = originalProgramStart.toISOString();

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

    UIElements.dvrRecordingsTbody.addEventListener('click', async (e) => {
        const row = e.target.closest('tr');
        if (!row) return;
        const recordingId = row.dataset.recordingId;
        const recording = dvrState.completedRecordings.find(r => r.id == recordingId);
        if (!recording) return;

        if (e.target.closest('.play-recording-btn')) {
            // **MODIFIED: Check file type and use the appropriate player**
            if (recording.filename && recording.filename.endsWith('.ts')) {
                playCompletedTsFile(recording);
            } else {
                // Use the original, simpler player for non-ts files like .mp4
                UIElements.recordingTitle.textContent = recording.programTitle;
                UIElements.recordingVideoElement.src = `/dvr/${recording.filename}`;
                openModal(UIElements.recordingPlayerModal);
            }
        } else if (e.target.closest('.delete-recording-btn')) {
            showConfirm('Delete Recording?', `This will permanently delete the file.`, async () => {
                if (await apiFetch(`/api/dvr/recordings/${recordingId}`, { method: 'DELETE' })) {
                    showNotification('Recording deleted.');
                    loadCompletedRecordings();
                }
            });
        }
    });

    UIElements.closeRecordingPlayerBtn.addEventListener('click', () => {
        UIElements.recordingVideoElement.pause();
        UIElements.recordingVideoElement.src = '';
        closeModal(UIElements.recordingPlayerModal);
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

    // NEW: Event listeners for the "Clear All" buttons
    UIElements.clearScheduledDvrBtn.addEventListener('click', () => {
        showConfirm(
            'Clear All Jobs?',
            'This will delete all scheduled, completed, and error jobs from your history. This action cannot be undone and will not delete recorded files.',
            async () => {
                const res = await apiFetch('/api/dvr/jobs/all', { method: 'DELETE' });
                if (res && res.ok) {
                    showNotification('All scheduled jobs have been cleared.');
                    await loadScheduledJobs();
                }
            }
        );
    });

    UIElements.clearCompletedDvrBtn.addEventListener('click', () => {
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
        const jobProgramStart = new Date(job.startTime).getTime() + (job.preBufferMinutes * 60000);
        const jobProgramStop = new Date(job.endTime).getTime() - (job.postBufferMinutes * 60000);
        return job.channelId === program.channelId &&
            Math.abs(jobProgramStart - programStart) < 60000 &&
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
    if (!totalSeconds) return '0m';
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    let result = '';
    if (hours > 0) result += `${hours}h `;
    if (minutes > 0) result += `${minutes}m`;
    return result.trim() || '0m';
}
