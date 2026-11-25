// vodProcessor.js
const XtreamClient = require('./xtreamClient');

/**
 * Main function to refresh all VOD content for a given provider.
 * @param {sqlite.Database} db - The database instance.
 * @param {function} dbGet - Promisified db.get.
 * @param {function} dbAll - Promisified db.all.
 * @param {function} dbRun - Promisified db.run.
 * @param {object} provider - The provider object (id, server_url, username, password).
 * @param {function} sendStatus - Function to send status updates to the client.
 * @param {string} userAgent - User agent string for HTTP requests.
 */
async function refreshVodContent(db, dbGet, dbAll, dbRun, provider, sendStatus = () => {}, userAgent) {
    console.log(`[VOD Processor] Starting VOD refresh for: ${provider.name}`);
    const scanStartTime = new Date().toISOString();
    
    let server_url, username, password;
    try {
        if (!provider.xc_data) {
            throw new Error('Provider object is missing xc_data.');
        }
        const xcInfo = JSON.parse(provider.xc_data);
        server_url = xcInfo.server;
        username = xcInfo.username;
        password = xcInfo.password;
        if (!server_url || !username || !password) {
            throw new Error('Missing server, username, or password within xc_data.');
        }
    } catch (parseError) {
        console.error(`[VOD Processor] Failed to parse XC credentials for provider ${provider.name}: ${parseError.message}`);
        sendStatus(`Failed to parse XC credentials for ${provider.name}`, 'error');
        return; // Stop processing this provider if credentials are bad
    }

    const client = new XtreamClient(server_url, username, password, userAgent);
    const providerId = provider.id;

    // --- Schema Migration ---
    try {
        await dbRun(db, "ALTER TABLE movies ADD COLUMN provider_unique_id TEXT");
    } catch (e) {
        if (!e.message.includes('duplicate column name')) {
            console.error('[VOD Processor] Schema migration for movies failed:', e.message);
        }
    }
    try {
        await dbRun(db, "ALTER TABLE series ADD COLUMN provider_unique_id TEXT");
    } catch (e) {
        if (!e.message.includes('duplicate column name')) {
            console.error('[VOD Processor] Schema migration for series failed:', e.message);
        }
    }

    // --- 0. Process Categories ---
    const categoryMap = new Map();
    const selectedGroups = Array.isArray(provider.selectedGroups) ? provider.selectedGroups : [];
    const isGroupFilteringActive = selectedGroups.length > 0;
    const selectedGroupSet = new Set(selectedGroups);
    let inCategoryTx = false;
    try {
        sendStatus(`Fetching VOD and Series categories for ${provider.name}...`, 'info');
        const vodCategories = await client.getVodCategories().catch(e => {
            console.warn(`[VOD Processor] Could not fetch VOD categories for ${provider.name}:`, e.message);
            return [];
        });
        const seriesCategories = await client.getSeriesCategories().catch(e => {
            console.warn(`[VOD Processor] Could not fetch Series categories for ${provider.name}:`, e.message);
            return [];
        });
        
        const allCategories = {};
        if (vodCategories && Array.isArray(vodCategories)) {
            vodCategories.forEach(cat => { if (cat?.category_id) allCategories[cat.category_id] = cat; });
        }
        if (seriesCategories && Array.isArray(seriesCategories)) {
            seriesCategories.forEach(cat => { if (cat?.category_id) allCategories[cat.category_id] = cat; });
        }
        const combinedCategories = Object.values(allCategories);

        if (combinedCategories.length > 0) {
            console.log(`[VOD Processor] Fetched ${combinedCategories.length} combined VOD/Series categories from provider.`);
            sendStatus(`Processing ${combinedCategories.length} VOD/Series categories...`, 'info');
            
            await dbRun(db, "BEGIN TRANSACTION");
            inCategoryTx = true;
            const categoryInsertStmt = db.prepare(`INSERT OR IGNORE INTO vod_categories (category_id, category_name) VALUES (?, ?)`);
            for (const catData of combinedCategories) {
                if (catData.category_id && catData.category_name) {
                    await new Promise((resolve, reject) => {
                        categoryInsertStmt.run(catData.category_id, catData.category_name, function(err) {
                            if (err) return reject(err);
                            resolve(this);
                        });
                    });
                    categoryMap.set(String(catData.category_id), catData.category_name);
                }
            }
            await new Promise(resolve => categoryInsertStmt.finalize(resolve));
            await dbRun(db, "COMMIT");
            inCategoryTx = false;
        }
    } catch (error) {
        if (inCategoryTx) {
            try { await dbRun(db, "ROLLBACK"); } catch (rbErr) {}
        }
        console.warn(`[VOD Processor] Category processing warning for ${provider.name}: ${error.message}. Proceeding with default categories.`);
    }

    let moviesSuccess = false;
    let seriesSuccess = false;

    // --- 1. Process Movies ---
    try {
        sendStatus(`Fetching movies for ${provider.name}...`, 'info');
        const movies = await client.getVodStreams();
        
        if (movies && Array.isArray(movies)) {
            console.log(`[VOD Processor] Fetched ${movies.length} movies from provider.`);
            sendStatus(`Processing ${movies.length} movies...`, 'info');

            let inMovieTx = false;
            let movieInsertStmt = null;
            let movieUpdateStmt = null;
            let relationInsertStmt = null;

            try {
                await dbRun(db, "BEGIN TRANSACTION");
                inMovieTx = true;

                const existingMovies = await dbAll(db, 'SELECT id, provider_unique_id FROM movies WHERE provider_unique_id IS NOT NULL');
                const providerUniqueIdMap = new Map(existingMovies.map(m => [m.provider_unique_id, m.id]));

                movieInsertStmt = db.prepare(`INSERT INTO movies (name, year, description, logo, category_name, provider_unique_id) VALUES (?, ?, ?, ?, ?, ?)`);
                movieUpdateStmt = db.prepare(`UPDATE movies SET name = ?, year = ?, description = ?, logo = ?, category_name = ? WHERE id = ?`);
                relationInsertStmt = db.prepare(`INSERT OR REPLACE INTO provider_movie_relations (provider_id, movie_id, stream_id, container_extension, last_seen) VALUES (?, ?, ?, ?, ?)`);
                
                let processedCount = 0;
                let skippedCount = 0;

                for (const movieData of movies) {
                    try {
                        const stream_id = movieData?.stream_id;
                        if (!stream_id) continue;

                        const rawName = (movieData.name || movieData.title || '').toString().trim();
                        const cleanName = rawName || `Movie ${stream_id}`;

                        const providerUniqueId = `movie_${providerId}_${stream_id}`;
                        let year = null;
                        if (movieData.releaseDate) {
                            const parsedYear = new Date(movieData.releaseDate).getFullYear();
                            if (!isNaN(parsedYear) && parsedYear > 1800 && parsedYear < 2100) {
                                year = parsedYear;
                            }
                        }
                        if (!year && cleanName) {
                            const yearMatch = cleanName.match(/\b(19\d\d|20\d\d)\b/);
                            if (yearMatch) {
                                const parsedYear = parseInt(yearMatch[1], 10);
                                if (!isNaN(parsedYear)) year = parsedYear;
                            }
                        }

                        const categoryName = categoryMap.get(String(movieData.category_id)) || 'VOD';
                        if (isGroupFilteringActive && !selectedGroupSet.has(categoryName)) {
                            continue;
                        }

                        const plot = movieData.plot || movieData.description || null;
                        const streamIcon = movieData.stream_icon || movieData.cover || movieData.cover_big || movieData.movie_image || null;
                        const container_extension = (movieData.container_extension || 'mp4').toString().replace(/^\./, '');

                        let movieId = providerUniqueIdMap.get(providerUniqueId);

                        if (movieId) {
                            // Update existing movie
                            await new Promise((resolve, reject) => movieUpdateStmt.run(cleanName, year, plot, streamIcon, categoryName, movieId, (err) => err ? reject(err) : resolve()));
                        } else {
                            // Create new movie
                            const result = await new Promise((resolve, reject) => {
                                movieInsertStmt.run(cleanName, year, plot, streamIcon, categoryName, providerUniqueId, function(err) {
                                    if (err) return reject(err);
                                    resolve(this);
                                });
                            });
                            movieId = result.lastID;
                            providerUniqueIdMap.set(providerUniqueId, movieId);
                        }
                        
                        await new Promise((resolve, reject) => relationInsertStmt.run(providerId, movieId, stream_id, container_extension, scanStartTime, (err) => err ? reject(err) : resolve()));
                        processedCount++;
                    } catch (itemErr) {
                        skippedCount++;
                        if (skippedCount <= 10) {
                            console.warn(`[VOD Processor] Skipping malformed movie (stream_id: ${movieData?.stream_id}):`, itemErr.message);
                        }
                    }
                }
                
                await dbRun(db, "COMMIT");
                inMovieTx = false;
                moviesSuccess = true;
                if (skippedCount > 0) {
                    console.warn(`[VOD Processor] Finished processing movies: ${processedCount} processed, ${skippedCount} skipped due to errors.`);
                }
            } catch (txErr) {
                if (inMovieTx) {
                    try { await dbRun(db, "ROLLBACK"); } catch (rbErr) {}
                }
                throw txErr;
            } finally {
                if (movieInsertStmt) await new Promise(resolve => movieInsertStmt.finalize(resolve));
                if (movieUpdateStmt) await new Promise(resolve => movieUpdateStmt.finalize(resolve));
                if (relationInsertStmt) await new Promise(resolve => relationInsertStmt.finalize(resolve));
            }
        } else {
            console.warn(`[VOD Processor] No movies returned or invalid format for ${provider.name}.`);
        }
    } catch (error) {
        console.error(`[VOD Processor] Movie processing FAILED for ${provider.name}:`, error.message);
        sendStatus(`Movie processing FAILED for ${provider.name}: ${error.message}`, 'error');
    }

    // --- 2. Process Series ---
    try {
        sendStatus(`Fetching series for ${provider.name}...`, 'info');
        const series = await client.getSeries();
        
        if (series && Array.isArray(series)) {
            console.log(`[VOD Processor] Fetched ${series.length} series from provider.`);
            sendStatus(`Processing ${series.length} series...`, 'info');

            let inSeriesTx = false;
            let seriesInsertStmt = null;
            let seriesUpdateStmt = null;
            let seriesRelationInsertStmt = null;

            try {
                await dbRun(db, "BEGIN TRANSACTION");
                inSeriesTx = true;

                const existingSeries = await dbAll(db, 'SELECT id, provider_unique_id FROM series WHERE provider_unique_id IS NOT NULL');
                const providerUniqueIdMap = new Map(existingSeries.map(s => [s.provider_unique_id, s.id]));

                seriesInsertStmt = db.prepare(`INSERT INTO series (name, year, description, logo, category_name, provider_unique_id) VALUES (?, ?, ?, ?, ?, ?)`);
                seriesUpdateStmt = db.prepare(`UPDATE series SET name = ?, year = ?, description = ?, logo = ?, category_name = ? WHERE id = ?`);
                seriesRelationInsertStmt = db.prepare(`INSERT OR REPLACE INTO provider_series_relations (provider_id, series_id, external_series_id, last_seen) VALUES (?, ?, ?, ?)`);

                let processedCount = 0;
                let skippedCount = 0;

                for (const seriesData of series) {
                    try {
                        const external_series_id = seriesData?.series_id;
                        if (!external_series_id) continue;

                        const rawName = (seriesData.name || seriesData.title || '').toString().trim();
                        const cleanName = rawName || `Series ${external_series_id}`;

                        const providerUniqueId = `series_${providerId}_${external_series_id}`;
                        let year = null;
                        if (seriesData.releaseDate) {
                            const parsedYear = new Date(seriesData.releaseDate).getFullYear();
                            if (!isNaN(parsedYear) && parsedYear > 1800 && parsedYear < 2100) {
                                year = parsedYear;
                            }
                        }
                        if (!year && cleanName) {
                            const yearMatch = cleanName.match(/\b(19\d\d|20\d\d)\b/);
                            if (yearMatch) {
                                const parsedYear = parseInt(yearMatch[1], 10);
                                if (!isNaN(parsedYear)) year = parsedYear;
                            }
                        }

                        const categoryName = categoryMap.get(String(seriesData.category_id)) || 'Series';
                        if (isGroupFilteringActive && !selectedGroupSet.has(categoryName)) {
                            continue;
                        }

                        const plot = seriesData.plot || seriesData.description || null;
                        const cover = seriesData.cover || seriesData.logo || seriesData.cover_big || null;

                        let seriesId = providerUniqueIdMap.get(providerUniqueId);

                        if (seriesId) {
                            // Update existing series
                            await new Promise((resolve, reject) => seriesUpdateStmt.run(cleanName, year, plot, cover, categoryName, seriesId, (err) => err ? reject(err) : resolve()));
                        } else {
                            // Create new series
                            const result = await new Promise((resolve, reject) => {
                                seriesInsertStmt.run(cleanName, year, plot, cover, categoryName, providerUniqueId, function(err) {
                                    if (err) return reject(err);
                                    resolve(this);
                                });
                            });
                            seriesId = result.lastID;
                            providerUniqueIdMap.set(providerUniqueId, seriesId);
                        }

                        await new Promise((resolve, reject) => seriesRelationInsertStmt.run(providerId, seriesId, external_series_id, scanStartTime, (err) => err ? reject(err) : resolve()));
                        processedCount++;
                    } catch (itemErr) {
                        skippedCount++;
                        if (skippedCount <= 10) {
                            console.warn(`[VOD Processor] Skipping malformed series (series_id: ${seriesData?.series_id}):`, itemErr.message);
                        }
                    }
                }
                
                await dbRun(db, "COMMIT");
                inSeriesTx = false;
                seriesSuccess = true;
                if (skippedCount > 0) {
                    console.warn(`[VOD Processor] Finished processing series: ${processedCount} processed, ${skippedCount} skipped due to errors.`);
                }
            } catch (txErr) {
                if (inSeriesTx) {
                    try { await dbRun(db, "ROLLBACK"); } catch (rbErr) {}
                }
                throw txErr;
            } finally {
                if (seriesInsertStmt) await new Promise(resolve => seriesInsertStmt.finalize(resolve));
                if (seriesUpdateStmt) await new Promise(resolve => seriesUpdateStmt.finalize(resolve));
                if (seriesRelationInsertStmt) await new Promise(resolve => seriesRelationInsertStmt.finalize(resolve));
            }
        } else {
            console.warn(`[VOD Processor] No series returned or invalid format for ${provider.name}.`);
        }
    } catch (error) {
        console.error(`[VOD Processor] Series processing FAILED for ${provider.name}:`, error.message);
        sendStatus(`Series processing FAILED for ${provider.name}: ${error.message}`, 'error');
    }

    // --- 4. Cleanup Stale Content ---
    try {
        console.log(`[VOD Processor] Cleaning up stale VOD content for ${provider.name}...`);
        sendStatus(`Cleaning up old VOD entries for ${provider.name}...`, 'info');
        
        await dbRun(db, "BEGIN TRANSACTION");
        
        // ONLY prune stale relations if the respective ingestion succeeded!
        // If movie ingestion failed, last_seen was not updated, so pruning would wipe all movies!
        if (moviesSuccess) {
            const staleMovies = await dbRun(db, 'DELETE FROM provider_movie_relations WHERE provider_id = ? AND last_seen < ?', [providerId, scanStartTime]);
            if (staleMovies.changes > 0) console.log(`[VOD Processor] Removed ${staleMovies.changes} stale movie relations.`);
        } else {
            console.warn(`[VOD Processor] Preserving existing movie relations for ${provider.name} because movie sync was incomplete or failed.`);
        }

        if (seriesSuccess) {
            const staleSeries = await dbRun(db, 'DELETE FROM provider_series_relations WHERE provider_id = ? AND last_seen < ?', [providerId, scanStartTime]);
            if (staleSeries.changes > 0) console.log(`[VOD Processor] Removed ${staleSeries.changes} stale series relations.`);

            // Prune episode relations for series that no longer exist for this provider
            const staleEpRelations = await dbRun(db, `DELETE FROM provider_episode_relations WHERE provider_id = ? AND episode_id IN (SELECT id FROM episodes WHERE series_id NOT IN (SELECT series_id FROM provider_series_relations WHERE provider_id = ?))`, [providerId, providerId]);
            if (staleEpRelations.changes > 0) console.log(`[VOD Processor] Removed ${staleEpRelations.changes} stale episode relations.`);
        } else {
            console.warn(`[VOD Processor] Preserving existing series relations for ${provider.name} because series sync was incomplete or failed.`);
        }

        // --- 5. Cleanup Orphaned Content ---
        await dbRun(db, `DELETE FROM movies WHERE id NOT IN (SELECT DISTINCT movie_id FROM provider_movie_relations)`);
        await dbRun(db, `DELETE FROM series WHERE id NOT IN (SELECT DISTINCT series_id FROM provider_series_relations)`);
        await dbRun(db, `DELETE FROM episodes WHERE series_id NOT IN (SELECT DISTINCT id FROM series)`);
        
        await dbRun(db, "COMMIT");
        console.log(`[VOD Processor] VOD cleanup completed for: ${provider.name}`);
    } catch (error) {
        try { await dbRun(db, "ROLLBACK"); } catch (rbErr) {}
        console.error(`[VOD Processor] Cleanup FAILED for ${provider.name}:`, error.message);
        sendStatus(`Cleanup FAILED for ${provider.name}: ${error.message}`, 'error');
    }
    
    console.log(`[VOD Processor] VOD refresh completed for: ${provider.name}`);
    sendStatus(`VOD refresh successful for ${provider.name}.`, 'success');
}

