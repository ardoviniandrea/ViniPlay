// xtreamClient.js
const axios = require('axios');

class XtreamClient {
    constructor(baseUrl, username, password, userAgent = 'Xtream-JS-Client') {
        if (!baseUrl || typeof baseUrl !== 'string') {
            throw new Error('[XC Client Constructor] Invalid or missing baseUrl provided.');
        }
        // Normalize URL: remove any paths and trailing slashes
        try {
            const url = new URL(baseUrl);
            this.baseUrl = `${url.protocol}//${url.host}`;
        } catch (e) {
            // Provide more context in the error
            console.error(`[XC Client Constructor] Failed to parse baseUrl "${baseUrl}": ${e.message}`);
            throw new Error(`[XC Client Constructor] Invalid baseUrl format: "${baseUrl}". Please provide a valid URL (e.g., http://example.com:8080).`);
        }
    
        this.username = username;
        this.password = password;
    
        this.client = axios.create({
            timeout: 60000, // 60 second timeout
            headers: { 'User-Agent': userAgent }
        });
        console.log(`[XC Client Constructor] Client initialized for base URL: ${this.baseUrl} with User-Agent: ${userAgent}`); // Added log
    }

    /**
     * Makes a request to the provider's API.
     * @param {string} action The API action (e.g., 'get_vod_streams')
     * @param {object} params Additional URL parameters
     * @returns {Promise<object|Array>} The JSON response from the API
     */
    async _makeRequest(action, params = {}) {
        try {
            const url = `${this.baseUrl}/player_api.php`;
            const allParams = {
                username: this.username,
                password: this.password,
                action: action,
                ...params
            };
            
            console.log(`[XC Client] Requesting action: ${action}`);
            const response = await this.client.get(url, { params: allParams });
            
            if (!response.data) {
                throw new Error('Empty response from provider');
            }
            return response.data;
        } catch (error) {
            const msg = `[XC Client] Error in action '${action}': ${error.message}`;
            console.error(msg);
            throw new Error(msg);
        }
    }

    /** Fetches all VOD streams (movies). */
    async getVodStreams() {
        return this._makeRequest('get_vod_streams');
    }

    /** Fetches all series. */
    async getSeries() {
        return this._makeRequest('get_series');
    }

    /** Fetches detailed info for one movie. */
    async getVodInfo(vodId) {
        return this._makeRequest('get_vod_info', { vod_id: vodId });
    }

    /** Fetches detailed info for one series, including episodes. */
    async getSeriesInfo(seriesId) {
        return this._makeRequest('get_series_info', { series_id: seriesId });
    }

    /** Fetches all VOD categories. */
    async getVodCategories() {
        return this._makeRequest('get_vod_categories');
    }

    /** Fetches all Series categories. */
    async getSeriesCategories() {
        return this._makeRequest('get_series_categories');
    }

    /** Fetches all Live TV categories. */
    async getLiveCategories() {
        return this._makeRequest('get_live_categories');
    }

    /**
     * Fetches all category types (Live, VOD, Series) concurrently and returns a merged, unique list.
     * @returns {Promise<string[]>} A sorted array of unique category names.
     */
    async getAllCategories() {
        try {
            console.log('[XC Client] Fetching all category types concurrently...');
            const [live, vod, series] = await Promise.all([
                this.getLiveCategories(),
                this.getVodCategories(),
                this.getSeriesCategories()
            ]);

            const allCategories = new Set();

            // Add categories from all responses, checking if they are arrays
            if (Array.isArray(live)) {
                live.forEach(c => allCategories.add(c.category_name));
            }
            if (Array.isArray(vod)) {
                vod.forEach(c => allCategories.add(c.category_name));
            }
            if (Array.isArray(series)) {
                series.forEach(c => allCategories.add(c.category_name));
            }

            const sortedCategories = Array.from(allCategories).sort((a, b) => a.localeCompare(b));
            console.log(`[XC Client] Found ${sortedCategories.length} unique categories across all types.`);
            return sortedCategories;

        } catch (error) {
            console.error(`[XC Client] Failed to fetch all categories: ${error.message}`);
            // Depending on desired behavior, you might re-throw or return an empty array
            throw new Error(`Failed to fetch all categories: ${error.message}`);
        }
    }
}

module.exports = XtreamClient;
