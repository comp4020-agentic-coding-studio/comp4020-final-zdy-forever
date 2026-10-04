# Crit 8 — It's alive

**The breakthrough.** At first, not having a third-party API keys such as YouTube Data API v3 key seemed like a limitation. Without a key, I could not implement normal YouTube search, so I changed the design to use the keyless oEmbed endpoint and allow users to add songs by pasting YouTube links instead ([`e866195`](https://github.com/comp4020-agentic-coding-studio/comp4020-final-zdy-forever/commit/e866195)).

Later, I realised that this was not only a workaround. This repository will eventually become public, so using an API key would also create another problem: I would need to make sure that the key was never committed or exposed.

By choosing a keyless solution, I removed that risk completely instead of trying to manage it later.

The same idea also applies to other parts of the project. For example, I like Eggy Party's design style but I wrote in `CLAUDE.md` that the project should not directly copy Eggy Party characters, logos, assets or exact screens. I originally thought of this mainly as a design rule, but it is also related to the fact that the project will be public. A public repository needs to consider not only secret keys, but also copyright and trademark issues.

**What this changed.** Previously, I thought making a repository safe for public release was something to check near the end of development: remove secrets from `.env`, check `.gitignore`, and make sure nothing sensitive was committed.

This experience showed me whether a feature needs a secret key in the first place is already a design decision. Instead of building a feature first and worrying about exposing credentials later, I should think about public release when choosing APIs, dependencies and assets. If there is a simpler solution that avoids storing secrets or using copyrighted material, it may be a better design from the beginning.

The main lesson for me is that security and public exposure should be considered during development, not only as a final checklist before release.