/**
 * codecs.js
 * Provides utility functions to translate raw codec strings (e.g., 'avc1', 'mp4a')
 * into human-readable names (e.g., 'H.264', 'AAC').
 */

const CODEC_MAP = {
    // Video Codecs
    'avc1': 'H.264',
    'h264': 'H.264',
    'hev1': 'H.265 (HEVC)',
    'hvc1': 'H.265 (HEVC)',
    'vp8': 'VP8',
    'vp9': 'VP9',
    'av01': 'AV1',
    'theora': 'Theora',
    'mp4v': 'MPEG-4 Visual',
    'mpeg2': 'MPEG-2',
    'mpeg1': 'MPEG-1',

    // Audio Codecs
    'mp4a': 'AAC',
    'aac': 'AAC',
    'ac-3': 'Dolby Digital (AC-3)',
    'ec-3': 'Dolby Digital Plus (E-AC-3)',
    'mp3': 'MP3',
    'opus': 'Opus',
    'vorbis': 'Vorbis',
    'flac': 'FLAC',
    'alac': 'ALAC',
    'ulaw': 'G.711 u-law',
    'alaw': 'G.711 A-law',
};

/**
 * Returns a human-readable name for a given codec string.
 * @param {string} codecString - The raw codec string (e.g., "avc1.640028").
 * @returns {string} The human-readable name (e.g., "H.264") or the original string if not found.
 */
export function getCodecName(codecString) {
    if (!codecString) return 'Unknown';

    // Handle multipart codec strings (e.g., "mp4a.40.2")
    // We check the prefix (e.g., "mp4a") against our map.
    const parts = codecString.split('.');
    const prefix = parts[0].toLowerCase();

    if (CODEC_MAP[prefix]) {
        return CODEC_MAP[prefix];
    }

    // Fallback: Return the original string if no match found
    return codecString;
}
