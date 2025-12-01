/**
 * main.js
 *
 * Main entry point for the ViniPlay application.
 * Initializes the app by setting up authentication, event listeners, and loading initial data.
 */

import { appState, guideState, UIElements } from './modules/state.js';
import { apiFetch, fetchConfig } from './modules/api.js'; // IMPORTED fetchConfig
import { checkAuthStatus, setupAuthEventListeners } from './modules/auth.js';
import { handleGuideLoad, finalizeGuideLoad, setupGuideEventListeners } from './modules/guide.js';
//-- ENHANCEMENT: Import playChannel to handle the remote channel change event.
import { setupPlayerEventListeners, playChannel, stopAndCleanupPlayer, shouldMaintainAspectRatio } from './modules/player.js';
import { setupSettingsEventListeners, populateTimezoneSelector, updateUIFromSettings } from './modules/settings.js';
// MODIFIED: Imported showBroadcastMessage
import { makeModalResizable, handleRouteChange, switchTab, handleConfirm, closeModal, makeColumnResizable, openMobileMenu, closeMobileMenu, showNotification, showBroadcastMessage, updateProcessingStatus, showConfirm, refreshGuideAfterProcessing } from './modules/ui.js';
// MODIFIED: Import navigateToProgramInGuide to handle deep links from notifications.
import { loadAndScheduleNotifications, subscribeUserToPush, navigateToProgramInGuide } from './modules/notification.js';
import { setupDvrEventListeners, handleDvrChannelClick, initDvrPage } from './modules/dvr.js';
import { handleMultiViewChannelClick, populateChannelSelector, initMultiView } from './modules/multiview.js';
import { setupDirectPlayerEventListeners, initDirectPlayer } from './modules/player_direct.js';
import { initVodPage } from './modules/vod.js';
import { ICONS } from './modules/icons.js'; // MODIFIED: Import the new icon library
//-- ENHANCEMENT: Import the new handler for channel selector clicks from the admin page.
import { initActivityPage, setupAdminEventListeners, handleActivityUpdate, handleAdminChannelClick } from './modules/admin.js';

// The initializeCastApi function is no longer called directly from here,
// but the cast.js module will handle its own initialization via the window callback.

// NEW: Global variable to hold navigation target from a notification click
let notificationTarget = null;

/**
 * NEW: Finds all icon placeholders in the document and injects the SVG markup.
 */
function renderIcons() {
    console.log('[MAIN] Rendering all icons from placeholders...');
    const iconPlaceholders = document.querySelectorAll('[data-icon]');
    iconPlaceholders.forEach(placeholder => {
        const iconName = placeholder.dataset.icon;
        if (ICONS[iconName]) {
            // Replace the placeholder itself with the SVG element
            const template = document.createElement('template');
            template.innerHTML = ICONS[iconName].trim();
            const svgElement = template.content.firstChild;

            // Copy any existing classes from the placeholder to the SVG
            if (placeholder.className) {
                svgElement.classList.add(...placeholder.className.split(' '));
            }

            // Replace the placeholder in the DOM
            placeholder.parentNode.replaceChild(svgElement, placeholder);
        } else {
            console.warn(`[ICONS] Icon not found in library: ${iconName}`);
        }
    });
}


/**
 * NEW: Connects to the server for real-time events using Server-Sent Events (SSE).
 * This allows the server to push updates to the client, such as invalidating a push subscription.
 */
