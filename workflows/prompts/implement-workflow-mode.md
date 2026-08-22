# Prompt: implement or extend a workflow mode

Implement the requested mode as an integration of the existing run-state, scheduler, guardian, recipe index, and quality gates.

Before changing files:

1. read the current mode configurations and schemas;
2. inspect scheduler and guardian interfaces;
3. search commands and recipes for an equivalent mechanism;
4. define which fields and transitions the new mode adds.

Required behavior:

- state survives process and chat-session restarts;
- every phase has an explicit entry condition and durable output;
- workers own disjoint paths or use an explicit merge step;
- retries change a causal hypothesis and are bounded;
- blocking gates prevent false completion;
- interruption writes a resumable checkpoint;
- no endpoint, credential, user identity, or machine path is hard-coded.

Required deliverables:

- mode JSON validated by `schemas/mode.schema.json`;
- command documentation;
- one synthetic run-state example;
- a smoke test covering start, heartbeat, checkpoint, resume, and completion;
- updated index.