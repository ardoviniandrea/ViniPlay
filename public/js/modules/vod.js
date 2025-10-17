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
    // 3. Render the grid with the default (all) filter
    renderVodGrid();
    // 4. Set up all event listeners for the page
    setupVodEventListeners();
}

/**
 * Parses the raw movie and series data from guideState into a structured
 * library. Crucially, it groups flat episode lists into series objects.
 *
 * --- UPDATED ---
 * - Fixes the series grouping logic to be more robust.
 * - This fixes the bug where all episodes were flat.
 * - Fixes the "always same item" bug by using the clean series name as the
 * unique ID for the series object.
 */
function parseVODLibrary() {
    const movies = guideState.vodMovies || [];
    const seriesEpisodes = guideState.vodSeries || [];

    // 1. Process Movies (simple 1-to-1 mapping)
    const movieItems = movies.map(movie => ({
        type: 'movie',
        ...movie // Spread all properties (id, name, logo, group, url)
    }));

    // 2. Process Series (grouping episodes)
    const seriesMap = new Map();
    
    // Regex to extract season and episode numbers (e.g., S01E01, 1x01, S01-E01)
    // This is used to find the "split point" in the name.
    const seRegex = /[\s._-](S(\d+)E(\d+)|(\d+)x(\d+)|S(\d+)-E(\d+))[\s._-]/i;

    for (const episode of seriesEpisodes) {
        let seriesName;
        let seasonNum = 1; // Default to season 1
        let episodeNum = 0;

        // Try to find season/episode numbers
        const seMatch = episode.name.match(seRegex);
        
        if (seMatch) {
            // --- FIX: Robust name extraction ---
            // Everything *before* the S/E pattern is the series name.
            seriesName = episode.name.substring(0, seMatch.index).trim();
            
            seasonNum = parseInt(seMatch[2] || seMatch[4] || seMatch[6], 10);
            episodeNum = parseInt(seMatch[3] || seMatch[5] || seMatch[7], 10);
        } else {
            // If no S/E pattern, treat the whole name as the series name
            // (e.g., for a talk show where episodes are just dates)
            seriesName = episode.name.trim();
            // We'll number them in the order they appear
            episodeNum = seriesMap.has(seriesName) ? seriesMap.get(seriesName).seasons.get(1).length + 1 : 1;
        }

        // --- CRITICAL FIX for "always same item" bug ---
        // The unique ID for the series *must* be its name.
        if (!seriesMap.has(seriesName)) {
            seriesMap.set(seriesName, {
                type: 'series',
                id: seriesName, // Use the clean name as the unique ID
                name: seriesName,
                logo: episode.logo, // Use first episode's logo as placeholder
                group: episode.group,
                seasons: new Map(), // Use a Map for seasons
            });
        }
        const seriesObj = seriesMap.get(seriesName);
        
        // Use the logo from the first episode of Season 1 if possible
        if(seasonNum === 1 && episodeNum === 1 && episode.logo) {
            seriesObj.logo = episode.logo;
        }

        // Get or create the season array
        if (!seriesObj.seasons.has(seasonNum)) {
            seriesObj.seasons.set(seasonNum, []);
        }
        const seasonArr = seriesObj.seasons.get(seasonNum);

        // Add the episode to the season
        seasonArr.push({
            id: episode.id,
            name: episode.name,
            url: episode.url,
            logo: episode.logo,
            season: seasonNum,
            episode: episodeNum,
        });
    }

    // Sort episodes within each season
    for (const series of seriesMap.values()) {
        for (const season of series.seasons.values()) {
            season.sort((a, b) => a.episode - b.episode);
        }
    }

    // 3. Combine and store
    vodState.fullLibrary = [...movieItems, ...Array.from(seriesMap.values())];
    
    // Sort the full library alphabetically by name
    vodState.fullLibrary.sort((a, b) => a.name.localeCompare(b.name));
    
    console.log(`[VOD] Library parsed: ${movieItems.length} movies, ${seriesMap.size} series.`);
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
    
    selectEl.value = 'all';
}

