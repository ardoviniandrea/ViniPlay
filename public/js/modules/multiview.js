/**
 * multiview.js
 * Manages all functionality for the Multi-View page.
 * Uses Gridstack.js (12 columns x 24 dynamic viewport rows) for responsive auto-layouts and freeform resizing.
 */

import { appState, guideState, UIElements } from './state.js';
import { apiFetch, stopStream, startRedirectStream, stopRedirectStream, sendRedirectHeartbeat } from './api.js';
import { showNotification, openModal, closeModal, showConfirm } from './ui.js';
import { ICONS } from './icons.js';
import { proxiedImageUrl } from './utils.js';

let grid;
const players = new Map();
const playerUrls = new Map();
const playerChannelMeta = new Map();
let activePlayerId = null;
let channelSelectorCallback = null;
let lastLayoutBeforeHide = null; // Stores layout when browser tab is hidden
let immersiveHeaderTimeout = null;

function syncMultiviewActiveStreamToNative() {}

const MAX_PLAYERS = 9;
const GRID_COLS = 12;
const GRID_ROWS = 24;
const GRID_MARGIN = 4;

let currentLayoutMode = 'auto'; // 'auto' | '2x2' | '1x3' | 'freeform'
let pinHeaders = false;
let isDrawerOpen = false;
let drawerTargetWidgetId = null;
let drawerQuickFilter = 'all'; // 'all' | 'favorites' | 'recents'
let drawerGroupFilter = 'all';
let drawerSearchDebounce = null;
let containerResizeObserver = null;
let lastOrientationPortrait = window.innerWidth < 640;
let isProgrammaticLayoutUpdate = false;
const hudTimers = new Map();

const redirectHistoryIds = new Map(); // Tracks redirect streams for logging
let multiviewHeartbeatInterval = null; // Heartbeat timer for multiview redirect streams

/**
 * Escapes HTML special characters to prevent XSS in dynamic attributes/labels.
 */
