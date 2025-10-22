/**
 * vod.js
 * * Manages all functionality for the new Video on Demand (VOD) page.
 * Handles parsing, filtering, rendering, and playback of movies and series.
 */

import { appState, UIElements, guideState } from './state.js'; // Keep guideState for settings
import { openModal, closeModal, showNotification } from './ui.js';
import { ICONS } from './icons.js';
import { saveUserSetting, fetchVodLibrary } from './api.js'; // Import fetchVodLibrary
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
 * Main initialization function for the VOD page.
 * This is called by the router in ui.js when switching to the VOD tab.
 */
export async function initVodPage() {
    console.log('[VOD] Initializing VOD Page...');

    // 1. Fetch the structured library from the server
    const library = await fetchVodLibrary();

    if (library) {
        // The server sends { movies: [], series: [] }
        // We combine them and sort alphabetically
        vodState.fullLibrary = [...library.movies, ...library.series];
        vodState.fullLibrary.sort((a, b) => a.name.localeCompare(b.name));
        console.log(`[VOD] Library loaded: ${library.movies.length} movies, ${library.series.length} series.`);
    } else {
        console.error('[VOD] Failed to load VOD library from server.');
        vodState.fullLibrary = [];
        showNotification('Could not load VOD library.', true);
    }

    // 2. Populate the category filter dropdown
    populateVodGroups();
    UIElements.vodGroupFilter.value = 'all'; // Ensure "All Categories" is selected

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
 * Populates the "All Categories" dropdown filter.
 */
function populateVodGroups() {
    const groups = new Set(['all']);
    vodState.fullLibrary.forEach(item => {
        if (item.group) {
            groups.add(item.group);
        }
    });

    const selectEl = UIElements.vodGroupFilter;
    selectEl.innerHTML = '';
    Array.from(groups).sort().forEach(group => {
        const option = document.createElement('option');
        option.value = group;
        option.textContent = group === 'all' ? 'All Categories' : group;
        selectEl.appendChild(option);
    });
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

            return `
                <div class="vod-item" data-id="${itemIdStr}">
                    <span class="vod-type-badge">${itemType}</span>
                    <div class="vod-item-poster">
                        <img src="${displayLogo}"
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
 * @param {object} item - The movie or series object to display.
 */
function openVodDetails(item) {
    if (!item) return;

    // Set common fields
    UIElements.vodDetailsTitle.textContent = item.name;
    UIElements.vodDetailsPoster.src = item.logo || `https_placehold.co/400x600/1f2937/d1d5db?text=${encodeURIComponent(item.name)}`;
    UIElements.vodDetailsBackdropImg.src = item.logo || ''; // Use poster as backdrop for now

    // Reset all fields
    UIElements.vodDetailsYear.textContent = '';
    UIElements.vodDetailsRating.textContent = '';
    UIElements.vodDetailsDuration.textContent = '';
    UIElements.vodDetailsGenre.textContent = item.group || 'N/A';
    UIElements.vodDetailsDirector.textContent = 'N/A';
    UIElements.vodDetailsCast.textContent = 'N/A';
    UIElements.vodDetailsDesc.textContent = `Details for ${item.name}. (TMDB integration planned)`;

    if (item.type === 'movie') {
        // Show movie info and play button
        UIElements.vodDetailsType.textContent = 'Movie';
        UIElements.vodDetailsMovieActions.classList.remove('hidden');
        UIElements.vodDetailsSeriesActions.classList.add('hidden');

        // --- Attach play button listener ---
        // Ensure we use the 'item' passed directly to openVodDetails
        const movieUrl = item.url;
        const movieName = item.name;
        console.log(`[VOD_DETAILS] Setting up play button for Movie: "${movieName}" URL: ${movieUrl}`); // Add log

        // Remove any previous listener to be safe (though generally not needed if assigned directly)
        UIElements.vodPlayMovieBtn.onclick = null;
        UIElements.vodPlayMovieBtn.onclick = () => {
            console.log(`[VOD_DETAILS] Play button clicked for: "${movieName}"`); // Add log
            playVOD(movieUrl, movieName); // Use variables captured in this scope
            closeModal(UIElements.vodDetailsModal);
        };
        // --- End Play Button Logic ---

    } else if (item.type === 'series') {
        // Show series info and episode list
        UIElements.vodDetailsType.textContent = 'Series';
        UIElements.vodDetailsMovieActions.classList.add('hidden');
        UIElements.vodDetailsSeriesActions.classList.remove('hidden');

        // Populate season dropdown
        const seasonSelect = UIElements.vodSeasonSelect;
        seasonSelect.innerHTML = '';
        const sortedSeasonKeys = Object.keys(item.seasons).map(Number).sort((a, b) => a - b);
        
        for (const seasonNum of sortedSeasonKeys) {
            const option = document.createElement('option');
            option.value = seasonNum;
            option.textContent = `Season ${seasonNum}`;
            seasonSelect.appendChild(option);
        }

        // Render episodes for the first season
        renderEpisodeList(item, sortedSeasonKeys[0]);

        // Add listener for season changes
        seasonSelect.onchange = (e) => {
            renderEpisodeList(item, parseInt(e.target.value, 10));
        };
    }

    openModal(UIElements.vodDetailsModal);
}

/**
 * Renders the list of episodes for a given season inside the details modal.
 * @param {object} series - The full series object.
 * @param {number} seasonNum - The season number to render.
 */
function renderEpisodeList(series, seasonNum) {
    const episodeListEl = UIElements.vodEpisodeList;
    const episodes = series.seasons.get(seasonNum);

    if (!episodes || episodes.length === 0) {
        episodeListEl.innerHTML = `<p class="p-4 text-center text-gray-400">No episodes found for this season.</p>`;
        return;
    }

    // --- UPDATED HTML STRUCTURE ---
    episodeListEl.innerHTML = episodes.map((ep, index) => {
        // Try to get a clean episode name, fallback to the full name
        let epName = ep.name.split(' - ').pop();
        if (epName.length < 5) epName = ep.name; // Handle cases where split fails

        // Use original name for the data attribute for playback title consistency
        const originalTitle = ep.name || `Episode ${index + 1}`;

        return `
            <div class="episode-item" data-url="${ep.url}" data-title="${originalTitle.replace(/"/g, '&quot;')}">
                <div class="episode-item-epnum">${index + 1}</div>
                <div class="episode-item-title">${epName}</div>
                <div class="episode-item-duration">N/A</div>
                <div class="episode-item-date">N/A</div>
                <button class="episode-item-play-btn" title="Play Episode">
                    ${ICONS.play}
                </button>
            </div>
        `;
    }).join('');
    // --- END OF UPDATED HTML ---
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
        renderVodGrid();
    });
    UIElements.vodTypeMovies.addEventListener('click', () => {
        UIElements.vodTypeAll.classList.remove('active');
        UIElements.vodTypeMovies.classList.add('active');
        UIElements.vodTypeSeries.classList.remove('active');
        renderVodGrid();
    });
    UIElements.vodTypeSeries.addEventListener('click', () => {
        UIElements.vodTypeAll.classList.remove('active');
        UIElements.vodTypeMovies.classList.remove('active');
        UIElements.vodTypeSeries.classList.add('active');
        renderVodGrid();
    });

    UIElements.vodGroupFilter.addEventListener('change', renderVodGrid);
    UIElements.vodSearchInput.addEventListener('input', () => {
        clearTimeout(vodState.searchDebounce);
        vodState.searchDebounce = setTimeout(renderVodGrid, 300);
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
            const itemId = vodItemEl.dataset.id; // ID should already be a string from data-*
            console.log(`[VOD_CLICK] Click detected on item with data-id: ${itemId}`);
            // Find item comparing strings, ensure IDs from library are also strings
            const item = vodState.fullLibrary.find(i => String(i.id) === itemId); // Ensure string comparison
            if (item) {
                console.log(`[VOD_CLICK] Found item in library:`, item);
                openVodDetails(item);
            } else {
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
    UIElements.vodEpisodeList.addEventListener('click', (e) => {
        const episodeItem = e.target.closest('.episode-item');
        if (episodeItem) {
            const url = episodeItem.dataset.url;
            const title = episodeItem.dataset.title;
            playVOD(url, title);
            closeModal(UIElements.vodDetailsModal);
        }
    });
}

/**
 * Renders the pagination controls below the VOD grid.
 */
function renderVodPaginationControls() {
    const controlsContainer = document.getElementById('vod-pagination-controls'); // We'll add this ID in index.html
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
    pagesHTML += `<li><button class="pagination-btn prev-page-btn" ${currentPage === 1 ? 'disabled' : ''}>Prev</button></li>`;

    // Page number buttons (simplified for now: first, current, last)
    pagesHTML += `<li><button class="pagination-btn page-number-btn ${1 === currentPage ? 'active' : ''}" data-page="1">1</button></li>`;

    if (currentPage > 2) {
        pagesHTML += `<li><span class="pagination-btn">...</span></li>`;
    }
    if (currentPage !== 1 && currentPage !== totalPages) {
        pagesHTML += `<li><button class="pagination-btn page-number-btn active" data-page="${currentPage}">${currentPage}</button></li>`;
    }
    if (currentPage < totalPages - 1) {
        pagesHTML += `<li><span class="pagination-btn">...</span></li>`;
    }

    if (totalPages > 1) {
       pagesHTML += `<li><button class="pagination-btn page-number-btn ${totalPages === currentPage ? 'active' : ''}" data-page="${totalPages}">${totalPages}</button></li>`;
    }


    // Next button
    pagesHTML += `<li><button class="pagination-btn next-page-btn" ${currentPage === totalPages ? 'disabled' : ''}>Next</button></li>`;

    controlsContainer.innerHTML = `
        <div class="flex flex-col md:flex-row justify-between items-start md:items-center space-y-3 md:space-y-0 p-4" aria-label="Table navigation">
            <div class="flex items-center gap-2">
                <span class="text-sm font-normal text-gray-400">Page Size:</span>
                <select id="vod-page-size-select" class="bg-gray-700 border border-gray-600 rounded-md px-2 py-1 text-sm text-white focus:ring-blue-500 focus:border-blue-500">
                    <option value="25" ${pageSize === 25 ? 'selected' : ''}>25</option>
                    <option value="50" ${pageSize === 50 ? 'selected' : ''}>50</option>
                    <option value="75" ${pageSize === 75 ? 'selected' : ''}>75</option>
                    <option value="100" ${pageSize === 100 ? 'selected' : ''}>100</option>
                </select>
                <span id="vod-pagination-info" class="text-sm font-normal text-gray-400 ml-4">
                    Showing ${startItem}-${endItem} of ${totalItems}
                </span>
            </div>
            <ul id="vod-pagination-pages" class="inline-flex items-center -space-x-px">
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
