#!/bin/bash
cd /home/hatch/workspace/lantask/manager
nohup env PORT=9400 DATA_DIR=/home/hatch/workspace/lantask/data node server.js > /home/hatch/workspace/lantask/probe/manager3.log 2>&1 &
sleep 3
curl -s http://127.0.0.1:9400/api/health; echo
