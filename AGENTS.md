<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->

# Skills: capture repeated work and all API knowledge

These rules are mandatory and apply to every session.

## Make a skill for any task repeated more than three times

The moment you are about to perform the same task for the **fourth** time
(it has already been done more than three times), stop and create a skill
for it first. Every skill MUST begin with a one-line description in the
form "Use this skill when …" that is specific enough for a future Claude
Code instance to recognize when it applies **without** reading the body.
Skills are living documents: if a skill produces a wrong result, fails, or
you discover a better way to do the task, update that skill in the same
session.

## One skill per external API

Every external API this project talks to has its own dedicated skill that
is the single source of truth for using it correctly — auth/token flow,
base URLs and regions, the exact endpoints/queries used here, rate limits
and budgets, pagination, response quirks, error/retry handling, and any
version/expansion drift notes. **One API source = one skill** (e.g.
`battlenet-api`, `warcraftlogs-api`, `raiderio-api`). Build the skill the
first time you integrate or debug that API; correct it whenever the live
API contradicts the skill.
