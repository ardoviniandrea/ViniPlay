/**
 * auth.js
 * * Handles user authentication, including login, logout, and initial setup.
 */

import { UIElements, appState } from './state.js';
import { initMainApp } from '../main.js';
import { showNotification } from './ui.js'; // Import showNotification for consistent error display

/**
 * Populates the UIElements object with references to DOM elements.
 * This is now called from showApp() to ensure the main container is visible.
 */
const initializeUIElements = () => {
    // Populate UIElements by querying all elements with an 'id' attribute
    // and converting their kebab-case IDs to camelCase keys.
    Object.assign(UIElements, Object.fromEntries(
        [...document.querySelectorAll('[id]')].map(el => [
            el.id.replace(/-(\w)/g, (match, letter) => letter.toUpperCase()),
            el
        ])
    ));

    // Add specific references that might not be picked up by generic ID mapping
    // or are critical and need direct assignment for clarity.
    UIElements.appContainer = document.getElementById('app-container');
    UIElements.mainHeader = document.getElementById('main-header');
    UIElements.unifiedGuideHeader = document.getElementById('unified-guide-header');
    UIElements.pageGuide = document.getElementById('page-guide');
    UIElements.guideDateDisplay = document.getElementById('guide-date-display');
    UIElements.stickyCorner = document.querySelector('.sticky-corner');
    UIElements.channelColumnResizeHandle = document.getElementById('channel-column-resize-handle');
    UIElements.userDisplay = document.getElementById('user-display');
    UIElements.userManagementSection = document.getElementById('user-management-section');
    // NOTE: dvrSettingsSection is the entire settings div, not a separate element. Logic will handle visibility.


    // Program Details Modal and its Buttons
    UIElements.programDetailsModal = document.getElementById('program-details-modal');
    UIElements.programDetailsNotifyBtn = document.getElementById('program-details-notify-btn');
    UIElements.programDetailsRecordBtn = document.getElementById('details-record-btn');

    // Mobile menu elements
    UIElements.mobileMenuToggle = document.getElementById('mobile-menu-toggle');
    UIElements.mobileNavMenu = document.getElementById('mobile-nav-menu');
    UIElements.mobileMenuClose = document.getElementById('mobile-menu-close');
    UIElements.mobileNavGuide = document.getElementById('mobile-nav-guide');
    UIElements.mobileNavSettings = document.getElementById('mobile-nav-settings');
    UIElements.mobileNavLogoutBtn = document.getElementById('mobile-nav-logout-btn');
    UIElements.mobileMenuOverlay = document.getElementById('mobile-menu-overlay');

    // Notification Tab/Page Elements
    UIElements.tabNotifications = document.getElementById('tab-notifications'); // Desktop Nav
    UIElements.mobileNavNotifications = document.getElementById('mobile-nav-notifications'); // Mobile Nav
    UIElements.pageNotifications = document.getElementById('page-notifications');
    UIElements.notificationsList = document.getElementById('notifications-list');
    UIElements.noNotificationsMessage = document.getElementById('no-notifications-message');
    UIElements.notificationLeadTimeInput = document.getElementById('notification-lead-time-input');
    UIElements.pastNotificationsList = document.getElementById('past-notifications-list');
    UIElements.noPastNotificationsMessage = document.getElementById('no-past-notifications-message');
    UIElements.notificationModal = document.getElementById('notification-modal-wrapper');
    UIElements.notificationBox = document.getElementById('notification-box');
    UIElements.notificationMessage = document.getElementById('notification-message');


    // Multi-View Elements
    UIElements.pageMultiview = document.getElementById('page-multiview');
    UIElements.tabMultiview = document.getElementById('tab-multiview');
    UIElements.mobileNavMultiview = document.getElementById('mobile-nav-multiview');
    UIElements.multiviewHeader = document.getElementById('multiview-header');
    UIElements.multiviewContainer = document.getElementById('multiview-container');
    UIElements.multiviewAddPlayer = document.getElementById('multiview-add-player');
    UIElements.multiviewRemovePlayer = document.getElementById('multiview-remove-player');
    UIElements.layoutBtnAuto = document.getElementById('layout-btn-auto');
    UIElements.layoutBtn2x2 = document.getElementById('layout-btn-2x2');
    UIElements.layoutBtn1x3 = document.getElementById('layout-btn-1x3');
    UIElements.multiviewChannelSelectorModal = document.getElementById('multiview-channel-selector-modal');
    UIElements.channelSelectorList = document.getElementById('channel-selector-list');
    UIElements.channelSelectorSearch = document.getElementById('channel-selector-search');
    UIElements.channelSelectorCancelBtn = document.getElementById('channel-selector-cancel-btn');
    UIElements.multiviewSaveLayoutBtn = document.getElementById('multiview-save-layout-btn');
    UIElements.multiviewLoadLayoutBtn = document.getElementById('multiview-load-layout-btn');
    UIElements.multiviewDeleteLayoutBtn = document.getElementById('multiview-delete-layout-btn');
    UIElements.savedLayoutsSelect = document.getElementById('saved-layouts-select');
    UIElements.saveLayoutModal = document.getElementById('save-layout-modal');
    UIElements.saveLayoutForm = document.getElementById('save-layout-form');
    UIElements.saveLayoutName = document.getElementById('save-layout-name');
    UIElements.saveLayoutCancelBtn = document.getElementById('save-layout-cancel-btn');
    UIElements.multiviewChannelFilter = document.getElementById('multiview-channel-filter');

    // NEW: Player Page Elements
    UIElements.pagePlayer = document.getElementById('page-player');
    UIElements.tabPlayer = document.getElementById('tab-player');
    UIElements.mobileNavPlayer = document.getElementById('mobile-nav-player');
    UIElements.directPlayerForm = document.getElementById('direct-player-form');
    UIElements.directStreamUrl = document.getElementById('direct-stream-url');
    UIElements.directPlayBtn = document.getElementById('direct-play-btn');
    UIElements.directPlayerContainer = document.getElementById('direct-player-container');
    UIElements.directVideoElement = document.getElementById('direct-video-element');
    
    // DVR Elements
    UIElements.pageDvr = document.getElementById('page-dvr');
    UIElements.tabDvr = document.getElementById('tab-dvr');
    UIElements.mobileNavDvr = document.getElementById('mobile-nav-dvr');
    UIElements.dvrJobsTbody = document.getElementById('dvr-jobs-tbody');
    UIElements.noDvrJobsMessage = document.getElementById('no-dvr-jobs-message');
    UIElements.dvrRecordingsTbody = document.getElementById('dvr-recordings-tbody');
    UIElements.noDvrRecordingsMessage = document.getElementById('no-dvr-recordings-message');
    UIElements.recordingPlayerModal = document.getElementById('recording-player-modal');
    UIElements.recordingVideoElement = document.getElementById('recording-video-element');
    UIElements.recordingTitle = document.getElementById('recording-title');
    UIElements.closeRecordingPlayerBtn = document.getElementById('close-recording-player-btn');
    UIElements.dvrPreBufferInput = document.getElementById('dvr-pre-buffer-input');
    UIElements.dvrPostBufferInput = document.getElementById('dvr-post-buffer-input');
    UIElements.addDvrProfileBtn = document.getElementById('add-dvr-profile-btn');
    UIElements.editDvrProfileBtn = document.getElementById('edit-dvr-profile-btn');
    UIElements.deleteDvrProfileBtn = document.getElementById('delete-dvr-profile-btn');
    UIElements.dvrRecordingProfileSelect = document.getElementById('dvr-recording-profile-select');
    // FIX: Add explicit references for the clear all buttons
    UIElements.clearScheduledDvrBtn = document.getElementById('clear-scheduled-dvr-btn');
    UIElements.clearCompletedDvrBtn = document.getElementById('clear-completed-dvr-btn');
    // UX IMPROVEMENT: Add references for profile containers
    UIElements.streamProfileContainer = document.getElementById('stream-profile-container');
    UIElements.dvrProfileContainer = document.getElementById('dvr-profile-container');

    // NEW: Admin Activity Page Elements
    UIElements.pageActivity = document.getElementById('page-activity');
    UIElements.tabActivity = document.getElementById('tab-activity');
    UIElements.mobileNavActivity = document.getElementById('mobile-nav-activity');
    UIElements.liveActivityTbody = document.getElementById('live-activity-tbody');
    UIElements.watchHistoryTbody = document.getElementById('watch-history-tbody');
    UIElements.noLiveActivityMessage = document.getElementById('no-live-activity-message');
    UIElements.noWatchHistoryMessage = document.getElementById('no-watch-history-message');
    UIElements.liveActivityTableContainer = document.getElementById('live-activity-table-container');
    UIElements.watchHistoryTableContainer = document.getElementById('watch-history-table-container');
    UIElements.refreshActivityBtn = document.getElementById('refresh-activity-btn');
    UIElements.historySearchInput = document.getElementById('history-search-input');

    // --- NEW: VOD Elements (Page & Details Modal) ---
    UIElements.tabVod = document.getElementById('tab-vod');
    UIElements.mobileNavVod = document.getElementById('mobile-nav-vod');
    UIElements.pageVod = document.getElementById('page-vod');
    UIElements.vodFilterBar = document.getElementById('vod-filter-bar');
    UIElements.vodTypeAll = document.getElementById('vod-type-all');
    UIElements.vodTypeMovies = document.getElementById('vod-type-movies');
    UIElements.vodTypeSeries = document.getElementById('vod-type-series');
    UIElements.vodGroupFilter = document.getElementById('vod-group-filter');
    UIElements.vodSearchInput = document.getElementById('vod-search-input');
    UIElements.vodGridContainer = document.getElementById('vod-grid-container');
    UIElements.vodNoResults = document.getElementById('vod-no-results');
    UIElements.vodGrid = document.getElementById('vod-grid');
    UIElements.vodDetailsModal = document.getElementById('vod-details-modal');
    UIElements.vodDetailsContainer = document.getElementById('vod-details-container');
    UIElements.vodDetailsCloseBtn = document.getElementById('vod-details-close-btn');
    UIElements.vodDetailsBackdrop = document.getElementById('vod-details-backdrop');
    UIElements.vodDetailsBackdropImg = document.getElementById('vod-details-backdrop-img');
    UIElements.vodDetailsContent = document.getElementById('vod-details-content');
    UIElements.vodDetailsPoster = document.getElementById('vod-details-poster');
    UIElements.vodDetailsTitle = document.getElementById('vod-details-title');
    UIElements.vodDetailsMeta = document.getElementById('vod-details-meta');
    UIElements.vodDetailsYear = document.getElementById('vod-details-year');
    UIElements.vodDetailsRating = document.getElementById('vod-details-rating');
    UIElements.vodDetailsType = document.getElementById('vod-details-type');
    UIElements.vodDetailsDuration = document.getElementById('vod-details-duration');
    UIElements.vodDetailsGenre = document.getElementById('vod-details-genre');
    UIElements.vodDetailsDirector = document.getElementById('vod-details-director');
    UIElements.vodDetailsCast = document.getElementById('vod-details-cast');
    UIElements.vodDetailsDesc = document.getElementById('vod-details-desc');
    UIElements.vodDetailsMovieActions = document.getElementById('vod-details-movie-actions');
    UIElements.vodPlayMovieBtn = document.getElementById('vod-play-movie-btn');
    UIElements.vodDetailsSeriesActions = document.getElementById('vod-details-series-actions');
    UIElements.vodSeasonSelect = document.getElementById('vod-season-select');
    UIElements.vodEpisodeList = document.getElementById('vod-episode-list');
    // --- END VOD Elements ---

    // --- FIX: Add missing VOD Pagination Elements ---
    UIElements.vodPaginationControls = document.getElementById('vod-pagination-controls');
    UIElements.vodPaginationInfo = document.getElementById('vod-pagination-info');
    UIElements.vodPrevBtn = document.getElementById('vod-prev-btn');
    UIElements.vodNextBtn = document.getElementById('vod-next-btn');
    UIElements.vodPageSize = document.getElementById('vod-page-size'); // Added page size selector
    // --- END FIX ---

    // Settings Buttons
    UIElements.addM3uBtn = document.getElementById('add-m3u-btn');
    UIElements.addEpgBtn = document.getElementById('add-epg-btn');
    UIElements.processSourcesBtnContent = document.getElementById('process-sources-btn-content');
    UIElements.processSourcesBtn = document.getElementById('process-sources-btn');
    // NEW: Processing Modal Buttons
    UIElements.processingStatusRunningActions = document.getElementById('processing-status-running-actions');
    UIElements.processingStatusFinishedActions = document.getElementById('processing-status-finished-actions');
    UIElements.processingStatusBackgroundBtn = document.getElementById('processing-status-background-btn');
    UIElements.processingStatusCloseRefreshBtn = document.getElementById('processing-status-close-refresh-btn');

    // --- NEW: Group Filter Modal Elements ---
    UIElements.groupFilterModal = document.getElementById('group-filter-modal');
    UIElements.groupFilterCloseBtn = document.getElementById('group-filter-close-btn');
    UIElements.groupFilterTabLive = document.getElementById('group-filter-tab-live');
    UIElements.groupFilterTabMovies = document.getElementById('group-filter-tab-movies');
    UIElements.groupFilterTabSeries = document.getElementById('group-filter-tab-series');
    UIElements.groupFilterSelectAll = document.getElementById('group-filter-select-all');
    UIElements.groupFilterDeselectAll = document.getElementById('group-filter-deselect-all');
    UIElements.groupFilterSearch = document.getElementById('group-filter-search');
    UIElements.groupFilterList = document.getElementById('group-filter-list');
    UIElements.groupFilterCancelBtn = document.getElementById('group-filter-cancel-btn');
    UIElements.groupFilterSaveBtn = document.getElementById('group-filter-save-btn');
    // --- END Group Filter Elements ---
    
};


