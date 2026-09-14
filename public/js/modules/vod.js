/**
 * vod.js
 * * Manages all functionality for the new Video on Demand (VOD) page.
 * Handles parsing, filtering, rendering, and playback of movies and series.
 */

import { appState, UIElements, guideState } from './state.js'; // Keep guideState for settings
import { openModal, closeModal, showNotification, showResumePrompt } from './ui.js';
import { ICONS } from './icons.js';
import { saveUserSetting, fetchVodLibrary, fetchSeriesDetails, getWatchProgress, deleteWatchProgress } from './api.js';
import { playVOD } from './player.js';

// Local state for VOD page
const vodState = {
    // This will hold the parsed and combined list of all movies and series objects
    fullLibrary: [],
    // This will hold the items currently being shown after filters are applied
    filteredLibrary: [],
    // Simple debounce timer for search
    searchDebounce: null,
    // --- NEW: Pagination State ---
    pagination: {
        currentPage: 1,
        pageSize: 50, // Default page size
        totalItems: 0,
        totalPages: 1,
    },
};

/**
 * Formats episode duration in seconds or time string into a clean "Xm Ys" or "Xm" string.
 */
function formatEpisodeDuration(durationSecs, durationStr) {
    if (typeof durationSecs === 'number' && durationSecs > 0) {
        const mins = Math.floor(durationSecs / 60);
        const secs = durationSecs % 60;
        if (mins > 0 && secs > 0) {
            return `${mins}m ${secs}s`;
        } else if (mins > 0) {
            return `${mins}m`;
        } else {
            return `${secs}s`;
        }
    }
    if (durationStr && typeof durationStr === 'string' && durationStr.trim()) {
        const clean = durationStr.trim();
        // Check for HH:MM:SS or MM:SS
        const parts = clean.split(':').map(Number);
        if (parts.length === 3 && !parts.some(isNaN)) {
            const mins = parts[0] * 60 + parts[1];
            const secs = parts[2];
            return mins > 0 ? (secs > 0 ? `${mins}m ${secs}s` : `${mins}m`) : `${secs}s`;
        } else if (parts.length === 2 && !parts.some(isNaN)) {
            return parts[0] > 0 ? (parts[1] > 0 ? `${parts[0]}m ${parts[1]}s` : `${parts[0]}m`) : `${parts[1]}s`;
        }
        const num = parseInt(clean, 10);
        if (!isNaN(num) && num > 0) {
            return `${num}m`;
        }
        if (clean.toLowerCase() !== 'n/a') {
            return clean;
        }
    }
    return '';
}

/**
 * Formats air/release date string into localized date string.
 */
function formatEpisodeDate(dateStr) {
    if (!dateStr || typeof dateStr !== 'string') return '';
    const clean = dateStr.trim().split(' ')[0]; // Strip timestamp if present (e.g. "2015-01-14 00:00:00")
    if (!clean || clean.toLowerCase() === 'n/a') return '';
    try {
        const d = new Date(clean);
        if (!isNaN(d.getTime())) {
            return d.toLocaleDateString();
        }
    } catch (e) { /* ignore */ }
    return clean;
}

/**
 * Main initialization function for the VOD page.
 * This is called by the router in ui.js when switching to the VOD tab.
 */
export async function initVodPage() {
    console.log('[VOD] Initializing VOD Page...');

    // 1. Fetch the structured library from the server
    const library = await fetchVodLibrary();

    if (library) {
        // Combine movies and series (which now only contain basic info)
        vodState.fullLibrary = [...library.movies, ...library.series];
        // Ensure all IDs are strings for consistent lookup later
        vodState.fullLibrary.forEach(item => item.id = String(item.id));
        vodState.fullLibrary.sort((a, b) => a.name.localeCompare(b.name));
        console.log(`[VOD] Library loaded: ${library.movies.length} movies, ${library.series.length} series headers.`);
    } else {
        console.error('[VOD] Failed to load VOD library from server.');
        vodState.fullLibrary = [];
        showNotification('Could not load VOD library.', true);
    }

    // 2. Populate the category filter dropdown based on active tab ('all' by default)
    populateVodGroups('all');
    UIElements.vodGroupFilter.value = 'all';

    // 3. Set initial state of the VOD Direct Play checkbox
    const savedVodDirectPlay = guideState.settings.vodDirectPlayEnabled === true;
    UIElements.vodDirectPlayCheckbox.checked = savedVodDirectPlay;
    console.log(`[VOD] Initial VOD Direct Play state: ${savedVodDirectPlay}`);

    // 4. Render the grid
    renderVodGrid();

    // 5. Set up all event listeners for the page
    setupVodEventListeners();
}


