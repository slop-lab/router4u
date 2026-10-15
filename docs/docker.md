# Docker installation and account operations

## Install on a new computer

The commands below target a Linux x86-64 Docker host and a POSIX shell. Install Git and Docker Engine, start Docker, and make sure your account can run `docker info`. Host Node.js, npm, Go, Docker Compose, a model name, and a provider credential are not needed for this installation. Windows/macOS hosts and ARM64 hardware are not covered by the current build verification; the backend image currently targets Linux amd64.

Check the destination computer before downloading the source:

```sh
docker info --format '{{.OSType}}/{{.Architecture}}'
git --version
```

Docker must report Linux and an x86-64 architecture (`x86_64` or `amd64`). If Docker reports a permission error or cannot connect to its daemon, resolve that before continuing. Run these commands on the machine whose Docker daemon will host Router4u; a remote Docker context changes where ports and volumes are created.

### Get the source and build

```sh
git clone https://github.com/slop-lab/router4u.git
cd router4u
docker build -t router4u:local .
```

If you already have a checkout, enter its root instead of cloning again. Access to the repository is required; no public Docker Hub image is published yet. The first build needs network access to Docker Hub, Debian package repositories, and GitHub for the checksum-pinned CLIProxyAPI release. No files from another development machine, downloaded `.tools` directory, or `npm install` step are required. Keep the checkout for future rebuilds and documentation; the running container stores its state in Docker volumes.

### Create the installation

```sh
docker run -d --name router4u --restart unless-stopped --stop-timeout 30 \
  --read-only --tmpfs /tmp \
  --log-driver json-file --log-opt max-size=10m --log-opt max-file=3 \
  -p 127.0.0.1:9470:9470 \
  -v router4u-data:/var/lib/router4u \
  -v router4u-transcripts:/var/lib/router4u-transcripts router4u:local
```

Docker creates both named volumes automatically with the image's initial ownership. They belong to this Docker daemon, not the checkout directory. Use a different container name, host port, and **both** volume names for an independent second installation. Never run two installations against the same state or transcript volume.

### Wait for readiness and open the UI

```sh
docker inspect --format '{{.State.Status}} / {{.State.Health.Status}}' router4u
```

Wait for `running / healthy`; the first health check may take about 30 seconds. Repeat the command if it shows `starting`. If the container keeps restarting or becomes unhealthy, inspect `docker logs --tail 100 router4u` and use the troubleshooting table below. A container ID from `docker run` alone does not prove initialization succeeded.

Once healthy, retrieve the administrator key:

```sh
docker exec router4u router4u admin-key show
```

Open **http://127.0.0.1:9470/** on that computer and paste the key into the login form. This key administers Router4u; issue a separate project key for pi or another application. You do not need to create a host `.env` file for the server.

If the Docker host is a remote machine, keep the loopback port binding and run an SSH tunnel on the computer with your browser:

```sh
ssh -N -L 9470:127.0.0.1:9470 USER@SERVER
```

Keep that terminal open, then visit `http://127.0.0.1:9470/` locally. If local port 9470 is occupied, use `-L 19470:127.0.0.1:9470` and open `http://127.0.0.1:19470/`. The tunnel also works for a local client using that forwarded gateway address. It must remain connected while the client runs.

During Codex login, the provider may redirect your browser to `localhost:1455`. If that page cannot load, copy its full callback URL into Router4u's sign-in dialog. Do not publish backend port 8317 or forward port 1455 just to complete this manual callback flow.

First start generates private keys and a disabled `personal` connection. Sign in at `http://127.0.0.1:9470/` using the explicitly retrieved administrator key, connect the account, select models, and enable routing. Keys are never printed in ordinary startup logs. An optional `ROUTER4U_ADMIN_KEY` environment value is accepted on first initialization and persisted; a conflicting value on later startup is rejected.