function escapeHtml(str = '') {
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

/**
 * Starts periodic 30s heartbeats for all active redirect streams in MultiView.
 */
function startMultiviewHeartbeats() {
    if (multiviewHeartbeatInterval) return;
    multiviewHeartbeatInterval = setInterval(async () => {
        if (redirectHistoryIds.size === 0) {
            clearInterval(multiviewHeartbeatInterval);
            multiviewHeartbeatInterval = null;
            return;
        }
        for (const [, historyId] of redirectHistoryIds.entries()) {
            await sendRedirectHeartbeat(historyId);
        }
    }, 30000);
}

/**
 * Stops the multiview heartbeat timer if no redirect streams are active.
 */
function checkAndStopMultiviewHeartbeats() {
    if (redirectHistoryIds.size === 0 && multiviewHeartbeatInterval) {
        clearInterval(multiviewHeartbeatInterval);
        multiviewHeartbeatInterval = null;
    }
}

// Unload handlers to cleanly stop all active redirect streams in MultiView on tab/browser close
const handleMultiviewUnload = () => {
    for (const historyId of redirectHistoryIds.values()) {
        stopRedirectStream(historyId, true);
    }
};
window.addEventListener('pagehide', handleMultiviewUnload);
window.addEventListener('beforeunload', handleMultiviewUnload);

/**
 * Detects if a URL is a VOD file by checking for file extensions.
 * @param {string} url - The stream URL to check
 * @returns {boolean} True if URL appears to be a VOD file
 */
function isVODFile(url) {
    const vodExtensions = ['.mkv', '.mp4', '.avi', '.mov', '.m4v', '.flv', '.wmv', '.mpg', '.mpeg', '.webm'];
    const lowerUrl = url.toLowerCase();
    return vodExtensions.some(ext => lowerUrl.includes(ext));
}

/**
 * Less aggressive cleanup function specifically for when the browser tab is hidden.
 * Pauses players and stops server streams without causing race conditions with browser media suspension.
 */
async function pauseAndClearAllPlayers() {
    if (grid) {
        const gridItems = grid.getGridItems();
        lastLayoutBeforeHide = {
            mode: currentLayoutMode,
            items: gridItems.map(item => {
                const node = item.gridstackNode;
                const placeholder = item.querySelector('.player-placeholder');
                return {
                    x: node.x,
                    y: node.y,
                    w: node.w,
                    h: node.h,
                    id: placeholder?.id || node.id,
                    channelId: placeholder?.dataset.channelId || null
                };
            })
        };
    }

    const stopPromises = [];
    for (const [widgetId, player] of players.entries()) {
        if (playerUrls.has(widgetId)) {
            const originalUrl = playerUrls.get(widgetId);
            console.log(`[MultiView] Tab Hide: Sending stop request for widget ${widgetId}, URL: ${originalUrl}`);
            stopPromises.push(stopStream(originalUrl));
        }

        try {
            player.pause();
            player.detachMediaElement();
        } catch (e) {
            console.warn(`[MultiView] Tab Hide: Error pausing player for widget ${widgetId}.`, e);
        }
    }

    for (const [, historyId] of redirectHistoryIds.entries()) {
        stopPromises.push(stopRedirectStream(historyId));
    }
    redirectHistoryIds.clear();
    checkAndStopMultiviewHeartbeats();

    await Promise.all(stopPromises);
    console.log('[MultiView] Tab Hide: All server streams have been requested to stop.');

    players.clear();
    playerUrls.clear();
    activePlayerId = null;
    if (grid) {
        grid.removeAll();
    }
    updatePlayerCountBadge();
}

/**
 * Handles visibility changes of the browser tab.
 */
const restoreSavedMultiViewSession = () => {
    if (!lastLayoutBeforeHide) return;
    const savedMode = lastLayoutBeforeHide.mode || 'auto';
    setLayoutModeUI(savedMode);
    isProgrammaticLayoutUpdate = true;
    grid.batchUpdate();
    try {
        lastLayoutBeforeHide.items.forEach(widgetData => {
            const channel = widgetData.channelId ? guideState.channels.find(c => c.id === widgetData.channelId) : null;
            addPlayerWidget(channel, widgetData, true);
        });
    } finally {
        grid.commit();
        isProgrammaticLayoutUpdate = false;
        lastLayoutBeforeHide = null;
        updatePlayerCountBadge();
        refreshAllEmptyPlaceholders();
    }
};

const handleVisibilityChange = async () => {
    if (document.hidden) {
        if (isMultiViewActive()) {
            console.log('[MultiView] Tab hidden. Pausing all streams and cleaning up UI.');
            await pauseAndClearAllPlayers();
        }
    } else {
        if (lastLayoutBeforeHide && lastLayoutBeforeHide.items?.length > 0) {
            if (window.ViniAndroid) {
                console.log('[MultiView] Native Android app returned to foreground. Auto-restoring Multi-View session seamlessly.');
                restoreSavedMultiViewSession();
                return;
            }
            console.log('[MultiView] Tab visible. Offering to restore previous session.');
            showConfirm(
                'Restore Session?',
                'Would you like to restore your previous Multi-View session?',
                () => {
                    restoreSavedMultiViewSession();
                },
                () => {
                    lastLayoutBeforeHide = null;
                }
            );
        }
    }
};

/**
 * Dynamically calculates and updates Gridstack's cellHeight so 24 rows always equal 100% of #multiview-container height.
 */
function recalculateGridCellHeight() {
    if (!grid || !UIElements.multiviewContainer) return;
    const container = UIElements.multiviewContainer;
    const containerHeight = container.clientHeight;
    const containerWidth = container.clientWidth;
    if (containerHeight < 80 || containerWidth < 80) return;

    // Subtract small container padding (8px) and divide by 24 rows
    const availableHeight = Math.max(240, containerHeight - 8);
    const cellHeight = Math.max(8, Math.floor(availableHeight / GRID_ROWS));

    grid.cellHeight(cellHeight);
    updateGridBackground(cellHeight);

    const isPortraitNow = containerWidth < 640;
    if (isPortraitNow !== lastOrientationPortrait) {
        lastOrientationPortrait = isPortraitNow;
        if (currentLayoutMode === 'auto' && grid.getGridItems().length > 0) {
            relayoutExistingPlayers('auto');
        }
    }
}

/**
 * Adjusts the grid's background snap-line pattern to match 12 columns x 24 rows.
 */
function updateGridBackground(cellHeightOverride = null) {
    const gridEl = UIElements.multiviewContainer?.querySelector('.grid-stack');
    if (!gridEl || !grid) return;
    const columnWidth = gridEl.clientWidth / GRID_COLS;
    const rowHeight = cellHeightOverride || grid.getCellHeight() || Math.floor((UIElements.multiviewContainer.clientHeight - 8) / GRID_ROWS);
    if (columnWidth > 0 && rowHeight > 0) {
        gridEl.style.backgroundSize = `${columnWidth}px ${rowHeight}px`;
    }
}

/**
 * Updates the active pill styling for the Layout Mode buttons in the toolbar.
 * @param {'auto'|'2x2'|'1x3'|'freeform'} mode
 */
function setLayoutModeUI(mode) {
    currentLayoutMode = mode;
    const buttons = [
        { el: UIElements.layoutBtnAuto, mode: 'auto' },
        { el: UIElements.layoutBtn2x2, mode: '2x2' },
        { el: UIElements.layoutBtn1x3, mode: '1x3' },
        { el: UIElements.layoutBtnFreeform, mode: 'freeform' },
    ];

    buttons.forEach(({ el, mode: btnMode }) => {
        if (!el) return;
        const isActive = btnMode === mode;
        el.classList.toggle('active', isActive);
        el.classList.toggle('bg-blue-600', isActive);
        el.classList.toggle('text-white', isActive);
        el.classList.toggle('shadow', isActive);
        el.classList.toggle('text-gray-300', !isActive);
        el.classList.toggle('hover:bg-gray-800', !isActive);
    });

    const gridEl = UIElements.multiviewGrid || UIElements.multiviewContainer?.querySelector('.grid-stack');
    if (gridEl) {
        gridEl.classList.toggle('show-grid-lines', mode === 'freeform');
    }
    if (UIElements.multiviewContainer) {
        UIElements.multiviewContainer.classList.toggle('overflow-y-auto', mode === 'freeform');
        UIElements.multiviewContainer.classList.toggle('overflow-hidden', mode !== 'freeform');
    }
}

/**
 * Computes the (x, y, w, h) coordinates on the 12x24 grid for a given layout mode and widget count.
 * Every count from 1 to 9 fills 100% of the 12x24 canvas.
 */
function computeLayoutSlots(mode, count) {
    if (count <= 0) return [];
    const isPortrait = (UIElements.multiviewContainer?.clientWidth || window.innerWidth) < 640;

    if (mode === '2x2' && count === 4) {
        return [
            { x: 0, y: 0, w: 6, h: 12 },
            { x: 6, y: 0, w: 6, h: 12 },
            { x: 0, y: 12, w: 6, h: 12 },
            { x: 6, y: 12, w: 6, h: 12 }
        ];
    }

    if (mode === '1x3' && count === 4) {
        if (isPortrait) {
            return [
                { x: 0, y: 0, w: 12, h: 12 },
                { x: 0, y: 12, w: 4, h: 12 },
                { x: 4, y: 12, w: 4, h: 12 },
                { x: 8, y: 12, w: 4, h: 12 }
            ];
        }
        return [
            { x: 0, y: 0, w: 8, h: 24 },
            { x: 8, y: 0, w: 4, h: 8 },
            { x: 8, y: 8, w: 4, h: 8 },
            { x: 8, y: 16, w: 4, h: 8 }
        ];
    }

    // Auto mode (or fallback for any count 1..9)
    switch (count) {
        case 1:
            return [{ x: 0, y: 0, w: 12, h: 24 }];
        case 2:
            if (isPortrait) {
                return [
                    { x: 0, y: 0, w: 12, h: 12 },
                    { x: 0, y: 12, w: 12, h: 12 }
                ];
            }
            return [
                { x: 0, y: 0, w: 6, h: 24 },
                { x: 6, y: 0, w: 6, h: 24 }
            ];
        case 3:
            if (isPortrait) {
                return [
                    { x: 0, y: 0, w: 12, h: 8 },
                    { x: 0, y: 8, w: 12, h: 8 },
                    { x: 0, y: 16, w: 12, h: 8 }
                ];
            }
            return [
                { x: 0, y: 0, w: 8, h: 24 },
                { x: 8, y: 0, w: 4, h: 12 },
                { x: 8, y: 12, w: 4, h: 12 }
            ];
        case 4:
            return [
                { x: 0, y: 0, w: 6, h: 12 },
                { x: 6, y: 0, w: 6, h: 12 },
                { x: 0, y: 12, w: 6, h: 12 },
                { x: 6, y: 12, w: 6, h: 12 }
            ];
        case 5:
            return [
                { x: 0, y: 0, w: 6, h: 12 },
                { x: 6, y: 0, w: 6, h: 12 },
                { x: 0, y: 12, w: 4, h: 12 },
                { x: 4, y: 12, w: 4, h: 12 },
                { x: 8, y: 12, w: 4, h: 12 }
            ];
        case 6:
            return [
                { x: 0, y: 0, w: 4, h: 12 },
                { x: 4, y: 0, w: 4, h: 12 },
                { x: 8, y: 0, w: 4, h: 12 },
                { x: 0, y: 12, w: 4, h: 12 },
                { x: 4, y: 12, w: 4, h: 12 },
                { x: 8, y: 12, w: 4, h: 12 }
            ];
        case 7:
            return [
                { x: 0, y: 0, w: 4, h: 12 },
                { x: 4, y: 0, w: 4, h: 12 },
                { x: 8, y: 0, w: 4, h: 12 },
                { x: 0, y: 12, w: 3, h: 12 },
                { x: 3, y: 12, w: 3, h: 12 },
                { x: 6, y: 12, w: 3, h: 12 },
                { x: 9, y: 12, w: 3, h: 12 }
            ];
        case 8:
            return [
                { x: 0, y: 0, w: 3, h: 12 },
                { x: 3, y: 0, w: 3, h: 12 },
                { x: 6, y: 0, w: 3, h: 12 },
                { x: 9, y: 0, w: 3, h: 12 },
                { x: 0, y: 12, w: 3, h: 12 },
                { x: 3, y: 12, w: 3, h: 12 },
                { x: 6, y: 12, w: 3, h: 12 },
                { x: 9, y: 12, w: 3, h: 12 }
            ];
        default: {
            // 9 players: 3x3 grid (each 4 wide x 8 tall = 12x24)
            const slots = [];
            for (let i = 0; i < Math.min(count, MAX_PLAYERS); i++) {
                const row = Math.floor(i / 3);
                const col = i % 3;
                slots.push({ x: col * 4, y: row * 8, w: 4, h: 8 });
            }
            return slots;
        }
    }
}

/**
 * Rearranges all existing Gridstack widgets in-place without stopping or reloading any streams.
 * @param {'auto'|'2x2'|'1x3'} mode
 */
function relayoutExistingPlayers(mode = currentLayoutMode) {
    if (!grid || mode === 'freeform') return;
    const items = grid.getGridItems();
    if (items.length === 0) return;

    const slots = computeLayoutSlots(mode, items.length);
    isProgrammaticLayoutUpdate = true;
    grid.batchUpdate();
    try {
        items.forEach((item, index) => {
            const slot = slots[index];
            if (slot) {
                grid.update(item, { x: slot.x, y: slot.y, w: slot.w, h: slot.h });
            }
        });
    } finally {
        grid.commit();
        isProgrammaticLayoutUpdate = false;
    }
    recalculateGridCellHeight();
}

/**
 * Updates the slot counter badge in the toolbar and refreshes slot numbers on empty cards.
 */
function updatePlayerCountBadge() {
    if (!grid) return;
    const items = grid.getGridItems();
    const count = items.length;
    const playingCount = players.size + redirectHistoryIds.size;
    if (UIElements.multiviewPlayerCountBadge) {
        UIElements.multiviewPlayerCountBadge.textContent = `${count} / ${MAX_PLAYERS}`;
        UIElements.multiviewPlayerCountBadge.title = `${playingCount} active stream(s) across ${count} slot(s)`;
    }

    items.forEach((item, idx) => {
        const slotBadge = item.querySelector('.slot-index-badge');
        if (slotBadge) {
            slotBadge.textContent = `Slot ${idx + 1}`;
        }
        const titleEl = item.querySelector('.player-header-title');
        const placeholder = item.querySelector('.player-placeholder');
        if (titleEl && placeholder && !placeholder.dataset.channelId) {
            titleEl.textContent = `Slot ${idx + 1} · Empty`;
        }
    });

    updateDrawerTargetUI();
}

/**
 * Initializes the Multi-View page, sets up the 12x24 grid, resize observer, and event listeners.
 */
export function initMultiView() {
    document.addEventListener('visibilitychange', handleVisibilityChange);

    if (grid) {
        loadLayouts();
        populateDrawerGroups();
        renderDrawerChannels();
        if (grid.getGridItems().length === 0) {
            setLayoutModeUI('auto');
            addPlayerWidget(null, {}, true);
            addPlayerWidget(null, {}, true);
            relayoutExistingPlayers('auto');
            updatePlayerCountBadge();
        }
        setTimeout(() => recalculateGridCellHeight(), 50);
        return;
    }

    console.log('[MultiView] Initializing 12x24 responsive grid.');
    const options = {
        float: true,
        cellHeight: 36,
        margin: GRID_MARGIN,
        column: GRID_COLS,
        maxRow: 0,
        alwaysShowResizeHandle: 'mobile',
        resizable: { handles: 'e, se, s, sw, w' },
        draggable: { handle: '.player-header' }
    };
    grid = GridStack.init(options, '#multiview-grid');

    // Observe container resize so 24 rows always match 100% of available height
    if (UIElements.multiviewContainer && typeof ResizeObserver !== 'undefined') {
        containerResizeObserver = new ResizeObserver(() => {
            recalculateGridCellHeight();
        });
        containerResizeObserver.observe(UIElements.multiviewContainer);
    }

    // Detect user-initiated drag/resize to automatically switch to Freeform mode
    grid.on('dragstart resizestart', () => {
        const gridEl = UIElements.multiviewGrid || UIElements.multiviewContainer?.querySelector('.grid-stack');
        if (gridEl) gridEl.classList.add('show-grid-lines');
    });

    grid.on('dragstop resizestop', () => {
        if (!isProgrammaticLayoutUpdate) {
            setLayoutModeUI('freeform');
        }
    });

    setupMultiViewEventListeners();
    loadLayouts();
    populateDrawerGroups();
    renderDrawerChannels();

    // Start with 2 neatly arranged slots in Auto mode so the screen is immediately ready
    setLayoutModeUI('auto');
    if (grid.getGridItems().length === 0) {
        addPlayerWidget(null, {}, true);
        addPlayerWidget(null, {}, true);
        relayoutExistingPlayers('auto');
        updatePlayerCountBadge();
    }

    setTimeout(() => recalculateGridCellHeight(), 60);
}

/**
 * Checks if there are any active streams playing on the Multi-View page.
 * @returns {boolean} True if at least one stream is playing.
 */
export function isMultiViewActive() {
    return players.size > 0 || redirectHistoryIds.size > 0;
}

/**
 * Destroys all players, clears the grid, and resets the Multi-View state.
 */
export async function cleanupMultiView(keepEmptySlots = false) {
    if (!keepEmptySlots) {
        document.removeEventListener('visibilitychange', handleVisibilityChange);
        setImmersiveMode(false);
    }

    if (grid) {
        console.log('[MultiView] Cleaning up all players and grid.');
        const allWidgetIds = grid.getGridItems().map(item => {
            const placeholder = item.querySelector('.player-placeholder');
            return placeholder ? placeholder.id : item.gridstackNode?.id;
        }).filter(Boolean);

        const stopPromises = allWidgetIds.map(widgetId => stopAndCleanupPlayer(widgetId, true));
        await Promise.all(stopPromises);
        grid.removeAll();
    }

    players.clear();
    playerUrls.clear();
    playerChannelMeta.clear();
    for (const historyId of redirectHistoryIds.values()) {
        stopRedirectStream(historyId);
    }
    redirectHistoryIds.clear();
    checkAndStopMultiviewHeartbeats();
    activePlayerId = null;
    syncMultiviewActiveStreamToNative();
    if (!keepEmptySlots) {
        channelSelectorCallback = null;
        lastLayoutBeforeHide = null;
    }
    updatePlayerCountBadge();
    renderDrawerChannels();
    console.log('[MultiView] Cleanup complete.');
}

/**
 * Toggles the immersive mode for the Multi-View page.
 * @param {boolean} isImmersive - True to enable immersive mode, false to disable.
 */
function setImmersiveMode(isImmersive) {
    const appContainer = UIElements.appContainer;
    if (!appContainer) return;

    appContainer.classList.toggle('multiview-immersive', isImmersive);
    const immersiveToggle = document.getElementById('immersive-mode-toggle');
    if (immersiveToggle && immersiveToggle.checked !== isImmersive) {
        immersiveToggle.checked = isImmersive;
    }

    if (!isImmersive && UIElements.multiviewHeader) {
        UIElements.multiviewHeader.classList.remove('overlay-visible');
    }

    // Close drawer on immersive enter to maximize screen space
    if (isImmersive && isDrawerOpen) {
        toggleChannelDrawer(false);
    }

    if (grid) {
        setTimeout(() => {
            grid.onParentResize();
            recalculateGridCellHeight();
        }, 150);
    }
}

/**
 * Handles showing and auto-hiding the top toolbar when in immersive mode on desktop mouse hover near top.
 */
function handleImmersiveHeaderOverlay(e) {
    const appContainer = UIElements.appContainer;
    const multiviewHeader = UIElements.multiviewHeader;
    if (!appContainer || !multiviewHeader || !appContainer.classList.contains('multiview-immersive')) {
        return;
    }

    if (e.clientY < 64) {
        showImmersiveToolbarTemporarily();
    }
}

/**
 * Reveals the top Multi-View toolbar overlay temporarily during Immersive Mode (works on both desktop and mobile).
 */
function showImmersiveToolbarTemporarily() {
    const multiviewHeader = UIElements.multiviewHeader;
    if (!multiviewHeader) return;
    multiviewHeader.classList.add('overlay-visible');
    if (immersiveHeaderTimeout) {
        clearTimeout(immersiveHeaderTimeout);
    }
    immersiveHeaderTimeout = setTimeout(() => {
        multiviewHeader.classList.remove('overlay-visible');
    }, 4000);
}

/**
 * Toggles the Collapsible Channel Side Drawer.
 * @param {boolean|null} forceOpen - Optional explicit open/close state.
 * @param {string|null} targetWidgetId - Optional slot ID to target.
 */
function toggleChannelDrawer(forceOpen = null, targetWidgetId = null) {
    const drawer = UIElements.multiviewChannelDrawer;
    if (!drawer) return;

    isDrawerOpen = forceOpen !== null ? forceOpen : !isDrawerOpen;
    drawer.classList.toggle('hidden', !isDrawerOpen);
    drawer.classList.toggle('flex', isDrawerOpen);

    if (UIElements.multiviewDrawerToggleBtn) {
        UIElements.multiviewDrawerToggleBtn.classList.toggle('bg-blue-600', isDrawerOpen);
        UIElements.multiviewDrawerToggleBtn.classList.toggle('text-white', isDrawerOpen);
        UIElements.multiviewDrawerToggleBtn.classList.toggle('border-blue-500', isDrawerOpen);
        UIElements.multiviewDrawerToggleBtn.classList.toggle('bg-gray-900/90', !isDrawerOpen);
        UIElements.multiviewDrawerToggleBtn.classList.toggle('text-gray-200', !isDrawerOpen);
    }

    if (targetWidgetId) {
        setDrawerTargetSlot(targetWidgetId);
    } else if (isDrawerOpen) {
        updateDrawerTargetUI();
    } else {
        setDrawerTargetSlot(null);
    }

    if (isDrawerOpen) {
        populateDrawerGroups();
        renderDrawerChannels();
    }

    setTimeout(() => {
        if (grid) grid.onParentResize();
        recalculateGridCellHeight();
    }, 60);
}

/**
 * Sets and highlights the target player slot for the Channel Drawer.
 * @param {string|null} widgetId
 */
function setDrawerTargetSlot(widgetId) {
    drawerTargetWidgetId = widgetId;
    document.querySelectorAll('#multiview-grid .grid-stack-item-content').forEach(el => {
        el.classList.remove('drawer-target-slot');
    });

    if (widgetId) {
        const placeholder = document.getElementById(widgetId);
        const contentEl = placeholder?.closest('.grid-stack-item-content');
        if (contentEl) {
            contentEl.classList.add('drawer-target-slot');
        }
    }
    updateDrawerTargetUI();
}

/**
 * Updates the target badge text in the Channel Drawer header.
 */
function updateDrawerTargetUI() {
    const badge = UIElements.multiviewDrawerTargetBadge;
    if (!badge || !grid) return;

    const items = grid.getGridItems();
    if (drawerTargetWidgetId) {
        const idx = items.findIndex(item => item.querySelector('.player-placeholder')?.id === drawerTargetWidgetId);
        if (idx !== -1) {
            badge.textContent = `Target: Slot ${idx + 1}`;
            return;
        } else {
            drawerTargetWidgetId = null;
        }
    }

    // Find first empty slot
    const firstEmptyIdx = items.findIndex(item => !item.querySelector('.player-placeholder')?.dataset.channelId);
    if (firstEmptyIdx !== -1) {
        badge.textContent = `Next: Slot ${firstEmptyIdx + 1}`;
    } else if (items.length < MAX_PLAYERS) {
        badge.textContent = `Auto (+New Slot)`;
    } else {
        badge.textContent = `Replace Active`;
    }
}

/**
 * Populates the category/group dropdown inside the Channel Drawer.
 */
function populateDrawerGroups() {
    const select = UIElements.multiviewDrawerGroupSelect;
    if (!select) return;

    const currentVal = select.value || 'all';
    const groups = Array.from(new Set(
        (guideState.channels || []).map(c => c.group || 'Uncategorized')
    )).sort((a, b) => a.localeCompare(b));

    select.innerHTML = `<option value="all">All Categories (${groups.length})</option>` +
        groups.map(g => `<option value="${escapeHtml(g)}">${escapeHtml(g)}</option>`).join('');

    if (groups.includes(currentVal) || currentVal === 'all') {
        select.value = currentVal;
    } else {
        select.value = 'all';
        drawerGroupFilter = 'all';
    }
}

/**
 * Renders the filtered channel list inside the Collapsible Channel Drawer.
 */
function renderDrawerChannels() {
    const listEl = UIElements.multiviewDrawerChannelList;
    if (!listEl || !isDrawerOpen) return;

    const searchTerm = (UIElements.multiviewDrawerSearch?.value || '').trim().toLowerCase();
    let channels = [];

    if (drawerQuickFilter === 'favorites') {
        const favIds = new Set(guideState.settings.favorites || []);
        channels = (guideState.channels || []).filter(ch => favIds.has(ch.id));
    } else if (drawerQuickFilter === 'recents') {
        const recentIds = guideState.settings.recentChannels || [];
        channels = recentIds.map(id => (guideState.channels || []).find(ch => ch.id === id)).filter(Boolean);
    } else {
        channels = [...(guideState.channels || [])];
    }

    if (drawerGroupFilter && drawerGroupFilter !== 'all') {
        channels = channels.filter(ch => (ch.group || 'Uncategorized') === drawerGroupFilter);
    }

    if (searchTerm) {
        channels = channels.filter(ch =>
            (ch.displayName || ch.name || '').toLowerCase().includes(searchTerm) ||
            (ch.group || '').toLowerCase().includes(searchTerm)
        );
    }

    if (UIElements.multiviewDrawerChannelCount) {
        UIElements.multiviewDrawerChannelCount.textContent = `${channels.length} ch`;
    }

    if (channels.length === 0) {
        listEl.innerHTML = `
            <div class="text-center py-10 px-4 text-gray-500">
                <p class="text-xs font-semibold text-gray-400">No channels match your filter</p>
                <p class="text-[11px] mt-1">Try switching categories or clearing the search box.</p>
            </div>
        `;
        return;
    }

    // Determine which channel IDs are currently playing in Multi-View
    const playingChannelIds = new Set();
    if (grid) {
        grid.getGridItems().forEach(item => {
            const cid = item.querySelector('.player-placeholder')?.dataset.channelId;
            if (cid) playingChannelIds.add(cid);
        });
    }

    // Cap DOM nodes to 250 for instant rendering while scrolling
    const visibleSlice = channels.slice(0, 250);
    listEl.innerHTML = visibleSlice.map(channel => {
        const isPlaying = playingChannelIds.has(channel.id);
        const displayName = escapeHtml(channel.displayName || channel.name);
        const groupName = escapeHtml(channel.group || 'Uncategorized');
        const logoUrl = proxiedImageUrl(channel.logo) || 'https://placehold.co/40x40/1f2937/d1d5db?text=?';

        return `
            <div class="drawer-channel-item group flex items-center justify-between gap-2 p-2 rounded-xl border ${isPlaying ? 'bg-blue-950/40 border-blue-700/60' : 'bg-gray-800/50 hover:bg-gray-800 border-gray-800 hover:border-gray-700'} cursor-pointer transition-all"
                 draggable="true"
                 data-id="${escapeHtml(channel.id)}"
                 data-name="${displayName}"
                 data-url="${escapeHtml(channel.url)}"
                 data-logo="${escapeHtml(channel.logo || '')}">
                <div class="flex items-center gap-2.5 min-w-0">
                    <img src="${logoUrl}"
                         loading="lazy"
                         decoding="async"
                         onerror="this.onerror=null; this.src='https://placehold.co/40x40/1f2937/d1d5db?text=?';"
                         class="w-9 h-9 object-contain rounded-lg bg-gray-900 p-0.5 border border-gray-700/60 flex-shrink-0">
                    <div class="min-w-0">
                        <p class="font-semibold text-white text-xs truncate group-hover:text-blue-400 transition-colors">${displayName}</p>
                        <p class="text-gray-400 text-[11px] truncate">${groupName}</p>
                    </div>
                </div>
                <div class="flex items-center gap-1 flex-shrink-0">
                    ${isPlaying
                        ? `<span class="px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wider rounded bg-emerald-500/20 text-emerald-300 border border-emerald-500/30">Live</span>`
                        : `<span class="opacity-0 group-hover:opacity-100 text-xs text-blue-400 font-bold px-1.5 py-0.5 rounded bg-blue-500/10 transition-opacity">+ Play</span>`
                    }
                </div>
            </div>
        `;
    }).join('');
}

/**
 * Assigns a clicked channel from the Drawer into the targeted slot (or next available slot) and advances target.
 */
async function assignChannelFromDrawer(channel) {
    if (!grid || !channel) return;

    let items = grid.getGridItems();
    let targetItem = null;
    const hadExplicitTarget = Boolean(drawerTargetWidgetId);

    // 1. Explicit target slot
    if (drawerTargetWidgetId) {
        targetItem = items.find(item => item.querySelector('.player-placeholder')?.id === drawerTargetWidgetId);
    }

    // 2. First empty slot
    if (!targetItem) {
        targetItem = items.find(item => !item.querySelector('.player-placeholder')?.dataset.channelId);
    }

    // 3. Spawn a new slot if < MAX_PLAYERS
    if (!targetItem) {
        if (items.length < MAX_PLAYERS) {
            targetItem = addPlayerWidget(null, {}, false);
            items = grid.getGridItems();
        } else if (activePlayerId) {
            targetItem = items.find(item => item.querySelector('.player-placeholder')?.id === activePlayerId);
        } else {
            targetItem = items[items.length - 1];
        }
    }

    if (!targetItem) return;

    const placeholder = targetItem.querySelector('.player-placeholder');
    const widgetId = placeholder?.id || targetItem.gridstackNode?.id;
    const contentEl = targetItem.querySelector('.grid-stack-item-content');

    if (widgetId && contentEl) {
        await playChannelInWidget(widgetId, channel, contentEl);

        // On mobile screens, if user tapped a specific slot to pick a channel, auto-close drawer immediately
        if (window.innerWidth < 768 && hadExplicitTarget && isDrawerOpen) {
            toggleChannelDrawer(false);
            return;
        }

        // Advance drawer target to the next empty slot for rapid 1-2-3-4 channel filling
        const remainingEmpty = grid.getGridItems().find(item => !item.querySelector('.player-placeholder')?.dataset.channelId);
        if (remainingEmpty) {
            const nextId = remainingEmpty.querySelector('.player-placeholder')?.id;
            setDrawerTargetSlot(nextId || null);
        } else {
            setDrawerTargetSlot(null);
            // On mobile screens, auto-close drawer once all slots are filled
            if (window.innerWidth < 768 && isDrawerOpen) {
                toggleChannelDrawer(false);
            }
        }
    }
}

/**
 * Sets up global event listeners for the Multi-View page controls and Channel Drawer.
 */
function setupMultiViewEventListeners() {
    // Add Player (+) button
    UIElements.multiviewAddPlayer?.addEventListener('click', () => {
        const newWidget = addPlayerWidget(null, {}, false);
        if (newWidget && isDrawerOpen) {
            const pid = newWidget.querySelector('.player-placeholder')?.id;
            if (pid) setDrawerTargetSlot(pid);
        }
    });

    // Decrement Player (-) button: removes 1 slot (prefers removing an empty slot first)
    UIElements.multiviewDecrementPlayer?.addEventListener('click', async () => {
        if (!grid) return;
        const items = grid.getGridItems();
        if (items.length === 0) {
            showNotification('No slots to remove.', false);
            return;
        }

        // Prefer removing the last empty slot first; otherwise remove the last slot
        let targetItem = null;
        for (let i = items.length - 1; i >= 0; i--) {
            const ph = items[i].querySelector('.player-placeholder');
            if (ph && !ph.dataset.channelId) {
                targetItem = items[i];
                break;
            }
        }
        if (!targetItem) {
            targetItem = items[items.length - 1];
        }

        const placeholder = targetItem.querySelector('.player-placeholder');
        const widgetId = placeholder?.id || targetItem.gridstackNode?.id;
        if (widgetId) {
            await stopAndCleanupPlayer(widgetId, true);
        }
        grid.removeWidget(targetItem);

        if (currentLayoutMode !== 'freeform') {
            if (currentLayoutMode === '2x2' || currentLayoutMode === '1x3') {
                setLayoutModeUI('auto');
            }
            relayoutExistingPlayers('auto');
        }
        updatePlayerCountBadge();
    });

    // Mobile More Options (⋯) button: toggles secondary toolbar row on mobile
    UIElements.multiviewMobileMoreBtn?.addEventListener('click', () => {
        const sec = UIElements.multiviewSecondaryControls;
        if (!sec) return;
        const isHidden = sec.classList.contains('hidden');
        sec.classList.toggle('hidden', !isHidden);
        sec.classList.toggle('flex', isHidden);
        UIElements.multiviewMobileMoreBtn.classList.toggle('bg-blue-600', isHidden);
        UIElements.multiviewMobileMoreBtn.classList.toggle('text-white', isHidden);
        UIElements.multiviewMobileMoreBtn.classList.toggle('border-blue-500', isHidden);
        UIElements.multiviewMobileMoreBtn.classList.toggle('bg-gray-900/90', !isHidden);
        UIElements.multiviewMobileMoreBtn.classList.toggle('text-gray-300', !isHidden);
        setTimeout(() => recalculateGridCellHeight(), 50);
    });

    // Clear All button
    UIElements.multiviewRemovePlayer?.addEventListener('click', () => {
        if (!grid || grid.getGridItems().length === 0) {
            showNotification('Grid is already empty.', false);
            return;
        }
        if (isMultiViewActive()) {
            showConfirm(
                'Clear All Streams?',
                'This will stop all active streams and reset the Multi-View grid.',
                async () => {
                    await cleanupMultiView(true);
                    if (currentLayoutMode !== 'freeform') {
                        addPlayerWidget(null, {}, true);
                        addPlayerWidget(null, {}, true);
                        relayoutExistingPlayers(currentLayoutMode === 'auto' ? 'auto' : '2x2');
                        updatePlayerCountBadge();
                    }
                }
            );
        } else {
            cleanupMultiView(true);
        }
    });

    // Layout Mode Pill Buttons
    UIElements.layoutBtnAuto?.addEventListener('click', () => applyPresetLayout('auto'));
    UIElements.layoutBtn2x2?.addEventListener('click', () => applyPresetLayout('2x2'));
    UIElements.layoutBtn1x3?.addEventListener('click', () => applyPresetLayout('1x3'));
    UIElements.layoutBtnFreeform?.addEventListener('click', () => applyPresetLayout('freeform'));

    // Saved Layouts Controls
    UIElements.multiviewSaveLayoutBtn?.addEventListener('click', () => openModal(UIElements.saveLayoutModal));
    UIElements.multiviewLoadLayoutBtn?.addEventListener('click', loadSelectedLayout);
    UIElements.multiviewDeleteLayoutBtn?.addEventListener('click', deleteLayout);
    UIElements.saveLayoutForm?.addEventListener('submit', saveLayout);
    UIElements.saveLayoutCancelBtn?.addEventListener('click', () => closeModal(UIElements.saveLayoutModal));

    // Pin Headers Toggle Button
    UIElements.multiviewPinControlsBtn?.addEventListener('click', () => {
        pinHeaders = !pinHeaders;
        const gridEl = UIElements.multiviewGrid || UIElements.multiviewContainer?.querySelector('.grid-stack');
        if (gridEl) {
            gridEl.classList.toggle('pin-headers', pinHeaders);
        }
        UIElements.multiviewPinControlsBtn.classList.toggle('bg-blue-600', pinHeaders);
        UIElements.multiviewPinControlsBtn.classList.toggle('text-white', pinHeaders);
        UIElements.multiviewPinControlsBtn.classList.toggle('border-blue-500', pinHeaders);
        UIElements.multiviewPinControlsBtn.classList.toggle('bg-gray-900/80', !pinHeaders);
        UIElements.multiviewPinControlsBtn.classList.toggle('text-gray-300', !pinHeaders);
    });

    // Channel Drawer Toggle & Close
    UIElements.multiviewDrawerToggleBtn?.addEventListener('click', () => toggleChannelDrawer());
    UIElements.multiviewDrawerCloseBtn?.addEventListener('click', () => toggleChannelDrawer(false));

    // Drawer Mode Switcher (Live Channels vs Custom URL)
    UIElements.multiviewDrawerTabList?.addEventListener('click', () => {
        UIElements.multiviewDrawerTabList.classList.add('bg-blue-600', 'text-white');
        UIElements.multiviewDrawerTabList.classList.remove('text-gray-400');
        UIElements.multiviewDrawerTabCustom?.classList.remove('bg-blue-600', 'text-white');
        UIElements.multiviewDrawerTabCustom?.classList.add('text-gray-400');
        UIElements.multiviewDrawerListControls?.classList.remove('hidden');
        UIElements.multiviewDrawerChannelList?.classList.remove('hidden');
        UIElements.multiviewDrawerCustomControls?.classList.add('hidden');
    });

    UIElements.multiviewDrawerTabCustom?.addEventListener('click', () => {
        UIElements.multiviewDrawerTabCustom.classList.add('bg-blue-600', 'text-white');
        UIElements.multiviewDrawerTabCustom.classList.remove('text-gray-400');
        UIElements.multiviewDrawerTabList?.classList.remove('bg-blue-600', 'text-white');
        UIElements.multiviewDrawerTabList?.classList.add('text-gray-400');
        UIElements.multiviewDrawerListControls?.classList.add('hidden');
        UIElements.multiviewDrawerChannelList?.classList.add('hidden');
        UIElements.multiviewDrawerCustomControls?.classList.remove('hidden');
    });

    // Drawer Quick Filter Pills (All / Favorites / Recents)
    document.querySelectorAll('.multiview-drawer-filter-pill').forEach(btn => {
        btn.addEventListener('click', () => {
            drawerQuickFilter = btn.dataset.drawerFilter || 'all';
            document.querySelectorAll('.multiview-drawer-filter-pill').forEach(b => {
                const active = b.dataset.drawerFilter === drawerQuickFilter;
                b.className = active
                    ? 'multiview-drawer-filter-pill flex-1 py-1 px-2 rounded-lg font-medium bg-blue-600/20 text-blue-300 border border-blue-500/40 transition-all'
                    : 'multiview-drawer-filter-pill flex-1 py-1 px-2 rounded-lg font-medium bg-gray-800 text-gray-400 hover:text-gray-200 border border-gray-700/60 transition-all';
            });
            renderDrawerChannels();
        });
    });

    // Drawer Group Select & Search
    UIElements.multiviewDrawerGroupSelect?.addEventListener('change', (e) => {
        drawerGroupFilter = e.target.value || 'all';
        renderDrawerChannels();
    });

    UIElements.multiviewDrawerSearch?.addEventListener('input', () => {
        clearTimeout(drawerSearchDebounce);
        drawerSearchDebounce = setTimeout(() => renderDrawerChannels(), 180);
    });

    // Drawer Custom URL Play Button
    UIElements.multiviewDrawerCustomPlayBtn?.addEventListener('click', () => {
        const url = UIElements.multiviewDrawerCustomUrl?.value.trim();
        const name = UIElements.multiviewDrawerCustomName?.value.trim() || 'Custom Stream';
        if (!url) {
            showNotification('Please enter a stream URL', true);
            return;
        }
        assignChannelFromDrawer({
            id: `custom-${Date.now()}`,
            name,
            url,
            logo: 'https://placehold.co/40x40/1f2937/d1d5db?text=URL'
        });
        if (UIElements.multiviewDrawerCustomUrl) UIElements.multiviewDrawerCustomUrl.value = '';
        if (UIElements.multiviewDrawerCustomName) UIElements.multiviewDrawerCustomName.value = '';
    });

    // Drawer Channel List Click & Drag Start
    UIElements.multiviewDrawerChannelList?.addEventListener('click', (e) => {
        const item = e.target.closest('.drawer-channel-item');
        if (!item) return;
        const channel = {
            id: item.dataset.id,
            name: item.dataset.name,
            url: item.dataset.url,
            logo: item.dataset.logo
        };
        assignChannelFromDrawer(channel);
    });

    UIElements.multiviewDrawerChannelList?.addEventListener('dragstart', (e) => {
        const item = e.target.closest('.drawer-channel-item');
        if (!item) return;
        const channel = {
            id: item.dataset.id,
            name: item.dataset.name,
            url: item.dataset.url,
            logo: item.dataset.logo
        };
        e.dataTransfer.setData('application/x-viniplay-channel', JSON.stringify(channel));
        e.dataTransfer.effectAllowed = 'copy';
    });

    // Allow dropping a channel onto empty canvas space to create a new player slot
    UIElements.multiviewContainer?.addEventListener('dragover', (e) => {
        if (e.dataTransfer.types.includes('application/x-viniplay-channel')) {
            e.preventDefault();
            e.dataTransfer.dropEffect = 'copy';
        }
    });

    UIElements.multiviewContainer?.addEventListener('drop', (e) => {
        // Ignore if already handled by a specific player widget
        if (e.target.closest('.grid-stack-item-content')) return;
        const raw = e.dataTransfer.getData('application/x-viniplay-channel');
        if (!raw) return;
        e.preventDefault();
        try {
            const channel = JSON.parse(raw);
            const newWidget = addPlayerWidget(channel, {}, false);
            if (!newWidget) {
                assignChannelFromDrawer(channel);
            }
        } catch (err) {
            console.warn('[MultiView] Failed to parse dropped channel data:', err);
        }
    });

    // --- Modal Fallback Listeners (Used by DVR & Admin remote channel selector) ---
    UIElements.multiviewSourceListBtn?.addEventListener('click', () => {
        UIElements.multiviewSourceListBtn.classList.add('bg-gray-700', 'text-white', 'font-medium');
        UIElements.multiviewSourceListBtn.classList.remove('text-gray-300');
        UIElements.multiviewSourceCustomBtn.classList.remove('bg-gray-700', 'text-white', 'font-medium');
        UIElements.multiviewSourceCustomBtn.classList.add('text-gray-300');

        UIElements.channelSelectorList.classList.remove('hidden');
        UIElements.channelSelectorSearch.classList.remove('hidden');
        const filterContainer = UIElements.multiviewChannelFilter.closest('.flex.justify-between');
        if (filterContainer) filterContainer.classList.remove('hidden');
        UIElements.multiviewCustomUrlContainer.classList.add('hidden');
    });

    UIElements.multiviewSourceCustomBtn?.addEventListener('click', () => {
        UIElements.multiviewSourceCustomBtn.classList.add('bg-gray-700', 'text-white', 'font-medium');
        UIElements.multiviewSourceCustomBtn.classList.remove('text-gray-300');
        UIElements.multiviewSourceListBtn.classList.remove('bg-gray-700', 'text-white', 'font-medium');
        UIElements.multiviewSourceListBtn.classList.add('text-gray-300');

        UIElements.channelSelectorList.classList.add('hidden');
        UIElements.channelSelectorSearch.classList.add('hidden');
        const filterContainer = UIElements.multiviewChannelFilter.closest('.flex.justify-between');
        if (filterContainer) filterContainer.classList.add('hidden');
        UIElements.multiviewCustomUrlContainer.classList.remove('hidden');
    });

    UIElements.multiviewCustomUrlPlayBtn?.addEventListener('click', () => {
        const url = UIElements.multiviewCustomUrlInput.value.trim();
        const name = UIElements.multiviewCustomNameInput.value.trim() || 'Custom Stream';

        if (!url) {
            showNotification('Please enter a stream URL', true);
            return;
        }

        const customChannel = {
            id: `custom-${Date.now()}`,
            name: name,
            url: url,
            logo: 'https://placehold.co/40x40/1f2937/d1d5db?text=URL'
        };

        if (channelSelectorCallback) {
            channelSelectorCallback(customChannel);
            closeModal(UIElements.multiviewChannelSelectorModal);
            UIElements.multiviewCustomUrlInput.value = '';
            UIElements.multiviewCustomNameInput.value = '';
        }
    });

    // --- Immersive Mode Event Listeners (Desktop + Mobile Floating Pill) ---
    const immersiveToggle = document.getElementById('immersive-mode-toggle');
    if (immersiveToggle) {
        immersiveToggle.addEventListener('change', (e) => {
            setImmersiveMode(e.target.checked);
        });
    }

    UIElements.multiviewImmersiveToolbarBtn?.addEventListener('click', () => {
        const header = UIElements.multiviewHeader;
        if (!header) return;
        if (header.classList.contains('overlay-visible')) {
            header.classList.remove('overlay-visible');
        } else {
            showImmersiveToolbarTemporarily();
        }
    });

    UIElements.multiviewImmersiveExitBtn?.addEventListener('click', () => {
        setImmersiveMode(false);
    });

    // Allow Escape key to exit Immersive Mode
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && UIElements.appContainer?.classList.contains('multiview-immersive')) {
            setImmersiveMode(false);
        }
    });

    if (UIElements.appContainer) {
        UIElements.appContainer.addEventListener('mousemove', handleImmersiveHeaderOverlay);
    }
}

