## Project Overview

wetty-chat is a chat application targeting ~20k users / ~10k messages per day. It has a **Rust backend** (Axum + Diesel/PostgreSQL) and a **React frontend** (Ionic + Vite).

## SubAgents
The project is relatively large and complex, so use subagents to explore the project
unless you know for sure there are limited files to look and you know which ones.

## Explicit confirmation
If you are planning a large code change (more than 50 lines) you should review your plan with the user
and only execute the edit after given explicit permission to proceed. This applies to fixing
bugs as well, you should explain what the problem is & what the proposed fix is before making edit

## Project Layout

### Frontend
Frontend is located in `wetty-chat-mobile` directory. It is a Progressive Web Applicaiton (PWA)
When working on frontend reference @wetty-chat-mobile/AGENTS.md

### Backend
Backend is a Rust + Axum project located in `backend` directory.
When working on backend, load @backend/AGENTS.md

### Flutter
There's also a flutter mobile app located in `wetty-chat-flutter` directory.
When working on flutter, load @wetty-chat-flutter/AGENTS.md
