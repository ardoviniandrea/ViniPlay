/**
 * guide.js
 * * Manages all functionality related to the TV Guide,
 * including data loading, rendering, searching, and user interaction.
 *
 * REFACTORED to use UI Virtualization for high-performance rendering of large channel lists.
 */

import { appState, guideState, UIElements, dvrState } from './state.js';
import { saveUserSetting, getDeviceSetting, saveDeviceSetting } from './api.js';
import { parseM3U, formatTimeWithOffset, proxiedImageUrl } from './utils.js';
import { playChannel } from './player.js';
import { showNotification, openModal, closeModal } from './ui.js';
import { addOrRemoveNotification, findNotificationForProgram } from './notification.js';
import { addOrRemoveDvrJob, findDvrJobForProgram } from './dvr.js';
import { ICONS } from './icons.js'; // MODIFIED: Import the new icon library

// --- Virtualization Constants ---
const ROW_HEIGHT = 96; // Height in pixels of a single channel row (.channel-info + .timeline-row)
const OVERSCAN_COUNT = 5; // Number of extra rows to render above and below the visible area for smooth scrolling

// Track logo URLs that returned 404/error with a 60-second cooldown so virtual scrolling does not spam dead URLs,
// while allowing "?" logos to auto-heal when scrolling back later if the upstream source comes back online.
const LOGO_FAIL_COOLDOWN_MS = 60 * 1000;
export const failedLogoUrls = new Map();
if (typeof window !== 'undefined') {
    window.__viniMarkLogoFailed = (url) => {
        if (url) failedLogoUrls.set(url, Date.now());
    };
    window.__viniClearLogoFailed = (url) => {
        if (url) failedLogoUrls.delete(url);
    };
}

/**
 * NEW: Opens the program details modal. This is now a standalone, exportable function.
 * @param {HTMLElement} progItem - The program item element that was clicked.
 */
export function openProgramDetails(progItem) {
    console.log('[GUIDE_DEBUG] openProgramDetails function called for element:', progItem);
    if (!progItem || !progItem.dataset) {
        console.error('[GUIDE_DEBUG] openProgramDetails called with an invalid or null element.');
        return;
    }

    const programDetailsModal = document.getElementById('program-details-modal');
    if (!programDetailsModal) {
        console.error('[GUIDE_DEBUG] programDetailsModal element not found in DOM when opening details.');
        showNotification('Error: Program details modal is missing. Please refresh the page.', true);
        return;
    }

    const channelId = progItem.dataset.channelId;
    const programData = {
        title: progItem.dataset.progTitle,
        desc: progItem.dataset.progDesc,
        start: progItem.dataset.progStart,
        stop: progItem.dataset.progStop,
        channelId: channelId,
        programId: progItem.dataset.progId,
        url: progItem.dataset.channelUrl,
    };

    const channelData = guideState.channels.find(c => c.id === channelId);
    if (!channelData) {
        console.error(`[GUIDE_DEBUG] Could not find channel data for ID: ${channelId}`);
        showNotification("Error: Could not find channel data for this program.", true);
        return;
    }

    const channelName = channelData.displayName || channelData.name;
    const channelLogo = proxiedImageUrl(channelData.logo);
    const channelUrl = channelData.url;

    // Get fresh references to buttons inside the modal
    const detailsTitle = programDetailsModal.querySelector('#details-title');
    const detailsTime = programDetailsModal.querySelector('#details-time');
    const detailsDesc = programDetailsModal.querySelector('#details-desc');
    const detailsPlayBtn = programDetailsModal.querySelector('#details-play-btn');
    const programDetailsNotifyBtn = programDetailsModal.querySelector('#program-details-notify-btn');
    const programDetailsRecordBtn = programDetailsModal.querySelector('#details-record-btn');
    const detailsCloseBtn = programDetailsModal.querySelector('#details-close-btn');
    const detailsFavoriteBtn = programDetailsModal.querySelector('#details-favorite-btn');

    if (detailsTitle) detailsTitle.textContent = programData.title;
    const progStart = new Date(programData.start);
    const progStop = new Date(programData.stop);
    const offset = guideState.settings.timezoneOffset || 0;
    if (detailsTime) detailsTime.textContent = `${formatTimeWithOffset(progStart, offset)} - ${formatTimeWithOffset(progStop, offset)}`;
    if (detailsDesc) detailsDesc.textContent = programData.desc || "No description available.";

    if (detailsPlayBtn) {
        detailsPlayBtn.onclick = () => {
            playChannel(channelUrl, channelName, channelId);
            handleRecentChannelsUpdated();
            closeModal(programDetailsModal);
        };
    }

    // Favorite button logic
    if (detailsFavoriteBtn) {
        // MODIFIED: Target the SVG icon inside the button for visual changes.
        const favoriteIcon = detailsFavoriteBtn.querySelector('.favorite-star');
        if (favoriteIcon) {
            favoriteIcon.classList.toggle('favorited', channelData.isFavorite);
        }

        detailsFavoriteBtn.onclick = (e) => {
            e.stopPropagation();
            channelData.isFavorite = !channelData.isFavorite;

            // MODIFIED: Toggle the class on the icon, not the button.
            if (favoriteIcon) {
                favoriteIcon.classList.toggle('favorited', channelData.isFavorite);
            }

            // Also update the star in the main guide view if it exists
            const guideStar = document.querySelector(`.favorite-star[data-channel-id="${channelId}"]`);
            if (guideStar) {
                guideStar.classList.toggle('favorited', channelData.isFavorite);
            }

            guideState.settings.favorites = guideState.channels.filter(c => c.isFavorite).map(c => c.id);
            saveUserSetting('favorites', guideState.settings.favorites);

            updateQuickFilterButtonsUI();
            if (isGroupFilterIncluding('favorites')) {
                handleSearchAndFilter(false, true);
            }
        };
    }

    const now = new Date();
    const programStopTime = new Date(programData.stop).getTime();
    const isProgramRelevant = programStopTime > now.getTime();

    // --- Notification Button Logic ---
    if (programDetailsNotifyBtn) {
        const notification = findNotificationForProgram(programData, channelId);
        if (isProgramRelevant) {
            programDetailsNotifyBtn.classList.remove('hidden');
            programDetailsNotifyBtn.textContent = notification ? 'Notification Set' : 'Notify Me';
            programDetailsNotifyBtn.disabled = !notification && !window.ViniAndroid && (typeof Notification !== 'undefined' && Notification.permission === 'denied');
            programDetailsNotifyBtn.classList.toggle('bg-yellow-600', !notification);
            programDetailsNotifyBtn.classList.toggle('hover:bg-yellow-700', !notification);
            programDetailsNotifyBtn.classList.toggle('bg-gray-600', !!notification);
            programDetailsNotifyBtn.classList.toggle('hover:bg-gray-500', !!notification);

            programDetailsNotifyBtn.onclick = async () => {
                await addOrRemoveNotification({
                    id: notification ? notification.id : null,
                    channelId: programData.channelId,
                    channelName: channelName,
                    channelLogo: channelLogo,
                    programTitle: programData.title,
                    programStart: programData.start,
                    programStop: programData.stop,
                    programDesc: programData.desc,
                    programId: programData.programId
                });
                const updatedNotification = findNotificationForProgram(programData, channelId);
                programDetailsNotifyBtn.textContent = updatedNotification ? 'Notification Set' : 'Notify Me';
                programDetailsNotifyBtn.classList.toggle('bg-yellow-600', !updatedNotification);
                programDetailsNotifyBtn.classList.toggle('hover:bg-yellow-700', !updatedNotification);
                programDetailsNotifyBtn.classList.toggle('bg-gray-600', !!updatedNotification);
                programDetailsNotifyBtn.classList.toggle('hover:bg-gray-500', !!updatedNotification);
                handleSearchAndFilter(false, true);
            };
        } else {
            programDetailsNotifyBtn.classList.add('hidden');
        }
    }

    // --- DVR Record Button Logic (with permission check) ---
    const hasDvrAccess = appState.currentUser?.isAdmin || appState.currentUser?.canUseDvr;
    if (programDetailsRecordBtn && hasDvrAccess) {
        const dvrJob = findDvrJobForProgram(programData);

        if (isProgramRelevant) {
            programDetailsRecordBtn.classList.remove('hidden');

            let buttonText = 'Record';
            let buttonClass = 'bg-red-600';
            let hoverClass = 'hover:bg-red-700';
            let isDisabled = false;

            if (dvrJob) {
                switch (dvrJob.status) {
                    case 'scheduled':
                        buttonText = 'Cancel Recording';
                        buttonClass = 'bg-gray-600';
                        hoverClass = 'hover:bg-gray-500';
                        break;
                    case 'recording':
                        buttonText = 'Recording...';
                        buttonClass = 'bg-red-800';
                        hoverClass = 'hover:bg-red-800';
                        isDisabled = true;
                        break;
                    case 'completed':
                    case 'error':
                        buttonText = dvrJob.status === 'completed' ? 'Recorded' : 'Error';
                        buttonClass = dvrJob.status === 'completed' ? 'bg-green-600' : 'bg-orange-600';
                        hoverClass = dvrJob.status === 'completed' ? 'hover:bg-green-600' : 'hover:bg-orange-600';
                        isDisabled = true;
                        break;
                }
            }

            programDetailsRecordBtn.textContent = buttonText;
            programDetailsRecordBtn.className = `font-bold py-2 px-4 rounded-md transition-colors ${buttonClass} ${hoverClass} text-white`;
            programDetailsRecordBtn.disabled = isDisabled;

            programDetailsRecordBtn.onclick = async () => {
                await addOrRemoveDvrJob(programData);
                closeModal(programDetailsModal);
                handleSearchAndFilter(false, true);
            };

        } else {
            programDetailsRecordBtn.classList.add('hidden');
        }
    } else if (programDetailsRecordBtn) {
        programDetailsRecordBtn.classList.add('hidden');
    }

    if (detailsCloseBtn) {
        detailsCloseBtn.onclick = () => closeModal(programDetailsModal);
    }

    openModal(programDetailsModal);
}


// --- Data Loading and Processing ---

/**
 * Handles loading guide data from the server response.
 * @param {string} m3uContent - The M3U playlist content.
 * @param {object} epgContent - The parsed EPG JSON data.
 */
export async function handleGuideLoad(m3uContent, epgContent, shouldCenter = false) {
    console.log('[GUIDE_LOAD_DEBUG] handleGuideLoad called with shouldCenter:', shouldCenter);
    console.log('[GUIDE_LOAD_DEBUG] m3uContent length:', m3uContent?.length || 0);

    if (!m3uContent || m3uContent.trim() === '#EXTM3U') {
        guideState.channels = [];
        guideState.programs = {};
    } else {
        guideState.channels = parseM3U(m3uContent);
        guideState.programs = epgContent || {};
    }

    if (appState.db) {
        await appState.db.transaction(['guideData'], 'readwrite').objectStore('guideData').put(guideState.channels, 'channels');
        await appState.db.transaction(['guideData'], 'readwrite').objectStore('guideData').put(guideState.programs, 'programs');
    }

    console.log('[GUIDE_LOAD_DEBUG] About to call finalizeGuideLoad with shouldCenter:', shouldCenter);
    return finalizeGuideLoad(shouldCenter);
}

