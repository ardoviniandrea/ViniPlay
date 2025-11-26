/**
 * guide.js
 * * Manages all functionality related to the TV Guide,
 * including data loading, rendering, searching, and user interaction.
 *
 * REFACTORED to use UI Virtualization for high-performance rendering of large channel lists.
 */

import { appState, guideState, UIElements, dvrState } from './state.js';
import { saveUserSetting } from './api.js';
import { parseM3U, formatTimeWithOffset } from './utils.js';
import { playChannel } from './player.js';
import { showNotification, openModal, closeModal } from './ui.js';
import { addOrRemoveNotification, findNotificationForProgram } from './notification.js';
import { addOrRemoveDvrJob, findDvrJobForProgram } from './dvr.js';
import { ICONS } from './icons.js'; // MODIFIED: Import the new icon library

// --- Virtualization Constants ---
const ROW_HEIGHT = 96; // Height in pixels of a single channel row (.channel-info + .timeline-row)
const OVERSCAN_COUNT = 5; // Number of extra rows to render above and below the visible area for smooth scrolling

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
    const channelLogo = channelData.logo;
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

            if (UIElements.groupFilter.value === 'favorites') {
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
            programDetailsNotifyBtn.disabled = !notification && Notification.permission === 'denied';
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
            if (!minDate || startDate < minDate) {
                minDate = startDate;
            }
            if (!maxDate || stopDate > maxDate) {
                maxDate = stopDate;
            }
        }
    }

    return { minDate, maxDate };
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
    populateGroupFilter();
    populateSourceFilter();

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


    const allPrograms = [];
    const guideStart = new Date(guideState.currentDate);
    guideStart.setHours(0, 0, 0, 0);
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

        const guideStart = new Date(guideState.currentDate);
        guideStart.setHours(0, 0, 0, 0);
        const guideStartUtc = new Date(Date.UTC(guideStart.getUTCFullYear(), guideStart.getUTCMonth(), guideStart.getUTCDate()));
        const timelineWidth = guideState.guideDurationHours * guideState.hourWidthPixels;
        UIElements.guideGrid.style.setProperty('--timeline-width', `${timelineWidth}px`);
        UIElements.guideDateDisplay.textContent = guideState.currentDate.toLocaleDateString([], { weekday: 'short', month: 'long', day: 'numeric' });

        // CRITICAL FIX: Ensure static HTML elements exist
        // They may have been removed by a previous render with no data (line 382)
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

            // CRITICAL: Reattach resize event listener to the new handle
            // Update UIElements reference to the new element
            UIElements.channelColumnResizeHandle = document.getElementById('channel-column-resize-handle');

            // Reattach the resize listener (only on desktop)
            if (UIElements.channelColumnResizeHandle && window.innerWidth >= 768) {
                import('./ui.js').then(({ makeColumnResizable }) => {
                    makeColumnResizable(UIElements.channelColumnResizeHandle, UIElements.guideGrid, 100, 'channelColumnWidth', '--channel-col-width');
                });
            }
        }

        if (!UIElements.guideGrid.querySelector('.time-bar-cell')) {
            const timeBarCell = document.createElement('div');
            timeBarCell.className = 'time-bar-cell';
            UIElements.guideGrid.appendChild(timeBarCell);
        }

        if (!document.getElementById('now-line')) {
            const nowLine = document.createElement('div');
            nowLine.id = 'now-line';
            nowLine.className = 'absolute top-0 bg-red-500 w-0.5 z-30 pointer-events-none hidden';
            UIElements.guideGrid.appendChild(nowLine);
        }

        const timeBarCellEl = UIElements.guideGrid.querySelector('.time-bar-cell');
        console.log('[RENDER_DEBUG] timeBarCellEl found:', !!timeBarCellEl);
        if (timeBarCellEl) {
            timeBarCellEl.innerHTML = '';
            const offset = guideState.settings.timezoneOffset || 0;
            for (let i = 0; i < guideState.guideDurationHours; i++) {
                const time = new Date(guideStartUtc.getTime() + i * 3600 * 1000);
                timeBarCellEl.innerHTML += `<div class="absolute top-0 bottom-0 flex items-center justify-start px-2 text-xs text-gray-400 border-r border-gray-700/50" style="left: ${i * guideState.hourWidthPixels}px; width:${guideState.hourWidthPixels}px;">${formatTimeWithOffset(time, offset)}</div>`;
            }
            timeBarCellEl.style.width = `${timelineWidth}px`;
            console.log('[RENDER_DEBUG] timeBarCellEl populated, width:', timelineWidth);
        } else {
            console.log('[RENDER_DEBUG] timeBarCellEl NOT FOUND!');
        }

        const guideContainer = UIElements.guideContainer;
        const guideGrid = UIElements.guideGrid;

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

        const updateVisibleRows = () => {
            if (!guideContainer) return;
            const scrollTop = guideContainer.scrollTop;
            const startIndex = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - OVERSCAN_COUNT);
            const endIndex = Math.min(totalRows, Math.ceil((scrollTop + guideContainer.clientHeight) / ROW_HEIGHT) + OVERSCAN_COUNT);

            let rowsHTML = '';
            const sourceColors = ['bg-blue-600', 'bg-green-600', 'bg-pink-600', 'bg-yellow-500', 'bg-indigo-600', 'bg-red-600'];
            const sourceColorMap = new Map();
            let colorIndex = 0;

            for (let i = startIndex; i < endIndex; i++) {
                const channel = channelsToRender[i];
                const channelName = channel.displayName || channel.name;

                if (!sourceColorMap.has(channel.source)) {
                    sourceColorMap.set(channel.source, sourceColors[colorIndex % sourceColors.length]);
                    colorIndex++;
                }
                const sourceBadgeColor = sourceColorMap.get(channel.source);
                const sourceBadgeHTML = guideState.channelSources.size > 1 ? `<span class="source-badge ${sourceBadgeColor} text-white">${channel.source}</span>` : '';
                const chnoBadgeHTML = channel.chno ? `<span class="chno-badge">${channel.chno}</span>` : '';

                // MODIFIED: Replaced hardcoded SVG with icon from the library
                const starIconHTML = ICONS.star.replace(
                    'class="w-5 h-5"',
                    `data-channel-id="${channel.id}" class="w-6 h-6 text-gray-500 hover:text-yellow-400 favorite-star cursor-pointer ${channel.isFavorite ? 'favorited' : ''}"`
                );

                const channelInfoHTML = `
                    <div class="channel-info p-2 flex items-center justify-between cursor-pointer" data-url="${channel.url}" data-name="${channelName}" data-id="${channel.id}" data-channel-index="${i}">
                        <div class="flex items-center overflow-hidden flex-grow min-w-0">
                            <img src="${channel.logo}" onerror="this.onerror=null; this.src='https://placehold.co/48x48/1f2937/d1d5db?text=?';" class="w-12 h-12 object-contain mr-3 flex-shrink-0 rounded-md bg-gray-700">
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
                const now = new Date();
                const guideEnd = new Date(guideStartUtc.getTime() + guideState.guideDurationHours * 3600 * 1000);
                (guideState.programs[channel.id] || []).forEach(prog => {
                    const progStart = new Date(prog.start);
                    const progStop = new Date(prog.stop);
                    if (progStop < guideStartUtc || progStart > guideEnd) return;

                    const durationMs = progStop - progStart;
                    if (durationMs <= 0) return;

                    const left = ((progStart.getTime() - guideStartUtc.getTime()) / 3600000) * guideState.hourWidthPixels;
                    const width = (durationMs / 3600000) * guideState.hourWidthPixels;
                    const isLive = now >= progStart && now < progStop;
                    const progressWidth = isLive ? ((now - progStart) / durationMs) * 100 : 0;

                    const uniqueProgramId = `${channel.id}-${progStart.toISOString()}-${progStop.toISOString()}`;

                    const hasNotification = findNotificationForProgram({ ...prog, programId: uniqueProgramId }, channel.id);
                    const notificationClass = hasNotification ? 'has-notification' : '';

                    const dvrJob = findDvrJobForProgram({ ...prog, channelId: channel.id });
                    const recordingClass = dvrJob ? `has-recording status-${dvrJob.status}` : '';

                    const offset = guideState.settings.timezoneOffset || 0;

                    programsHTML += `<div class="programme-item absolute top-1 bottom-1 bg-gray-800 rounded-md p-2 overflow-hidden flex flex-col justify-center z-5 ${isLive ? 'live' : ''} ${progStop < now ? 'past' : ''} ${notificationClass} ${recordingClass}" style="left:${left}px; width:${Math.max(0, width - 2)}px" data-channel-url="${channel.url}" data-channel-id="${channel.id}" data-channel-name="${channelName}" data-prog-title="${prog.title}" data-prog-desc="${prog.desc}" data-prog-start="${progStart.toISOString()}" data-prog-stop="${progStop.toISOString()}" data-prog-id="${uniqueProgramId}"><div class="programme-progress" style="width:${progressWidth}%"></div><p class="prog-title text-white font-semibold truncate relative z-10">${prog.title}</p><p class="prog-time text-gray-400 truncate relative z-10">${formatTimeWithOffset(progStart, offset)} - ${formatTimeWithOffset(progStop, offset)}</p></div>`;
                });
                const timelineRowHTML = `<div class="timeline-row" style="width: ${timelineWidth}px;">${programsHTML}</div>`;

                rowsHTML += channelInfoHTML + timelineRowHTML;
            }

            rowContainer.innerHTML = rowsHTML;
            rowContainer.style.transform = `translateY(${startIndex * ROW_HEIGHT}px)`;
        };

        if (guideState.scrollHandler) {
            guideContainer.removeEventListener('scroll', guideState.scrollHandler);
        }
        guideState.scrollHandler = throttle(updateVisibleRows, 16);
        guideContainer.addEventListener('scroll', guideState.scrollHandler);

        // MODIFIED: Preserve vertical scroll position if not resetting
        const currentScrollTop = guideContainer.scrollTop;
        console.log('[RENDER_DEBUG] Captured scrollTop at start:', currentScrollTop);

        if (resetScroll) {
            guideContainer.scrollTop = 0;
            guideContainer.scrollLeft = 0;
        } else {
            // Restore vertical scroll after a short delay to allow layout update
            console.log('[SCROLL_DEBUG] Restoring scrollTop:', currentScrollTop);
            requestAnimationFrame(() => {
                console.log('[SCROLL_DEBUG] Setting scrollTop to:', currentScrollTop, 'Current:', guideContainer.scrollTop);
                guideContainer.scrollTop = currentScrollTop;
                console.log('[SCROLL_DEBUG] New scrollTop:', guideContainer.scrollTop);
            });
        }
        updateVisibleRows();
        console.log('[RENDER_DEBUG] About to call updateNowLine with shouldCenter:', shouldCenter);
        updateNowLine(guideStartUtc, shouldCenter);

        const nowBtn = UIElements.guideGrid.querySelector('#now-btn');
        console.log('[RENDER_DEBUG] nowBtn found:', !!nowBtn);
        if (nowBtn) nowBtn.onclick = () => {
            const now = new Date();
            if (guideState.currentDate.toDateString() !== now.toDateString()) {
                guideState.currentDate = now;
                finalizeGuideLoad(true);
            } else {
                const guideStart = new Date(guideState.currentDate);
                guideStart.setHours(0, 0, 0, 0);
                const guideStartUtc = new Date(Date.UTC(guideStart.getUTCFullYear(), guideStart.getUTCMonth(), guideStart.getUTCDate()));
                updateNowLine(guideStartUtc, true);
            }
        };

        setTimeout(() => resolve(true), 100);
    });
};

/**
 * Updates the position of the "now" line and program states (live, past).
 * @param {Date} guideStartUtc - The start time of the current guide view in UTC.
 * @param {boolean} shouldScroll - If true, scrolls the timeline to the now line.
 */
const updateNowLine = (guideStartUtc, shouldScroll = false) => {
    const nowLineEl = document.getElementById('now-line');
    if (!nowLineEl) return;

    const now = new Date();
    const nowValue = now.getTime();
    const guideEnd = new Date(guideStartUtc.getTime() + guideState.guideDurationHours * 3600 * 1000);
    const channelInfoColWidth = guideState.settings.channelColumnWidth;

    if (nowValue >= guideStartUtc.getTime() && nowValue <= guideEnd.getTime()) {
        const leftOffsetInScrollableArea = ((nowValue - guideStartUtc.getTime()) / 3600000) * guideState.hourWidthPixels;
        nowLineEl.style.left = `${channelInfoColWidth + leftOffsetInScrollableArea}px`;
        nowLineEl.classList.remove('hidden');
        if (shouldScroll) {
            setTimeout(() => {
                const isMobile = window.innerWidth < 768;
                let scrollLeft;

                if (isMobile) {
                    scrollLeft = (channelInfoColWidth + leftOffsetInScrollableArea) - (UIElements.guideContainer.clientWidth / 2);
                } else {
                    scrollLeft = leftOffsetInScrollableArea - (UIElements.guideContainer.clientWidth / 4);
                }

                UIElements.guideContainer.scrollTo({
                    left: Math.max(0, scrollLeft),
                    behavior: 'smooth'
                });
            }, 500);
        }
    } else {
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

    setTimeout(() => updateNowLine(guideStartUtc, false), 60000);
};

/**
 * Exported helper to update NOW line position without scrolling.
 * Used when column is resized to recalculate the NOW line position.
 */
export const updateNowLinePosition = () => {
    const guideStart = new Date(guideState.currentDate);
    guideStart.setHours(0, 0, 0, 0);
    const guideStartUtc = new Date(Date.UTC(guideStart.getUTCFullYear(), guideStart.getUTCMonth(), guideStart.getUTCDate()));
    updateNowLine(guideStartUtc, false);
};

// --- Filtering and Searching ---

/**
 * Populates the "group" filter dropdown.
 */
const populateGroupFilter = () => {
    const savedFilter = guideState.settings.activeGroupFilter;
    UIElements.groupFilter.innerHTML = `<option value="all">All Groups</option><option value="recents">Recents</option><option value="favorites">Favorites</option>`;
    [...guideState.channelGroups].sort((a, b) => a.localeCompare(b)).forEach(group => {
        const cleanGroup = group.replace(/"/g, '&quot;');
        UIElements.groupFilter.innerHTML += `<option value="${cleanGroup}">${group}</option>`;
    });

    // Set the value based on saved setting, falling back to 'all'
    if (savedFilter && UIElements.groupFilter.querySelector(`option[value="${savedFilter.replace(/"/g, '&quot;')}"]`)) {
        UIElements.groupFilter.value = savedFilter;
    } else {
        UIElements.groupFilter.value = 'all';
    }

    UIElements.groupFilter.classList.remove('hidden');
};