/**
 * Renders the VOD grid based on the current filters.
 *
 * --- UPDATED ---
 * - Now supports pagination. It filters the full list, then
 * slices it based on the current page and page size.
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

    // 2. Apply filters to the *full* library
    const fullFilteredList = vodState.fullLibrary.filter(item => {
        const typeMatch = (typeFilter === 'all') || (typeFilter === 'movies' && item.type === 'movie') || (typeFilter === 'series' && item.type === 'series');
        const groupMatch = (groupFilter === 'all') || (item.group === groupFilter);
        const searchMatch = (searchFilter === '') || (item.name.toLowerCase().includes(searchFilter));
        
        return typeMatch && groupMatch && searchMatch;
    });

    // --- NEW: PAGINATION LOGIC ---

    // 3. Update pagination state directly on the shared vodState
    vodState.pagination.totalItems = fullFilteredList.length;
    vodState.pagination.totalPages = Math.ceil(vodState.pagination.totalItems / vodState.pagination.pageSize) || 1;

    // Ensure currentPage is valid
    if (vodState.pagination.currentPage > vodState.pagination.totalPages) {
        vodState.pagination.currentPage = 1; // Reset if current page is out of bounds
    }

    // 4. Slice the filtered list using the updated state
    const startIndex = (vodState.pagination.currentPage - 1) * vodState.pagination.pageSize;
    const endIndex = startIndex + vodState.pagination.pageSize;
    vodState.filteredLibrary = fullFilteredList.slice(startIndex, endIndex);
    
    // 5. Render the *paginated* items
    if (vodState.filteredLibrary.length === 0) {
        gridEl.innerHTML = '';
        noResultsEl.classList.remove('hidden');
    } else {
        noResultsEl.classList.add('hidden');
        gridEl.innerHTML = vodState.filteredLibrary.map(item => {
            const itemType = item.type === 'movie' ? 'Movie' : 'Series';
            // The item.id is now the unique series name, fixing the details bug
            return `
                <div class="vod-item" data-id="${item.id}"> 
                    <span class="vod-type-badge">${itemType}</span>
                    <div class="vod-item-poster">
                        <img src="${item.logo}" 
                             alt="${item.name}" 
                             onerror="this.onerror=null; this.src='https_placehold.co/400x600/1f2937/d1d5db?text=${encodeURIComponent(item.name)}'; this.style.objectFit='cover';">
                    </div>
                    <div class="vod-item-info">
                        <p class="vod-item-title" title="${item.name}">${item.name}</p>
                        <p class="vod-item-type">${item.group || 'Uncategorized'}</p>
                    </div>
                </div>
            `;
        }).join('');
    }

    // 6. Render the pagination controls
    renderVodPagination();
}

/**
 * NEW: Renders the pagination controls for the VOD page.
 */
function renderVodPagination() {
    const { currentPage, totalPages, totalItems } = vodState.pagination;
    const controlsEl = UIElements.vodPaginationControls;
    const infoEl = UIElements.vodPaginationInfo;
    const prevBtn = UIElements.vodPrevBtn;
    const nextBtn = UIElements.vodNextBtn;

    if (!controlsEl || !infoEl || !prevBtn || !nextBtn) {
        // Elements not on page yet, do nothing.
        return;
    }

    if (totalPages <= 1) {
        controlsEl.classList.add('hidden');
        return;
    }
    
    controlsEl.classList.remove('hidden');
    
    infoEl.textContent = `Page ${currentPage} of ${totalPages} (${totalItems} items)`;
    
    prevBtn.disabled = currentPage === 1;
    nextBtn.disabled = currentPage === totalPages;
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
 *
 * --- UPDATED ---
 * - Adds event listeners for new pagination controls.
 * - Resets pagination to page 1 when any filter is changed.
 */
function setupVodEventListeners() {
    // --- Filter Bar Listeners ---
    UIElements.vodTypeAll.addEventListener('click', () => {
        UIElements.vodTypeAll.classList.add('active');
        UIElements.vodTypeMovies.classList.remove('active');
        UIElements.vodTypeSeries.classList.remove('active');
        vodState.pagination.currentPage = 1; // Reset page
        renderVodGrid();
    });
    UIElements.vodTypeMovies.addEventListener('click', () => {
        UIElements.vodTypeAll.classList.remove('active');
        UIElements.vodTypeMovies.classList.add('active');
        UIElements.vodTypeSeries.classList.remove('active');
        vodState.pagination.currentPage = 1; // Reset page
        renderVodGrid();
    });
    UIElements.vodTypeSeries.addEventListener('click', () => {
        UIElements.vodTypeAll.classList.remove('active');
        UIElements.vodTypeMovies.classList.remove('active');
        UIElements.vodTypeSeries.classList.add('active');
        vodState.pagination.currentPage = 1; // Reset page
        renderVodGrid();
    });

    UIElements.vodGroupFilter.addEventListener('change', () => {
        vodState.pagination.currentPage = 1; // Reset page
        renderVodGrid();
    });
    UIElements.vodSearchInput.addEventListener('input', () => {
        clearTimeout(vodState.searchDebounce);
        vodState.searchDebounce = setTimeout(() => {
            vodState.pagination.currentPage = 1; // Reset page
            renderVodGrid();
        }, 300);
    });
    
    // --- NEW: Page Size Listener ---
    UIElements.vodPageSize?.addEventListener('change', (e) => {
        vodState.pagination.pageSize = parseInt(e.target.value, 10);
        vodState.pagination.currentPage = 1; // Reset page
        renderVodGrid();
    });

    // --- VOD Grid Click Listener (Event Delegation) ---
    UIElements.vodGrid.addEventListener('click', (e) => {
        const vodItemEl = e.target.closest('.vod-item');
        if (vodItemEl) {
            const itemId = vodItemEl.dataset.id;
            // This find will now work correctly because item.id is the unique series name
            const item = vodState.fullLibrary.find(i => i.id === itemId);
            if (item) {
                openVodDetails(item);
            } else {
                console.error(`[VOD] Clicked item with id "${itemId}" but could not find it in fullLibrary.`);
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
    
    // --- NEW: Pagination Controls Listener ---
    UIElements.vodPaginationControls?.addEventListener('click', (e) => {
        const prevBtn = e.target.closest('#vod-prev-btn');
        const nextBtn = e.target.closest('#vod-next-btn');

        if (prevBtn && !prevBtn.disabled) {
            vodState.pagination.currentPage--;
            renderVodGrid();
        } else if (nextBtn && !nextBtn.disabled) {
            vodState.pagination.currentPage++;
            renderVodGrid();
        }
    });
}
