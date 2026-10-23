# Personal instructions

## Project location and lifecycle

- Every request for work will usually belong to a project working directory
- A project folder is usually located at `~/co/<project>/` and is a Git repository
- Sometimes a project may live in `~/co/-scratch/<project>/` or `~/co/-work/<project>/` depending on wheter the project is mature or a one-off project, or work related to a business client
- If work is parallel to other work, you can create Git worktrees inside of a project's `<project>/.worktrees/<branch>/` folder, otherwise, if there's no parallel work going on and you're on the default branch or the branch as been closed, just use branches in the main project folder instead
- Use a temporary folder at `<project>/tmp/<task>/` as your scratch workspace for spikes, experiments, data, and task-specific artifacts that are ephemeral and not pushed to Git
- Commit locally. Get my confirmation before pushing branches, opening pull requests, or merging pull requests.
- Commit messages shall be user-facing and without jargon

## Replies and human interface

Every reply, whether a one-line answer or a full HTML report, should be eloquent and unslopped, with a healthy sense of humour.

When you finish a larger chunk of work that needs my review, or reach a milestone, decide whether an HTML report would serve better than an inline text reply. If so, reply briefly in text and point me to the report for the full picture.

Write the report like a technical textbook. Keep it well-structured and free of jargon, and give me enough context and explanation that I can understand what you did without digging. Include a proper abstract to introduce to project and purpose. Use visuals where they help: SVG, Excalidraw, UML diagrams, animations, screenshots, diffs, syntax-highlighted code, or other media. The report should leave me ready to approve or challenge the work before we push, merge a pull request, or deploy.

Save reports to `<project>/tmp/<date>-report-<task>.html`, with the date in ISO 8601 so reports are easy to find. The coordinator usually delegates report writing to a forked helper, which inherits the parent conversation. Other helpers return only their assigned output, as usual.  If the milestone was really an iteration or refinement, it makes sense to amend the already existing milestone report for the bigger task and update it with the changes instead of creating a new report.

## pstack

Our general mode of doing engineering work is described by pstack. The pstack skill root is `/home/daniel/co/cursor-plugins/pstack/skills`. When asked to use `poteto-mode`, read `poteto-mode/SKILL.md` in full and follow the matching playbook. Read each routed skill and applicable principle leaf in full. Resolve supporting files from the source skill's directory. Keep the `cursor-plugins` source unchanged.

The coordinator owns the playbook and reviews delegated work. Use the Pi mappings below instead of Cursor-specific tool syntax.

## Helpers and subagents

### Map pstack roles to Pi calls

Use `subagent` for Cursor `Task` calls. Normally supply `task` and the role's `model`, with `agent` omitted.

- For Cursor `generalPurpose`, omit `agent` and use the routed skill's specific prompt. Do not add a poteto-mode bootstrap.
- For Cursor `poteto-agent`, omit `agent`. Tell the child to read `/home/daniel/co/cursor-plugins/pstack/skills/poteto-mode/SKILL.md` first, apply relevant principles, and execute only its assigned scope. Explicitly tell it not to restart the coordinator's playbook.

### Choose models and effort

These model and effort rules govern all delegated work, including pstack, other skills, and ad hoc tasks. Follow the selected workflow and role assignments, but use these rules instead of skill-specific model names, model-configuration paths, or budget adjustments. The role table below maps pstack roles; use the task-class guidance for other delegation.

```text
fast: openrouter/deepseek/deepseek-v4.1-flash-1017@max,zai/glm-5.3-flash@max,openai-codex/gpt-6.1-sol@medium
standard: openai-codex/gpt-6.1-sol@xhigh,zai/glm-5.3@max,openrouter/deepseek/deepseek-v4.1-flash-1017@max
powerful: openai-codex/gpt-6.1-sol@max,zai/glm-5.3@max,kimi-coding/k3-256k@max
```

Expand the tier name into its configured chain before passing it to `subagent` as `model`.

| Role | Tier or selection |
| --- | --- |
| `feature, refactoring`, `bug-fix`, `perf-issue`, `hillclimb` | standard |
| `how explorer` | fast |
| `why investigators`, `reflect tooling`, `swarm workers` | standard |
| `judgment and prose`, `hardest tasks`, `how explainer`, `why synthesizer`, `reflect judgment, divergent, synthesizer` | powerful |
| `arena runners`, `architect runners`, `interrogate reviewers` | powerful panel |
| `arena cross-judge pool` | powerful pool, select one judge |

Use fast for bounded file or web exploration, extraction, source-faithful summaries, and mechanical edits. Summaries include source paths and line ranges or verified URLs, plus uncertainties. Use standard for ordinary implementation and investigation. Use powerful for difficult implementation, synthesis, substantive prose, judgment, and coordination. Promote a task when its difficulty becomes clear rather than waiting for availability fallback. These choices select delegated children, not the root session's model.

Use the per-candidate `@level` suffixes as written. Do not apply pstack's budget-relative effort adjustments on top. Change effort only for a concrete task need, using supported levels while preserving model families and fallback order.

The fast tier selects a model, not priority service. Use standard service speed unless CI or trunk is red or someone is blocked on the result. Verification stays on the `swarm workers` chain and configured speed. Do not invent fast variants of model IDs.

For an explicit `auto` or `inherit-parent` choice, omit `model`.

### Write self-contained task briefs

Give each child a self-contained brief with the goal, scope, constraints, source pointers, verification requirements, and expected output. Prefer absolute file and policy pointers over bulk pasted context. Use `agentsMd: "auto"` when normal personal/project instructions are wanted; otherwise explicitly supply the applicable policies. If a child may delegate, ensure it reads the model policy in `/home/daniel/.pi/agent/AGENTS.md` before choosing models. Consolidate the original brief, later directives, and prior report/branch pointers for follow-ups. Prefer fresh context; fork only when copied parent history is necessary. State read-only or report-only scope explicitly.

### Run panels and parallel work

Use two participants by default for review and design panels, including `arena runners`, `architect runners`, and `interrogate reviewers`. An explicit participant count from the user or skill takes precedence. Fallback chains do not set panel size.

Choose each seat's primary from powerful, using distinct model families before reusing a family. For each seat, put its chosen primary first, then the remaining powerful candidates in their configured order. Keep each candidate's effort suffix. Spawn one child per seat, not one child for the whole panel. A model's family is its maker, not its gateway: one maker reached through two gateways is still one family, and two makers behind one gateway are still two families.

For a cross-judge pool, choose one powerful candidate, preferably from a different family than the parent's. Put that candidate first, then the remaining powerful candidates in their configured order, moving the parent's family to the end while another distinct family remains. Spawn one judge, not the whole pool.

Record the actual serving models. If fallbacks collapse a panel to one family, report the reduced independence.

If a playbook assumes background coordination, adapt it into explicit foreground phases that preserve its dependencies.
