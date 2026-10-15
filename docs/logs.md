# JSONL logs and on-demand analysis

Request history, original request/response bodies, audit entries, and notification events are JSONL files. SQLite contains identities, configuration, transactional usage/reservations, budget bookings, minimal request recovery state, and capture size/retention controls. It does not contain body chunks, a request-history document, or audit/event tables.

## Runtime diagnostics versus transcripts

Runtime diagnostics are stdout/stderr, available through `docker logs router4u`. Docker's `json-file` driver wraps output in JSON records; the documented deployment rotates these files at 10 MiB with three files retained. Docker manages their host location. They are not stored in the transcript volume or in `data/logs`. Upstream diagnostic output is also treated as private and is not promised to be token-free.

Transcripts, request history, audit actions, and event notifications are sensitive application records with a separate storage and backup lifecycle. The gateway configuration's `transcript_dir` selects their directory and requires a restart to change. Bundled mode defaults to `/var/lib/router4u-transcripts`; mount a separate named volume there. Compose mounts `.runtime/transcripts` at `/transcripts`. Local test embeddings default to `data_dir/transcripts`.

Storage separation lets you set different backup, retention, and access policies; the gateway can still read both volumes. Do not mount either volume into consuming applications.

## Location and format

Bundled installations store logs at `/var/lib/router4u-transcripts` in the separate `router4u-transcripts` volume. Compose stores them under `.runtime/transcripts` on the host. Files are private (mode 0600), directories are mode 0700.

| File | Records |
|---|---|
| `requests/REQUEST_ID.jsonl` | Initial `request` document, `update` patches, and `manifest` patches |
| `exchanges/REQUEST_ID.jsonl` | Body chunks with `direction`, per-direction `sequence`, timestamp, SHA-256 `hash`, and base64 `payload` |
| `audit.jsonl` | Sequenced operator actions, targets, and JSON-encoded `data` |
| `events.jsonl` | Sequenced request-finished and usage-change notifications |

Each complete line is one JSON value. Apply request updates in file order to reconstruct its history; the request API overlays current transactional accounting/recovery fields. Payloads use base64 to preserve binary data and UTF-8 split across stream chunks. Raw bodies can contain sensitive content, including secrets submitted by applications. Authentication headers and provider credentials are not captured by the gateway.

The Requests and Activity views read these files on demand. They do not build a second database index for history or audit. Large history scans may take longer; use the files directly for substantial analysis. Metrics expose `analysis_log_failures` for this process; latency aggregates are calculated from request JSONL on demand.

## Inspect and copy

Copy logs from the container without reading its credential directory:

```sh
mkdir -p .runtime/log-analysis
docker cp router4u:/var/lib/router4u-transcripts/. .runtime/log-analysis/
```

A copy taken during active requests is a partial snapshot. Stop the service before a complete consistent backup.

With jq installed, inspect request transitions and audit operations:

```sh
jq -c . .runtime/log-analysis/requests/REQUEST_ID.jsonl
jq -c '{sequence, created, operation, target}' .runtime/log-analysis/audit.jsonl
```

Reconstruct the exact response bytes, including SSE if the request streamed:

```sh
python3 - REQUEST_ID <<'PY'
import base64, json, pathlib, sys
path = pathlib.Path('.runtime/log-analysis/exchanges') / (sys.argv[1] + '.jsonl')
with path.open() as source:
    rows = [json.loads(line) for line in source if line.endswith('\n')]
for row in sorted((row for row in rows if row['direction'] == 'response'), key=lambda row: row['sequence']):
    sys.stdout.buffer.write(base64.b64decode(row['payload']))
PY
```

Use the authenticated exchange export API when you need built-in hash validation and project authorization. Files are operator-accessible; do not mount them into application containers.

## Failure, retention, and backups

Body chunks are synced before forwarding under `required` recording. Capture controls in SQLite track committed chunk counts. Startup discards uncommitted trailing chunks; missing or damaged committed bytes are reported as incomplete or fail integrity verification. An interrupted final JSONL line is ignored and removed before another append. Corrupt complete lines are errors, not silently omitted.

History, audit, and notification writes happen after the operational transaction commits. A process crash or disk error can leave a gap in these analysis logs. They are not a transactional outbox and must not be used as the accounting authority. Logging failures are reported on stderr and in metrics without replaying inference or undoing committed policy/accounting changes.

Configured capture retention removes completed exchange files and retains accounting and request/audit history. History and audit do not rotate automatically. Archive capacity counts original payload bytes, not JSON/base64 overhead or history files; monitor actual volume space. If archiving history or audit manually, stop the installation first and expect those records to disappear from the UI. Do not modify accounting state to delete logs.

Both gateway backup and full installation backup include the JSONL directory. A SQLite-only copy no longer preserves logs. Back up both the state and transcript volumes while the service is stopped. Full backup bundles stage transcript files at `data/transcripts`; restore those files into the separate transcript volume and review `transcript_dir` before startup.

## Convert an existing schema-2 installation

Stop the service, set `transcript_dir` in its installation configuration to `/var/lib/router4u-transcripts`, and use the new image with both volumes for the explicit conversion. It retains project keys, provider credentials, usage, and recorded exchanges, moves history/audit/body records to JSONL, and vacuums removed database content. No inference or provider login is performed.

```sh
docker stop -t 30 router4u
docker run --rm -v router4u-data:/var/lib/router4u \
  -v router4u-transcripts:/var/lib/router4u-transcripts router4u:local \
  migrate-jsonl --config /var/lib/router4u/router4u.json
```

Then recreate the container with the new image and the same volume as described in the [Docker guide](docker.md#rebuild-and-restart). Conversion requires free space for the extracted logs and SQLite vacuum. Fresh installations initialize schema 3 directly. Normal startup rejects older schemas; it does not silently convert them. Schema-2 backup bundles are not accepted as schema-3 bundles.

## Move a previous combined log directory

Stop the installation, copy the complete previous `data/logs` directory into the new transcript volume, and verify all files before removing the source. Set `transcript_dir` in the installation configuration to the new mount path, then recreate the container with both volume mounts. Browser overrides cannot change this restart-only field. Keep project keys, OAuth credentials, and SQLite state unchanged. Startup rejects the old combined `data/logs` layout instead of silently opening an empty transcript directory.
