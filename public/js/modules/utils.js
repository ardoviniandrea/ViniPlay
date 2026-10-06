/**
 * utils.js
 * * Contains generic helper and utility functions, like parsers.
 */

/**
 * Routes an external image URL through the server-side image proxy so that
 * plain-http images (e.g. provider `tvg-logo` URLs) are not blocked as mixed
 * content when ViniPlay is served over HTTPS behind a reverse proxy.
 * Relative/data URLs and empty values are returned unchanged.
 * @param {string} url - The original image URL.
 * @returns {string} The proxied URL, or the input unchanged when no proxying is needed.
 */
export function proxiedImageUrl(url) {
    return url && url.startsWith('http')
        ? `/api/image-proxy?url=${encodeURIComponent(url)}`
        : (url || '');
}

/**
 * Parses M3U playlist data into a structured array of channel objects.
 * @param {string} data - The raw M3U content as a string.
 * @returns {Array<object>} - An array of channel objects.
 */
export function parseM3U(data) {
    if (!data) return [];
    const lines = data.split('\n');
    const channels = [];
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i].trim();
        if (line.startsWith('#EXTINF:')) {
            const nextLine = lines[i + 1]?.trim();
            // Ensure the next line is a valid URL
            if (nextLine && (nextLine.startsWith('http') || nextLine.startsWith('rtp'))) {
                const idMatch = line.match(/tvg-id="([^"]*)"/);
                const logoMatch = line.match(/tvg-logo="([^"]*)"/);
                const nameMatch = line.match(/tvg-name="([^"]*)"/);
                const groupMatch = line.match(/group-title="([^"]*)"/);
                const chnoMatch = line.match(/tvg-chno="([^"]*)"/);
                const sourceMatch = line.match(/vini-source="([^"]*)"/);
                const commaIndex = line.lastIndexOf(',');
                const displayName = (commaIndex !== -1) ? line.substring(commaIndex + 1).trim() : 'Unknown';

                channels.push({
                    id: idMatch ? idMatch[1] : `unknown-${Math.random()}`,
                    logo: logoMatch ? logoMatch[1] : '',
                    name: nameMatch ? nameMatch[1] : displayName,
                    group: groupMatch ? groupMatch[1] : 'Uncategorized',
                    chno: chnoMatch ? chnoMatch[1] : null,
                    source: sourceMatch ? sourceMatch[1] : 'Default',
                    displayName: displayName,
                    url: nextLine
                });
                i++; // Skip the URL line in the next iteration
            }
        }
    }
    return channels;
}

/**
 * NEW: Formats a date object to a time string with a specified UTC offset.
 * @param {Date} date - The date object to format.
 * @param {number} offsetHours - The timezone offset in hours (e.g., -5 for EST).
 * @returns {string} The formatted time string (e.g., "14:30").
 */
export function formatTimeWithOffset(date, offsetHours = 0) {
    if (!(date instanceof Date)) {
        date = new Date(date);
    }

    // Apply the user's desired offset directly to the input timestamp
    // This assumes the input date is already in the correct base time (typically UTC)
    const adjustedTime = new Date(date.getTime() + (offsetHours * 3600000));

    // Use UTC methods for consistent, device-independent formatting
    // This ensures identical results regardless of viewport size, browser, or device locale
    const hours = adjustedTime.getUTCHours().toString().padStart(2, '0');
    const minutes = adjustedTime.getUTCMinutes().toString().padStart(2, '0');

    return `${hours}:${minutes}`;
}