function initializeSse() {
    console.log('[SSE] Initializing Server-Sent Events connection...');
    const eventSource = new EventSource('/api/events');

    eventSource.onopen = () => {
        console.log('[SSE] Connection to server opened.');
    };

    eventSource.onerror = (error) => {
        console.error('[SSE] EventSource failed:', error);
        // The browser will automatically try to reconnect on its own.
    };

    // Listen for our custom 'subscription-invalidated' event from the server.
    eventSource.addEventListener('subscription-invalidated', (event) => {
        console.warn('[SSE] Received "subscription-invalidated" event from server.');
        const data = JSON.parse(event.data);
        console.log('[SSE] Invalid subscription details:', data);

        // Show a non-error notification to the user that we are fixing things automatically.
        showNotification('Notification subscription expired. Re-subscribing automatically...', false, 5000);

        // Automatically trigger the re-subscription process. The `true` flag forces it to
        // first unsubscribe the bad subscription from the browser before creating a new one.
        subscribeUserToPush(true);
    });

    // NEW: Listen for real-time processing status updates
    eventSource.addEventListener('processing-status', (event) => {
        const data = JSON.parse(event.data);
        // This function will be created in ui.js to update the modal
        updateProcessingStatus(data.message, data.type);
    });

    // NEW: Listen for the 'force-logout' event
    eventSource.addEventListener('force-logout', (event) => {
        console.warn('[SSE] Received "force-logout" event from server.');
        const data = JSON.parse(event.data);
        showNotification(`Forced logout: ${data.reason}`, true, 5000);

        // Wait a moment for the user to see the notification, then reload the page.
        // This will trigger the auth check, which will fail, showing the login screen.
        setTimeout(() => {
            window.location.reload();
        }, 3000);
    });

    //-- ENHANCEMENT: Listen for real-time activity updates for the admin dashboard.
    eventSource.addEventListener('activity-update', (event) => {
        const data = JSON.parse(event.data);
        // This will only do something if the admin page is currently active.
        if (window.location.pathname.startsWith('/activity')) {
            handleActivityUpdate(data.live);
        }
    });

    //-- ENHANCEMENT: Listen for the remote channel change command.
    eventSource.addEventListener('change-channel', (event) => {
        console.log('[SSE] Received "change-channel" command from admin.');
        const { channel } = JSON.parse(event.data);

        // Check which player is active and change its channel
        const currentPage = window.location.pathname;
        if (currentPage.startsWith('/tvguide') || currentPage === '/') {
            // Stop the main player if it's open, then play the new channel.
            stopAndCleanupPlayer().then(() => {
                showNotification(`An administrator has changed your channel to: ${channel.name}`, false, 4000);
                playChannel(channel.url, channel.name, channel.id);
            });
        }
        // Note: For now, this doesn't affect Multi-View or the Direct Player page.
        // This could be extended in the future if needed.
    });

    // NEW: Listen for admin broadcast messages
    eventSource.addEventListener('broadcast-message', (event) => {
        console.log('[SSE] Received broadcast message from admin.');
        const data = JSON.parse(event.data);
        showBroadcastMessage(data.message);
    });
}


/**
 * Initializes the main application after successful authentication.
 */
