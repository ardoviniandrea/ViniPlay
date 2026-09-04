/**
 * multiview.js
 * Manages all functionality for the Multi-View page.
 * Uses Gridstack.js for the draggable and resizable player grid.
 */

import { appState, guideState, UIElements } from './state.js';
import { apiFetch, stopStream, startRedirectStream, stopRedirectStream } from './api.js';
import { showNotification, openModal, closeModal, showConfirm } from './ui.js';
import { ICONS } from './icons.js';
import { proxiedImageUrl } from './utils.js';

let grid;
const players = new Map();
const playerUrls = new Map();
let activePlayerId = null;
let channelSelectorCallback = null;
let lastLayoutBeforeHide = null; // To store layout when tab is hidden
let immersiveHeaderTimeout = null; // NEW: Timer for immersive mode header

const MAX_PLAYERS = 9;
const redirectHistoryIds = new Map(); // To track redirect streams for logging

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
 * NEW: A less aggressive cleanup function specifically for when the tab is hidden.
 * It pauses players and stops server streams without destroying the player instances,
 * which can cause race conditions with the browser's media suspension.
 */
async function pauseAndClearAllPlayers() {
    // 1. Save the layout for potential restoration
    if (grid) {
        const gridItems = grid.getGridItems();
        lastLayoutBeforeHide = gridItems.map(item => {
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
        });
    }

    // 2. Stop server-side streams and pause client-side players
    const stopPromises = [];
    for (const [widgetId, player] of players.entries()) {
        // Stop the server-side ffmpeg process
        if (playerUrls.has(widgetId)) {
            const originalUrl = playerUrls.get(widgetId);
            console.log(`[MultiView] Tab Hide: Sending stop request for widget ${widgetId}, URL: ${originalUrl}`);
            stopPromises.push(stopStream(originalUrl));
        }

        // Safely detach and pause the client-side player
        try {
            player.pause();
            player.detachMediaElement();
        } catch (e) {
            console.warn(`[MultiView] Tab Hide: Error pausing player for widget ${widgetId}. It might already be detached.`, e);
        }
    }

    // Wait for all server stop requests to be sent
    await Promise.all(stopPromises);
    console.log('[MultiView] Tab Hide: All server streams have been requested to stop.');

    // 3. Clear the state and UI
    players.clear();
    playerUrls.clear();
    activePlayerId = null;
    if (grid) {
        grid.removeAll(); // This removes the widgets from the view
    }
}


/**
 * Handles the visibility change of the tab to prevent crashes.
 */
const handleVisibilityChange = async () => {
    if (document.hidden) {
        if (isMultiViewActive()) {
            console.log('[MultiView] Tab hidden. Pausing all streams and cleaning up UI.');
            // Use the new, safer cleanup for tab switching.
            await pauseAndClearAllPlayers();
        }
    } else {
        if (lastLayoutBeforeHide) {
            console.log('[MultiView] Tab visible. Offering to restore previous session.');
            showConfirm(
                'Restore Session?',
                'Would you like to restore your previous Multi-View session?',
                () => {
                    if (lastLayoutBeforeHide) {
                        grid.batchUpdate();
                        try {
                            lastLayoutBeforeHide.forEach(widgetData => {
                                const channel = widgetData.channelId ? guideState.channels.find(c => c.id === widgetData.channelId) : null;
                                addPlayerWidget(channel, widgetData);
                            });
                        } finally {
                            grid.commit();
                            lastLayoutBeforeHide = null; // Clear after restoring
                        }
                    }
                },
                () => {
                    lastLayoutBeforeHide = null; // Clear if user cancels
                }
            );
        }
    }
};


/**
 * Initializes the Multi-View page, sets up the grid and event listeners.
 */
export function initMultiView() {
    // Add the visibility change listener when the page is active.
    document.addEventListener('visibilitychange', handleVisibilityChange);

    if (grid) {
        loadLayouts();
        return;
    }

    console.log('[MultiView] Initializing for the first time.');
    const options = {
        float: true,
        cellHeight: '8vh',
        margin: 5,
        column: 12,
        alwaysShowResizeHandle: 'mobile',
        resizable: { handles: 'e, se, s, sw, w' }
    };
    grid = GridStack.init(options, '#multiview-grid');

    updateGridBackground();
    grid.on('change', updateGridBackground);

    setupMultiViewEventListeners();
    loadLayouts();
}

