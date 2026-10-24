# Resolve votes when everyone has voted

The voting window (15 seconds, 10 since [ADR 0016](0016-ten-second-votes.md)) is a maximum wait. After each ballot, the server
checks its live list of distinct account IDs. If every present account has
voted YES or NO, tally immediately using the existing strict majority and
minimum-two-votes rules. The sole-listener request exception remains unchanged.

Missing ballots still wait until the deadline. Ballots from departed accounts
cannot substitute for uncast ballots from present members. Early resolution
cancels the timer and removes the active proposal before applying it; ties and
NO majorities fail immediately, and stale references never change shared state.
