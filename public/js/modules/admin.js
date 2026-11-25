/**
 * admin.js
 * Manages all client-side functionality for the redesigned Tautulli-style Admin Activity & Analytics page.
 */

import { UIElements, guideState, adminState, appState } from './state.js';
import { apiFetch, saveUserSetting } from './api.js';
import { showNotification, showConfirm, openModal } from './ui.js';
import { ICONS } from './icons.js';
import { proxiedImageUrl } from './utils.js';
import { populateChannelSelector } from './multiview.js';

const COLUMNS_STORAGE_KEY = 'viniplay_activity_columns_v1';

const DATE_FILTER_LABELS = {
    all: 'All Time',
    today: 'Today',
    '24h': 'Last 24h',
    '7d': '7 Days',
    '30d': '30 Days',
    '90d': '90 Days',
    custom: 'Custom Range'
};

/**
 * Loads saved column visibility preferences from localStorage.
 */
function loadSavedColumns() {
    try {
        const raw = localStorage.getItem(COLUMNS_STORAGE_KEY);
        if (raw) {
            const parsed = JSON.parse(raw);
            if (parsed && typeof parsed === 'object') {
                adminState.columns = {
                    ip: parsed.ip !== false,
                    platform: parsed.platform !== false,
                    streamMode: parsed.streamMode !== false,
                    stopped: parsed.stopped !== false,
                };
            }
        }
    } catch (e) {
        console.warn('[ADMIN] Failed to load saved column preferences:', e);
    }

    // Sync checkboxes in the menu if present
    const menu = document.getElementById('history-columns-menu');
    if (menu) {
        menu.querySelectorAll('input[data-toggle-col]').forEach(cb => {
            const col = cb.dataset.toggleCol;
            if (col in adminState.columns) {
                cb.checked = !!adminState.columns[col];
            }
        });
    }
}

/**
 * Saves column visibility preferences and updates table DOM.
 */
function applyColumnVisibility() {
    const table = document.getElementById('watch-history-table-container');
    if (!table) return;

    Object.entries(adminState.columns).forEach(([col, visible]) => {
        table.querySelectorAll(`[data-col="${col}"]`).forEach(el => {
            el.classList.toggle('hidden', !visible);
        });
    });

    const deleteHeader = document.getElementById('history-delete-col-header');
    if (deleteHeader) {
        deleteHeader.classList.toggle('hidden', !adminState.deleteMode);
    }
    table.querySelectorAll('[data-col="delete"]').forEach(el => {
        el.classList.toggle('hidden', !adminState.deleteMode);
    });
}

/**
 * Initializes the Activity page by syncing controls, fetching data, and starting health polling.
 */
export async function initActivityPage() {
    console.log('[ADMIN] Initializing Admin Activity & Analytics Dashboard...');

    if (adminState.healthCheckInterval) {
        clearInterval(adminState.healthCheckInterval);
    }

    loadSavedColumns();

    // Set default end date for custom picker if empty
    const today = formatLocalYMD(new Date());
    if (UIElements.historyDateEnd && !UIElements.historyDateEnd.value) {
        UIElements.historyDateEnd.value = today;
        adminState.filters.endDate = today;
    }

    // Reset pagination to page 1 and restore saved page size
    adminState.pagination.currentPage = 1;
    adminState.pagination.pageSize = guideState.settings.adminPageSize || 25;
    if (UIElements.historyPageSizeSelect) {
        UIElements.historyPageSizeSelect.value = adminState.pagination.pageSize;
    }

    syncFilterControlsFromState();

    await Promise.all([
        loadActivityData(),
        renderDashboardWidgets()
    ]);

    adminState.healthCheckInterval = setInterval(renderHealthWidget, 5000);
}

/**
 * Builds URLSearchParams for the current filter state.
 * @param {boolean} includePagination - Whether to include page and pageSize.
 * @returns {URLSearchParams}
 */
function buildFilterQueryParams(includePagination = true) {
    const f = adminState.filters;
    const params = new URLSearchParams();

    if (includePagination) {
        params.set('page', adminState.pagination.currentPage);
        params.set('pageSize', adminState.pagination.pageSize);
    }

    if (f.search) params.set('search', f.search);
    if (f.user && f.user !== 'all') params.set('user', f.user);
    if (f.mediaType && f.mediaType !== 'all') params.set('mediaType', f.mediaType);
    if (f.streamMode && f.streamMode !== 'all') params.set('streamMode', f.streamMode);
    if (f.dateFilter) params.set('dateFilter', f.dateFilter);
    if (f.dateFilter === 'custom') {
        if (f.startDate) params.set('startDate', f.startDate);
        if (f.endDate) params.set('endDate', f.endDate);
    }
    if (f.sortBy) params.set('sortBy', f.sortBy);
    if (f.sortDir) params.set('sortDir', f.sortDir);

    return params;
}

/**
 * Syncs UI filter controls to match adminState.filters.
 */
