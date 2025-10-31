// vodProcessor.js
const XtreamClient = require('./xtreamClient');

/**
 * Main function to refresh all VOD content for a given provider.
 * @param {sqlite.Database} db - The database instance.
 * @param {object} provider - The provider object (id, server_url, username, password).
 * @param {function} sendStatus - Function to send status updates to the client.
 */
async function refreshVodContent(db, dbGet, dbAll, dbRun, provider, sendStatus = () => {}) {
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

    const client = new XtreamClient(server_url, username, password);
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
    try {
        sendStatus(`Fetching VOD and Series categories for ${provider.name}...`, 'info');
        const vodCategories = await client.getVodCategories();
        const seriesCategories = await client.getSeriesCategories();
        
        const allCategories = {};
        if (vodCategories && Array.isArray(vodCategories)) {
            vodCategories.forEach(cat => allCategories[cat.category_id] = cat);
        }
        if (seriesCategories && Array.isArray(seriesCategories)) {
            seriesCategories.forEach(cat => allCategories[cat.category_id] = cat);
        }
        const combinedCategories = Object.values(allCategories);

        if (combinedCategories.length > 0) {
            console.log(`[VOD Processor] Fetched ${combinedCategories.length} combined VOD/Series categories from provider.`);
            sendStatus(`Processing ${combinedCategories.length} VOD/Series categories...`, 'info');
            
            await dbRun(db, "BEGIN TRANSACTION");
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
        }
    } catch (error) {
        await dbRun(db, "ROLLBACK");
        console.error(`[VOD Processor] Category processing FAILED for ${provider.name}:`, error.message);
        sendStatus(`Category processing FAILED for ${provider.name}: ${error.message}`, 'error');
        return; // Stop if categories fail
    }

    // --- 1. Process Movies ---
    try {
        sendStatus(`Fetching movies for ${provider.name}...`, 'info');
        const movies = await client.getVodStreams();
        
        if (movies && Array.isArray(movies)) {
            console.log(`[VOD Processor] Fetched ${movies.length} movies from provider.`);
            sendStatus(`Processing ${movies.length} movies...`, 'info');

            await dbRun(db, "BEGIN TRANSACTION");

            const existingMovies = await dbAll(db, 'SELECT id, provider_unique_id FROM movies WHERE provider_unique_id IS NOT NULL');
            const providerUniqueIdMap = new Map(existingMovies.map(m => [m.provider_unique_id, m.id]));

            const movieInsertStmt = db.prepare(`INSERT INTO movies (name, year, description, logo, category_name, provider_unique_id) VALUES (?, ?, ?, ?, ?, ?)`);
            const movieUpdateStmt = db.prepare(`UPDATE movies SET name = ?, year = ?, description = ?, logo = ?, category_name = ? WHERE id = ?`);
            const relationInsertStmt = db.prepare(`INSERT OR REPLACE INTO provider_movie_relations (provider_id, movie_id, stream_id, container_extension, last_seen) VALUES (?, ?, ?, ?, ?)`);
            
            for (const movieData of movies) {
                const { name, plot, stream_icon, stream_id, container_extension, category_id } = movieData;
                if (!stream_id) continue;

                const providerUniqueId = `movie_${providerId}_${stream_id}`;
                let year = null;
                if (movieData.releaseDate) year = new Date(movieData.releaseDate).getFullYear();
                else if (name) {
                    const yearMatch = name.match(/\((\d{4})\)/);
                    if (yearMatch) year = parseInt(yearMatch[1]);
                }
                const categoryName = categoryMap.get(String(category_id)) || 'VOD';

                let movieId = providerUniqueIdMap.get(providerUniqueId);

                if (movieId) {
                    // Update existing movie
                    await new Promise((resolve, reject) => movieUpdateStmt.run(name, year, plot, stream_icon, categoryName, movieId, (err) => err ? reject(err) : resolve()));
                } else {
                    // Create new movie
                    const result = await new Promise((resolve, reject) => {
                        movieInsertStmt.run(name, year, plot, stream_icon, categoryName, providerUniqueId, function(err) {
                            if (err) return reject(err);
                            resolve(this);
                        });
                    });
                    movieId = result.lastID;
                    providerUniqueIdMap.set(providerUniqueId, movieId);
                }
                
                await new Promise((resolve, reject) => relationInsertStmt.run(providerId, movieId, stream_id, container_extension || 'mp4', scanStartTime, (err) => err ? reject(err) : resolve()));
            }
            await new Promise(resolve => movieInsertStmt.finalize(resolve));
            await new Promise(resolve => movieUpdateStmt.finalize(resolve));
            await new Promise(resolve => relationInsertStmt.finalize(resolve));
            await dbRun(db, "COMMIT");
        }
    } catch (error) {
        await dbRun(db, "ROLLBACK");
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

            await dbRun(db, "BEGIN TRANSACTION");

            const existingSeries = await dbAll(db, 'SELECT id, provider_unique_id FROM series WHERE provider_unique_id IS NOT NULL');
            const providerUniqueIdMap = new Map(existingSeries.map(s => [s.provider_unique_id, s.id]));

            const seriesInsertStmt = db.prepare(`INSERT INTO series (name, year, description, logo, category_name, provider_unique_id) VALUES (?, ?, ?, ?, ?, ?)`);
            const seriesUpdateStmt = db.prepare(`UPDATE series SET name = ?, year = ?, description = ?, logo = ?, category_name = ? WHERE id = ?`);
            const seriesRelationInsertStmt = db.prepare(`INSERT OR REPLACE INTO provider_series_relations (provider_id, series_id, external_series_id, last_seen) VALUES (?, ?, ?, ?)`);

            for (const seriesData of series) {
                const { name, plot, cover, series_id: external_series_id, category_id } = seriesData;
                if (!external_series_id) continue;

                const providerUniqueId = `series_${providerId}_${external_series_id}`;
                let year = null;
                if (seriesData.releaseDate) year = new Date(seriesData.releaseDate).getFullYear();
                else if (name) {
                    const yearMatch = name.match(/\((\d{4})\)/);
                    if (yearMatch) year = parseInt(yearMatch[1]);
                }
                const categoryName = categoryMap.get(String(category_id)) || 'Series';

                let seriesId = providerUniqueIdMap.get(providerUniqueId);

                if (seriesId) {
                    // Update existing series
                    await new Promise((resolve, reject) => seriesUpdateStmt.run(name, year, plot, cover, categoryName, seriesId, (err) => err ? reject(err) : resolve()));
                } else {
                    // Create new series
                    const result = await new Promise((resolve, reject) => {
                        seriesInsertStmt.run(name, year, plot, cover, categoryName, providerUniqueId, function(err) {
                            if (err) return reject(err);
                            resolve(this);
                        });
                    });
                    seriesId = result.lastID;
                    providerUniqueIdMap.set(providerUniqueId, seriesId);
                }

                await new Promise((resolve, reject) => seriesRelationInsertStmt.run(providerId, seriesId, external_series_id, scanStartTime, (err) => err ? reject(err) : resolve()));
            }
            await new Promise(resolve => seriesInsertStmt.finalize(resolve));
            await new Promise(resolve => seriesUpdateStmt.finalize(resolve));
            await new Promise(resolve => seriesRelationInsertStmt.finalize(resolve));
            await dbRun(db, "COMMIT");
        }
    } catch (error) {
        await dbRun(db, "ROLLBACK");
        console.error(`[VOD Processor] Series processing FAILED for ${provider.name}:`, error.message);
        sendStatus(`Series processing FAILED for ${provider.name}: ${error.message}`, 'error');
    }

    // --- 4. Cleanup Stale Content ---
    try {
        console.log(`[VOD Processor] Cleaning up stale VOD content for ${provider.name}...`);
        sendStatus(`Cleaning up old VOD entries for ${provider.name}...`, 'info');
        
        await dbRun(db, "BEGIN TRANSACTION");
        
        const staleMovies = await dbRun(db, 'DELETE FROM provider_movie_relations WHERE provider_id = ? AND last_seen < ?', [providerId, scanStartTime]);
        if (staleMovies.changes > 0) console.log(`[VOD Processor] Removed ${staleMovies.changes} stale movie relations.`);

        const staleSeries = await dbRun(db, 'DELETE FROM provider_series_relations WHERE provider_id = ? AND last_seen < ?', [providerId, scanStartTime]);
        if (staleSeries.changes > 0) console.log(`[VOD Processor] Removed ${staleSeries.changes} stale series relations.`);

        const staleEpisodes = await dbRun(db, 'DELETE FROM provider_episode_relations WHERE provider_id = ? AND last_seen < ?', [providerId, scanStartTime]);
        if (staleEpisodes.changes > 0) console.log(`[VOD Processor] Removed ${staleEpisodes.changes} stale episode relations.`);

        // --- 5. Cleanup Orphaned Content ---
        await dbRun(db, `DELETE FROM movies WHERE id NOT IN (SELECT DISTINCT movie_id FROM provider_movie_relations)`);
        await dbRun(db, `DELETE FROM series WHERE id NOT IN (SELECT DISTINCT series_id FROM provider_series_relations)`);
        await dbRun(db, `DELETE FROM episodes WHERE id NOT IN (SELECT DISTINCT episode_id FROM provider_episode_relations)`);
        
        await dbRun(db, "COMMIT");
        console.log(`[VOD Processor] VOD cleanup completed for: ${provider.name}`);
    } catch (error) {
        await dbRun(db, "ROLLBACK");
        console.error(`[VOD Processor] Cleanup FAILED for ${provider.name}:`, error.message);
        sendStatus(`Cleanup FAILED for ${provider.name}: ${error.message}`, 'error');
    }
    
    console.log(`[VOD Processor] VOD refresh completed for: ${provider.name}`);
    sendStatus(`VOD refresh successful for ${provider.name}.`, 'success');
}

module.exports = { refreshVodContent };
