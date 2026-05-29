# cdkl-invoke demo recording.
#
# Shows the "no AWS account, no deploy" headline flow:
#   cdkl invoke -> JSON response.
#
# `pnpm install` + `cdk synth` run as a hidden pre-warm step in
# `run.sh` (cdkl invoke does its own internal synth via toolkit-lib);
# the recorded session shows only the one cdkl line plus its output.
#
# Total recorded time around 10 seconds. FontSize matches the
# cdkl-start-api tape (18pt) so the RIE invoke logs fit on screen
# without wrapping.

Output "../cdkl-invoke.gif"

Set Theme        "Catppuccin Mocha"
Set FontFamily   "JetBrainsMono Nerd Font"
Set FontSize     18
Set Width        1400
Set Height       720
Set Padding      20
Set TypingSpeed  40ms
Set PlaybackSpeed 1.0

Hide
Type "export PS1='$ ' && clear"
Enter
Sleep 500ms
Show

Type "bash run.sh"
Enter

# Bare `cdkl invoke` opens the single-select picker (3 Lambdas:
# EchoHandler / GreetHandler / HealthHandler). Arrow through it, then pick.
# TUNE every Sleep below against the recorded result — these are estimates.
Sleep 3s
Down
Sleep 700ms
Down
Sleep 700ms
Up
Sleep 700ms
Enter

# Hold for: RIE container start (~3-5s), Lambda invoke (~1s), and a beat
# after the JSON response for readability.
Sleep 14s
