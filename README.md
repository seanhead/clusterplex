# ClusterPlex (seanhead fork)

Fork of [pabloromeo/clusterplex](https://github.com/pabloromeo/clusterplex) maintained for personal home-infra use.

## Changes from upstream

- **Automated digest-based rebuilds** — Images only rebuild on the daily schedule when `linuxserver/plex:latest` changes (digest comparison via GitHub Actions cache). Manual dispatch and push triggers always rebuild.
- **GHCR images published under `ghcr.io/seanhead/`** — All images (PMS, worker, worker_hw, orchestrator) are built and pushed to this fork's packages.

## Images

| Image | Platform | Description |
|-------|----------|-------------|
| `ghcr.io/seanhead/clusterplex_pms:master` | amd64, arm64 | Plex Media Server with ClusterPlex shim |
| `ghcr.io/seanhead/clusterplex_worker:master` | amd64, arm64 | Transcoding worker |
| `ghcr.io/seanhead/clusterplex_worker_hw:master` | amd64 | Hardware-accelerated transcoding worker (VA-API + NVIDIA) |
| `ghcr.io/seanhead/clusterplex_orchestrator:master` | amd64, arm64 | Transcoding orchestrator |

## What is ClusterPlex?

ClusterPlex is an extended version of [Plex](https://plex.tv) which supports distributed Workers across a cluster to handle transcoding requests. It has been tested on Kubernetes and Docker Swarm.

## Components

- **Plex Media Server** — Official LinuxServer Plex image with ClusterPlex shim
- **Transcoding Orchestrator** — Routes transcoding requests to available workers
- **Transcoding Workers** — Execute transcoding jobs, can be scaled as replicated services

## How does it work?

1. PMS's transcoder is replaced with a shim that communicates with the Orchestrator over websockets
2. The Orchestrator forwards requests to available Workers
3. Workers execute transcoding and report progress back via a Local Relay on PMS

## Requirements

- Shared storage (NFS, SMB, Ceph, etc.) for media libraries and transcoding directory between PMS and Workers
- Paths MUST be identical on PMS and all Workers
- `/codecs` volume on workers for persisting downloaded codec binaries

## Upstream Documentation

For full configuration details, see the [upstream docs](https://github.com/pabloromeo/clusterplex/tree/master/docs):

- [Configuration Parameters](https://github.com/pabloromeo/clusterplex/tree/master/docs)
- [On Kubernetes](https://github.com/pabloromeo/clusterplex/tree/master/docs/kubernetes)
- [On Docker Swarm](https://github.com/pabloromeo/clusterplex/tree/master/docs/docker-swarm)
- [Grafana Dashboard and Metrics](https://github.com/pabloromeo/clusterplex/tree/master/docs/grafana-dashboard)
- [Helm Chart](https://pabloromeo.github.io/clusterplex)
