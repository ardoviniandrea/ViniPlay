/**
 * admin.js
 * Manages all client-side functionality for the admin Activity page.
 * -- ENHANCEMENT: This file has been significantly updated to support real-time updates,
 * history filtering, and advanced admin actions like changing a user's channel.
 */

import { UIElements, guideState, adminState } from './state.js';
import { apiFetch, saveUserSetting } from './api.js';
import { showNotification, showConfirm, openModal } from './ui.js';
import { ICONS } from './icons.js';
//-- ENHANCEMENT: Import channel selector functions from multiview.js to reuse the modal.
import { populateChannelSelector } from './multiview.js';


/**
 * Initializes the Activity page by fetching data and setting up listeners.
 */
export async function initActivityPage() {
    console.log('[ADMIN] Initializing Admin Dashboard...');
    
    // Stop any existing health check interval
    if (adminState.healthCheckInterval) {
        clearInterval(adminState.healthCheckInterval);
    }

    // Set default values for date filters
    const today = new Date().toISOString().split('T')[0];
    if (UIElements.historyDateEnd) UIElements.historyDateEnd.value = today;

    // Reset pagination and set page size from saved settings
    adminState.pagination.currentPage = 1;
    adminState.pagination.pageSize = guideState.settings.adminPageSize || 25;
    UIElements.historyPageSizeSelect.value = adminState.pagination.pageSize;
    
    // Initial data load
    await loadActivityData();
    await renderDashboardWidgets();

    // Start polling for system health
    adminState.healthCheckInterval = setInterval(renderHealthWidget, 5000); // Refresh every 5 seconds
}


/**
 * Fetches both live and historical activity data from the server based on current filters and pagination.
 */
async function loadActivityData() {
    const { currentPage, pageSize } = adminState.pagination;
    const search = UIElements.historySearchInput.value.trim();
    const dateFilter = UIElements.historyDateFilter.value;
    const startDate = UIElements.historyDateStart.value;
    const endDate = UIElements.historyDateEnd.value;

    const query = new URLSearchParams({
        page: currentPage,
        pageSize,
        search,
        dateFilter,
        startDate,
        endDate
    });

    const res = await apiFetch(`/api/admin/activity?${query.toString()}`);
    if (res && res.ok) {
        const data = await res.json();
        adminState.live = data.live || [];
        adminState.history = data.history.items || [];
        
        // Update pagination state
        adminState.pagination.totalPages = data.history.totalPages;
        adminState.pagination.totalItems = data.history.totalItems;

        renderLiveActivity();
        renderWatchHistory();
        renderPaginationControls();
    } else {
        showNotification('Could not load activity data.', true);
        UIElements.noLiveActivityMessage.classList.remove('hidden');
        UIElements.noWatchHistoryMessage.classList.remove('hidden');
    }
}

/**
 * Handles real-time updates for live activity pushed from the server.
 * @param {Array} liveActivityData - The new list of live streams.
 */
export function handleActivityUpdate(liveActivityData) {
    console.log('[ADMIN_SSE] Received real-time activity update.');
    adminState.live = liveActivityData || [];
    renderLiveActivity();
    // Update the live viewer count widget
    if (UIElements.statCurrentViewers) {
        UIElements.statCurrentViewers.textContent = adminState.live.length;
    }
}

/**
 * Fetches and renders all dashboard widgets (analytics and health).
 */
async function renderDashboardWidgets() {
    renderHealthWidget(); // Initial call
    
    // Fetch analytics data
    const res = await apiFetch('/api/admin/analytics');
    if (res && res.ok) {
        const analytics = await res.json();
        renderAnalyticsWidgets(analytics);
    }
}

/**
 * Renders the server health widget with CPU, RAM, and Disk info.
 */
async function renderHealthWidget() {
    const res = await apiFetch('/api/admin/system-health');
    if (res && res.ok) {
        const health = await res.json();
        UIElements.statCpuHealth.innerHTML = `<span class="text-gray-500">CPU:</span> <span class="font-mono ml-1">${health.cpu.load}%</span>`;
        UIElements.statRamHealth.innerHTML = `<span class="text-gray-500">RAM:</span> <span class="font-mono ml-1">${health.memory.percent}% (${formatBytes(health.memory.used)} / ${formatBytes(health.memory.total)})</span>`;
        UIElements.statDvrDiskHealth.innerHTML = `<span class="text-gray-500">DVR Disk:</span><span class="font-mono ml-1">${health.disks.dvr.percent}% (${formatBytes(health.disks.dvr.used)} / ${formatBytes(health.disks.dvr.total)})</span>`;
    }
}

/**
 * Renders the analytics widgets (Top Channels, Top Users).
 * @param {object} analytics - The analytics data from the server.
 */
