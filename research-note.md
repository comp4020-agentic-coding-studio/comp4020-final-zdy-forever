# Leading agentic development without inspecting every function

**Position.** Developers can increasingly delegate implementation and detailed code review, while retaining responsibility for requirements, trade-offs and acceptance. I do not think effective leadership requires personally understanding every function's boundary conditions. It does require understanding the system's purpose and dependencies well enough to judge whether the evidence answers the intended question. Delegation can make implementation opaque; it should not make success undefined.

My starting point is personal: while building a Telegram bot with an agent, I mainly make engineering decisions and adjust wording rather than write application logic. I expect manual implementation may eventually be concentrated in unusually complex projects. This is my prediction, not a general result established by that experience. The relevant question is how much understanding responsible delegation requires.

## A shift in work, not proof of dispensability

[Willison (2026)](https://simonwillison.net/guides/agentic-engineering-patterns/code-is-cheap/) distinguishes inexpensive code generation from the continuing cost of producing good software, including knowing that it works. This practitioner argument supports moving attention toward acceptance rather than typing, but does not demonstrate that all implementation knowledge has become unnecessary.

[Vella and Blincoe (2026)](https://arxiv.org/abs/2605.23135) provide empirical context: their longitudinal study included 95 matched participants, and 82% reported less time writing code. They describe supervisory engineering involving direction, evaluation and correction. Yet reported deterioration in developer experience rose from 14% to 27%. These self-reports support a redistribution of work, not a causal claim that agents eliminate expertise. Supervision may create new cognitive demands even while reducing manual implementation.

Taken together, these sources make my leadership model plausible without establishing its strongest version. Producing less code does not itself tell us whether leaders can safely avoid its details.

## Review can also be delegated

The alternative to reading every generated line is to arrange checks that expose consequential behaviour. [Böckeler (2026)](https://martinfowler.com/articles/harness-engineering.html) distinguishes guidance before generation from feedback afterwards, including deterministic checks and inferential model-based review. I interpret this as a practical way to delegate detailed investigation: agents can propose tests, diagnose failures and compare technical options, while a person decides which outcomes matter. This framework is practitioner guidance, not experimental proof that an automated checking system is sufficient.

The person need not personally discover every boundary case. They can ask an agent to challenge a requirement and produce executable examples. However, a generated test suite can faithfully implement a mistaken interpretation. For example, testing disconnected participants does not answer a requirement about connected people who decline to vote. The human's task is to recognise that difference in meaning and request evidence addressing it; locating the faulty function can remain delegated.

[Cihan et al. (2025)](https://arxiv.org/abs/2505.20206) complicate reliance on a second model. On 492 AI-generated blocks, GPT-4o classified correctness with 68.50% accuracy and corrected code in 67.83% of cases when supplied with problem descriptions. Performance declined without them. This bounded HumanEval-based study is not an estimate for every current agent or production system. It nevertheless shows why another agent's approval is evidence to assess, not a guarantee. Multiple approvals may share the same mistaken assumption; their agreement does not establish independent verification.

## The strongest objection: lost understanding

[Balepur et al. (2026)](https://arxiv.org/abs/2607.26375) studied 54 students building a website with an editing agent or a chatbot. Agents aided initial completion but harmed comprehension and preparation for extending the code without agents. Low-effort interactions and automatically accepted edits were associated with weaker understanding. This is a serious objection: a leader who cannot interrogate explanations may accept fluent but inadequate advice.

However, the study is an in-progress preprint involving students, and its extension task removed agent assistance. It does not establish that continuous agent-assisted work requires personally reconstructing every implementation detail. My response is to preserve understanding at the level of functionality, dependencies and observable consequences, while obtaining deeper investigation when evidence conflicts. I can judge a proposed trade-off from explanations and demonstrations without independently reproducing its entire technical derivation.

That boundary is conditional. If agents disagree and no available test distinguishes their explanations, I should withhold acceptance, request further investigation or obtain specialist help. Calling myself a leader cannot substitute for resolving uncertainty.

## A defensible form of delegation

The literature supports a narrower conclusion than “developers no longer need to understand code.” Implementation and much review can be delegated, but someone must connect requirements to credible evidence. This is the responsibility I retain. I do not need proactive mastery of every failure mechanism; I need to recognise when the available explanation and results are insufficient to make a decision. Engineering judgement then concerns what to build, what costs to accept and what would demonstrate success, while agents perform increasingly detailed implementation and investigation.

## References

- Balepur, N., Baumler, C., Chen, V., Choi, E., Rudinger, R., & Boyd-Graber, J. L. (2026). *(Im)Paired programming: Coding agents improve productivity but harm understanding*. In-progress preprint. [arXiv:2607.26375](https://arxiv.org/abs/2607.26375).
- Böckeler, B. (2026, April 2). *Harness engineering for coding agent users*. [martinfowler.com](https://martinfowler.com/articles/harness-engineering.html).
- Cihan, U., İçöz, A., Haratian, V., & Tüzün, E. (2025). *Evaluating large language models for code review*. Preprint. [arXiv:2505.20206](https://arxiv.org/abs/2505.20206).
- Vella, A., & Blincoe, K. (2026). *The impact of AI coding assistants on software engineering: A longitudinal study*. Preprint. [arXiv:2605.23135](https://arxiv.org/abs/2605.23135).
- Willison, S. (2026). *Writing code is cheap now*. [Agentic Engineering Patterns](https://simonwillison.net/guides/agentic-engineering-patterns/code-is-cheap/).

<!-- Evidence status: sources were located by agents. The student has not yet read them. This revision uses the three research abstracts and the two practitioner articles; it does not claim full-paper review or personal reading. See docs/submission-status.md before submission. -->