/**
 * Checks if there are any active players on the Multi-View page.
 * @returns {boolean} True if at least one player exists.
 */
export function isMultiViewActive() {
    return players.size > 0;
}

/**
 * Destroys all players, clears the grid, and resets the Multi-View state.
 */
export async function cleanupMultiView() {
    // Remove the visibility change listener when leaving the page.
    document.removeEventListener('visibilitychange', handleVisibilityChange);

    if (grid) {
        console.log('[MultiView] Cleaning up all players and grid.');
        const stopPromises = Array.from(players.keys()).map(widgetId => stopAndCleanupPlayer(widgetId, true));
        await Promise.all(stopPromises);
        console.log('[MultiView] All streams have been stopped and players cleaned up.');
        grid.removeAll();
    }
    players.clear();
    playerUrls.clear();
    // Stop any active redirect logging sessions
    for (const historyId of redirectHistoryIds.values()) {
        stopRedirectStream(historyId);
    }
    redirectHistoryIds.clear();
    activePlayerId = null;
    channelSelectorCallback = null;
    lastLayoutBeforeHide = null; // A full cleanup should clear this
    console.log('[MultiView] Cleanup complete.');
}

/**
 * Adjusts the grid's background pattern size.
 */
function updateGridBackground() {
    const container = UIElements.multiviewContainer.querySelector('.grid-stack');
    if (!container) return;
    const columnWidth = container.offsetWidth / grid.getColumn();
    container.style.backgroundSize = `${columnWidth}px ${columnWidth}px`;
}

/**
 * NEW: Toggles the immersive mode for the Multi-View page.
 * @param {boolean} isImmersive - True to enable immersive mode, false to disable.
 */
function setImmersiveMode(isImmersive) {
    const appContainer = UIElements.appContainer;
    if (!appContainer) return;

    appContainer.classList.toggle('multiview-immersive', isImmersive);
    if (grid) {
        // A short delay before updating the grid ensures the CSS transition for the header is complete,
        // so Gridstack can calculate the new available height correctly.
        setTimeout(() => grid.onParentResize(), 300);
    }
}

/**
 * NEW: Handles showing and auto-hiding the header when in immersive mode.
 */
function handleImmersiveHeaderOverlay(e) {
    const appContainer = UIElements.appContainer;
    const multiviewHeader = UIElements.multiviewHeader;
    if (!appContainer || !multiviewHeader || !appContainer.classList.contains('multiview-immersive')) {
        return;
    }

    // Show header if mouse is near the top of the screen
    if (e.clientY < 80) {
        multiviewHeader.classList.add('overlay-visible');
        // Clear any existing timer
        if (immersiveHeaderTimeout) {
            clearTimeout(immersiveHeaderTimeout);
        }
        // Set a new timer to hide it again
        immersiveHeaderTimeout = setTimeout(() => {
            multiviewHeader.classList.remove('overlay-visible');
        }, 3000); // Hide after 3 seconds of inactivity
    }
}


/**
 * Sets up global event listeners for the Multi-View page controls.
 */
