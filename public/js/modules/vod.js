/**
 * vod.js
 * * Manages all functionality for the new Video on Demand (VOD) page.
 * Handles parsing, filtering, rendering, and playback of movies and series.
 */

import { appState, UIElements, guideState } from './state.js'; // Keep guideState for settings
import { openModal, closeModal, showNotification, showResumePrompt } from './ui.js';
import { ICONS } from './icons.js';
import { saveUserSetting, fetchVodLibrary, fetchSeriesDetails, fetchMovieDetails, getWatchProgress, deleteWatchProgress } from './api.js';
import { playVOD } from './player.js';
import { proxiedImageUrl } from './utils.js';

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
    // Currently active movie or series in details modal
    currentDetailsItem: null,
    listenersInitialized: false,
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
 * Extracts a YouTube embed URL from an ID or full YouTube URL.
 * Returns null if not valid.
 */
function getYouTubeEmbedUrl(input) {
    if (!input || typeof input !== 'string') return null;
    const clean = input.trim();
    if (!clean || clean.toLowerCase() === 'n/a') return null;

    // Match patterns like youtube.com/watch?v=ID, youtu.be/ID, youtube.com/embed/ID
    const urlMatch = clean.match(/(?:youtu\.be\/|youtube\.com\/(?:embed\/|v\/|watch\?v=|watch\?.+&v=))([\w-]{11})/);
    if (urlMatch && urlMatch[1]) {
        return `https://www.youtube-nocookie.com/embed/${urlMatch[1]}?autoplay=1`;
    }

    // Direct 11-char ID
    if (/^[\w-]{11}$/.test(clean)) {
        return `https://www.youtube-nocookie.com/embed/${clean}?autoplay=1`;
    }

    return null;
}

/**
 * Copies a stream URL to the clipboard with user feedback.
 */
function copyStreamLinkToClipboard(url) {
    if (!url) {
        showNotification('No stream URL available to copy.', true);
        return;
    }

    const onCopied = () => {
        showNotification('Stream link copied to clipboard (ready for VLC/external players)', false, 2500);
    };

    if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(url).then(onCopied).catch(() => {
            fallbackCopyText(url, onCopied);
        });
    } else {
        fallbackCopyText(url, onCopied);
    }
}

function fallbackCopyText(text, successCb) {
    try {
        const textArea = document.createElement('textarea');
        textArea.value = text;
        textArea.style.position = 'fixed';
        textArea.style.left = '-9999px';
        document.body.appendChild(textArea);
        textArea.focus();
        textArea.select();
        const successful = document.execCommand('copy');
        document.body.removeChild(textArea);
        if (successful) {
            if (successCb) successCb();
            else showNotification('Stream link copied to clipboard (ready for VLC/external players)', false, 2500);
        } else {
            showNotification('Could not copy link to clipboard.', true);
        }
    } catch (err) {
        console.error('[VOD] Fallback copy error:', err);
        showNotification('Could not copy link to clipboard.', true);
    }
}

/**
 * Opens the in-app YouTube trailer modal.
 */
function openTrailerModal(title, embedUrl) {
    if (!UIElements.vodTrailerModal) return;
    if (UIElements.vodTrailerTitle) {
        UIElements.vodTrailerTitle.textContent = title ? `${title} - Trailer` : 'Movie Trailer';
    }
    if (UIElements.vodTrailerIframe) {
        UIElements.vodTrailerIframe.src = embedUrl;
    }
    openModal(UIElements.vodTrailerModal);
}

/**
 * Closes the trailer modal and clears iframe src to prevent background audio.
 */
function closeTrailerModal() {
    if (!UIElements.vodTrailerModal) return;
    closeModal(UIElements.vodTrailerModal);
    if (UIElements.vodTrailerIframe) {
        UIElements.vodTrailerIframe.src = '';
    }
}

/**
 * Sanitizes IPTV media titles to remove provider prefixes, quality tags, and season indicators
 * for accurate searches on IMDb, TMDB, Trakt, Rotten Tomatoes, and Letterboxd.
 * e.g., "4K-IT - Cape Fear (2026) (US)" -> "Cape Fear"
 */
