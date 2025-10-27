# Stage 1: The Builder
# Use the full CUDA development image to build dependencies.
# We're using a specific version for reproducibility.
FROM ubuntu:24.04 AS builder

# Set environment to non-interactive to avoid prompts
ENV DEBIAN_FRONTEND=noninteractive

# Install Node.js and build essentials
RUN apt-get update && \
    apt-get install -y --no-install-recommends \
    build-essential \
    ca-certificates \
    curl \
    gnupg \
    python3-setuptools && \
    curl -fsSL https://deb.nodesource.com/setup_24.x | bash - && \
    apt-get install -y nodejs && \
    apt-get clean && \
    rm -rf /var/lib/apt/lists/*

# Set working directory and copy package files
WORKDIR /usr/src/app
COPY package*.json ./

# Install only production dependencies to keep the node_modules folder smaller
# FIX: Switched from 'npm ci' to 'npm install' for better compatibility in build environments
# that may not have a package-lock.json file.
RUN npm install --only=production

# Copy the rest of the application source code
COPY . .

# ---

# Stage 2: The Final Image
# Use a much smaller CUDA 'base' image for the runtime environment.
# This image contains the necessary NVIDIA drivers and libraries but not the full SDK.
FROM ubuntu:24.04

# Set environment variables for NVIDIA capabilities
ENV NVIDIA_DRIVER_CAPABILITIES all
ENV DEBIAN_FRONTEND=noninteractive

# Install only the necessary runtime dependencies: Node.js, FFmpeg, and drivers.
# We also add 'ca-certificates' which is crucial for making HTTPS requests from Node.js.
# MODIFIED: Added intel-media-va-driver and vainfo for Intel QSV / VA-API hardware acceleration.
RUN apt-get update && \
    apt-get install -y --no-install-recommends \
    curl \
    gnupg \
    ca-certificates \
    mesa-va-drivers \
    vainfo && \
    curl -s https://repo.jellyfin.org/ubuntu/jellyfin_team.gpg.key | gpg --dearmor | tee /usr/share/keyrings/jellyfin.gpg >/dev/null && \
    echo 'deb [arch=amd64 signed-by=/usr/share/keyrings/jellyfin.gpg] https://repo.jellyfin.org/ubuntu noble main' > /etc/apt/sources.list.d/jellyfin.list && \
    curl -fsSL https://deb.nodesource.com/setup_24.x | bash - && \
    apt-get install -y --no-install-recommends \
    jellyfin-ffmpeg7 \
    nodejs && \
    ln -s /usr/lib/jellyfin-ffmpeg/ffmpeg /usr/bin/ffmpeg && \
    # Clean up apt caches to reduce final image size
    apt-get clean && \
    rm -rf /var/lib/apt/lists/*

# Create and set the working directory
WORKDIR /usr/src/app

# Copy the application files and the installed node_modules from the 'builder' stage
COPY --from=builder /usr/src/app .

# Expose the application port
EXPOSE 8998

# Create and declare volumes for persistent data
RUN mkdir -p /data /dvr
VOLUME /data
VOLUME /dvr

# Define the command to run your application
CMD [ "npm", "start" ]
