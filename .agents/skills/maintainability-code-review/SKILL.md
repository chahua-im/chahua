---
name: maintainability-code-review
description: Performs a maintainability-focused code review on code that is already functionally correct. Use this skill when the user asks to review code for maintainability, readability, or code quality — not for bugs or functionality.
---

# Maintainability Code Review Skill

## Goal

To review code that is already functionally verified and working, focusing exclusively on long-term maintainability, readability, and structural quality. This is not a bug hunt — assume the code runs correctly.

## Trigger Confirmation

Before starting the review, respond with:
`🔍 Starting maintainability review using skill: maintainability-code-review`

## Instructions

Work through the following checklist in order. For each item, report findings clearly. If nothing to flag, write `✅ No issues found` for that item.

### 1. Dead / Compatibility-Only Code
- Identify code that was left behind after previous refactors or iterations.
- Look for: commented-out blocks, unreachable branches, feature flags that are always on/off, adapter layers that no longer have a counterpart, legacy shims kept "just in case."
- Action: Recommend deletion. If a shim is still needed, require a comment explaining exactly why and when it can be removed.

### 2. Duplicate / Redundant Code
- Find logic that is copy-pasted or reimplemented in multiple places.
- Look for: nearly identical functions differing only in a parameter, repeated inline expressions that could be extracted, parallel implementations of the same algorithm.
- Action: Recommend merging into a shared utility or parameterised function.

### 3. Hard-Coded Values
- Scan for numeric literals, string literals, and URLs embedded directly in logic.
- Distinguish between values that are truly local (e.g., `array[0]`, `range(10)`) and those that represent a domain concept (timeouts, limits, status strings, endpoint paths).
- Action: For domain-concept values, recommend extraction to a constants file, enum, or config.

### 4. Magic Strings
- Specifically look for string literals used in conditionals, switch/match statements, and comparisons (e.g., `if status == "active"`, `type === "admin"`).
- Action: Recommend extracting to an enum or named constant.

### 5. Over-Complex Logic
- Flag functions or blocks where the cognitive load is disproportionate to what is actually being done.
- Look for: deeply nested conditionals (3+ levels), chains of single-use intermediate variables, boolean logic that could be simplified with a named predicate, long functions that could be split.
- Action: Suggest a simpler rewrite or extraction. Prioritise readability over cleverness.

### 6. Unnecessary Comments
- Remove comments that simply restate the code (`i++ // increment i`), describe what is obvious from the code itself, or are outdated and no longer match the implementation.
- Keep comments that explain *why* a non-obvious decision was made, or that document public API contracts.
- Action: List specific comments to delete or rewrite.

### 7. Naming Quality
- Check that variable, function, parameter, and class names are semantically accurate and specific.
- Flag: single-letter names outside of well-understood idioms (loop counters, math), generic names (`data`, `temp`, `result`, `flag`, `info`, `obj`), misleading names that no longer match behaviour after refactoring.
- Also check for *inconsistent abbreviations* across the codebase (e.g., `mgr` in one place and `manager` in another).
- Action: Suggest concrete replacement names.

### 8. Single Responsibility
- Check whether each function or class does exactly one coherent thing.
- Flag: functions with multiple unrelated side effects, utility functions that secretly do I/O, classes that own both data and unrelated orchestration logic.
- Action: Recommend splitting or restructuring with a brief justification.

### 9. Error Handling Consistency
- Scan for: empty `catch`/`except` blocks, errors that are silently swallowed, error messages with no context (bare `raise`, `throw new Error()`), inconsistent patterns across the codebase (some callers check return codes, others use exceptions).
- Action: Recommend a consistent strategy and flag specific gaps.

### 10. Unnecessary Exposure (Visibility)
- Check whether functions, methods, classes, or modules are exported / made public without being used outside the current module.
- Action: Recommend reducing visibility to the minimum required scope.

### 11. Dependency Direction
- Check for circular dependencies between modules.
- Check for lower-level modules importing from higher-level orchestration modules (reversed dependency).
- Action: Recommend restructuring with a brief explanation of the intended layering.

## Output Format

Structure the review as follows:

```
## Maintainability Review

### [Item Name]
**Severity**: [Low | Medium | High]
**Location**: [file:line or function name]
**Issue**: [What is wrong and why it harms maintainability]
**Suggestion**: [Concrete recommendation, with a code snippet if helpful]

---
```

If there are no issues at all, output:
`✅ No maintainability issues found. The code is clean.`

## Constraints

- Do NOT comment on correctness, performance, or security unless they are directly caused by a maintainability problem (e.g., duplicated logic causing a security inconsistency).
- Do NOT rewrite the entire file unless explicitly asked.
- Do NOT flag style preferences (spacing, bracket placement) unless a formatter is absent and the inconsistency actively hinders readability.
- Keep suggestions actionable and specific — avoid generic advice like "improve naming."
- Assign severity honestly: reserve **High** for issues that would concretely slow down future changes or cause bugs during the next refactor.
