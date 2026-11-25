# Nova: a daily dashboard for Nova SBE students in Orca

An [Orca](https://github.com/stablyai/orca) plugin that puts your Nova SBE day in Orca's right sidebar:
today's schedule, your open assignments with a status bar each, deadlines, and your unread Nova mail.
Everything is read locally on your Mac and nothing is written, sent or uploaded.

By Elia Heinzer. Built for the Nova SBE AI club.

## What each tab shows

- **Today** (the daily dashboard): date and greeting, today's schedule (in the Calendar plugin's
  Apple-style design, with the red "now" line), what is due in the next 48 hours with status bars,
  "Do today" (the next step of your 3 most urgent tasks), your newest unread mail, and a strip with
  this week's deadlines.
- **Calendar**: your Mac calendars as an agenda, in the original design of
  [Calendar for Orca](https://github.com/BautistaPessagno/orca-calendar).
- **Tasks**: your open assignments from `TASKS.md`, soonest first. Each one has a countdown and a status
  bar (length = how far along it is, colour = time left: red under 36 h, amber under 4 days, green
  otherwise). Click a task to see its requirements, rubric, plan and next step from its task pack, and
  to open the pack or its folder. You can also set the status by hand.
- **Classes**: today's and tomorrow's classes with rooms, plus the next 7 days of deadlines.
- **Mail**: only **unread** mail of your Nova account, from your inbox and your own folders, with a
  filter per folder. Click a mail to open it in Apple Mail.
- **Status bar**: `Nova · 1 urgent · next in 2 d 8 h`.

Overdue and finished items are never shown.

## Requirements

- macOS and Orca (version in `orca-plugin.json` → `engines`).
- **Mail tab**: your Nova account (`…@novasbe.pt`) added to **Apple Mail**. The plugin finds it by
  itself: it is the Apple Mail account that receives the most mail addressed to `@novasbe.pt`
  (`NOVA_DOMAIN` in `src/nova.ts`). Orca may need **Full Disk Access**
  (System Settings → Privacy & Security) to read Apple Mail's index; the tab tells you if it does.
- **Schedule and Classes**: your Nova timetable subscribed in the **Mac Calendar app** in a calendar
  whose name starts with "Nova SBE" (for classes). The schedule shows all your Mac calendars; macOS may
  ask once to allow calendar access.
- **Tasks and deadlines** (optional): the Microsoft OneDrive app with your Nova OneDrive
  (the first folder in `~/Library/CloudStorage/` named `OneDrive-…Nova…`), containing the files below.
  Without them those sections say so and the rest still works.

## Folder layout it expects

Inside your Nova OneDrive (all optional; missing parts just show an empty section):

```text
<Nova OneDrive>/
├── TASKS.md                         your task list (format below)
├── DEADLINES.md                     upcoming deadlines (format below)
├── 1 Admin/6 Academic Calendar/     a timetable .ics export, used only if your Mac calendar
│                                    "Nova SBE …" can't be read            (SCHEDULE_DIR in src/worker.ts)
└── <any course folder>/3 Assignments & Group Work/<task>/
                                     one folder per task, with its _PREP pack and your files
                                                                         (ASSIGNMENTS_DIR in src/nova.ts)
```

Task folders can live anywhere in the OneDrive: the Tasks tab finds a task's folder from the `[pack](…)`
link in `TASKS.md`. When a row has no link but its text names `3 Assignments & Group Work/<task>/`, that
folder is used. To use other folder names, change the two constants and reinstall.

## The files the Tasks and deadline sections read

`TASKS.md` and `DEADLINES.md` are in the root of your Nova OneDrive. You can write them by hand or let an AI assistant keep them
up to date.

**`TASKS.md`**: one Markdown table, one row per task:

```markdown
| Status | Due | Course | Task | Link |
|---|---|---|---|---|
| 🔥 urgent | Tue 15 Jan 14:00 (team), Sat 19 Jan 23:59 (Moodle) | Course A | Group report | [pack](/full/path/to/_PREP 2030-01-14 Group report.md) |
| 🆕 prepared | Wed 16 Jan 23:59 | Course B | Reflections 1–3 | Moodle |
| ⏳ not prepared yet | Mon 21 Jan 23:59 | Course C | Essay | Moodle |
| ✅ done | Thu 17 Jan 23:59 | Course D | Slides | Moodle |
```

- Status: 🔥 urgent, 🆕 prepared, ⏳ not prepared yet, ✅ done, ⚠️ passed/overdue (hidden).
- Due: `Wed 16 Jan 23:59`; several dates are fine, the next upcoming one counts; `no date set` is allowed.
- Link: `[pack](<absolute path to a _PREP file>)`, `[draft](…)`, or plain text like `Moodle`.
- An optional line starting with `Updated …` above the table is shown as "last updated".

**Task folders**: the folder of each `_PREP` file decides the status, every refresh:

| Status | When |
|---|---|
| ✅ Done | a file with `SUBMITTED` or `_FINAL` in its name, or the row is ✅ |
| 🟢 Ready to submit | a file starting with `_READY` |
| 🟡 In progress | files starting with `_DRAFT`, or any other file edited after the pack's date |
| 🔵 Prepared | only the `_PREP …` pack |
| ⚪ Not started | no pack or folder |

A `_PREP <YYYY-MM-DD> <name>.md` pack is Markdown with these `##` sections (all optional):
`What & when`, `What the professor wants` (or `Requirements` / `Rubric`), `Material already there`,
`Plan`, `Head start`, `Open questions`, `Status`, `Next step`. The panel shows them in that order.

**`DEADLINES.md`**: a table of upcoming deadlines (an `Updated …` line above it is optional):

```markdown
| Date | Day | Time | Course | What | Source |
|---|---|---|---|---|---|
| 16 Jan | Wed | 23:59 | Course B | Reflections 1–3 | Moodle |
| 15 Jan | Tue | 14:00 | Course A | ⚠️ 🆕 Team deadline | WhatsApp |
```

⚠️ marks urgent and 🆕 marks new.

## Install

Download or clone this repository, then:

```sh
orca plugin install ./orca-nova-panel
```

Orca shows what the plugin may access and prints an approval command with a fingerprint; run it to
install. Open the panel from the right sidebar ("Nova").

## Privacy

- Read-only: it reads your files, Apple Mail's local index (with the `sqlite3` tool in read-only mode)
  and your Mac calendars. It never writes to OneDrive, never marks mail as read, never sends anything.
- No network: the panel makes no internet requests, and there is no Google sign-in, API key or secret
  in this plugin. Manual task statuses are stored in the plugin's own Orca storage on your Mac.
- Clicking a file or a mail only opens it in its own app.

## Credits

`calendar/` is copied unchanged from **Calendar for Orca** by **Bautista Pessagno**
(https://github.com/BautistaPessagno/orca-calendar, version 0.3.0), MIT License,
Copyright (c) 2026 Bautista Pessagno (full text in `THIRD_PARTY_LICENSES/calendar-LICENSE`).
`calendar/panel/nova.html` is its `index.html` plus three added lines (Nova's stylesheet, tab bar
and script), built by `nova/build.py`. Nova runs it through `src/calendar-bridge.ts` with the Mac
calendars backend only: no Google sign-in, reminders or extra status bar item.

Nova's own code: MIT License, Copyright (c) 2026 Elia Heinzer (see `LICENSE`).
