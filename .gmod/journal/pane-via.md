# pane-via: Decisions made in the pane say they came from the pane

- 2026-11-09T04:40:52.414Z check: red (approving and accepting from the pane run gmod with --via pane)
- 2026-11-09T04:41:07.119Z check: green
- 2026-11-09T04:41:12.987Z dev@soundheart.io: The pane's Approve and Accept buttons and /gmod approve and /gmod adr accept now pass --via pane, so their commits say Decided-Via: pane. Rejects commit nothing, so they get no --via.
