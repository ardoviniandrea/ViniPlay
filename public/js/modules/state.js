/**
 * state.js
 * * Manages the shared state of the application.
 * This includes global app status, guide data, and cached UI elements.
 */

// Global state for the application's status
export const appState = {
    currentUser: null, // { username, isAdmin }
    appInitialized: false,
    player: null, // mpegts.js player instance
    searchDebounceTimer: null,
    confirmCallback: null,
    db: null, // IndexedDB instance
    fuseChannels: null, // Fuse.js instance for channels
    fusePrograms: null, // Fuse.js instance for programs
    currentSourceTypeForEditor: 'url',
    swRegistration: null, // To hold the service worker registration
    isNavigating: false, // NEW: Flag to prevent race conditions during navigation
};

// State specific to the TV Guide
export const guideState = {
    channels: [],
    programs: {},
    vodMovies: [],
    vodSeries: [],
    settings: {
        // Add a default for channelColumnWidth
        channelColumnWidth: window.innerWidth < 768 ? 64 : 180, // Default based on screen size
        notificationLeadTime: 10, // Default notification lead time in minutes
        multiviewLayouts: [], // To store saved layouts for the user
        adminPageSize: 25, // NEW: Default page size for the admin history table
        vodDirectPlayEnabled: false, // Default to false (use mpegts.js/profiles)
    }, // This will hold both GLOBAL and USER settings, merged.
    guideDurationHours: 48,
    hourWidthPixels: window.innerWidth < 768 ? 200 : 300,
    currentDate: new Date(),
    channelGroups: new Set(),
    channelSources: new Set(), // For the source filter
    visibleChannels: [],
    scrollHandler: null, // Holds the reference to the throttled scroll handler for virtualization
    userNotifications: [], // Stores active program notifications for the current user
};

// State specific to the DVR
export const dvrState = {
    scheduledJobs: [],
    completedRecordings: [],
};

// NEW: State specific to the Admin Activity page
export const adminState = {
    live: [],
    history: [],
    liveDurationInterval: null,
    channelSelectorCallback: null,
    pagination: {
        currentPage: 1,
        pageSize: 25,
        totalPages: 1,
        totalItems: 0,
    },
    healthCheckInterval: null
};


// A cache for frequently accessed DOM elements
// This will be populated by the auth.js module after the main app is visible.
export const UIElements = {
    // --- **FIX: Add the new element for notification settings** ---
    notificationSettings: document.getElementById('notification-settings-container'),

    // --- NEW: Header Elements for Scroll Logic ---
    mainHeader: document.getElementById('main-header'),
    unifiedGuideHeader: document.getElementById('unified-guide-header'),

    // --- NEW: VOD Page Elements ---
    tabVod: null,
    mobileNavVod: null,
    pageVod: null,
    vodFilterBar: null,
    vodTypeAll: null,
    vodTypeMovies: null,
    vodTypeSeries: null,
    vodGroupFilter: null,
    vodSearchInput: null,
    vodGridContainer: null,
    vodNoResults: null,
    vodGrid: null,
    vodDirectPlayCheckbox: null,

    // --- NEW: VOD Details Modal ---
    vodDetailsModal: null,
    vodDetailsContainer: null,
    vodDetailsCloseBtn: null,
    vodDetailsBackdrop: null,
    vodDetailsBackdropImg: null,
    vodDetailsContent: null,
    vodDetailsPoster: null,
    vodDetailsTitle: null,
    vodDetailsMeta: null,
    vodDetailsYear: null,
    vodDetailsRating: null,
    vodDetailsType: null,
    vodDetailsDuration: null,
    vodDetailsGenre: null,
    vodDetailsDirector: null,
    vodDetailsCast: null,
    vodDetailsDesc: null,
    vodDetailsMovieActions: null,
    vodPlayMovieBtn: null,
    vodDetailsSeriesActions: null,
    vodSeasonSelect: null,
    vodEpisodeList: null,

    // --- NEW: Group Filter Modal ---
    groupFilterModal: null,
    groupFilterCloseBtn: null,
    groupFilterTabLive: null,
    groupFilterTabMovies: null,
    groupFilterTabSeries: null,
    groupFilterSelectAll: null,
    groupFilterDeselectAll: null,
    groupFilterSearch: null,
    groupFilterList: null,
    groupFilterCancelBtn: null,
    groupFilterSaveBtn: null,

    // --- NEW: Log Management Elements ---
    logFileCount: null,
    logTotalSize: null,
    logOldestDate: null,
    logMaxFilesInput: null,
    logMaxSizeInput: null,
    logAutoDeleteDaysInput: null,
    downloadLogsBtn: null,
    clearLogsBtn: null,
};