/**
 * Populates the "source" filter dropdown.
 */
const populateSourceFilter = () => {
    const savedFilter = guideState.settings.activeSourceFilter;
    UIElements.sourceFilter.innerHTML = `<option value="all">All Sources</option>`;
    [...guideState.channelSources].sort((a, b) => a.localeCompare(b)).forEach(source => {
        const cleanSource = source.replace(/"/g, '&quot;');
        UIElements.sourceFilter.innerHTML += `<option value="${cleanSource}">${source}</option>`;
    });

    if (savedFilter && UIElements.sourceFilter.querySelector(`option[value="${savedFilter.replace(/"/g, '&quot;')}"]`)) {
        UIElements.sourceFilter.value = savedFilter;
    } else {
        UIElements.sourceFilter.value = 'all';
    }

    UIElements.sourceFilter.classList.remove('hidden');
    UIElements.sourceFilter.style.display = guideState.channelSources.size <= 1 ? 'none' : 'block';
};

/**
 * Filters channels based on dropdowns and rerenders the guide.
 * @param {boolean} shouldCenter - Indicates if the guide should auto-center to current time.
 * @returns {Promise<boolean>} A promise that resolves when the re-render is complete.
 */
export function handleSearchAndFilter(shouldCenter = false, preserveScroll = false) {
    const searchTerm = UIElements.searchInput.value.trim().toLowerCase();
    const selectedGroup = UIElements.groupFilter.value;
    const selectedSource = UIElements.sourceFilter.value;
    const searchScope = guideState.settings.searchScope || 'channels_only_filtered';

    let channelsForGuide;

    // --- NEW CORRECTED LOGIC ---

    // 1. First, determine the base list of channels based on the group/source filters.
    // This is what the user sees when NOT searching.
    let baseFilteredChannels = guideState.channels;
    if (selectedGroup !== 'all') {
        if (selectedGroup === 'favorites') {
            baseFilteredChannels = baseFilteredChannels.filter(ch => ch.isFavorite);
        } else if (selectedGroup === 'recents') {
            const recentIds = guideState.settings.recentChannels || [];
            baseFilteredChannels = recentIds.map(id => guideState.channels.find(ch => ch.id === id)).filter(Boolean);
        } else {
            baseFilteredChannels = baseFilteredChannels.filter(ch => ch.group === selectedGroup);
        }
    }
    if (selectedSource !== 'all') {
        baseFilteredChannels = baseFilteredChannels.filter(ch => ch.source === selectedSource);
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
                <img src="${item.logo}" onerror="this.onerror=null; this.src='https://placehold.co/40x40/1f2937/d1d5db?text=?';" class="w-10 h-10 object-contain mr-3 rounded-md bg-gray-700 flex-shrink-0">
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
                <img src="${item.channel.logo}" onerror="this.onerror=null; this.src='https://placehold.co/40x40/1f2937/d1d5db?text=?';" class="w-10 h-10 object-contain mr-3 rounded-md bg-gray-700 flex-shrink-0">
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
    UIElements.groupFilter.addEventListener('change', () => {
        const selectedGroup = UIElements.groupFilter.value;
        // Save the setting for the user
        saveUserSetting('activeGroupFilter', selectedGroup);
        // Update local state immediately for responsiveness
        guideState.settings.activeGroupFilter = selectedGroup;
        handleSearchAndFilter(true); // Auto-center when filter changes
    });
    UIElements.sourceFilter.addEventListener('change', () => {
        const selectedSource = UIElements.sourceFilter.value;
        saveUserSetting('activeSourceFilter', selectedSource);
        guideState.settings.activeSourceFilter = selectedSource;
        handleSearchAndFilter(true); // Auto-center when filter changes
    });
    UIElements.searchInput.addEventListener('keydown', (event) => {
        if (event.key === 'Enter') {
            handleSearchAndFilter(false);
        }
    });
    document.addEventListener('click', e => {
        if (!UIElements.searchInput.contains(e.target) && !UIElements.searchResultsContainer.contains(e.target) && !e.target.closest('.search-result-channel') && !e.target.closest('.search-result-program')) {
            UIElements.searchResultsContainer.classList.add('hidden');
        }
    });

    UIElements.guideDatePicker.addEventListener('change', (e) => {
        const selectedDate = e.target.value;
        if (selectedDate) {
            const date = new Date(e.target.valueAsDate);
            const userTimezoneOffset = date.getTimezoneOffset() * 60000;
            guideState.currentDate = new Date(date.getTime() + userTimezoneOffset);

            finalizeGuideLoad(true);
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

            if (UIElements.groupFilter.value === 'favorites') {
                handleSearchAndFilter();
            }
            return;
        }

        if (channelInfo) {
            playChannel(channelInfo.dataset.url, channelInfo.dataset.name, channelInfo.dataset.id);
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
        } else if (scrollDirection === 'up' && scrollTop < lastScrollTop) { // Reappear on any scroll up
            UIElements.appContainer.classList.remove('header-collapsed');
        }
        lastScrollTop = scrollTop <= 0 ? 0 : scrollTop;

    }, 100);

    if (UIElements.guideContainer) {
        UIElements.guideContainer.addEventListener('scroll', handleScrollHeader);
    }
}
