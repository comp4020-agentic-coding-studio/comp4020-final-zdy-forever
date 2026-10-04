# From Code Production to Engineering Judgement: The Developer's Role in Agentic Software Development

**Position.** As coding agents take over more implementation work, the developer’s role is not simply changing from writing code to reviewing code. Instead, developers are becoming responsible for higher-level engineering judgement: explaining what they want, comparing different trade-offs, and deciding whether an AI-generated solution should be accepted. This does not mean programming skills are becoming useless. Developers still need strong technical knowledge in order to judge AI-generated code properly.

## The bottleneck has moved

In traditional software development, one of the most expensive steps was turning an idea into working code. Willison (2026) argues that coding agents greatly reduce the cost of producing code, but producing *good* software is still expensive. The development process is therefore changing. A developer defines a task, an agent produces a change, the developer checks it, and the agent revises it.

When code generation becomes cheap, writing the implementation is no longer the main limitation. The more important question becomes whether the implementation is correct, useful, maintainable, and worth keeping.

## Work is already being redistributed

There is evidence that this shift is already happening. Vella and Blincoe (2026) studied professional software engineers over six months. In their matched group of 95 participants, 82% reported spending less time writing code. The authors described a shift “from creation to verification” and called the new type of work *supervisory engineering work*. This includes directing AI systems, evaluating their output, and correcting their mistakes.

A GitHub survey of 2,000 enterprise developers reported a similar pattern. Developers said that time saved by AI was being used for system design, collaboration, and learning (Daigle & GitHub Staff, 2024). However, these two sources should not be treated equally. GitHub sells Copilot and has a commercial reason to present AI-assisted development positively. Vella and Blincoe provide more independent evidence, and their findings were less optimistic. They found that the percentage of developers reporting a worse experience almost doubled, from 14% to 27%, while problems such as cognitive load and loss of flow increased.

This suggests that agents do not simply make development easier. Instead, they move more of the developer’s effort away from writing code and toward supervising AI-generated work.

## Evaluation is not a minor remaining task

It might seem that checking AI-generated code is only a temporary problem that will disappear as developers become more familiar with AI tools. However, current evidence suggests otherwise.

In a randomized workplace study, Butler et al. (2025) found that developers became more positive about the usefulness and enjoyment of generative coding tools over time. However, their trust in the correctness of AI-generated code did not increase. In other words, familiarity with AI tools did not remove the need for careful checking.

Zhong et al. (2026) analysed 278,790 code-review conversations from 300 open-source projects. They found that AI reviewers were useful for finding defects at scale, but human reviewers contributed more contextual feedback, including comments about understanding, testing, and knowledge sharing. AI suggestions were also accepted less often. More than half of the rejected AI suggestions were either incorrect or replaced by a different solution. The study also found that accepted AI suggestions tended to increase code size and complexity more than human suggestions.

These results suggest that once code generation is automated, evaluation becomes one of the main places where software quality is controlled.

## Counter-case: evaluation can also be automated

A strong counterargument is that evaluation itself can also be automated. If one AI agent writes the code and another AI system checks it, human supervision may only be a temporary stage.

Harness engineering supports this idea. Böckeler (2026) argues that developers can surround agents with automated checks such as tests, linters, type checkers, and LLM-based reviewers. These tools can detect mistakes and allow agents to correct themselves with less human involvement.

There is evidence that this works to some extent. Cihan et al. (2025) found that GPT-4o correctly classified 68.5% of AI-generated code blocks and correctly repaired 67.8% of them. This shows that a large amount of mechanical checking may also be automated.

However, this result also shows the limits of automated evaluation. The model performed better when it was given a clear problem description. Without clear information about what the code was supposed to do, its performance became worse. This means automated evaluation still depends on someone clearly defining the intended behaviour.

Böckeler makes a similar point. Automated checks cannot determine whether a system is correct if the human has not clearly explained what “correct” means. Zhong et al.’s finding about increased code complexity also shows that some important qualities are difficult to measure automatically. Code may pass every test while still making the system harder to understand or maintain.

Tests can check whether code behaves as expected. They cannot always decide whether the expectation itself is sensible, whether a feature is worth building, or whether a particular design is the best choice. Therefore, as mechanical evaluation becomes more automated, human judgement is likely to move toward higher-level decisions about intent, trade-offs, architecture, and acceptance.

## What this means for developers

This is also why programming knowledge still matters. A developer cannot judge an implementation well without understanding how it works.

Balepur et al. (2026) studied 54 students using coding agents. They found that agents helped participants complete tasks, but also reduced their understanding of the code. Participants who automatically accepted more AI-generated edits tended to understand the system less well. Because this was a small study involving only students, it should not be treated as strong evidence about all professional developers. However, it highlights an important risk: developers may lose the technical understanding that they need in order to supervise AI effectively.

Good agentic development therefore does not mean trying to write code faster than the agent, but it also does not mean giving up technical knowledge. Developers need enough understanding to clearly direct agents, evaluate their work, and reject poor solutions when necessary.

The developer’s role is therefore shifting not simply from writing code to reviewing it, but from producing implementation to exercising engineering judgement.

## References

- Balepur, N., Baumler, C., Chen, V., Choi, E., Rudinger, R., & Boyd-Graber, J. L. (2026). *(Im)Paired programming: Coding agents improve productivity but harm understanding* [Preprint]. arXiv:2607.26375. <https://arxiv.org/abs/2607.26375>

- Böckeler, B. (2026, April 2). *Harness engineering for coding agent users*. martinfowler.com. <https://martinfowler.com/articles/harness-engineering.html>

- Butler, J., Suh, J., Haniyur, S., & Hadley, C. (2025). Dear Diary: A randomized controlled trial of generative AI coding tools in the workplace. In *Proceedings of the 47th International Conference on Software Engineering: Software Engineering in Practice (ICSE-SEIP)*. IEEE. <https://doi.org/10.1109/ICSE-SEIP66354.2025.00034>

- Cihan, U., İçöz, A., Haratian, V., & Tüzün, E. (2025). *Evaluating large language models for code review* [Preprint]. arXiv:2505.20206. <https://arxiv.org/abs/2505.20206>

- Daigle, K., & GitHub Staff. (2024, August 20). *Survey: The AI wave continues to grow on software development teams*. The GitHub Blog. <https://github.blog/news-insights/research/survey-ai-wave-grows/>

- Vella, A., & Blincoe, K. (2026). *The impact of AI coding assistants on software engineering: A longitudinal study* [Preprint]. arXiv:2605.23135. <https://arxiv.org/abs/2605.23135>

- Willison, S. (2026). Writing code is cheap now. In *Agentic engineering patterns*. <https://simonwillison.net/guides/agentic-engineering-patterns/code-is-cheap/>

- Zhong, S., Noei, S., Zou, Y., & Adams, B. (2026). *Human-AI synergy in agentic code review* [Preprint]. arXiv:2603.15911. <https://arxiv.org/abs/2603.15911>