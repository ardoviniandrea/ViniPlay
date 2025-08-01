/**
 * guide.js
 * * Manages all functionality related to the TV Guide,
 * including data loading, rendering, searching, and user interaction.
 *
 * REFACTORED to use UI Virtualization for high-performance rendering of large channel lists.
 */

import { appState, guideState, UIElements, dvrState } from './state.js';
import { saveUserSetting } from './api.js';
import { parseM3U } from './utils.js';
import { playChannel } from './player.js';
import { showNotification, openModal, closeModal } from './ui.js';
import { addOrRemoveNotification, findNotificationForProgram } from './notification.js';
import { addOrRemoveDvrJob, findDvrJobForProgram } from './dvr.js'; // NEW: Import DVR functions

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

    // IMPORTANT FIX: Get fresh references to buttons inside the modal
    const detailsTitle = programDetailsModal.querySelector('#details-title');
    const detailsTime = programDetailsModal.querySelector('#details-time');
    const detailsDesc = programDetailsModal.querySelector('#details-desc');
    const detailsPlayBtn = programDetailsModal.querySelector('#details-play-btn');
    const programDetailsNotifyBtn = programDetailsModal.querySelector('#program-details-notify-btn');
    const programDetailsRecordBtn = programDetailsModal.querySelector('#details-record-btn'); // Using UIElements for now as it's passed around, but direct query is safer for modals
    const detailsCloseBtn = programDetailsModal.querySelector('#details-close-btn');

    if (detailsTitle) detailsTitle.textContent = programData.title;
    const progStart = new Date(programData.start);
    const progStop = new Date(programData.stop);
    if (detailsTime) detailsTime.textContent = `${progStart.toLocaleTimeString([],{hour:'2-digit', minute:'2-digit'})} - ${progStop.toLocaleTimeString([],{hour:'2-digit', minute:'2-digit'})}`;
    if (detailsDesc) detailsDesc.textContent = programData.desc || "No description available.";
    
    if (detailsPlayBtn) {
        detailsPlayBtn.onclick = () => {
            playChannel(channelUrl, channelName, channelId);
            closeModal(programDetailsModal);
        };
    }

    const now = new Date();
    const programStopTime = new Date(programData.stop).getTime();
    console.log('[DVR_DEBUG] Program Data:', programData);
    console.log('[DVR_DEBUG] Current Time (now):', now.toISOString());
    console.log('[DVR_DEBUG] Program Stop Time:', new Date(programStopTime).toISOString());
    const isProgramRelevant = programStopTime > now.getTime();
    console.log('[DVR_DEBUG] Is Program Relevant (programStopTime > now.getTime()):', isProgramRelevant);
    
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
                handleSearchAndFilter(false); 
            };
        } else {
            programDetailsNotifyBtn.classList.add('hidden');
        }
    }

    // --- NEW: DVR Record Button Logic ---
    if (programDetailsRecordBtn) {
        const dvrJob = findDvrJobForProgram(programData);

        if (isProgramRelevant) {
            programDetailsRecordBtn.classList.remove('hidden');
            // Ensure the record button becomes a flex item if its parent uses flex, or block otherwise
            programDetailsRecordBtn.style.display = 'block'; // More aggressive override for debugging
            console.log('[DVR_DEBUG] Attempting to show record button. Current display style:', programDetailsRecordBtn.style.display);


            let buttonText = 'Record';
            let buttonClass = 'bg-red-600';
            let hoverClass = 'hover:bg-red-700';
            let isDisabled = false;

            if (dvrJob) {
                switch (dvrJob.status) {
                    case 'pending':
                    case 'scheduled':
                        buttonText = 'Cancel Recording';
                        buttonClass = 'bg-gray-600';
                        hoverClass = 'hover:bg-gray-500';
                        break;
                    case 'recording':
                        buttonText = 'Recording...';
                        buttonClass = 'bg-red-800';
                        hoverClass = 'hover:bg-red-800';
                        isDisabled = true; // Can't cancel while recording from here
                        break;
                    case 'completed':
                    case 'failed':
                        buttonText = 'Recorded';
                        buttonClass = 'bg-green-600';
                        hoverClass = 'hover:bg-green-600';
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
                handleSearchAndFilter(false); 
            };

        } else {
            programDetailsRecordBtn.classList.add('hidden');
            programDetailsRecordBtn.style.display = 'none'; 
            console.log('[DVR_DEBUG] Hiding record button.');
        }
    }
    
    if (detailsCloseBtn) {
        detailsCloseBtn.onclick = () => closeModal(programDetailsModal);
    }

    console.log('[GUIDE_DEBUG] Opening program details modal via openProgramDetails function.');
    openModal(programDetailsModal);
}