/**
 * Processes VOD content from a raw M3U file string.
 * @param {sqlite.Database} db - The database instance.
 * @param {function} dbGet - Promisified db.get.
 * @param {function} dbAll - Promisified db.all.
 * @param {function} dbRun - Promisified db.run.
 * @param {string} m3uContent - The full M3U file content as a string.
 * @param {object} provider - The provider object from settings.
 * @param {function} sendStatus - Function to send status updates to the client.
 */
async function processM3uVod(db, dbGet, dbAll, dbRun, m3uContent, provider, sendStatus = () => {}) {
    console.log(`[VOD Processor M3U] Starting VOD processing for M3U source: ${provider.name}`);
    const scanStartTime = new Date().toISOString();
    const providerId = provider.id;
    const selectedGroups = Array.isArray(provider.selectedGroups) ? provider.selectedGroups : [];
    const isGroupFilteringActive = selectedGroups.length > 0;
    const selectedGroupSet = new Set(selectedGroups);

    let inM3uTx = false;
    try {
        const lines = m3uContent.split('\n');
        let currentExtInf = null;
        const movies = [];
        const series = [];

        // Regex to extract attributes from #EXTINF
        const attributeRegex = /([a-zA-Z0-9_-]+)="([^"]*)"/g;

        for (const line of lines) {
            if (line.startsWith('#EXTINF:')) {
                currentExtInf = { line: line.trim(), attributes: {} };
                let match;
                while ((match = attributeRegex.exec(line)) !== null) {
                    currentExtInf.attributes[match[1]] = match[2];
                }
                const nameMatch = line.match(/,(.*)$/);
                currentExtInf.name = nameMatch ? nameMatch[1].trim() : 'Untitled';
            } else if (line.trim().startsWith('http') && currentExtInf) {
                const url = line.trim();
                const isMovie = url.includes('/movie/') || currentExtInf.attributes['tvg-type'] === 'movie';
                const isSeries = url.includes('/series/') || currentExtInf.attributes['tvg-type'] === 'series';

                if (isMovie) {
                    movies.push({ ...currentExtInf, url });
                } else if (isSeries) {
                    series.push({ ...currentExtInf, url });
                }
                currentExtInf = null; // Reset after processing a URL
            }
        }

        console.log(`[VOD Processor M3U] Found ${movies.length} movies and ${series.length} series in M3U.`);
        sendStatus(`Processing ${movies.length} movies and ${series.length} series from ${provider.name}...`, 'info');

        await dbRun(db, "BEGIN TRANSACTION");
        inM3uTx = true;

        // Process Movies
        if (movies.length > 0) {
            let movieInsertStmt = null;
            let movieRelationInsertStmt = null;
            try {
                movieInsertStmt = db.prepare(`INSERT OR IGNORE INTO movies (name, year, logo, category_name, provider_unique_id) VALUES (?, ?, ?, ?, ?)`);
                movieRelationInsertStmt = db.prepare(`INSERT OR REPLACE INTO provider_movie_relations (provider_id, movie_id, stream_id, container_extension, last_seen) VALUES (?, ?, ?, ?, ?)`);
                const existingMovies = await dbAll(db, 'SELECT id, provider_unique_id FROM movies WHERE provider_unique_id IS NOT NULL');
                const providerUniqueIdMap = new Map(existingMovies.map(m => [m.provider_unique_id, m.id]));

                for (const movieData of movies) {
                    try {
                        const { name, attributes, url } = movieData;
                        const streamId = url.substring(url.lastIndexOf('/') + 1).split('.')[0] || 'stream';
                        const providerUniqueId = `movie_${providerId}_${streamId}`;

                        const rawName = (name || '').toString().trim();
                        const cleanName = rawName || `Movie ${streamId}`;

                        let year = null;
                        const yearMatch = cleanName.match(/\b(19\d\d|20\d\d)\b/);
                        if (yearMatch) {
                            const parsedYear = parseInt(yearMatch[1], 10);
                            if (!isNaN(parsedYear)) year = parsedYear;
                        }

                        const logo = attributes['tvg-logo'] || null;
                        const categoryName = attributes['group-title'] || 'VOD';
                        if (isGroupFilteringActive && !selectedGroupSet.has(categoryName)) {
                            continue;
                        }

                        let movieId = providerUniqueIdMap.get(providerUniqueId);
                        if (!movieId) {
                            const result = await new Promise((resolve, reject) => {
                                movieInsertStmt.run(cleanName, year, logo, categoryName, providerUniqueId, function(err) {
                                    if (err) return reject(err);
                                    resolve(this);
                                });
                            });
                            movieId = result.lastID;
                            providerUniqueIdMap.set(providerUniqueId, movieId);
                        }
                        
                        const extension = url.split('.').pop() || 'mp4';
                        await new Promise((resolve, reject) => movieRelationInsertStmt.run(providerId, movieId, streamId, extension, scanStartTime, (err) => err ? reject(err) : resolve()));
                    } catch (mErr) {
                        console.warn(`[VOD Processor M3U] Skipping malformed movie:`, mErr.message);
                    }
                }
            } finally {
                if (movieInsertStmt) await new Promise(resolve => movieInsertStmt.finalize(resolve));
                if (movieRelationInsertStmt) await new Promise(resolve => movieRelationInsertStmt.finalize(resolve));
            }
        }

        // Process Series (basic info, not episodes from M3U)
        if (series.length > 0) {
            let seriesInsertStmt = null;
            let seriesRelationInsertStmt = null;
            try {
                seriesInsertStmt = db.prepare(`INSERT OR IGNORE INTO series (name, year, logo, category_name, provider_unique_id) VALUES (?, ?, ?, ?, ?)`);
                seriesRelationInsertStmt = db.prepare(`INSERT OR REPLACE INTO provider_series_relations (provider_id, series_id, external_series_id, last_seen) VALUES (?, ?, ?, ?)`);
                const existingSeries = await dbAll(db, 'SELECT id, provider_unique_id FROM series WHERE provider_unique_id IS NOT NULL');
                const providerUniqueIdMap = new Map(existingSeries.map(s => [s.provider_unique_id, s.id]));

                for (const seriesData of series) {
                    try {
                        const { name, attributes, url } = seriesData;
                        const rawName = (name || '').toString().trim();
                        const streamId = url.substring(url.lastIndexOf('/') + 1).split('.')[0] || 'series';
                        const cleanName = rawName || `Series ${streamId}`;

                        const externalSeriesId = (cleanName.replace(/\s+/g, '_').toLowerCase()) || streamId;
                        const providerUniqueId = `series_${providerId}_${externalSeriesId}`;

                        let year = null;
                        const yearMatch = cleanName.match(/\b(19\d\d|20\d\d)\b/);
                        if (yearMatch) {
                            const parsedYear = parseInt(yearMatch[1], 10);
                            if (!isNaN(parsedYear)) year = parsedYear;
                        }

                        const logo = attributes['tvg-logo'] || null;
                        const categoryName = attributes['group-title'] || 'Series';
                        if (isGroupFilteringActive && !selectedGroupSet.has(categoryName)) {
                            continue;
                        }

                        let seriesId = providerUniqueIdMap.get(providerUniqueId);
                        if (!seriesId) {
                            const result = await new Promise((resolve, reject) => {
                                seriesInsertStmt.run(cleanName, year, logo, categoryName, providerUniqueId, function(err) {
                                    if (err) return reject(err);
                                    resolve(this);
                                });
                            });
                            seriesId = result.lastID;
                            providerUniqueIdMap.set(providerUniqueId, seriesId);
                        }
                        
                        await new Promise((resolve, reject) => seriesRelationInsertStmt.run(providerId, seriesId, externalSeriesId, scanStartTime, (err) => err ? reject(err) : resolve()));
                    } catch (sErr) {
                        console.warn(`[VOD Processor M3U] Skipping malformed series:`, sErr.message);
                    }
                }
            } finally {
                if (seriesInsertStmt) await new Promise(resolve => seriesInsertStmt.finalize(resolve));
                if (seriesRelationInsertStmt) await new Promise(resolve => seriesRelationInsertStmt.finalize(resolve));
            }
        }

        await dbRun(db, "COMMIT");
        inM3uTx = false;
        sendStatus(`Successfully processed VOD content from ${provider.name}.`, 'success');

    } catch (error) {
        if (inM3uTx) {
            try { await dbRun(db, "ROLLBACK"); } catch (rbErr) {}
        }
        console.error(`[VOD Processor M3U] Processing FAILED for ${provider.name}:`, error.message);
        sendStatus(`M3U VOD processing FAILED for ${provider.name}: ${error.message}`, 'error');
    }
}

module.exports = { refreshVodContent, processM3uVod };