export async function initMainApp() {
    console.log('[MAIN] Initializing main application...');
    // 1. Initialize IndexedDB for caching
    try {
        appState.db = await openDB();
        console.log('[MAIN] IndexedDB initialized successfully.');
    } catch (e) {
        console.error('[MAIN] Error initializing IndexedDB:', e);
        showNotification("Could not initialize local cache. Data may not persist.", true);
    }

    // 2. Setup all event listeners for the main app
    console.log('[MAIN] Setting up all event listeners...');
    setupCoreEventListeners();
    setupGuideEventListeners();
    setupPlayerEventListeners();
    setupSettingsEventListeners();
    setupDvrEventListeners();
    setupDirectPlayerEventListeners();
    setupAdminEventListeners(); // NEW: Setup admin event listeners
    // REMOVED: The direct call to initializeCastApi() is no longer needed here.
    // The cast.js module will now be initialized automatically by the Google Cast SDK callback.
    console.log('[MAIN] All event listeners set up.');

    // MODIFIED: Render all icons now that the DOM is ready.
    renderIcons();

    // 3. Load initial configuration and guide data
    try {
        console.log('[MAIN] Fetching initial configuration from server via api.js...');
        // REFACTORED: Use the centralized fetchConfig from api.js
        const config = await fetchConfig();
        if (!config) {
            throw new Error(`Could not load configuration from server. Check logs for details.`);
        }

        console.log('[MAIN] Configuration loaded:', config);
        Object.assign(guideState.settings, config.settings || {}); // Merge server settings into guideState

        // --- NEW: Load VOD data into state ---
        guideState.vodMovies = config.vodMovies || [];
        guideState.vodSeries = config.vodSeries || [];
        console.log(`[MAIN] Loaded ${guideState.vodMovies.length} movies and ${guideState.vodSeries.length} series episodes.`);

        // Restore UI dimensions from settings
        restoreDimensions();
        // Populate timezone selector and update other settings UI
        populateTimezoneSelector();
        updateUIFromSettings();

        // Show initial loading indicator for guide (if not already handled by auth.js)
        UIElements.initialLoadingIndicator.classList.remove('hidden');
        UIElements.guidePlaceholder.classList.remove('hidden');

        // FIX: Cache Validation Logic
        const serverTimestamp = config.settings.sourcesLastUpdated;
        const localTimestamp = await loadDataFromDB('sourcesLastUpdated');
        let useCache = false;

        if (serverTimestamp && localTimestamp && serverTimestamp === localTimestamp) {
            console.log('[MAIN_CACHE] Server and local timestamps match. Using local cache.');
            useCache = true;
        } else {
            console.log(`[MAIN_CACHE] Timestamps differ or are missing. Server: ${serverTimestamp}, Local: ${localTimestamp}. Fetching fresh data.`);
            useCache = false;
        }

        let loadedFromCache = false;
        if (useCache) {
            const cachedChannels = await loadDataFromDB('channels');
            const cachedPrograms = await loadDataFromDB('programs');
            if (cachedChannels?.length > 0 && cachedPrograms) {
                console.log('[MAIN] Loaded guide data from cache. Finalizing guide load.');
                guideState.channels = cachedChannels;
                guideState.programs = cachedPrograms;
                await finalizeGuideLoad(true); // true indicates first load
                loadedFromCache = true;
            }
        }

        // If we didn't use the cache or the cache was incomplete, load from server config.
        if (!loadedFromCache) {
            if (config.m3uContent) {
                console.log('[MAIN] Processing guide data from server config.');
                await handleGuideLoad(config.m3uContent, config.epgContent);
                // After successfully loading from server, update the local timestamp.
                await saveDataToDB('sourcesLastUpdated', serverTimestamp);
                console.log('[MAIN_CACHE] Updated local timestamp to match server.');
            } else {
                console.log('[MAIN] No M3U content from server or cache. Displaying no data message.');
                UIElements.initialLoadingIndicator.classList.add('hidden');
                UIElements.noDataMessage.classList.remove('hidden');
            }
        }

        // Load the list of scheduled notifications for the UI
        console.log('[MAIN] Loading and scheduling notifications...');
        await loadAndScheduleNotifications();

        // Subscribe to push notifications
        console.log('[MAIN] Attempting to subscribe to push notifications...');
        await subscribeUserToPush();
        console.log('[MAIN] Push notification subscription process initiated.');

        // MODIFICATION: If we have a notification target, navigate to it now that the guide is loaded.
        // Otherwise, handle the regular route change.
        if (notificationTarget) {
            console.log('[MAIN] App initialized. Executing deferred navigation to notification target.');
            await navigateToProgramInGuide(notificationTarget.channelId, notificationTarget.programStart, notificationTarget.programId);
            // Clean up to prevent re-triggering on refresh
            notificationTarget = null;
            // Clean the URL
            window.history.replaceState({}, document.title, window.location.pathname);
        } else {
            // Handle initial route based on URL
            console.log('[MAIN] Handling initial route change.');
            handleRouteChange();
        }

        // NEW: Connect to the server for real-time events like notification updates.
        initializeSse();
        console.log('[MAIN] Server-Sent Events listener initialized.');

    } catch (e) {
        console.error('[MAIN] Application initialization failed:', e);
        showNotification("Initialization failed: " + e.message, true);
        UIElements.initialLoadingIndicator.classList.add('hidden');
        UIElements.noDataMessage.classList.remove('hidden'); // Ensure no data message is shown
        switchTab('settings'); // Suggest going to settings to add sources
    }
}

/**
 * Opens and sets up the IndexedDB database.
 */
function openDB() {
    return new Promise((resolve, reject) => {
        const request = indexedDB.open('ViniPlayDB_v3', 1); // Increment version for schema changes
        request.onerror = (event) => {
            console.error('[IndexedDB] Error opening database:', event.target.errorCode);
            reject("Error opening IndexedDB.");
        };
        request.onsuccess = (event) => {
            const dbInstance = event.target.result;
            console.log('[IndexedDB] Database opened successfully.');
            resolve(dbInstance);
        };
        request.onupgradeneeded = (event) => {
            console.log('[IndexedDB] Database upgrade needed. Old version:', event.oldVersion, 'New version:', event.newVersion);
            const dbInstance = event.target.result;
            if (!dbInstance.objectStoreNames.contains('guideData')) {
                dbInstance.createObjectStore('guideData');
                console.log('[IndexedDB] Created "guideData" object store.');
            }
            // Add any future schema upgrades here
        };
    });
}

