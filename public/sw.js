/**
 * sw.js
 * Service Worker for ViniPlay
 *
 * This script runs in the background to handle push notifications,
 * allowing them to be received and displayed even when the app's
 * web page is not open.
 */

// Instant Service Worker activation
self.addEventListener('install', () => {
    self.skipWaiting();
});

self.addEventListener('activate', event => {
    event.waitUntil(clients.claim());
});

// NEW: Initialize BroadcastChannel for cross-page communication
const notificationChannel = new BroadcastChannel('viniplay-notifications');

// Listener for when a push message is received
self.addEventListener('push', event => {
    console.log('[Service Worker] Push Received.');

    let payload;
    try {
        payload = event.data.json();
    } catch (e) {
        console.error('[Service Worker] Error parsing push data:', e);
        // If parsing fails, we can't do much, so we'll just log it.
        return;
    }

    // --- **FIX: Timezone-Correct Notification Logic** ---
    // This logic correctly interprets the data from the updated server.js
    // and formats the notification based on the user's local timezone.
    if (payload && payload.type === 'program_reminder' && payload.data) {
        const { programTitle, programStart, channelName, channelLogo, url } = payload.data;

        // Validate essential data to prevent errors
        if (!programTitle || !programStart || !channelName) {
            console.error('[SW] Invalid program_reminder payload. Missing essential data.', payload.data);
            return;
        }

        // Convert the UTC start time from the server into a local time string.
        // This is the key to fixing the timezone issue.
        const localStartTime = new Date(programStart).toLocaleTimeString([], {
            hour: '2-digit',
            minute: '2-digit',
            hour12: false // Using 24-hour format for consistency
        });

        const notificationTitle = programTitle;
        const notificationOptions = {
            body: `Starts at ${localStartTime} on ${channelName}`,
            icon: channelLogo || 'https://i.imgur.com/rwa8SjI.png',
            badge: 'https://i.imgur.com/rwa8SjI.png', // Badge for Android
            vibrate: [100, 50, 100],
            data: {
                url: url || '/'
            },
            tag: `program-${programStart}-${channelName}` // Prevents duplicate notifications for the same event
        };
        
        console.log(`[SW] Showing timezone-aware notification: "${notificationTitle}" with body: "${notificationOptions.body}"`);
        event.waitUntil(
            self.registration.showNotification(notificationTitle, notificationOptions)
            .then(() => {
                // Your existing logic to refresh clients
                notificationChannel.postMessage({ type: 'refresh-notifications' });
            })
        );

    } else {
        // Fallback for any other type of notification you might have
        console.log('[SW] Received a generic push notification.', payload);
        const title = payload.title || 'ViniPlay Notification';
        const options = {
            body: payload.body || 'You have a new notification.',
            icon: payload.icon || 'https://i.imgur.com/rwa8SjI.png',
            data: {
                url: payload.data ? payload.data.url : '/'
            },
        };
        event.waitUntil(self.registration.showNotification(title, options));
    }
});

// Listener for when a user clicks on the notification
self.addEventListener('notificationclick', event => {
    console.log('[Service Worker] Notification click Received.');

    // Close the notification
    event.notification.close();

    const urlToOpen = event.notification.data.url || '/';

    // Use waitUntil to ensure the browser doesn't terminate the
    // service worker before the new window/tab has been focused.
    event.waitUntil(
        clients.matchAll({
            type: "window",
            includeUncontrolled: true // Include tabs that might not be controlled by this SW yet
        }).then(clientList => {
            // Check if there's already a window open for the app
            for (let i = 0; i < clientList.length; i++) {
                const client = clientList[i];
                // If a client is found that matches our origin, focus it without hard-reloading the page
                if (client.url.startsWith(self.location.origin)) {
                    notificationChannel.postMessage({ type: 'refresh-notifications' });
                    return client.focus();
                }
            }
            // If no client is found or no suitable client to navigate, open a new tab/window.
            if (clients.openWindow) {
                return clients.openWindow(urlToOpen).then(newWindow => {
                    // If a new window is opened, also send a refresh signal once it loads
                    notificationChannel.postMessage({ type: 'refresh-notifications' });
                    return newWindow;
                });
            }
        })
    );
});
