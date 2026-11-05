---
"@fveracoechea/operator": minor
---

WorkerAgents now ask their SuperAgent on the record.
`operator question ask` records a keyed question from the worker's pane, and `operator next` shows it as `answer_question` until the SuperAgent answers with `operator question answer --by super-agent|person`.
`operator question escalate` moves a question to the person, and `next` shows it as `person_decision` until the person's answer is recorded.
The worker reads the answer with `operator question wait` and can withdraw a question with `operator question withdraw`.
A question that is unanswered when its assignment ends is abandoned.
The state migration adds the `worker_questions` table, and the brief and the `worker-agent` and `super-agent` skills describe the protocol.