/**
 * Loads data from IndexedDB.
 */
async function loadDataFromDB(key) {
    if (!appState.db) {
        console.warn('[IndexedDB] Cannot load data: DB instance is null.');
        return null;
    }
    return new Promise((resolve, reject) => {
        try {
            const transaction = appState.db.transaction(['guideData'], 'readonly');
            const store = transaction.objectStore('guideData');
            const request = store.get(key);
            request.onsuccess = () => {
                if (request.result) {
                    console.log(`[IndexedDB] Data for key "${key}" loaded from cache.`);
                } else {
                    console.log(`[IndexedDB] No data found for key "${key}" in cache.`);
                }
                resolve(request.result);
            };
            request.onerror = (event) => {
                console.error(`[IndexedDB] Error loading data for key "${key}" from DB:`, event.target.error);
                reject("Error loading data from DB.");
            };
        } catch (e) {
            console.error(`[IndexedDB] Unexpected error during loadDataFromDB for key "${key}":`, e);
            reject(e);
        }
    });
}

// FIX: New function to save data to IndexedDB
async function saveDataToDB(key, value) {
    if (!appState.db) {
        console.warn('[IndexedDB] Cannot save data: DB instance is null.');
        return false;
    }
    return new Promise((resolve, reject) => {
        try {
            const transaction = appState.db.transaction(['guideData'], 'readwrite');
            const store = transaction.objectStore('guideData');
            const request = store.put(value, key);
            request.onsuccess = () => {
                console.log(`[IndexedDB] Data for key "${key}" saved successfully.`);
                resolve(true);
            };
            request.onerror = (event) => {
                console.error(`[IndexedDB] Error saving data for key "${key}" to DB:`, event.target.error);
                reject(false);
            };
        } catch (e) {
            console.error(`[IndexedDB] Unexpected error during saveDataToDB for key "${key}":`, e);
            reject(false);
        }
    });
}

/**
 * Restores the dimensions of resizable modals and the channel column from saved settings.
 */
function restoreDimensions() {
    console.log('[MAIN] Restoring UI dimensions from settings.');
    if (guideState.settings.playerDimensions && UIElements.videoModalContainer) {
        const { width, height } = guideState.settings.playerDimensions;
        if (width) UIElements.videoModalContainer.style.width = `${width}px`;
        if (height) UIElements.videoModalContainer.style.height = `${height}px`;
        console.log(`[MAIN] Restored player dimensions: ${width}x${height}`);
    }
    if (guideState.settings.programDetailsDimensions && UIElements.programDetailsContainer) {
        const { width, height } = guideState.settings.programDetailsDimensions;
        if (width) UIElements.programDetailsContainer.style.width = `${width}px`;
        if (height) UIElements.programDetailsContainer.style.height = `${height}px`;
        console.log(`[MAIN] Restored program details dimensions: ${width}x${height}`);
    }
    if (guideState.settings.channelColumnWidth && UIElements.guideGrid) {
        UIElements.guideGrid.style.setProperty('--channel-col-width', `${guideState.settings.channelColumnWidth}px`);
        console.log(`[MAIN] Restored channel column width: ${guideState.settings.channelColumnWidth}px`);
    } else if (UIElements.guideGrid) {
        // Set default if not in settings (or if it's the first run)
        const defaultChannelWidth = window.innerWidth < 768 ? 64 : 180;
        UIElements.guideGrid.style.setProperty('--channel-col-width', `${defaultChannelWidth}px`);
        console.log(`[MAIN] Set default channel column width: ${defaultChannelWidth}px`);
    }
}

/**
 * Sets up core application event listeners (navigation, modals, etc.).
 */
