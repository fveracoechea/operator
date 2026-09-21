# A question holds only its own work, and authority is granted rather than inferred

An Operative that cannot continue inside its authority limits raises one question.
The blocked report states the question, its evidence, its options, the Operative's recommendation, the scope that waits, and the work that continues without the answer.
That report carries no authority of its own: the request shape refuses any other field, so an Operative cannot widen what the Operator may then do.

One Operative waits on one question at a time.
A second report would hide the first, so the crew state refuses it and the Operative revises the question it already raised.
Every other assignment stays dispatchable, because a question holds the assignment that raised it and nothing else.
`operator work accept` refuses an assignment that still waits, so no dependent starts from a result built on a guess.

An answer is a requirement, a human answer, or an Operator decision.
The exact words stay in their own field, separate from the structured reading of them, so a later session can see what was said as well as what it was taken to mean.
A requirement also names the source and revision it comes from.
An Operator decision quotes nobody, because no human text stands behind it.

Five subjects are outside delegated authority: visible behavior, scope, security permissions, unresolved ambiguity, and conflicting explicit requirements.
A question that names one of them refuses an Operator decision, however often that decision is retried.
The Operator escalates by bringing the question to the user and recording their words as a human answer.

Recording an answer, delivering it, and receiving it are three states.
Recording is the decision, and one question revision carries exactly one decision.
Delivery is an external operation with its own identity, so a repeat reports what it already sent instead of submitting the answer again.
The Operative's own acknowledgement is the only proof the answer arrived, and it releases the work that waited.
A delivery that never answered is uncertain: it blocks another delivery until it is reconciled, and an acknowledgement settles it because an Operative cannot acknowledge an answer it never received.

A question's revision moves when the question or its target changes.
The recorded answer then stops applying, and delivering it is refused.
Using it again takes an applicability check and an approval that names that exact answer, this question, and the revision it is being reused for.
An Operator decision is never reused into a question that has since become a subject for the user.

An approval binds one action, its targets, its scope, and the revision of the request it was granted against.
It covers an action when the action, the scope, and the request revision are the same words and the approval names every target of the action.
A broader grant therefore covers a narrower action inside it, and an approval that names fewer targets never covers more of them.
A revocation ends an approval, and a revoked approval covers nothing.

`operator approval grant` is the only producer of an approval, and it records the person's exact words.
Silence, a timeout, a general direction to finish, and an Operative report produce nothing.

## Considered options

Letting the Operator add an escalation trigger to a question was rejected.
The Operator escalates by choosing the authority of its answer, so a second path to the same judgement would only drift from the first.

Treating a delivered answer as received was rejected.
Herdr acknowledges a submission, never a turn, which is the same reason the assignment brief needs its own acknowledgement.

Keeping the delivery state only on the question row was rejected.
An answer delivery is an effect outside the crew state like any other, and giving it a second rendering would leave recovery with two places to look.

Applying an older answer to a changed question whenever the words still look similar was rejected.
Similarity is a judgement, and a judgement made by the party that wants the answer is not a check.

A single approval flag that authorizes a class of actions was rejected.
An approval that does not name its targets cannot be compared against the action about to run.

## Consequences

`operator question revise` refuses to change a question after a delivery has started.
The Operative acknowledges the answer on its way and raises a new question, rather than changing the question the answer is already in flight for.

Ending an attempt withdraws the questions it raised.
A replacement is a new attempt, so it asks for itself rather than inheriting a question the former writer was waiting on.

The `answer-reuse` approval action and the `question:<id>` scope are fixed strings this release checks.
Another action that needs an approval states its own words, and the matching rule stays the same for all of them.

The state version stays at 1.
No release has shipped, so a new table is not yet a change an older Operator could meet.