/**
 * Handles the channel selection logic when the fallback modal is used.
 * @param {HTMLElement} channelItem - The clicked channel item element.
 */
export function handleMultiViewChannelClick(channelItem) {
    if (channelItem && channelSelectorCallback) {
        const channel = {
            id: channelItem.dataset.id,
            name: channelItem.dataset.name,
            url: channelItem.dataset.url,
            logo: channelItem.dataset.logo,
        };
        channelSelectorCallback(channel);
        closeModal(UIElements.multiviewChannelSelectorModal);
    }
}

/**
 * Builds up to 3 quick-pick channel pills (from Favorites or Recents) for an empty player placeholder.
 */
function buildQuickPickChannelsHTML() {
    const favIds = guideState.settings.favorites || [];
    const recentIds = guideState.settings.recentChannels || [];
    const candidateIds = Array.from(new Set([...favIds, ...recentIds]));

    const playingIds = new Set();
    if (grid) {
        grid.getGridItems().forEach(item => {
            const cid = item.querySelector('.player-placeholder')?.dataset.channelId;
            if (cid) playingIds.add(cid);
        });
    }

    const quickChannels = candidateIds
        .filter(id => !playingIds.has(id))
        .map(id => (guideState.channels || []).find(c => c.id === id))
        .filter(Boolean)
        .slice(0, 3);

    if (quickChannels.length === 0) return '';

    return `
        <div class="quick-picks-container mt-3 pt-2.5 border-t border-gray-800/80 flex flex-wrap items-center justify-center gap-1.5 max-w-xs">
            <span class="w-full text-[10px] uppercase tracking-wider text-gray-500 font-semibold mb-0.5">Quick Launch</span>
            ${quickChannels.map(ch => `
                <button type="button"
                    class="quick-pick-channel-btn px-2 py-1 rounded-lg bg-gray-800/90 hover:bg-blue-600 text-gray-200 hover:text-white border border-gray-700 hover:border-blue-500 text-[11px] font-medium truncate max-w-[130px] transition-all shadow-sm"
                    data-id="${escapeHtml(ch.id)}"
                    data-name="${escapeHtml(ch.displayName || ch.name)}"
                    data-url="${escapeHtml(ch.url)}"
                    data-logo="${escapeHtml(ch.logo || '')}"
                    title="Play ${escapeHtml(ch.displayName || ch.name)}">
                    ${escapeHtml(ch.displayName || ch.name)}
                </button>
            `).join('')}
        </div>
    `;
}