/**
 * Populates the "All Categories" dropdown filter dynamically based on the active tab (all, movies, series).
 * Follows the same pattern as the TV guide with source and groups.
 * @param {string} typeFilter - 'all', 'movies', or 'series'
 */
function populateVodGroups(typeFilter = 'all') {
    const selectEl = UIElements.vodGroupFilter;
    if (!selectEl) return;
    const currentFilter = selectEl.value;

    const availableGroups = new Set();
    if (Array.isArray(vodState.fullLibrary)) {
        vodState.fullLibrary.forEach(item => {
            if (!item.group) return;
            if (typeFilter === 'all') {
                availableGroups.add(item.group);
            } else if (typeFilter === 'movies' && item.type === 'movie') {
                availableGroups.add(item.group);
            } else if (typeFilter === 'series' && item.type === 'series') {
                availableGroups.add(item.group);
            }
        });
    }

    selectEl.innerHTML = '';

    // Always add "All Categories"
    const allOption = document.createElement('option');
    allOption.value = 'all';
    allOption.textContent = 'All Categories';
    selectEl.appendChild(allOption);

    // Add sorted group names
    [...availableGroups].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' })).forEach(group => {
        const option = document.createElement('option');
        option.value = group;
        option.textContent = group;
        selectEl.appendChild(option);
    });

    const optionExists = Array.from(selectEl.options).some(opt => opt.value === currentFilter);
    if (currentFilter && currentFilter !== 'all' && optionExists) {
        selectEl.value = currentFilter;
    } else {
        selectEl.value = 'all';
    }

    console.log(`[VOD] Populated group filter for '${typeFilter}' with ${availableGroups.size} categories. Selected: ${selectEl.value}`);
}

/**
 * Renders the VOD grid based on the current filters and pagination state.
 */