function renderAnalyticsWidgets(analytics) {
    const topChannelsEl = UIElements.statTopChannels;
    const topUsersEl = UIElements.statTopUsers;

    if (analytics.topChannels.length > 0) {
        topChannelsEl.innerHTML = analytics.topChannels.map(c => `
            <div class="flex justify-between items-center">
                <span class="truncate" title="${c.channel_name}">${c.channel_name}</span>
                <span class="font-mono text-gray-400">${formatDuration(c.total_duration, true)}</span>
            </div>
        `).join('');
    } else {
        topChannelsEl.innerHTML = `<p class="text-gray-500">No watch history yet.</p>`;
    }
    
    if (analytics.topUsers.length > 0) {
        topUsersEl.innerHTML = analytics.topUsers.map(u => `
            <div class="flex justify-between items-center">
                <span class="truncate" title="${u.username}">${u.username}</span>
                <span class="font-mono text-gray-400">${formatDuration(u.total_duration, true)}</span>
            </div>
        `).join('');
    } else {
        topUsersEl.innerHTML = `<p class="text-gray-500">No watch history yet.</p>`;
    }
}


/**
 * Renders the table of currently active streams.
 */
function renderLiveActivity() {
    const tbody = UIElements.liveActivityTbody;
    const hasLiveStreams = adminState.live.length > 0;

    UIElements.noLiveActivityMessage.classList.toggle('hidden', hasLiveStreams);
    UIElements.liveActivityTableContainer.classList.toggle('hidden', !hasLiveStreams);
    if (UIElements.statCurrentViewers) {
        UIElements.statCurrentViewers.textContent = adminState.live.length;
    }

    if (!tbody) return;
    tbody.innerHTML = '';

    adminState.live.forEach(stream => {
        const tr = document.createElement('tr');
        tr.dataset.streamKey = stream.streamKey;
        tr.dataset.userId = stream.userId; // Store userId for actions

        const transcodeIndicator = stream.isTranscoded 
            ? `<span class="transcode-indicator bg-orange-400" title="Transcoding with FFmpeg"></span>`
            : `<span class="transcode-indicator bg-green-400" title="Direct Redirect"></span>`;

        // Use image proxy for channel logos
        const channelLogo = stream.channelLogo && stream.channelLogo.startsWith('http')
            ? `/api/image-proxy?url=${encodeURIComponent(stream.channelLogo)}`
            : stream.channelLogo || 'https://placehold.co/40x40/1f2937/d1d5db?text=?';

        tr.innerHTML = `
            <td><span class="clickable-username" title="Filter history for this user">${stream.username}</span></td>
            <td>${stream.clientIp || 'N/A'}</td>
            <td>
                <div class="flex items-center gap-3">
                    <img src="${channelLogo}" 
                         onerror="this.onerror=null; this.src='https://placehold.co/40x40/1f2937/d1d5db?text=?';" 
                         class="w-10 h-10 object-contain rounded-md bg-gray-700 flex-shrink-0" 
                         alt="Channel Logo">
                    <span class="truncate" title="${stream.channelName}">${stream.channelName}</span>
                </div>
            </td>
            <td>${stream.streamProfileName || 'N/A'}</td>
            <td class="text-center">${transcodeIndicator}</td>
            <td>${new Date(stream.startTime).toLocaleString()}</td>
            <td class="live-duration" data-start-time="${stream.startTime}">-</td>
            <td class="text-right">
                <div class="flex items-center justify-end gap-3">
                    <button class="action-btn change-stream-btn text-blue-400 hover:text-blue-300" title="Change User's Channel">
                        <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8 7h12m0 0l-4-4m4 4l-4 4m0 6H4m0 0l4 4m-4-4l4-4"></path></svg>
                    </button>
                    <button class="action-btn stop-stream-btn text-red-500 hover:text-red-400" title="Stop Stream">
                        ${ICONS.stopRec}
                    </button>
                </div>
            </td>
        `;
        tbody.appendChild(tr);
    });

    updateLiveDurations();
    if (adminState.liveDurationInterval) clearInterval(adminState.liveDurationInterval);
    if (hasLiveStreams) {
        adminState.liveDurationInterval = setInterval(updateLiveDurations, 1000);
    }
}

/**
 * Renders the table of historical watch sessions based on the current state.
 */
