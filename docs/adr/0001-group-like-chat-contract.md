# Group-Like Chat Contract

Group-like chats treat AnyAgent as one participant among humans, so every non-command delivered message triggers or joins an agent turn, but only final output inside `<group_message>` is sent back as visible group text. We chose plain-text input transcripts with nearby attachment metadata and explicit XML output controls so the agent sees messages in a natural chat shape while the relay can suppress intermediate or private reasoning text from group channels.