function cleanMediaTitle(rawTitle) {
    if (!rawTitle || typeof rawTitle !== 'string') return '';
    let title = rawTitle.trim();
    // Strip common IPTV provider/country prefixes: "4K-IT - ", "IT | ", "EN - ", "4K - ", "FHD : ", "IT: "
    title = title.replace(/^[A-Za-z0-9_\-\s]{1,10}\s*[-|:]\s*/i, '');
    // Strip bracketed quality/source tags: [4K], [UHD], [FHD], [HD], [1080p], [720p], [HEVC], [HDR], [Sub-ITA]
    title = title.replace(/\[[^\]]*(?:4k|uhd|fhd|hd|1080p|720p|hevc|hdr|aac|sub|ita|eng)[^\]]*\]/gi, '');
    // Strip parenthesized tags that are not a 4-digit year: (US), (UK), (IT), (Extended Cut), (4K), (UHD)
    title = title.replace(/\((?!\d{4}\b)[^)]*\)/g, '');
    // Strip trailing season markers: S01, Season 1, etc.
    title = title.replace(/\b(?:s\d{1,2}|season\s*\d{1,2})\b.*/gi, '');
    // Strip remaining 4-digit year in parentheses so cleanTitle is just the pure title
    title = title.replace(/\(\d{4}\)/g, '');
    return title.trim().replace(/\s+/g, ' ');
}

/**
 * Builds external aggregator links (IMDb, TMDB, Trakt, Rotten Tomatoes, Letterboxd).
 * Uses direct IDs if present; falls back to smart sanitized search query.
 */
function buildExternalMediaLinks(item) {
    if (!item) return {};
    const isMovie = item.type === 'movie';
    const cleanTitle = cleanMediaTitle(item.name || '');
    const rawYear = item.year || (item.release_date ? item.release_date.split('-')[0] : '');
    const cleanYear = rawYear && /^\d{4}$/.test(String(rawYear).trim()) ? String(rawYear).trim() : '';

    const query = cleanYear ? `${cleanTitle} ${cleanYear}` : cleanTitle;
    const encodedQuery = encodeURIComponent(query);
    const encodedTitle = encodeURIComponent(cleanTitle);

    const links = {
        imdb: null,
        tmdb: null,
        trakt: null,
        rt: null,
        letterboxd: null
    };

    if (cleanTitle) {
        // 1. IMDb
        if (item.imdb_id) {
            links.imdb = `https://www.imdb.com/title/${item.imdb_id}/`;
        } else {
            links.imdb = `https://www.imdb.com/find/?q=${encodedQuery}&s=tt`;
        }

        // 2. TMDB
        if (item.tmdb_id) {
            links.tmdb = `https://www.themoviedb.org/${isMovie ? 'movie' : 'tv'}/${item.tmdb_id}`;
        } else {
            links.tmdb = `https://www.themoviedb.org/search?query=${encodedTitle}`;
        }

        // 3. Trakt (Trakt web app uses ?q= parameter)
        links.trakt = `https://trakt.tv/search?q=${encodedTitle}`;

        // 4. Rotten Tomatoes (Searches by sanitized title)
        links.rt = `https://www.rottentomatoes.com/search?search=${encodedTitle}`;

        // 5. Letterboxd (Movies ONLY)
        if (isMovie) {
            if (item.tmdb_id) {
                links.letterboxd = `https://letterboxd.com/tmdb/${item.tmdb_id}/`;
            } else if (item.imdb_id) {
                links.letterboxd = `https://letterboxd.com/imdb/${item.imdb_id}/`;
            } else {
                links.letterboxd = `https://letterboxd.com/search/${encodedTitle}/`;
            }
        }
    }

    return links;
}

/**
 * Updates the external aggregator links bar in the VOD details modal.
 * Shows buttons that have a valid link and hides any whose link is empty/null.
 * If all links are empty/null, the entire row is hidden.
 */
