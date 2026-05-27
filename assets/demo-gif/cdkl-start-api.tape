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

# Hold long enough for the curl response + a beat to read it.
# Tune once the actual recording shows the natural settle time.
Sleep 16s