function setupMultiViewEventListeners() {
    UIElements.multiviewAddPlayer.addEventListener('click', () => addPlayerWidget());
    UIElements.multiviewRemovePlayer.addEventListener('click', removeLastPlayer);
    UIElements.layoutBtnAuto.addEventListener('click', () => applyPresetLayout('auto'));
    UIElements.layoutBtn2x2.addEventListener('click', () => applyPresetLayout('2x2'));
    UIElements.layoutBtn1x3.addEventListener('click', () => applyPresetLayout('1x3'));
    UIElements.multiviewSaveLayoutBtn.addEventListener('click', () => openModal(UIElements.saveLayoutModal));
    UIElements.multiviewLoadLayoutBtn.addEventListener('click', loadSelectedLayout);
    UIElements.multiviewDeleteLayoutBtn.addEventListener('click', deleteLayout);
    UIElements.saveLayoutForm.addEventListener('submit', saveLayout);
    UIElements.saveLayoutCancelBtn.addEventListener('click', () => closeModal(UIElements.saveLayoutModal));

    // --- NEW: Custom URL Tab Switching ---
    UIElements.multiviewSourceListBtn?.addEventListener('click', () => {
        UIElements.multiviewSourceListBtn.classList.add('bg-gray-700', 'text-white', 'font-medium');
        UIElements.multiviewSourceListBtn.classList.remove('text-gray-300');
        UIElements.multiviewSourceCustomBtn.classList.remove('bg-gray-700', 'text-white', 'font-medium');
        UIElements.multiviewSourceCustomBtn.classList.add('text-gray-300');

        // Show channel list elements
        UIElements.channelSelectorList.classList.remove('hidden');
        UIElements.channelSelectorSearch.classList.remove('hidden');
        // Show the filter dropdown container (parent of the select and h3)
        const filterContainer = UIElements.multiviewChannelFilter.closest('.flex.justify-between');
        if (filterContainer) filterContainer.classList.remove('hidden');

        // Hide custom URL container
        UIElements.multiviewCustomUrlContainer.classList.add('hidden');
    });

    UIElements.multiviewSourceCustomBtn?.addEventListener('click', () => {
        UIElements.multiviewSourceCustomBtn.classList.add('bg-gray-700', 'text-white', 'font-medium');
        UIElements.multiviewSourceCustomBtn.classList.remove('text-gray-300');
        UIElements.multiviewSourceListBtn.classList.remove('bg-gray-700', 'text-white', 'font-medium');
        UIElements.multiviewSourceListBtn.classList.add('text-gray-300');

        // Hide channel list elements
        UIElements.channelSelectorList.classList.add('hidden');
        UIElements.channelSelectorSearch.classList.add('hidden');
        // Hide the filter dropdown container (parent of the select and h3)
        const filterContainer = UIElements.multiviewChannelFilter.closest('.flex.justify-between');
        if (filterContainer) filterContainer.classList.add('hidden');

        // Show custom URL container
        UIElements.multiviewCustomUrlContainer.classList.remove('hidden');
    });

    // --- NEW: Handle custom URL play button ---
    UIElements.multiviewCustomUrlPlayBtn?.addEventListener('click', () => {
        const url = UIElements.multiviewCustomUrlInput.value.trim();
        const name = UIElements.multiviewCustomNameInput.value.trim() || 'Custom Stream';

        if (!url) {
            showNotification('Please enter a stream URL', true);
            return;
        }

        // Create a temporary channel object
        const customChannel = {
            id: `custom-${Date.now()}`,
            name: name,
            url: url,
            logo: 'https://placehold.co/40x40/1f2937/d1d5db?text=URL'
        };

        // Call the callback (same as clicking a channel from list)
        if (channelSelectorCallback) {
            channelSelectorCallback(customChannel);
            closeModal(UIElements.multiviewChannelSelectorModal);

            // Clear inputs
            UIElements.multiviewCustomUrlInput.value = '';
            UIElements.multiviewCustomNameInput.value = '';
        }
    });

    // --- NEW: Immersive Mode Event Listeners ---
    const immersiveToggle = document.getElementById('immersive-mode-toggle');
    if (immersiveToggle) {
        immersiveToggle.addEventListener('change', (e) => {
            setImmersiveMode(e.target.checked);
        });
    }

    // Add mousemove listener to the main app container to detect when to show the header
    const appContainer = UIElements.appContainer;
    if (appContainer) {
        appContainer.addEventListener('mousemove', handleImmersiveHeaderOverlay);
    }
}

/**
 * Handles the channel selection logic for the Multi-View page.
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
 * Creates and adds a new player widget to the grid.
 * @param {object|null} channel - Optional channel to auto-load.
 * @param {object|null} layout - Optional layout data for the widget.
 * @returns {HTMLElement} The added widget element.
 */
