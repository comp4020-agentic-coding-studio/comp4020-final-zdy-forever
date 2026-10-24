# Leading agentic development without inspecting every function

**Position.** I think I can delegate implementation and detailed code review without understanding every function's boundary conditions. I still have to decide what the system should do and which trade-offs to accept. Before accepting the result, I need to understand enough to tell whether the evidence actually checks what I asked for.

When I work on my Telegram bot with an agent, I mostly make decisions and change wording. The agent writes the logic. I expect manual coding to become concentrated in unusually complex projects, but that is still my prediction. This leaves me asking how much I need to understand to delegate responsibly.

## A shift in work, not proof of dispensability

[Willison (2026)](https://simonwillison.net/guides/agentic-engineering-patterns/code-is-cheap/) distinguishes inexpensive code generation from the continuing cost of producing good software, including knowing that it works. This moves attention from typing to acceptance; it does not make implementation knowledge unnecessary.

[Vella and Blincoe (2026)](https://arxiv.org/abs/2605.23135) followed 95 professional engineers across six months: 82% reported less time writing code, and the authors name the new work "supervisory engineering": direction, evaluation and correction. Yet those reporting a worse developer experience nearly doubled, from 14% to 27%, with flow and cognitive load eroding. I often have three or four agent sessions open for different projects. They can all work at once, but I have to review each one separately. I get tired quickly from switching between them. The work now waits for my attention, so I need to be careful about how much I take on for review.

## Review can also be delegated

The alternative to reading every line is checks that expose behaviour. [Böckeler (2026)](https://martinfowler.com/articles/harness-engineering.html) distinguishes guidance before generation from feedback afterwards, and deterministic checks from inferential model-based review. Agents can propose tests, diagnose failures and compare options. But she marks the limit: "Correctness is outside any sensor's remit if the human didn't clearly specify what they wanted in the first place."

My final project showed this. A generated test of disconnected voters passed, but my requirement concerned connected people who decline to vote. I had to notice that difference and ask for a check that covered it. I left finding the faulty function to the agent.

[Cihan et al. (2025)](https://arxiv.org/abs/2505.20206) complicate reliance on a second model. On 492 AI-generated blocks, GPT-4o classified correctness with 68.50% accuracy and corrected code in 67.83% of cases when supplied with problem descriptions. Performance declined without them: the reviewer did better when someone told it what the code was for, which is exactly the part a person can supply without reading the code. This bounded HumanEval study does not describe every current agent, but another agent's approval is evidence to assess, not a guarantee.

## The strongest objection: lost understanding

[Balepur et al. (2026)](https://arxiv.org/abs/2607.26375) studied 54 students building a website with an editing agent or a chatbot. Agents aided completion but harmed comprehension and the ability to extend the code without them. This is a serious objection: a leader who cannot interrogate explanations may accept fluent but inadequate advice.

But the objection bundles reasons that need separating. The authors measured understanding by having participants extend their code without the agent, to isolate skill from offloading, and they justify understanding by the agent being unavailable (confidential work, outages), by communication, and by oversight that can "thwart catastrophic errors". Where agents are permitted and available, the test condition and the outage argument lose most of their force: nobody need work as if the agent might vanish. The authors concede that for some work "short-term productivity may be sufficient".

I still have to check the work, even with an agent available. Cihan et al.'s results show why I cannot leave that entirely to the agent. So the understanding a leader keeps is not the ability to rewrite the code by hand; it is the ability to say what correct behaviour looks like and recognise evidence that does not test it. Balepur et al. also found that low-effort use, such as pasted prompts and auto-accepted edits, went with weaker comprehension. I read this as a reason to stay involved when I delegate. If agents disagree and no available test distinguishes their explanations, I should withhold acceptance or obtain specialist help; calling myself a leader cannot substitute for resolving uncertainty.

## A defensible form of delegation

I would not take these papers to mean that developers can stop understanding code. I do think they put too much weight on working without an agent when one is available. For my own work, I need to know what I want to build, which costs I can accept and what evidence would convince me it works. I can delegate implementation and investigation. If the checks leave my question unanswered, I have to keep asking.

## References

- Balepur, N., Baumler, C., Chen, V., Choi, E., Rudinger, R., & Boyd-Graber, J. L. (2026). *(Im)Paired programming: Coding agents improve productivity but harm understanding*. In-progress preprint. [arXiv:2607.26375](https://arxiv.org/abs/2607.26375).
- Böckeler, B. (2026, April 2). *Harness engineering for coding agent users*. [martinfowler.com](https://martinfowler.com/articles/harness-engineering.html).
- Cihan, U., İçöz, A., Haratian, V., & Tüzün, E. (2025). *Evaluating large language models for code review*. Preprint. [arXiv:2505.20206](https://arxiv.org/abs/2505.20206).
- Vella, A., & Blincoe, K. (2026). *The impact of AI coding assistants on software engineering: A longitudinal study*. Preprint. [arXiv:2605.23135](https://arxiv.org/abs/2605.23135).
- Willison, S. (2026). *Writing code is cheap now*. [Agentic Engineering Patterns](https://simonwillison.net/guides/agentic-engineering-patterns/code-is-cheap/).

