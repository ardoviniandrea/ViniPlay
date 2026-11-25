#!/bin/bash
set -e
cd "$(dirname "$0")"
TOOLCHAIN_DIR="/Users/ardovini/.gemini/antigravity/brain/bf7a31d8-a358-434a-bf3c-f61616f56b39/scratch/android-toolchain"
export JAVA_HOME="/opt/homebrew/opt/openjdk@17/libexec/openjdk.jdk/Contents/Home"
export ANDROID_HOME="$TOOLCHAIN_DIR/android-sdk"
export GRADLE_OPTS="-Xmx2048m -Dfile.encoding=UTF-8"

"$TOOLCHAIN_DIR/gradle-8.5/bin/gradle" assembleDebug --gradle-user-home "$TOOLCHAIN_DIR/gradle-home" --no-daemon
cp -f app/build/outputs/apk/debug/app-debug.apk ../viniplay.apk
echo "✅ Built APK successfully: $(cd .. && pwd)/viniplay.apk"