function renderWatchHistory() {
    const history = adminState.history;
    const tbody = UIElements.watchHistoryTbody;
    const hasHistory = history.length > 0;

    UIElements.noWatchHistoryMessage.classList.toggle('hidden', hasHistory);
    UIElements.watchHistoryTableContainer.classList.toggle('hidden', !hasHistory);

    if (!tbody) return;
    tbody.innerHTML = '';

    history.forEach(entry => {
        const tr = document.createElement('tr');
        // Use image proxy for channel logos
        const channelLogo = entry.channel_logo && entry.channel_logo.startsWith('http')
            ? `/api/image-proxy?url=${encodeURIComponent(entry.channel_logo)}`
            : entry.channel_logo || 'https://placehold.co/40x40/1f2937/d1d5db?text=?';
        tr.innerHTML = `
            <td><span class="clickable-username" title="Filter history for this user">${entry.username}</span></td>
            <td>${entry.client_ip || 'N/A'}</td>
            <td>
                <div class="flex items-center gap-3">
                    <img src="${channelLogo}" 
                         onerror="this.onerror=null; this.src='https://placehold.co/40x40/1f2937/d1d5db?text=?';" 
                         class="w-10 h-10 object-contain rounded-md bg-gray-700 flex-shrink-0" 
                         alt="Channel Logo">
                    <span class="truncate" title="${entry.channel_name}">${entry.channel_name}</span>
                </div>
            </td>
            <td>${entry.stream_profile_name || 'N/A'}</td>
            <td>${new Date(entry.start_time).toLocaleString()}</td>
            <td>${entry.end_time ? new Date(entry.end_time).toLocaleString() : 'N/A'}</td>
            <td>${formatDuration(entry.duration_seconds)}</td>
        `;
        tbody.appendChild(tr);
    });
}

/**
 * Renders the pagination controls for the history table.
 */
function renderPaginationControls() {
    const { currentPage, totalPages, totalItems, pageSize } = adminState.pagination;
    const controlsEl = UIElements.historyPaginationControls;
    const pagesEl = UIElements.historyPaginationPages;
    const infoEl = UIElements.historyPaginationInfo;

    if (totalPages <= 1) {
        controlsEl.classList.add('hidden');
        return;
    }
    controlsEl.classList.remove('hidden');

    const startItem = (currentPage - 1) * pageSize + 1;
    const endItem = Math.min(startItem + pageSize - 1, totalItems);
    infoEl.textContent = `Showing ${startItem}-${endItem} of ${totalItems}`;

    let pagesHTML = '';
    // Previous button
    pagesHTML += `<li><button class="pagination-btn" data-page="${currentPage - 1}" ${currentPage === 1 ? 'disabled' : ''}>Prev</button></li>`;

    // Page number buttons
    const maxPagesToShow = 5;
    let startPage = Math.max(1, currentPage - Math.floor(maxPagesToShow / 2));
    let endPage = Math.min(totalPages, startPage + maxPagesToShow - 1);
    
    if (endPage - startPage + 1 < maxPagesToShow) {
        startPage = Math.max(1, endPage - maxPagesToShow + 1);
    }
    
    if (startPage > 1) {
        pagesHTML += `<li><button class="pagination-btn" data-page="1">1</button></li>`;
        if (startPage > 2) pagesHTML += `<li><span class="pagination-btn">...</span></li>`;
    }

    for (let i = startPage; i <= endPage; i++) {
        pagesHTML += `<li><button class="pagination-btn ${i === currentPage ? 'active' : ''}" data-page="${i}">${i}</button></li>`;
    }

    if (endPage < totalPages) {
        if (endPage < totalPages - 1) pagesHTML += `<li><span class="pagination-btn">...</span></li>`;
        pagesHTML += `<li><button class="pagination-btn" data-page="${totalPages}">${totalPages}</button></li>`;
    }

    // Next button
    pagesHTML += `<li><button class="pagination-btn" data-page="${currentPage + 1}" ${currentPage === totalPages ? 'disabled' : ''}>Next</button></li>`;

    pagesEl.innerHTML = pagesHTML;
}

/**
 * Sets up event listeners for the Activity page.
 */