/**
 * Shows the login form.
 * @param {string|null} errorMsg - An optional error message to display.
 */
export const showLoginScreen = (errorMsg = null) => {
    // This is called before the main app is visible, so we only need to find the auth elements here.
    const authContainer = document.getElementById('auth-container');
    const appContainer = document.getElementById('app-container');
    const loginForm = document.getElementById('login-form');
    const setupForm = document.getElementById('setup-form');
    const authLoader = document.getElementById('auth-loader');
    const loginError = document.getElementById('login-error');

    console.log('[AUTH_UI] Displaying login screen.');
    authContainer.classList.remove('hidden');
    appContainer.classList.add('hidden');
    loginForm.classList.remove('hidden');
    setupForm.classList.add('hidden');
    authLoader.classList.add('hidden'); // Hide loader
    if (errorMsg) {
        loginError.textContent = errorMsg;
        loginError.classList.remove('hidden');
        console.error(`[AUTH_UI] Login error displayed: ${errorMsg}`);
    } else {
        loginError.classList.add('hidden'); // Ensure error is hidden if no message
    }
};

/**
 * Shows the initial admin setup form.
 */
const showSetupScreen = () => {
    const authContainer = document.getElementById('auth-container');
    const appContainer = document.getElementById('app-container');
    const loginForm = document.getElementById('login-form');
    const setupForm = document.getElementById('setup-form');
    const authLoader = document.getElementById('auth-loader');
    const setupError = document.getElementById('setup-error');
    
    console.log('[AUTH_UI] Displaying setup screen.');
    authContainer.classList.remove('hidden');
    appContainer.classList.add('hidden');
    loginForm.classList.add('hidden');
    setupForm.classList.remove('hidden');
    authLoader.classList.add('hidden'); // Hide loader
    setupError.classList.add('hidden'); // Clear previous setup errors
};