function updateExternalLinksUI(item) {
    if (!UIElements.vodDetailsExternalLinks) return;

    const links = buildExternalMediaLinks(item);
    let visibleCount = 0;

    const configureLinkBtn = (btnElement, url) => {
        if (!btnElement) return;
        if (url) {
            btnElement.href = url;
            btnElement.classList.remove('hidden');
            visibleCount++;
        } else {
            btnElement.href = '#';
            btnElement.classList.add('hidden');
        }
    };

    configureLinkBtn(UIElements.vodLinkImdb, links.imdb);
    configureLinkBtn(UIElements.vodLinkTmdb, links.tmdb);
    configureLinkBtn(UIElements.vodLinkTrakt, links.trakt);
    configureLinkBtn(UIElements.vodLinkRt, links.rt);
    configureLinkBtn(UIElements.vodLinkLetterboxd, links.letterboxd);

    if (visibleCount > 0) {
        UIElements.vodDetailsExternalLinks.classList.remove('hidden');
    } else {
        UIElements.vodDetailsExternalLinks.classList.add('hidden');
    }
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
            const proxiedLogo = proxiedImageUrl(displayLogo);

            return `
                <div class="vod-item" data-id="${itemIdStr}">
                    <span class="vod-type-badge">${itemType}</span>
                    <div class="vod-item-poster">
                        <img src="${proxiedLogo}"
                             loading="lazy"
                             decoding="async"
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
 * Enriches metadata lazily for both movies and series with unified pill badges,
 * backdrop, in-app trailer playback, and stream link copying.
 * @param {object} item - The movie or series object (basic info) to display.
 */
async function openVodDetails(item) {
    if (!item) return;

    vodState.currentDetailsItem = item;

    try {
        // --- 1. Basic Fields (with image proxy) ---
        if (UIElements.vodDetailsTitle) UIElements.vodDetailsTitle.textContent = item.name || '';

        const posterUrl = item.logo || `https://placehold.co/400x600/1f2937/d1d5db?text=${encodeURIComponent(item.name || 'VOD')}`;
        const proxiedPoster = proxiedImageUrl(posterUrl);
        if (UIElements.vodDetailsPoster) UIElements.vodDetailsPoster.src = proxiedPoster;

        const initialBackdrop = item.backdrop_url ? proxiedImageUrl(item.backdrop_url) : (item.logo ? proxiedPoster : '');
        if (UIElements.vodDetailsBackdropImg) UIElements.vodDetailsBackdropImg.src = initialBackdrop;

        // --- 2. Initial Badges ---
        const initialYear = item.year || (item.release_date ? item.release_date.split('-')[0] : '');
        if (UIElements.vodDetailsYear) {
            if (initialYear) {
                UIElements.vodDetailsYear.textContent = initialYear;
                UIElements.vodDetailsYear.classList.remove('hidden');
            } else {
                UIElements.vodDetailsYear.classList.add('hidden');
            }
        }

        if (UIElements.vodDetailsDuration) {
            const initialDur = item.duration || (item.duration_secs ? formatEpisodeDuration(item.duration_secs) : '');
            if (initialDur) {
                UIElements.vodDetailsDuration.textContent = initialDur;
                UIElements.vodDetailsDuration.classList.remove('hidden');
            } else {
                UIElements.vodDetailsDuration.classList.add('hidden');
            }
        }

        if (UIElements.vodDetailsRating) {
            const initialRating = item.rating;
            if (initialRating && initialRating !== '0' && initialRating !== 'N/A') {
                const rNum = parseFloat(initialRating);
                UIElements.vodDetailsRating.innerHTML = `<span class="text-amber-400 font-bold">★</span> ${!isNaN(rNum) ? rNum.toFixed(1) : initialRating}`;
                UIElements.vodDetailsRating.classList.remove('hidden');
            } else {
                UIElements.vodDetailsRating.classList.add('hidden');
            }
        }

        if (UIElements.vodDetailsType) {
            if (item.type === 'movie') {
                UIElements.vodDetailsType.textContent = 'MOVIE';
                UIElements.vodDetailsType.className = 'px-2.5 py-0.5 rounded-full text-xs font-semibold bg-blue-600/30 text-blue-300 border border-blue-500/40';
            } else {
                UIElements.vodDetailsType.textContent = 'SERIES';
                UIElements.vodDetailsType.className = 'px-2.5 py-0.5 rounded-full text-xs font-semibold bg-purple-600/30 text-purple-300 border border-purple-500/40';
            }
        }

        if (UIElements.vodDetailsTmdb) {
            if (item.tmdb_id) {
                UIElements.vodDetailsTmdb.classList.remove('hidden');
            } else {
                UIElements.vodDetailsTmdb.classList.add('hidden');
            }
        }

        // --- 3. Initial Metadata Rows ---
        if (UIElements.vodDetailsReleaseDateRow && UIElements.vodDetailsReleaseDate) {
            if (item.release_date) {
                UIElements.vodDetailsReleaseDate.textContent = formatEpisodeDate(item.release_date);
                UIElements.vodDetailsReleaseDateRow.classList.remove('hidden');
            } else {
                UIElements.vodDetailsReleaseDateRow.classList.add('hidden');
            }
        }

        if (UIElements.vodDetailsCountryRow && UIElements.vodDetailsCountry) {
            if (item.country) {
                UIElements.vodDetailsCountry.textContent = item.country;
                UIElements.vodDetailsCountryRow.classList.remove('hidden');
            } else {
                UIElements.vodDetailsCountryRow.classList.add('hidden');
            }
        }

        if (UIElements.vodDetailsGenre) UIElements.vodDetailsGenre.textContent = item.genre || item.group || 'N/A';
        if (UIElements.vodDetailsDirector) UIElements.vodDetailsDirector.textContent = item.director || 'N/A';
        if (UIElements.vodDetailsCast) UIElements.vodDetailsCast.textContent = item.cast || 'N/A';
        if (UIElements.vodDetailsDesc) UIElements.vodDetailsDesc.textContent = item.description || `Details for ${item.name}.`;

        // --- 4. Initial Trailer & Copy Link Buttons ---
        const initialTrailerUrl = getYouTubeEmbedUrl(item.youtube_trailer);
        if (UIElements.vodWatchTrailerBtn) {
            if (initialTrailerUrl) {
                UIElements.vodWatchTrailerBtn.classList.remove('hidden');
                UIElements.vodWatchTrailerBtn.onclick = () => openTrailerModal(item.name, initialTrailerUrl);
            } else {
                UIElements.vodWatchTrailerBtn.classList.add('hidden');
                UIElements.vodWatchTrailerBtn.onclick = null;
            }
        }

        if (UIElements.vodCopyLinkBtn) {
            if (item.type === 'movie' && item.url) {
                UIElements.vodCopyLinkBtn.classList.remove('hidden');
                UIElements.vodCopyLinkBtn.onclick = () => copyStreamLinkToClipboard(vodState.currentDetailsItem?.url || item.url);
            } else {
                UIElements.vodCopyLinkBtn.classList.add('hidden');
            }
        }

        // --- 5. Initial Technical Info ---
        if (UIElements.vodTechProviderBadge) {
            UIElements.vodTechProviderBadge.textContent = item.provider_name || 'IPTV Source';
        }
        if (UIElements.vodTechStreamDetails) {
            UIElements.vodTechStreamDetails.textContent = '';
        }

        // --- 6. Reset Actions Containers ---
        if (UIElements.vodDetailsMovieActions) UIElements.vodDetailsMovieActions.classList.add('hidden');
        if (UIElements.vodDetailsSeriesActions) UIElements.vodDetailsSeriesActions.classList.add('hidden');
        if (UIElements.vodSeasonSelect) UIElements.vodSeasonSelect.innerHTML = '';
        if (UIElements.vodSeasonTabs) UIElements.vodSeasonTabs.innerHTML = '';
        if (UIElements.vodEpisodesCountBadge) UIElements.vodEpisodesCountBadge.textContent = '0';
        if (UIElements.vodEpisodeList) UIElements.vodEpisodeList.innerHTML = '<div class="p-6 text-center text-gray-400">Loading episodes...</div>';

        // Update external aggregator links (IMDb, TMDB, Trakt, RT, Letterboxd)
        updateExternalLinksUI(item);

        // Open modal immediately to give instant visual feedback
        if (UIElements.vodDetailsModal) {
            openModal(UIElements.vodDetailsModal);
        }
    } catch (initErr) {
        console.error('[VOD] Error preparing VOD modal fields:', initErr);
        if (UIElements.vodDetailsModal) openModal(UIElements.vodDetailsModal);
    }

    // --- 7. Movie Logic (Rich Metadata Enrichment & Play) ---
    if (item.type === 'movie') {
        if (UIElements.vodDetailsMovieActions) UIElements.vodDetailsMovieActions.classList.remove('hidden');

        // Helper to bind the play movie click action with watch progress
        const bindMoviePlayBtn = (targetMovie) => {
            const movieUrl = targetMovie.url;
            const movieName = targetMovie.name;
            const movieLogo = targetMovie.logo;
            const durationSecs = targetMovie.duration_secs || (typeof targetMovie.duration === 'number' ? targetMovie.duration : null);

            UIElements.vodPlayMovieBtn.onclick = null;
            UIElements.vodPlayMovieBtn.onclick = async () => {
                const movieMediaInfo = {
                    contentType: 'vod_movie',
                    contentId: String(targetMovie.id),
                    title: movieName,
                    duration: durationSecs || 0
                };
                closeModal(UIElements.vodDetailsModal);

                try {
                    const prog = await getWatchProgress('vod_movie', targetMovie.id);
                    if (prog && prog.progress_seconds >= 15 && (!prog.duration_seconds || prog.progress_seconds < prog.duration_seconds * 0.95)) {
                        showResumePrompt({
                            title: movieName,
                            progressSeconds: prog.progress_seconds,
                            durationSeconds: prog.duration_seconds || durationSecs || 0,
                            onResume: () => playVOD(movieUrl, movieName, movieLogo, prog.progress_seconds, durationSecs || null, movieMediaInfo),
                            onStartOver: () => {
                                deleteWatchProgress('vod_movie', targetMovie.id);
                                playVOD(movieUrl, movieName, movieLogo, 0, durationSecs || null, movieMediaInfo);
                            }
                        });
                        return;
                    }
                } catch (err) {
                    console.warn('[VOD] Error checking movie watch progress:', err);
                }

                playVOD(movieUrl, movieName, movieLogo, 0, durationSecs || null, movieMediaInfo);
            };
        };

        // Bind initial handler
        bindMoviePlayBtn(item);

        // Fetch rich movie details lazily from server
        const fullMovieData = await fetchMovieDetails(item.id);
        if (fullMovieData) {
            console.log(`[VOD] Enriched movie data for ID ${item.id}:`, fullMovieData);
            vodState.currentDetailsItem = fullMovieData;

            // Update Backdrop
            if (fullMovieData.backdrop_url && UIElements.vodDetailsBackdropImg) {
                UIElements.vodDetailsBackdropImg.src = proxiedImageUrl(fullMovieData.backdrop_url);
            }

            // Update Year
            const movieYear = (fullMovieData.release_date ? fullMovieData.release_date.split('-')[0] : '') || fullMovieData.year || item.year;
            if (UIElements.vodDetailsYear) {
                if (movieYear) {
                    UIElements.vodDetailsYear.textContent = movieYear;
                    UIElements.vodDetailsYear.classList.remove('hidden');
                } else {
                    UIElements.vodDetailsYear.classList.add('hidden');
                }
            }

            // Update Duration
            const dur = fullMovieData.duration || (fullMovieData.duration_secs ? formatEpisodeDuration(fullMovieData.duration_secs) : null);
            if (UIElements.vodDetailsDuration) {
                if (dur) {
                    UIElements.vodDetailsDuration.textContent = dur;
                    UIElements.vodDetailsDuration.classList.remove('hidden');
                } else {
                    UIElements.vodDetailsDuration.classList.add('hidden');
                }
            }

            // Update Rating
            if (UIElements.vodDetailsRating) {
                const r = fullMovieData.rating;
                if (r && r !== '0' && r !== 'N/A') {
                    const num = parseFloat(r);
                    UIElements.vodDetailsRating.innerHTML = `<span class="text-amber-400 font-bold">★</span> ${!isNaN(num) ? num.toFixed(1) : r}`;
                    UIElements.vodDetailsRating.classList.remove('hidden');
                } else {
                    UIElements.vodDetailsRating.classList.add('hidden');
                }
            }

            // Update TMDB Badge
            if (UIElements.vodDetailsTmdb) {
                if (fullMovieData.tmdb_id) {
                    UIElements.vodDetailsTmdb.classList.remove('hidden');
                } else {
                    UIElements.vodDetailsTmdb.classList.add('hidden');
                }
            }

            // Update Release Date Row
            if (UIElements.vodDetailsReleaseDateRow && UIElements.vodDetailsReleaseDate) {
                if (fullMovieData.release_date) {
                    UIElements.vodDetailsReleaseDate.textContent = formatEpisodeDate(fullMovieData.release_date);
                    UIElements.vodDetailsReleaseDateRow.classList.remove('hidden');
                } else {
                    UIElements.vodDetailsReleaseDateRow.classList.add('hidden');
                }
            }

            // Update Country Row
            if (UIElements.vodDetailsCountryRow && UIElements.vodDetailsCountry) {
                if (fullMovieData.country) {
                    UIElements.vodDetailsCountry.textContent = fullMovieData.country;
                    UIElements.vodDetailsCountryRow.classList.remove('hidden');
                } else {
                    UIElements.vodDetailsCountryRow.classList.add('hidden');
                }
            }

            // Update Director, Cast, Genre, Description
            if (fullMovieData.director && UIElements.vodDetailsDirector) UIElements.vodDetailsDirector.textContent = fullMovieData.director;
            if (fullMovieData.cast && UIElements.vodDetailsCast) UIElements.vodDetailsCast.textContent = fullMovieData.cast;
            if (fullMovieData.genre && UIElements.vodDetailsGenre) UIElements.vodDetailsGenre.textContent = fullMovieData.genre;
            if (fullMovieData.description && UIElements.vodDetailsDesc) UIElements.vodDetailsDesc.textContent = fullMovieData.description;

            // Update Trailer Button
            const embedUrl = getYouTubeEmbedUrl(fullMovieData.youtube_trailer);
            if (UIElements.vodWatchTrailerBtn) {
                if (embedUrl) {
                    UIElements.vodWatchTrailerBtn.classList.remove('hidden');
                    UIElements.vodWatchTrailerBtn.onclick = () => openTrailerModal(fullMovieData.name || item.name, embedUrl);
                } else {
                    UIElements.vodWatchTrailerBtn.classList.add('hidden');
                    UIElements.vodWatchTrailerBtn.onclick = null;
                }
            }

            // Update Copy Stream Link Button
            const playableUrl = fullMovieData.url || item.url;
            if (UIElements.vodCopyLinkBtn) {
                if (playableUrl) {
                    UIElements.vodCopyLinkBtn.classList.remove('hidden');
                    UIElements.vodCopyLinkBtn.onclick = () => copyStreamLinkToClipboard(playableUrl);
                } else {
                    UIElements.vodCopyLinkBtn.classList.add('hidden');
                }
            }

            // Update Technical Info
            if (UIElements.vodTechProviderBadge) {
                UIElements.vodTechProviderBadge.textContent = fullMovieData.provider_name || item.provider_name || 'IPTV Source';
            }
            if (UIElements.vodTechStreamDetails) {
                const techParts = [];
                if (fullMovieData.container_extension) techParts.push(`Format: ${fullMovieData.container_extension.toUpperCase()}`);
                if (fullMovieData.stream_id) techParts.push(`Stream ID: ${fullMovieData.stream_id}`);
                UIElements.vodTechStreamDetails.textContent = techParts.join(' • ');
            }

            // Update external aggregator links with enriched movie metadata
            updateExternalLinksUI(fullMovieData);

            // Re-bind play handler with the refreshed movie URL & metadata
            bindMoviePlayBtn(fullMovieData);
        }

    // --- 8. Series Logic (Lazy Loading & Season Tabs) ---
    } else if (item.type === 'series') {
        if (UIElements.vodDetailsSeriesActions) UIElements.vodDetailsSeriesActions.classList.remove('hidden');
        if (UIElements.vodCopyLinkBtn) UIElements.vodCopyLinkBtn.classList.add('hidden');

        // Fetch full series details including episodes
        const fullSeriesData = await fetchSeriesDetails(item.id);
        console.log(`[VOD] Fetched full series data for ID ${item.id}:`, fullSeriesData);

        if (fullSeriesData) {
            vodState.currentDetailsItem = fullSeriesData;

            // Update Backdrop
            if (fullSeriesData.backdrop_url && UIElements.vodDetailsBackdropImg) {
                UIElements.vodDetailsBackdropImg.src = proxiedImageUrl(fullSeriesData.backdrop_url);
            }

            // Update Year
            const seriesYear = (fullSeriesData.release_date ? fullSeriesData.release_date.split('-')[0] : '') || fullSeriesData.year || item.year;
            if (UIElements.vodDetailsYear) {
                if (seriesYear) {
                    UIElements.vodDetailsYear.textContent = seriesYear;
                    UIElements.vodDetailsYear.classList.remove('hidden');
                } else {
                    UIElements.vodDetailsYear.classList.add('hidden');
                }
            }

            // Update Rating
            if (UIElements.vodDetailsRating) {
                const r = fullSeriesData.rating;
                if (r && r !== '0' && r !== 'N/A') {
                    const num = parseFloat(r);
                    UIElements.vodDetailsRating.innerHTML = `<span class="text-amber-400 font-bold">★</span> ${!isNaN(num) ? num.toFixed(1) : r}`;
                    UIElements.vodDetailsRating.classList.remove('hidden');
                } else {
                    UIElements.vodDetailsRating.classList.add('hidden');
                }
            }

            // Update TMDB Badge
            if (UIElements.vodDetailsTmdb) {
                if (fullSeriesData.tmdb_id) {
                    UIElements.vodDetailsTmdb.classList.remove('hidden');
                } else {
                    UIElements.vodDetailsTmdb.classList.add('hidden');
                }
            }

            // Update Release Date Row
            if (UIElements.vodDetailsReleaseDateRow && UIElements.vodDetailsReleaseDate) {
                if (fullSeriesData.release_date) {
                    UIElements.vodDetailsReleaseDate.textContent = formatEpisodeDate(fullSeriesData.release_date);
                    UIElements.vodDetailsReleaseDateRow.classList.remove('hidden');
                } else {
                    UIElements.vodDetailsReleaseDateRow.classList.add('hidden');
                }
            }

            // Update Country Row
            if (UIElements.vodDetailsCountryRow && UIElements.vodDetailsCountry) {
                if (fullSeriesData.country) {
                    UIElements.vodDetailsCountry.textContent = fullSeriesData.country;
                    UIElements.vodDetailsCountryRow.classList.remove('hidden');
                } else {
                    UIElements.vodDetailsCountryRow.classList.add('hidden');
                }
            }

            // Update Director, Cast, Genre, Description
            if (fullSeriesData.director && UIElements.vodDetailsDirector) UIElements.vodDetailsDirector.textContent = fullSeriesData.director;
            if (fullSeriesData.cast && UIElements.vodDetailsCast) UIElements.vodDetailsCast.textContent = fullSeriesData.cast;
            if (fullSeriesData.genre && UIElements.vodDetailsGenre) UIElements.vodDetailsGenre.textContent = fullSeriesData.genre;
            if (fullSeriesData.description && UIElements.vodDetailsDesc) UIElements.vodDetailsDesc.textContent = fullSeriesData.description;

            // Update Trailer Button
            const embedUrl = getYouTubeEmbedUrl(fullSeriesData.youtube_trailer);
            if (UIElements.vodWatchTrailerBtn) {
                if (embedUrl) {
                    UIElements.vodWatchTrailerBtn.classList.remove('hidden');
                    UIElements.vodWatchTrailerBtn.onclick = () => openTrailerModal(fullSeriesData.name || item.name, embedUrl);
                } else {
                    UIElements.vodWatchTrailerBtn.classList.add('hidden');
                    UIElements.vodWatchTrailerBtn.onclick = null;
                }
            }

            // Update Technical Info
            if (UIElements.vodTechProviderBadge) {
                UIElements.vodTechProviderBadge.textContent = fullSeriesData.provider_name || item.provider_name || 'IPTV Source';
            }

            // Update external aggregator links with enriched series metadata
            updateExternalLinksUI(fullSeriesData);
        }

        // Store logo on episode list for click player
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
            if (UIElements.vodDetailsDuration) {
                UIElements.vodDetailsDuration.classList.add('hidden');
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

        if (UIElements.vodDetailsDuration) {
            if (sortedSeasonKeys.length > 0) {
                UIElements.vodDetailsDuration.textContent = `${sortedSeasonKeys.length} Season${sortedSeasonKeys.length > 1 ? 's' : ''}`;
                UIElements.vodDetailsDuration.classList.remove('hidden');
            } else {
                UIElements.vodDetailsDuration.classList.add('hidden');
            }
        }

        if (UIElements.vodTechStreamDetails) {
            UIElements.vodTechStreamDetails.textContent = `${sortedSeasonKeys.length} Season${sortedSeasonKeys.length > 1 ? 's' : ''} • ${totalEpisodes} Episode${totalEpisodes > 1 ? 's' : ''}`;
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
                <div class="episode-item-actions">
                    <button class="episode-item-copy-btn" title="Copy stream link (for VLC/external players)" aria-label="Copy stream link">
                        ${ICONS.clipboard}
                    </button>
                    <button class="episode-item-play-btn" title="Play Episode" aria-label="Play Episode">
                        ${ICONS.play}
                    </button>
                </div>
            </div>
        `;
    }).join('');
}


/**
 * Sets up all event listeners for the VOD page and its modals.
 */
function setupVodEventListeners() {
    if (vodState.listenersInitialized) return;
    vodState.listenersInitialized = true;

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
    if (UIElements.vodDetailsCloseBtn) {
        UIElements.vodDetailsCloseBtn.addEventListener('click', () => {
            closeModal(UIElements.vodDetailsModal);
            if (UIElements.vodDetailsBackdropImg) {
                UIElements.vodDetailsBackdropImg.src = '';
            }
            closeTrailerModal();
        });
    }

    // --- VOD Trailer Modal Listeners ---
    if (UIElements.vodTrailerCloseBtn) {
        UIElements.vodTrailerCloseBtn.addEventListener('click', closeTrailerModal);
    }
    if (UIElements.vodTrailerModal) {
        UIElements.vodTrailerModal.addEventListener('click', (e) => {
            if (e.target === UIElements.vodTrailerModal) {
                closeTrailerModal();
            }
        });
    }

    // Episode list delegation (Copy Stream Link & Play Episode)
    if (UIElements.vodEpisodeList) {
        UIElements.vodEpisodeList.addEventListener('click', async (e) => {
            // Check if Copy Link button was clicked
            const copyBtn = e.target.closest('.episode-item-copy-btn');
            if (copyBtn) {
                e.stopPropagation();
                const episodeItem = copyBtn.closest('.episode-item');
                const url = episodeItem ? episodeItem.dataset.url : null;
                copyStreamLinkToClipboard(url);
                return;
            }

            // Episode play click
            const playBtn = e.target.closest('.episode-item-play-btn');
            const episodeItem = e.target.closest('.episode-item');
            if (episodeItem && (playBtn || !e.target.closest('button'))) {
                const url = episodeItem.dataset.url;
                const title = episodeItem.dataset.title;
                const episodeId = episodeItem.dataset.id || url;
                const seriesLogo = UIElements.vodEpisodeList.dataset.seriesLogo || '';

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