function renderVodGrid() {
    const gridEl = UIElements.vodGrid;
    const noResultsEl = UIElements.vodNoResults;
    if (!gridEl || !noResultsEl) return;

    // 1. Get current filter values
    const activeTypeBtn = document.querySelector('.vod-type-btn.active');
    const typeFilter = activeTypeBtn ? activeTypeBtn.id.replace('vod-type-', '') : 'all'; // 'all', 'movies', 'series'
    const groupFilter = UIElements.vodGroupFilter.value; // 'all' or specific group
    const searchFilter = UIElements.vodSearchInput.value.toLowerCase();

    // 2. Apply filters to the full library
    vodState.filteredLibrary = vodState.fullLibrary.filter(item => {
        const typeMatch = (typeFilter === 'all') || (typeFilter === 'movies' && item.type === 'movie') || (typeFilter === 'series' && item.type === 'series');
        const groupMatch = (groupFilter === 'all') || (item.group === groupFilter);
        const searchMatch = (searchFilter === '') || (item.name.toLowerCase().includes(searchFilter));

        return typeMatch && groupMatch && searchMatch;
    });

    // 3. Update Pagination State
    vodState.pagination.totalItems = vodState.filteredLibrary.length;
    vodState.pagination.totalPages = Math.ceil(vodState.pagination.totalItems / vodState.pagination.pageSize);
    // Ensure currentPage is valid after filtering
    if (vodState.pagination.currentPage > vodState.pagination.totalPages) {
        vodState.pagination.currentPage = Math.max(1, vodState.pagination.totalPages);
    }

    // 4. Calculate items for the current page
    const startIndex = (vodState.pagination.currentPage - 1) * vodState.pagination.pageSize;
    const endIndex = startIndex + vodState.pagination.pageSize;
    const itemsToRender = vodState.filteredLibrary.slice(startIndex, endIndex);

    // 5. Render Grid HTML
    if (itemsToRender.length === 0) {
        gridEl.innerHTML = ''; // Clear grid
        noResultsEl.classList.remove('hidden');
    } else {
        noResultsEl.classList.add('hidden');
        gridEl.innerHTML = itemsToRender.map(item => {
            const itemType = item.type === 'movie' ? 'Movie' : 'Series';
            // Sanitize the name for placeholder text just in case
            const safeName = item.name ? String(item.name).replace(/[^a-zA-Z0-9 ]/g, '') : 'VOD';
            const placeholderImageUrl = `https://placehold.co/400x600/1f2937/d1d5db?text=${encodeURIComponent(safeName)}`;
            // Ensure ID is treated as a string for the data attribute
            const itemIdStr = String(item.id);

            // --- SERIES RENDERING FIX ---
            // Display the series name, not individual episode names here
            const displayName = item.name || (item.type === 'series' ? 'Unknown Series' : 'Unknown Movie');
            const displayGroup = item.group || 'Uncategorized';
            const displayLogo = item.logo || placeholderImageUrl;

            // Use image proxy for both HTTP and HTTPS posters to avoid mixed content warnings
            const proxiedLogo = displayLogo.startsWith('http') ? `/api/image-proxy?url=${encodeURIComponent(displayLogo)}` : displayLogo;

            return `
                <div class="vod-item" data-id="${itemIdStr}">
                    <span class="vod-type-badge">${itemType}</span>
                    <div class="vod-item-poster">
                        <img src="${proxiedLogo}"
                             alt="${displayName.replace(/"/g, '&quot;')}"
                             onerror="this.onerror=null; this.src='${placeholderImageUrl}'; this.style.objectFit='cover';">
                    </div>
                    <div class="vod-item-info">
                        <p class="vod-item-title" title="${displayName.replace(/"/g, '&quot;')}">${displayName}</p>
                        <p class="vod-item-type">${displayGroup}</p>
                    </div>
                </div>
            `;
        }).join('');
    }

    // 6. Render Pagination Controls
    renderVodPaginationControls();
}



/**
 * Opens the VOD details modal and populates it with item info.
 * Handles lazy loading for series episodes.
 * @param {object} item - The movie or series object (basic info) to display.
 */
