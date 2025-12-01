/**
 * ui.js
 * * Contains functions for managing the user interface.
 * This includes navigation, modals, notifications, and other DOM manipulations.
 */

import { UIElements, appState, guideState } from './state.js';
import { refreshUserList, updateUIFromSettings } from './settings.js';
import { loadAndScheduleNotifications, renderNotifications } from './notification.js';
import { initMultiView, isMultiViewActive, cleanupMultiView } from './multiview.js';
import { initDvrPage } from './dvr.js';
import { stopAndCleanupPlayer } from './player.js';
import { initDirectPlayer, isDirectPlayerActive, cleanupDirectPlayer } from './player_direct.js';
// MODIFIED: Import handleGuideLoad and fetchConfig for the refresh logic
import { finalizeGuideLoad, handleGuideLoad } from './guide.js';
import { fetchConfig } from './api.js';
import { initActivityPage } from './admin.js';
import { initVodPage } from './vod.js';


let confirmCallback = null;
let currentPage = '/';
let activeModalCloseListener = null;
let isResizing = false;
// FINAL FIX: Flag to temporarily block config reloads after a setting is saved.
let blockConfigReload = false;

// NEW: Exported variable to track if processing is running
export let isProcessingRunning = false;


/**
 * Shows a notification message at the top-right of the screen.
 * @param {string} message - The message to display.
 * @param {boolean} isError - If true, displays a red error notification.
 * @param {number} duration - How long the notification should be visible in ms.
 */
export const showNotification = (message, isError = false, duration = 3000) => {
    if (!UIElements.notificationBox || !UIElements.notificationMessage || !UIElements.notificationModal) {
        console.error('[UI_NOTIF] Notification elements not found in UIElements. Cannot display notification.');
        console.log('[UI_NOTIF] Message attempted: ', message);
        return;
    }

    UIElements.notificationMessage.textContent = message;

    UIElements.notificationBox.classList.remove('success-bg', 'error-bg');
    UIElements.notificationBox.classList.add(isError ? 'error-bg' : 'success-bg');

    UIElements.notificationModal.classList.remove('hidden');

    setTimeout(() => { UIElements.notificationModal.classList.add('hidden'); }, duration);
};

/**
 * Displays a modal.
 * @param {HTMLElement} modal - The modal element to show.
 */
export const openModal = (modal) => {
    modal.classList.replace('hidden', 'flex');
    document.body.classList.add('modal-open');

    const handleBackdropClick = (e) => {
        if (e.target === modal) {
            const onMouseUp = (upEvent) => {
                if (upEvent.target === modal && !isResizing) {
                    if (modal === UIElements.videoModal) {
                        stopAndCleanupPlayer();
                    } else {
                        closeModal(modal);
                    }
                }
                document.removeEventListener('mouseup', onMouseUp);
            };
            document.addEventListener('mouseup', onMouseUp, { once: true });
        }
    };

    if (activeModalCloseListener && activeModalCloseListener.element) {
        activeModalCloseListener.element.removeEventListener('mousedown', activeModalCloseListener.handler);
    }

    modal.addEventListener('mousedown', handleBackdropClick);
    activeModalCloseListener = { element: modal, handler: handleBackdropClick };
};

/**
 * Hides a modal.
 * @param {HTMLElement} modal - The modal element to hide.
 */
export const closeModal = (modal) => {
    modal.classList.replace('flex', 'hidden');

    if (activeModalCloseListener && activeModalCloseListener.element === modal) {
        activeModalCloseListener.element.removeEventListener('mousedown', activeModalCloseListener.handler);
        activeModalCloseListener = null;
    }

    if (!document.querySelector('.fixed.inset-0.flex')) {
        document.body.classList.remove('modal-open');
    }
};


/**
 * Shows a confirmation dialog.
 * @param {string} title - The title of the confirmation dialog.
 * @param {string} message - The message body of the dialog.
 * @param {Function} callback - The function to execute if the user confirms.
 */
export const showConfirm = (title, message, callback) => {
    UIElements.confirmTitle.textContent = title;
    UIElements.confirmMessage.innerHTML = message;
    confirmCallback = callback;
    openModal(UIElements.confirmModal);
};

