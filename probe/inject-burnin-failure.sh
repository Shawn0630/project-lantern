#!/bin/bash
# Probe helper: wait for the first burn-in task to become assigned, freeze
# the worker mid-task, report the task failed (simulating a worker crash),
# then resume the worker. The manager must re-queue the segment and the job
# must still complete.
# Usage: inject-burnin-failure.sh <job-id>
set -u
JOB="$1"
L=/home/hatch/workspace/project-lantern
WORKER_PID=$(cat "$L/probe/worker-v11.pid")
WORKER_ID=probe-worker-v11
for i in $(seq 1 180); do
  TASK=$(curl -s "http://127.0.0.1:9400/api/jobs/$JOB" | python3 -c "
import json,sys
d=json.load(sys.stdin)
ts=[t for t in d['tasks'] if t['type']=='burnin' and t['state']=='assigned']
print(ts[0]['id'] if ts else '')")
  if [ -n "$TASK" ]; then
    echo "freezing worker $WORKER_PID for burnin task $TASK"
    kill -STOP "$WORKER_PID"
    sleep 1
    curl -s -X POST "http://127.0.0.1:9400/api/tasks/$TASK/result" \
      -H 'Content-Type: application/json' \
      -d "{\"workerId\":\"$WORKER_ID\",\"status\":\"failed\",\"error\":\"probe-injected failure\"}"
    echo
    kill -CONT "$WORKER_PID"
    echo "injected failure for $TASK at $(date -u +%H:%M:%S)"
    exit 0
  fi
  sleep 1
done
echo "no burnin task assigned within 180s"
exit 1