async function openVodDetails(item) { // Make the function async
    if (!item) return;

    try {
        // --- Common Fields (with image proxy) ---
        if (UIElements.vodDetailsTitle) UIElements.vodDetailsTitle.textContent = item.name || '';

        // Use image proxy for modal posters/backdrops
        const posterUrl = item.logo || `https://placehold.co/400x600/1f2937/d1d5db?text=${encodeURIComponent(item.name || 'VOD')}`;
        const proxiedPoster = posterUrl.startsWith('http') ? `/api/image-proxy?url=${encodeURIComponent(posterUrl)}` : posterUrl;
        if (UIElements.vodDetailsPoster) UIElements.vodDetailsPoster.src = proxiedPoster;
        if (UIElements.vodDetailsBackdropImg) UIElements.vodDetailsBackdropImg.src = item.logo ? proxiedPoster : '';

        if (UIElements.vodDetailsYear) UIElements.vodDetailsYear.textContent = item.year || '';
        if (UIElements.vodDetailsRating) UIElements.vodDetailsRating.textContent = ''; // Placeholder
        if (UIElements.vodDetailsDuration) UIElements.vodDetailsDuration.textContent = ''; // Placeholder
        if (UIElements.vodDetailsGenre) UIElements.vodDetailsGenre.textContent = item.group || 'N/A';
        if (UIElements.vodDetailsDirector) UIElements.vodDetailsDirector.textContent = item.director || 'N/A';
        if (UIElements.vodDetailsCast) UIElements.vodDetailsCast.textContent = item.cast || 'N/A';
        if (UIElements.vodDetailsDesc) UIElements.vodDetailsDesc.textContent = item.description || `Details for ${item.name}.`; // Use description if available

        // --- Reset visibility and clear previous dynamic content ---
        if (UIElements.vodDetailsMovieActions) UIElements.vodDetailsMovieActions.classList.add('hidden');
        if (UIElements.vodDetailsSeriesActions) UIElements.vodDetailsSeriesActions.classList.add('hidden');
        if (UIElements.vodSeasonSelect) UIElements.vodSeasonSelect.innerHTML = '';
        if (UIElements.vodSeasonTabs) UIElements.vodSeasonTabs.innerHTML = '';
        if (UIElements.vodEpisodesCountBadge) UIElements.vodEpisodesCountBadge.textContent = '0';
        if (UIElements.vodEpisodeList) UIElements.vodEpisodeList.innerHTML = '<div class="p-6 text-center text-gray-400">Loading episodes...</div>'; // Show loading state

        // Open the modal immediately to show the loading state
        if (UIElements.vodDetailsModal) {
            openModal(UIElements.vodDetailsModal);
        }
    } catch (initErr) {
        console.error('[VOD] Error preparing VOD modal fields:', initErr);
        if (UIElements.vodDetailsModal) openModal(UIElements.vodDetailsModal);
    }

    // --- Movie Logic (No Change) ---
    if (item.type === 'movie') {
        UIElements.vodDetailsType.textContent = 'Movie';
        UIElements.vodDetailsMovieActions.classList.remove('hidden');
        const movieUrl = item.url;
        const movieName = item.name;
        const movieLogo = item.logo; // Get the logo
        UIElements.vodPlayMovieBtn.onclick = null;
        UIElements.vodPlayMovieBtn.onclick = async () => {
            const movieMediaInfo = {
                contentType: 'vod_movie',
                contentId: String(item.id),
                title: movieName,
                duration: item.duration || 0
            };
            closeModal(UIElements.vodDetailsModal);

            try {
                const prog = await getWatchProgress('vod_movie', item.id);
                if (prog && prog.progress_seconds >= 15 && (!prog.duration_seconds || prog.progress_seconds < prog.duration_seconds * 0.95)) {
                    showResumePrompt({
                        title: movieName,
                        progressSeconds: prog.progress_seconds,
                        durationSeconds: prog.duration_seconds || item.duration || 0,
                        onResume: () => playVOD(movieUrl, movieName, movieLogo, prog.progress_seconds, item.duration || null, movieMediaInfo),
                        onStartOver: () => {
                            deleteWatchProgress('vod_movie', item.id);
                            playVOD(movieUrl, movieName, movieLogo, 0, item.duration || null, movieMediaInfo);
                        }
                    });
                    return;
                }
            } catch (err) {
                console.warn('[VOD] Error checking movie watch progress:', err);
            }

            playVOD(movieUrl, movieName, movieLogo, 0, item.duration || null, movieMediaInfo);
        };

        // --- Series Logic (Lazy Loading & Season Tabs) ---
    } else if (item.type === 'series') {
        UIElements.vodDetailsType.textContent = 'Series';
        UIElements.vodDetailsSeriesActions.classList.remove('hidden'); // Show series section immediately

        // Fetch full series details including episodes
        const fullSeriesData = await fetchSeriesDetails(item.id);
        console.log(`[VOD] Fetched full series data for ID ${item.id}:`, fullSeriesData);

        if (fullSeriesData) {
            if (fullSeriesData.director) {
                UIElements.vodDetailsDirector.textContent = fullSeriesData.director;
            }
            if (fullSeriesData.cast) {
                UIElements.vodDetailsCast.textContent = fullSeriesData.cast;
            }
        }

        // Store the logo on the episode list element to be accessed by the click listener
        UIElements.vodEpisodeList.dataset.seriesLogo = fullSeriesData?.logo || item.logo || '';

        // Robust check for invalid or empty series data
        if (!fullSeriesData || !fullSeriesData.seasons || Object.keys(fullSeriesData.seasons).length === 0) {
            const errorMessage = fullSeriesData ? "No episodes found for this series." : "Could not load episodes for this series. The provider may be offline or slow to respond.";
            UIElements.vodEpisodeList.innerHTML = `<p class="p-6 text-center text-gray-400 text-sm">${errorMessage}</p>`;
            if (UIElements.vodSeasonTabs) {
                UIElements.vodSeasonTabs.innerHTML = '<span class="text-sm text-gray-500 py-1">No Seasons Available</span>';
            }
            if (UIElements.vodEpisodesCountBadge) {
                UIElements.vodEpisodesCountBadge.textContent = '0';
            }
            return;
        }

        // Populate Season Tabs & Episode Count Badge
        const sortedSeasonKeys = Object.keys(fullSeriesData.seasons).map(Number).sort((a, b) => a - b);
        let totalEpisodes = 0;
        sortedSeasonKeys.forEach(k => {
            totalEpisodes += fullSeriesData.seasons[k]?.length || 0;
        });
        if (UIElements.vodEpisodesCountBadge) {
            UIElements.vodEpisodesCountBadge.textContent = totalEpisodes;
        }

        const tabsContainer = UIElements.vodSeasonTabs;
        if (tabsContainer) {
            tabsContainer.innerHTML = '';
            sortedSeasonKeys.forEach((seasonNum, idx) => {
                const btn = document.createElement('button');
                btn.type = 'button';
                btn.className = `season-tab-btn pb-2 px-1 text-sm font-semibold whitespace-nowrap transition-colors border-b-2 ${
                    idx === 0 ? 'text-white border-blue-500 active' : 'text-gray-400 hover:text-gray-200 border-transparent'
                }`;
                btn.textContent = `Season ${seasonNum}`;
                btn.dataset.season = String(seasonNum);
                btn.addEventListener('click', () => {
                    tabsContainer.querySelectorAll('.season-tab-btn').forEach(b => {
                        b.classList.remove('text-white', 'border-blue-500', 'active');
                        b.classList.add('text-gray-400', 'border-transparent');
                    });
                    btn.classList.remove('text-gray-400', 'border-transparent');
                    btn.classList.add('text-white', 'border-blue-500', 'active');
                    renderEpisodeList(fullSeriesData, seasonNum);
                });
                tabsContainer.appendChild(btn);
            });
        }

        if (UIElements.vodSeasonSelect) {
            UIElements.vodSeasonSelect.innerHTML = '';
            sortedSeasonKeys.forEach(seasonNum => {
                const option = document.createElement('option');
                option.value = seasonNum;
                option.textContent = `Season ${seasonNum}`;
                UIElements.vodSeasonSelect.appendChild(option);
            });
            UIElements.vodSeasonSelect.onchange = (e) => {
                renderEpisodeList(fullSeriesData, parseInt(e.target.value, 10));
            };
        }

        // Render episodes for the first season by default
        if (sortedSeasonKeys.length > 0) {
            renderEpisodeList(fullSeriesData, sortedSeasonKeys[0]);
        }
    }
}

