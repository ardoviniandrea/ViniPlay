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
    hlsPlayer: null, // Hls.js player instance for timeshift/DVR
    activeTimeshiftJobId: null, // Currently active timeshift job ID
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
        vodDirectPlayEnabled: true, // Default to true (native <video> playback with full seeking)
        // Default timezone offset based on browser's timezone (will be overridden by server settings)
        timezoneOffset: Math.round(-(new Date().getTimezoneOffset() / 60)),
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

    // --- Video Player Elements ---
    videoModal: null,
    videoModalContainer: null,
    videoResizeHandle: null,
    videoElement: null,
    audioElement: null,
    videoTitle: null,
    closeModalBtn: null,


    // --- Timeshift Controls Overlay Elements ---
    timeshiftControlsOverlay: null,
    timeshiftProgressBar: null,
    timeshiftCurrentTime: null,
    timeshiftTotalTime: null,
    timeshiftLiveEdgeBtn: null,
    timeshiftLiveDot: null,
    timeshiftPlayPauseBtn: null,
    timeshiftRewind15Btn: null,
    timeshiftForward15Btn: null,
    timeshiftStatusText: null,

    // --- Program Details Modal Elements ---
    programDetailsContainer: null,
    detailsResizeHandle: null,

    // --- DVR Page Elements ---
    pageDvr: null,
    tabDvr: null,
    mobileNavDvr: null,
    dvrStoragePercentBadge: null,
    dvrStorageText: null,
    dvrStorageBar: null,

    // Live Hero Banner
    dvrLiveHeroBanner: null,
    dvrLiveStatusBadge: null,
    dvrLiveChannelBadge: null,
    dvrLiveTitle: null,
    dvrLiveWindow: null,
    dvrLiveCountdown: null,
    dvrLiveProgressBar: null,
    dvrLiveElapsedText: null,
    dvrLiveTimeshiftBtn: null,
    dvrLiveStopBtn: null,

    // Tabs & Toolbar
    dvrTabBtnRecordings: null,
    dvrTabBtnScheduled: null,
    dvrTabBtnHistory: null,
    dvrRecordingsCount: null,
    dvrScheduledCount: null,
    dvrRecordingsContent: null,
    dvrScheduledContent: null,
    dvrHistoryContent: null,
    dvrSearchInput: null,
    dvrViewSwitcher: null,
    dvrViewTableBtn: null,
    dvrViewCardsBtn: null,
    dvrToggleManualBtn: null,
    closeManualRecBtn: null,

    manualRecordingSection: null,
    scheduledRecordingsSection: null,
    dvrJobsTbody: null,
    noDvrJobsMessage: null,
    dvrRecordingsTbody: null,
    dvrRecordingsCardsContainer: null,
    noDvrRecordingsMessage: null,
    dvrJobsTableContainer: null,
    dvrRecordingsTableContainer: null,
    dvrHistoryTbody: null,
    noDvrHistoryMessage: null,
    dvrHistoryTableContainer: null,
    clearHistoryDvrBtn: null,

    dvrErrorModal: null,
    dvrErrorModalTitle: null,
    dvrErrorModalContent: null,
    dvrErrorModalCloseBtn: null,
    clearScheduledDvrBtn: null,
    clearCompletedDvrBtn: null,

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
    vodSeasonTabs: null,
    vodEpisodesCountBadge: null,
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

    // --- Resume Playback Modal Elements ---
    resumePlaybackModal: null,
    resumePlaybackTitle: null,
    resumePlaybackMessage: null,
    resumePlaybackConfirmBtn: null,
    resumePlaybackConfirmLabel: null,
    resumePlaybackRestartBtn: null,
    resumePlaybackCloseBtn: null,

    logMaxFilesInput: null,
    logMaxSizeInput: null,
    logAutoDeleteDaysInput: null,
    downloadLogsBtn: null,
    clearLogsBtn: null,

    // --- NEW: User Editor Elements ---
    userEditorSourceList: null,
};