The `router4u-data` volume stores `secrets.json`, gateway/backend configuration, OAuth credentials, and SQLite operational state under `data/`. The separate `router4u-transcripts` volume stores sensitive request/response bodies, request history, and audit/event JSONL. Internal backend keys are implementation details, not user configuration. Never commit or share this volume. Named volumes avoid host UID/GID setup; bind mounts must be writable by the container user (UID/GID 1000 by default). Do not use an anonymous volume or delete the named volume when replacing the container.

Gateway listens on `0.0.0.0:9470` inside the container. Set the **host** bind with Docker `-p`, not a container environment variable:

- `-p 127.0.0.1:9470:9470`: local host access only.
- `-p 192.168.1.10:9470:9470`: one host interface.
- `-p 0.0.0.0:8080:9470`: all host IPv4 interfaces, port 8080; use protected HTTPS ingress.

CLIProxyAPI listens on `127.0.0.1:8317` with remote management disabled. Do not publish its port. Application containers may share a Docker network with Router4u and use `http://router4u:9470/v1`, with their own project keys and no mounts of service state.

A supervisor starts Gateway after backend readiness. Either process failing ends the container; `--restart unless-stopped` handles recovery. `docker stop` allows 25 seconds for gateway shutdown before forced cleanup; use `docker stop -t 30 router4u`. Healthchecks probe local Gateway and backend management without provider inference. An unhealthy status alone does not trigger Docker restart.

```sh
docker exec router4u router4u health
docker exec router4u router4u pause
docker exec router4u router4u reload --config /var/lib/router4u/router4u.json --dry-run
```

To rotate the administrator key, first stop the installation; rotation refuses to run while its state lock is held. The command does not print the new key. If the container was created with an explicit `ROUTER4U_ADMIN_KEY`, recreate it without that override after rotation; the old value will be rejected:

```sh
docker stop -t 30 router4u
docker run --rm -v router4u-data:/var/lib/router4u \
  -v router4u-transcripts:/var/lib/router4u-transcripts router4u:local admin-key rotate
docker start router4u
docker exec router4u router4u admin-key show
```

For a complete cold backup, pause admissions, inspect active requests, stop the container, then copy **both** the state and transcript volumes using a temporary container. Keep both processes stopped for the whole copy. The backup includes live credentials and original payloads. Restore into a new volume; start only one installation using those credentials. Do not blindly replay uncertain requests. CLIProxyAPI remains the only OAuth and refresh owner.

Bundled mode currently starts one backend. Different project-to-account eligibility requires the [separate Compose partition topology](compose.md); do not combine differently authorized credential sets into one pool.

## Rebuild and restart

From the checkout, fetch the desired revision (`git pull --ff-only` for an unmodified checkout), read any storage-conversion notes, and build before stopping the running service. Then replace the container and reuse both named volumes:

```sh
docker build -t router4u:local .
docker stop -t 30 router4u
docker rm router4u
docker run -d --name router4u --restart unless-stopped --stop-timeout 30 \
  --read-only --tmpfs /tmp \
  --log-driver json-file --log-opt max-size=10m --log-opt max-file=3 \
  -p 127.0.0.1:9470:9470 \
  -v router4u-data:/var/lib/router4u \
  -v router4u-transcripts:/var/lib/router4u-transcripts router4u:local
```

Preserve any custom network or host-port options when recreating it. Browser sessions expire on gateway restart; retrieve the administrator key with `docker exec router4u router4u admin-key show` and sign in again. A fresh volume creates new keys and requires account setup and new application keys. Reusing the current volume retains configuration, accounts, and project keys. Incompatible database schemas are rejected; no automatic schema conversion is provided.

## Browser setup and application access

1. Open **Connections → personal → Connect Codex**. Complete sign-in and submit the loopback callback URL if necessary. The dialog checks CLIProxyAPI for completion; callback acceptance alone is not success.
2. Choose **Set up models → Load available models**, select the allowed models, and choose **Use selected models**.
3. Set **Request routing** to **On** and save. Account connection and request routing are separate states.
4. Create a project in **Projects & keys**, authorize `personal`, and issue its application key. Blank concurrency and daily limits mean no project limit on that dimension; other limits still apply.
5. Configure the application with `http://127.0.0.1:9470/v1` and the project key. See [client integrations](clients.md), including the pi CLI.