/**
 * A helper function to format a Date object into 'YYYY-MM-DD' string format for date inputs.
 * @param {Date} date - The date to format.
 * @returns {string} The formatted date string.
 */
const formatDateForInput = (date) => {
    const year = date.getFullYear();
    const month = (date.getMonth() + 1).toString().padStart(2, '0');
    const day = date.getDate().toString().padStart(2, '0');
    return `${year}-${month}-${day}`;
};


/**
 * Scans all programs to determine the earliest start date and latest end date.
 * @returns {{minDate: Date, maxDate: Date}|null} An object with min and max dates, or null if no programs exist.
 */
const getEpgDateRange = () => {
    let minDate = null;
    let maxDate = null;

    if (!guideState.programs || Object.keys(guideState.programs).length === 0) {
        return null;
    }

    for (const channelId in guideState.programs) {
        for (const prog of guideState.programs[channelId]) {
            const startDate = new Date(prog.start);
            const stopDate = new Date(prog.stop);
            if (isNaN(startDate.getTime()) || isNaN(stopDate.getTime())) continue;
            if (!minDate || startDate < minDate) {
                minDate = startDate;
            }
            if (!maxDate || stopDate > maxDate) {
                maxDate = stopDate;
            }
        }
    }

    if (!minDate || !maxDate) {
        return null;
    }

    return { minDate, maxDate };
};


/**
 * Returns the effective numeric timezone offset in hours, falling back to the browser's offset.
 */
export const getEffectiveTimezoneOffset = () => {
    const raw = guideState.settings?.timezoneOffset;
    if (raw !== undefined && raw !== null && !Number.isNaN(Number(raw))) {
        return Number(raw);
    }
    return Math.round(-(new Date().getTimezoneOffset() / 60));
};

/**
 * Computes the UTC timestamp corresponding to 00:00 (midnight) of the selected date in the configured timezone.
 */
export const computeGuideStartUtc = (dateObj = guideState.currentDate, offsetOverride = null) => {
    const selectedDate = new Date(dateObj);
    const offset = offsetOverride !== null ? Number(offsetOverride) : getEffectiveTimezoneOffset();
    const offsetMs = offset * 3600000;
    return new Date(Date.UTC(
        selectedDate.getFullYear(),
        selectedDate.getMonth(),
        selectedDate.getDate(),
        0, 0, 0, 0
    ) - offsetMs);
};

/**
 * Returns the actual rendered width in pixels of the sticky channel column.
 */
export const getEffectiveChannelColumnWidth = () => {
    if (window.innerWidth < 768) {
        return 64;
    }
    const timeBarCell = UIElements.guideGrid?.querySelector('.time-bar-cell');
    if (timeBarCell && timeBarCell.offsetLeft > 0) {
        return timeBarCell.offsetLeft;
    }
    const stickyCorner = UIElements.guideGrid?.querySelector('.sticky-corner');
    if (stickyCorner && stickyCorner.offsetWidth > 0) {
        return stickyCorner.offsetWidth;
    }
    if (UIElements.guideGrid) {
        const cssVar = parseFloat(getComputedStyle(UIElements.guideGrid).getPropertyValue('--channel-col-width'));
        if (Number.isFinite(cssVar) && cssVar > 0) {
            return cssVar;
        }
    }
    const stateWidth = Number(guideState.settings?.channelColumnWidth);
    if (Number.isFinite(stateWidth) && stateWidth > 0) {
        return stateWidth;
    }
    return 180;
};

/**
 * Hides #now-line when horizontal scrolling moves it behind the sticky left channel column.
 */
export const syncNowLineVisibilityWithScroll = () => {
    const nowLineEl = document.getElementById('now-line');
    if (!nowLineEl) return;
    if (guideState.lastNowOffsetPx === null || !Number.isFinite(guideState.lastNowOffsetPx)) {
        nowLineEl.classList.add('hidden');
        return;
    }
    const scrollLeft = UIElements.guideContainer ? UIElements.guideContainer.scrollLeft : 0;
    const isBehindChannelColumn = guideState.lastNowOffsetPx <= scrollLeft + 1;
    nowLineEl.classList.toggle('hidden', isBehindChannelColumn);
};

/**
 * Computes the horizontal scrollLeft target that centers #now-line in the visible timeline area.
 */
const computeNowScrollTarget = (leftOffsetInScrollableArea) => {
    const guideContainer = UIElements.guideContainer;
    if (!guideContainer) return 0;
    const channelInfoColWidth = getEffectiveChannelColumnWidth();
    const isMobile = window.innerWidth < 768;
    const rawTargetLeft = isMobile
        ? (channelInfoColWidth + leftOffsetInScrollableArea) - (guideContainer.clientWidth / 2)
        : leftOffsetInScrollableArea - (guideContainer.clientWidth / 4);
    return Math.max(0, Number.isFinite(rawTargetLeft) ? rawTargetLeft : 0);
};

/**
 * Smoothly scrolls the guide timeline horizontally to center on the given #now-line offset.
 */
const scrollToNowLine = (leftOffsetInScrollableArea, smooth = true) => {
    const guideContainer = UIElements.guideContainer;
    if (!guideContainer) return;
    const isGuideVisible = UIElements.pageGuide && !UIElements.pageGuide.classList.contains('hidden') && guideContainer.clientWidth > 0;
    if (!isGuideVisible) {
        guideState.needsCenterOnActivate = true;
        return;
    }

    const targetLeft = computeNowScrollTarget(leftOffsetInScrollableArea);

    guideState.lastProgrammaticScrollAt = Date.now();
    guideState.lastAutoScrollAt = Date.now();
    guideState.savedScrollLeft = targetLeft;
    guideState.needsCenterOnActivate = false;

    guideContainer.scrollTo({
        left: targetLeft,
        behavior: smooth ? 'smooth' : 'auto'
    });
    setTimeout(syncNowLineVisibilityWithScroll, smooth ? 350 : 20);
};

/**
 * Finalizes the guide setup after data is loaded from any source (API or cache).
 * @param {boolean} shouldCenter - Indicates if the guide should auto-center to current time.
 */
export function finalizeGuideLoad(shouldCenter = false) {
    const favoriteIds = new Set(guideState.settings.favorites || []);
    guideState.channels.forEach(channel => {
        channel.isFavorite = favoriteIds.has(channel.id);
    });

    guideState.channelGroups.clear();
    guideState.channelSources.clear();
    guideState.channels.forEach(ch => {
        if (ch.group) guideState.channelGroups.add(ch.group);
        if (ch.source) guideState.channelSources.add(ch.source);
    });
    populateSourceFilter();
    populateGroupFilter();

    appState.fuseChannels = new Fuse(guideState.channels, {
        keys: ['name', 'displayName', 'source', 'chno'],
        threshold: 0.4,
        includeScore: true,
    });

    const epgRange = getEpgDateRange();
    if (epgRange && UIElements.guideDatePicker) {
        UIElements.guideDatePicker.min = formatDateForInput(epgRange.minDate);
        UIElements.guideDatePicker.max = formatDateForInput(epgRange.maxDate);
        UIElements.guideDatePicker.value = formatDateForInput(guideState.currentDate);
        UIElements.guideDatePicker.disabled = false;
    } else if (UIElements.guideDatePicker) {
        UIElements.guideDatePicker.disabled = true;
    }

    guideState.isViewingToday = formatDateForInput(new Date(guideState.currentDate)) === formatDateForInput(new Date());

    const allPrograms = [];
    const guideStart = computeGuideStartUtc(guideState.currentDate);
    const guideEnd = new Date(guideStart.getTime() + guideState.guideDurationHours * 3600 * 1000);

    for (const channelId in guideState.programs) {
        const channel = guideState.channels.find(c => c.id === channelId);
        if (channel) {
            guideState.programs[channelId].forEach(prog => {
                const progStart = new Date(prog.start);
                const progStop = new Date(prog.stop);
                if (progStop < guideStart || progStart > guideEnd) return;

                allPrograms.push({
                    ...prog,
                    channel: {
                        id: channel.id,
                        name: channel.displayName || channel.name,
                        logo: channel.logo,
                        source: channel.source,
                    },
                    programId: `${channel.id}-${progStart.toISOString()}-${progStop.toISOString()}`
                });
            });
        }
    }

    appState.fusePrograms = new Fuse(allPrograms, {
        keys: ['title'],
        threshold: 0.4,
        includeScore: true,
    });

    return handleSearchAndFilter(shouldCenter);
}

// --- UI Rendering (REFACTORED FOR VIRTUALIZATION) ---

/**
 * Renders the guide using UI virtualization.
 * @param {Array<object>} channelsToRender - The filtered list of channels to display.
 * @param {boolean} resetScroll - If true, scrolls the guide to the top-left.
 * @param {boolean} shouldCenter - If true, centers the guide on the current time.
 * @returns {Promise<boolean>} A promise that resolves when the initial render is complete.
 */