/**
 * NEW: Displays a site-wide broadcast message banner at the top of the page.
 * @param {string} message - The message to display.
 */
export const showBroadcastMessage = (message) => {
    const container = UIElements.broadcastBannerContainer;
    if (!container) return;

    const banner = document.createElement('div');
    banner.className = 'broadcast-banner';
    banner.textContent = message;

    container.appendChild(banner);

    // Use a short timeout to allow the element to be in the DOM before adding the class to trigger the transition
    setTimeout(() => {
        banner.classList.add('visible');
    }, 50);

    // Hide the banner after 10 seconds
    setTimeout(() => {
        banner.classList.remove('visible');
        // Remove the element from the DOM after the transition ends
        banner.addEventListener('transitionend', () => {
            if (banner.parentElement) {
                banner.remove();
            }
        });
    }, 10000);
};

export function handleConfirm() {
    if (confirmCallback) {
        confirmCallback();
    }
    closeModal(UIElements.confirmModal);
}

/**
 * Sets the loading state of a button, showing a spinner.
 * @param {HTMLElement} buttonEl - The button element.
 * @param {boolean} isLoading - True to show loading state, false to restore.
 * @param {string} originalContent - The original HTML content of the button.
 */
export const setButtonLoadingState = (buttonEl, isLoading, originalContent) => {
    if (!buttonEl) return;
    buttonEl.disabled = isLoading;
    const btnContentEl = buttonEl.querySelector('span');
    if (btnContentEl) {
        btnContentEl.innerHTML = isLoading ?
            `<svg class="animate-spin h-5 w-5 text-white" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24"><circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle><path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path></svg><span>Loading...</span>` :
            originalContent;
    }
};

/**
 * Makes a modal window resizable by dragging a handle.
 */
export const makeModalResizable = (handleEl, containerEl, minWidth, minHeight, settingKey, ratioCallback = null) => {
    import('./api.js').then(({ saveUserSetting }) => {
        let resizeDebounceTimer;

        const startResize = (clientX, clientY) => {
            isResizing = true;
            const startX = clientX;
            const startY = clientY;
            const startWidth = containerEl.offsetWidth;
            const startHeight = containerEl.offsetHeight;

            const doResize = (moveEvent) => {
                // Handle both mouse and touch events for coordinates
                const currentX = moveEvent.touches ? moveEvent.touches[0].clientX : moveEvent.clientX;
                const currentY = moveEvent.touches ? moveEvent.touches[0].clientY : moveEvent.clientY;

                let newWidth = Math.max(minWidth, startWidth + currentX - startX);
                let newHeight = Math.max(minHeight, startHeight + currentY - startY);

                // Apply aspect ratio if callback is provided
                if (ratioCallback) {
                    const calculatedHeight = ratioCallback(newWidth);
                    if (calculatedHeight) {
                        newHeight = calculatedHeight;
                    }
                }

                containerEl.style.width = `${newWidth}px`;
                containerEl.style.height = `${newHeight}px`;
            };

            const stopResize = () => {
                window.removeEventListener('mousemove', doResize);
                window.removeEventListener('mouseup', stopResize);
                window.removeEventListener('touchmove', doResize);
                window.removeEventListener('touchend', stopResize);
                document.body.style.cursor = '';

                isResizing = false;

                clearTimeout(resizeDebounceTimer);
                resizeDebounceTimer = setTimeout(() => {
                    saveUserSetting(settingKey, {
                        width: containerEl.offsetWidth,
                        height: containerEl.offsetHeight,
                    });
                }, 500);
            };

            document.body.style.cursor = 'se-resize';
            window.addEventListener('mousemove', doResize);
            window.addEventListener('mouseup', stopResize);
            window.addEventListener('touchmove', doResize, { passive: false });
            window.addEventListener('touchend', stopResize);
        };

        handleEl.addEventListener('mousedown', e => {
            e.preventDefault();
            startResize(e.clientX, e.clientY);
        }, false);

        handleEl.addEventListener('touchstart', e => {
            e.preventDefault(); // Prevent scrolling while resizing
            startResize(e.touches[0].clientX, e.touches[0].clientY);
        }, { passive: false });
    });
};

