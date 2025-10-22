// vodProcessor.js
const XtreamClient = require('./xtreamClient');

/**
 * Promisified version of db.run
 * @param {sqlite.Database} db - The database instance.
 * @param {string} sql - The SQL query.
 * @param {Array} params - Query parameters.
 * @returns {Promise<object>} - { lastID, changes }
 */
const dbRun = (db, sql, params = []) => {
    return new Promise((resolve, reject) => {
        db.run(sql, params, function (err) {
            if (err) return reject(err);
            resolve(this);
        });
    });
};

/**
 * Promisified version of db.get
 * @param {sqlite.Database} db - The database instance.
 * @param {string} sql - The SQL query.
 * @param {Array} params - Query parameters.
 * @returns {Promise<object|null>} - The first row found.
 */
const dbGet = (db, sql, params = []) => {
    return new Promise((resolve, reject) => {
        db.get(sql, params, (err, row) => {
            if (err) return reject(err);
            resolve(row);
        });
    });
};

/**
 * Promisified version of db.all
 * @param {sqlite.Database} db - The database instance.
 * @param {string} sql - The SQL query.
 * @param {Array} params - Query parameters.
 * @returns {Promise<Array>} - An array of rows.
 */
const dbAll = (db, sql, params = []) => {
    return new Promise((resolve, reject) => {
        db.all(sql, params, (err, rows) => {
            if (err) return reject(err);
            resolve(rows);
        });
    });
};

/**
 * Main function to refresh all VOD content for a given provider.
 * @param {sqlite.Database} db - The database instance.
 * @param {object} provider - The provider object (id, server_url, username, password).
 * @param {function} sendStatus - Function to send status updates to the client.
 */