const renderGuide = (channelsToRender, resetScroll = false, shouldCenter = false) => {
    return new Promise((resolve) => {
        guideState.visibleChannels = channelsToRender;
        const totalRows = channelsToRender.length;
        const showNoData = totalRows === 0;

        UIElements.guidePlaceholder.classList.toggle('hidden', !showNoData);
        UIElements.noDataMessage.classList.toggle('hidden', !showNoData);
        UIElements.initialLoadingIndicator.classList.add('hidden');
        UIElements.guideGrid.classList.toggle('hidden', showNoData);
        if (showNoData) {
            UIElements.guideGrid.innerHTML = '';
            resolve(true);
            return;
        }

        const selectedDate = new Date(guideState.currentDate);
        const offset = getEffectiveTimezoneOffset();
        const guideStartUtc = computeGuideStartUtc(selectedDate, offset);

        guideState.renderedGuideStartUtc = guideStartUtc;
        guideState.renderedTimezoneOffset = offset;
        guideState.renderedDateStr = formatDateForInput(selectedDate);
        guideState.isViewingToday = guideState.renderedDateStr === formatDateForInput(new Date());

        const timelineWidth = guideState.guideDurationHours * guideState.hourWidthPixels;
        UIElements.guideGrid.style.setProperty('--timeline-width', `${timelineWidth}px`);
        UIElements.guideDateDisplay.textContent = selectedDate.toLocaleDateString([], { weekday: 'short', month: 'long', day: 'numeric' });

        // CRITICAL FIX: Ensure static HTML elements exist
        if (!UIElements.guideGrid.querySelector('.sticky-corner')) {
            const stickyCorner = document.createElement('div');
            stickyCorner.className = 'sticky-corner flex items-center justify-center p-2 sm:p-4';
            stickyCorner.innerHTML = `
                <div class="flex items-center gap-2">
                    <button id="now-btn" class="bg-blue-600 hover:bg-blue-700 text-white font-bold py-2 px-3 rounded-md text-sm transition-colors">Now</button>
                </div>
                <div id="channel-column-resize-handle" class="channel-resize-handle"></div>
            `;
            UIElements.guideGrid.appendChild(stickyCorner);

            UIElements.channelColumnResizeHandle = document.getElementById('channel-column-resize-handle');

            if (UIElements.channelColumnResizeHandle && window.innerWidth >= 768) {
                import('./ui.js').then(({ makeColumnResizable }) => {
                    makeColumnResizable(UIElements.channelColumnResizeHandle, UIElements.guideGrid, 100, 'channelColumnWidth', '--channel-col-width');
                });
            }
        }

        if (!UIElements.guideGrid.querySelector('.time-bar-cell')) {
            const timeBarCell = document.createElement('div');
            timeBarCell.className = 'time-bar-cell';
            const stickyCorner = UIElements.guideGrid.querySelector('.sticky-corner');
            if (stickyCorner) {
                stickyCorner.insertAdjacentElement('afterend', timeBarCell);
            } else {
                UIElements.guideGrid.appendChild(timeBarCell);
            }
        }

        if (!document.getElementById('now-line')) {
            const nowLine = document.createElement('div');
            nowLine.id = 'now-line';
            nowLine.className = 'absolute top-0 bg-red-500 w-0.5 pointer-events-none hidden';
            UIElements.guideGrid.appendChild(nowLine);
        }

        const timeBarCellEl = UIElements.guideGrid.querySelector('.time-bar-cell');
        if (timeBarCellEl) {
            let timeCellsHTML = '';
            for (let i = 0; i < guideState.guideDurationHours; i++) {
                const time = new Date(guideStartUtc.getTime() + i * 3600 * 1000);
                timeCellsHTML += `<div class="absolute top-0 bottom-0 flex items-center justify-start px-2 text-xs text-gray-400 border-r border-gray-700/50" style="left: ${i * guideState.hourWidthPixels}px; width:${guideState.hourWidthPixels}px;">${formatTimeWithOffset(time, offset)}</div>`;
            }
            timeBarCellEl.innerHTML = timeCellsHTML;
            timeBarCellEl.style.width = `${timelineWidth}px`;
        }

        const guideContainer = UIElements.guideContainer;
        const guideGrid = UIElements.guideGrid;

        const isGuideVisible = Boolean(UIElements.pageGuide && !UIElements.pageGuide.classList.contains('hidden') && guideContainer && guideContainer.clientHeight > 0);
        const currentScrollTop = isGuideVisible ? guideContainer.scrollTop : (guideState.savedScrollTop || 0);
        const currentScrollLeft = isGuideVisible ? guideContainer.scrollLeft : (guideState.savedScrollLeft || 0);
        if (!isGuideVisible) {
            guideState.needsViewportRefreshOnActivate = true;
            if (shouldCenter) {
                guideState.needsCenterOnActivate = true;
            }
        }

        let contentWrapper = guideGrid.querySelector('#virtual-content-wrapper');
        if (contentWrapper) {
            guideGrid.removeChild(contentWrapper);
        }

        contentWrapper = document.createElement('div');
        contentWrapper.id = 'virtual-content-wrapper';
        contentWrapper.style.gridColumn = '1 / -1';
        contentWrapper.style.position = 'relative';
        contentWrapper.style.height = `${totalRows * ROW_HEIGHT}px`;

        const rowContainer = document.createElement('div');
        rowContainer.id = 'virtual-row-container';
        rowContainer.style.position = 'absolute';
        rowContainer.style.width = '100%';
        rowContainer.style.top = '0';
        rowContainer.style.left = '0';
        rowContainer.style.display = 'grid';
        rowContainer.style.gridTemplateColumns = 'var(--channel-col-width, 180px) 1fr';

        contentWrapper.appendChild(rowContainer);
        guideGrid.appendChild(contentWrapper);

        let lastRenderedStartIndex = -1;
        let lastRenderedEndIndex = -1;

        const updateVisibleRows = (force = false) => {
            if (!guideContainer) return;
            const scrollTop = guideContainer.scrollTop;
            const effectiveClientHeight = guideContainer.clientHeight > 0
                ? guideContainer.clientHeight
                : Math.max(400, window.innerHeight - 140);
            const startIndex = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - OVERSCAN_COUNT);
            const endIndex = Math.min(totalRows, Math.ceil((scrollTop + effectiveClientHeight) / ROW_HEIGHT) + OVERSCAN_COUNT);

            // Avoid rebuilding DOM during horizontal scrolling when vertical row range has not changed
            if (!force && startIndex === lastRenderedStartIndex && endIndex === lastRenderedEndIndex) {
                return;
            }
            lastRenderedStartIndex = startIndex;
            lastRenderedEndIndex = endIndex;

            const activeGuideStartUtc = guideState.renderedGuideStartUtc || guideStartUtc;
            const activeOffset = guideState.renderedTimezoneOffset ?? offset;
            const guideEnd = new Date(activeGuideStartUtc.getTime() + guideState.guideDurationHours * 3600 * 1000);
            const now = new Date();

            let rowsHTML = '';
            const sourceColors = ['bg-blue-600', 'bg-green-600', 'bg-pink-600', 'bg-yellow-500', 'bg-indigo-600', 'bg-red-600'];
            const sourceColorMap = new Map();
            let colorIndex = 0;

            for (let i = startIndex; i < endIndex; i++) {
                const channel = channelsToRender[i];
                if (!channel) continue;
                const channelName = channel.displayName || channel.name;

                if (!sourceColorMap.has(channel.source)) {
                    sourceColorMap.set(channel.source, sourceColors[colorIndex % sourceColors.length]);
                    colorIndex++;
                }
                const sourceBadgeColor = sourceColorMap.get(channel.source);
                const sourceBadgeHTML = guideState.channelSources.size > 1 ? `<span class="source-badge ${sourceBadgeColor} text-white">${channel.source}</span>` : '';
                const chnoBadgeHTML = channel.chno ? `<span class="chno-badge">${channel.chno}</span>` : '';

                const starIconHTML = ICONS.star.replace(
                    'class="w-5 h-5"',
                    `data-channel-id="${channel.id}" class="w-6 h-6 text-gray-500 hover:text-yellow-400 favorite-star cursor-pointer ${channel.isFavorite ? 'favorited' : ''}"`
                );

                const rawLogoUrl = proxiedImageUrl(channel.logo);
                const fallbackLogoUrl = 'https://placehold.co/48x48/1f2937/d1d5db?text=?';
                let effectiveLogoUrl = fallbackLogoUrl;
                if (rawLogoUrl) {
                    const failedAt = failedLogoUrls.get(rawLogoUrl);
                    if (!failedAt) {
                        effectiveLogoUrl = rawLogoUrl;
                    } else if ((Date.now() - failedAt) >= LOGO_FAIL_COOLDOWN_MS) {
                        const sep = rawLogoUrl.includes('?') ? '&' : '?';
                        effectiveLogoUrl = `${rawLogoUrl}${sep}r=${failedAt}`;
                    }
                }

                const channelInfoHTML = `
                    <div class="channel-info p-2 flex items-center justify-between cursor-pointer" data-url="${channel.url}" data-name="${channelName}" data-id="${channel.id}" data-channel-index="${i}">
                        <div class="flex items-center overflow-hidden flex-grow min-w-0">
                            <img src="${effectiveLogoUrl}" data-logo-src="${rawLogoUrl || ''}" onload="if (this.src !== '${fallbackLogoUrl}' && window.__viniClearLogoFailed) window.__viniClearLogoFailed(this.dataset.logoSrc);" onerror="window.__viniMarkLogoFailed && window.__viniMarkLogoFailed(this.dataset.logoSrc); this.onerror=null; this.src='${fallbackLogoUrl}';" class="w-12 h-12 object-contain mr-3 flex-shrink-0 rounded-md bg-gray-700">
                            <div class="flex-grow min-w-0 channel-details">
                                <span class="font-semibold text-sm truncate block">${channelName}</span>
                                <div class="flex items-center gap-2 mt-1">
                                    ${chnoBadgeHTML}
                                    ${sourceBadgeHTML}
                                </div>
                            </div>
                        </div>
                        <div class="hidden md:flex items-center justify-center ml-2 flex-shrink-0">
                            ${starIconHTML}
                        </div>
                    </div>
                `;

                let programsHTML = '';
                (guideState.programs[channel.id] || []).forEach((prog) => {
                    const progStart = new Date(prog.start);
                    const progStop = new Date(prog.stop);
                    if (progStop < activeGuideStartUtc || progStart > guideEnd) return;

                    const durationMs = progStop - progStart;
                    if (durationMs <= 0) return;

                    let left = ((progStart.getTime() - activeGuideStartUtc.getTime()) / 3600000) * guideState.hourWidthPixels;
                    let width = (durationMs / 3600000) * guideState.hourWidthPixels;

                    if (left < 0) {
                        width = width + left;
                        left = 0;
                    }
                    if (width <= 0) return;

                    const isLive = now >= progStart && now < progStop;
                    const progressWidth = isLive ? ((now - progStart) / durationMs) * 100 : 0;

                    const uniqueProgramId = `${channel.id}-${progStart.toISOString()}-${progStop.toISOString()}`;

                    const hasNotification = findNotificationForProgram({ ...prog, programId: uniqueProgramId }, channel.id);
                    const notificationClass = hasNotification ? 'has-notification' : '';

                    const dvrJob = findDvrJobForProgram({ ...prog, channelId: channel.id });
                    const recordingClass = dvrJob ? `has-recording status-${dvrJob.status}` : '';

                    programsHTML += `<div class="programme-item absolute top-1 bottom-1 bg-gray-800 rounded-md p-2 overflow-hidden flex flex-col justify-center z-5 ${isLive ? 'live' : ''} ${progStop < now ? 'past' : ''} ${notificationClass} ${recordingClass}" style="left:${left}px; width:${Math.max(0, width - 2)}px" data-channel-url="${channel.url}" data-channel-id="${channel.id}" data-channel-name="${channelName}" data-prog-title="${prog.title}" data-prog-desc="${prog.desc}" data-prog-start="${progStart.toISOString()}" data-prog-stop="${progStop.toISOString()}" data-prog-id="${uniqueProgramId}"><div class="programme-progress" style="width:${progressWidth}%"></div><p class="prog-title text-white font-semibold truncate relative z-10">${prog.title}</p><p class="prog-time text-gray-400 truncate relative z-10">${formatTimeWithOffset(progStart, activeOffset)} - ${formatTimeWithOffset(progStop, activeOffset)}</p></div>`;
                });
                const timelineRowHTML = `<div class="timeline-row" style="width: ${timelineWidth}px;">${programsHTML}</div>`;

                rowsHTML += channelInfoHTML + timelineRowHTML;
            }

            rowContainer.innerHTML = rowsHTML;
            rowContainer.style.top = `${startIndex * ROW_HEIGHT}px`;
        };

        guideState.updateVisibleRows = updateVisibleRows;

        if (guideState.scrollHandler) {
            guideContainer.removeEventListener('scroll', guideState.scrollHandler);
        }

        const throttledVerticalUpdate = throttle(() => updateVisibleRows(false), 16);
        let prevScrollLeft = currentScrollLeft;
        let prevScrollTop = currentScrollTop;

        guideState.scrollHandler = () => {
            if (!guideContainer) return;
            syncNowLineVisibilityWithScroll();

            const curLeft = guideContainer.scrollLeft;
            const curTop = guideContainer.scrollTop;

            if (Math.abs(curLeft - prevScrollLeft) > 1) {
                prevScrollLeft = curLeft;
                guideState.savedScrollLeft = curLeft;
                if (Date.now() - (guideState.lastProgrammaticScrollAt || 0) > 650) {
                    guideState.lastUserHorizontalScrollAt = Date.now();
                    if (guideState.centerScrollTimer) {
                        clearTimeout(guideState.centerScrollTimer);
                        guideState.centerScrollTimer = null;
                    }
                    if (guideState.idleAutoScrollTimer) {
                        clearTimeout(guideState.idleAutoScrollTimer);
                    }
                    guideState.idleAutoScrollTimer = setTimeout(() => {
                        guideState.idleAutoScrollTimer = null;
                        if (guideState.isViewingToday && document.visibilityState === 'visible') {
                            updateNowLine(guideState.renderedGuideStartUtc, false);
                        }
                    }, 2 * 60 * 1000 + 250);
                }
            }

            if (Math.abs(curTop - prevScrollTop) > 1) {
                prevScrollTop = curTop;
                guideState.savedScrollTop = curTop;
                throttledVerticalUpdate();
            }
        };
        guideContainer.addEventListener('scroll', guideState.scrollHandler, { passive: true });

        if (resetScroll) {
            guideState.savedScrollTop = 0;
            guideState.savedScrollLeft = 0;
            guideState.lastProgrammaticScrollAt = Date.now();
            guideContainer.scrollTop = 0;
            guideContainer.scrollLeft = 0;
        } else {
            guideState.lastProgrammaticScrollAt = Date.now();
            guideContainer.scrollTop = currentScrollTop;
            if (!shouldCenter) {
                guideContainer.scrollLeft = currentScrollLeft;
            }
            requestAnimationFrame(() => {
                guideState.lastProgrammaticScrollAt = Date.now();
                guideContainer.scrollTop = currentScrollTop;
                if (!shouldCenter) {
                    guideContainer.scrollLeft = currentScrollLeft;
                }
                syncNowLineVisibilityWithScroll();
            });
        }

        updateVisibleRows(true);
        updateNowLine(guideStartUtc, shouldCenter);

        const nowBtn = UIElements.guideGrid.querySelector('#now-btn');
        if (nowBtn) nowBtn.onclick = () => {
            const now = new Date();
            guideState.isViewingToday = true;
            guideState.lastUserHorizontalScrollAt = 0;

            const todayStr = formatDateForInput(now);
            const currentOffset = getEffectiveTimezoneOffset();
            const expectedStartUtc = computeGuideStartUtc(now, currentOffset);
            const needsFullRender =
                guideState.renderedDateStr !== todayStr ||
                guideState.renderedTimezoneOffset !== currentOffset ||
                !guideState.renderedGuideStartUtc ||
                guideState.renderedGuideStartUtc.getTime() !== expectedStartUtc.getTime() ||
                !UIElements.guideGrid?.querySelector('.channel-info');

            guideState.currentDate = now;
            if (needsFullRender) {
                finalizeGuideLoad(true);
            } else {
                updateVisibleRows(true);
                updateNowLine(guideState.renderedGuideStartUtc, true);
            }
        };

        setTimeout(() => resolve(true), 100);
    });
};