function setupCoreEventListeners() {
    console.log('[MAIN] Setting up core event listeners.');

    // --- Tab Navigation and Refresh Logic ---
    const setupTabListener = (tabElement, tabName, refreshFunction) => {
        if (!tabElement) return;
        tabElement.addEventListener('click', () => {
            if (tabElement.classList.contains('active')) {
                console.log(`[NAV] Refreshing ${tabName} tab data.`);
                if (refreshFunction) refreshFunction();
            } else {
                console.log(`[NAV] Switching to ${tabName} tab.`);
                switchTab(tabName);
            }
        });
    };

    // Desktop Tabs
    setupTabListener(UIElements.tabGuide, 'guide');
    setupTabListener(UIElements.tabMultiview, 'multiview', initMultiView);
    setupTabListener(UIElements.tabPlayer, 'player', initDirectPlayer);
    setupTabListener(UIElements.tabDvr, 'dvr', initDvrPage);
    setupTabListener(UIElements.tabVod, 'vod', initVodPage);
    setupTabListener(UIElements.tabActivity, 'activity', initActivityPage); // NEW
    setupTabListener(UIElements.tabNotifications, 'notifications', loadAndScheduleNotifications);
    setupTabListener(UIElements.tabSettings, 'settings');

    // Mobile Navigation
    UIElements.mobileMenuToggle?.addEventListener('click', openMobileMenu);
    UIElements.mobileMenuClose?.addEventListener('click', closeMobileMenu);
    UIElements.mobileMenuOverlay?.addEventListener('click', closeMobileMenu);

    UIElements.mobileNavGuide?.addEventListener('click', () => switchTab('guide'));
    UIElements.mobileNavMultiview?.addEventListener('click', () => switchTab('multiview'));
    UIElements.mobileNavPlayer?.addEventListener('click', () => switchTab('player'));
    UIElements.mobileNavDvr?.addEventListener('click', () => switchTab('dvr'));
    UIElements.mobileNavVod?.addEventListener('click', () => switchTab('vod'));
    UIElements.mobileNavActivity?.addEventListener('click', () => switchTab('activity')); // NEW
    UIElements.mobileNavNotifications?.addEventListener('click', () => switchTab('notifications'));
    UIElements.mobileNavSettings?.addEventListener('click', () => switchTab('settings'));

    UIElements.mobileNavLogoutBtn?.addEventListener('click', () => {
        const logoutButton = document.getElementById('logout-btn');
        if (logoutButton) logoutButton.click();
        closeMobileMenu();
    });

    // --- Browser and Document Listeners ---
    window.addEventListener('popstate', () => { console.log('[NAV] Popstate event (browser back/forward).'); handleRouteChange(); });

    // NEW: Refresh data when tab becomes visible again
    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') {
            console.log('[MAIN] Tab is visible again, refreshing data for current page.');
            const currentPage = window.location.pathname;
            if (currentPage.startsWith('/dvr')) {
                initDvrPage();
            } else if (currentPage.startsWith('/notifications')) {
                loadAndScheduleNotifications();
            } else if (currentPage.startsWith('/activity')) { // NEW
                initActivityPage();
            }
        }
    });

    // --- Modal Listeners ---
    UIElements.confirmCancelBtn?.addEventListener('click', () => closeModal(UIElements.confirmModal));
    UIElements.confirmOkBtn?.addEventListener('click', handleConfirm);
    UIElements.detailsCloseBtn?.addEventListener('click', () => closeModal(UIElements.programDetailsModal));

    //-- ENHANCEMENT: Centralized Channel Selector Modal Listeners with Context Switching
    UIElements.multiviewChannelFilter?.addEventListener('change', () => populateChannelSelector());
    UIElements.channelSelectorSearch?.addEventListener('input', () => {
        clearTimeout(appState.searchDebounceTimer);
        appState.searchDebounceTimer = setTimeout(() => populateChannelSelector(), 250);
    });

    UIElements.channelSelectorList?.addEventListener('click', (e) => {
        const channelItem = e.target.closest('.channel-item');
        if (!channelItem) return;

        // Use a data attribute on the body to determine which function to call
        const context = document.body.dataset.channelSelectorContext;
        console.log(`[CHANNEL_SELECTOR] Click handled with context: ${context}`);

        if (context === 'dvr') {
            handleDvrChannelClick(channelItem);
        } else if (context === 'admin') {
            handleAdminChannelClick(channelItem);
        } else { // Default to multiview
            handleMultiViewChannelClick(channelItem);
        }

        // Clean up the context after use
        delete document.body.dataset.channelSelectorContext;
        closeModal(UIElements.multiviewChannelSelectorModal);
    });

    UIElements.channelSelectorCancelBtn?.addEventListener('click', () => {
        delete document.body.dataset.channelSelectorContext;
        closeModal(UIElements.multiviewChannelSelectorModal);
    });

    // --- Resizable Elements ---
    // --- Resizable Elements ---
    if (UIElements.videoResizeHandle && UIElements.videoModalContainer) {
        makeModalResizable(UIElements.videoResizeHandle, UIElements.videoModalContainer, 400, 300, 'playerDimensions', (newWidth) => {
            const isLocked = shouldMaintainAspectRatio();

            if (isLocked && UIElements.videoElement && UIElements.videoElement.videoWidth && UIElements.videoElement.videoHeight) {
                const videoRatio = UIElements.videoElement.videoWidth / UIElements.videoElement.videoHeight;

                if (!isFinite(videoRatio) || videoRatio === 0) return null;

                // Calculate header height to add to the total height
                const header = UIElements.videoModalContainer.querySelector('.flex.justify-between');
                const headerHeight = header ? header.offsetHeight : 0;

                // Calculate target height: (width / ratio) + headerHeight
                return (newWidth / videoRatio) + headerHeight;
            }
            return null;
        });
    }
    if (UIElements.detailsResizeHandle && UIElements.programDetailsContainer) {
        makeModalResizable(UIElements.detailsResizeHandle, UIElements.programDetailsContainer, 320, 250, 'programDetailsDimensions');
    }
    if (UIElements.channelColumnResizeHandle && UIElements.guideGrid && window.innerWidth >= 768) {
        makeColumnResizable(UIElements.channelColumnResizeHandle, UIElements.guideGrid, 100, 'channelColumnWidth', '--channel-col-width');
    }

    // --- Header Resize Observer ---
    if (UIElements.mainHeader && UIElements.unifiedGuideHeader) {
        const mainHeaderObserver = new ResizeObserver(entries => {
            for (let entry of entries) {
                if (entry.target === UIElements.mainHeader) {
                    document.documentElement.style.setProperty('--main-header-height', `${entry.contentRect.height}px`);
                }
            }
        });
        mainHeaderObserver.observe(UIElements.mainHeader);
    }

    // monitor the processes of channel sources
    document.addEventListener('background-process-finished', () => {
        console.log('[MAIN] Detected background process has finished.');
        showConfirm(
            'Sources Processed',
            'Your sources have finished processing in the background. Would you like to update the TV Guide now?',
            refreshGuideAfterProcessing // The callback function to execute on confirm
        );
    });
}