/**
 * Makes a column resizable horizontally by dragging a handle.
 */
export const makeColumnResizable = (handleEl, targetEl, minWidth, settingKey, cssVarName) => {
    Promise.all([
        import('./api.js'),
        import('./guide.js')
    ]).then(([{ saveUserSetting }, { updateNowLinePosition }]) => {
        let resizeDebounceTimer;
        let startWidth;
        let startX;

        if (!targetEl) {
            console.error('makeColumnResizable: targetEl is null. Cannot apply resize logic.');
            return;
        }

        const startResize = (clientX) => {
            isResizing = true;
            startX = clientX;
            startWidth = parseInt(getComputedStyle(targetEl).getPropertyValue(cssVarName)) || minWidth;

            const doResize = (moveEvent) => {
                const currentX = moveEvent.touches ? moveEvent.touches[0].clientX : moveEvent.clientX;
                const newWidth = startWidth + (currentX - startX);
                const finalWidth = Math.max(minWidth, newWidth);
                targetEl.style.setProperty(cssVarName, `${finalWidth}px`);

                // CRITICAL: Update guideState immediately and recalculate NOW line position
                guideState.settings.channelColumnWidth = finalWidth;
                updateNowLinePosition();
            };

            const stopResize = () => {
                window.removeEventListener('mousemove', doResize);
                window.removeEventListener('mouseup', stopResize);
                window.removeEventListener('touchmove', doResize);
                window.removeEventListener('touchend', stopResize);
                document.body.style.cursor = '';
                isResizing = false;

                clearTimeout(resizeDebounceTimer);
                resizeDebounceTimer = setTimeout(() => {
                    const currentWidth = parseInt(getComputedStyle(targetEl).getPropertyValue(cssVarName));
                    saveUserSetting(settingKey, currentWidth);
                }, 500);
            };

            document.body.style.cursor = 'ew-resize';
            window.addEventListener('mousemove', doResize);
            window.addEventListener('mouseup', stopResize);
            window.addEventListener('touchmove', doResize, { passive: false });
            window.addEventListener('touchend', stopResize);
        };

        handleEl.addEventListener('mousedown', e => {
            e.preventDefault();
            startResize(e.clientX);
        }, false);

        handleEl.addEventListener('touchstart', e => {
            e.preventDefault();
            startResize(e.touches[0].clientX);
        }, { passive: false });
    });
};

/**
 * Opens the mobile navigation menu.
 */
export const openMobileMenu = () => {
    if (UIElements.mobileNavMenu) {
        UIElements.mobileNavMenu.classList.remove('hidden');
        UIElements.mobileNavMenu.classList.remove('-translate-x-full');
        UIElements.mobileNavMenu.classList.add('translate-x-0');
    }
    if (UIElements.mobileMenuOverlay) {
        UIElements.mobileMenuOverlay.classList.remove('hidden');
    }
    document.body.classList.add('overflow-hidden');
};

/**
 * Closes the mobile navigation menu.
 */
export const closeMobileMenu = () => {
    if (UIElements.mobileNavMenu) {
        UIElements.mobileNavMenu.classList.add('-translate-x-full');
        UIElements.mobileNavMenu.classList.remove('translate-x-0');
        UIElements.mobileNavMenu.addEventListener('transitionend', function handler() {
            UIElements.mobileNavMenu.classList.add('hidden');
            UIElements.mobileNavMenu.removeEventListener('transitionend', handler);
        });
    }
    if (UIElements.mobileMenuOverlay) {
        UIElements.mobileMenuOverlay.classList.add('hidden');
    }
    document.body.classList.remove('overflow-hidden');
};

// FINAL FIX: This function will be called whenever a setting is saved.
/**
 * Temporarily blocks the automatic config reload that happens on navigation.
 * This prevents the UI from overwriting a user's new setting with old data from the server.
 */