/**
 * Updates the position of the "now" line, live program progress bars, day rollover, and smart live-follow auto-scroll.
 * @param {Date} guideStartUtc - The start time of the current guide view in UTC.
 * @param {boolean} shouldScroll - If true, scrolls the timeline to the now line.
 */
const updateNowLine = (guideStartUtc, shouldScroll = false) => {
    if (guideState.nowLineTimer) {
        clearTimeout(guideState.nowLineTimer);
        guideState.nowLineTimer = null;
    }

    const now = new Date();
    const todayStr = formatDateForInput(now);

    // Automatic day rollover if the session stayed open past midnight while viewing "Today"
    if (guideState.isViewingToday && guideState.renderedDateStr && guideState.renderedDateStr !== todayStr) {
        console.log('[GUIDE] Midnight day rollover detected while viewing Today. Advancing guide date.');
        guideState.currentDate = now;
        finalizeGuideLoad(true);
        return;
    }

    const activeGuideStartUtc = guideState.renderedGuideStartUtc || guideStartUtc || computeGuideStartUtc();
    const nowLineEl = document.getElementById('now-line');
    if (!nowLineEl) return;

    const nowValue = now.getTime();
    const guideEnd = new Date(activeGuideStartUtc.getTime() + guideState.guideDurationHours * 3600 * 1000);
    const channelInfoColWidth = getEffectiveChannelColumnWidth();

    if (nowValue >= activeGuideStartUtc.getTime() && nowValue <= guideEnd.getTime()) {
        const leftOffsetInScrollableArea = ((nowValue - activeGuideStartUtc.getTime()) / 3600000) * guideState.hourWidthPixels;
        guideState.lastNowOffsetPx = leftOffsetInScrollableArea;
        nowLineEl.style.left = `${channelInfoColWidth + leftOffsetInScrollableArea}px`;
        syncNowLineVisibilityWithScroll();

        if (shouldScroll) {
            if (guideState.centerScrollTimer) {
                clearTimeout(guideState.centerScrollTimer);
            }
            guideState.centerScrollTimer = setTimeout(() => {
                guideState.centerScrollTimer = null;
                scrollToNowLine(leftOffsetInScrollableArea, true);
            }, 60);
        } else {
            // Smart Live-Follow Auto-Scroll:
            // - Re-centers after 2 minutes of horizontal scroll inactivity if drifted/scrolled away (>= 30px)
            // - Smoothly advances every 5 minutes when left open on Today
            const AUTO_SCROLL_INTERVAL_MS = 5 * 60 * 1000;
            const USER_IDLE_THRESHOLD_MS = 2 * 60 * 1000;
            const isGuideVisible = Boolean(UIElements.pageGuide && !UIElements.pageGuide.classList.contains('hidden') && UIElements.guideContainer?.clientWidth > 0);
            const isModalOpen = document.body.classList.contains('modal-open');
            const timeSinceAutoScroll = Date.now() - (guideState.lastAutoScrollAt || 0);
            const timeSinceUserScroll = Date.now() - (guideState.lastUserHorizontalScrollAt || 0);

            if (
                guideState.isViewingToday &&
                document.visibilityState === 'visible' &&
                isGuideVisible &&
                !isModalOpen &&
                timeSinceUserScroll >= USER_IDLE_THRESHOLD_MS
            ) {
                const container = UIElements.guideContainer;
                const idealTargetLeft = computeNowScrollTarget(leftOffsetInScrollableArea);
                const distanceFromNowTarget = Math.abs(container.scrollLeft - idealTargetLeft);

                if (distanceFromNowTarget >= 30 || (timeSinceAutoScroll >= AUTO_SCROLL_INTERVAL_MS && distanceFromNowTarget >= 10)) {
                    console.log(`[GUIDE] Auto-scrolling timeline to Now (drift: ${Math.round(distanceFromNowTarget)}px).`);
                    scrollToNowLine(leftOffsetInScrollableArea, true);
                }
            }
        }
    } else {
        guideState.lastNowOffsetPx = null;
        nowLineEl.classList.add('hidden');
    }

    document.querySelectorAll('.programme-item').forEach(item => {
        const progStart = new Date(item.dataset.progStart);
        const progStop = new Date(item.dataset.progStop);
        const isLive = now >= progStart && now < progStop;
        item.classList.toggle('live', isLive);
        item.classList.toggle('past', now >= progStop);

        const progressEl = item.querySelector('.programme-progress');
        if (progressEl) {
            progressEl.style.width = isLive ? `${((now - progStart) / (progStop - progStart)) * 100}%` : '0%';
        }
    });

    guideState.nowLineTimer = setTimeout(() => updateNowLine(activeGuideStartUtc, false), 60000);
};

/**
 * Exported helper to update NOW line position without scrolling.
 * Used when column is resized to recalculate the NOW line position.
 */
export const updateNowLinePosition = () => {
    const activeGuideStartUtc = guideState.renderedGuideStartUtc || computeGuideStartUtc();
    updateNowLine(activeGuideStartUtc, false);
};

/**
 * Ensures the TV Guide is properly aligned, up to date, and centered when switching to the Guide tab or waking from background.
 */
export const onGuideTabActivated = () => {
    const now = new Date();
    const todayStr = formatDateForInput(now);
    const currentOffset = getEffectiveTimezoneOffset();
    const expectedHourWidth = window.innerWidth < 768 ? 200 : 300;
    const hourWidthChanged = guideState.hourWidthPixels !== expectedHourWidth;
    if (hourWidthChanged) {
        guideState.hourWidthPixels = expectedHourWidth;
    }

    // Ensure channel column width CSS variable is synced with this device's setting
    const defaultChannelWidth = window.innerWidth < 768 ? 64 : 180;
    const savedChannelWidth = getDeviceSetting('channelColumnWidth', guideState.settings?.channelColumnWidth || defaultChannelWidth);
    const safeWidth = window.innerWidth < 768 ? 64 : Math.min(window.innerWidth - 80, Math.max(50, savedChannelWidth));
    if (UIElements.guideGrid) {
        UIElements.guideGrid.style.setProperty('--channel-col-width', `${safeWidth}px`);
    }
    if (guideState.settings) {
        guideState.settings.channelColumnWidth = safeWidth;
    }

    if (guideState.isViewingToday && guideState.renderedDateStr && guideState.renderedDateStr !== todayStr) {
        guideState.currentDate = now;
        finalizeGuideLoad(true);
        return;
    }

    if (
        hourWidthChanged ||
        !guideState.renderedGuideStartUtc ||
        guideState.renderedTimezoneOffset !== currentOffset ||
        !UIElements.guideGrid?.querySelector('.channel-info')
    ) {
        if (guideState.channels?.length > 0) {
            finalizeGuideLoad(true);
        }
        return;
    }

    const container = UIElements.guideContainer;
    if (container) {
        if (container.scrollTop === 0 && (guideState.savedScrollTop || 0) > 0) {
            container.scrollTop = guideState.savedScrollTop;
        }
        if (!guideState.needsCenterOnActivate && container.scrollLeft === 0 && (guideState.savedScrollLeft || 0) > 0) {
            guideState.lastProgrammaticScrollAt = Date.now();
            container.scrollLeft = guideState.savedScrollLeft;
        }
    }

    if (guideState.needsViewportRefreshOnActivate) {
        guideState.needsViewportRefreshOnActivate = false;
        guideState.updateVisibleRows?.(true);
    }

    const isStuckAtZeroOnToday =
        guideState.isViewingToday &&
        container &&
        container.scrollLeft === 0 &&
        (guideState.lastNowOffsetPx || 0) > guideState.hourWidthPixels * 2 &&
        (Date.now() - (guideState.lastUserHorizontalScrollAt || 0) > 60 * 1000);

    const shouldCenterNow =
        guideState.needsCenterOnActivate ||
        isStuckAtZeroOnToday ||
        (guideState.isViewingToday && (Date.now() - (guideState.lastAutoScrollAt || 0) >= 5 * 60 * 1000) && (Date.now() - (guideState.lastUserHorizontalScrollAt || 0) >= 3 * 60 * 1000));

    updateNowLine(guideState.renderedGuideStartUtc, shouldCenterNow);
};