/**
 * Shows the main application container and hides the auth screen.
 * @param {object} user - The user object { username, isAdmin, canUseDvr }.
 */
const showApp = (user) => {
    appState.currentUser = user;

    const authContainer = document.getElementById('auth-container');
    const appContainer = document.getElementById('app-container');

    authContainer.classList.add('hidden');
    appContainer.classList.remove('hidden');
    appContainer.classList.add('flex'); // Ensure flex display for app layout

    // --- CORRECTED POSITION ---
    // This line MUST be here, before the 'if' block below
    initializeUIElements(); // Ensure UI elements are found BEFORE initializing the main app
    console.log('[AUTH_UI] UI Elements initialized.');
    // --- END CORRECTED POSITION ---

    console.log(`[AUTH_UI] Displaying main app for user: ${user.username} (Admin: ${user.isAdmin}, DVR: ${user.canUseDvr})`);

    // Visibility toggling is handled by proceedWithRouteChange

    UIElements.userDisplay.textContent = user.username;
    UIElements.userDisplay.classList.remove('hidden');

    console.log(`[AUTH_UI] User display set to: ${user.username}.`);

    // The 'if' block now runs AFTER initializeUIElements()
    if (!appState.appInitialized) {
        console.log('[AUTH_UI] Main app not initialized yet, calling initMainApp().');
        initMainApp(); // initMainApp triggers the first route change
        appState.appInitialized = true;
    } else {
        console.log('[AUTH_UI] Main app already initialized.');
    }
};

