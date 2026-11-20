#!/bin/bash

# Function to check if license is expired
check_license_expiration() {
    local license_content="$1"
    local current_timestamp=$(date +%s)
    
    # Extract the first part of the license (timestamp or "lifetime")
    local license_timestamp=$(echo "$license_content" | awk '{print $1}')
    
    echo "License timestamp: $license_timestamp"
    
    # Check if it's "lifetime" (never expires)
    if [ "$license_timestamp" = "lifetime" ]; then
        echo "License is lifetime - never expires"
        return 0
    fi
    
    # Check if it's a valid timestamp (numeric)
    if ! [[ "$license_timestamp" =~ ^[0-9]+$ ]]; then
        echo "License timestamp is not numeric - treating as expired"
        return 1
    fi
    
    # Check if timestamp is in the past
    if [ "$license_timestamp" -lt "$current_timestamp" ]; then
        echo "License is expired (timestamp: $license_timestamp, current: $current_timestamp)"
        return 1
    else
        echo "License is valid until $(date -d @$license_timestamp 2>/dev/null || echo "unknown date")"
        return 0
    fi
}

# Function to download EAE and extract license
download_eae_and_license() {
    local eae_version="$1"
    local codec_arch="$2"
    local plex_version="$3"
    local codec_path="$4"
    
    echo "Downloading EasyAudioEncoder version => ${eae_version}"
    UUID=$(cat /proc/sys/kernel/random/uuid)
    # download eae definition to eae.xml
    EAE_XML="https://plex.tv/api/codecs/easyaudioencoder?build=${codec_arch}&deviceId=${UUID}&oldestPreviousVersion=${plex_version}&version=${eae_version}"
    echo "Downloading EAE_XML => ${EAE_XML}"
    curl -s -o eae.xml "${EAE_XML}"

    # extract codec url
    EAE_CODEC_URL=$(grep -Pio 'Codec url="\K[^"]*' eae.xml)
    echo "EAE_CODEC_URL => ${EAE_CODEC_URL}"
    echo "Downloading EasyAudioEncoder"
    curl -s -o "EasyAudioEncoder-${eae_version}-${codec_arch}.zip" "${EAE_CODEC_URL}"
    echo "Decompressing EasyAudioEncoder"
    unzip -o "EasyAudioEncoder-${eae_version}-${codec_arch}.zip" -d "EasyAudioEncoder"
    # extract license key
    echo "Extracting License Key"
    EAE_LICENSE_KEY=$(grep -Po 'license="\K([A-Za-z0-9]{10}\s[A-Za-z0-9]{60}\s[A-Za-z0-9]{64})' eae.xml)
    EAE_LICENSE_CONTENT="${EAE_LICENSE_KEY}"
    EAE_LICENSE_PATH="${codec_path}/EasyAudioEncoder/EasyAudioEncoder/eae-license.txt"
    echo "License Path output => ${EAE_LICENSE_PATH}"
    echo $EAE_LICENSE_CONTENT > $EAE_LICENSE_PATH
    
    # Validate the new license
    echo "Validating new license..."
    if check_license_expiration "$EAE_LICENSE_CONTENT"; then
      echo "New license is valid"
    else
      echo "WARNING: New license appears to be expired or invalid"
      echo "License content: $EAE_LICENSE_CONTENT"
    fi
    
    # save eae version to file
    echo $eae_version > EAE_VERSION.txt
    echo "EAE_VERSION.txt saved"
}

# Function to clean up old EAE
cleanup_old_eae() {
    local codec_path="$1"
    
    # Check if the directory exists
    if [[ -d "${codec_path}/EasyAudioEncoder" ]]; then
        # Remove the directory recursively
        echo "Deleting Old EAE"
        rm -rf "${codec_path}/EasyAudioEncoder"
    else
        echo "EasyAudioEncoder directory does not exist, skipped deletion"
    fi
}

cd /usr/lib/plexmediaserver

CLUSTERPLEX_PLEX_VERSION=$(strings "pms_original" | grep -P '^([0-9]+)\.([0-9]+)\.([0-9]+)\.([0-9]+)-[0-9a-f]{9}')
CLUSTERPLEX_PLEX_CODECS_VERSION=$(strings "Plex Transcoder" | grep -Po '[0-9a-f]{7}-[0-9a-f]{4,}$')
CLUSTERPLEX_PLEX_EAE_VERSION=$(printf "eae-`strings "pms_original" | grep -P '^EasyAudioEncoder-eae-[0-9a-f]{7}-$' | cut -d- -f3`-42")

EAE_VERSION="${EAE_VERSION_NUMBER:=2001}" # default fixed for now

echo "CLUSTERPLEX_PLEX_VERSION => '${CLUSTERPLEX_PLEX_VERSION}'"
echo "CLUSTERPLEX_PLEX_CODECS_VERSION => '${CLUSTERPLEX_PLEX_CODECS_VERSION}'"
echo "CLUSTERPLEX_PLEX_EAE_VERSION (extracted) => '${CLUSTERPLEX_PLEX_EAE_VERSION}'"
echo "PLEX_ARCH => '${PLEX_ARCH}'"
echo "EAE_VERSION => '${EAE_VERSION}'"