// --- Filtering and Searching (Multi-Select Pick Lists) ---

/**
 * Escapes HTML special characters for safe attribute and text rendering.
 * @param {string} str
 * @returns {string}
 */
const escapePicklistHtml = (str) => String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

/**
 * Normalizes a saved or active filter value ('all', legacy string, or array of strings)
 * against the set of currently valid option values.
 * Returns either 'all' (default/reset state) or a non-empty array of valid strings.
 * @param {string|string[]|null|undefined} rawVal
 * @param {Set<string>} validOptionsSet
 * @returns {'all'|string[]}
 */
const normalizePicklistValue = (rawVal, validOptionsSet) => {
    if (!rawVal || rawVal === 'all') return 'all';
    const arr = Array.isArray(rawVal) ? rawVal : [String(rawVal)];
    if (arr.length === 0 || arr.includes('all')) return 'all';
    const valid = [...new Set(arr.filter(item => validOptionsSet.has(item)))];
    return valid.length > 0 ? valid : 'all';
};

/**
 * Checks whether a specific view/group key ('favorites', 'recents', or a channel group)
 * is currently active.
 * @param {string} groupKey
 * @returns {boolean}
 */
const isGroupFilterIncluding = (groupKey) => {
    if (groupKey === 'favorites' || groupKey === 'recents') {
        return guideState.settings.activeQuickFilter === groupKey;
    }
    const active = guideState.settings.activeGroupFilter;
    return Array.isArray(active) && active.includes(groupKey);
};

/**
 * Returns the channels matching the currently selected source filter.
 * @returns {Array}
 */
const getChannelsForSelectedSources = () => {
    const selectedSources = guideState.settings.activeSourceFilter;
    if (!Array.isArray(selectedSources) || selectedSources.length === 0) {
        return guideState.channels;
    }
    const sourceSet = new Set(selectedSources);
    return guideState.channels.filter(ch => sourceSet.has(ch.source));
};

/**
 * Updates the Favorites and Recents quick-toggle buttons in the TV Guide header.
 */
const updateQuickFilterButtonsUI = () => {
    const favBtn = document.getElementById('guide-favorites-toggle');
    const favIcon = document.getElementById('guide-favorites-toggle-icon');
    const favCountEl = document.getElementById('guide-favorites-toggle-count');

    const recBtn = document.getElementById('guide-recents-toggle');
    const recIcon = document.getElementById('guide-recents-toggle-icon');
    const recCountEl = document.getElementById('guide-recents-toggle-count');

    const sourceChannels = getChannelsForSelectedSources();
    const recentIdsSet = new Set(guideState.settings.recentChannels || []);
    let favCount = 0;
    let recCount = 0;
    sourceChannels.forEach(ch => {
        if (ch.isFavorite) favCount++;
        if (recentIdsSet.has(ch.id)) recCount++;
    });

    if (favCountEl) favCountEl.textContent = String(favCount);
    if (recCountEl) recCountEl.textContent = String(recCount);

    const activeQuick = guideState.settings.activeQuickFilter || 'none';
    const isFavActive = activeQuick === 'favorites';
    const isRecActive = activeQuick === 'recents';

    if (favBtn) {
        favBtn.setAttribute('aria-pressed', isFavActive ? 'true' : 'false');
        favBtn.className = isFavActive
            ? 'flex items-center gap-1.5 px-2.5 py-1.5 sm:py-2 rounded-md border border-amber-400 bg-amber-500/20 hover:bg-amber-500/30 text-amber-200 ring-1 ring-amber-400/50 shadow-sm text-xs sm:text-sm font-semibold transition-all select-none'
            : 'flex items-center gap-1.5 px-2.5 py-1.5 sm:py-2 rounded-md border border-gray-600 bg-gray-700 hover:bg-gray-600 text-gray-300 text-xs sm:text-sm font-semibold transition-all select-none';
    }
    if (favIcon) {
        favIcon.setAttribute('fill', isFavActive ? 'currentColor' : 'none');
        favIcon.className.baseVal = isFavActive
            ? 'w-4 h-4 text-amber-400 transition-colors flex-shrink-0'
            : 'w-4 h-4 text-gray-400 transition-colors flex-shrink-0';
    }
    if (favCountEl) {
        favCountEl.className = isFavActive
            ? 'inline-block text-[11px] px-1.5 py-0.5 rounded-full bg-amber-500/30 text-amber-100 font-mono leading-none'
            : 'inline-block text-[11px] px-1.5 py-0.5 rounded-full bg-gray-800/80 text-gray-400 font-mono leading-none';
    }

    if (recBtn) {
        recBtn.setAttribute('aria-pressed', isRecActive ? 'true' : 'false');
        recBtn.className = isRecActive
            ? 'flex items-center gap-1.5 px-2.5 py-1.5 sm:py-2 rounded-md border border-blue-400 bg-blue-600 hover:bg-blue-500 text-white ring-1 ring-blue-400/50 shadow-sm text-xs sm:text-sm font-semibold transition-all select-none'
            : 'flex items-center gap-1.5 px-2.5 py-1.5 sm:py-2 rounded-md border border-gray-600 bg-gray-700 hover:bg-gray-600 text-gray-300 text-xs sm:text-sm font-semibold transition-all select-none';
    }
    if (recIcon) {
        recIcon.className.baseVal = isRecActive
            ? 'w-4 h-4 text-white transition-colors flex-shrink-0'
            : 'w-4 h-4 text-gray-400 transition-colors flex-shrink-0';
    }
    if (recCountEl) {
        recCountEl.className = isRecActive
            ? 'inline-block text-[11px] px-1.5 py-0.5 rounded-full bg-blue-800/80 text-blue-100 font-mono leading-none'
            : 'inline-block text-[11px] px-1.5 py-0.5 rounded-full bg-gray-800/80 text-gray-400 font-mono leading-none';
    }
};

/**
 * Updates the Recents toggle count and refreshes the guide if the Recents view is currently active.
 */
const handleRecentChannelsUpdated = () => {
    updateQuickFilterButtonsUI();
    if (isGroupFilterIncluding('recents')) {
        handleSearchAndFilter(false, true);
    }
};

/**
 * Updates the Source pick list trigger button label, count badge, and active border styling.
 */
const updateSourceFilterButtonUI = () => {
    const btn = document.getElementById('source-filter');
    const labelEl = document.getElementById('source-filter-label');
    const badgeEl = document.getElementById('source-filter-badge');
    const resetBtn = document.getElementById('source-filter-reset');
    if (!btn || !labelEl || !badgeEl) return;

    const selected = guideState.settings.activeSourceFilter;
    const isFiltered = Array.isArray(selected) && selected.length > 0;

    if (!isFiltered) {
        labelEl.textContent = 'All Sources';
        badgeEl.classList.add('hidden');
        btn.classList.remove('border-blue-500', 'bg-gray-700/90');
        btn.classList.add('border-gray-600');
        btn.title = 'All Sources (Default)';
        btn.value = 'all';
        if (resetBtn) resetBtn.classList.add('opacity-50');
    } else if (selected.length === 1) {
        labelEl.textContent = selected[0];
        badgeEl.classList.add('hidden');
        btn.classList.remove('border-gray-600');
        btn.classList.add('border-blue-500');
        btn.title = `Source: ${selected[0]}`;
        btn.value = selected[0];
        if (resetBtn) resetBtn.classList.remove('opacity-50');
    } else {
        labelEl.textContent = 'Sources';
        badgeEl.textContent = String(selected.length);
        badgeEl.classList.remove('hidden');
        btn.classList.remove('border-gray-600');
        btn.classList.add('border-blue-500');
        btn.title = `Sources (${selected.length}): ${selected.join(', ')}`;
        btn.value = 'multiple';
        if (resetBtn) resetBtn.classList.remove('opacity-50');
    }
};

/**
 * Updates the Group pick list trigger button label, count badge, and active border styling.
 * Clearly indicates when the group selection is temporarily paused by Favorites or Recents.
 */
const updateGroupFilterButtonUI = () => {
    const btn = document.getElementById('group-filter');
    const labelEl = document.getElementById('group-filter-label');
    const badgeEl = document.getElementById('group-filter-badge');
    const resetBtn = document.getElementById('group-filter-pick-reset');
    if (!btn || !labelEl || !badgeEl) return;

    const selected = guideState.settings.activeGroupFilter;
    const isFiltered = Array.isArray(selected) && selected.length > 0;
    const activeQuick = guideState.settings.activeQuickFilter || 'none';
    const isQuickActive = activeQuick === 'favorites' || activeQuick === 'recents';
    const quickLabel = activeQuick === 'favorites' ? '★ Favs' : '🕒 Recents';

    if (isQuickActive) {
        btn.classList.remove('border-blue-500', 'border-gray-600');
        btn.classList.add('border-dashed', 'border-gray-500', 'opacity-70');
        badgeEl.className = 'bg-gray-600 text-gray-300 text-[11px] font-bold px-1.5 py-0.5 rounded-full leading-none';

        if (!isFiltered) {
            labelEl.textContent = `All Groups (${quickLabel} active)`;
            badgeEl.classList.add('hidden');
            btn.title = `Viewing ${quickLabel} — tap ${quickLabel} again to return to All Groups`;
        } else if (selected.length === 1) {
            labelEl.textContent = `${selected[0]} (Paused • ${quickLabel})`;
            badgeEl.classList.add('hidden');
            btn.title = `Viewing ${quickLabel} — saved group "${selected[0]}" will resume when ${quickLabel} is untoggled`;
        } else {
            labelEl.textContent = `Groups (Paused • ${quickLabel})`;
            badgeEl.textContent = String(selected.length);
            badgeEl.classList.remove('hidden');
            btn.title = `Viewing ${quickLabel} — saved groups (${selected.length}) will resume when ${quickLabel} is untoggled`;
        }
        btn.value = activeQuick;
        if (resetBtn) resetBtn.classList.toggle('opacity-50', !isFiltered);
        return;
    }

    btn.classList.remove('border-dashed', 'border-gray-500', 'opacity-70');
    badgeEl.className = 'bg-blue-600 text-white text-[11px] font-bold px-1.5 py-0.5 rounded-full leading-none';

    if (!isFiltered) {
        labelEl.textContent = 'All Groups';
        badgeEl.classList.add('hidden');
        btn.classList.remove('border-blue-500');
        btn.classList.add('border-gray-600');
        btn.title = 'All Groups (Default)';
        btn.value = 'all';
        if (resetBtn) resetBtn.classList.add('opacity-50');
    } else if (selected.length === 1) {
        labelEl.textContent = selected[0];
        badgeEl.classList.add('hidden');
        btn.classList.remove('border-gray-600');
        btn.classList.add('border-blue-500');
        btn.title = `Group: ${selected[0]}`;
        btn.value = selected[0];
        if (resetBtn) resetBtn.classList.remove('opacity-50');
    } else {
        labelEl.textContent = 'Groups';
        badgeEl.textContent = String(selected.length);
        badgeEl.classList.remove('hidden');
        btn.classList.remove('border-gray-600');
        btn.classList.add('border-blue-500');
        btn.title = `Groups (${selected.length}): ${selected.join(', ')}`;
        btn.value = 'multiple';
        if (resetBtn) resetBtn.classList.remove('opacity-50');
    }
};