// --- Data Loading and Processing ---

/**
 * Handles loading guide data from the server response.
 * @param {string} m3uContent - The M3U playlist content.
 * @param {object} epgContent - The parsed EPG JSON data.
 */
export function handleGuideLoad(m3uContent, epgContent) {
    if (!m3uContent || m3uContent.trim() === '#EXTM3U') {
        guideState.channels = [];
        guideState.programs = {};
    } else {
        guideState.channels = parseM3U(m3uContent);
        guideState.programs = epgContent || {};
    }

    // Cache the loaded data in IndexedDB
    // This is a "fire and forget" operation for performance
    if (appState.db) {
        appState.db.transaction(['guideData'], 'readwrite').objectStore('guideData').put(guideState.channels, 'channels');
        appState.db.transaction(['guideData'], 'readwrite').objectStore('guideData').put(guideState.programs, 'programs');
    }

    finalizeGuideLoad(true);
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
 * @param {boolean} isFirstLoad - Indicates if this is the initial load of the guide.
 */
export function finalizeGuideLoad(isFirstLoad = false) {
    // Add favorite status to channels from user settings
    const favoriteIds = new Set(guideState.settings.favorites || []);
    guideState.channels.forEach(channel => {
        channel.isFavorite = favoriteIds.has(channel.id);
    });

    // Populate unique channel groups and sources for the filter dropdowns
    guideState.channelGroups.clear();
    guideState.channelSources.clear();
    guideState.channels.forEach(ch => {
        if (ch.group) guideState.channelGroups.add(ch.group);
        if (ch.source) guideState.channelSources.add(ch.source);
    });
    populateGroupFilter();
    populateSourceFilter();

    // Initialize Fuse.js for fuzzy searching channels
    appState.fuseChannels = new Fuse(guideState.channels, {
        keys: ['name', 'displayName', 'source', 'chno'],
        threshold: 0.4,
        includeScore: true,
    });

    // --- NEW: Date Picker Initialization ---
    const epgRange = getEpgDateRange();
    if (epgRange && UIElements.guideDatePicker) {
        UIElements.guideDatePicker.min = formatDateForInput(epgRange.minDate);
        UIElements.guideDatePicker.max = formatDateForInput(epgRange.maxDate);
        UIElements.guideDatePicker.value = formatDateForInput(guideState.currentDate);
        UIElements.guideDatePicker.disabled = false;
    } else if (UIElements.guideDatePicker) {
        UIElements.guideDatePicker.disabled = true; // Disable if no EPG data
    }


    // Prepare program data for searching
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
                // Only include programs within the current guide view
                if (progStop < guideStart || progStart > guideEnd) return; // Corrected logic to filter out programs completely outside view
                    
                allPrograms.push({
                    ...prog,
                    channel: {
                        id: channel.id,
                        name: channel.displayName || channel.name,
                        logo: channel.logo,
                        source: channel.source,
                    },
                    // Ensure a programId is generated for programs in the search index
                    programId: `${channel.id}-${progStart.toISOString()}-${progStop.toISOString()}`
                });
            });
        }
    }

    // Initialize Fuse.js for fuzzy searching programs
    appState.fusePrograms = new Fuse(allPrograms, {
        keys: ['title'],
        threshold: 0.4,
        includeScore: true,
    });
    
    // Call new function to set padding top for the guide container
    updateGuidePaddingTop();

    handleSearchAndFilter(isFirstLoad);
}