/**
 * Checks the user's authentication status with the server.
 * Determines whether to show the login, setup, or main app screen.
 */
export async function checkAuthStatus() {
    console.log('[AUTH] Starting authentication status check...');
    // We only need a few elements for the initial check
    const authLoader = document.getElementById('auth-loader');
    const loginError = document.getElementById('login-error');
    authLoader.classList.remove('hidden'); // Show loader
    loginError.classList.add('hidden'); // Clear any previous errors

    try {
        const res = await fetch('/api/auth/status');
        if (!res.ok) {
            console.warn(`[AUTH] /api/auth/status returned non-OK status: ${res.status} ${res.statusText}`);
        }
        const status = await res.json();
        console.log('[AUTH] /api/auth/status response:', status);

        if (status.isLoggedIn) {
            console.log('[AUTH] User is logged in. Showing app.');
            showApp(status.user);
        } else {
            console.log('[AUTH] User not logged in. Checking if setup is needed...');
            const setupRes = await fetch('/api/auth/needs-setup');
            if (!setupRes.ok) {
                 console.warn(`[AUTH] /api/auth/needs-setup returned non-OK status: ${setupRes.status} ${setupRes.statusText}`);
            }
            const setup = await setupRes.json();
            console.log('[AUTH] /api/auth/needs-setup response:', setup);
            if (setup.needsSetup) {
                console.log('[AUTH] App needs initial admin setup. Showing setup screen.');
                showSetupScreen();
            } else {
                console.log('[AUTH] App does not need setup. Showing login screen.');
                showLoginScreen();
            }
        }
    } catch (e) {
        console.error("[AUTH] Authentication check failed:", e);
        showLoginScreen("Could not verify authentication status. Please check server connection.");
        showNotification("Failed to connect to authentication server.", true);
    } finally {
        authLoader.classList.add('hidden'); // Always hide loader at the end
    }
}

