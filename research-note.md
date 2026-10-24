# Leading agentic development without inspecting every function

**Position.** Developers can increasingly delegate implementation and detailed code review, while retaining responsibility for requirements, trade-offs and acceptance. I do not think effective leadership requires personally understanding every function's boundary conditions. It does require understanding the system's purpose and dependencies well enough to judge whether the evidence answers the intended question. Delegation can make implementation opaque; it should not make success undefined.

My starting point is personal: building a Telegram bot with an agent, I mainly make engineering decisions and adjust wording rather than write logic. I expect manual implementation to concentrate in unusually complex projects, though that is a prediction, not a finding. The question is how much understanding responsible delegation requires.

## A shift in work, not proof of dispensability

[Willison (2026)](https://simonwillison.net/guides/agentic-engineering-patterns/code-is-cheap/) distinguishes inexpensive code generation from the continuing cost of producing good software, including knowing that it works. This supports moving attention from typing to acceptance, not that implementation knowledge is unnecessary.

[Vella and Blincoe (2026)](https://arxiv.org/abs/2605.23135) provide empirical context: their longitudinal study included 95 matched participants, and 82% reported less time writing code. They describe supervisory engineering involving direction, evaluation and correction. Yet reported deterioration in developer experience rose from 14% to 27%. These self-reports support a redistribution of work, not a claim that agents eliminate expertise; supervision brings its own demands. Producing less code does not itself tell us whether leaders can safely avoid its details.

## Review can also be delegated

The alternative to reading every generated line is to arrange checks that expose consequential behaviour. [Böckeler (2026)](https://martinfowler.com/articles/harness-engineering.html) distinguishes guidance before generation from feedback afterwards, including deterministic checks and inferential model-based review. I read this as a way to delegate detailed investigation: agents propose tests, diagnose failures and compare options, while a person decides which outcomes matter. It is practitioner guidance, not proof that automated checks suffice.

The person need not discover every boundary case, but a generated test suite can faithfully implement a mistaken interpretation. For example, testing disconnected participants does not answer a requirement about connected people who decline to vote. The human's task is to recognise that difference in meaning and request evidence addressing it; locating the faulty function can remain delegated.

[Cihan et al. (2025)](https://arxiv.org/abs/2505.20206) complicate reliance on a second model. On 492 AI-generated blocks, GPT-4o classified correctness with 68.50% accuracy and corrected code in 67.83% of cases when supplied with problem descriptions. Performance declined without them: the reviewer did better when someone told it what the code was for, which is exactly the part a person can supply without reading the code. This bounded HumanEval study does not describe every current agent, but it shows why another agent's approval is evidence to assess, not a guarantee; several approvals may share one mistaken assumption.

## The strongest objection: lost understanding

[Balepur et al. (2026)](https://arxiv.org/abs/2607.26375) studied 54 students building a website with an editing agent or a chatbot. Agents aided completion but harmed comprehension and the ability to extend the code without them. This is a serious objection: a leader who cannot interrogate explanations may accept fluent but inadequate advice.

But the objection bundles reasons that need separating. The authors measured understanding by having participants extend their code without the agent, to isolate skill from offloading, and they justify understanding by the agent being unavailable (confidential work, outages), by communication, and by oversight that can "thwart catastrophic errors". Where agents are permitted and available, the test condition and the outage argument lose most of their force: nobody need work as if the agent might vanish. The authors concede that for some work "short-term productivity may be sufficient".

Oversight does not dissolve this way. It is needed with the agent present, and Cihan et al.'s results show the agent cannot supply it alone. So the understanding a leader keeps is not the ability to rewrite the code by hand; it is the ability to say what correct behaviour looks like and recognise evidence that does not test it. Balepur et al. also found that low-effort use, such as pasted prompts and auto-accepted edits, went with weaker comprehension. That locates the risk in disengagement, not in delegation. If agents disagree and no available test distinguishes their explanations, I should withhold acceptance or obtain specialist help; calling myself a leader cannot substitute for resolving uncertainty.

## A defensible form of delegation

The literature supports a narrower conclusion than “developers no longer need to understand code.” Where agents are available, the ability to work without them matters less than these studies imply. What remains essential is connecting requirements to credible evidence: knowing what to build, what costs to accept and what would demonstrate success, and recognising when the available results cannot decide. That is the understanding I keep; implementation and investigation I delegate.

## References

- Balepur, N., Baumler, C., Chen, V., Choi, E., Rudinger, R., & Boyd-Graber, J. L. (2026). *(Im)Paired programming: Coding agents improve productivity but harm understanding*. In-progress preprint. [arXiv:2607.26375](https://arxiv.org/abs/2607.26375).
- Böckeler, B. (2026, April 2). *Harness engineering for coding agent users*. [martinfowler.com](https://martinfowler.com/articles/harness-engineering.html).
- Cihan, U., İçöz, A., Haratian, V., & Tüzün, E. (2025). *Evaluating large language models for code review*. Preprint. [arXiv:2505.20206](https://arxiv.org/abs/2505.20206).
- Vella, A., & Blincoe, K. (2026). *The impact of AI coding assistants on software engineering: A longitudinal study*. Preprint. [arXiv:2605.23135](https://arxiv.org/abs/2605.23135).
- Willison, S. (2026). *Writing code is cheap now*. [Agentic Engineering Patterns](https://simonwillison.net/guides/agentic-engineering-patterns/code-is-cheap/).