/**
 * Renders the list of episodes for a given season inside the details modal.
 * @param {object} series - The full series object.
 * @param {number} seasonNum - The season number to render.
 */
function renderEpisodeList(series, seasonNum) {
    const episodeListEl = UIElements.vodEpisodeList;
    const episodes = series.seasons[seasonNum];
    console.log(`[VOD] Rendering episodes for Series ID ${series.id}, Season ${seasonNum}:`, episodes);

    if (!episodes || episodes.length === 0) {
        episodeListEl.innerHTML = `<p class="p-6 text-center text-gray-400 text-sm">No episodes found for this season.</p>`;
        return;
    }

    episodeListEl.innerHTML = episodes.map((ep, index) => {
        let epName = ep.name.split(' - ').pop();
        if (epName.length < 5) epName = ep.name;

        const originalTitle = ep.name || `Episode ${index + 1}`;
        const epNum = ep.episode || (index + 1);
        const durationText = formatEpisodeDuration(ep.duration_secs, ep.duration);
        const dateText = formatEpisodeDate(ep.air_date);

        return `
            <div class="episode-item" data-id="${ep.id || ep.url}" data-url="${ep.url}" data-title="${originalTitle.replace(/"/g, '&quot;')}">
                <div class="episode-item-epnum">${epNum}</div>
                <div class="episode-item-title" title="${originalTitle.replace(/"/g, '&quot;')}">${epName}</div>
                <div class="episode-item-duration">${durationText}</div>
                <div class="episode-item-date">${dateText}</div>
                <button class="episode-item-play-btn" title="Play Episode" aria-label="Play Episode">
                    ${ICONS.play}
                </button>
            </div>
        `;
    }).join('');
}