CLUSTERPLEX_PLEX_CODEC_ARCH="${PLEX_ARCH}"
INTERNAL_PLEX_MEDIA_SERVER_INFO_MODEL=""

case "${PLEX_ARCH}" in
  amd64)
    CLUSTERPLEX_PLEX_CODEC_ARCH="linux-x86_64-standard"
    INTERNAL_PLEX_MEDIA_SERVER_INFO_MODEL="x86_64"
    ;;
  armhf)
    CLUSTERPLEX_PLEX_CODEC_ARCH="linux-armv7neon-standard"
    INTERNAL_PLEX_MEDIA_SERVER_INFO_MODEL="armv7l"
    ;;
  arm64)
    CLUSTERPLEX_PLEX_CODEC_ARCH="linux-aarch64-standard"
    INTERNAL_PLEX_MEDIA_SERVER_INFO_MODEL="aarch64"
    ;;
esac

echo "CLUSTERPLEX_PLEX_CODEC_ARCH => ${CLUSTERPLEX_PLEX_CODEC_ARCH}"

CODEC_PATH="/codecs/${CLUSTERPLEX_PLEX_CODECS_VERSION}-${CLUSTERPLEX_PLEX_CODEC_ARCH}"
echo "Codec location => ${CODEC_PATH}"

mkdir -p ${CODEC_PATH}
cd ${CODEC_PATH}

if [ "$EAE_SUPPORT" == "0" ] || [ "$EAE_SUPPORT" == "false" ]
then
  echo "EAE_SUPPORT is turned off => ${EAE_SUPPORT}, skipping EasyAudioEncoder download"
else
  # Check if the EAE_VERSION.txt file exists
  if [[ -f "EAE_VERSION.txt" ]]; then
    # Read the contents of the file into a variable
    eae_version_file=$(cat EAE_VERSION.txt)
    echo "Found EAE_VERSION.txt => ${eae_version_file}"
  else
    # Set eae_version_file to an empty string
    eae_version_file=""
    echo "EAE_VERSION.txt not found"
  fi

  # Determine if we need to download EAE
  need_download=false
  
  # Compare the eae_version_file contents with the variable
  if [[ "$eae_version_file" == "$EAE_VERSION" ]]; then
    echo "EAE version is up to date"
    
    # Check if existing license is expired
    if [ -f "${CODEC_PATH}/EasyAudioEncoder/EasyAudioEncoder/eae-license.txt" ]; then
      echo "Checking existing license for expiration..."
      existing_license=$(cat "${CODEC_PATH}/EasyAudioEncoder/EasyAudioEncoder/eae-license.txt")
      if check_license_expiration "$existing_license"; then
        echo "EAE is up to date and license is valid"
      else
        echo "EAE version is up to date but license is expired - will fetch new license"
        need_download=true
      fi
    else
      echo "No existing license found - will download"
      need_download=true
    fi
  else
    echo "EAE is not the latest version"
    need_download=true
  fi
  
  # Download EAE if needed
  if [ "$need_download" = true ]; then
    cleanup_old_eae "$CODEC_PATH"
    download_eae_and_license "$EAE_VERSION" "$CLUSTERPLEX_PLEX_CODEC_ARCH" "$CLUSTERPLEX_PLEX_VERSION" "$CODEC_PATH"
  fi
fi

#original list: libhevc_decoder libh264_decoder libdca_decoder libac3_decoder libmp3_decoder libaac_decoder libaac_encoder libmpeg4_decoder libmpeg2video_decoder liblibmp3lame_encoder liblibx264_encoder; do
cat /app/codecs.txt | while read line
do
  codec=${line//[$'\t\r\n']}
  if [ -f "${codec}.so" ]; then
    echo "Codec ${codec}.so already exists. Skipping"
  else
    echo "Codec ${codec}.so does not exist. Downloading..."
    wget https://downloads.plex.tv/codecs/${CLUSTERPLEX_PLEX_CODECS_VERSION}/${CLUSTERPLEX_PLEX_CODEC_ARCH}/${codec}.so
  fi
done

export FFMPEG_EXTERNAL_LIBS="${CODEC_PATH}/"
export PLEX_MEDIA_SERVER_INFO_MODEL="${INTERNAL_PLEX_MEDIA_SERVER_INFO_MODEL}"
export EAE_EXECUTABLE="${CODEC_PATH}/EasyAudioEncoder/EasyAudioEncoder/EasyAudioEncoder"

# Legacy PID location on the /codecs PVC plus the current container-local one
for pid_file in "${EAE_EXECUTABLE}.pid" "${EAE_PID_FILE:-/run/clusterplex/easy-audio-encoder.pid}"; do
  if [ -f "$pid_file" ]; then
    echo "Removing EAE pid file $pid_file"
    rm -f "$pid_file"
  fi
done

cd /app

node worker.js