function addPlayerWidget(channel = null, layout = {}) {
    if (grid.getGridItems().length >= MAX_PLAYERS) {
        showNotification(`You can add a maximum of ${MAX_PLAYERS} players.`, true);
        return null;
    }

    const widgetId = layout.id || `player-${Date.now()}`;
    const widgetHTML = `
        <div class="player-header">
            <span class="player-header-title">No Channel</span>
            <div class="player-controls">
                <button class="select-channel-btn" title="Select Channel">${ICONS.selectChannel}</button>
                <button class="play-pause-btn" title="Play/Pause">${ICONS.pause}</button>
                <button class="mute-btn" title="Mute">${ICONS.unmute}</button>
                <input type="range" min="0" max="1" step="0.05" value="0.5" class="volume-slider">
                <button class="fullscreen-btn" title="Fullscreen">${ICONS.fullscreen}</button>
                <button class="stop-btn" title="Stop Channel">${ICONS.stop}</button>
                <button class="remove-widget-btn" title="Remove Player">${ICONS.removeWidget}</button>
            </div>
        </div>
        <div class="player-body">
            <div class="player-placeholder" id="${widgetId}" data-channel-id="">
                ${ICONS.placeholderPlay}
                <span>Click to Select Channel</span>
            </div>
            <video class="hidden w-full h-full object-contain" muted></video>
        </div>
    `;

    const newWidgetEl = grid.addWidget({
        id: widgetId,
        content: widgetHTML,
        w: layout.w || 4,
        h: layout.h || 4,
        x: layout.x,
        y: layout.y
    });

    const widgetContentEl = newWidgetEl.querySelector('.grid-stack-item-content');
    if (widgetContentEl) {
        attachWidgetEventListeners(widgetContentEl, widgetId);
    }

    if (channel) {
        playChannelInWidget(widgetId, channel, widgetContentEl);
    }
    return newWidgetEl;
}

/**
 * Removes the most recently added player from the grid.
 */
async function removeLastPlayer() {
    const items = grid.getGridItems();
    if (items.length > 0) {
        const sortedItems = items.sort((a, b) => {
            const timeA = parseInt((a.gridstackNode.id || '0').split('-')[1]);
            const timeB = parseInt((b.gridstackNode.id || '0').split('-')[1]);
            return timeA - timeB;
        });
        const lastItem = sortedItems[sortedItems.length - 1];
        if (lastItem) {
            const playerPlaceholder = lastItem.querySelector('.player-placeholder');
            const widgetId = playerPlaceholder ? playerPlaceholder.id : lastItem.gridstackNode.id;

            await stopAndCleanupPlayer(widgetId);
            grid.removeWidget(lastItem);
            console.log(`[MultiView] Removed last player: ${widgetId}`);
        }
    } else {
        showNotification("No players to remove.", false);
    }
}


/**
 * Applies a predefined layout to the player grid.
 * @param {'auto'|'2x2'|'1x3'} layoutName - The name of the layout to apply.
 */
function applyPresetLayout(layoutName) {
    const numPlayers = grid.getGridItems().length;

    if (layoutName === 'auto' && numPlayers === 0) {
        addPlayerWidget();
        return;
    }

    const createLayout = async () => {
        await cleanupMultiView();

        let layout = [];

        if (layoutName === 'auto') {
            let cols, rows;
            if (numPlayers <= 1) { cols = 1; rows = 1; }
            else if (numPlayers === 2) { cols = 2; rows = 1; }
            else if (numPlayers === 3) { cols = 3; rows = 1; }
            else if (numPlayers === 4) { cols = 2; rows = 2; }
            else if (numPlayers >= 5 && numPlayers <= 6) { cols = 3; rows = 2; }
            else { cols = 3; rows = 3; }

            const widgetWidth = Math.floor(12 / cols);
            const totalGridHeight = 9;
            const widgetHeight = Math.floor(totalGridHeight / rows);

            for (let i = 0; i < numPlayers; i++) {
                const row = Math.floor(i / cols);
                const col = i % cols;
                layout.push({
                    x: col * widgetWidth,
                    y: row * widgetHeight,
                    w: widgetWidth,
                    h: widgetHeight
                });
            }
        } else if (layoutName === '2x2') {
            layout = [
                { x: 0, y: 0, w: 6, h: 5 }, { x: 6, y: 0, w: 6, h: 5 },
                { x: 0, y: 5, w: 6, h: 5 }, { x: 6, y: 5, w: 6, h: 5 }
            ];
        } else if (layoutName === '1x3') {
            const largeHeight = 9;
            const smallHeight = 3;
            layout = [
                { x: 0, y: 0, w: 8, h: largeHeight },
                { x: 8, y: 0, w: 4, h: smallHeight },
                { x: 8, y: smallHeight, w: 4, h: smallHeight },
                { x: 8, y: smallHeight * 2, w: 4, h: smallHeight }
            ];
        }

        grid.batchUpdate();
        try {
            layout.forEach(widgetLayout => {
                addPlayerWidget(null, widgetLayout);
            });
        } finally {
            grid.commit();
        }
    };

    if (numPlayers > 0) {
        showConfirm(
            `Apply '${layoutName}' Layout?`,
            "This will stop all current streams and apply the new layout with empty players. Are you sure?",
            createLayout
        );
    } else {
        createLayout();
    }
}

