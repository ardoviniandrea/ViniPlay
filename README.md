<div align="center">

# ViniPlay

**A powerful, self-hosted IPTV player with a modern web interface.**

Stream your M3U playlists with EPG data, manage users, cast to your TV, and watch multiple channels at once.

Join my <a href="https://discord.gg/DXxvAw22Us">discord</a> to talk with the community.
<p>
    <img src="https://img.shields.io/badge/docker-ready-blue.svg?style=for-the-badge&logo=docker" alt="Docker Ready">
    <img src="https://img.shields.io/badge/platform-node-green.svg?style=for-the-badge&logo=node.js" alt="Node.js Backend">
</p>

</div>

---

ViniPlay transforms your M3U and EPG files into a polished, high-performance streaming experience. It's a full-featured IPTV solution that runs in a Docker container, providing a robust Node.js backend to handle streams and a sleek, responsive frontend for an exceptional user experience.

The server-side backend resolves common CORS and browser compatibility issues by proxying or transcoding streams with FFMPEG, while the feature-rich frontend provides a user experience comparable to premium IPTV services.

### Main User Interface Flow
![Main User Interface Flow](https://github.com/ardoviniandrea/ViniPlay/blob/main/images/viniplay-main%20ux-min.gif)

### Feature Snapshots

| TV Guide Page | Multi-View Page | Direct Player |
| :---: | :---: | :---: |
| ![TV Guide page](https://i.imgur.com/O7jk6X1.png) | ![Multi-View page](https://i.imgur.com/eE3R0Hr.png) <br> [View Animation](https://github.com/ardoviniandrea/ViniPlay/blob/main/images/multiview.gif) | ![Direct player](https://i.imgur.com/ftmxvss.png) |

| DVR & Recording | Admin Activity Monitoring | Push Notifications |
| :---: | :---: | :---: |
| ![DVR](https://i.imgur.com/XVhT1pH.png) <br> [View Animation](https://github.com/ardoviniandrea/ViniPlay/blob/main/images/DVR.gif) | ![Admin activity](https://i.imgur.com/4zaFF1v.png) | ![Notification](https://i.imgur.com/D4hFLoI.png) <br> [View Animation](https://github.com/ardoviniandrea/ViniPlay/blob/main/images/notification.gif) |

| Powerful Settings | Responsive Mobile View | Favorite Manager |
| :---: | :---: | :---: |
| ![Settings](https://i.imgur.com/FxOFq88.png) | ![Mobile TV Guide view](https://i.imgur.com/j8LjxSf.png) | ![Favorite manager](https://i.imgur.com/kKCnkFg.png) <br> [View Animation](https://github.com/ardoviniandrea/ViniPlay/blob/main/images/Favorites.gif) |


---

## ✨ Features

 - 👤 **Multi-User Management**: Secure the application with a dedicated admin account. Create, edit, and manage standard user accounts.
 - 📺 **Modern TV Guide**: A high-performance, virtualized EPG grid that handles thousands of channels and programs smoothly. Features include advanced search, channel favoriting, and a "Recents" category.
 - 🖼️ **Multi-View**: Drag, drop, and resize players on a grid to watch multiple streams simultaneously. Save and load custom layouts. "Immersive view" will hide all UI elements and only leave the players on the page to maximize the watching experience.
 - 🛜 **Chromecast Support**: Cast your streams directly to any Google Cast-enabled device on your network. (This will only work if your source signal is strong and correctly passed without package missing, due to Cast framework)
 - 🔔 **Push Notifications**: Set reminders for upcoming programs and receive push notifications in your browser, even when the app is closed.
 - ⚙️ **Powerful Transcoding - even with GPUs**: The backend uses FFMPEG to process streams, ensuring compatibility across all modern browsers and devices. Create custom stream profiles to tailor transcoding settings. GPU transcoding supported. (Nvidia, InterlQSV and Vaapi)
 - 📂 **Flexible Source Management**: Add M3U and EPG sources from either local files, XC code and remote URLs. Set automatic refresh intervals for URL-based sources to keep your guide data fresh.
 - 🚀 **High Performance UI**: The frontend is built with performance in mind, using UI virtualization for the guide and efficient state management to ensure a fast and responsive experience.
 - 🐳 **Dockerized Deployment**: The entire application is packaged in a single Docker container for simple, one-command deployment using Docker or Docker Compose.
 - ▶️ **Picture-in-Picture**: Pop out the player to keep watching while you work on other things.
 - 🎥 **DVR**: Record programs using FFMPEG. Schedule recording via the TV Guide, or set specific channels and time with ease.
 - 📽️ **Single player**: Play .m3u8 and .ts links directly from the browser, with detailed console logs and recorded history
 - 👥 **Admin monitoring page**: Monitor users watch stream in real time, store historical plays, and broadcast messages to all users.
 - 📺 **VODs support**: Play your VODs from your provider, divided cleanly in the UI with a scalable grid, with filters and tabs for Movies and Series (IMPORTANT: this only workd with XC API log in)
---


## 🚀 Getting Started

ViniPlay is designed for easy deployment using Docker.

### Prerequisites

-   Docker
-   Docker Compose (Recommended)
    
### Method 1: Using `docker-compose` (Recommended)

1.  **Create Project Files:** Create a directory for your ViniPlay setup and add a `docker-compose.yml` and a `.env` file.
    
    -   `docker-compose.yml`:
        
        ```
        version: "3.8"
        services:
          viniplay:
            image: ardovini/viniplay:latest
            container_name: viniplay
            ports:
              - "8998:8998"
            restart: unless-stopped
            volumes:
              - ./viniplay-data:/data
            env_file:
              - ./.env
        
        ```
        
    -   `.env`:
        
        ```
        # Replace this with a long, random, and secret string
        SESSION_SECRET=your_super_secret_session_key_here
        
        ```
        
        > **Security Note:** Your `SESSION_SECRET` should be a long, random string to properly secure user sessions.
    
2.  **Build and Run the Container:**
    
    ```
    docker-compose up --build -d
    
    ```

### Method 2: Using `docker`

1.  **Build the Image:**
    
    ```
    docker build -t viniplay .
    
    ```
    
2.  **Run the Container:** Create a volume directory (`mkdir viniplay-data`) and a `.env` file first. Then run the container:
    
    ```
    docker run -d \
      -p 8998:8998 \
      --name viniplay \
      --env-file ./.env \
      -v "$(pwd)/viniplay-data":/data \
      viniplay
    
    ```
    
### First-Time Setup

Once the container is running, open your browser and navigate to `http://localhost:8998`. You will be prompted to create your initial **admin account**. After creating the admin account, you can log in and start configuring your sources in the **Settings** tab.

---
## 🔧 Configuration

All configuration is done via the web interface in the **Settings** tab.

-   **Data Sources:** Add your M3U and EPG sources from remote URLs, XC Codes, uploaded files.
-   **Processing:** After adding sources, click the **Process Sources & View Guide** button to download, parse, and merge all your data.
-   **Player Settings:** Manage User-Agent strings and define `ffmpeg` stream profiles.
-   **User Management (Admin):** Admins can create, edit, and delete user accounts.

### Reverse-proxy (SSO) authentication — optional

If you run ViniPlay behind an authenticating reverse proxy (e.g. `oauth2-proxy`, Authelia, Authentik, Traefik forward-auth), the proxy has already authenticated the user. You can let ViniPlay trust an identity header from the proxy and log the user in automatically, so its own login form is skipped and you don't have to maintain a second password. Users are auto-provisioned on first sight. Configure it with these environment variables:

| Variable | Default | Description |
| --- | --- | --- |
| `PROXY_AUTH_ENABLED` | `false` | Set to `true` to enable reverse-proxy authentication. |
| `PROXY_AUTH_HEADER` | `X-Forwarded-Email` | The request header carrying the authenticated user's identity (used as the ViniPlay username). For `oauth2-proxy`, enable `--pass-user-headers=true` (or `--set-xauthrequest=true` and use `X-Auth-Request-Email`). |
| `PROXY_AUTH_TRUSTED_IPS` | *(empty)* | Comma-separated list of proxy source IPs/CIDRs allowed to supply the identity header, e.g. `172.31.0.0/16`. Matched against the request's real TCP peer, **never** `X-Forwarded-For`. **Required:** if empty while enabled, the header is never trusted (fail closed). |
| `PROXY_AUTH_ADMIN_USERS` | *(empty)* | Comma-separated identities that are admins. A listed identity is made admin both when its account is first provisioned and, if it already exists as a non-admin, on its next login (grant only — the list never removes admin). Additionally, if no admin exists yet, the first proxy-authenticated user becomes admin (bootstrap). |
| `PROXY_AUTH_LOGOUT_URL` | *(empty)* | Where the Logout button sends the browser. Without it, logout only clears the ViniPlay session and the next request is re-authenticated by the proxy immediately (so nothing appears to happen). Set it to the proxy's sign-out, e.g. `/oauth2/sign_out` for `oauth2-proxy`, to actually end the session. |

> **Security:** only enable this when a proxy in front of ViniPlay is the **only** way to reach it. The identity header is trusted solely when the connecting IP is in `PROXY_AUTH_TRUSTED_IPS`; a client able to reach ViniPlay directly and set the header could otherwise impersonate any user. Auto-provisioned users have no local password and authenticate only through the proxy. Logout: with proxy auth on, ViniPlay's own logout clears only the ViniPlay session and the proxy re-authenticates the next request immediately — set `PROXY_AUTH_LOGOUT_URL` to the proxy's sign-out so the Logout button actually ends the upstream session.

> **Where logout lands you.** To *fully* sign out (so the next visit shows a login prompt rather than being silently re-authenticated), the logout has to end the identity provider's session too — e.g. point `PROXY_AUTH_LOGOUT_URL` at oauth2-proxy's sign-out with an `rd` to the IdP's `end_session_endpoint`: `PROXY_AUTH_LOGOUT_URL=/oauth2/sign_out?rd=<url-encoded IdP logout URL>` (and whitelist the IdP domain on the proxy, e.g. `OAUTH2_PROXY_WHITELIST_DOMAINS`). After that, the browser is left on the **IdP's** login page, because most IdPs redirect to their own login after logout and ignore any post-logout redirect back to the app (Nextcloud's OIDC logout, for instance, always returns to `/login`). That is expected: to return to ViniPlay, open ViniPlay's own URL again — with the IdP session gone you'll log in once and land back in the app. There is no reliable way to bounce automatically from a full IdP logout straight back into the app; if you prefer the app to be immediately usable again after logout, leave `PROXY_AUTH_LOGOUT_URL` unset (or set it to a plain `/oauth2/sign_out`), accepting that this is a session refresh rather than a true sign-out.

---
## 🏗️ Project Structure

The project is organized into a Node.js backend and a modular vanilla JavaScript frontend.

```
/
├── public/                          # Frontend static files
│   ├── js/
│   │   ├── main.js                  # Main application entry point
│   │   └── modules/                 # Modular JS components for each feature
│   │       ├── api.js               # Backend API communication
│   │       ├── auth.js              # Authentication flow
│   │       ├── cast.js              # Google Cast logic
│   │       ├── dvr.js               # DVR logic
│   │       ├── guide.js             # TV Guide logic & rendering
│   │       ├── multiview.js         # Multi-View grid and players
│   │       ├── notification.js      # Push notification management
│   │       ├── player.js            # Video player (mpegts.js)
│   │       ├── settings.js          # Settings page logic
│   │       ├── state.js             # Shared application state
│   │       ├── ui.js                # Global UI functions (modals, etc.)
│   │       └── utils.js             # Utility functions (parsers)
│   ├── sw.js                        # Service Worker for push notifications
│   └── index.html                   # Main HTML file
│
├── server.js                        # Node.js backend (Express.js)
├── Dockerfile                       # Docker build instructions
├── docker-compose.yml               # Docker Compose configuration
├── package.json                     # Node.js dependencies
└── .env                             # Environment variables (e.g., SESSION_SECRET)

```

---
## 🏗️ Roadmap

Upcoming features and fixes include:

-   Add VODs support for M3U links and File uploads  
-   Making DVR .ts files seekable during recording.
-   Storing logos to improve load time.
-   Implementing full horizontal scroll in the TV Guide.

---
## ⚖️ License

ViniPlay is licensed under **CC BY-NC-SA 4.0**:

- **BY**: Give credit where credit’s due.
- **NC**: No commercial use.
- **SA**: Share alike if you remix.

For full license details, see [LICENSE](https://creativecommons.org/licenses/by-nc-sa/4.0/).