For API-key providers, edit the private CLIProxyAPI configuration in the volume and restart the installation. Select `api_key` in the route's backend settings. Provider keys remain in CLIProxyAPI; do not put them in the browser configuration editor.

## Backup and recovery

Back up both stopped volumes: `router4u-data` holds `secrets.json`, configuration, `auth/`, and database state in `data/`; `router4u-transcripts` holds the sensitive JSONL records. Restore to a fresh volume with the same ownership and start exactly one installation. The [operations guide](operations.md) explains uncertain requests and audited corrections. A SQLite-only copy omits JSONL logs, upstream credentials, and the administrator key. See [JSONL storage and conversion](logs.md).

## Multiple account partitions

For separate account eligibility, use the [Compose partition guide](compose.md#add-another-account-or-provider-partition). The bundled supervisor starts one backend and does not create more backend containers from the UI.

## Certificate errors during sign-in

The image installs system CA certificates for CLIProxyAPI's Go TLS client. If an older local image lacks them, rebuild and replace the container, then start a new Codex sign-in attempt. Do not reuse an old authorization code. On a TLS-intercepting network, install the network's trusted CA in the backend's system trust store; do not disable verification.

Docker Hub publication and a `curl ... | sh` installer remain deferred. `router4u:local` refers to the image built from this checkout.

## Verify an application connection

After browser setup, give the client its **project key**, the allowed model ID, and the gateway base URL. On the Docker host this is `http://127.0.0.1:9470/v1`; through the SSH example it is the local forwarded address. Container clients need their own reachable network address, as described above.

For pi, follow [the pi CLI instructions](clients.md#pi-cli). You can first use the project key to list authorized models; this does not perform inference. A real prompt consumes provider quota. Inspect the request in the UI after sending it. Health checks and a nonempty model list alone do not establish real inference success.

A fresh installation on another computer has new administrator and project keys and requires its own account connection. Copying a client `.env` from the old computer does not connect it to the new installation. To relocate an existing installation with its keys and history, stop the old service and restore **both** volumes; use the backup guidance above and keep only one active owner of rotating provider credentials.

## Transfer a built image instead of building on the destination

For another supported Linux amd64 Docker host, save the local image and copy the archive:

```sh
# On the build computer:
docker image save router4u:local -o router4u-image.tar
scp router4u-image.tar USER@SERVER:~/

# On the destination computer:
docker image load -i ~/router4u-image.tar
```

Then follow **Create the installation** above. This transfers the image only; it does not include state volumes, accounts, project keys, or transcripts. The destination still needs network access to the provider for login and inference. No Docker Hub upload is required.

## Installation troubleshooting

| Symptom | Check or next step |
|---|---|
| Build fails at the architecture check | The current backend build is Linux amd64 only. Do not assume ARM emulation has been verified. |
| Downloads or certificate verification fail during build | Check access to the image/package/release servers and the host network's trusted CA configuration. |
| Container name `router4u` already exists | Inspect it with `docker ps -a --filter name=router4u`; use `docker start router4u` for a stopped installation, or the rebuild procedure for a replacement. |
| Host port 9470 is occupied | Use `-p 127.0.0.1:19470:9470` and open port 19470 in the browser/client. |
| `admin-key show` cannot read secrets | Wait for health and inspect startup diagnostics. Do not create replacement credentials manually. |
| Browser on another computer cannot connect | The default host binding is loopback. Use the SSH tunnel or deliberately configured protected ingress. |
| Container is healthy but models are empty | Finish account login, select models, enable request routing, and authorize the connection in the project policy. |
| Client receives 401 | Use the newly issued project key, not the administrator key or a key from another installation. |
| Capture fails after a custom mount change | Check the transcript mount, writable ownership, free space, and `transcript_dir`. Both volumes are required. |

Keep the two volume names when updating. Removing the checkout or container does not remove named volumes, but deleting a volume deletes its persisted contents.