/**
 * Refreshes the quick-pick channel buttons inside all currently empty placeholders.
 */
function refreshAllEmptyPlaceholders() {
    if (!grid) return;
    grid.getGridItems().forEach(item => {
        const placeholder = item.querySelector('.player-placeholder');
        if (placeholder && !placeholder.dataset.channelId) {
            const existingQuick = placeholder.querySelector('.quick-picks-container');
            if (existingQuick) existingQuick.remove();
            const html = buildQuickPickChannelsHTML();
            if (html) {
                placeholder.insertAdjacentHTML('beforeend', html);
            }
        }
    });
}

/**
 * Creates and adds a new player widget to the grid.
 * @param {object|null} channel - Optional channel to auto-load.
 * @param {object} layout - Optional layout data for the widget.
 * @param {boolean} skipAutoRelayout - If true, skips triggering Auto relayout (used during batch operations).
 * @returns {HTMLElement|null} The added widget element.
 */
function addPlayerWidget(channel = null, layout = {}, skipAutoRelayout = false) {
    if (grid.getGridItems().length >= MAX_PLAYERS) {
        showNotification(`You can add a maximum of ${MAX_PLAYERS} players.`, true);
        return null;
    }

    const slotNumber = grid.getGridItems().length + 1;
    const widgetId = layout.id || `player-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    const swapIcon = `<svg class="w-4 h-4" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M7 16V4m0 0L3 8m4-4l4 4m6 0v12m0 0l4-4m-4 4l-4-4"/></svg>`;

    const widgetHTML = `
        <div class="player-header">
            <div class="flex items-center gap-2 min-w-0">
                <span class="player-header-title">Slot ${slotNumber} · Empty</span>
            </div>
            <div class="player-controls">
                <button type="button" class="select-channel-btn" title="Select Channel">${ICONS.selectChannel}</button>
                <button type="button" class="swap-primary-btn" title="Promote / Swap with Primary Slot">${swapIcon}</button>
                <button type="button" class="play-pause-btn" title="Play/Pause">${ICONS.pause}</button>
                <button type="button" class="mute-btn" title="Mute / Unmute">${ICONS.mute}</button>
                <input type="range" min="0" max="1" step="0.05" value="0.7" class="volume-slider hidden sm:inline-block" title="Volume">
                <button type="button" class="fullscreen-btn" title="Fullscreen">${ICONS.fullscreen}</button>
                <button type="button" class="stop-btn" title="Stop Stream">${ICONS.stop}</button>
                <button type="button" class="remove-widget-btn" title="Close Slot">${ICONS.removeWidget}</button>
            </div>
        </div>
        <div class="player-body">
            <div class="player-placeholder" id="${widgetId}" data-channel-id="">
                <span class="slot-index-badge px-2.5 py-0.5 rounded-full text-[11px] font-mono font-semibold bg-gray-800/90 text-gray-400 border border-gray-700/80 mb-2">Slot ${slotNumber}</span>
                ${ICONS.placeholderPlay}
                <span class="text-xs font-semibold text-gray-300">Click to Select Channel</span>
                <span class="text-[11px] text-gray-500 mt-0.5">or drag a channel from the drawer</span>
                ${buildQuickPickChannelsHTML()}
            </div>
            <video class="hidden w-full h-full object-contain" muted playsinline></video>
            <!-- Bottom HUD: Status Pill (Left) + Mobile Split Playback Controls (Right, < 640px only) -->
            <div class="player-bottom-hud hidden absolute bottom-2 left-2 right-2 z-20 pointer-events-none flex items-center justify-between gap-1.5">
                <div class="player-status-pill flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-gray-950/85 border border-gray-700/70 backdrop-blur-sm text-[11px] font-medium text-gray-200 shadow-lg min-w-0">
                    <span class="player-audio-dot w-2 h-2 rounded-full bg-gray-500 flex-shrink-0"></span>
                    <span class="player-status-name truncate max-w-[140px]"></span>
                </div>
                <div class="player-bottom-controls">
                    <button type="button" class="play-pause-btn" title="Play/Pause">${ICONS.pause}</button>
                    <button type="button" class="mute-btn" title="Mute / Unmute">${ICONS.mute}</button>
                    <button type="button" class="swap-primary-btn" title="Promote / Swap with Primary Slot">${swapIcon}</button>
                    <button type="button" class="fullscreen-btn" title="Fullscreen">${ICONS.fullscreen}</button>
                </div>
            </div>
        </div>
    `;

    isProgrammaticLayoutUpdate = true;
    const newWidgetEl = grid.addWidget({
        id: widgetId,
        content: widgetHTML,
        w: layout.w || 4,
        h: layout.h || 8,
        x: layout.x,
        y: layout.y
    });
    isProgrammaticLayoutUpdate = false;

    const widgetContentEl = newWidgetEl.querySelector('.grid-stack-item-content');
    if (widgetContentEl) {
        widgetContentEl.classList.add('is-empty');
        attachWidgetEventListeners(widgetContentEl, widgetId);
    }

    if (!skipAutoRelayout && currentLayoutMode !== 'freeform') {
        if (currentLayoutMode === '2x2' || currentLayoutMode === '1x3') {
            setLayoutModeUI('auto');
        }
        relayoutExistingPlayers('auto');
    }

    updatePlayerCountBadge();

    if (channel) {
        playChannelInWidget(widgetId, channel, widgetContentEl);
    }
    return newWidgetEl;
}

