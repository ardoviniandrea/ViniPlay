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
    // Regex to find and strip SXXEXX patterns to get a clean series name
    const seriesNameRegex = /^(.*?) - (S\d+E\d+)/i;
    // Regex to extract season and episode numbers
    const seRegex = /(S(\d+)E(\d+)|(\d+)x(\d+))/i;

    for (const episode of seriesEpisodes) {
        let seriesName = episode.name;
        let seasonNum = 1; // Default to season 1
        let episodeNum = 0;

        // Try to find a clean series name
        const nameMatch = episode.name.match(seriesNameRegex);
        if (nameMatch && nameMatch[1]) {
            seriesName = nameMatch[1].trim(); // "My Show - S01E01" -> "My Show"
        }

        // Try to find season/episode numbers
        const seMatch = episode.name.match(seRegex);
        if (seMatch) {
            seasonNum = parseInt(seMatch[2] || seMatch[4], 10);
            episodeNum = parseInt(seMatch[3] || seMatch[5], 10);
        } else {
            // Fallback for episodes without clear S/E numbers (e.g., daily shows)
            // We'll just number them in the order they appear
            episodeNum = seriesMap.has(seriesName) ? seriesMap.get(seriesName).seasons.get(1).length + 1 : 1;
        }

        // Get or create the main series object
        if (!seriesMap.has(seriesName)) {
            seriesMap.set(seriesName, {
                type: 'series',
                id: episode.id, // Use first episode's ID as the "main" ID
                name: seriesName,
                logo: episode.logo, // Use first episode's logo
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
}

/**
 * Renders the VOD grid based on the current filters.
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

    // 2. Apply filters
    vodState.filteredLibrary = vodState.fullLibrary.filter(item => {
        const typeMatch = (typeFilter === 'all') || (typeFilter === 'movies' && item.type === 'movie') || (typeFilter === 'series' && item.type === 'series');
        const groupMatch = (groupFilter === 'all') || (item.group === groupFilter);
        const searchMatch = (searchFilter === '') || (item.name.toLowerCase().includes(searchFilter));
        
        return typeMatch && groupMatch && searchMatch;
    });

    // 3. Render HTML
    if (vodState.filteredLibrary.length === 0) {
        gridEl.innerHTML = '';
        noResultsEl.classList.remove('hidden');
        return;
    }

    noResultsEl.classList.add('hidden');
    gridEl.innerHTML = vodState.filteredLibrary.map(item => {
        const itemType = item.type === 'movie' ? 'Movie' : 'Series';
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

    // --- VOD Grid Click Listener (Event Delegation) ---
    UIElements.vodGrid.addEventListener('click', (e) => {
        const vodItemEl = e.target.closest('.vod-item');
        if (vodItemEl) {
            const itemId = vodItemEl.dataset.id;
            const item = vodState.fullLibrary.find(i => i.id === itemId);
            if (item) {
                openVodDetails(item);
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