/**
 * Sets up all event listeners for the VOD page and its modals.
 */
function setupVodEventListeners() {
    // --- Filter Bar Listeners ---
    UIElements.vodTypeAll.addEventListener('click', () => {
        UIElements.vodTypeAll.classList.add('active');
        UIElements.vodTypeMovies.classList.remove('active');
        UIElements.vodTypeSeries.classList.remove('active');
        populateVodGroups('all');
        vodState.pagination.currentPage = 1;
        renderVodGrid();
    });
    UIElements.vodTypeMovies.addEventListener('click', () => {
        UIElements.vodTypeAll.classList.remove('active');
        UIElements.vodTypeMovies.classList.add('active');
        UIElements.vodTypeSeries.classList.remove('active');
        populateVodGroups('movies');
        vodState.pagination.currentPage = 1;
        renderVodGrid();
    });
    UIElements.vodTypeSeries.addEventListener('click', () => {
        UIElements.vodTypeAll.classList.remove('active');
        UIElements.vodTypeMovies.classList.remove('active');
        UIElements.vodTypeSeries.classList.add('active');
        populateVodGroups('series');
        vodState.pagination.currentPage = 1;
        renderVodGrid();
    });

    UIElements.vodGroupFilter.addEventListener('change', () => {
        vodState.pagination.currentPage = 1;
        renderVodGrid();
    });
    UIElements.vodSearchInput.addEventListener('input', () => {
        clearTimeout(vodState.searchDebounce);
        vodState.searchDebounce = setTimeout(() => {
            vodState.pagination.currentPage = 1;
            renderVodGrid();
        }, 300);
    });

    UIElements.vodDirectPlayCheckbox.addEventListener('change', () => {
        const isEnabled = UIElements.vodDirectPlayCheckbox.checked;
        guideState.settings.vodDirectPlayEnabled = isEnabled;
        saveUserSetting('vodDirectPlayEnabled', isEnabled); // Assumes saveUserSetting is imported
        showNotification(`VOD Direct Play ${isEnabled ? 'enabled' : 'disabled'}.`, false, 2000);
        console.log(`[VOD] VOD Direct Play toggled to: ${isEnabled}`);
    });

    // --- Pagination Listeners (Initial setup, might be re-attached in renderVodPaginationControls) ---
    // Note: The actual page number/prev/next listeners are attached *dynamically*
    // in renderVodPaginationControls because the elements are recreated.
    // We only need the initial setup for the container existence check.
    const paginationContainer = document.getElementById('vod-pagination-controls');
    if (paginationContainer) {
        // Listener for page size change is initially attached here and re-attached on render
        const pageSizeSelect = paginationContainer.querySelector('#vod-page-size-select');
        if (pageSizeSelect) {
            pageSizeSelect.addEventListener('change', changeVodPageSize);
        }
    }

    // --- VOD Grid Click Listener (Event Delegation) ---
    UIElements.vodGrid.addEventListener('click', (e) => {
        const vodItemEl = e.target.closest('.vod-item');
        if (vodItemEl) {
            const itemId = vodItemEl.dataset.id; // ID is always a string from data-*
            console.log(`[VOD_CLICK] Click detected on item with data-id: ${itemId}`); // Keep log

            // --- FIX: Ensure string comparison ---
            const item = vodState.fullLibrary.find(i => String(i.id) === itemId);
            // --- END FIX ---

            if (item) {
                console.log(`[VOD_CLICK] Found item in library:`, item);
                openVodDetails(item).catch(err => {
                    console.error(`[VOD_CLICK] Error opening details for item ${itemId}:`, err);
                });
            } else {
                // Keep error handling
                console.error(`[VOD_CLICK] Could not find VOD item in fullLibrary with ID: ${itemId}`);
                showNotification(`Error: Could not find details for the selected item (ID: ${itemId}).`, true);
            }
        }
    });

    // --- VOD Details Modal Listeners ---
    UIElements.vodDetailsCloseBtn.addEventListener('click', () => {
        closeModal(UIElements.vodDetailsModal);
        // Clear backdrop when closing
        UIElements.vodDetailsBackdropImg.src = '';
    });

    // Episode play click (Event Delegation)
    UIElements.vodEpisodeList.addEventListener('click', async (e) => {
        const episodeItem = e.target.closest('.episode-item');
        if (episodeItem) {
            const url = episodeItem.dataset.url;
            const title = episodeItem.dataset.title;
            const episodeId = episodeItem.dataset.id || url;
            const seriesLogo = UIElements.vodEpisodeList.dataset.seriesLogo || ''; // Get logo from parent

            const epMediaInfo = {
                contentType: 'vod_episode',
                contentId: String(episodeId),
                title: title
            };

            closeModal(UIElements.vodDetailsModal);

            try {
                const prog = await getWatchProgress('vod_episode', episodeId);
                if (prog && prog.progress_seconds >= 15 && (!prog.duration_seconds || prog.progress_seconds < prog.duration_seconds * 0.95)) {
                    showResumePrompt({
                        title: title,
                        progressSeconds: prog.progress_seconds,
                        durationSeconds: prog.duration_seconds || 0,
                        onResume: () => playVOD(url, title, seriesLogo, prog.progress_seconds, null, epMediaInfo),
                        onStartOver: () => {
                            deleteWatchProgress('vod_episode', episodeId);
                            playVOD(url, title, seriesLogo, 0, null, epMediaInfo);
                        }
                    });
                    return;
                }
            } catch (err) {
                console.warn('[VOD] Error checking episode watch progress:', err);
            }

            playVOD(url, title, seriesLogo, 0, null, epMediaInfo);
        }
    });
}