/**
 * Applies a predefined layout mode ('auto', '2x2', '1x3', 'freeform') non-destructively.
 * Active streams continue playing uninterrupted while windows reposition and resize.
 * @param {'auto'|'2x2'|'1x3'|'freeform'} layoutName
 */
function applyPresetLayout(layoutName) {
    if (!grid) return;

    if (layoutName === 'freeform') {
        setLayoutModeUI('freeform');
        recalculateGridCellHeight();
        return;
    }

    setLayoutModeUI(layoutName);
    let items = grid.getGridItems();

    if (layoutName === 'auto') {
        if (items.length === 0) {
            addPlayerWidget(null, {}, true);
            addPlayerWidget(null, {}, true);
        }
        relayoutExistingPlayers('auto');
        updatePlayerCountBadge();
        return;
    }

    // For '2x2' and '1x3' presets: ensure we have 4 slots without stopping any playing streams
    if (layoutName === '2x2' || layoutName === '1x3') {
        isProgrammaticLayoutUpdate = true;
        grid.batchUpdate();
        try {
            // If fewer than 4 widgets exist, add empty slots to reach 4
            while (grid.getGridItems().length < 4) {
                addPlayerWidget(null, {}, true);
            }

            // If more than 4 widgets exist, remove any excess empty slots down to 4
            items = grid.getGridItems();
            if (items.length > 4) {
                for (let i = items.length - 1; i >= 4; i--) {
                    if (grid.getGridItems().length <= 4) break;
                    const placeholder = items[i].querySelector('.player-placeholder');
                    if (placeholder && !placeholder.dataset.channelId) {
                        grid.removeWidget(items[i]);
                    }
                }
            }
        } finally {
            grid.commit();
            isProgrammaticLayoutUpdate = false;
        }

        relayoutExistingPlayers(layoutName);
        updatePlayerCountBadge();
    }
}