/**
 * Dynamically sets the padding-top of the guide page based on the combined height of the headers.
 * This is crucial to prevent content from being hidden by sticky headers.
 */
function updateGuidePaddingTop() {
    if (!UIElements.mainHeader || !UIElements.unifiedGuideHeader || !UIElements.pageGuide) {
        console.warn('[GUIDE] Cannot update guide padding: Missing header or page elements.');
        return;
    }

    const mainHeaderHeight = UIElements.mainHeader.offsetHeight;
    const unifiedGuideHeaderHeight = UIElements.unifiedGuideHeader.offsetHeight;
    const totalHeaderHeight = mainHeaderHeight + unifiedGuideHeaderHeight;

    // Apply this height as padding-top to the page-guide
    UIElements.pageGuide.style.paddingTop = `${totalHeaderHeight}px`;
    console.log(`[GUIDE] Setting page-guide padding-top to ${totalHeaderHeight}px.`);
}


// --- UI Rendering (REFACTORED FOR VIRTUALIZATION) ---

/**
 * Renders the guide using UI virtualization.
 * @param {Array<object>} channelsToRender - The filtered list of channels to display.
 * @param {boolean} resetScroll - If true, scrolls the guide to the top-left.
 * @returns {Promise<boolean>} A promise that resolves when the initial render is complete.
 */