/**
 * Renders the scrollable checkbox list inside #source-filter-list.
 */
const renderSourceFilterList = () => {
    const listEl = document.getElementById('source-filter-list');
    if (!listEl) return;

    const searchInput = document.getElementById('source-filter-search');
    const query = (searchInput?.value || '').trim().toLowerCase();
    const selectedSet = new Set(
        Array.isArray(guideState.settings.activeSourceFilter) ? guideState.settings.activeSourceFilter : []
    );

    const sourceCounts = new Map();
    guideState.channels.forEach(ch => {
        if (ch.source) {
            sourceCounts.set(ch.source, (sourceCounts.get(ch.source) || 0) + 1);
        }
    });

    const sortedSources = [...guideState.channelSources].sort((a, b) => a.localeCompare(b));
    const filteredSources = query
        ? sortedSources.filter(src => src.toLowerCase().includes(query))
        : sortedSources;

    if (filteredSources.length === 0) {
        listEl.innerHTML = '<div class="text-center text-gray-500 py-4 text-xs">No matching sources found</div>';
        return;
    }

    listEl.innerHTML = filteredSources.map(source => {
        const isChecked = selectedSet.has(source);
        const count = sourceCounts.get(source) || 0;
        const escaped = escapePicklistHtml(source);
        return `
            <div role="option" aria-selected="${isChecked}" data-value="${escaped}"
                class="picklist-option-item flex items-center justify-between gap-2 px-2.5 py-2 rounded-lg cursor-pointer select-none transition-colors ${isChecked ? 'bg-blue-600/20 text-white font-medium' : 'text-gray-200 hover:bg-gray-700/70'}">
                <div class="flex items-center gap-2.5 min-w-0">
                    <input type="checkbox" tabindex="-1" ${isChecked ? 'checked' : ''}
                        class="h-4 w-4 rounded border-gray-500 bg-gray-700 text-blue-600 focus:ring-0 pointer-events-none flex-shrink-0">
                    <span class="text-xs sm:text-sm truncate" title="${escaped}">${escaped}</span>
                </div>
                <span class="text-[11px] text-gray-400 bg-gray-900/70 px-1.5 py-0.5 rounded font-mono flex-shrink-0">${count}</span>
            </div>
        `;
    }).join('');
};

/**
 * Renders the scrollable checkbox list of channel groups inside #group-filter-pick-list.
 */
const renderGroupFilterList = () => {
    const listEl = document.getElementById('group-filter-pick-list');
    if (!listEl) return;

    const searchInput = document.getElementById('group-filter-pick-search');
    const query = (searchInput?.value || '').trim().toLowerCase();
    const selectedSet = new Set(
        Array.isArray(guideState.settings.activeGroupFilter) ? guideState.settings.activeGroupFilter : []
    );

    const sourceChannels = getChannelsForSelectedSources();
    const groupCounts = new Map();

    sourceChannels.forEach(ch => {
        if (ch.group) {
            groupCounts.set(ch.group, (groupCounts.get(ch.group) || 0) + 1);
        }
    });

    const sortedGroups = [...groupCounts.keys()].sort((a, b) => a.localeCompare(b));
    const filteredGroups = query
        ? sortedGroups.filter(grp => grp.toLowerCase().includes(query))
        : sortedGroups;

    if (filteredGroups.length === 0) {
        listEl.innerHTML = '<div class="text-center text-gray-500 py-4 text-xs">No matching groups found</div>';
        return;
    }

    listEl.innerHTML = filteredGroups.map(group => {
        const isChecked = selectedSet.has(group);
        const count = groupCounts.get(group) || 0;
        const escaped = escapePicklistHtml(group);
        return `
            <div role="option" aria-selected="${isChecked}" data-value="${escaped}"
                class="picklist-option-item flex items-center justify-between gap-2 px-2.5 py-2 rounded-lg cursor-pointer select-none transition-colors ${isChecked ? 'bg-blue-600/20 text-white font-medium' : 'text-gray-200 hover:bg-gray-700/70'}">
                <div class="flex items-center gap-2.5 min-w-0">
                    <input type="checkbox" tabindex="-1" ${isChecked ? 'checked' : ''}
                        class="h-4 w-4 rounded border-gray-500 bg-gray-700 text-blue-600 focus:ring-0 pointer-events-none flex-shrink-0">
                    <span class="text-xs sm:text-sm truncate" title="${escaped}">${escaped}</span>
                </div>
                <span class="text-[11px] text-gray-400 bg-gray-900/70 px-1.5 py-0.5 rounded font-mono flex-shrink-0">${count}</span>
            </div>
        `;
    }).join('');
};

/**
 * Closes any open pick list dropdown panels in the TV Guide header.
 */
const closeGuidePicklistPanels = () => {
    const sourcePanel = document.getElementById('source-filter-panel');
    const groupPanel = document.getElementById('group-filter-panel');
    const sourceBtn = document.getElementById('source-filter');
    const groupBtn = document.getElementById('group-filter');
    const sourceChevron = document.getElementById('source-filter-chevron');
    const groupChevron = document.getElementById('group-filter-chevron');

    if (sourcePanel && !sourcePanel.classList.contains('hidden')) {
        sourcePanel.classList.add('hidden');
        if (sourceBtn) sourceBtn.setAttribute('aria-expanded', 'false');
        if (sourceChevron) sourceChevron.classList.remove('rotate-180');
    }
    if (groupPanel && !groupPanel.classList.contains('hidden')) {
        groupPanel.classList.add('hidden');
        if (groupBtn) groupBtn.setAttribute('aria-expanded', 'false');
        if (groupChevron) groupChevron.classList.remove('rotate-180');
    }
};

/**
 * Populates the "source" multi-select pick list filter.
 */
const populateSourceFilter = () => {
    const savedFilter = getDeviceSetting('activeSourceFilter', guideState.settings.activeSourceFilter);
    const normalized = normalizePicklistValue(savedFilter, guideState.channelSources);

    guideState.settings.activeSourceFilter = normalized;
    if (JSON.stringify(savedFilter) !== JSON.stringify(normalized)) {
        saveDeviceSetting('activeSourceFilter', normalized);
    }

    renderSourceFilterList();
    updateSourceFilterButtonUI();

    const container = document.getElementById('source-filter-container') || UIElements.sourceFilter;
    if (container) {
        container.classList.remove('hidden');
        container.style.display = guideState.channelSources.size <= 1 ? 'none' : 'block';
    }
};

/**
 * Populates the "group" multi-select pick list filter and quick-toggle buttons based on the currently selected source(s).
 */
const populateGroupFilter = () => {
    const savedFilter = getDeviceSetting('activeGroupFilter', guideState.settings.activeGroupFilter);
    let savedQuick = getDeviceSetting('activeQuickFilter', guideState.settings.activeQuickFilter || 'none');
    if (savedQuick !== 'favorites' && savedQuick !== 'recents') {
        savedQuick = 'none';
    }

    const currentRaw = guideState.settings.activeGroupFilter !== undefined && guideState.settings.activeGroupFilter !== 'all'
        ? guideState.settings.activeGroupFilter
        : savedFilter;

    // Migrate legacy 'favorites' / 'recents' values from activeGroupFilter to activeQuickFilter
    if (currentRaw === 'favorites' || currentRaw === 'recents') {
        savedQuick = currentRaw;
        saveDeviceSetting('activeQuickFilter', savedQuick);
    } else if (Array.isArray(currentRaw) && currentRaw.length === 1 && (currentRaw[0] === 'favorites' || currentRaw[0] === 'recents')) {
        savedQuick = currentRaw[0];
        saveDeviceSetting('activeQuickFilter', savedQuick);
    }
    guideState.settings.activeQuickFilter = savedQuick;

    const sourceChannels = getChannelsForSelectedSources();
    const availableGroups = new Set();
    sourceChannels.forEach(ch => {
        if (ch.group) availableGroups.add(ch.group);
    });

    const normalized = normalizePicklistValue(currentRaw, availableGroups);

    if (JSON.stringify(guideState.settings.activeGroupFilter) !== JSON.stringify(normalized)) {
        guideState.settings.activeGroupFilter = normalized;
        saveDeviceSetting('activeGroupFilter', normalized);
    }

    renderGroupFilterList();
    updateQuickFilterButtonsUI();
    updateGroupFilterButtonUI();

    const container = document.getElementById('group-filter-container') || UIElements.groupFilter;
    if (container) {
        container.classList.remove('hidden');
    }
};

/**
 * Filters channels based on source/group pick lists, quick toggles, and search input, then rerenders the guide.
 * @param {boolean} shouldCenter - Indicates if the guide should auto-center to current time.
 * @param {boolean} preserveScroll - Indicates if scroll position should be preserved.
 * @returns {Promise<boolean>} A promise that resolves when the re-render is complete.
 */
