// xtreamClient.js
const axios = require('axios');

class XtreamClient {
    constructor(baseUrl, username, password) {
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
            headers: { 'User-Agent': 'Xtream-JS-Client' }
        });
        console.log(`[XC Client Constructor] Client initialized for base URL: ${this.baseUrl}`); // Added log
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
}

module.exports = XtreamClient;
