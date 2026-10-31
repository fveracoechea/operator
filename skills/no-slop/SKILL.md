---
name: no-slop
description: Use when writing or editing prose, documentation, code comments, commit messages, issue or pull request text, a Slack message, or a reply to the person.
---

# No-slop

Write plain text that a busy colleague reads once and understands.
Remove the patterns that make text read as AI generated.

## Process

1. Find the audience, then read its topic below.
2. Write or edit the text with the rules in this file.
3. Ask "What makes this obviously AI generated?" and fix each tell you find.

The text is done when every numbered rule holds and the audience topic holds.

## Audience

- A pull request, an issue, a review comment, a commit message, documentation, or a code comment: [github.md](github.md).
- A Slack message, a thread reply, or a quick check-in with teammates: [slack.md](slack.md).
- A reply to the person you work for, in a terminal or an agent pane: [replies.md](replies.md).

## Voice

Write business casual, the way one colleague writes to another.
Sound like a person, not a system log or a press release.

ASD-STE100 Simplified Technical English and a relaxed tone pull in different directions.
Settle it this way:

- **STE controls the sentence.** Sentence length, one idea per sentence, active voice, articles, and word choice follow the rules below in every audience.
- **The audience controls the tone and the length.** Greetings, contractions, first person, how many sentences, and the format come from the audience topic.

A short Slack message is still made of whole, simple sentences.

## Simplified Technical English

34. **Short sentences.** Keep an instruction to 20 words or fewer, and a description to 25 words or fewer. Split a longer sentence.
35. **One instruction per sentence.** Write each action as its own imperative sentence. "Run the tests, then push" becomes "Run the tests. Then push the branch."
36. **Simple verb tenses.** Use the simple present, simple past, and simple future. "We are currently running the migration" becomes "The migration runs now."
37. **One word, one meaning.** Use a common word in its most common meaning, and use it as one part of speech. "Address the bug" becomes "fix the bug".
38. **Single verbs over phrasal verbs.** "Set up the database" becomes "configure the database". "Find out" becomes "learn" or "check". Keep a phrasal verb only when it is the name of a command or a UI label.
39. **Short paragraphs.** Keep a paragraph to one topic and six sentences or fewer.
40. **Lists for steps.** Put sequential steps in a numbered list, and parallel items in a bullet list.

## Patterns to detect and fix

Rule numbers are stable ids that other skills cite. A removed rule leaves a gap.

### Content

3. **Superficial -ing phrases.** "highlighting...", "ensuring...", "reflecting...", "showcasing...", "fostering...". Delete the phrase, or state the fact it points at.
5. **Vague attributions.** "Experts believe", "Industry reports suggest", "Some critics argue". Name the source or delete the claim.

### Language

7. **AI vocabulary.** Additionally, crucial, delve, enduring, enhance, fostering, garner, interplay, intricate, landscape (abstract), pivotal, robust, seamless, showcase, tapestry (abstract), testament, underscore, vibrant. Use the plain word.
8. **Fancy ways to say "is".** "serves as", "stands as", "boasts", "features". Say "is" or "has".
9. **"Not just X, but Y."** State the point directly.
10. **Rule of three.** Use the natural number of items, not a forced group of three.
11. **Synonym cycling.** Pick one term for one thing and repeat it. STE rule 37 applies the same idea to every word.
12. **False ranges.** "from X to Y" where X and Y are not on a real scale. List the topics.

### Style

13. **Em dashes.** Use no em dash. Separate thoughts with a period or a comma. Use no en dash or hyphen as a dash substitute either.
14. **Colon overuse.** Use a colon before a list or an example. Elsewhere, let the point stand as its own sentence.
15. **Bold for structure only.** Bold the one fact a skimming reader must not miss, or a lead-in that names a list item. Do not bold every proper noun or acronym.
16. **Inline-header lists.** A bold label and colon that repeats the line, "**Performance:** Performance improved...", is a tell. Remove the label, or make it a lead-in that ends in a period and is followed by new detail: "**Schema in TypeScript.** Tables live in one file."
17. **Title case headings.** Use sentence case.
18. **Decorative emojis.** Remove them from headings and bullets.
19. **Curly quotes.** Use straight quotes.

### Communication artifacts

20. **Chatbot phrases.** "I hope this helps!", "Let me know if you have any questions!", "Of course!", "Certainly!", "Found the smoking gun!" Remove them. A real question or request to a named person is fine.
22. **Sycophantic tone.** "Great question! You're absolutely right!" Respond directly.

### Filler

23. **Filler phrases.** "In order to" becomes "To". "Due to the fact that" becomes "Because". Delete "It is important to note that".
24. **Excessive hedging.** "could potentially possibly be argued that it might" becomes "may".
25. **Generic conclusions.** "The future looks bright." State the specific plan or fact.

### Jargon

26. **Abstract metaphor nouns.** Substrate (base), wedge in (add), vector (way, method), locus, vantage, nexus, primitive as a noun, harness as a metaphor, surface as in "API surface", bedrock, scaffolding as a metaphor, modality, paradigm, gold-plating (more than the job needs), ratchet as a metaphor, evacuate for moving code (move out), endgame (the last phase), north star, flywheel. Use the concrete word.
41. **Buzzwords.** Synergy, deep dive, circle back, touch base, move the needle, low-hanging fruit, game changer, unlock, empower, best in class, bandwidth for time, align for agree. Say the plain thing: "deep dive" becomes "a close look", "circle back" becomes "reply later".

### Plain speech

27. **Say what it does, not how it feels.** "SQL you can read" names a feeling. "`.toSQL()` returns the exact string sent to the database" names the mechanism. If you cannot restate a sentence as an instruction, a fact, or a number, cut it. A sentence that could appear unchanged in another project's docs says nothing about this one.
28. **Shorten or split dense sentences.** If the reader must read a sentence twice, split it or drop clauses. STE rule 34 gives the word limits.
29. **Active voice.** Name the actor: "queries are validated" becomes "the compiler validates queries". Use the passive only when the actor is unknown or does not matter.
30. **Cut adverbs, or use a stronger verb.** "runs quickly" becomes "is fast" or the number. "significantly improves" becomes the measured change.
31. **Prefer the plain word.** "utilize" and "leverage" become "use", "facilitate" becomes "help", "numerous" becomes "many", "in the event that" becomes "if".
32. **Mannered prose.** Aphorisms ("wire it or delete it"), rhetorical fragments, personified code ("the plan holds it"), and figurative verbs ("rides along") hide the literal meaning. Write the literal phrase.
33. **Over-compression.** Dropped articles, verbless fragments, arrows, and abbreviations make the reader decode. "Parser rejects bad date → exit 2" becomes "The parser rejects a bad date and exits with code 2." A short message keeps its articles and verbs too.