const renderGuide = (channelsToRender, resetScroll = false) => {
    return new Promise((resolve) => {
        guideState.visibleChannels = channelsToRender;
        const totalRows = channelsToRender.length;
        const showNoData = totalRows === 0;

        // Toggle placeholder vs. guide content visibility
        UIElements.guidePlaceholder.classList.toggle('hidden', !showNoData);
        UIElements.noDataMessage.classList.toggle('hidden', !showNoData);
        UIElements.initialLoadingIndicator.classList.add('hidden');
        UIElements.guideGrid.classList.toggle('hidden', showNoData);
        if (showNoData) {
            UIElements.guideGrid.innerHTML = '';
            resolve(true); // Resolve even if there's no data
            return;
        }

        // --- Static Header/Time Bar Setup (Done once per full render) ---
        const guideStart = new Date(guideState.currentDate);
        guideStart.setHours(0, 0, 0, 0);
        const guideStartUtc = new Date(Date.UTC(guideStart.getUTCFullYear(), guideStart.getUTCMonth(), guideStart.getUTCDate()));
        const timelineWidth = guideState.guideDurationHours * guideState.hourWidthPixels;
        UIElements.guideGrid.style.setProperty('--timeline-width', `${timelineWidth}px`);
        UIElements.guideDateDisplay.textContent = guideState.currentDate.toLocaleDateString([], { weekday: 'short', month: 'long', day: 'numeric' });

        const timeBarCellEl = UIElements.guideGrid.querySelector('.time-bar-cell');
        if (timeBarCellEl) {
            timeBarCellEl.innerHTML = '';
            for (let i = 0; i < guideState.guideDurationHours; i++) {
                const time = new Date(guideStartUtc.getTime() + i * 3600 * 1000);
                timeBarCellEl.innerHTML += `<div class="absolute top-0 bottom-0 flex items-center justify-start px-2 text-xs text-gray-400 border-r border-gray-700/50" style="left: ${i * guideState.hourWidthPixels}px; width:${guideState.hourWidthPixels}px;">${time.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</div>`;
            }
            timeBarCellEl.style.width = `${timelineWidth}px`;
        }

        const guideContainer = UIElements.guideContainer;
        const guideGrid = UIElements.guideGrid;

        // Remove old virtual content wrapper if it exists (for re-renders)
        let oldContentWrapper = guideGrid.querySelector('#virtual-content-wrapper');
        if (oldContentWrapper) {
            guideGrid.removeChild(oldContentWrapper);
        }

        // Create the main content wrapper for virtualization
        const contentWrapper = document.createElement('div');
        contentWrapper.id = 'virtual-content-wrapper';
        // This is crucial: span both columns of the grid for the main scrollable area
        contentWrapper.style.gridColumn = '1 / -1';
        contentWrapper.style.position = 'relative';
        contentWrapper.style.height = `${totalRows * ROW_HEIGHT}px`; // This sets the total scrollable height

        // Create the container for the visible rows (which will be absolutely positioned)
        const rowContainer = document.createElement('div');
        rowContainer.id = 'virtual-row-container';
        rowContainer.style.position = 'absolute';
        rowContainer.style.width = '100%'; // Spans across the entire virtual content wrapper
        rowContainer.style.top = '0';
        rowContainer.style.left = '0';
        rowContainer.style.display = 'grid'; // This will define the 2-column grid for channels and programs
        rowContainer.style.gridTemplateColumns = 'var(--channel-col-width, 180px) 1fr';

        // Append the row container to the content wrapper
        contentWrapper.appendChild(rowContainer);
        // Append the content wrapper to the guide grid
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

                // Channel Info HTML for the left sticky column
                const channelInfoHTML = `
                    <div class="channel-info p-2 flex items-center justify-between cursor-pointer" data-url="${channel.url}" data-name="${channelName}" data-id="${channel.id}" data-channel-index="${i}" style="top: ${i * ROW_HEIGHT}px;">
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
                        <svg data-channel-id="${channel.id}" class="w-6 h-6 text-gray-500 hover:text-yellow-400 favorite-star cursor-pointer flex-shrink-0 ml-2 ${channel.isFavorite ? 'favorited' : ''}" fill="currentColor" viewBox="0 0 20 20"><path fill-rule="evenodd" d="M10.868 2.884c.321-.772 1.415-.772 1.736 0l1.884 4.545a1.5 1.5 0 001.292.934l4.892.38c.787.061 1.1.99.444 1.527l-3.623 2.805a1.5 1.5 0 00-.48 1.644l1.449 4.493c.25.777-.606 1.378-1.292.934l-4.148-2.564a1.5 1.5 0 00-1.543 0l-4.148 2.564c-.686.444-1.542-.157-1.292-.934l1.449-4.493a1.5 1.5 0 00-.48-1.644L2.008 10.26c-.656-.537-.345-1.466.444-1.527l4.892-.38a1.5 1.5 0 001.292-.934l1.884-4.545z" clip-rule="evenodd" /></svg>
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

                    const hasNotification = findNotificationForProgram({ programId: uniqueProgramId, ...prog }, channel.id);
                    const notificationClass = hasNotification ? 'has-notification' : '';

                    const dvrJob = findDvrJobForProgram({ programId: uniqueProgramId, ...prog });
                    const recordingClass = dvrJob ? `has-recording status-${dvrJob.status}` : '';

                    programsHTML += `<div class="programme-item absolute top-1 bottom-1 bg-gray-800 rounded-md p-2 overflow-hidden flex flex-col justify-center z-5 ${isLive ? 'live' : ''} ${progStop < now ? 'past' : ''} ${notificationClass} ${recordingClass}" style="left:${left}px; width:${Math.max(0, width - 2)}px" data-channel-url="${channel.url}" data-channel-id="${channel.id}" data-channel-name="${channelName}" data-prog-title="${prog.title}" data-prog-desc="${prog.desc}" data-prog-start="${progStart.toISOString()}" data-prog-stop="${progStop.toISOString()}" data-prog-id="${uniqueProgramId}"><div class="programme-progress" style="width:${progressWidth}%"></div><p class="prog-title text-white font-semibold truncate relative z-10">${prog.title}</p><p class="prog-time text-gray-400 truncate relative z-10">${progStart.toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'})} - ${progStop.toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'})}</p></div>`;
                });
                // Timeline Row HTML for the right scrollable column
                const timelineRowHTML = `<div class="timeline-row" style="width: ${timelineWidth}px; top: ${i * ROW_HEIGHT}px; position: absolute;">${programsHTML}</div>`;

                // Append both channel info and timeline row directly to the rowContainer
                rowsHTML += channelInfoHTML + timelineRowHTML;
            }

            rowContainer.innerHTML = rowsHTML;
            // The transform on rowContainer is no longer needed as each row is absolutely positioned
            // rowContainer.style.transform = `translateY(${startIndex * ROW_HEIGHT}px)`;
        };

        if (guideState.scrollHandler) {
            guideContainer.removeEventListener('scroll', guideState.scrollHandler);
        }
        guideState.scrollHandler = throttle(updateVisibleRows, 16);
        guideContainer.addEventListener('scroll', guideState.scrollHandler);

        if (resetScroll) {
            guideContainer.scrollTop = 0;
            // Reset horizontal scroll too on full re-render
            guideContainer.scrollLeft = 0;
        }
        updateVisibleRows();
        updateNowLine(guideStartUtc, resetScroll);

        const nowBtn = UIElements.guideGrid.querySelector('#now-btn');
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
    const channelInfoColWidth = parseInt(getComputedStyle(UIElements.guideGrid).getPropertyValue('--channel-col-width'));

    if (nowValue >= guideStartUtc.getTime() && nowValue <= guideEnd.getTime()) {
        const leftOffsetInScrollableArea = ((nowValue - guideStartUtc.getTime()) / 3600000) * guideState.hourWidthPixels;
        nowLineEl.style.left = `${channelInfoColWidth + leftOffsetInScrollableArea}px`;
        nowLineEl.classList.remove('hidden');
        // The height is now handled by CSS with `height: 100%;` on #now-line, spanning the parent grid.
        // We no longer need to dynamically set its height in JS.
        // nowLineEl.style.height = `${contentWrapper?.scrollHeight || UIElements.guideContainer.scrollHeight}px`;


        if (shouldScroll) {
            setTimeout(() => {
                const isMobile = window.innerWidth < 767; // Consistent mobile breakpoint
                let scrollLeft;

                // Adjust scroll based on whether mobile or desktop view
                if (isMobile) {
                    // On mobile, center the "now" line relative to the entire guide container width
                    scrollLeft = (channelInfoColWidth + leftOffsetInScrollableArea) - (UIElements.guideContainer.clientWidth / 2);
                } else {
                    // On desktop, position it more towards the left, allowing more upcoming programs to be seen
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
    
    // The height of now-line is now CSS-driven via `height: 100%` on guide-grid.

    // Update program states (live, past) for currently rendered programs
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

    // Schedule next update, but only for the positioning of the line and program states
    // The scroll handling within updateNowLine only happens if `shouldScroll` is true.
    setTimeout(() => updateNowLine(guideStartUtc, false), 60000);
};

// --- Filtering and Searching ---

/**
 * Populates the "group" filter dropdown.
 */
const populateGroupFilter = () => {
    const currentVal = UIElements.groupFilter.value;
    UIElements.groupFilter.innerHTML = `<option value="all">All Groups</option><option value="recents">Recents</option><option value="favorites">Favorites</option>`;
    [...guideState.channelGroups].sort((a, b) => a.localeCompare(b)).forEach(group => {
        const cleanGroup = group.replace(/"/g, '&quot;');
        UIElements.groupFilter.innerHTML += `<option value="${cleanGroup}">${group}</option>`;
    });
    UIElements.groupFilter.value = currentVal && UIElements.groupFilter.querySelector(`option[value="${currentVal.replace(/"/g, '&quot;')}"]`) ? currentVal : 'all';
    UIElements.groupFilter.classList.remove('hidden');
};

