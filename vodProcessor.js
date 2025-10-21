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
 * Finds or creates a generic movie in the database.
 * This is the core deduplication logic using TMDB/IMDB.
 * @param {sqlite.Database} db - The database instance.
 * @param {object} movieData - The movie data from the XC API.
 * @returns {Promise<number>} The ID of the found or created movie.
 */
async function findOrCreateMovie(db, movieData) {
    const { name, tmdb_id, imdb_id, plot, stream_icon } = movieData;
    
    // Extract year from 'name' (e.g., "Movie (2023)") or 'releaseDate'
    let year = null;
    if (movieData.releaseDate) {
        year = new Date(movieData.releaseDate).getFullYear();
    } else if (name) {
        const yearMatch = name.match(/\((\d{4})\)/);
        if (yearMatch) year = parseInt(yearMatch[1]);
    }

    // --- Deduplication Logic ---
    // 1. Try to find by TMDB ID (if valid)
    if (tmdb_id && tmdb_id != "0") {
        const row = await dbGet(db, 'SELECT id FROM movies WHERE tmdb_id = ?', [tmdb_id]);
        if (row) return row.id;
    }
    // 2. Try to find by IMDB ID (if valid)
    if (imdb_id && imdb_id != "0") {
        const row = await dbGet(db, 'SELECT id FROM movies WHERE imdb_id = ?', [imdb_id]);
        if (row) return row.id;
    }
    // 3. Fallback: Try to find by name and year
    if (name && year) {
        const row = await dbGet(db, 'SELECT id FROM movies WHERE name = ? AND year = ?', [name, year]);
        if (row) return row.id;
    }

    // 4. Not found, create it
    console.log(`[VOD Processor] Creating new movie: ${name}`);
    const result = await dbRun(
        db,
        `INSERT INTO movies (name, year, description, logo, tmdb_id, imdb_id)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [name, year, plot, stream_icon, (tmdb_id && tmdb_id != "0") ? tmdb_id : null, (imdb_id && imdb_id != "0") ? imdb_id : null]
    );
    return result.lastID;
}

/**
 * Finds or creates a generic series in the database.
 * @param {sqlite.Database} db - The database instance.
 * @param {object} seriesData - The series data from the XC API.
 * @returns {Promise<number>} The ID of the found or created series.
 */
async function findOrCreateSeries(db, seriesData) {
    const { name, tmdb_id, imdb_id, plot, cover } = seriesData;
    
    let year = null;
    if (seriesData.releaseDate) {
        year = new Date(seriesData.releaseDate).getFullYear();
    } else if (name) {
        const yearMatch = name.match(/\((\d{4})\)/);
        if (yearMatch) year = parseInt(yearMatch[1]);
    }

    // --- Deduplication Logic ---
    if (tmdb_id && tmdb_id != "0") {
        const row = await dbGet(db, 'SELECT id FROM series WHERE tmdb_id = ?', [tmdb_id]);
        if (row) return row.id;
    }
    if (imdb_id && imdb_id != "0") {
        const row = await dbGet(db, 'SELECT id FROM series WHERE imdb_id = ?', [imdb_id]);
        if (row) return row.id;
    }
    if (name && year) {
        const row = await dbGet(db, 'SELECT id FROM series WHERE name = ? AND year = ?', [name, year]);
        if (row) return row.id;
    }

    // 4. Not found, create it
    console.log(`[VOD Processor] Creating new series: ${name}`);
    const result = await dbRun(
        db,
        `INSERT INTO series (name, year, description, logo, tmdb_id, imdb_id)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [name, year, plot, cover, (tmdb_id && tmdb_id != "0") ? tmdb_id : null, (imdb_id && imdb_id != "0") ? imdb_id : null]
    );
    return result.lastID;
}

/**
 * Main function to refresh all VOD content for a given provider.
 * @param {sqlite.Database} db - The database instance.
 * @param {object} provider - The provider object (id, server_url, username, password).
 */
