# Crit 9 — All at once

**The breakthrough.** I originally designed the voting rule so that at least two valid votes were required before an action such as Play or Pause could be accepted. I tested this rule and initially thought it was finished.

However, I later noticed a problem. If there were two users in the room, one of them might still appear online but be temporarily inactive — for example, they might be doing something else in real life and simply ignore the voting prompt. The server would still count that user as present. In this situation, only one user would actually participate in the vote, so the required two votes could never be reached. The Play or Pause request would therefore fail every time.

This showed me that the rule should not always require exactly two votes. Instead, the required number of votes should take into account how many users are actually active and able to participate in the vote.

I documented this decision in `docs/adr/0010-live-presence-quorum.md` and also explained why I did not simply rely on presence detection alone. Writing down both the final rule and the rejected alternative made this a proper design decision rather than just a quick fix.

**What this changed.** Before this crit, I often treated passing tests and human judgement as evidence that a feature was finished. This experience showed me that this can be misleading.

The main problem was that I could not discover this issue by testing the application as a single user. It only appeared when multiple users were involved and one of them did not respond. If neither my own judgement nor my test cases considered this situation, then even a very good-looking test result, such as high code coverage, would not mean that the system was actually correct.

This made me realise that after making my own judgement, it is useful to ask an agent to review the design again and look specifically for scenarios or edge cases that I may have overlooked. 