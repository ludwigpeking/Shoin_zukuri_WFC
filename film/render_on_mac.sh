#!/bin/bash
# Renders the film on the Mac mini and brings the result back. Run from Git Bash in this folder:
#   bash render_on_mac.sh [output name, default Chinese_Architecture_WFC.mp4] [language: zh (default) or en]
# Sends only what the renderer needs and the Mac does not have yet (the footage shot on the Mac
# stays there; the fonts, photos, voice and the stills made on Windows go over), renders inside
# tmux so that a dropped connection does not stop it, and copies the mp4 and srt back.
set -e
MAC=liq@Qians-Mac-mini
OUTPUT_NAME=${1:-Chinese_Architecture_WFC.mp4}
FILM_LANGUAGE=${2:-zh}
# the English film has its own voice and its own night still (its shots are in footage_en on the Mac)
if [ "$FILM_LANGUAGE" = "en" ]; then LANGUAGE_FILES="voice_en footage_en/large_night"; else LANGUAGE_FILES="voice footage/large_night"; fi

tar -cf - --exclude=external/new make_film.js narration.json kept_views.json package.json package-lock.json fonts photos footage/diagrams $LANGUAGE_FILES |
    ssh -o BatchMode=yes $MAC 'mkdir -p ~/Shoin-zakuri/film && tar -xf - -C ~/Shoin-zakuri/film'
tar -cf - -C .. quadMap.js | ssh -o BatchMode=yes $MAC 'tar -xf - -C ~/Shoin-zakuri'

ssh -o BatchMode=yes $MAC "export PATH=/opt/homebrew/bin:\$PATH; cd ~/Shoin-zakuri/film && npm install --no-audit --no-fund >/dev/null 2>&1; rm -f /tmp/shoin_render.log /tmp/shoin_render.done; tmux kill-session -t shoinrender 2>/dev/null; tmux new-session -d -s shoinrender \"node make_film.js --language $FILM_LANGUAGE --output $OUTPUT_NAME > /tmp/shoin_render.log 2>&1; touch /tmp/shoin_render.done\""
echo "rendering on the Mac..."
ssh -o BatchMode=yes -o ServerAliveInterval=30 $MAC 'until [ -f /tmp/shoin_render.done ]; do sleep 10; done; grep -E "film length|wrote|rror" /tmp/shoin_render.log'

SUBTITLE_NAME=${OUTPUT_NAME%.mp4}.srt
scp -q -o BatchMode=yes $MAC:Shoin-zakuri/film/$OUTPUT_NAME $MAC:Shoin-zakuri/film/$SUBTITLE_NAME .
ls -la $OUTPUT_NAME $SUBTITLE_NAME
