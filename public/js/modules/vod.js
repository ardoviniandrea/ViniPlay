/**
 * vod.js
 * * Manages all functionality for the new Video on Demand (VOD) page.
 * Handles parsing, filtering, rendering, and playback of movies and series.
 */

import { appState, guideState, UIElements } from './state.js';
import { openModal, closeModal } from './ui.js';
import { ICONS } from './icons.js';
// We will create this new function in player.js in the next step.
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
    // 1. Parse the raw data from guideState into a structured library
    parseVODLibrary();
    // 2. Populate the category filter dropdown
    populateVodGroups();
    // --- Set default value ---
    UIElements.vodGroupFilter.value = 'all'; // Ensure "All Categories" is selected initially
    // --- End set default ---
    // 3. Render the grid with the default (all) filter
    renderVodGrid();
    // 4. Set up all event listeners for the page
    setupVodEventListeners();
}

/**
 * Parses the raw movie and series data from guideState into a structured
 * library. Crucially, it groups flat episode lists into series objects.
 * IMPROVED VERSION with better regex and grouping logic.
 */
function parseVODLibrary() {
    const movies = guideState.vodMovies || [];
    const seriesEpisodes = guideState.vodSeries || [];

    // 1. Process Movies (simple 1-to-1 mapping)
    const movieItems = movies.map(movie => ({
        type: 'movie',
        id: movie.id || `movie-${Math.random()}`, // Ensure unique ID
        name: movie.name || 'Unknown Movie',
        logo: movie.logo || '',
        group: movie.group || 'Uncategorized',
        url: movie.url
    }));

    // 2. Process Series (grouping episodes)
    const seriesMap = new Map();

    // Regex patterns to extract Series Name, Season, and Episode
    // Order matters: More specific patterns first.
    const patterns = [
        // Pattern 1: "Series Name - S01E01 - Optional Title" OR "Series Name - 1x01 - Optional Title"
        { regex: /^(.*?)\s*-\s*(?:S(\d+)[EX](\d+)|(\d+)x(\d+))\s*(?:-\s*(.*))?$/i, nameIdx: 1, seasonIdx: [2, 4], episodeIdx: [3, 5], titleIdx: 6 },
        // Pattern 2: "Series Name S01E01 Optional Title" OR "Series Name 1x01 Optional Title" (Less common separator)
        { regex: /^(.*?)\s+(?:S(\d+)[EX](\d+)|(\d+)x(\d+))\s*(.*)?$/i, nameIdx: 1, seasonIdx: [2, 4], episodeIdx: [3, 5], titleIdx: 6 },
        // Pattern 3: "Series Name - Episode Title" (No S/E numbers, often for mini-series or specials) - Assume Season 1
        { regex: /^(.*?)\s*-\s*([^S0-9].*)$/i, nameIdx: 1, seasonIdx: [], episodeIdx: [], titleIdx: 2 },
        // Pattern 4: Simple name (Fallback - Assume Season 1, will be numbered sequentially)
        { regex: /^(.*)$/i, nameIdx: 1, seasonIdx: [], episodeIdx: [], titleIdx: -1 }
    ];

    let fallbackEpisodeCounter = {}; // To number episodes without S/E info

    for (const episode of seriesEpisodes) {
        let parsedInfo = null;
        let originalName = episode.name || 'Unknown Episode';

        // Try matching patterns
        for (const p of patterns) {
            const match = originalName.match(p.regex);
            if (match) {
                parsedInfo = {
                    seriesName: (match[p.nameIdx] || originalName).trim(),
                    seasonNum: 1, // Default season
                    episodeNum: 0, // Default episode (will be handled below)
                    episodeTitle: (p.titleIdx > 0 && match[p.titleIdx]) ? match[p.titleIdx].trim() : originalName // Use original if no title found
                };

                // Extract Season/Episode if pattern includes them
                const seasonMatch = p.seasonIdx.map(idx => match[idx]).find(Boolean);
                const episodeMatch = p.episodeIdx.map(idx => match[idx]).find(Boolean);

                if (seasonMatch) parsedInfo.seasonNum = parseInt(seasonMatch, 10);
                if (episodeMatch) parsedInfo.episodeNum = parseInt(episodeMatch, 10);

                // If we successfully parsed S/E numbers, use the cleaner series name
                if (seasonMatch || episodeMatch) {
                    parsedInfo.seriesName = match[p.nameIdx].trim();
                }
                // If no S/E found, but a title was separated (Pattern 3), use that title
                else if (p.titleIdx > 0 && match[p.titleIdx]) {
                    parsedInfo.episodeTitle = match[p.titleIdx].trim();
                }


                // Clean up potential trailing hyphens or spaces if we extracted S/E
                if (seasonMatch || episodeMatch) {
                    parsedInfo.seriesName = parsedInfo.seriesName.replace(/[\s-]+$/, '');
                }

                break; // Stop on first successful match
            }
        }

        // If parsing failed entirely (shouldn't happen with fallback), log error and skip
        if (!parsedInfo) {
            console.warn(`[VOD PARSE] Could not parse series info for: ${originalName}`);
            continue;
        }

        // Handle episodes without explicit numbers (assign sequential number within Season 1)
        if (parsedInfo.episodeNum === 0) {
            if (!fallbackEpisodeCounter[parsedInfo.seriesName]) {
                fallbackEpisodeCounter[parsedInfo.seriesName] = 0;
            }
            fallbackEpisodeCounter[parsedInfo.seriesName]++;
            parsedInfo.episodeNum = fallbackEpisodeCounter[parsedInfo.seriesName];
            parsedInfo.seasonNum = 1; // Force Season 1 for these
        }

        // --- Grouping Logic ---
        const seriesKey = parsedInfo.seriesName; // Use the cleaned name as the key

        // Get or create the main series object
        if (!seriesMap.has(seriesKey)) {
            seriesMap.set(seriesKey, {
                type: 'series',
                // Generate a more stable ID based on the series name and first source ID
                id: `series-${seriesKey.replace(/[^a-zA-Z0-9]/g, '')}-${(episode.sourceId || 'unk').split('-')[0]}`,
                name: seriesKey,
                logo: episode.logo || '', // Initial logo
                group: episode.group || 'Uncategorized',
                seasons: new Map(), // Use a Map for seasons keyed by season number
            });
        }
        const seriesObj = seriesMap.get(seriesKey);

        // Use the logo from S01E01 if available and current logo is blank
        if (parsedInfo.seasonNum === 1 && parsedInfo.episodeNum === 1 && episode.logo && !seriesObj.logo) {
            seriesObj.logo = episode.logo;
        }
        // Fallback: If after processing all episodes, logo is still blank, try finding *any* logo
        if (!seriesObj.logo && episode.logo) {
             seriesObj.logo = episode.logo;
        }


        // Get or create the season array within the Map
        if (!seriesObj.seasons.has(parsedInfo.seasonNum)) {
            seriesObj.seasons.set(parsedInfo.seasonNum, []);
        }
        const seasonArr = seriesObj.seasons.get(parsedInfo.seasonNum);

        // Add the episode to the season
        seasonArr.push({
            id: episode.id || `ep-${Math.random()}`, // Ensure unique ID
            name: parsedInfo.episodeTitle, // Store the potentially cleaned title
            originalName: originalName, // Keep original for reference if needed
            url: episode.url,
            logo: episode.logo, // Keep individual episode logo if present
            season: parsedInfo.seasonNum,
            episode: parsedInfo.episodeNum,
        });
    }

    // Sort episodes within each season AFTER processing all episodes
    for (const series of seriesMap.values()) {
        for (const season of series.seasons.values()) {
            season.sort((a, b) => a.episode - b.episode);
        }
        // Optional: You could also try to find a better overall series logo here
        // if the S01E01 logic didn't find one.
        if (!series.logo) {
            for (const seasonNum of Array.from(series.seasons.keys()).sort((a,b)=> a-b)) {
                const firstEpWithLogo = series.seasons.get(seasonNum).find(ep => ep.logo);
                if (firstEpWithLogo) {
                    series.logo = firstEpWithLogo.logo;
                    break;
                }
            }
        }
    }

    // 3. Combine and store
    vodState.fullLibrary = [...movieItems, ...Array.from(seriesMap.values())];
    // Sort the final library alphabetically by name
    vodState.fullLibrary.sort((a, b) => a.name.localeCompare(b.name));

    console.log(`[VOD] Library parsed: ${movieItems.length} movies, ${seriesMap.size} series objects created.`);
    // console.log('[VOD] Final Library:', vodState.fullLibrary); // Uncomment for deep debugging
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
            // Use a placeholder image URL that works
            const placeholderImageUrl = `https://placehold.co/400x600/1f2937/d1d5db?text=${encodeURIComponent(item.name)}`;
            return `
                <div class="vod-item" data-id="${item.id}">
                    <span class="vod-type-badge">${itemType}</span>
                    <div class="vod-item-poster">
                        <img src="${item.logo || placeholderImageUrl}"
                             alt="${item.name}"
                             onerror="this.onerror=null; this.src='${placeholderImageUrl}'; this.style.objectFit='cover';">
                    </div>
                    <div class="vod-item-info">
                        <p class="vod-item-title" title="${item.name}">${item.name}</p>
                        <p class="vod-item-type">${item.group || 'Uncategorized'}</p>
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

        // Attach play button listener
        UIElements.vodPlayMovieBtn.onclick = () => {
            playVOD(item.url, item.name);
            closeModal(UIElements.vodDetailsModal);
        };

    } else if (item.type === 'series') {
        // Show series info and episode list
        UIElements.vodDetailsType.textContent = 'Series';
        UIElements.vodDetailsMovieActions.classList.add('hidden');
        UIElements.vodDetailsSeriesActions.classList.remove('hidden');

        // Populate season dropdown
        const seasonSelect = UIElements.vodSeasonSelect;
        seasonSelect.innerHTML = '';
        const sortedSeasonKeys = Array.from(item.seasons.keys()).sort((a, b) => a - b);
        
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

    episodeListEl.innerHTML = episodes.map((ep, index) => {
        // Try to get a clean episode name, fallback to the full name
        let epName = ep.name.split(' - ').pop();
        if (epName.length < 5) epName = ep.name; // Handle cases where split fails

        return `
            <div class="episode-item" data-url="${ep.url}" data-title="${ep.name}">
                <div class="flex items-center gap-4">
                    <span class="text-gray-400 text-sm w-4 text-right">${index + 1}</span>
                    <div class="flex-grow">
                        <p class="text-white text-sm font-medium">${epName}</p>
                    </div>
                </div>
                <button class="episode-item-play-btn" title="Play Episode">
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
            const itemId = vodItemEl.dataset.id;
            console.log(`[VOD_CLICK] Click detected on item with data-id: ${itemId}`); // Add log
            // Ensure we are comparing strings to strings if IDs might be numeric
            const item = vodState.fullLibrary.find(i => String(i.id) === String(itemId));
            if (item) {
                console.log(`[VOD_CLICK] Found item in library:`, item); // Add log
                openVodDetails(item);
            } else {
                // Add error handling if item not found
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