function syncFilterControlsFromState() {
    const f = adminState.filters;

    if (UIElements.historySearchInput && UIElements.historySearchInput.value !== f.search) {
        UIElements.historySearchInput.value = f.search;
    }
    if (UIElements.historyDateFilter) {
        UIElements.historyDateFilter.value = f.dateFilter;
    }
    if (UIElements.historyCustomDateContainer) {
        UIElements.historyCustomDateContainer.classList.toggle('hidden', f.dateFilter !== 'custom');
    }
    if (UIElements.historyDateStart && f.startDate) {
        UIElements.historyDateStart.value = f.startDate;
    }
    if (UIElements.historyDateEnd && f.endDate) {
        UIElements.historyDateEnd.value = f.endDate;
    }

    // Media type pills
    document.querySelectorAll('#history-media-pills .history-media-pill').forEach(btn => {
        const isActive = btn.dataset.mediaType === f.mediaType;
        btn.className = isActive
            ? 'history-media-pill px-3 py-1 rounded-lg text-xs font-semibold bg-blue-600 text-white transition-colors'
            : 'history-media-pill px-3 py-1 rounded-lg text-xs font-medium text-gray-400 hover:text-white transition-colors';
    });

    // Stream mode pills
    document.querySelectorAll('#history-mode-pills .history-mode-pill').forEach(btn => {
        const isActive = btn.dataset.streamMode === f.streamMode;
        btn.className = isActive
            ? 'history-mode-pill px-3 py-1 rounded-lg text-xs font-semibold bg-blue-600 text-white transition-colors'
            : 'history-mode-pill px-3 py-1 rounded-lg text-xs font-medium text-gray-400 hover:text-white transition-colors';
    });

    // Sort indicators
    document.querySelectorAll('#watch-history-thead th[data-sort]').forEach(th => {
        const indicator = th.querySelector('.sort-indicator');
        if (!indicator) return;
        if (th.dataset.sort === f.sortBy) {
            indicator.textContent = f.sortDir === 'asc' ? '↑' : '↓';
        } else {
            indicator.textContent = '';
        }
    });

    // Reset button visibility
    const hasActiveFilter = Boolean(
        f.search ||
        (f.user && f.user !== 'all') ||
        (f.mediaType && f.mediaType !== 'all') ||
        (f.streamMode && f.streamMode !== 'all') ||
        (f.dateFilter && f.dateFilter !== 'all')
    );
    const resetBtn = document.getElementById('history-reset-filters-btn');
    if (resetBtn) {
        resetBtn.classList.toggle('hidden', !hasActiveFilter);
    }

    // Period labels on analytics cards
    let periodLabel = DATE_FILTER_LABELS[f.dateFilter] || 'All Time';
    if (f.dateFilter === 'custom') {
        if (f.startDate && f.endDate && f.startDate === f.endDate) {
            periodLabel = f.startDate;
        } else if (f.startDate || f.endDate) {
            periodLabel = `${f.startDate || '...'} → ${f.endDate || '...'}`;
        }
    }
    const topChPeriod = document.getElementById('stat-top-channels-period');
    const topUsrPeriod = document.getElementById('stat-top-users-period');
    if (topChPeriod) topChPeriod.textContent = periodLabel;
    if (topUsrPeriod) topUsrPeriod.textContent = periodLabel;
}

/**
 * Populates the user dropdown while preserving the active selection.
 */
function populateUserFilterDropdown(users = []) {
    const select = document.getElementById('history-user-filter');
    if (!select) return;

    const currentVal = adminState.filters.user || 'all';
    const uniqueUsers = Array.from(new Set(users.filter(Boolean)));
    if (currentVal !== 'all' && !uniqueUsers.includes(currentVal)) {
        uniqueUsers.unshift(currentVal);
    }

    select.innerHTML = `<option value="all">All Users</option>` +
        uniqueUsers.map(u => `<option value="${escapeAttr(u)}">${escapeHtml(u)}</option>`).join('');
    select.value = currentVal;
}

/**
 * Fetches both live and historical activity data from the server based on current filters and pagination.
 */
async function loadActivityData() {
    const query = buildFilterQueryParams(true);

    const res = await apiFetch(`/api/admin/activity?${query.toString()}`);
    if (res && res.ok) {
        const data = await res.json();
        adminState.live = data.live || [];
        adminState.history = data.history.items || [];
        adminState.users = data.users || [];

        adminState.pagination.totalPages = data.history.totalPages || 1;
        adminState.pagination.totalItems = data.history.totalItems || 0;
        adminState.pagination.totalDurationSeconds = data.history.totalDurationSeconds || 0;

        populateUserFilterDropdown(adminState.users);
        renderLiveActivity();
        renderWatchHistory();
        renderPaginationControls();
    } else {
        showNotification('Could not load activity data.', true);
        UIElements.noLiveActivityMessage?.classList.remove('hidden');
        UIElements.noWatchHistoryMessage?.classList.remove('hidden');
    }
}

/**
 * Handles real-time updates for live activity pushed from the server via SSE.
 * @param {Array} liveActivityData - The new list of live streams.
 */
export function handleActivityUpdate(liveActivityData) {
    console.log('[ADMIN_SSE] Received real-time activity update.');
    adminState.live = liveActivityData || [];
    renderLiveActivity();
}

/**
 * Fetches and renders all dashboard widgets (analytics and health).
 */
async function renderDashboardWidgets() {
    renderHealthWidget();
    await loadAnalyticsData();
}

/**
 * Fetches analytics data with current filters applied.
 */
async function loadAnalyticsData() {
    const query = buildFilterQueryParams(false);
    const res = await apiFetch(`/api/admin/analytics?${query.toString()}`);
    if (res && res.ok) {
        const analytics = await res.json();
        renderAnalyticsWidgets(analytics);
    }
}

/**
 * Renders the server health widget with CPU, RAM, and Disk info + visual progress bars.
 */