/**
 * Renders the pagination controls below the VOD grid.
 */
function renderVodPaginationControls() {
    const controlsContainer = document.getElementById('vod-pagination-controls');
    if (!controlsContainer) return;

    const { currentPage, totalPages, totalItems, pageSize } = vodState.pagination;

    if (totalPages <= 1) {
        controlsContainer.innerHTML = ''; // Hide controls if only one page
        return;
    }

    const startItem = (currentPage - 1) * pageSize + 1;
    const endItem = Math.min(startItem + pageSize - 1, totalItems);

    let pagesHTML = '';
    // Previous button
    pagesHTML += `<li><button class="pagination-btn prev-page-btn" ${currentPage === 1 ? 'disabled' : ''} aria-label="Previous Page">Prev</button></li>`;

    // Page 1
    pagesHTML += `<li><button class="pagination-btn page-number-btn ${1 === currentPage ? 'active' : ''}" data-page="1">1</button></li>`;

    if (currentPage > 3) {
        pagesHTML += `<li><span class="pagination-ellipsis">...</span></li>`;
    }

    // Pages around current page
    const startPage = Math.max(2, currentPage - 1);
    const endPage = Math.min(totalPages - 1, currentPage + 1);

    for (let p = startPage; p <= endPage; p++) {
        pagesHTML += `<li><button class="pagination-btn page-number-btn ${p === currentPage ? 'active' : ''}" data-page="${p}">${p}</button></li>`;
    }

    if (currentPage < totalPages - 2) {
        pagesHTML += `<li><span class="pagination-ellipsis">...</span></li>`;
    }

    // Always show last page if > 1
    if (totalPages > 1) {
        pagesHTML += `<li><button class="pagination-btn page-number-btn ${totalPages === currentPage ? 'active' : ''}" data-page="${totalPages}">${totalPages}</button></li>`;
    }

    // Next button
    pagesHTML += `<li><button class="pagination-btn next-page-btn" ${currentPage === totalPages ? 'disabled' : ''} aria-label="Next Page">Next</button></li>`;

    controlsContainer.innerHTML = `
        <div class="flex flex-col sm:flex-row justify-between items-center gap-4 p-4" aria-label="Pagination navigation">
            <div class="flex flex-wrap items-center gap-3">
                <span class="text-sm font-normal text-gray-400">Page Size:</span>
                <select id="vod-page-size-select" class="bg-gray-700/80 border border-gray-600 rounded-lg px-2.5 py-1 text-sm text-white focus:ring-2 focus:ring-blue-500 focus:outline-none">
                    <option value="25" ${pageSize === 25 ? 'selected' : ''}>25</option>
                    <option value="50" ${pageSize === 50 ? 'selected' : ''}>50</option>
                    <option value="75" ${pageSize === 75 ? 'selected' : ''}>75</option>
                    <option value="100" ${pageSize === 100 ? 'selected' : ''}>100</option>
                </select>
                <span id="vod-pagination-info" class="text-sm font-normal text-gray-400">
                    Showing <strong class="text-gray-200">${startItem}-${endItem}</strong> of <strong class="text-gray-200">${totalItems}</strong>
                </span>
            </div>
            <ul id="vod-pagination-pages" class="flex flex-wrap items-center gap-1.5 list-none p-0 m-0">
                ${pagesHTML}
            </ul>
        </div>
    `;

    // Re-attach listeners specifically for the newly rendered elements
    const pageSizeSelect = controlsContainer.querySelector('#vod-page-size-select');
    if (pageSizeSelect) {
        pageSizeSelect.addEventListener('change', changeVodPageSize);
    }
    const paginationPages = controlsContainer.querySelector('#vod-pagination-pages');
    if (paginationPages) {
        paginationPages.addEventListener('click', (e) => {
            const button = e.target.closest('button');
            if (!button || button.disabled) return;

            if (button.classList.contains('prev-page-btn')) {
                goToVodPage(vodState.pagination.currentPage - 1);
            } else if (button.classList.contains('next-page-btn')) {
                goToVodPage(vodState.pagination.currentPage + 1);
            } else if (button.classList.contains('page-number-btn')) {
                const pageNum = parseInt(button.dataset.page, 10);
                if (pageNum) {
                    goToVodPage(pageNum);
                }
            }
        });
    }
}

/**
 * Navigates to a specific page in the VOD grid.
 * @param {number} pageNum - The page number to go to.
 */
function goToVodPage(pageNum) {
    const { totalPages } = vodState.pagination;
    if (pageNum >= 1 && pageNum <= totalPages) {
        vodState.pagination.currentPage = pageNum;
        renderVodGrid(); // Re-render the grid for the new page
        // Scroll to the top of the grid container
        UIElements.vodGridContainer.scrollTo({ top: 0, behavior: 'smooth' });
    }
}

/**
 * Changes the number of items shown per page in the VOD grid.
 * @param {Event} event - The change event from the select dropdown.
 */
function changeVodPageSize(event) {
    const newSize = parseInt(event.target.value, 10);
    if (newSize) {
        vodState.pagination.pageSize = newSize;
        vodState.pagination.currentPage = 1; // Reset to first page
        renderVodGrid(); // Re-render with new page size
        // Optionally save this preference
        // import('./api.js').then(({ saveUserSetting }) => saveUserSetting('vodPageSize', newSize));
    }
}