async function refreshVodContent(db, provider) {
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
        // Optional: Update provider status here if needed
        return; // Stop processing this provider if credentials are bad
    }


    
    const client = new XtreamClient(server_url, username, password);

    try {
        // --- 1. Process Movies ---
        const movies = await client.getVodStreams();
        if (movies && Array.isArray(movies)) {
            console.log(`[VOD Processor] Fetched ${movies.length} movies from provider.`);
            for (const movieData of movies) {
                try {
                    const movieId = await findOrCreateMovie(db, movieData);
                    const { stream_id, container_extension } = movieData;
                    
                    // "Upsert" the relation to link the provider to the movie
                    await dbRun(
                        db,
                        `INSERT INTO provider_movie_relations (provider_id, movie_id, stream_id, container_extension, last_seen)
                         VALUES (?, ?, ?, ?, ?)
                         ON CONFLICT(provider_id, stream_id) DO UPDATE SET
                           movie_id = excluded.movie_id,
                           container_extension = excluded.container_extension,
                           last_seen = excluded.last_seen`,
                        [provider.id, movieId, stream_id, container_extension || 'mp4', scanStartTime]
                    );
                } catch (err) {
                    console.error(`[VOD Processor] Failed to process movie ${movieData.name}:`, err.message);
                }
            }
        }

        // --- 2. Process Series ---
        const series = await client.getSeries();
        if (series && Array.isArray(series)) {
            console.log(`[VOD Processor] Fetched ${series.length} series from provider.`);
            for (const seriesData of series) {
                 try {
                    const seriesId = await findOrCreateSeries(db, seriesData);
                    const { series_id } = seriesData; // This is the provider's ID
                    
                    // "Upsert" the relation to link the provider to the series
                    await dbRun(
                        db,
                        `INSERT INTO provider_series_relations (provider_id, series_id, external_series_id, last_seen)
                         VALUES (?, ?, ?, ?)
                         ON CONFLICT(provider_id, external_series_id) DO UPDATE SET
                           series_id = excluded.series_id,
                           last_seen = excluded.last_seen`,
                        [provider.id, seriesId, series_id, scanStartTime]
                    );
                } catch (err) {
                    console.error(`[VOD Processor] Failed to process series ${seriesData.name}:`, err.message);
                }
            }
        }
        
        // --- 3. Cleanup Stale Content ---
        console.log(`[VOD Processor] Cleaning up stale VOD content...`);
        // Delete movie relations that were NOT seen during this scan
        const staleMovies = await dbRun(
            db,
            'DELETE FROM provider_movie_relations WHERE provider_id = ? AND last_seen < ?',
            [provider.id, scanStartTime]
        );
        if (staleMovies.changes > 0) console.log(`[VOD Processor] Removed ${staleMovies.changes} stale movie relations.`);

        // Delete series relations that were NOT seen during this scan
        const staleSeries = await dbRun(
            db,
            'DELETE FROM provider_series_relations WHERE provider_id = ? AND last_seen < ?',
            [provider.id, scanStartTime]
        );
        if (staleSeries.changes > 0) console.log(`[VOD Processor] Removed ${staleSeries.changes} stale series relations.`);

        // --- 4. Cleanup Orphaned Content ---
        // (Optional but recommended) Delete generic movies/series that no longer
        // have *any* provider relations. This keeps your DB clean.
        await dbRun(db, `
            DELETE FROM movies WHERE id NOT IN (
                SELECT DISTINCT movie_id FROM provider_movie_relations
            )
        `);
        await dbRun(db, `
            DELETE FROM series WHERE id NOT IN (
                SELECT DISTINCT series_id FROM provider_series_relations
            )
        `);

        console.log(`[VOD Processor] VOD refresh completed for: ${provider.name}`);

    } catch (error) {
        console.error(`[VOD Processor] VOD refresh FAILED for ${provider.name}:`, error.message);
    }
}

module.exports = { refreshVodContent, dbRun, dbGet };
