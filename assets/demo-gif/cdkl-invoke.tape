# cdkl-invoke demo recording.
#
# Shows the "no AWS account, no deploy" headline flow:
#   pnpm install -> cdk synth -> cdkl invoke -> JSON response.
#
# The full sequence completes in roughly 3-5 seconds of recorded time,
# small enough to embed at the top of the project README without
# bloating page weight.

Output "../cdkl-invoke.gif"

Set Theme        "Catppuccin Mocha"
Set FontFamily   "JetBrainsMono Nerd Font"
Set FontSize     22
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

# Hold long enough to read the JSON payload after the command finishes.
# Tune this once the actual recording shows the natural settle time.
Sleep 15s
