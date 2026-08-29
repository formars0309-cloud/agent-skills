# agent-skills

Personal agent skills, kept here so they survive a machine and can be installed
anywhere. Works with Claude Code, and with any other agent that reads the
[skills.sh](https://skills.sh) layout.

## Skills

| Skill | What it does |
|---|---|
| [`citation-verify`](skills/citation-verify) | Resolves DOIs / PMIDs / PMCIDs against PubMed, Crossref and Europe PMC to catch fabricated, misattributed and retracted citations. |
| [`clinical-writing`](skills/clinical-writing) | Discipline for clinical content a clinician will act on: guideline lookup before drafting, a source label on every dose and target, and cross-model review before delivery. |

## Install on another machine

```bash
npx --yes skills add https://github.com/formars0309-cloud/agent-skills \
  --skill citation-verify --skill clinical-writing --global --agent claude-code -y
```

The repo is private, so that machine needs to be authenticated to GitHub first
(`gh auth login`, or an SSH key with access).

Or without the installer — clone and point the agent's skill directory at it:

```bash
git clone https://github.com/formars0309-cloud/agent-skills ~/projects/agent-skills
# Windows (no admin needed):
cmd //c mklink //J "%USERPROFILE%\.claude\skills\citation-verify" ^
  "%USERPROFILE%\projects\agent-skills\skills\citation-verify"
# macOS / Linux:
ln -s ~/projects/agent-skills/skills/citation-verify ~/.claude/skills/citation-verify
```

## How this checkout is wired on the main machine

`~/.claude/skills/citation-verify` is a directory junction into this repo, so
editing a skill here takes effect immediately in Claude Code — there is no copy
to keep in sync. Committing is the backup step, nothing else.

## Requirements

Node.js 18+ (for the built-in `fetch`). No API keys: PubMed, Crossref and
Europe PMC are all queried anonymously.

## Adding a skill

One directory per skill under `skills/`, each with a `SKILL.md` whose front
matter carries `name` and a `description` that says *when* to use it — the
description is the whole trigger, so write it as a list of situations and
phrases, not as a summary.