export function handleSearchAndFilter(shouldCenter = false, preserveScroll = false) {
    const searchTerm = UIElements.searchInput.value.trim().toLowerCase();
    const selectedGroups = guideState.settings.activeGroupFilter;
    const selectedSources = guideState.settings.activeSourceFilter;
    const activeQuick = guideState.settings.activeQuickFilter || 'none';
    const searchScope = guideState.settings.searchScope || 'channels_only_filtered';

    updateQuickFilterButtonsUI();

    let channelsForGuide;

    // 1. Filter by selected Source(s) first
    let baseFilteredChannels = guideState.channels;
    if (Array.isArray(selectedSources) && selectedSources.length > 0) {
        const sourceSet = new Set(selectedSources);
        baseFilteredChannels = baseFilteredChannels.filter(ch => sourceSet.has(ch.source));
    }

    // 2. Apply Quick Toggle (Favorites or Recents) if active; otherwise apply selected Channel Group(s)
    if (activeQuick === 'favorites') {
        baseFilteredChannels = baseFilteredChannels.filter(ch => ch.isFavorite);
    } else if (activeQuick === 'recents') {
        const recentIds = guideState.settings.recentChannels || [];
        const channelMap = new Map(baseFilteredChannels.map(ch => [ch.id, ch]));
        baseFilteredChannels = recentIds.map(id => channelMap.get(id)).filter(Boolean);
    } else if (Array.isArray(selectedGroups) && selectedGroups.length > 0) {
        const groupSet = new Set(selectedGroups);
        baseFilteredChannels = baseFilteredChannels.filter(ch => ch.group && groupSet.has(ch.group));
    }

    // 2. Now, handle the search logic.
    if (searchTerm) {
        let channelSearchPool;
        // Determine if we search ALL channels or just the base filtered list.
        if (searchScope.endsWith('_unfiltered')) {
            channelSearchPool = guideState.channels; // Use all channels for the search
        } else {
            channelSearchPool = baseFilteredChannels; // Use the already filtered list for the search
        }

        // Perform the channel search on the determined pool.
        const fuseForChannels = new Fuse(channelSearchPool, { keys: ['name', 'displayName', 'source', 'chno'], threshold: 0.4, includeScore: true });
        const channelResults = fuseForChannels.search(searchTerm);

        // Perform the program search if the scope allows it.
        let programResults = [];
        if (searchScope.includes('programs') && appState.fusePrograms) {
            programResults = appState.fusePrograms.search(searchTerm); //programResults = appState.fusePrograms.search(searchTerm); // appState.fusePrograms.search(searchTerm).slice(0, 20);
        }

        // BUG FIX: Include channels from both channel search AND program search
        // This ensures that searching for program titles (e.g., "Shark Tank") 
        // will display all channels that have matching programs, not just channels
        // whose names match the search term.
        const channelIdsFromChannelSearch = new Set(channelResults.map(r => r.item.id));
        const channelIdsFromProgramSearch = new Set(programResults.map(r => r.item.channel.id));
        const allRelevantChannelIds = new Set([...channelIdsFromChannelSearch, ...channelIdsFromProgramSearch]);

        channelsForGuide = channelSearchPool.filter(ch => allRelevantChannelIds.has(ch.id));

        // Render the search results dropdown.
        renderSearchResults(channelResults, programResults); //renderSearchResults(channelResults.slice(0, 10), programResults);

    } else {
        // If there is no search term, the guide simply displays the base filtered channels.
        channelsForGuide = baseFilteredChannels;
        // And we hide the search results dropdown.
        UIElements.searchResultsContainer.innerHTML = '';
        UIElements.searchResultsContainer.classList.add('hidden');
    }

    // 3. Finally, render the guide with the correct list of channels.
    // When shouldCenter is true, we DON'T want to reset scroll (let it stay where it is)
    // Then we'll center it to the now line
    // MODIFIED: Logic for resetScroll.
    // If preserveScroll is true, we NEVER reset.
    // If shouldCenter is true, we also don't reset (because we want to scroll to a specific place, not 0,0).
    // So we only reset if BOTH are false.
    const resetScroll = !shouldCenter && !preserveScroll;
    return renderGuide(channelsForGuide, resetScroll, shouldCenter);
};
/**
 * Renders the search results dropdown.
 * @param {Array} channelResults - Results from Fuse.js channel search.
 * @param {Array} programResults - Results from Fuse.js program search.
 */
const renderSearchResults = (channelResults, programResults) => {
    let html = '';

    if (channelResults.length > 0) {
        html += '<div class="search-results-header">Channels</div>';
        html += channelResults.map(({ item }) => `
            <div class="search-result-channel flex items-center p-3 border-b border-gray-700/50 hover:bg-gray-700 cursor-pointer" data-channel-id="${item.id}">
                <img src="${proxiedImageUrl(item.logo) || 'https://placehold.co/40x40/1f2937/d1d5db?text=?'}" onerror="this.onerror=null; this.src='https://placehold.co/40x40/1f2937/d1d5db?text=?';" class="w-10 h-10 object-contain mr-3 rounded-md bg-gray-700 flex-shrink-0">
                <div class="overflow-hidden">
                    <p class="font-semibold text-white text-sm truncate">${item.chno ? `[${item.chno}] ` : ''}${item.displayName || item.name}</p>
                    <p class="text-gray-400 text-xs truncate">${item.group} &bull; ${item.source}</p>
                </div>
            </div>
        `).join('');
    }

    if (programResults.length > 0) {
        html += '<div class="search-results-header">Programs</div>';
        const timeFormat = { hour: '2-digit', minute: '2-digit' };
        html += programResults.map(({ item }) => `
             <div class="search-result-program flex items-center p-3 border-b border-gray-700/50 hover:bg-gray-700 cursor-pointer" data-channel-id="${item.channel.id}" data-prog-start="${item.start}">
                <img src="${proxiedImageUrl(item.channel.logo) || 'https://placehold.co/40x40/1f2937/d1d5db?text=?'}" onerror="this.onerror=null; this.src='https://placehold.co/40x40/1f2937/d1d5db?text=?';" class="w-10 h-10 object-contain mr-3 rounded-md bg-gray-700 flex-shrink-0">
                <div class="overflow-hidden">
                    <p class="font-semibold text-white text-sm truncate" title="${item.title}">${item.title}</p>
                    <p class="text-gray-400 text-xs truncate">${item.channel.name} &bull; ${item.channel.source}</p>
                    <p class="text-blue-400 text-xs">${new Date(item.start).toLocaleTimeString([], timeFormat)} - ${new Date(item.stop).toLocaleTimeString([], timeFormat)}</p>
                </div>
            </div>
        `).join('');
    }

    if (html) {
        UIElements.searchResultsContainer.innerHTML = html;
        UIElements.searchResultsContainer.classList.remove('hidden');
    } else {
        UIElements.searchResultsContainer.innerHTML = '<p class="text-center text-gray-500 p-4 text-sm">No results found.</p>';
        UIElements.searchResultsContainer.classList.remove('hidden');
    }
};

/**
 * A utility function to limit the execution of a function to once every specified time limit.
 * @param {Function} func The function to throttle.
 * @param {number} limit The time limit in milliseconds.
 * @returns {Function} The throttled function.
 */
const throttle = (func, limit) => {
    let inThrottle;
    return function () {
        const args = arguments;
        const context = this;
        if (!inThrottle) {
            func.apply(context, args);
            inThrottle = true;
            setTimeout(() => inThrottle = false, limit);
        }
    };
};

/**
 * Scrolls the guide vertically to bring a specific channel into view and confirms its visibility.
 * @param {string} channelId - The full or partial (stable) ID of the channel to scroll to.
 * @returns {Promise<boolean>} - Resolves to true once the channel element is rendered in the DOM, false otherwise.
 */
export const scrollToChannel = (channelId) => {
    return new Promise((resolve) => {
        const channelIndex = guideState.visibleChannels.findIndex(ch =>
            ch.id === channelId || ch.id.endsWith(channelId)
        );

        if (channelIndex === -1) {
            console.warn(`[GUIDE_SCROLL_FAIL] Channel with ID/suffix "${channelId}" not found in visibleChannels list.`);
            resolve(false);
            return;
        }

        const foundChannel = guideState.visibleChannels[channelIndex];
        const targetScrollTop = channelIndex * ROW_HEIGHT;
        UIElements.guideContainer.scrollTo({ top: targetScrollTop, behavior: 'smooth' });

        // MODIFICATION: Use requestAnimationFrame for a more robust check.
        let startTime = null;
        const checkRender = (timestamp) => {
            if (!startTime) startTime = timestamp;
            const elapsedTime = timestamp - startTime;

            const channelElement = UIElements.guideGrid.querySelector(`.channel-info[data-id="${foundChannel.id}"]`);
            if (channelElement) {
                console.log(`[GUIDE_SCROLL_SUCCESS] Channel element "${foundChannel.id}" found and rendered.`);
                resolve(true);
            } else if (elapsedTime < 5000) { // 5-second timeout
                requestAnimationFrame(checkRender);
            } else {
                console.warn(`[GUIDE_SCROLL_FAIL] Timeout waiting for channel element "${foundChannel.id}" to be rendered.`);
                resolve(false);
            }
        };
        requestAnimationFrame(checkRender);
    });
};

// --- Event Listeners ---

/**
 * Sets up all event listeners for the guide page.
 */
