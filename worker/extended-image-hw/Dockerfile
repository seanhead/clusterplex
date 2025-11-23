FROM linuxserver/plex:latest

LABEL maintainers="pabloromeo,matthew-beckett"

COPY /docker-mod/root/etc/ /etc/
COPY /app /app

RUN bash /etc/s6-overlay/s6-rc.d/1-install-dependencies/run && \
bash /etc/s6-overlay/s6-rc.d/2-npm-install/run && \
    rm -rf /etc/s6-overlay/s6-rc.d/1-install-dependencies && \
    rm -rf /etc/s6-overlay/s6-rc.d/2-npm-install && \
    rm -rf /etc/s6-overlay/s6-rc.d/3-install-shim/dependencies.d && \
    rm -rf /etc/s6-overlay/s6-rc.d/4-setup-codecs-dir/dependencies.d && \
    rm /etc/s6-overlay/s6-rc.d/init-mods-end/dependencies.d/1-install-dependencies && \
    rm /etc/s6-overlay/s6-rc.d/init-mods-end/dependencies.d/2-npm-install && \
    rm /etc/s6-overlay/s6-rc.d/user/contents.d/1-install-dependencies && \
    rm /etc/s6-overlay/s6-rc.d/user/contents.d/2-npm-install && \
    echo "**** cleanup ****" && \
    rm -rf \
    /tmp/* \
    /var/lib/apt/lists/* \
    /var/tmp/*

RUN apt-get update && apt-get install -y \
    vainfo \
    libva2 \
    libva-drm2 \
    libva-x11-2 \
    intel-media-va-driver-non-free \
    i965-va-driver \
    intel-gpu-tools \
    intel-opencl-icd \
    libdrm-intel1 \
    mesa-utils \
    && rm -rf /var/lib/apt/lists/*

EXPOSE 3501

VOLUME /codecs