/**
 * Attaches event listeners to the controls within a player widget.
 * @param {HTMLElement} widgetContentEl - The widget's .grid-stack-item-content element.
 * @param {string} widgetId - The unique ID of the widget.
 */
function attachWidgetEventListeners(widgetContentEl, widgetId) {
    const playerPlaceholderEl = widgetContentEl.querySelector(`.player-placeholder[id="${widgetId}"]`);
    const videoEl = widgetContentEl.querySelector('video');
    const gridStackItem = widgetContentEl.closest('.grid-stack-item');

    const openSelector = () => {
        if (document.body.dataset.channelSelectorContext) {
            delete document.body.dataset.channelSelectorContext;
        }
        channelSelectorCallback = (channel) => playChannelInWidget(widgetId, channel, widgetContentEl);
        populateChannelSelector();
        openModal(UIElements.multiviewChannelSelectorModal);
    };

    widgetContentEl.querySelector('.select-channel-btn').addEventListener('click', openSelector);
    if (playerPlaceholderEl) {
        playerPlaceholderEl.addEventListener('click', openSelector);
    }

    widgetContentEl.querySelector('.stop-btn').addEventListener('click', (e) => {
        e.stopPropagation();
        stopAndCleanupPlayer(widgetId, true);
    });

    widgetContentEl.querySelector('.remove-widget-btn').addEventListener('click', (e) => {
        e.stopPropagation();
        stopAndCleanupPlayer(widgetId, true);
        if (gridStackItem) {
            grid.removeWidget(gridStackItem);
        }
    });

    const muteBtn = widgetContentEl.querySelector('.mute-btn');
    muteBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        videoEl.muted = !videoEl.muted;
        muteBtn.innerHTML = videoEl.muted ? ICONS.mute : ICONS.unmute;
    });

    const playPauseBtn = widgetContentEl.querySelector('.play-pause-btn');
    playPauseBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        if (videoEl.paused) {
            videoEl.play();
            playPauseBtn.innerHTML = ICONS.pause;
        } else {
            videoEl.pause();
            playPauseBtn.innerHTML = ICONS.play;
        }
    });

    // Update play/pause button icon based on video state
    videoEl.addEventListener('play', () => {
        playPauseBtn.innerHTML = ICONS.pause;
    });
    videoEl.addEventListener('pause', () => {
        playPauseBtn.innerHTML = ICONS.play;
    });

    widgetContentEl.querySelector('.volume-slider').addEventListener('input', (e) => {
        e.stopPropagation();
        videoEl.volume = parseFloat(e.target.value);
        if (videoEl.volume > 0) {
            videoEl.muted = false;
            muteBtn.innerHTML = ICONS.unmute;
        }
    });

    widgetContentEl.querySelector('.fullscreen-btn').addEventListener('click', (e) => {
        e.stopPropagation();
        if (videoEl.requestFullscreen) {
            videoEl.requestFullscreen();
        }
    });

    widgetContentEl.addEventListener('click', () => {
        setActivePlayer(widgetId);
    });
}

/**
 * Sets the currently active player, highlighting it and handling audio.
 * @param {string} widgetId - The ID of the player to set as active.
 */