export function setupGuideEventListeners() {
    const sourceContainer = document.getElementById('source-filter-container');
    const sourceBtn = document.getElementById('source-filter');
    const sourcePanel = document.getElementById('source-filter-panel');
    const sourceChevron = document.getElementById('source-filter-chevron');
    const sourceSearch = document.getElementById('source-filter-search');
    const sourceSelectAllBtn = document.getElementById('source-filter-select-all');
    const sourceResetBtn = document.getElementById('source-filter-reset');
    const sourceList = document.getElementById('source-filter-list');

    const groupContainer = document.getElementById('group-filter-container');
    const groupBtn = document.getElementById('group-filter');
    const groupPanel = document.getElementById('group-filter-panel');
    const groupChevron = document.getElementById('group-filter-chevron');
    const groupSearch = document.getElementById('group-filter-pick-search');
    const groupSelectAllBtn = document.getElementById('group-filter-pick-select-all');
    const groupResetBtn = document.getElementById('group-filter-pick-reset');
    const groupList = document.getElementById('group-filter-pick-list');

    const favToggleBtn = document.getElementById('guide-favorites-toggle');
    const recToggleBtn = document.getElementById('guide-recents-toggle');

    const toggleQuickFilter = (mode) => {
        closeGuidePicklistPanels();
        const current = guideState.settings.activeQuickFilter || 'none';
        const next = current === mode ? 'none' : mode;
        guideState.settings.activeQuickFilter = next;
        saveDeviceSetting('activeQuickFilter', next);
        updateQuickFilterButtonsUI();
        updateGroupFilterButtonUI();
        handleSearchAndFilter(true);
    };

    if (favToggleBtn) {
        favToggleBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            toggleQuickFilter('favorites');
        });
    }

    if (recToggleBtn) {
        recToggleBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            toggleQuickFilter('recents');
        });
    }

    window.addEventListener('viniplay:recents-updated', handleRecentChannelsUpdated);

    const applySourceFilterSelection = (newSelection) => {
        const normalized = normalizePicklistValue(newSelection, guideState.channelSources);
        guideState.settings.activeSourceFilter = normalized;
        saveDeviceSetting('activeSourceFilter', normalized);
        renderSourceFilterList();
        updateSourceFilterButtonUI();
        populateGroupFilter();
        handleSearchAndFilter(true);
    };

    const applyGroupFilterSelection = (newSelection) => {
        const sourceChannels = getChannelsForSelectedSources();
        const validGroups = new Set();
        sourceChannels.forEach(ch => {
            if (ch.group) validGroups.add(ch.group);
        });
        const normalized = normalizePicklistValue(newSelection, validGroups);
        guideState.settings.activeGroupFilter = normalized;
        saveDeviceSetting('activeGroupFilter', normalized);

        // Selecting/modifying channel groups automatically turns off Favorites/Recents override
        if (guideState.settings.activeQuickFilter && guideState.settings.activeQuickFilter !== 'none') {
            guideState.settings.activeQuickFilter = 'none';
            saveDeviceSetting('activeQuickFilter', 'none');
            updateQuickFilterButtonsUI();
        }

        renderGroupFilterList();
        updateGroupFilterButtonUI();
        handleSearchAndFilter(true);
    };

    // Toggle Source pick list panel
    if (sourceBtn && sourcePanel) {
        sourceBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            const isHidden = sourcePanel.classList.contains('hidden');
            closeGuidePicklistPanels();
            UIElements.searchResultsContainer?.classList.add('hidden');
            if (isHidden) {
                renderSourceFilterList();
                sourcePanel.classList.remove('hidden');
                sourceBtn.setAttribute('aria-expanded', 'true');
                sourceChevron?.classList.add('rotate-180');
            }
        });
    }

    // Toggle Group pick list panel
    if (groupBtn && groupPanel) {
        groupBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            const isHidden = groupPanel.classList.contains('hidden');
            closeGuidePicklistPanels();
            UIElements.searchResultsContainer?.classList.add('hidden');
            if (isHidden) {
                renderGroupFilterList();
                groupPanel.classList.remove('hidden');
                groupBtn.setAttribute('aria-expanded', 'true');
                groupChevron?.classList.add('rotate-180');
            }
        });
    }

    // Source search input
    if (sourceSearch) {
        sourceSearch.addEventListener('input', () => {
            renderSourceFilterList();
        });
    }

    // Source Select All button
    if (sourceSelectAllBtn) {
        sourceSelectAllBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            const query = (sourceSearch?.value || '').trim().toLowerCase();
            const allSources = [...guideState.channelSources].sort((a, b) => a.localeCompare(b));
            if (query) {
                const matching = allSources.filter(s => s.toLowerCase().includes(query));
                const current = Array.isArray(guideState.settings.activeSourceFilter)
                    ? guideState.settings.activeSourceFilter
                    : [];
                applySourceFilterSelection([...new Set([...current, ...matching])]);
            } else {
                applySourceFilterSelection(allSources);
            }
        });
    }

    // Source Reset button
    if (sourceResetBtn) {
        sourceResetBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            if (sourceSearch && sourceSearch.value) {
                sourceSearch.value = '';
            }
            applySourceFilterSelection('all');
        });
    }

    // Source option item toggle
    if (sourceList) {
        sourceList.addEventListener('click', (e) => {
            e.stopPropagation();
            const item = e.target.closest('.picklist-option-item');
            if (!item) return;
            const value = item.dataset.value;
            if (!value) return;

            const current = Array.isArray(guideState.settings.activeSourceFilter)
                ? [...guideState.settings.activeSourceFilter]
                : [];
            const idx = current.indexOf(value);
            if (idx > -1) {
                current.splice(idx, 1);
            } else {
                current.push(value);
            }
            applySourceFilterSelection(current.length > 0 ? current : 'all');
        });
    }

    // Group search input
    if (groupSearch) {
        groupSearch.addEventListener('input', () => {
            renderGroupFilterList();
        });
    }

    // Group Select All button
    if (groupSelectAllBtn) {
        groupSelectAllBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            const query = (groupSearch?.value || '').trim().toLowerCase();
            const sourceChannels = getChannelsForSelectedSources();
            const availableChannelGroups = new Set();
            sourceChannels.forEach(ch => {
                if (ch.group) availableChannelGroups.add(ch.group);
            });
            const allChannelGroups = [...availableChannelGroups].sort((a, b) => a.localeCompare(b));

            if (query) {
                const matching = allChannelGroups.filter(g => g.toLowerCase().includes(query));
                const current = Array.isArray(guideState.settings.activeGroupFilter)
                    ? guideState.settings.activeGroupFilter
                    : [];
                applyGroupFilterSelection([...new Set([...current, ...matching])]);
            } else {
                applyGroupFilterSelection(allChannelGroups);
            }
        });
    }

    // Group Reset button
    if (groupResetBtn) {
        groupResetBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            if (groupSearch && groupSearch.value) {
                groupSearch.value = '';
            }
            applyGroupFilterSelection('all');
        });
    }

    // Group option item toggle
    if (groupList) {
        groupList.addEventListener('click', (e) => {
            e.stopPropagation();
            const item = e.target.closest('.picklist-option-item');
            if (!item) return;
            const value = item.dataset.value;
            if (!value) return;

            const current = Array.isArray(guideState.settings.activeGroupFilter)
                ? [...guideState.settings.activeGroupFilter]
                : [];
            const idx = current.indexOf(value);
            if (idx > -1) {
                current.splice(idx, 1);
            } else {
                current.push(value);
            }
            applyGroupFilterSelection(current.length > 0 ? current : 'all');
        });
    }

    UIElements.searchInput.addEventListener('keydown', (event) => {
        if (event.key === 'Enter') {
            handleSearchAndFilter(false, true);
        }
    });
    document.addEventListener('click', e => {
        if (!UIElements.searchInput.contains(e.target) && !UIElements.searchResultsContainer.contains(e.target) && !e.target.closest('.search-result-channel') && !e.target.closest('.search-result-program')) {
            UIElements.searchResultsContainer.classList.add('hidden');
        }
        if (sourceContainer && !sourceContainer.contains(e.target) && groupContainer && !groupContainer.contains(e.target)) {
            closeGuidePicklistPanels();
        }
    });
    document.addEventListener('keydown', e => {
        if (e.key === 'Escape') {
            closeGuidePicklistPanels();
        }
    });

    UIElements.guideDatePicker.addEventListener('change', (e) => {
        const selectedDate = e.target.value;
        if (selectedDate) {
            const parts = selectedDate.split('-').map(Number);
            if (parts.length === 3 && !parts.some(Number.isNaN)) {
                guideState.currentDate = new Date(parts[0], parts[1] - 1, parts[2]);
            } else if (e.target.valueAsDate) {
                const date = new Date(e.target.valueAsDate);
                const userTimezoneOffset = date.getTimezoneOffset() * 60000;
                guideState.currentDate = new Date(date.getTime() + userTimezoneOffset);
            }
            guideState.isViewingToday = formatDateForInput(guideState.currentDate) === formatDateForInput(new Date());
            finalizeGuideLoad(guideState.isViewingToday);
        }
    });

    const datePickerLabel = document.querySelector('label[for="guide-date-picker"]');
    if (datePickerLabel) {
        datePickerLabel.addEventListener('click', (e) => {
            if (UIElements.guideDatePicker && typeof UIElements.guideDatePicker.showPicker === 'function') {
                try {
                    UIElements.guideDatePicker.showPicker();
                } catch (error) {
                    console.error("Could not programmatically open date picker:", error);
                }
            }
        });
    }

    UIElements.guideGrid.addEventListener('click', (e) => {
        const favoriteStar = e.target.closest('.favorite-star');
        const channelInfo = e.target.closest('.channel-info');
        const progItem = e.target.closest('.programme-item');

        if (favoriteStar) {
            e.stopPropagation();
            const channelId = favoriteStar.dataset.channelId;
            const channel = guideState.channels.find(c => c.id === channelId);
            if (!channel) return;

            channel.isFavorite = !channel.isFavorite;
            favoriteStar.classList.toggle('favorited', channel.isFavorite);

            guideState.settings.favorites = guideState.channels.filter(c => c.isFavorite).map(c => c.id);
            saveUserSetting('favorites', guideState.settings.favorites);

            updateQuickFilterButtonsUI();
            if (isGroupFilterIncluding('favorites')) {
                handleSearchAndFilter(false, true);
            }
            return;
        }

        if (channelInfo) {
            playChannel(channelInfo.dataset.url, channelInfo.dataset.name, channelInfo.dataset.id);
            handleRecentChannelsUpdated();
        }

        if (progItem) {
            openProgramDetails(progItem);
        }
    });

    UIElements.searchResultsContainer.addEventListener('click', e => {
        const programItem = e.target.closest('.search-result-program');
        const channelItem = e.target.closest('.search-result-channel');

        UIElements.searchResultsContainer.classList.add('hidden');
        UIElements.searchInput.value = '';

        if (channelItem) {
            const channelId = channelItem.dataset.channelId;
            const channelIndex = guideState.visibleChannels.findIndex(c => c.id === channelId);
            if (channelIndex > -1) {
                UIElements.guideContainer.scrollTo({ top: channelIndex * ROW_HEIGHT, behavior: 'smooth' });

                setTimeout(() => {
                    const channelRow = UIElements.guideGrid.querySelector(`.channel-info[data-id="${channelId}"]`);
                    if (channelRow) {
                        channelRow.style.transition = 'background-color 0.5s';
                        channelRow.style.backgroundColor = '#3b82f6';
                        setTimeout(() => { channelRow.style.backgroundColor = ''; }, 2000);
                    }
                }, 500);
            }
        } else if (programItem) {
            const progStart = new Date(programItem.dataset.progStart);
            const guideStart = new Date(guideState.currentDate);
            guideStart.setHours(0, 0, 0, 0);

            const dateDiff = Math.floor((progStart - guideStart) / (1000 * 60 * 60 * 24));
            if (dateDiff !== 0) {
                guideState.currentDate.setDate(guideState.currentDate.getDate() + dateDiff);
                finalizeGuideLoad();
            }

            setTimeout(() => {
                const programElement = UIElements.guideGrid.querySelector(`.programme-item[data-prog-start="${programItem.dataset.progStart}"][data-channel-id="${programItem.dataset.channelId}"]`);
                if (programElement) {
                    const scrollLeft = programElement.offsetLeft - (UIElements.guideContainer.clientWidth / 4);
                    UIElements.guideContainer.scrollTo({ left: scrollLeft, behavior: 'smooth' });

                    programElement.style.transition = 'outline 0.5s';
                    programElement.style.outline = '3px solid #facc15';
                    setTimeout(() => { programElement.style.outline = 'none'; }, 2500);
                }
            }, 200);
        }
    });

    let lastScrollTop = 0;
    let headerHeight = 0; // Will store the combined height of main-header and unified-guide-header

    const handleScrollHeader = throttle(() => {
        if (!UIElements.guideContainer || !UIElements.appContainer || !UIElements.mainHeader || !UIElements.unifiedGuideHeader) {
            return;
        }

        // Calculate header height once, or re-calculate if it changes (e.g., on resize)
        if (headerHeight === 0) {
            headerHeight = UIElements.mainHeader.offsetHeight + UIElements.unifiedGuideHeader.offsetHeight;
        }

        const scrollTop = UIElements.guideContainer.scrollTop;
        const scrollDirection = scrollTop > lastScrollTop ? 'down' : 'up';

        // Define a threshold for collapsing (e.g., headerHeight or a fixed value)
        const collapseThreshold = headerHeight / 2; // Hide after scrolling half the header height

        if (scrollDirection === 'down' && scrollTop > collapseThreshold) {
            UIElements.appContainer.classList.add('header-collapsed');
            closeGuidePicklistPanels();
        } else if (scrollDirection === 'up' && scrollTop < lastScrollTop) { // Reappear on any scroll up
            UIElements.appContainer.classList.remove('header-collapsed');
        }
        lastScrollTop = scrollTop <= 0 ? 0 : scrollTop;

    }, 100);

    if (UIElements.guideContainer) {
        UIElements.guideContainer.addEventListener('scroll', handleScrollHeader);
    }
}
