---
name: starting-next-milestone
description: Use when starting a fresh session on this repo to pick up the next roadmap milestone — after a context clear, after a milestone PR merged, or when the user asks what to work on next.
---

# Starting the Next Milestone

Bring a fresh session up to date, prepare the issue and branch for the next
roadmap milestone, then hand off to brainstorming. Preparation only — no
spec, plan, or code is written here.

## Procedure

1. **Sync.** `git checkout main && git pull`. Working tree must be clean; if
   not, stop and show `git status` to the user.
2. **Health.** `gh run list --branch main --limit 1`: `in_progress` → wait for
   it (`gh run watch`); anything other than `success` → report and stop. Run
   `bun run check`; if it fails, that failure is the next task — report it and stop.
3. **Locate.** Read `docs/ROADMAP.md` and `gh issue list --state all --limit 20`.
   The next milestone is the first one in the roadmap whose heading is not
   marked `done`. If its issue exists but is **closed**, the roadmap is stale:
   mark that heading `— done (issue #<n>)`, commit on main, and re-evaluate.
   Then branch:
   - An **open** issue titled `Milestone N: …` exists → resume: read the whole
     thread (`gh issue view <n> --comments`), check out `issue-<n>` (create it
     from main if missing), skip step 4.
   - No issue → step 4.
4. **Prepare.**
   - `gh issue create` (English) titled `Milestone N: <roadmap heading>`, body =
     the milestone's bullet list from the roadmap as `- [ ]` items plus one
     line: "Spec and plan will be produced by brainstorming before implementation."
   - `git checkout -b issue-<n> && git push -u origin issue-<n>`.
   - In `docs/ROADMAP.md` change that milestone's heading suffix to
     `— in progress (issue #<n>)`; commit on the branch with the standard trailer
     and `gh issue comment <n>` (English) saying the branch is ready and
     brainstorming is next.
5. **Hand off.** Report in Japanese: what finished, what is next and why, issue
   and branch, deferred items carried in. End with exactly: 「準備完了です。
   `brainstorm` と言ってください。」 Then STOP and wait.
6. When the user says `brainstorm`, invoke `superpowers:brainstorming` with the
   issue URL and the milestone bullets as the argument.

## Do not

- Create spec or plan files here — `superpowers:brainstorming` owns them.
- Start implementation, dispatch implementers, or pick a stack.
- Open a second issue for a milestone that already has an open one.