/**
 * Populates the "source" filter dropdown.
 */
const populateSourceFilter = () => {
    const currentVal = UIElements.sourceFilter.value;
    UIElements.sourceFilter.innerHTML = `<option value="all">All Sources</option>`;
    [...guideState.channelSources].sort((a, b) => a.localeCompare(b)).forEach(source => {
        const cleanSource = source.replace(/"/g, '&quot;');
        UIElements.sourceFilter.innerHTML += `<option value="${cleanSource}">${source}</option>`;
    });
    UIElements.sourceFilter.value = currentVal && UIElements.sourceFilter.querySelector(`option[value="${currentVal.replace(/"/g, '&quot;')}"]`) ? currentVal : 'all';

    UIElements.sourceFilter.classList.remove('hidden');
    UIElements.sourceFilter.style.display = guideState.channelSources.size <= 1 ? 'none' : 'block';
};

/**
 * Filters channels based on dropdowns and rerenders the guide.
 * @param {boolean} isFirstLoad - Indicates if this is the initial load.
 * @returns {Promise<boolean>} A promise that resolves when the re-render is complete.
 */
export function handleSearchAndFilter(isFirstLoad = false) {
    const searchTerm = UIElements.searchInput.value.trim();
    const selectedGroup = UIElements.groupFilter.value;
    const selectedSource = UIElements.sourceFilter.value;
    let channelsForGuide = guideState.channels;

    if (selectedGroup !== 'all') {
        if (selectedGroup === 'favorites') {
            const favoriteIds = new Set(guideState.settings.favorites || []);
            channelsForGuide = channelsForGuide.filter(ch => favoriteIds.has(ch.id));
        } else if (selectedGroup === 'recents') {
            const recentIds = guideState.settings.recentChannels || [];
            channelsForGuide = recentIds.map(id => channelsForGuide.find(ch => ch.id === id)).filter(Boolean);
        } else {
            channelsForGuide = channelsForGuide.filter(ch => ch.group === selectedGroup);
        }
    }

    if (selectedSource !== 'all') {
        channelsForGuide = channelsForGuide.filter(ch => ch.source === selectedSource);
    }

    if (searchTerm && appState.fuseChannels && appState.fusePrograms) {
        const lowerCaseSearchTerm = searchTerm.toLowerCase();
        channelsForGuide = channelsForGuide.filter(ch =>
            (ch.displayName || ch.name).toLowerCase().includes(lowerCaseSearchTerm) ||
            (ch.source && ch.source.toLowerCase().includes(lowerCaseSearchTerm)) ||
            (ch.chno && ch.chno.toLowerCase().includes(lowerCaseSearchTerm))
        );

        const channelResults = appState.fuseChannels.search(searchTerm).slice(0, 10);

        let programResults = [];
        if (guideState.settings.searchScope === 'channels_programs') {
            programResults = appState.fusePrograms.search(searchTerm).slice(0, 20);
        }
        renderSearchResults(channelResults, programResults);
    } else {
        UIElements.searchResultsContainer.innerHTML = '';
        UIElements.searchResultsContainer.classList.add('hidden');
    }

    return renderGuide(channelsForGuide, isFirstLoad);
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
    return function() {
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
        // Find the index of the channel in the currently filtered list
        const channelIndex = guideState.visibleChannels.findIndex(ch =>
            ch.id === channelId || ch.id.endsWith(channelId)
        );

        // If channel isn't in the list, we can't scroll to it.
        if (channelIndex === -1) {
            console.warn(`[GUIDE_SCROLL_FAIL] Channel with ID/suffix "${channelId}" not found in visibleChannels list.`);
            resolve(false);
            return;
        }

        const foundChannel = guideState.visibleChannels[channelIndex];
        console.log(`[GUIDE_SCROLL] Found channel for ID "${channelId}". Matched with "${foundChannel.id}". Scrolling to index ${channelIndex}.`);
        
        // Calculate the target scroll position
        const targetScrollTop = channelIndex * ROW_HEIGHT;

        // Initiate the scroll
        UIElements.guideContainer.scrollTo({ top: targetScrollTop, behavior: 'smooth' });

        // --- NEW ROBUST WAITER ---
        // Now, wait for the element to actually be rendered by the virtualization logic.
        let attempts = 0;
        const maxAttempts = 100; // 100 * 50ms = 5 second timeout
        const checkInterval = setInterval(() => {
            const channelElement = UIElements.guideGrid.querySelector(`.channel-info[data-id="${foundChannel.id}"]`);

            if (channelElement) {
                // Element is in the DOM! We can now safely proceed.
                clearInterval(checkInterval);
                console.log(`[GUIDE_SCROLL] Channel element for "${foundChannel.id}" is now visible in the DOM.`);
                resolve(true);
            } else {
                attempts++;
                if (attempts >= maxAttempts) {
                    clearInterval(checkInterval);
                    console.warn(`[GUIDE_SCROLL_FAIL] Max attempts reached waiting for channel element "${foundChannel.id}" to be rendered.`);
                    resolve(false);
                }
            }
        }, 50); // Check every 50ms
    });
};