export const tempBlockConfigReload = () => {
    blockConfigReload = true;
    console.log(`%c[DEBUG] RACE_CONDITION_FIX: Config reload temporarily BLOCKED.`, 'color: #fca5a5; font-weight: bold;');
    setTimeout(() => {
        blockConfigReload = false;
        console.log(`%c[DEBUG] RACE_CONDITION_FIX: Config reload UNBLOCKED.`, 'color: #86efac; font-weight: bold;');
    }, 1000); // Block for 1 second, plenty of time for the save to complete.
};


/**
 * Handles client-side routing by showing/hiding pages.
 */
export const handleRouteChange = () => {
    const wasMultiView = currentPage.startsWith('/multiview');
    const wasPlayer = currentPage.startsWith('/player');
    const path = window.location.pathname;

    if (wasMultiView && !path.startsWith('/multiview')) {
        if (isMultiViewActive()) {
            showConfirm(
                'Leave Multi-View?',
                'Leaving this page will stop all streams and clear your current layout. Are you sure?',
                () => {
                    cleanupMultiView();
                    proceedWithRouteChange(path);
                }
            );
            window.history.pushState({}, currentPage, window.location.origin + currentPage);
            return;
        } else {
            cleanupMultiView();
        }
    }

    if (wasPlayer && !path.startsWith('/player')) {
        if (isDirectPlayerActive()) {
            showConfirm(
                'Leave Player?',
                'Leaving this page will stop the current stream. Are you sure?',
                () => {
                    cleanupDirectPlayer();
                    proceedWithRouteChange(path);
                }
            );
            window.history.pushState({}, currentPage, window.location.origin + currentPage);
            return;
        } else {
            cleanupDirectPlayer();
        }
    }

    proceedWithRouteChange(path);
};

/**
 * The core logic for switching pages after checks have passed.
 * MODIFIED: Now handles visibility of Settings and DVR tabs based on admin/user permissions.
 * @param {string} path - The new path to render.
 */
