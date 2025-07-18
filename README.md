<div align="center">

# ViniPlay

A simple, self-hosted IPTV player with a clean web interface and powerful backend transcoding using FFMPEG.

<p>
    <img src="https://img.shields.io/badge/docker-ready-blue.svg?style=for-the-badge&logo=docker" alt="Docker Ready">
    <img src="https://img.shields.io/badge/platform-node-green.svg?style=for-the-badge&logo=node.js" alt="Node.js Backend">
    <img src="https://img.shields.io/github/license/YOUR_GITHUB_USERNAME/viniplay?style=for-the-badge" alt="License">
</p>

</div>

---

This project allows you to load M3U playlists and EPG XML files to create a personalized TV guide and stream channels directly in your browser. The backend server handles stream fetching and on-the-fly transcoding, resolving common browser compatibility and CORS issues.

<!-- It's highly recommended to add a screenshot or a GIF of your app in action -->
<!-- 
<div align="center">
    <img src="URL_TO_YOUR_SCREENSHOT.png" alt="ARDO IPTV Player Screenshot" width="700">
</div> 
-->

---

## ✨ Features

* **TV Guide Interface:** A clean, responsive EPG (Electronic Program Guide) view.
* **M3U & EPG Support:** Load channels and guide data from local files or remote URLs.
* **FFMPEG Transcoding:** The Node.js backend uses `ffmpeg` to transcode streams, ensuring broad browser compatibility.
* **Dockerized:** The entire application is bundled into a single, easy-to-deploy Docker image.
* **Favorites & Recents:** Mark your favorite channels and quickly access recently watched ones.
* **Search:** Instantly search through both channels and program listings.
* **Picture-in-Picture:** Continue watching your stream while you browse other tabs.

---

## 🚀 How to Run

This application is distributed as a Docker image. To run it, you will need [Docker](https://docs.docker.com/get-docker/) installed on your system.

1.  **Log in to GitHub Container Registry**

    You first need to authenticate your Docker client with GHCR. You only need to do this once.
    ```bash
    docker login ghcr.io -u YOUR_GITHUB_USERNAME
    ```
    > **Note:** You will be prompted for a password. You must use a GitHub Personal Access Token (PAT) with the `read:packages` scope. You can generate one [here](https://github.com/settings/tokens/new?scopes=read:packages).

2.  **Pull the Docker Image**

    Pull the latest version of the player from the GitHub Container Registry.
    ```bash
    docker pull ghcr.io/YOUR_GITHUB_USERNAME/viniplay:latest
    ```

3.  **Run the Container**

    Start the container, mapping port `8998` to your host machine.
    ```bash
    docker run -d -p 8998:8998 --name viniplay ghcr.io/YOUR_GITHUB_USERNAME/viniplay:latest
    ```

Remember to replace **YOUR_GITHUB_USERNAME** in the commands above with your actual GitHub username.

Once the container is running, you can access your IPTV player by navigating to **[http://localhost:8998](http://localhost:8998)** in your web browser.






```text
public/
├── js/
│   ├── main.js       // The new, lean entry point
│   └── modules/
│       ├── api.js        // For all fetch requests to the backend
│       ├── auth.js       // Handles the entire authentication flow
│       ├── guide.js      // All logic for the TV Guide
│       ├── player.js     // Video player logic
│       ├── settings.js   // Logic for the settings page
│       ├── state.js      // Shared application state and UI elements
│       ├── ui.js         // General UI functions (modals, notifications)
│       └── utils.js      // Helper functions like the M3U parser
└── index.html

