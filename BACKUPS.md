# Back up and restore Optiplex

The bot writes to the local `history-data` Docker volume at `/app/data`. Keep this
volume across deployments. It contains the full metric archive and the configured
window of command records. Local copies share the SSD's failure risk; copy verified
snapshots to R2 or another independent destination.

## Create and check a backup

In the **running bot container's Coolify terminal**:

```sh
npm run backup
npm run backup -- --verify /app/data/optiplex.backup.sqlite
```

Each run uses SQLite's online backup API, checks the temporary copy with
`PRAGMA quick_check`, validates its schema/readings and fsyncs it. Only then does
it retain the verified current copy as `optiplex.backup.previous.sqlite` and
publish the new `optiplex.backup.sqlite`. A corrupt snapshot cannot replace either
good generation. A damaged current copy is never rotated over the previous one.
If rotation is interrupted, the previous generation remains recoverable.

Run this **before every scheduled R2/volume backup**. Enabling R2 alone does not
execute the command. Save both generations. Restore a standalone `.backup.sqlite`
file, rather than a raw main database copied while its WAL writer was running.
Verification refuses a file with a nonempty associated WAL. A verified backup can
still contain unintended application changes; choose the required generation.

Audit expiry applies to the live database. Older local/R2 backups keep old user
IDs until those copies expire; configure backup retention separately. Every new
snapshot still contains the full indefinite metric archive.

## A backup is blocked by an existing file

A `database_backup_blocked` event names the existing snapshot by basename, gives
the reason (for example `UnsupportedBackupSchema`) and explains the next action.
The file and the previous generation remain untouched. An unsupported format can
still be an intact backup from another version; preserve it before moving it aside.

For the default current snapshot, this example keeps the file under a new name:

```sh
mv -n /app/data/optiplex.backup.sqlite /app/data/optiplex.backup.saved.sqlite
npm run backup
```

Run this in the bot container terminal after confirming the log identifies that
file. If the saved name already exists, choose another unused name first. Keep
that saved artifact and the previous generation until recovery is confirmed.
Do not delete an unsupported file merely to make the command pass.

## Restore with the bot stopped

Run host commands over **SSH on optiplex**. Before stopping anything, identify the
bot container and save its volume/image identifiers:

```sh
sudo docker ps -a --filter label=com.docker.compose.service=optiplex \
  --format 'table {{.ID}}\t{{.Names}}\t{{.Status}}'
```

Replace `YOUR_CONTAINER_ID` with the bot's ID from that table:

```sh
opti_container=YOUR_CONTAINER_ID
opti_volume=$(sudo docker inspect "$opti_container" --format '{{range .Mounts}}{{if eq .Destination "/app/data"}}{{.Name}}{{end}}{{end}}')
opti_image=$(sudo docker inspect "$opti_container" --format '{{.Image}}')
test -n "$opti_volume" && test -n "$opti_image"
```

Now **Stop the bot resource in Coolify**, and pause automatic deployments during
recovery. Keep the volume. If recovering from R2, first restore the selected files
to this volume, retaining ownership for the image's `node` user (UID 1000) and mode
0600. The example below restores `optiplex.backup.sqlite`; change the `snapshot`
line to `optiplex.backup.previous.sqlite` to use the previous generation. Use an
image containing v0.2.3 or newer for the verification command.

Confirm no container is using the data volume, then run the one-off restore helper:

```sh
if [ -z "$opti_volume" ] || [ -z "$opti_image" ]; then
  echo 'Stopped: missing volume/image identifiers.'
elif [ -n "$(sudo docker ps -q --filter volume="$opti_volume")" ]; then
  echo 'Stopped: a container still uses the volume. Stop the bot in Coolify first.'
else
  sudo docker run --rm --network none --read-only --cap-drop ALL \
    --security-opt no-new-privileges:true \
    --mount "type=volume,source=$opti_volume,target=/app/data" \
    --entrypoint /bin/sh "$opti_image" -c '
      set -eu
      snapshot=/app/data/optiplex.backup.sqlite
      candidate=/app/data/restore-candidate.sqlite
      saved=/app/data/pre-restore-$(date -u +%Y%m%dT%H%M%SZ)
      test ! -e "$candidate"
      node dist/backup-cli.js --verify "$snapshot"
      cp "$snapshot" "$candidate"
      chmod 600 "$candidate"
      node dist/backup-cli.js --verify "$candidate"
      node -e "const f=require(\"node:fs\");const d=f.openSync(process.argv[1],\"r\");f.fsyncSync(d);f.closeSync(d)" "$candidate"
      mkdir -m 700 "$saved"
      for name in optiplex.sqlite optiplex.sqlite-wal optiplex.sqlite-shm; do
        if [ -e "/app/data/$name" ]; then mv "/app/data/$name" "$saved/"; fi
      done
      node -e "const f=require(\"node:fs\");const d=f.openSync(process.argv[1],\"r\");f.fsyncSync(d);f.closeSync(d)" "$saved"
      mv "$candidate" /app/data/optiplex.sqlite
      node -e "const f=require(\"node:fs\");const d=f.openSync(\"/app/data\",\"r\");f.fsyncSync(d);f.closeSync(d)"
      node dist/backup-cli.js --verify /app/data/optiplex.sqlite
      echo "Restore complete. Previous database and sidecars preserved in $saved"
    '
fi
```

Moving the old **main database, `-wal` and `-shm` files** out of their live paths is
mandatory: an old WAL must never be applied to a restored main database. The
helper verifies and syncs the candidate before moving old data, and preserves the
old files together for rollback. If it stops early, leave the bot stopped and
inspect the preserved files/candidate before retrying.

Start the resource in Coolify, then check `/diagnostics`, `/history` and `/audit`.
The configured audit retention runs again at startup, so a restored backup does
not override `AUDIT_RETENTION_DAYS`. Keep the preserved directory until recovery is
confirmed; remove it later according to your retention policy.