export function setupAdminEventListeners() {
    UIElements.refreshActivityBtn?.addEventListener('click', () => {
        initActivityPage(); // Re-initialize the page fully
    });

    const handleTableClick = e => {
        const stopBtn = e.target.closest('.stop-stream-btn');
        const changeBtn = e.target.closest('.change-stream-btn');
        const userSpan = e.target.closest('.clickable-username');

        if (stopBtn) {
            const row = stopBtn.closest('tr');
            const streamKey = row.dataset.streamKey;
            const username = row.querySelector('.clickable-username').textContent;

            showConfirm(
                'Stop Stream?',
                `Are you sure you want to terminate the stream for user "${username}"?`,
                async () => {
                    const res = await apiFetch('/api/admin/stop-stream', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ streamKey })
                    });
                    if (res && res.ok) {
                        showNotification('Stream terminated successfully.');
                        // UI will update via SSE
                    }
                }
            );
        } else if (changeBtn) {
            const row = changeBtn.closest('tr');
            const streamKey = row.dataset.streamKey;
            const userId = row.dataset.userId;

            adminState.channelSelectorCallback = async (channel) => {
                await apiFetch('/api/admin/change-stream', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ userId, streamKey, channel })
                });
            };
            
            document.body.dataset.channelSelectorContext = 'admin';
            populateChannelSelector();
            openModal(UIElements.multiviewChannelSelectorModal);

        } else if (userSpan) {
            const username = userSpan.textContent;
            UIElements.historySearchInput.value = username;
            applyHistoryFilters();
        }
    };

    UIElements.liveActivityTbody?.addEventListener('click', handleTableClick);
    UIElements.watchHistoryTbody?.addEventListener('click', handleTableClick);
    
    // History filter event listeners
    UIElements.historySearchInput?.addEventListener('input', () => {
        clearTimeout(appState.searchDebounceTimer);
        appState.searchDebounceTimer = setTimeout(() => applyHistoryFilters(), 300);
    });
    UIElements.historyDateFilter?.addEventListener('change', () => {
        const isCustom = UIElements.historyDateFilter.value === 'custom';
        UIElements.historyCustomDateContainer.classList.toggle('hidden', !isCustom);
        if (!isCustom) applyHistoryFilters();
    });
    UIElements.historyDateStart?.addEventListener('change', applyHistoryFilters);
    UIElements.historyDateEnd?.addEventListener('change', applyHistoryFilters);

    // Pagination event listeners
    UIElements.historyPageSizeSelect.addEventListener('change', (e) => {
        const newSize = parseInt(e.target.value, 10);
        adminState.pagination.pageSize = newSize;
        adminState.pagination.currentPage = 1;
        saveUserSetting('adminPageSize', newSize); // Persist setting
        guideState.settings.adminPageSize = newSize; // Update local state
        loadActivityData();
    });

    UIElements.historyPaginationControls.addEventListener('click', e => {
        const button = e.target.closest('button[data-page]');
        if (button && !button.disabled) {
            const newPage = parseInt(button.dataset.page, 10);
            if (newPage !== adminState.pagination.currentPage) {
                adminState.pagination.currentPage = newPage;
                loadActivityData();
            }
        }
    });

    // Broadcast message listener
    UIElements.broadcastMessageBtn.addEventListener('click', () => {
        const message = prompt("Enter the broadcast message to send to all active users:");
        if (message && message.trim()) {
            apiFetch('/api/admin/broadcast', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ message: message.trim() })
            }).then(res => {
                if (res && res.ok) {
                    showNotification('Broadcast message sent!');
                }
            });
        }
    });
}

/**
 * Resets to page 1 and reloads history data. Called by filter inputs.
 */
function applyHistoryFilters() {
    adminState.pagination.currentPage = 1;
    loadActivityData();
}

// --- Utility Functions ---

/**
 * Updates the duration display for all live streams.
 */
function updateLiveDurations() {
    const durationElements = document.querySelectorAll('#live-activity-tbody .live-duration');
    durationElements.forEach(el => {
        const startTime = el.dataset.startTime;
        if (startTime) {
            const start = new Date(startTime).getTime();
            const now = Date.now();
            const durationSeconds = Math.round((now - start) / 1000);
            el.textContent = formatDuration(durationSeconds);
        }
    });
}

/**
 * Formats a duration in seconds to a human-readable string (e.g., 1h 23m 45s).
 * @param {number} totalSeconds - The duration in seconds.
 * @param {boolean} shortFormat - If true, returns a very short format (e.g., 1.4h).
 * @returns {string} The formatted duration string.
 */
function formatDuration(totalSeconds, shortFormat = false) {
    if (totalSeconds === null || isNaN(totalSeconds) || totalSeconds < 0) return 'N/A';
    
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;

    if (shortFormat) {
        if (hours > 0) return `${(totalSeconds / 3600).toFixed(1)}h`;
        if (minutes > 0) return `${(totalSeconds / 60).toFixed(1)}m`;
        return `${totalSeconds}s`;
    }

    if (totalSeconds < 60) return `${totalSeconds}s`;
    
    let result = '';
    if (hours > 0) result += `${hours}h `;
    if (minutes > 0) result += `${minutes}m `;
    if (hours === 0 && minutes < 5) result += `${seconds}s`; // Only show seconds for short durations

    return result.trim() || '0s';
}

function formatBytes(bytes) {
    if (!bytes || bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return `${parseFloat((bytes / Math.pow(k, i)).toFixed(1))} ${sizes[i]}`;
}

export function handleAdminChannelClick(channelItem) {
    if (channelItem && adminState.channelSelectorCallback) {
        const channel = {
            id: channelItem.dataset.id,
            name: channelItem.dataset.name,
            url: channelItem.dataset.url,
            logo: channelItem.dataset.logo,
        };
        adminState.channelSelectorCallback(channel);
    }
}
