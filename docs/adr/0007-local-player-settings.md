# Local video quality and subtitles

Status: accepted.

YouTube selects quality automatically; it does not guarantee the highest
resolution. Its IFrame API no longer supports setPlaybackQuality or listing
available quality levels. Use the native settings menu for quality and captions.

The player keeps controls enabled but direct input locked by default. The local
Quality / subtitles button temporarily unlocks the iframe. Done locks it again
and reapplies the latest room anchor without recreating the player. Changing or
ending the track also locks input. Settings are never sent to the room server.

YouTube cannot expose only its quality/caption controls: other controls are
also accessible while settings are open. Playback changes never change room
state, existing sync guards still run, Done corrects local position/status, and
native speed changes are reset to 1x. Available quality and captions depend on
the video and device. YouTube owns preference persistence across videos.

Sources:
- https://developers.google.com/youtube/iframe_api_revision_history
- https://support.google.com/youtube/answer/91449
- https://support.google.com/youtube/answer/100078