async function renderHealthWidget() {
    const res = await apiFetch('/api/admin/system-health');
    if (res && res.ok) {
        const health = await res.json();
        const cpuLoad = Math.min(100, Math.max(0, parseFloat(health.cpu.load) || 0));
        const ramPct = Math.min(100, Math.max(0, parseFloat(health.memory.percent) || 0));
        const dvrPct = Math.min(100, Math.max(0, parseFloat(health.disks.dvr.percent) || 0));

        if (UIElements.statCpuHealth) {
            UIElements.statCpuHealth.innerHTML = `<span class="text-gray-400">CPU Load</span><span class="font-mono font-semibold text-white">${cpuLoad.toFixed(1)}%</span>`;
        }
        if (UIElements.statRamHealth) {
            UIElements.statRamHealth.innerHTML = `<span class="text-gray-400">RAM</span><span class="font-mono font-semibold text-white">${ramPct.toFixed(1)}% <span class="text-gray-400 font-normal">(${formatBytes(health.memory.used)} / ${formatBytes(health.memory.total)})</span></span>`;
        }
        if (UIElements.statDvrDiskHealth) {
            UIElements.statDvrDiskHealth.innerHTML = `<span class="text-gray-400">DVR Disk</span><span class="font-mono font-semibold text-white">${dvrPct.toFixed(1)}% <span class="text-gray-400 font-normal">(${formatBytes(health.disks.dvr.used)} / ${formatBytes(health.disks.dvr.total)})</span></span>`;
        }

        const cpuBar = document.getElementById('stat-cpu-bar');
        const ramBar = document.getElementById('stat-ram-bar');
        const dvrBar = document.getElementById('stat-dvr-bar');
        if (cpuBar) {
            cpuBar.style.width = `${cpuLoad}%`;
            cpuBar.className = `h-full rounded-full transition-all duration-300 ${cpuLoad > 85 ? 'bg-red-500' : cpuLoad > 65 ? 'bg-amber-500' : 'bg-blue-500'}`;
        }
        if (ramBar) {
            ramBar.style.width = `${ramPct}%`;
            ramBar.className = `h-full rounded-full transition-all duration-300 ${ramPct > 85 ? 'bg-red-500' : ramPct > 70 ? 'bg-amber-500' : 'bg-indigo-500'}`;
        }
        if (dvrBar) {
            dvrBar.style.width = `${dvrPct}%`;
            dvrBar.className = `h-full rounded-full transition-all duration-300 ${dvrPct > 90 ? 'bg-red-500' : dvrPct > 75 ? 'bg-amber-500' : 'bg-emerald-500'}`;
        }
    }
}

/**
 * Renders the analytics widgets (Top Channels, Top Users).
 * @param {object} analytics - The analytics data from the server.
 */
function renderAnalyticsWidgets(analytics) {
    const topChannelsEl = UIElements.statTopChannels;
    const topUsersEl = UIElements.statTopUsers;

    if (topChannelsEl) {
        if (analytics.topChannels && analytics.topChannels.length > 0) {
            topChannelsEl.innerHTML = analytics.topChannels.map((c, idx) => `
                <div class="flex justify-between items-center gap-2 py-0.5">
                    <div class="flex items-center gap-2 min-w-0">
                        <span class="w-4 h-4 rounded bg-gray-700/80 text-[10px] font-mono font-bold text-gray-300 flex items-center justify-center flex-shrink-0">${idx + 1}</span>
                        <button type="button" class="clickable-title text-left text-gray-200 hover:text-blue-400 truncate transition-colors" data-title="${escapeAttr(c.channel_name)}" title="Filter history for ${escapeAttr(c.channel_name)}">${escapeHtml(c.channel_name)}</button>
                    </div>
                    <div class="flex items-center gap-2 flex-shrink-0 font-mono text-[11px]">
                        ${c.play_count ? `<span class="text-gray-500">${c.play_count}x</span>` : ''}
                        <span class="text-blue-400 font-semibold">${formatDuration(c.total_duration, true)}</span>
                    </div>
                </div>
            `).join('');
        } else {
            topChannelsEl.innerHTML = `<p class="text-gray-500 text-xs py-2">No watch data for this period.</p>`;
        }
    }

    if (topUsersEl) {
        if (analytics.topUsers && analytics.topUsers.length > 0) {
            topUsersEl.innerHTML = analytics.topUsers.map((u, idx) => `
                <div class="flex justify-between items-center gap-2 py-0.5">
                    <div class="flex items-center gap-2 min-w-0">
                        <span class="w-4 h-4 rounded bg-gray-700/80 text-[10px] font-mono font-bold text-gray-300 flex items-center justify-center flex-shrink-0">${idx + 1}</span>
                        <button type="button" class="clickable-username text-left text-gray-200 hover:text-blue-400 truncate transition-colors" data-username="${escapeAttr(u.username)}" title="Filter history for ${escapeAttr(u.username)}">${escapeHtml(u.username)}</button>
                    </div>
                    <div class="flex items-center gap-2 flex-shrink-0 font-mono text-[11px]">
                        ${u.play_count ? `<span class="text-gray-500">${u.play_count}x</span>` : ''}
                        <span class="text-emerald-400 font-semibold">${formatDuration(u.total_duration, true)}</span>
                    </div>
                </div>
            `).join('');
        } else {
            topUsersEl.innerHTML = `<p class="text-gray-500 text-xs py-2">No user activity for this period.</p>`;
        }
    }
}

/**
 * Renders the table of currently active streams.
 */