async function proceedWithRouteChange(path) {
    const isGuide = path.startsWith('/tvguide') || path === '/';
    const isMultiView = path.startsWith('/multiview');
    const isPlayer = path.startsWith('/player');
    const isDvr = path.startsWith('/dvr');
    const isVod = path.startsWith('/vod');
    const isActivity = path.startsWith('/activity');
    const isNotifications = path.startsWith('/notifications');
    const isSettings = path.startsWith('/settings');

    closeMobileMenu();

    const isAdmin = appState.currentUser?.isAdmin;

    // Toggle desktop and mobile nav button visibility and active state
    UIElements.tabGuide?.classList.toggle('active', isGuide);
    UIElements.mobileNavGuide?.classList.toggle('active', isGuide);

    UIElements.tabMultiview?.classList.toggle('active', isMultiView);
    UIElements.mobileNavMultiview?.classList.toggle('active', isMultiView);

    UIElements.tabPlayer?.classList.toggle('active', isPlayer);
    UIElements.mobileNavPlayer?.classList.toggle('active', isPlayer);

    // DVR tab is visible to all users to see completed recordings
    if (UIElements.tabDvr) UIElements.tabDvr.classList.toggle('active', isDvr);
    if (UIElements.mobileNavDvr) UIElements.mobileNavDvr.classList.toggle('active', isDvr);

    // VOD tab is visible to all
    if (UIElements.tabVod) UIElements.tabVod.classList.toggle('active', isVod);
    if (UIElements.mobileNavVod) UIElements.mobileNavVod.classList.toggle('active', isVod);
    // --- END ADD ---

    // Activity tab is for admins only
    if (UIElements.tabActivity) {
        UIElements.tabActivity.classList.toggle('active', isActivity && isAdmin);
        UIElements.tabActivity.classList.toggle('hidden', !isAdmin);
    }
    if (UIElements.mobileNavActivity) {
        UIElements.mobileNavActivity.classList.toggle('active', isActivity && isAdmin);
        UIElements.mobileNavActivity.classList.toggle('hidden', !isAdmin);
    }

    UIElements.tabNotifications?.classList.toggle('active', isNotifications);
    UIElements.mobileNavNotifications?.classList.toggle('active', isNotifications);

    // Settings tab is for admins only
    if (UIElements.tabSettings) {
        UIElements.tabSettings.classList.toggle('active', isSettings && isAdmin);
        UIElements.tabSettings.classList.toggle('hidden', !isAdmin);
    }
    if (UIElements.mobileNavSettings) {
        UIElements.mobileNavSettings.classList.toggle('active', isSettings && isAdmin);
        UIElements.mobileNavSettings.classList.toggle('hidden', !isAdmin);
    }

    // Toggle page visibility
    UIElements.pageGuide.classList.toggle('hidden', !isGuide);
    UIElements.pageGuide.classList.toggle('flex', isGuide);

    UIElements.pageMultiview.classList.toggle('hidden', !isMultiView);
    UIElements.pageMultiview.classList.toggle('flex', isMultiView);

    UIElements.pagePlayer.classList.toggle('hidden', !isPlayer);
    UIElements.pagePlayer.classList.toggle('flex', isPlayer);

    // Show DVR page to everyone; content inside is handled by dvr.js
    UIElements.pageDvr.classList.toggle('hidden', !isDvr);
    UIElements.pageDvr.classList.toggle('flex', isDvr);

    // Show VOD page to everyone
    UIElements.pageVod.classList.toggle('hidden', !isVod);
    UIElements.pageVod.classList.toggle('flex', isVod);
    // --- END ADD ---

    UIElements.pageActivity.classList.toggle('hidden', !isActivity || !isAdmin);
    UIElements.pageActivity.classList.toggle('flex', isActivity && isAdmin);

    UIElements.pageNotifications.classList.toggle('hidden', !isNotifications);
    UIElements.pageNotifications.classList.toggle('flex', isNotifications);

    // Show settings page only to admins
    UIElements.pageSettings.classList.toggle('hidden', !isSettings || !isAdmin);
    UIElements.pageSettings.classList.toggle('flex', isSettings && isAdmin);

    const appContainer = UIElements.appContainer;

    if (isGuide) {
        if (appContainer) appContainer.classList.remove('header-collapsed');
        if (UIElements.guideContainer) UIElements.guideContainer.scrollTop = 0;

        if (blockConfigReload) {
            console.log(`%c[DEBUG] RACE_CONDITION_FIX: Navigation to Guide tab occurred while config reload was blocked. Skipping reload.`, 'color: #fca5a5; font-weight: bold;');
            return;
        }

        if (!appState.isNavigating) {
            console.log('[UI] Refreshing TV Guide data on tab switch.');
            const config = await fetchConfig();
            if (config) {
                Object.assign(guideState.settings, config.settings || {});
                // --- FIX: Add VOD data to the global state ---
                //guideState.vodMovies = config.vodMovies || [];
                //guideState.vodSeries = config.vodSeries || [];
                finalizeGuideLoad(true);
            }
        } else {
            console.log('[UI] Skipping soft refresh because a navigation action is in progress.');
        }

    } else {
        if (appContainer) appContainer.classList.remove('header-collapsed');

        if (isSettings && isAdmin) {
            if (blockConfigReload) {
                console.log(`%c[DEBUG] RACE_CONDITION_FIX: Navigation to Settings tab occurred while config reload was blocked. Skipping reload.`, 'color: #fca5a5; font-weight: bold;');
            } else {
                updateUIFromSettings();
                if (appState.currentUser?.isAdmin) refreshUserList();
            }
        } else if (isNotifications) {
            await loadAndScheduleNotifications();
        } else if (isMultiView) {
            initMultiView();
        } else if (isPlayer) {
            initDirectPlayer();
        } else if (isDvr) { // DVR page init is now called for all users
            await initDvrPage();
        } else if (isVod) {
            await initVodPage();
        } else if (isActivity && isAdmin) {
            await initActivityPage();
        }
    }
    currentPage = path;
}


/**
 * Pushes a new state to the browser history and triggers a route change.
 * @param {string} path - The new path to navigate to.
 */
export const navigate = (path) => {
    if (window.location.pathname !== path) {
        window.history.pushState({}, path, window.location.origin + path);
    }
    handleRouteChange();
};

