---
name: starting-next-milestone
description: Use when starting a fresh session on this repo to pick up the next milestone — after a context clear, after a milestone PR merged, or when the user asks what to work on next.
---

# Starting the Next Milestone

Bring a fresh session up to date, prepare the milestone, issue and branch for
the next piece of work, then hand off to brainstorming. Preparation only — no
spec, plan, or code is written here.

Status lives on GitHub, not in `docs/ROADMAP.md`. Milestones carry what is in
flight, issues labelled `backlog` carry unscheduled ideas, and project 1 under
owner `7milch` carries priority with a `Status` field of `Todo` / `In Progress` /
`Done`. The roadmap file only records shipped history and the standing design
rules.

## Procedure

1. **Sync.** `git checkout main && git pull`. Working tree must be clean; if
   not, stop and show `git status` to the user.
2. **Health.** `gh run list --branch main --limit 1`: `in_progress` → wait for
   it (`gh run watch`); anything other than `success` → report and stop. Run
   `bun run check`; if it fails, that failure is the next task — report it and stop.
3. **Locate.** `gh api repos/{owner}/{repo}/milestones?state=open` and
   `gh issue list --state open --limit 30`.
   - An **open milestone** exists → that is the work in flight. Resume it: read
     the thread of its tracking issue (`gh issue view <n> --comments`), check out
     `issue-<n>` (create it from main if missing), skip step 4. If every issue in
     it is closed, the milestone is finished: close it, add a heading for it to
     the shipped history in `docs/ROADMAP.md`, commit on main, and re-evaluate.
   - **No open milestone** → pick the next item with the user from
     `gh issue list --label backlog`, then step 4.
4. **Prepare.**
   - Create the milestone: `gh api repos/{owner}/{repo}/milestones -f title="Milestone N: <short name>" -f description="<one or two lines>"`.
     N is one past the highest heading in the roadmap's shipped history.
   - Put the chosen backlog issue in it (`gh issue edit <n> --milestone "..."`)
     and drop the label (`--remove-label backlog`). That issue is the tracking
     issue. If the milestone bundles several issues, add them all and pick the
     largest as the tracking issue.
   - `git checkout -b issue-<n> && git push -u origin issue-<n>`.
   - `gh issue comment <n>` (English) saying the milestone and branch are ready
     and brainstorming is next.
   - Add the issues to the [project board](https://github.com/users/7milch/projects/1)
     and set their Status to `In Progress`:
     `gh project item-add 1 --owner 7milch --url <issue url>`, then
     `gh project item-edit --id <item id> --project-id <project id> --field-id <status field id> --single-select-option-id <option id>`
     with ids from `gh project item-list 1 --owner 7milch --format json` and
     `gh project field-list 1 --owner 7milch --format json`. The token needs the
     `project` scope; if it is missing, tell the user to run
     `gh auth refresh -s project` and carry on without the board.
5. **Hand off.** Report in Japanese: what finished, what is next and why, the
   milestone, issue and branch, deferred items carried in. End with exactly:
   「準備完了です。`brainstorm` と言ってください。」 Then STOP and wait.
6. When the user says `brainstorm`, invoke `superpowers:brainstorming` with the
   issue URL and the milestone description as the argument.

## Do not

- Create spec or plan files here — `superpowers:brainstorming` owns them.
- Start implementation, dispatch implementers, or pick a stack.
- Open a second milestone while one is still open.
- Track status in `docs/ROADMAP.md`; it records shipped milestones only.