/**
 * Swaps the position and size of the given widget with the primary (largest or top-left) widget on the grid.
 * @param {string} widgetId
 */
function swapWithPrimaryWidget(widgetId) {
    if (!grid) return;
    const items = grid.getGridItems();
    if (items.length < 2) return;

    const currentItem = items.find(item => item.querySelector('.player-placeholder')?.id === widgetId);
    if (!currentItem) return;

    // Find primary item: largest area (w * h), or top-leftmost if equal
    let primaryItem = items[0];
    let maxArea = (primaryItem.gridstackNode.w || 0) * (primaryItem.gridstackNode.h || 0);

    items.forEach(item => {
        const node = item.gridstackNode;
        const area = (node.w || 0) * (node.h || 0);
        if (area > maxArea || (area === maxArea && (node.y < primaryItem.gridstackNode.y || (node.y === primaryItem.gridstackNode.y && node.x < primaryItem.gridstackNode.x)))) {
            maxArea = area;
            primaryItem = item;
        }
    });

    if (primaryItem === currentItem) {
        // Already the primary slot; swap with the second slot instead
        primaryItem = items.find(item => item !== currentItem) || primaryItem;
    }

    const nodeA = {
        x: primaryItem.gridstackNode.x,
        y: primaryItem.gridstackNode.y,
        w: primaryItem.gridstackNode.w,
        h: primaryItem.gridstackNode.h
    };
    const nodeB = {
        x: currentItem.gridstackNode.x,
        y: currentItem.gridstackNode.y,
        w: currentItem.gridstackNode.w,
        h: currentItem.gridstackNode.h
    };

    isProgrammaticLayoutUpdate = true;
    grid.batchUpdate();
    try {
        grid.update(primaryItem, nodeB);
        grid.update(currentItem, nodeA);
    } finally {
        grid.commit();
        isProgrammaticLayoutUpdate = false;
    }

    setActivePlayer(widgetId);
}

/**
 * Temporarily reveals the top HUD overlay on a player widget for 4 seconds (for mobile touch & click ergonomics).
 * @param {HTMLElement} widgetContentEl
 * @param {string} widgetId
 */
function revealWidgetHudTemporarily(widgetContentEl, widgetId) {
    if (!widgetContentEl) return;
    widgetContentEl.classList.add('hud-visible');
    if (hudTimers.has(widgetId)) {
        clearTimeout(hudTimers.get(widgetId));
    }
    const timer = setTimeout(() => {
        widgetContentEl.classList.remove('hud-visible');
        hudTimers.delete(widgetId);
    }, 4000);
    hudTimers.set(widgetId, timer);
}

/**
 * Updates the bottom-left audio indicator pill on a player widget.
 */
function updateWidgetAudioPill(widgetContentEl, isActive, isMuted) {
    if (!widgetContentEl) return;
    const dot = widgetContentEl.querySelector('.player-audio-dot');
    const pill = widgetContentEl.querySelector('.player-status-pill');
    if (!dot || !pill) return;

    if (isActive && !isMuted) {
        dot.className = 'player-audio-dot w-2 h-2 rounded-full bg-blue-400 animate-pulse';
        pill.classList.add('border-blue-500/60', 'text-white');
        pill.classList.remove('border-gray-700/70', 'text-gray-200');
    } else {
        dot.className = 'player-audio-dot w-2 h-2 rounded-full bg-gray-500';
        pill.classList.remove('border-blue-500/60', 'text-white');
        pill.classList.add('border-gray-700/70', 'text-gray-200');
    }
}

/**
 * Attaches event listeners to the controls and drop zone within a player widget.
 * @param {HTMLElement} widgetContentEl - The widget's .grid-stack-item-content element.
 * @param {string} widgetId - The unique ID of the widget.
 */
