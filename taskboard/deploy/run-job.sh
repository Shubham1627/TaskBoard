#!/usr/bin/env bash
# Runs a one-shot script with the same environment as the service:  run-job.sh migrate | cleanup
set -euo pipefail
set -a; . /etc/taskboard/app.env; . /etc/taskboard/secrets.env; set +a
cd /opt/taskboard
exec node "scripts/$1.js"
