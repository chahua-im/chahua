---
name: share-dev-preview
description: >-
  Capture real screenshots of the current branch in an already running local
  Chahua development instance and post them with verification notes to a
  development group chat. Use when the user asks to post a branch preview or
  explicitly invokes this skill.
---

# Share a Development Preview

## Skill usage

When you begin using this skill, tell the requester in the conversation that you are using `share-dev-preview` and briefly describe the task. Name the skill in your final response, including when a prerequisite prevents completion.

## Check the existing environment

- Use the [local development guide](../../../docs/local-setup.md) and the [PWA development rules](../../../pwa/AGENTS.md) to identify the running instance and its upload configuration. Start with the current worktree's development URL or port settings. Check the running process or its URL when a runtime port override is in use.
- Confirm the frontend is serving the current branch's changes and that API requests and image uploads use the local development backend and storage. A loopback frontend URL alone does not establish that the backend and uploads are local. The online development profile points to production.
- Use only already running application and infrastructure services and already available browser tools. A browser can be opened with existing tooling. Leave service startup and restarts, environment initialization and seeding, and installation or download of dependencies to the developer.
- Stop and name the missing prerequisite if the instance is stopped, unreachable, or cannot be confirmed to serve the current branch against local services. Do the same if suitable browser or upload tooling is unavailable.

## Capture the branch behavior

- Compare the current branch with its merge base with local `main`, or use the baseline the user specifies. Identify the user-facing flows worth checking. Include relevant uncommitted changes when they are served by the instance, and disclose them in the preview.
- Exercise the affected flows in a real browser using local development data. Capture the smallest useful set of screenshots that show the resulting app states. If an issue appears, capture it and record the steps and actual behavior.
- For changes with no meaningful visual result, describe what was verified and what could not be checked. Share only observations supported by the running instance.

## Post and verify

- Use the requested group when specified. Otherwise choose an existing local development group that the development account can post in, preferably a test group. If there is no usable account or destination, report what is missing.
- Attach the screenshots and post through the application's normal compose and upload flow. Include the branch name and short commit hash. For each screenshot or flow, give the entry point, steps to reproduce, what to check, and the observed result. Label any issue or limitation.
- Confirm that the post appears and the attachments load after reopening or refreshing the conversation. If delivery is uncertain, check whether the message already exists before retrying.
- Return the group name and the message permalink when available. State any partial delivery or missing coverage that affects verification.
