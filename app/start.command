#!/bin/zsh
cd "${0:A:h}"
/opt/homebrew/bin/node server.js &
station_pid=$!
sleep 0.4
open "http://127.0.0.1:3186"
wait $station_pid