function attachWidgetEventListeners(widgetContentEl, widgetId) {
    const playerPlaceholderEl = widgetContentEl.querySelector(`.player-placeholder[id="${widgetId}"]`);
    const videoEl = widgetContentEl.querySelector('video');
    const gridStackItem = widgetContentEl.closest('.grid-stack-item');

    const openDrawerForSlot = (e) => {
        if (e) e.stopPropagation();
        toggleChannelDrawer(true, widgetId);
    };

    widgetContentEl.querySelector('.select-channel-btn')?.addEventListener('click', openDrawerForSlot);
    if (playerPlaceholderEl) {
        playerPlaceholderEl.addEventListener('click', (e) => {
            const quickBtn = e.target.closest('.quick-pick-channel-btn');
            if (quickBtn) {
                e.stopPropagation();
                playChannelInWidget(widgetId, {
                    id: quickBtn.dataset.id,
                    name: quickBtn.dataset.name,
                    url: quickBtn.dataset.url,
                    logo: quickBtn.dataset.logo
                }, widgetContentEl);
                return;
            }
            if (e.target.closest('.quick-picks-container')) {
                e.stopPropagation();
                return;
            }
            openDrawerForSlot(e);
        });
    }

    // Swap / Promote to Primary buttons (top bar + mobile bottom bar)
    widgetContentEl.querySelectorAll('.swap-primary-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            swapWithPrimaryWidget(widgetId);
        });
    });

    // Stop stream (resets slot to empty placeholder)
    widgetContentEl.querySelector('.stop-btn')?.addEventListener('click', (e) => {
        e.stopPropagation();
        stopAndCleanupPlayer(widgetId, true);
    });

    // Remove widget slot completely
    widgetContentEl.querySelector('.remove-widget-btn')?.addEventListener('click', async (e) => {
        e.stopPropagation();
        await stopAndCleanupPlayer(widgetId, true);
        if (gridStackItem && grid) {
            grid.removeWidget(gridStackItem);
            if (currentLayoutMode === 'auto') {
                relayoutExistingPlayers('auto');
            }
            updatePlayerCountBadge();
        }
    });

    const muteBtns = widgetContentEl.querySelectorAll('.mute-btn');
    muteBtns.forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            videoEl.muted = !videoEl.muted;
            muteBtns.forEach(b => { b.innerHTML = videoEl.muted ? ICONS.mute : ICONS.unmute; });
            updateWidgetAudioPill(widgetContentEl, activePlayerId === widgetId, videoEl.muted);
            revealWidgetHudTemporarily(widgetContentEl, widgetId);
        });
    });

    const playPauseBtns = widgetContentEl.querySelectorAll('.play-pause-btn');
    playPauseBtns.forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            if (videoEl.paused) {
                videoEl.play();
                playPauseBtns.forEach(b => { b.innerHTML = ICONS.pause; });
            } else {
                videoEl.pause();
                playPauseBtns.forEach(b => { b.innerHTML = ICONS.play; });
            }
            revealWidgetHudTemporarily(widgetContentEl, widgetId);
        });
    });

    videoEl.addEventListener('play', () => {
        playPauseBtns.forEach(b => { b.innerHTML = ICONS.pause; });
    });
    videoEl.addEventListener('pause', () => {
        playPauseBtns.forEach(b => { b.innerHTML = ICONS.play; });
    });

    widgetContentEl.querySelector('.volume-slider')?.addEventListener('input', (e) => {
        e.stopPropagation();
        videoEl.volume = parseFloat(e.target.value);
        if (videoEl.volume > 0) {
            videoEl.muted = false;
            muteBtns.forEach(b => { b.innerHTML = ICONS.unmute; });
        }
        updateWidgetAudioPill(widgetContentEl, activePlayerId === widgetId, videoEl.muted);
        revealWidgetHudTemporarily(widgetContentEl, widgetId);
    });

    widgetContentEl.querySelectorAll('.fullscreen-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            if (videoEl.requestFullscreen) {
                videoEl.requestFullscreen();
            } else if (videoEl.webkitEnterFullscreen) {
                videoEl.webkitEnterFullscreen();
            }
        });
    });

    // Click / Tap on player: Focus Audio + Reveal HUD for 4s (Mobile & Desktop friendly)
    widgetContentEl.addEventListener('click', () => {
        setActivePlayer(widgetId);
        revealWidgetHudTemporarily(widgetContentEl, widgetId);
        if (isDrawerOpen) {
            setDrawerTargetSlot(widgetId);
        }
    });

    // Drag & Drop support from the Channel Drawer onto this specific widget
    widgetContentEl.addEventListener('dragover', (e) => {
        if (e.dataTransfer.types.includes('application/x-viniplay-channel')) {
            e.preventDefault();
            e.stopPropagation();
            e.dataTransfer.dropEffect = 'copy';
            widgetContentEl.classList.add('drop-target-hover');
        }
    });

    widgetContentEl.addEventListener('dragleave', () => {
        widgetContentEl.classList.remove('drop-target-hover');
    });

    widgetContentEl.addEventListener('drop', (e) => {
        widgetContentEl.classList.remove('drop-target-hover');
        const raw = e.dataTransfer.getData('application/x-viniplay-channel');
        if (!raw) return;
        e.preventDefault();
        e.stopPropagation();
        try {
            const channel = JSON.parse(raw);
            playChannelInWidget(widgetId, channel, widgetContentEl);
        } catch (err) {
            console.warn('[MultiView] Error parsing dropped channel:', err);
        }
    });
}

/**
 * Sets the currently active player, highlighting it and focusing audio.
 * @param {string} widgetId - The ID of the player to set as active.
 */
function setActivePlayer(widgetId) {
    if (activePlayerId === widgetId) {
        const currentEl = document.getElementById(widgetId)?.closest('.grid-stack-item-content');
        const vid = currentEl?.querySelector('video');
        if (vid && currentEl && !currentEl.classList.contains('is-empty')) {
            vid.muted = false;
            currentEl.querySelectorAll('.mute-btn').forEach(b => { b.innerHTML = ICONS.unmute; });
            updateWidgetAudioPill(currentEl, true, false);
        }
        syncMultiviewActiveStreamToNative();
        return;
    }

    const oldActivePlaceholder = document.getElementById(activePlayerId);
    const oldActiveWidgetContent = oldActivePlaceholder ? oldActivePlaceholder.closest('.grid-stack-item-content') : null;

    if (oldActiveWidgetContent) {
        oldActiveWidgetContent.classList.remove('active-player');
        const oldVideo = oldActiveWidgetContent.querySelector('video');
        if (oldVideo) oldVideo.muted = true;
        oldActiveWidgetContent.querySelectorAll('.mute-btn').forEach(b => { b.innerHTML = ICONS.mute; });
        updateWidgetAudioPill(oldActiveWidgetContent, false, true);
    }

    const newActivePlaceholder = document.getElementById(widgetId);
    const newActiveWidgetContent = newActivePlaceholder ? newActivePlaceholder.closest('.grid-stack-item-content') : null;

    if (newActiveWidgetContent) {
        newActiveWidgetContent.classList.add('active-player');
        const videoEl = newActiveWidgetContent.querySelector('video');
        if (videoEl && !newActiveWidgetContent.classList.contains('is-empty')) {
            videoEl.muted = false;
            newActiveWidgetContent.querySelectorAll('.mute-btn').forEach(b => { b.innerHTML = ICONS.unmute; });
            updateWidgetAudioPill(newActiveWidgetContent, true, false);
        }
    }
    activePlayerId = widgetId;
    syncMultiviewActiveStreamToNative();
}

/**
 * Starts playing a selected channel in a specific player widget.
 * @param {string} widgetId - The ID of the target player.
 * @param {object} channel - The channel object with id, name, and url.
 * @param {HTMLElement} gridstackItemContentEl - The player widget's content container.
 */
async function playChannelInWidget(widgetId, channel, gridstackItemContentEl) {
    if (!gridstackItemContentEl) return;

    // Await the cleanup of the previous player to prevent race conditions
    await stopAndCleanupPlayer(widgetId, false);

    const videoEl = gridstackItemContentEl.querySelector('video');
    const playerPlaceholderEl = gridstackItemContentEl.querySelector(`.player-placeholder[id="${widgetId}"]`);
    const titleEl = gridstackItemContentEl.querySelector('.player-header-title');
    const bottomHudEl = gridstackItemContentEl.querySelector('.player-bottom-hud');
    const statusPillEl = gridstackItemContentEl.querySelector('.player-status-pill');
    const statusNameEl = gridstackItemContentEl.querySelector('.player-status-name');

    titleEl.textContent = channel.name;
    if (statusNameEl) statusNameEl.textContent = channel.name;
    if (bottomHudEl) bottomHudEl.classList.remove('hidden');
    if (statusPillEl) statusPillEl.classList.remove('hidden');

    gridstackItemContentEl.classList.remove('is-empty');
    revealWidgetHudTemporarily(gridstackItemContentEl, widgetId);

    if (playerPlaceholderEl) {
        playerPlaceholderEl.dataset.channelId = channel.id;
        playerPlaceholderEl.classList.add('hidden');
    }

    playerUrls.set(widgetId, channel.url);
    videoEl.classList.remove('hidden');

    updatePlayerCountBadge();
    renderDrawerChannels();
    refreshAllEmptyPlaceholders();

    const settings = guideState.settings;
    const userAgentId = settings.activeUserAgentId;
    const isVOD = isVODFile(channel.url);

    let profileIdToUse;
    let streamUrlToPlay;
    let useNativeVideo = false;
    let isRedirectStream = false;

    if (isVOD) {
        const hasNVIDIA = settings.hasNvidiaGpu;
        profileIdToUse = hasNVIDIA ? 'ffmpeg-fmp4-nvidia' : 'ffmpeg-fmp4';
        streamUrlToPlay = `/stream?url=${encodeURIComponent(channel.url)}&profileId=${profileIdToUse}&userAgentId=${userAgentId}`;
        useNativeVideo = true;
    } else {
        profileIdToUse = settings.activeStreamProfileId;
        const profile = (settings.streamProfiles || []).find(p => p.id === profileIdToUse);

        if (!profile) {
            showNotification('Active stream profile not found in settings.', true);
            return;
        }

        isRedirectStream = profile.command === 'redirect';
        streamUrlToPlay = isRedirectStream
            ? channel.url
            : `/stream?url=${encodeURIComponent(channel.url)}&profileId=${profileIdToUse}&userAgentId=${userAgentId}`;

        if (isRedirectStream) {
            const historyId = await startRedirectStream(channel.url, channel.id, channel.name, channel.logo);
            if (historyId) {
                redirectHistoryIds.set(widgetId, historyId);
                startMultiviewHeartbeats();
            }
        }
    }

    const absoluteStreamUrl = streamUrlToPlay.startsWith('http')
        ? streamUrlToPlay
        : `${window.location.origin}${streamUrlToPlay.startsWith('/') ? '' : '/'}${streamUrlToPlay}`;
    const absoluteLogo = channel.logo
        ? (channel.logo.startsWith('http') ? channel.logo : `${window.location.origin}${channel.logo.startsWith('/') ? '' : '/'}${channel.logo}`)
        : '';

    playerChannelMeta.set(widgetId, {
        streamUrl: absoluteStreamUrl,
        rawUrl: channel.url,
        profileId: profileIdToUse,
        userAgentId: userAgentId,
        isRedirect: isRedirectStream,
        title: channel.name,
        subtitle: 'MultiView · Live TV',
        logo: absoluteLogo,
        channelId: channel.id || null,
        mediaType: 'live',
        isLive: !isVOD,
        startTime: 0,
        duration: 0,
        timeshiftJobId: null,
        contentType: null,
        contentId: null,
        isTranscodedVod: false
    });

    if (useNativeVideo) {
        videoEl.src = streamUrlToPlay;

        videoEl.addEventListener('error', (e) => {
            console.error(`[MultiView] Native video error for ${widgetId}:`, e);
            if (!document.hidden) {
                showNotification(`Could not play file: ${channel.name}`, true);
            }
            stopAndCleanupPlayer(widgetId, true);
        }, { once: true });

        try {
            await videoEl.play();
            setActivePlayer(widgetId);
        } catch (err) {
            if (err.name !== 'AbortError') {
                console.error(`[MultiView] VOD playback error for ${widgetId}:`, err);
                if (!document.hidden) {
                    showNotification(`Could not play file: ${channel.name}`, true);
                }
                stopAndCleanupPlayer(widgetId, true);
            }
        }
    } else {
        if (mpegts.isSupported()) {
            const mpegtsConfig = {
                enableStashBuffer: true,
                stashInitialSize: 4096,
                liveBufferLatency: 2.0,
            };

            const player = mpegts.createPlayer({
                type: 'mse',
                isLive: true,
                url: streamUrlToPlay
            }, mpegtsConfig);

            player.on(mpegts.Events.ERROR, (errorType, errorDetail) => {
                console.error(`[MultiView] MPEGTS Player Error for ${widgetId}:`, errorType, errorDetail);
                if (!document.hidden) {
                    showNotification(`Could not play stream: ${channel.name}`, true);
                }
                stopAndCleanupPlayer(widgetId, true);
            });

            players.set(widgetId, player);
            player.attachMediaElement(videoEl);
            player.load();

            try {
                await player.play();
                setActivePlayer(widgetId);
            } catch (err) {
                if (err.name !== 'AbortError') {
                    console.error(`[MultiView] player.play() caught an error for ${widgetId}:`, err);
                    if (!document.hidden) {
                        showNotification(`Could not play stream: ${channel.name}`, true);
                    }
                    stopAndCleanupPlayer(widgetId, true);
                }
            }
        } else {
            showNotification('Your browser does not support Media Source Extensions (MSE).', true);
        }
    }

    updatePlayerCountBadge();
}

