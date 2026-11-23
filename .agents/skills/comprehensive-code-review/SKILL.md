---
name: comprehensive-code-review
description: >-
  Review uncommitted changes or a branch against a baseline. Use when the user
  requests a code review, comprehensive check, or repeat review of a diff.
  Cover behavior, user experience, performance, network requests, database
  queries, maintainability, compatibility, schema changes, and tests.
---

# Comprehensive Code Review

## Skill usage

When you begin using this skill, tell the requester in the conversation that you are using `comprehensive-code-review` and briefly describe the task. Name the skill in your final response, including when a prerequisite prevents completion.

## Scope

- For **current uncommitted changes**, use `HEAD` as the baseline and include staged, unstaged, and relevant untracked changes. Inspect the index and working tree separately when their versions differ, and identify findings that affect only one version.
- For **the current branch relative to main**, use the merge base of local `main` and `HEAD`. Review the combined effect of the branch's committed changes and the current uncommitted changes, including relevant untracked files. Follow any narrower scope or alternate baseline the user specifies.
- Read surrounding code and callers as needed. Report only problems introduced by the reviewed changes or made reachable or materially worse by them.
- Check applicable repository guidance and product contracts before judging expected behavior. In repeat reviews, carry forward confirmed decisions. Reopen a decision when new changes or evidence affect its rationale. Mention accepted tradeoffs briefly at the end when they are relevant or requested.

## Review Areas

Use the areas that apply to the diff and the user's request.

### Correctness and user experience

- Trace changed behavior through its real entry points, side effects, and visible outcomes. Check whether failures leave users with accurate feedback and a workable next action.
- For asynchronous changes, identify which result is authoritative and when state can be replaced or discarded. Follow relevant paths for partial success, retries, navigation, reconnects, and late or out-of-order responses. Check whether a reachable sequence can lose updates, restore stale state, or repeat side effects.

### Performance, network requests, and database queries

- Trace a single action or event across the client and server. Count avoidable requests, queries, refreshes, and work repeated per item or recipient. Check whether an already available result can be reused with the required freshness and scope.
- Describe the workload that triggers the cost. Where practical, quantify request or query counts, payload size, or elapsed time. Identify which figures were measured, derived from the code, or calculated as upper bounds. Set priority using frequency and impact.

### Maintainability

- Look for multiple implementations of the same business rule, and check whether they need to change together. Prefer the smallest shared implementation that preserves caller behavior and ownership.
- Check existing project code, standard libraries, and installed dependencies before suggesting a new helper or dependency. Compare behavior, added complexity, and costs on the affected paths before recommending a replacement.
- Trace callers, supported inputs, and release history before flagging dead branches, unused exports, or obsolete compatibility code. Look for defensive conditions with no reachable input and indirection that hides straightforward logic.
- Flag naming, comments, and literals when they obscure a contract or make a domain rule easy to change inconsistently. Review error handling, visibility, and dependency direction for concrete effects on callers or future changes.

### Compatibility

- Identify which released clients, public interfaces, and existing data can encounter the change. Check relevant combinations of old and new versions, including upgrades and rollbacks when persisted formats or deployment order change.
- Identify the consumers or data formats a compatibility path protects. Distinguish still-supported behavior from transitional code and formats that exist only in the unpublished changes. Flag avoidable breaks and unnecessary fallback logic with that evidence.

### Database schema

- Check whether a new table or field serves a necessary requirement. Compare the cost of using existing fields or deriving the value with the cost of storing and maintaining another copy of state.
- For new persisted state, trace who writes it, how existing records are handled, and how the value stays consistent as source state changes. Consider defaults, backfills, and cleanup where the change requires them.

### Tests

- Compare tests by the behavior, failure mode, and event ordering they protect. When recommending removal or consolidation, identify the retained coverage that would catch the same regression.
- Judge edge cases by reachability, impact, and maintenance cost. Call out missing coverage when a focused test would catch an important regression introduced by the change.

## Report

- State the baseline and the changes reviewed. Lead with findings ordered by impact and realistic likelihood. Give each finding a priority, file and line, trigger, consequence, evidence, and a concrete fix direction.
- Validate consequential claims with a code trace, focused test, reproduction, or measurement as appropriate. State what was verified and identify any uncertainty that materially affects the conclusion.
- Report actionable findings in scope. If the review yields none, say so and mention any material verification limits. Modify implementation files only when the user requests fixes.
