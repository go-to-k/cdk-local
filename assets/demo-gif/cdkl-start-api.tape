# cdkl-start-api demo recording.
#
# Split-pane tmux session:
#   left  — `cdkl start-api CdklDemo/MyApi --no-pull --port 8080` boots
#           the local HTTP API server.
#   right — wait for the server to come up, then `curl /hello` and show
#           the JSON response.
#
# Total recorded time around 16 seconds. Smaller FontSize than the
# single-pane invoke tape so the route table + curl line both fit
# without wrapping.

Output "../cdkl-start-api.gif"

Set Theme        "Catppuccin Mocha"
Set FontFamily   "JetBrainsMono Nerd Font"
Set FontSize     18
Set Width        1800
Set Height       720
Set Padding      20
Set TypingSpeed  40ms
Set PlaybackSpeed 1.0

Hide
Type "export PS1='$ ' && clear"
Enter
Sleep 500ms
Show

Type "bash run-start-api.sh"
Enter

# Bare `cdkl start-api` opens the multi-select picker in the LEFT pane
# (3 API surfaces, kind-grouped: HTTP API v2 / REST API v1 / Function URL).
# The cursor starts on MyHttpApi (HTTP API v2) — the curl target. Space
# selects it, Enter opens the Y/n confirm, Enter accepts the default (Yes).
# (Press → instead of Space to select all.) The first Sleep MUST outlast the
# synth + picker mount so Space toggles the picker instead of leaking into the
# terminal; a little extra also lets the multi-select stay on screen.
Sleep 5s
Space
Sleep 900ms
Enter
Sleep 900ms
Enter

# Hold for the server boot (left) + the right pane's curl (~12s sleep + a
# beat to read the JSON response).
Sleep 18s