/**
 * Stops the stream and cleans up resources for a specific player widget.
 * @param {string} widgetId - The ID of the player.
 * @param {boolean} resetUI - If true, resets the widget's UI to the empty placeholder state.
 */
async function stopAndCleanupPlayer(widgetId, resetUI = true) {
    const stopPromises = [];
    playerChannelMeta.delete(widgetId);
    syncMultiviewActiveStreamToNative();

    if (redirectHistoryIds.has(widgetId)) {
        stopPromises.push(stopRedirectStream(redirectHistoryIds.get(widgetId)));
        redirectHistoryIds.delete(widgetId);
        checkAndStopMultiviewHeartbeats();
    }

    if (playerUrls.has(widgetId)) {
        const originalUrl = playerUrls.get(widgetId);
        console.log(`[MultiView] Sending stop request for widget ${widgetId}, URL: ${originalUrl}`);
        stopPromises.push(stopStream(originalUrl));
        playerUrls.delete(widgetId);
    }

    if (players.has(widgetId)) {
        const player = players.get(widgetId);
        players.delete(widgetId);

        Promise.resolve().then(() => {
            try {
                player.pause();
                player.unload();
                player.detachMediaElement();
                player.destroy();
            } catch (e) {
                console.warn(`[MultiView] Non-critical error during player cleanup for widget ${widgetId}:`, e.message);
            }
        });
    }

    await Promise.all(stopPromises);

    if (resetUI) {
        const playerPlaceholderEl = document.getElementById(widgetId);
        const widgetContentEl = playerPlaceholderEl ? playerPlaceholderEl.closest('.grid-stack-item-content') : null;

        if (widgetContentEl) {
            widgetContentEl.classList.add('is-empty');
            const videoEl = widgetContentEl.querySelector('video');
            if (videoEl) {
                videoEl.src = '';
                videoEl.removeAttribute('src');
                videoEl.load();
                videoEl.classList.add('hidden');
            }
            if (playerPlaceholderEl) {
                playerPlaceholderEl.classList.remove('hidden');
                playerPlaceholderEl.dataset.channelId = '';
            }
            const bottomHudEl = widgetContentEl.querySelector('.player-bottom-hud');
            if (bottomHudEl) bottomHudEl.classList.add('hidden');
            const statusPillEl = widgetContentEl.querySelector('.player-status-pill');
            if (statusPillEl) statusPillEl.classList.add('hidden');
        }
        updatePlayerCountBadge();
        renderDrawerChannels();
        refreshAllEmptyPlaceholders();
    }
}

/**
 * Populates the fallback channel selector modal (used by DVR Manual Recording & Admin stream switching).
 */
export function populateChannelSelector() {
    if (UIElements.multiviewSourceListBtn) {
        UIElements.multiviewSourceListBtn.click();
    }

    const listEl = UIElements.channelSelectorList;
    const filter = UIElements.multiviewChannelFilter?.value || 'all';
    const searchTerm = (UIElements.channelSelectorSearch?.value || '').trim().toLowerCase();
    if (!listEl) return;

    let channelsToDisplay = [];

    if (filter === 'favorites') {
        const favoriteIds = new Set(guideState.settings.favorites || []);
        channelsToDisplay = guideState.channels.filter(ch => favoriteIds.has(ch.id));
    } else if (filter === 'recents') {
        const recentIds = guideState.settings.recentChannels || [];
        channelsToDisplay = recentIds.map(id => guideState.channels.find(ch => ch.id === id)).filter(Boolean);
    } else {
        channelsToDisplay = [...guideState.channels];
    }

    if (searchTerm) {
        channelsToDisplay = channelsToDisplay.filter(c =>
            (c.displayName || c.name).toLowerCase().includes(searchTerm) ||
            (c.group && c.group.toLowerCase().includes(searchTerm))
        );
    }

    if (channelsToDisplay.length === 0) {
        listEl.innerHTML = `<p class="text-center text-gray-500 p-4">No channels found.</p>`;
        return;
    }

    listEl.innerHTML = channelsToDisplay.map(channel => `
        <div class="channel-item flex items-center p-2 rounded-md hover:bg-gray-700 cursor-pointer" 
             data-id="${escapeHtml(channel.id)}" 
             data-name="${escapeHtml(channel.displayName || channel.name)}" 
             data-url="${escapeHtml(channel.url)}"
             data-logo="${escapeHtml(channel.logo || '')}">
            <img src="${proxiedImageUrl(channel.logo) || 'https://placehold.co/40x40/1f2937/d1d5db?text=?'}" onerror="this.onerror=null; this.src='https://placehold.co/40x40/1f2937/d1d5db?text=?';" class="w-10 h-10 object-contain mr-3 rounded-md bg-gray-700 flex-shrink-0">
            <div class="overflow-hidden">
                <p class="font-semibold text-white text-sm truncate">${escapeHtml(channel.displayName || channel.name)}</p>
                <p class="text-gray-400 text-xs truncate">${escapeHtml(channel.group || 'Uncategorized')}</p>
            </div>
        </div>
    `).join('');
}

// --- Saved Layout Management ---

/**
 * Fetches saved layouts from the server.
 */
async function loadLayouts() {
    const res = await apiFetch('/api/multiview/layouts');
    if (!res || !res.ok) {
        showNotification('Could not load saved layouts.', true);
        return;
    }
    const layouts = await res.json();
    guideState.settings.multiviewLayouts = layouts;
    populateLayoutsDropdown();
}

/**
 * Populates the 'Saved Layouts' dropdown.
 */
function populateLayoutsDropdown() {
    const select = UIElements.savedLayoutsSelect;
    if (!select) return;
    select.innerHTML = '<option value="" disabled selected>Saved Layouts...</option>';
    (guideState.settings.multiviewLayouts || []).forEach(layout => {
        const option = document.createElement('option');
        option.value = layout.id;
        option.textContent = layout.name;
        select.appendChild(option);
    });
}

/**
 * Saves the current grid layout.
 * @param {Event} e - The form submission event.
 */
async function saveLayout(e) {
    e.preventDefault();
    const name = UIElements.saveLayoutName.value.trim();
    if (!name) {
        showNotification('Layout name cannot be empty.', true);
        return;
    }

    const gridItems = grid.getGridItems();
    if (gridItems.length === 0) {
        showNotification('Cannot save an empty layout.', true);
        return;
    }

    const layoutData = gridItems.map(item => {
        const node = item.gridstackNode;
        const placeholder = item.querySelector('.player-placeholder');
        return {
            x: node.x,
            y: node.y,
            w: node.w,
            h: node.h,
            gridRows: GRID_ROWS,
            id: placeholder?.id || node.id,
            channelId: placeholder?.dataset.channelId || null
        };
    });

    const res = await apiFetch('/api/multiview/layouts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, layout_data: layoutData }),
    });

    if (res && res.ok) {
        showNotification('Layout saved successfully!');
        closeModal(UIElements.saveLayoutModal);
        UIElements.saveLayoutForm.reset();
        loadLayouts();
    }
}

/**
 * Loads a selected layout from the dropdown.
 * Automatically scales legacy 9-row layouts to the 24-row grid.
 */
function loadSelectedLayout() {
    const layoutId = UIElements.savedLayoutsSelect?.value;
    if (!layoutId) {
        showNotification('Please select a saved layout first.', true);
        return;
    }

    const layout = (guideState.settings.multiviewLayouts || []).find(l => l.id == layoutId);
    if (!layout) {
        showNotification('Selected layout not found.', true);
        return;
    }

    const executeLoad = async () => {
        await cleanupMultiView(true);
        setLayoutModeUI('freeform');
        isProgrammaticLayoutUpdate = true;
        grid.batchUpdate();
        try {
            const items = layout.layout_data || [];
            // Detect legacy layouts saved before 24-row upgrade (where max y+h <= 12 and gridRows !== 24)
            const isLegacyScale = items.length > 0 && !items[0].gridRows && items.every(w => (w.y + w.h) <= 12);
            const scaleFactor = isLegacyScale ? 2 : 1;

            items.forEach(widgetData => {
                const scaledData = {
                    ...widgetData,
                    y: (widgetData.y || 0) * scaleFactor,
                    h: (widgetData.h || 4) * scaleFactor
                };
                const channel = widgetData.channelId ? guideState.channels.find(c => c.id === widgetData.channelId) : null;
                addPlayerWidget(channel, scaledData, true);
            });
        } finally {
            grid.commit();
            isProgrammaticLayoutUpdate = false;
            recalculateGridCellHeight();
            updatePlayerCountBadge();
        }
    };

    if (isMultiViewActive()) {
        showConfirm(
            `Load '${layout.name}'?`,
            'This will replace your current streams with the saved layout. Continue?',
            executeLoad
        );
    } else {
        executeLoad();
    }
}

/**
 * Deletes the currently selected layout.
 */
async function deleteLayout() {
    const layoutId = UIElements.savedLayoutsSelect?.value;
    if (!layoutId) {
        showNotification('Please select a layout to delete.', true);
        return;
    }

    showConfirm('Delete Layout?', 'Are you sure you want to delete this saved layout?', async () => {
        const res = await apiFetch(`/api/multiview/layouts/${layoutId}`, { method: 'DELETE' });
        if (res && res.ok) {
            showNotification('Layout deleted successfully.');
            loadLayouts();
        }
    });
}
