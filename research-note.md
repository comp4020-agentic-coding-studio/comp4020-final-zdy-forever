# Leading agentic development without inspecting every function

**Position.** Developers can increasingly delegate implementation and detailed code review, while retaining responsibility for requirements, trade-offs and acceptance. Effective leadership does not require understanding every function's boundary conditions, but it does require understanding the system's purpose well enough to judge whether the evidence answers the intended question. Delegation can make implementation opaque; it should not make success undefined.

My starting point is personal: building a Telegram bot with an agent, I mostly make decisions and adjust wording rather than write logic. I expect manual implementation to concentrate in unusually complex projects, though that is a prediction, not a finding. The question is how much understanding responsible delegation requires.

## A shift in work, not proof of dispensability

[Willison (2026)](https://simonwillison.net/guides/agentic-engineering-patterns/code-is-cheap/) distinguishes inexpensive code generation from the continuing cost of producing good software, including knowing that it works. This moves attention from typing to acceptance; it does not make implementation knowledge unnecessary.

[Vella and Blincoe (2026)](https://arxiv.org/abs/2605.23135) followed 95 professional engineers across six months: 82% reported less time writing code, and the authors name the new work "supervisory engineering": direction, evaluation and correction. Yet those reporting a worse developer experience nearly doubled, from 14% to 27%, with flow and cognitive load eroding. That matches my own experience. I often run three or four agent sessions on different projects at once; the agents work in parallel, but I review them one at a time, and switching between their contexts tires me quickly. Delegation moves the bottleneck to the person's attention rather than removing it, so a leadership model has to economise on what the person must check.

## Review can also be delegated

The alternative to reading every line is checks that expose behaviour. [Böckeler (2026)](https://martinfowler.com/articles/harness-engineering.html) distinguishes guidance before generation from feedback afterwards, and deterministic checks from inferential model-based review. Agents can propose tests, diagnose failures and compare options. But she marks the limit: "Correctness is outside any sensor's remit if the human didn't clearly specify what they wanted in the first place."

My final project showed this. A generated test of disconnected voters passed, but my requirement concerned connected people who decline to vote. My task was to see that difference in meaning and ask for evidence about it; finding the faulty function stayed delegated.

[Cihan et al. (2025)](https://arxiv.org/abs/2505.20206) complicate reliance on a second model. On 492 AI-generated blocks, GPT-4o classified correctness with 68.50% accuracy and corrected code in 67.83% of cases when supplied with problem descriptions. Performance declined without them: the reviewer did better when someone told it what the code was for, which is exactly the part a person can supply without reading the code. This bounded HumanEval study does not describe every current agent, but another agent's approval is evidence to assess, not a guarantee.

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