function renderLiveActivity() {
    const tbody = UIElements.liveActivityTbody;
    const hasLiveStreams = adminState.live.length > 0;

    UIElements.noLiveActivityMessage?.classList.toggle('hidden', hasLiveStreams);
    UIElements.liveActivityTableContainer?.classList.toggle('hidden', !hasLiveStreams);

    if (UIElements.statCurrentViewers) {
        UIElements.statCurrentViewers.textContent = adminState.live.length;
    }

    const liveCountBadge = document.getElementById('live-activity-count-badge');
    if (liveCountBadge) {
        liveCountBadge.textContent = `${adminState.live.length} active`;
        liveCountBadge.className = hasLiveStreams
            ? 'px-2.5 py-0.5 text-xs font-semibold rounded-full bg-emerald-500/20 text-emerald-300 border border-emerald-500/30'
            : 'px-2.5 py-0.5 text-xs font-semibold rounded-full bg-gray-700 text-gray-300';
    }

    const directCount = adminState.live.filter(s => !s.isTranscoded).length;
    const transcodeCount = adminState.live.filter(s => s.isTranscoded).length;
    const breakdownEl = document.getElementById('stat-stream-breakdown');
    if (breakdownEl) {
        breakdownEl.innerHTML = `
            <span class="inline-flex items-center gap-1.5"><span class="w-2 h-2 rounded-full bg-emerald-400"></span>${directCount} Direct</span>
            <span class="inline-flex items-center gap-1.5"><span class="w-2 h-2 rounded-full bg-amber-400"></span>${transcodeCount} Transcode</span>
        `;
    }

    if (!tbody) return;
    tbody.innerHTML = '';

    adminState.live.forEach(stream => {
        const tr = document.createElement('tr');
        tr.className = 'hover:bg-gray-800/60 transition-colors';
        tr.dataset.streamKey = stream.streamKey;
        tr.dataset.userId = stream.userId;

        const cleanIp = cleanIpDisplay(stream.clientIp);
        const clientInfo = stream.clientInfo || 'Web Client';
        const mediaBadge = renderMediaTypeBadge(stream.mediaType || 'live');
        const modeBadge = renderStreamModeBadge(stream.streamProfileName, stream.isTranscoded);

        tr.innerHTML = `
            <td class="px-5 py-3.5 whitespace-nowrap">
                <div class="flex items-center gap-2.5">
                    <div class="w-7 h-7 rounded-full bg-blue-600/20 border border-blue-500/30 text-blue-400 font-bold text-xs flex items-center justify-center uppercase flex-shrink-0">
                        ${escapeHtml((stream.username || '?').charAt(0))}
                    </div>
                    <button type="button" class="clickable-username font-semibold text-white hover:text-blue-400 transition-colors" data-username="${escapeAttr(stream.username)}" title="Filter history for ${escapeAttr(stream.username)}">
                        ${escapeHtml(stream.username)}
                    </button>
                </div>
            </td>
            <td class="px-5 py-3.5 whitespace-nowrap">
                <div class="flex flex-col">
                    <button type="button" class="clickable-ip text-left font-mono text-xs text-gray-200 hover:text-blue-400 transition-colors" data-ip="${escapeAttr(cleanIp)}" title="Filter by IP ${escapeAttr(cleanIp)}">${escapeHtml(cleanIp)}</button>
                    <span class="text-[11px] text-gray-400">${escapeHtml(clientInfo)}</span>
                </div>
            </td>
            <td class="px-5 py-3.5">
                <div class="flex items-center gap-3 min-w-[200px]">
                    <img src="${proxiedImageUrl(stream.channelLogo) || 'https://placehold.co/40x40/1f2937/d1d5db?text=?'}"
                         onerror="this.onerror=null; this.src='https://placehold.co/40x40/1f2937/d1d5db?text=?';"
                         class="w-9 h-9 object-contain rounded-lg bg-gray-800 border border-gray-700 p-0.5 flex-shrink-0"
                         alt="Logo">
                    <div class="min-w-0">
                        <div class="font-medium text-white truncate max-w-xs sm:max-w-sm" title="${escapeAttr(stream.channelName)}">${escapeHtml(stream.channelName)}</div>
                        <div class="mt-0.5">${mediaBadge}</div>
                    </div>
                </div>
            </td>
            <td class="px-5 py-3.5 whitespace-nowrap">
                ${modeBadge}
            </td>
            <td class="px-5 py-3.5 whitespace-nowrap font-mono text-xs text-gray-300" title="${escapeAttr(new Date(stream.startTime).toLocaleString())}">
                ${formatTimeColumn(stream.startTime)}
            </td>
            <td class="px-5 py-3.5 whitespace-nowrap font-mono text-xs font-semibold text-emerald-400 live-duration" data-start-time="${escapeAttr(stream.startTime)}">
                -
            </td>
            <td class="px-5 py-3.5 whitespace-nowrap text-right">
                <div class="flex items-center justify-end gap-2">
                    <button class="action-btn change-stream-btn p-1.5 rounded-lg bg-blue-600/15 hover:bg-blue-600/30 text-blue-400 border border-blue-500/30 transition-colors" title="Switch User's Channel">
                        <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8 7h12m0 0l-4-4m4 4l-4 4m0 6H4m0 0l4 4m-4-4l4-4"></path></svg>
                    </button>
                    <button class="action-btn stop-stream-btn p-1.5 rounded-lg bg-red-600/15 hover:bg-red-600/30 text-red-400 border border-red-500/30 transition-colors" title="Terminate Stream">
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
 * Renders the Tautulli-style Watch History table.
 */
function renderWatchHistory() {
    const history = adminState.history;
    const tbody = UIElements.watchHistoryTbody;
    const hasHistory = history.length > 0;

    UIElements.noWatchHistoryMessage?.classList.toggle('hidden', hasHistory);
    UIElements.watchHistoryTableContainer?.classList.toggle('hidden', !hasHistory);

    const totalCountBadge = document.getElementById('history-total-count-badge');
    const totalDurationBadge = document.getElementById('history-total-duration-badge');
    if (totalCountBadge) {
        const count = adminState.pagination.totalItems || 0;
        totalCountBadge.textContent = `${count} ${count === 1 ? 'play' : 'plays'}`;
    }
    if (totalDurationBadge) {
        totalDurationBadge.textContent = `${formatDuration(adminState.pagination.totalDurationSeconds || 0, false)} total`;
    }

    if (!tbody) return;
    tbody.innerHTML = '';

    history.forEach(entry => {
        const tr = document.createElement('tr');
        tr.className = 'hover:bg-gray-800/60 transition-colors';
        tr.dataset.historyId = entry.id;

        const dateStr = formatDateColumn(entry.start_time);
        const startTimeStr = formatTimeColumn(entry.start_time);
        const stopTimeStr = entry.end_time
            ? formatTimeColumn(entry.end_time)
            : (entry.status === 'playing'
                ? `<span class="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-semibold bg-emerald-500/20 text-emerald-300 border border-emerald-500/30"><span class="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse"></span>Active</span>`
                : `<span class="text-gray-500">-</span>`);

        const cleanIp = cleanIpDisplay(entry.client_ip);
        const clientInfo = entry.client_info || 'Web Client';
        const mediaBadge = renderMediaTypeBadge(entry.media_type || 'live');
        const profileName = entry.stream_profile_name || 'N/A';
        const isDirect = ['redirect', 'direct', 'direct play'].includes(profileName.toLowerCase());
        const modeBadge = renderStreamModeBadge(profileName, !isDirect);

        const durationHtml = entry.status === 'playing' && !entry.duration_seconds
            ? `<span class="text-emerald-400 font-semibold">Playing</span>`
            : `<span class="text-gray-200 font-medium">${formatDuration(entry.duration_seconds)}</span>`;

        tr.innerHTML = `
            <td class="px-5 py-3.5 whitespace-nowrap">
                <button type="button" class="clickable-date font-mono text-xs font-medium text-gray-300 hover:text-blue-400 transition-colors" data-date="${escapeAttr(dateStr)}" title="Filter history to ${escapeAttr(dateStr)}">
                    ${escapeHtml(dateStr)}
                </button>
            </td>
            <td class="px-5 py-3.5 whitespace-nowrap">
                <div class="flex items-center gap-2">
                    <div class="w-6 h-6 rounded-full bg-gray-700 text-gray-200 font-bold text-[11px] flex items-center justify-center uppercase flex-shrink-0">
                        ${escapeHtml((entry.username || '?').charAt(0))}
                    </div>
                    <button type="button" class="clickable-username font-medium text-white hover:text-blue-400 transition-colors" data-username="${escapeAttr(entry.username)}" title="Filter history for ${escapeAttr(entry.username)}">
                        ${escapeHtml(entry.username)}
                    </button>
                </div>
            </td>
            <td data-col="ip" class="px-5 py-3.5 whitespace-nowrap">
                <button type="button" class="clickable-ip font-mono text-xs text-gray-300 hover:text-blue-400 transition-colors" data-ip="${escapeAttr(cleanIp)}" title="Filter by IP ${escapeAttr(cleanIp)}">
                    ${escapeHtml(cleanIp)}
                </button>
            </td>
            <td data-col="platform" class="px-5 py-3.5 whitespace-nowrap">
                <span class="text-xs text-gray-300">${escapeHtml(clientInfo)}</span>
            </td>
            <td class="px-5 py-3.5">
                <div class="flex items-center gap-3 min-w-[220px]">
                    <img src="${proxiedImageUrl(entry.channel_logo) || 'https://placehold.co/40x40/1f2937/d1d5db?text=?'}"
                         onerror="this.onerror=null; this.src='https://placehold.co/40x40/1f2937/d1d5db?text=?';"
                         class="w-9 h-9 object-contain rounded-lg bg-gray-800 border border-gray-700 p-0.5 flex-shrink-0"
                         alt="Logo">
                    <div class="min-w-0">
                        <button type="button" class="clickable-title text-left font-medium text-white hover:text-blue-400 truncate block max-w-xs sm:max-w-md transition-colors" data-title="${escapeAttr(entry.channel_name || 'Unknown')}" title="Filter by ${escapeAttr(entry.channel_name || 'Unknown')}">
                            ${escapeHtml(entry.channel_name || 'Unknown')}
                        </button>
                        <div class="mt-0.5">${mediaBadge}</div>
                    </div>
                </div>
            </td>
            <td data-col="streamMode" class="px-5 py-3.5 whitespace-nowrap">
                ${modeBadge}
            </td>
            <td class="px-5 py-3.5 whitespace-nowrap font-mono text-xs text-gray-300" title="${entry.start_time ? escapeAttr(new Date(entry.start_time).toLocaleString()) : ''}">
                ${startTimeStr}
            </td>
            <td data-col="stopped" class="px-5 py-3.5 whitespace-nowrap font-mono text-xs text-gray-300" title="${entry.end_time ? escapeAttr(new Date(entry.end_time).toLocaleString()) : ''}">
                ${stopTimeStr}
            </td>
            <td class="px-5 py-3.5 whitespace-nowrap font-mono text-xs text-right">
                ${durationHtml}
            </td>
            <td data-col="delete" class="hidden px-4 py-3.5 whitespace-nowrap text-right">
                <button type="button" class="delete-history-row-btn p-1.5 rounded-lg bg-red-600/15 hover:bg-red-600/30 text-red-400 border border-red-500/30 transition-colors" data-id="${entry.id}" title="Delete this record">
                    <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"></path></svg>
                </button>
            </td>
        `;
        tbody.appendChild(tr);
    });

    applyColumnVisibility();
}

/**
 * Renders the pagination controls for the history table.
 */
function renderPaginationControls() {
    const { currentPage, totalPages, totalItems, pageSize } = adminState.pagination;
    const controlsEl = UIElements.historyPaginationControls;
    const pagesEl = UIElements.historyPaginationPages;
    const infoEl = UIElements.historyPaginationInfo;

    if (!controlsEl) return;

    if (totalItems === 0) {
        controlsEl.classList.add('hidden');
        return;
    }
    controlsEl.classList.remove('hidden');

    const startItem = (currentPage - 1) * pageSize + 1;
    const endItem = Math.min(startItem + pageSize - 1, totalItems);
    if (infoEl) {
        infoEl.textContent = `Showing ${startItem}–${endItem} of ${totalItems}`;
    }

    if (!pagesEl) return;
    if (totalPages <= 1) {
        pagesEl.innerHTML = '';
        return;
    }

    let pagesHTML = '';
    pagesHTML += `<li><button class="pagination-btn" data-page="${currentPage - 1}" ${currentPage === 1 ? 'disabled' : ''}>Prev</button></li>`;

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

    pagesHTML += `<li><button class="pagination-btn" data-page="${currentPage + 1}" ${currentPage === totalPages ? 'disabled' : ''}>Next</button></li>`;

    pagesEl.innerHTML = pagesHTML;
}

/**
 * Triggers a CSV or JSON file download of the watch history with all current filters applied.
 * @param {'csv'|'json'} format
 */
function exportWatchHistory(format = 'csv') {
    const query = buildFilterQueryParams(false);
    query.set('format', format);

    const exportUrl = `/api/admin/activity/export?${query.toString()}`;
    showNotification(`Preparing ${format.toUpperCase()} export...`);

    const a = document.createElement('a');
    a.href = exportUrl;
    a.download = `viniplay-watch-history.${format}`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);

    document.getElementById('history-export-menu')?.classList.add('hidden');
}

/**
 * Sets up event listeners for the Activity page.
 */
export function setupAdminEventListeners() {
    UIElements.refreshActivityBtn?.addEventListener('click', () => {
        initActivityPage();
    });

    // Delegated click handler for Live Activity, Watch History, and Top Cards
    const handleActivityPageClick = async (e) => {
        const stopBtn = e.target.closest('.stop-stream-btn');
        const changeBtn = e.target.closest('.change-stream-btn');
        const userBtn = e.target.closest('.clickable-username');
        const ipBtn = e.target.closest('.clickable-ip');
        const titleBtn = e.target.closest('.clickable-title');
        const dateBtn = e.target.closest('.clickable-date');
        const deleteRowBtn = e.target.closest('.delete-history-row-btn');

        if (stopBtn) {
            const row = stopBtn.closest('tr');
            const streamKey = row.dataset.streamKey;
            const username = row.querySelector('.clickable-username')?.dataset.username || 'User';

            showConfirm(
                'Stop Stream?',
                `Are you sure you want to terminate the active stream for "${username}"?`,
                async () => {
                    const res = await apiFetch('/api/admin/stop-stream', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ streamKey })
                    });
                    if (res && res.ok) {
                        showNotification('Stream terminated successfully.');
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
        } else if (userBtn) {
            const username = userBtn.dataset.username || userBtn.textContent.trim();
            adminState.filters.user = username;
            const userSelect = document.getElementById('history-user-filter');
            if (userSelect) {
                populateUserFilterDropdown(adminState.users);
                userSelect.value = username;
            }
            applyHistoryFilters();
        } else if (ipBtn) {
            const ip = ipBtn.dataset.ip || ipBtn.textContent.trim();
            if (ip && ip !== 'N/A') {
                adminState.filters.search = ip;
                applyHistoryFilters();
            }
        } else if (titleBtn) {
            const title = titleBtn.dataset.title || titleBtn.textContent.trim();
            if (title) {
                adminState.filters.search = title;
                applyHistoryFilters();
            }
        } else if (dateBtn) {
            const dateStr = dateBtn.dataset.date;
            if (dateStr && /^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
                adminState.filters.dateFilter = 'custom';
                adminState.filters.startDate = dateStr;
                adminState.filters.endDate = dateStr;
                applyHistoryFilters();
            }
        } else if (deleteRowBtn) {
            const entryId = deleteRowBtn.dataset.id;
            if (!entryId) return;
            const res = await apiFetch(`/api/admin/activity/history/${entryId}`, { method: 'DELETE' });
            if (res && res.ok) {
                showNotification('History entry deleted.');
                await Promise.all([loadActivityData(), loadAnalyticsData()]);
            }
        }
    };

    const pageActivity = document.getElementById('page-activity');
    pageActivity?.addEventListener('click', handleActivityPageClick);

    // Search input (debounced)
    UIElements.historySearchInput?.addEventListener('input', () => {
        clearTimeout(appState.searchDebounceTimer);
        appState.searchDebounceTimer = setTimeout(() => {
            adminState.filters.search = UIElements.historySearchInput.value.trim();
            applyHistoryFilters();
        }, 300);
    });

    // User filter dropdown
    document.getElementById('history-user-filter')?.addEventListener('change', (e) => {
        adminState.filters.user = e.target.value || 'all';
        applyHistoryFilters();
    });

    // Media type pills
    document.getElementById('history-media-pills')?.addEventListener('click', (e) => {
        const pill = e.target.closest('.history-media-pill');
        if (!pill) return;
        adminState.filters.mediaType = pill.dataset.mediaType || 'all';
        applyHistoryFilters();
    });

    // Stream mode pills
    document.getElementById('history-mode-pills')?.addEventListener('click', (e) => {
        const pill = e.target.closest('.history-mode-pill');
        if (!pill) return;
        adminState.filters.streamMode = pill.dataset.streamMode || 'all';
        applyHistoryFilters();
    });

    // Date range filter
    UIElements.historyDateFilter?.addEventListener('change', () => {
        const val = UIElements.historyDateFilter.value;
        adminState.filters.dateFilter = val;
        const isCustom = val === 'custom';
        UIElements.historyCustomDateContainer?.classList.toggle('hidden', !isCustom);
        if (isCustom) {
            if (!adminState.filters.endDate) {
                const today = formatLocalYMD(new Date());
                adminState.filters.endDate = today;
                if (UIElements.historyDateEnd) UIElements.historyDateEnd.value = today;
            }
            if (!adminState.filters.startDate) {
                const weekAgo = formatLocalYMD(new Date(Date.now() - 7 * 24 * 60 * 60 * 1000));
                adminState.filters.startDate = weekAgo;
                if (UIElements.historyDateStart) UIElements.historyDateStart.value = weekAgo;
            }
        }
        applyHistoryFilters();
    });

    UIElements.historyDateStart?.addEventListener('change', () => {
        adminState.filters.startDate = UIElements.historyDateStart.value;
        applyHistoryFilters();
    });

    UIElements.historyDateEnd?.addEventListener('change', () => {
        adminState.filters.endDate = UIElements.historyDateEnd.value;
        applyHistoryFilters();
    });

    // Reset all filters button
    document.getElementById('history-reset-filters-btn')?.addEventListener('click', () => {
        adminState.filters.search = '';
        adminState.filters.user = 'all';
        adminState.filters.mediaType = 'all';
        adminState.filters.streamMode = 'all';
        adminState.filters.dateFilter = 'all';
        adminState.filters.startDate = '';
        adminState.filters.endDate = formatLocalYMD(new Date());
        const userSelect = document.getElementById('history-user-filter');
        if (userSelect) userSelect.value = 'all';
        applyHistoryFilters();
    });

    // Sortable table headers
    document.getElementById('watch-history-thead')?.addEventListener('click', (e) => {
        const th = e.target.closest('th[data-sort]');
        if (!th) return;
        const sortCol = th.dataset.sort;
        if (adminState.filters.sortBy === sortCol) {
            adminState.filters.sortDir = adminState.filters.sortDir === 'asc' ? 'desc' : 'asc';
        } else {
            adminState.filters.sortBy = sortCol;
            adminState.filters.sortDir = sortCol === 'username' || sortCol === 'channel_name' ? 'asc' : 'desc';
        }
        syncFilterControlsFromState();
        loadActivityData();
    });

    // Delete Mode toggle
    const deleteModeBtn = document.getElementById('history-delete-mode-btn');
    const clearFilteredBtn = document.getElementById('history-clear-filtered-btn');
    deleteModeBtn?.addEventListener('click', () => {
        adminState.deleteMode = !adminState.deleteMode;
        deleteModeBtn.className = adminState.deleteMode
            ? 'bg-red-600/20 hover:bg-red-600/30 text-red-300 border border-red-500/40 text-xs font-semibold py-2 px-3 rounded-lg flex items-center gap-1.5 transition-colors'
            : 'bg-gray-900/80 hover:bg-gray-700 text-gray-300 border border-gray-700 text-xs font-semibold py-2 px-3 rounded-lg flex items-center gap-1.5 transition-colors';
        clearFilteredBtn?.classList.toggle('hidden', !adminState.deleteMode);
        applyColumnVisibility();
    });

    // Clear Filtered History button
    clearFilteredBtn?.addEventListener('click', () => {
        const count = adminState.pagination.totalItems || 0;
        if (count === 0) {
            showNotification('No history entries to delete.', true);
            return;
        }
        showConfirm(
            'Delete Filtered Watch History?',
            `Are you sure you want to permanently delete ${count} watch history ${count === 1 ? 'record' : 'records'} matching your current filters?`,
            async () => {
                const query = buildFilterQueryParams(false);
                const res = await apiFetch(`/api/admin/activity/history?${query.toString()}`, { method: 'DELETE' });
                if (res && res.ok) {
                    const data = await res.json();
                    showNotification(`Deleted ${data.deletedCount || 0} history records.`);
                    await Promise.all([loadActivityData(), loadAnalyticsData()]);
                }
            }
        );
    });

    // Column Visibility dropdown
    const colsBtn = document.getElementById('history-columns-btn');
    const colsMenu = document.getElementById('history-columns-menu');
    colsBtn?.addEventListener('click', (e) => {
        e.stopPropagation();
        document.getElementById('history-export-menu')?.classList.add('hidden');
        colsMenu?.classList.toggle('hidden');
    });

    colsMenu?.addEventListener('change', (e) => {
        const cb = e.target.closest('input[data-toggle-col]');
        if (!cb) return;
        const col = cb.dataset.toggleCol;
        adminState.columns[col] = cb.checked;
        try {
            localStorage.setItem(COLUMNS_STORAGE_KEY, JSON.stringify(adminState.columns));
        } catch (err) {}
        applyColumnVisibility();
    });

    // Export dropdown
    const exportBtn = document.getElementById('history-export-btn');
    const exportMenu = document.getElementById('history-export-menu');
    exportBtn?.addEventListener('click', (e) => {
        e.stopPropagation();
        colsMenu?.classList.add('hidden');
        exportMenu?.classList.toggle('hidden');
    });

    document.getElementById('export-history-csv-btn')?.addEventListener('click', () => exportWatchHistory('csv'));
    document.getElementById('export-history-json-btn')?.addEventListener('click', () => exportWatchHistory('json'));

    // Close dropdown menus when clicking outside
    document.addEventListener('click', (e) => {
        if (colsMenu && !colsMenu.classList.contains('hidden') && !e.target.closest('#history-columns-menu') && !e.target.closest('#history-columns-btn')) {
            colsMenu.classList.add('hidden');
        }
        if (exportMenu && !exportMenu.classList.contains('hidden') && !e.target.closest('#history-export-menu') && !e.target.closest('#history-export-btn')) {
            exportMenu.classList.add('hidden');
        }
    });

    // Pagination listeners
    UIElements.historyPageSizeSelect?.addEventListener('change', (e) => {
        const newSize = parseInt(e.target.value, 10);
        adminState.pagination.pageSize = newSize;
        adminState.pagination.currentPage = 1;
        saveUserSetting('adminPageSize', newSize);
        guideState.settings.adminPageSize = newSize;
        loadActivityData();
    });

    UIElements.historyPaginationControls?.addEventListener('click', (e) => {
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
    UIElements.broadcastMessageBtn?.addEventListener('click', () => {
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
 * Resets to page 1, syncs UI filter controls, and reloads both Watch History and Analytics cards.
 */
function applyHistoryFilters() {
    adminState.pagination.currentPage = 1;
    syncFilterControlsFromState();
    loadActivityData();
    loadAnalyticsData();
}

// --- Formatting & Badge Helpers ---

function cleanIpDisplay(ip) {
    if (!ip) return 'N/A';
    let s = String(ip).trim();
    if (s.startsWith('::ffff:')) s = s.substring(7);
    if (s === '::1') return '127.0.0.1';
    return s || 'N/A';
}

function formatLocalYMD(dateObj) {
    if (!dateObj || isNaN(dateObj.getTime())) return '';
    const y = dateObj.getFullYear();
    const m = String(dateObj.getMonth() + 1).padStart(2, '0');
    const d = String(dateObj.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
}

function formatDateColumn(isoStr) {
    if (!isoStr) return 'N/A';
    const d = new Date(isoStr);
    if (isNaN(d.getTime())) return 'N/A';
    return formatLocalYMD(d);
}

function formatTimeColumn(isoStr) {
    if (!isoStr) return '-';
    const d = new Date(isoStr);
    if (isNaN(d.getTime())) return '-';
    const hh = String(d.getHours()).padStart(2, '0');
    const mm = String(d.getMinutes()).padStart(2, '0');
    const ss = String(d.getSeconds()).padStart(2, '0');
    return `${hh}:${mm}:${ss}`;
}

function renderMediaTypeBadge(mediaType) {
    const type = String(mediaType || 'live').toLowerCase();
    if (type === 'movie') {
        return `<span class="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-semibold bg-purple-500/15 text-purple-300 border border-purple-500/30">🎬 Movie</span>`;
    }
    if (type === 'series') {
        return `<span class="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-semibold bg-indigo-500/15 text-indigo-300 border border-indigo-500/30">🎞️ Series</span>`;
    }
    if (type === 'dvr') {
        return `<span class="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-semibold bg-rose-500/15 text-rose-300 border border-rose-500/30">⏺ DVR</span>`;
    }
    return `<span class="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-semibold bg-blue-500/15 text-blue-300 border border-blue-500/30">📺 Live TV</span>`;
}

function renderStreamModeBadge(profileName, isTranscoded) {
    const prof = profileName || 'Redirect';
    if (!isTranscoded) {
        return `<span class="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs font-semibold bg-emerald-500/15 text-emerald-300 border border-emerald-500/30" title="Direct Stream (${escapeAttr(prof)})"><span class="w-1.5 h-1.5 rounded-full bg-emerald-400"></span>Direct Play</span>`;
    }
    return `<span class="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs font-semibold bg-amber-500/15 text-amber-300 border border-amber-500/30" title="Transcoding Profile: ${escapeAttr(prof)}"><span class="w-1.5 h-1.5 rounded-full bg-amber-400"></span>${escapeHtml(prof)}</span>`;
}

function escapeHtml(str) {
    return String(str ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function escapeAttr(str) {
    return escapeHtml(str);
}

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
            const durationSeconds = Math.max(0, Math.round((now - start) / 1000));
            el.textContent = formatDuration(durationSeconds);
        }
    });
}

/**
 * Formats a duration in seconds to a human-readable string (e.g., 1h 23m 45s).
 * @param {number} totalSeconds - The duration in seconds.
 * @param {boolean} shortFormat - If true, returns a compact format (e.g., 1.4h).
 * @returns {string} The formatted duration string.
 */
function formatDuration(totalSeconds, shortFormat = false) {
    if (totalSeconds === null || totalSeconds === undefined || isNaN(totalSeconds) || totalSeconds < 0) return 'N/A';

    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = Math.floor(totalSeconds % 60);

    if (shortFormat) {
        if (hours > 0) return `${(totalSeconds / 3600).toFixed(1)}h`;
        if (minutes > 0) return `${Math.round(totalSeconds / 60)}m`;
        return `${seconds}s`;
    }

    if (totalSeconds < 60) return `${seconds}s`;

    let result = '';
    if (hours > 0) result += `${hours}h `;
    if (minutes > 0) result += `${minutes}m `;
    if (hours === 0 && minutes < 5 && seconds > 0) result += `${seconds}s`;

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