// --- App Start ---
document.addEventListener('DOMContentLoaded', () => {
    // NEW: Check for notification deep link parameters on initial load.
    const urlParams = new URLSearchParams(window.location.search);
    const channelId = urlParams.get('channelId');
    const programId = urlParams.get('programId');
    const programStart = urlParams.get('programStart');

    if (channelId && programId && programStart) {
        console.log('[MAIN] Notification deep link detected. Storing target:', { channelId, programId, programStart });
        notificationTarget = { channelId, programId, programStart };
    }

    // Register Service Worker
    if ('serviceWorker' in navigator && 'PushManager' in window) {
        console.log('[APP_START] Service Worker and Push API are supported by browser.');
        navigator.serviceWorker.register('/sw.js')
            .then(swReg => {
                console.log('[APP_START] Service Worker registered successfully:', swReg);
                appState.swRegistration = swReg;
                // The following function is now INSIDE the .then() block
                // This ensures it only runs after the service worker is ready.
                return subscribeUserToPush();
            })
            .then(() => {
                console.log('[MAIN] Push notification subscription process initiated after SW registration.');
            })
            .catch(error => {
                console.error('[APP_START] Service Worker registration or Push Subscription failed:', error);
                showNotification('Failed to set up notifications.', true);
            });
    } else {
        console.warn('[APP_START] Push messaging is not supported in this browser environment.');
        showNotification('Push notifications are not supported by your browser.', false, 5000);
    }

    console.log('[APP_START] Setting up authentication event listeners...');
    setupAuthEventListeners();
    console.log('[APP_START] Checking authentication status...');
    checkAuthStatus(); // This initiates the main app flow
});