function setActivePlayer(widgetId) {
    if (activePlayerId === widgetId) return;

    const oldActivePlaceholder = document.getElementById(activePlayerId);
    const oldActiveWidgetContent = oldActivePlaceholder ? oldActivePlaceholder.closest('.grid-stack-item-content') : null;

    if (oldActiveWidgetContent) {
        oldActiveWidgetContent.classList.remove('active-player');
        const oldVideo = oldActiveWidgetContent.querySelector('video');
        if (oldVideo) oldVideo.muted = true;
        const oldMuteBtn = oldActiveWidgetContent.querySelector('.mute-btn');
        if (oldMuteBtn) oldMuteBtn.innerHTML = ICONS.mute;
    }

    const newActivePlaceholder = document.getElementById(widgetId);
    const newActiveWidgetContent = newActivePlaceholder ? newActivePlaceholder.closest('.grid-stack-item-content') : null;

    if (newActiveWidgetContent) {
        newActiveWidgetContent.classList.add('active-player');
        const videoEl = newActiveWidgetContent.querySelector('video');
        if (videoEl) {
            videoEl.muted = false;
            const newMuteBtn = newActiveWidgetContent.querySelector('.mute-btn');
            if (newMuteBtn) newMuteBtn.innerHTML = ICONS.unmute;
        }
    }
    activePlayerId = widgetId;
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

    titleEl.textContent = channel.name;
    if (playerPlaceholderEl) {
        playerPlaceholderEl.dataset.channelId = channel.id;
    }

    playerUrls.set(widgetId, channel.url);
    console.log(`[MultiView] Stored URL for widget ${widgetId}: ${channel.url}`);

    videoEl.classList.remove('hidden');
    if (playerPlaceholderEl) {
        playerPlaceholderEl.classList.add('hidden');
    }

    const settings = guideState.settings;
    const userAgentId = settings.activeUserAgentId;

    // NEW: Detect if this is a VOD file
    const isVOD = isVODFile(channel.url);
    console.log(`[MultiView] URL type for ${widgetId}: ${isVOD ? 'VOD file' : 'Live stream'}`);

    let profileIdToUse;
    let streamUrlToPlay;
    let useNativeVideo = false;

    if (isVOD) {
        // For VOD files, auto-select fMP4 profile (same as Direct Player)
        const hasNVIDIA = settings.hasNvidiaGpu;
        profileIdToUse = hasNVIDIA ? 'ffmpeg-fmp4-nvidia' : 'ffmpeg-fmp4';
        console.log(`[MultiView] Auto-selected ${hasNVIDIA ? 'NVIDIA' : 'CPU'} fMP4 profile for VOD`);

        streamUrlToPlay = `/stream?url=${encodeURIComponent(channel.url)}&profileId=${profileIdToUse}&userAgentId=${userAgentId}`;
        useNativeVideo = true;
    } else {
        // For live streams, use existing logic
        profileIdToUse = settings.activeStreamProfileId;
        const profile = (settings.streamProfiles || []).find(p => p.id === profileIdToUse);

        if (!profile) {
            showNotification("Active stream profile not found in settings.", true);
            return;
        }

        streamUrlToPlay = profile.command === 'redirect'
            ? channel.url
            : `/stream?url=${encodeURIComponent(channel.url)}&profileId=${profileIdToUse}&userAgentId=${userAgentId}`;

        if (profile.command === 'redirect') {
            const historyId = await startRedirectStream(channel.url, channel.id, channel.name, channel.logo);
            if (historyId) {
                redirectHistoryIds.set(widgetId, historyId);
            }
        }
    }

    console.log(`[MultiView] Final stream URL for widget ${widgetId}: ${streamUrlToPlay}`);

    // NEW: Use native video for VOD, mpegts.js for live
    if (useNativeVideo) {
        console.log(`[MultiView] Using native HTML5 video for VOD file`);

        videoEl.src = streamUrlToPlay;

        videoEl.addEventListener('loadedmetadata', () => {
            console.log(`[MultiView] VOD metadata loaded for ${widgetId}`);
        }, { once: true });

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
            console.log(`[MultiView] VOD playback started for ${widgetId}`);
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
        // Existing mpegts.js logic for live streams
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
                if (err.name !== 'AbortError') { // AbortError is expected if we stop it quickly
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
}
/**
 * Stops the stream and cleans up resources for a specific player widget.
 * @param {string} widgetId - The ID of the player.
 * @param {boolean} resetUI - If true, resets the widget's UI to the placeholder state.
 */
async function stopAndCleanupPlayer(widgetId, resetUI = true) {
    const stopPromises = [];

    if (redirectHistoryIds.has(widgetId)) {
        stopPromises.push(stopRedirectStream(redirectHistoryIds.get(widgetId)));
        redirectHistoryIds.delete(widgetId);
    }

    if (playerUrls.has(widgetId)) {
        const originalUrl = playerUrls.get(widgetId);
        console.log(`[MultiView] Sending stop request for widget ${widgetId}, URL: ${originalUrl}`);
        stopPromises.push(stopStream(originalUrl));
        playerUrls.delete(widgetId);
    }

    if (players.has(widgetId)) {
        const player = players.get(widgetId);
        players.delete(widgetId); // Immediately remove from map

        // This is a fire-and-forget cleanup. We don't wait for it.
        // This prevents blocking when the browser is slow to destroy the player.
        Promise.resolve().then(() => {
            try {
                player.pause();
                player.unload();
                player.detachMediaElement();
                player.destroy();
                console.log(`[MultiView] Client-side player for widget ${widgetId} destroyed.`);
            } catch (e) {
                // Errors here are common if the player is already in a bad state. We can ignore them.
                console.warn(`[MultiView] Non-critical error during player cleanup for widget ${widgetId}:`, e.message);
            }
        });
    }

    // Wait for server-side cleanup to complete
    await Promise.all(stopPromises);

    if (resetUI) {
        const playerPlaceholderEl = document.getElementById(widgetId);
        const widgetContentEl = playerPlaceholderEl ? playerPlaceholderEl.closest('.grid-stack-item-content') : null;

        if (widgetContentEl) {
            const videoEl = widgetContentEl.querySelector('video');
            if (videoEl) {
                videoEl.src = "";
                videoEl.removeAttribute('src');
                videoEl.load();
                videoEl.classList.add('hidden');
            }
            if (playerPlaceholderEl) {
                playerPlaceholderEl.classList.remove('hidden');
                playerPlaceholderEl.dataset.channelId = '';
            }
            const titleEl = widgetContentEl.querySelector('.player-header-title');
            if (titleEl) titleEl.textContent = 'No Channel';
        }
    }
}


/**
 * Populates the channel selector modal.
 */
export function populateChannelSelector() {
    // NEW: Reset to "From List" tab when opening modal
    if (UIElements.multiviewSourceListBtn) {
        UIElements.multiviewSourceListBtn.click();
    }

    const listEl = UIElements.channelSelectorList;
    const filter = UIElements.multiviewChannelFilter.value;
    const searchTerm = UIElements.channelSelectorSearch.value.trim().toLowerCase();
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
             data-id="${channel.id}" 
             data-name="${channel.displayName || channel.name}" 
             data-url="${channel.url}"
             data-logo="${channel.logo}">
            <img src="${proxiedImageUrl(channel.logo)}" onerror="this.onerror=null; this.src='https://placehold.co/40x40/1f2937/d1d5db?text=?';" class="w-10 h-10 object-contain mr-3 rounded-md bg-gray-700 flex-shrink-0">
            <div class="overflow-hidden">
                <p class="font-semibold text-white text-sm truncate">${channel.displayName || channel.name}</p>
                <p class="text-gray-400 text-xs truncate">${channel.group || 'Uncategorized'}</p>
            </div>
        </div>
    `).join('');
}


// --- Layout Management ---

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
    select.innerHTML = '<option value="" disabled selected>Select a layout</option>';
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
        showNotification("Cannot save an empty layout.", true);
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
 */
function loadSelectedLayout() {
    const layoutId = UIElements.savedLayoutsSelect.value;
    if (!layoutId) return;

    const layout = guideState.settings.multiviewLayouts.find(l => l.id == layoutId);
    if (!layout) {
        showNotification('Selected layout not found.', true);
        return;
    }

    showConfirm(
        `Load '${layout.name}'?`,
        "This will stop all current streams and load the selected layout. Are you sure?",
        async () => {
            await cleanupMultiView();
            grid.batchUpdate();
            try {
                layout.layout_data.forEach(widgetData => {
                    const channel = widgetData.channelId ? guideState.channels.find(c => c.id === widgetData.channelId) : null;
                    addPlayerWidget(channel, widgetData);
                });
            } finally {
                grid.commit();
            }
        }
    );
}


/**
 * Deletes the currently selected layout.
 */
async function deleteLayout() {
    const layoutId = UIElements.savedLayoutsSelect.value;
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