/**
 * Switches between the tabs.
 * @param {string} activeTab - The tab to switch to.
 */
export const switchTab = (activeTab) => {
    let newPath;
    if (activeTab === 'guide') newPath = '/tvguide';
    else if (activeTab === 'multiview') newPath = '/multiview';
    else if (activeTab === 'player') newPath = '/player';
    else if (activeTab === 'dvr') newPath = '/dvr';
    else if (activeTab === 'vod') newPath = '/vod';
    else if (activeTab === 'activity') newPath = '/activity';
    else if (activeTab === 'notifications') newPath = '/notifications';
    else newPath = '/settings';
    navigate(newPath);
};

// Variable to track the last processing status to determine the action of the main button
// let isProcessingRunning = false; //commenting this out as it's exported above

// MODIFIED: Add export to this function
/**
 * NEW: Initiates a refresh of the TV Guide with new data.
 * FIXED: Reordered operations to fix race condition - navigate first, then load data.
 * FIXED: Set isNavigating flag to prevent navigation from triggering competing guide load.
 * FIXED: Load guide data BEFORE navigating to ensure DOM is ready for centering.
 */
export async function refreshGuideAfterProcessing() {
    console.log('[UI_PROCESS] Finalizing process and refreshing guide...');

    // 1. Close the modal first
    closeModal(UIElements.processingStatusModal);

    // 2. Fetch the absolute latest config from the server FIRST
    const config = await fetchConfig();
    console.log('[UI_PROCESS_DEBUG] Config fetched:', config ? 'SUCCESS' : 'NULL');
    console.log('[UI_PROCESS_DEBUG] m3uContent exists:', !!config?.m3uContent);
    console.log('[UI_PROCESS_DEBUG] m3uContent length:', config?.m3uContent?.length || 0);

    // 3. Update the global state
    if (config) {
        Object.assign(guideState.settings, config.settings || {});
    }

    // 4. Load guide data FIRST (this processes and stores the data in memory)
    // Do NOT render yet - just parse and store
    if (config?.m3uContent) {
        console.log('[UI_PROCESS_DEBUG] About to parse guide data (no render yet)...');
        await guideState.settings.timezoneOffset; // Ensure timezone is set before parsing

        // Parse the M3U and store in guideState (from handleGuideLoad logic)
        const { parseM3U } = await import('./utils.js');
        guideState.channels = parseM3U(config.m3uContent);
        guideState.programs = config.epgContent || {};

        // Store in IndexedDB
        if (appState.db) {
            await appState.db.transaction(['guideData'], 'readwrite').objectStore('guideData').put(guideState.channels, 'channels');
            await appState.db.transaction(['guideData'], 'readwrite').objectStore('guideData').put(guideState.programs, 'programs');
        }

        console.log('[UI_PROCESS_DEBUG] Guide data parsed and stored. Channels:', guideState.channels.length);

        // 5. NOW navigate to the guide tab
        // Set flag to prevent competing load
        appState.isNavigating = true;
        navigate('/tvguide');

        // 6. CRITICAL: Wait for the guide page to be FULLY VISIBLE before rendering
        // This ensures the page container is visible so DOM queries work
        await new Promise(resolve => {
            const checkVisible = () => {
                const guidePage = document.getElementById('page-guide');

                // Only check if the PAGE is visible, not the grid
                // (the grid visibility is controlled by renderGuide itself)
                if (guidePage && !guidePage.classList.contains('hidden')) {
                    console.log('[UI_PROCESS_DEBUG] Guide page is now visible');
                    resolve();
                } else {
                    requestAnimationFrame(checkVisible);
                }
            };
            checkVisible();
        });

        // 7. NOW render the guide with centering using the pre-loaded data
        console.log('[UI_PROCESS_DEBUG] About to finalize guide load with shouldCenter=true');
        await import('./guide.js').then(module => module.finalizeGuideLoad(true));
        console.log('[UI_PROCESS_DEBUG] Guide finalized - render complete');

        // 8. Reset navigation flag
        appState.isNavigating = false;

        showNotification('Sources processed. TV Guide updated!', false, 4000);
    } else {
        console.log('[UI_PROCESS_DEBUG] Skipping handleGuideLoad - no m3uContent');
        showNotification('Sources processed, but no guide data found.', true, 4000);
    }

    // 9. Update settings page UI for source status indicators
    import('./settings.js').then(module => module.updateUIFromSettings());
}