/**
 * Sets up event listeners for the authentication forms (login, setup, logout).
 */
export function setupAuthEventListeners() {
    console.log('[AUTH] Setting up authentication event listeners.');
    // These elements are always present from the start, so it's safe to get them here.
    const loginForm = document.getElementById('login-form');
    const loginUsername = document.getElementById('login-username');
    const loginPassword = document.getElementById('login-password');
    const loginError = document.getElementById('login-error');
    const setupForm = document.getElementById('setup-form');
    const setupUsername = document.getElementById('setup-username');
    const setupPassword = document.getElementById('setup-password');
    const setupError = document.getElementById('setup-error');
    const logoutBtn = document.getElementById('logout-btn');


    loginForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        console.log('[AUTH_EVENT] Login form submitted.');
        loginError.classList.add('hidden');
        const username = loginUsername.value;
        const password = loginPassword.value;

        try {
            const res = await fetch('/api/auth/login', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ username, password })
            });
            const data = await res.json();
            console.log('[AUTH_EVENT] Login API response:', data);

            if (res.ok) {
                console.log('[AUTH_EVENT] Login successful.');
                showApp(data.user);
            } else {
                console.warn(`[AUTH_EVENT] Login failed: ${data.error}`);
                loginError.textContent = data.error;
                loginError.classList.remove('hidden');
            }
        } catch (error) {
            console.error('[AUTH_EVENT] Login fetch error:', error);
            loginError.textContent = "Failed to connect to server for login.";
            loginError.classList.remove('hidden');
        }
    });

    setupForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        console.log('[AUTH_EVENT] Setup form submitted.');
        setupError.classList.add('hidden');
        const username = setupUsername.value;
        const password = setupPassword.value;

        try {
            const res = await fetch('/api/auth/setup-admin', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ username, password })
            });
            const data = await res.json();
            console.log('[AUTH_EVENT] Setup API response:', data);

            if (res.ok) {
                console.log('[AUTH_EVENT] Admin setup successful.');
                showApp(data.user);
            } else {
                console.warn(`[AUTH_EVENT] Admin setup failed: ${data.error}`);
                setupError.textContent = data.error;
                setupError.classList.remove('hidden');
            }
        } catch (error) {
            console.error('[AUTH_EVENT] Setup fetch error:', error);
            setupError.textContent = "Failed to connect to server for setup.";
            setupError.classList.remove('hidden');
        }
    });

    logoutBtn.addEventListener('click', async () => {
        console.log('[AUTH_EVENT] Logout button clicked.');
        try {
            const res = await fetch('/api/auth/logout', { method: 'POST' });
            if (!res.ok) {
                console.warn(`[AUTH_EVENT] Logout API returned non-OK status: ${res.status}`);
            }
            console.log('[AUTH_EVENT] Logout request sent. Reloading window.');
            window.location.reload(); // Full reload to clear client state
        } catch (error) {
            console.error('[AUTH_EVENT] Logout fetch error:', error);
            showNotification("Failed to log out. Please try again.", true);
        }
    });
}