// --- Event Listeners ---

/**
 * Sets up all event listeners for the guide page.
 */
export function setupGuideEventListeners() {
    UIElements.groupFilter.addEventListener('change', () => handleSearchAndFilter());
    UIElements.sourceFilter.addEventListener('change', () => handleSearchAndFilter());
    UIElements.searchInput.addEventListener('input', () => {
        clearTimeout(appState.searchDebounceTimer);
        appState.searchDebounceTimer = setTimeout(() => handleSearchAndFilter(false), 250);
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
        console.log('[GUIDE_DEBUG] guideGrid click event fired. Target:', e.target);
        
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
             guideStart.setHours(0,0,0,0);

             const dateDiff = Math.floor((progStart - guideStart) / (1000 * 60 * 60 * 24));
             if (dateDiff !== 0) {
                 guideState.currentDate.setDate(guideState.currentDate.getDate() + dateDiff);
                 finalizeGuideLoad();
             }

            setTimeout(() => {
                const programElement = UIElements.guideGrid.querySelector(`.programme-item[data-prog-start="${programItem.dataset.progStart}"][data-channel-id="${programItem.dataset.channelId}"]`);
                if(programElement) {
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
    let initialHeaderHeight = 0;

    const calculateInitialHeaderHeight = () => {
        let height = 0;
        if (UIElements.mainHeader) height += UIElements.mainHeader.offsetHeight;
        if (UIElements.unifiedGuideHeader) height += UIElements.unifiedGuideHeader.offsetHeight;
        return height;
    };

    const handleScrollHeader = throttle(() => {
        if (!UIElements.guideContainer || !UIElements.appContainer || !UIElements.pageGuide) {
            return;
        }

        const scrollTop = UIElements.guideContainer.scrollTop;
        const scrollDirection = scrollTop > lastScrollTop ? 'down' : 'up';

        // Calculate initial header height once or when elements might have changed size
        if (initialHeaderHeight === 0 || UIElements.mainHeader.offsetHeight + UIElements.unifiedGuideHeader.offsetHeight !== initialHeaderHeight) {
            initialHeaderHeight = calculateInitialHeaderHeight();
            // Also update page-guide padding immediately if header heights change
            updateGuidePaddingTop();
        }

        const collapseThreshold = initialHeaderHeight * 0.5; // Start collapsing after 50% scroll

        if (scrollDirection === 'down' && scrollTop > collapseThreshold) {
            UIElements.appContainer.classList.add('header-collapsed');
            // When collapsed, set page-guide padding-top to 0 or minimum needed for sticky corner
            UIElements.pageGuide.style.paddingTop = `0px`; // Or whatever minimum margin needed
        } else if (scrollDirection === 'up' && scrollTop <= collapseThreshold / 2) { // Show headers fully when scrolled near top
            UIElements.appContainer.classList.remove('header-collapsed');
            // When uncollapsed, restore padding-top to full header height
            updateGuidePaddingTop();
        }
        lastScrollTop = scrollTop <= 0 ? 0 : scrollTop;
    }, 100);

    // Attach the scroll handler to the guide container
    if (UIElements.guideContainer) {
        UIElements.guideContainer.addEventListener('scroll', handleScrollHeader);
    }
}