async function refreshVodContent(db, provider, sendStatus = () => {}) {
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

    try {
        await dbRun(db, "BEGIN TRANSACTION");

        // --- 1. Process Movies ---
        sendStatus(`Fetching movies for ${provider.name}...`, 'info');
        const movies = await client.getVodStreams();
        
        if (movies && Array.isArray(movies)) {
            console.log(`[VOD Processor] Fetched ${movies.length} movies from provider.`);
            sendStatus(`Processing ${movies.length} movies...`, 'info');

            // Get all existing movies from DB for faster lookup
            const existingMovies = await dbAll(db, 'SELECT id, tmdb_id, imdb_id, name, year FROM movies');
            const movieMap = new Map(existingMovies.map(m => [m.tmdb_id, m.id]));
            movieMap.set(null, new Map(existingMovies.map(m => [m.imdb_id, m.id])));
            movieMap.set(null, movieMap.get(null).set(null, new Map(existingMovies.map(m => [`${m.name}_${m.year}`, m.id]))));

            const movieInsertStmt = db.prepare(`INSERT INTO movies (name, year, description, logo, tmdb_id, imdb_id) VALUES (?, ?, ?, ?, ?, ?)`);
            const relationInsertStmt = db.prepare(`INSERT OR REPLACE INTO provider_movie_relations (provider_id, movie_id, stream_id, container_extension, last_seen) VALUES (?, ?, ?, ?, ?)`);
            
            for (const movieData of movies) {
                const { name, tmdb_id, imdb_id, plot, stream_icon, stream_id, container_extension } = movieData;
                let year = null;
                if (movieData.releaseDate) year = new Date(movieData.releaseDate).getFullYear();
                else if (name) {
                    const yearMatch = name.match(/\((\d{4})\)/);
                    if (yearMatch) year = parseInt(yearMatch[1]);
                }

                // Deduplication Logic
                let movieId;
                if (tmdb_id && tmdb_id != "0" && movieMap.has(tmdb_id)) movieId = movieMap.get(tmdb_id);
                else if (imdb_id && imdb_id != "0" && movieMap.get(null).has(imdb_id)) movieId = movieMap.get(null).get(imdb_id);
                else if (name && year && movieMap.get(null).get(null).has(`${name}_${year}`)) movieId = movieMap.get(null).get(null).get(`${name}_${year}`);

                if (!movieId) {
                    // Create new movie
                    const result = await new Promise((resolve, reject) => {
                        movieInsertStmt.run(name, year, plot, stream_icon, (tmdb_id && tmdb_id != "0") ? tmdb_id : null, (imdb_id && imdb_id != "0") ? imdb_id : null, function(err) {
                            if (err) return reject(err);
                            resolve(this);
                        });
                    });
                    movieId = result.lastID;
                    // Add to map for this session
                    if (tmdb_id && tmdb_id != "0") movieMap.set(tmdb_id, movieId);
                    else if (imdb_id && imdb_id != "0") movieMap.get(null).set(imdb_id, movieId);
                    else if (name && year) movieMap.get(null).get(null).set(`${name}_${year}`, movieId);
                }
                
                // "Upsert" the relation
                relationInsertStmt.run(providerId, movieId, stream_id, container_extension || 'mp4', scanStartTime);
            }
            await new Promise(resolve => movieInsertStmt.finalize(resolve));
            await new Promise(resolve => relationInsertStmt.finalize(resolve));
        }

        // --- 2. Process Series ---
        sendStatus(`Fetching series for ${provider.name}...`, 'info');
        const series = await client.getSeries();
        
        if (series && Array.isArray(series)) {
            console.log(`[VOD Processor] Fetched ${series.length} series from provider.`);
            sendStatus(`Processing ${series.length} series...`, 'info');

            // Get all existing series from DB for faster lookup
            const existingSeries = await dbAll(db, 'SELECT id, tmdb_id, imdb_id, name, year FROM series');
            const seriesMap = new Map(existingSeries.map(s => [s.tmdb_id, s.id]));
            seriesMap.set(null, new Map(existingSeries.map(s => [s.imdb_id, s.id])));
            seriesMap.set(null, seriesMap.get(null).set(null, new Map(existingSeries.map(s => [`${s.name}_${s.year}`, s.id]))));

            const seriesInsertStmt = db.prepare(`INSERT INTO series (name, year, description, logo, tmdb_id, imdb_id) VALUES (?, ?, ?, ?, ?, ?)`);
            const seriesRelationInsertStmt = db.prepare(`INSERT OR REPLACE INTO provider_series_relations (provider_id, series_id, external_series_id, last_seen) VALUES (?, ?, ?, ?)`);
            const episodeInsertStmt = db.prepare(`INSERT INTO episodes (series_id, season_num, episode_num, name, description, air_date, tmdb_id) VALUES (?, ?, ?, ?, ?, ?, ?)`);
            const episodeRelationInsertStmt = db.prepare(`INSERT OR REPLACE INTO provider_episode_relations (provider_id, episode_id, provider_stream_id, container_extension, last_seen) VALUES (?, ?, ?, ?, ?)`);

            for (const seriesData of series) {
                const { name, tmdb_id, imdb_id, plot, cover, series_id: external_series_id } = seriesData;
                let year = null;
                if (seriesData.releaseDate) year = new Date(seriesData.releaseDate).getFullYear();
                else if (name) {
                    const yearMatch = name.match(/\((\d{4})\)/);
                    if (yearMatch) year = parseInt(yearMatch[1]);
                }

                // Deduplication Logic
                let seriesId;
                if (tmdb_id && tmdb_id != "0" && seriesMap.has(tmdb_id)) seriesId = seriesMap.get(tmdb_id);
                else if (imdb_id && imdb_id != "0" && seriesMap.get(null).has(imdb_id)) seriesId = seriesMap.get(null).get(imdb_id);
                else if (name && year && seriesMap.get(null).get(null).has(`${name}_${year}`)) seriesId = seriesMap.get(null).get(null).get(`${name}_${year}`);

                if (!seriesId) {
                    // Create new series
                    const result = await new Promise((resolve, reject) => {
                        seriesInsertStmt.run(name, year, plot, cover, (tmdb_id && tmdb_id != "0") ? tmdb_id : null, (imdb_id && imdb_id != "0") ? imdb_id : null, function(err) {
                            if (err) return reject(err);
                            resolve(this);
                        });
                    });
                    seriesId = result.lastID;
                    // Add to map for this session
                    if (tmdb_id && tmdb_id != "0") seriesMap.set(tmdb_id, seriesId);
                    else if (imdb_id && imdb_id != "0") seriesMap.get(null).set(imdb_id, seriesId);
                    else if (name && year) seriesMap.get(null).get(null).set(`${name}_${year}`, seriesId);
                }

                // "Upsert" the series relation
                seriesRelationInsertStmt.run(providerId, seriesId, external_series_id, scanStartTime);

                // --- 3. Process Episodes for this Series ---
                try {
                    const seriesInfo = await client.getSeriesInfo(external_series_id);
                    if (seriesInfo && seriesInfo.episodes) {
                        const seasons = Object.values(seriesInfo.episodes);
                        for (const season of seasons) {
                            for (const episodeData of season) {
                                const { id: episode_stream_id, season: season_num, episode_num, title, plot: description, air_date, tmdb_id: episode_tmdb_id, container_extension } = episodeData;
                                
                                // Find or create episode
                                let episodeRow = await dbGet('SELECT id FROM episodes WHERE series_id = ? AND season_num = ? AND episode_num = ?', [seriesId, season_num, episode_num]);
                                if (episode_tmdb_id && episode_tmdb_id != "0" && !episodeRow) {
                                    episodeRow = await dbGet('SELECT id FROM episodes WHERE tmdb_id = ?', [episode_tmdb_id]);
                                }
                                
                                let episodeId;
                                if (episodeRow) {
                                    episodeId = episodeRow.id;
                                } else {
                                    // Create new episode
                                    const epResult = await new Promise((resolve, reject) => {
                                        episodeInsertStmt.run(seriesId, season_num, episode_num, title, description, air_date, (episode_tmdb_id && episode_tmdb_id != "0") ? episode_tmdb_id : null, function(err) {
                                            if (err) return reject(err);
                                            resolve(this);
                                        });
                                    });
                                    episodeId = epResult.lastID;
                                }
                                // "Upsert" the episode relation
                                episodeRelationInsertStmt.run(providerId, episodeId, episode_stream_id, container_extension || 'mp4', scanStartTime);
                            }
                        }
                    }
                } catch (epError) {
                    console.error(`[VOD Processor] Failed to process episodes for series ${name}:`, epError.message);
                }
            }
            await new Promise(resolve => seriesInsertStmt.finalize(resolve));
            await new Promise(resolve => seriesRelationInsertStmt.finalize(resolve));
            await new Promise(resolve => episodeInsertStmt.finalize(resolve));
            await new Promise(resolve => episodeRelationInsertStmt.finalize(resolve));
        }

        // --- 4. Cleanup Stale Content ---
        console.log(`[VOD Processor] Cleaning up stale VOD content for ${provider.name}...`);
        sendStatus(`Cleaning up old VOD entries for ${provider.name}...`, 'info');
        
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
        console.log(`[VOD Processor] VOD refresh completed for: ${provider.name}`);
        sendStatus(`VOD refresh successful for ${provider.name}.`, 'success');

    } catch (error) {
        await dbRun(db, "ROLLBACK");
        console.error(`[VOD Processor] VOD refresh FAILED for ${provider.name}:`, error.message);
        sendStatus(`VOD refresh FAILED for ${provider.name}: ${error.message}`, 'error');
    }
}

module.exports = { refreshVodContent, dbRun, dbGet };
