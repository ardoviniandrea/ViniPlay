// xtreamClient.js
const axios = require('axios');

class XtreamClient {
    constructor(baseUrl, username, password) {
        // Normalize URL: remove any paths and trailing slashes
        const url = new URL(baseUrl);
        this.baseUrl = `${url.protocol}//${url.host}`;
        this.username = username;
        this.password = password;
        
        this.client = axios.create({
            timeout: 20000, // 20 second timeout
            headers: { 'User-Agent': 'Xtream-JS-Client' }
        });
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

    /** Fetches detailed info for one series, including episodes. */
    async getSeriesInfo(seriesId) {
        return this._makeRequest('get_series_info', { series_id: seriesId });
    }
}

module.exports = XtreamClient;