/**
 * NEW: Shows and resets the processing status modal.
 */
export function showProcessingModal() {
    const modal = UIElements.processingStatusModal;
    const logContainer = UIElements.processingStatusLog;

    if (!modal || !logContainer || !UIElements.processingStatusBackgroundBtn || !UIElements.processingStatusCloseRefreshBtn || !UIElements.processingStatusRunningActions || !UIElements.processingStatusFinishedActions) {
        console.error('[UI_PROCESS] Missing processing modal elements in UIElements.');
        return;
    }

    // Reset the modal state
    logContainer.innerHTML = '';
    isProcessingRunning = true; // Assume running when modal is first opened

    // Hide all action buttons initially
    UIElements.processingStatusRunningActions.classList.remove('hidden');
    UIElements.processingStatusFinishedActions.classList.add('hidden');
    UIElements.processingStatusBackgroundBtn.classList.remove('hidden');

    // 1. Setup 'Continue in the background' button
    UIElements.processingStatusBackgroundBtn.onclick = () => {
        closeModal(modal);
        showNotification('Processing continued in the background.');
        // The main process-sources-btn listener is set up in settings.js to handle reopening
    };

    // 2. Setup 'Close and refresh' button
    UIElements.processingStatusCloseRefreshBtn.onclick = refreshGuideAfterProcessing;

    openModal(modal);
}

// MODIFIED: updateProcessingStatus function
/**
 * NEW: Updates the content of the processing status modal.
 * @param {string} message - The log message to display.
 * @param {string} type - The type of message ('info', 'success', 'error', 'final_success').
 */
export function updateProcessingStatus(message, type = 'info') {
    const logContainer = UIElements.processingStatusLog;
    const modal = UIElements.processingStatusModal; // Get a reference to the modal

    // --- New Button Logic ---
    const runningActionsEl = UIElements.processingStatusRunningActions;
    const finishedActionsEl = UIElements.processingStatusFinishedActions;
    // --- End New Button Logic ---

    if (!logContainer || !runningActionsEl || !finishedActionsEl || !modal) return;

    const logEntry = document.createElement('p');
    const timestamp = new Date().toLocaleTimeString();
    let typeIndicator = '';
    let colorClass = 'text-gray-400';
    let isFinished = false;

    switch (type) {
        case 'success':
            typeIndicator = '[SUCCESS]';
            colorClass = 'text-green-400';
            break;
        case 'final_success':
            typeIndicator = '[SUCCESS]';
            colorClass = 'text-green-400';
            isFinished = true;
            break;
        case 'error':
            typeIndicator = '[ERROR]';
            colorClass = 'text-red-400';
            isFinished = true;
            break;
        case 'info':
        default:
            typeIndicator = '[INFO]';
            break;
    }

    logEntry.innerHTML = `<span class="text-gray-500">${timestamp}</span> <span class="${colorClass} font-semibold">${typeIndicator}</span> <span class="${colorClass}">${message}</span>`;
    logContainer.appendChild(logEntry);

    // Auto-scroll to the bottom
    logContainer.scrollTop = logContainer.scrollHeight;

    // Update button visibility based on completion
    if (isFinished) {
        isProcessingRunning = false;
        runningActionsEl.classList.add('hidden');
        finishedActionsEl.classList.remove('hidden');

        // *** NEW LOGIC ***
        // If the process is finished and the modal is hidden (running in background),
        // dispatch a global event to notify the app.
        if (modal.classList.contains('hidden')) {
            console.log('[UI_PROCESS] Background process finished. Dispatching event.');
            document.dispatchEvent(new CustomEvent('background-process-finished'));
        }
        // *** END NEW LOGIC ***

    } else {
        runningActionsEl.classList.remove('hidden');
        finishedActionsEl.classList.add('hidden');
    }
}
