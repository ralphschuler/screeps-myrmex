# Development

## Requirements

- Node.js 24
- npm 11
- a Screeps account only when deploying a built bundle

## Commands

| Command              | Purpose                              |
| -------------------- | ------------------------------------ |
| `npm ci`             | install the locked dependency graph  |
| `npm run check`      | run every required repository gate   |
| `npm run test:watch` | run focused tests during development |
| `npm run format`     | apply repository formatting          |
| `npm run build`      | create `dist/main.js`                |
| `npm run clean`      | remove generated output              |

## Deployment

Bootstrap CI never deploys to Screeps and contains no credentials. Deployment will be added after
the survival kernel passes private-server scenarios. It must use GitHub environments, protected
branches, a dedicated Screeps code branch, and narrowly scoped secrets.

## Scenario Rules

A scenario has a stable id, deterministic initial world, bounded tick count, and outcome assertions.
Good scenarios include cold boot, zero-creep recovery, miner death, route blockage, hostile arrival,
nuke impact, lost spawn, failed claim, and portal arrival.

Do not assert implementation trivia such as a class name or event emission when the real requirement
is delivered energy, survival, replacement, or retreat.

## Wiki

Edit Markdown in `wiki/`. The Wiki workflow mirrors those files to the repository Wiki after a
successful `main` update. `_Sidebar.md` controls Wiki navigation.
