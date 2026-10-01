# Python Quiz Arena

A live, mobile-first multiplayer Python quiz for classrooms. One host creates a room, up to 60 players join with a 4-character code, and everyone plays the same 15 timed questions in real time.

Created by G. Tamizharasan & Pasupathi M.

## Features

- 60-player rooms with WebSocket multiplayer (Node.js + `ws`)
- Live PLAYERS IN ROOM counter (for example 37/60) in the lobby and during the quiz, updated instantly on every join and leave
- Late joining: students can join after the host starts the quiz and play from the current question onward
- 15 Python Unit 1 questions, 20 seconds each, advancing automatically
- Question 8 is a multiple-answer question (select all that apply, then SUBMIT ANSWER)
- Private player scores: players only ever receive their own score and result
- Live host scoreboard and a private host leaderboard with CSV export
- Live chat in the lobby and during the quiz, with a host-only CHAT ON / CHAT OFF switch
- Animated countdown clock with a Web Audio tick sound (no audio files)
- Dynamic animated donut chart on the final player result
- Answer key shown to everyone after the quiz
- Server-side scoring and validation; no database, no login, no paid services

## Run locally

```bash
npm install
npm start
```

Open http://localhost:3000. The server reads `PORT` from the environment (default 3000) and listens on `0.0.0.0`.

## Deploy on Render (Free)

1. Push this project to a GitHub repository (branch `main`). `package.json`, `server.js` and `public/` must be at the repository root.
2. In Render choose **New +** > **Web Service** and connect the repository.
3. Use these settings:

| Setting | Value |
| --- | --- |
| Runtime | Node |
| Root Directory | (leave blank) |
| Branch | `main` |
| Build Command | `npm install` |
| Start Command | `npm start` |
| Instance Type | Free |

No environment variables are needed. Render sets `PORT` automatically. The page uses `wss://` on HTTPS and `ws://` on HTTP automatically.

A free Render service sleeps after a period of inactivity, so open the site once before class to wake it up. Rooms live in memory: a restart or redeploy closes all rooms.

## Late joining

Students can join at any point until the quiz is over, as long as the room has a free slot (60 maximum).

- A student who joins during a question lands on that question with the live remaining time (not a fresh 20 seconds) and can answer it straight away.
- A student who joins between two questions waits a moment and enters the next question.
- Scoring is still 1 point per correct answer out of 15. Questions before the student joined count as 0, and the final result tells them which question they joined at.
- Late joiners appear on the host's live scoreboard and final leaderboard, and still never see anyone else's score.
- Once the last question has finished, new players are told "Quiz has ended."

## How a session works

1. Host opens the site, enters a name and taps **CREATE ROOM**.
2. Players enter their name and the room code (or open the shared join link) and tap **JOIN ROOM**.
3. Host taps **START QUIZ**. After a short countdown the 15 questions run automatically. Students can still join while the quiz is running.
4. Players see only their own score. The host sees the live scoreboard.
5. At the end, players see their result chart and the answer key; the host sees the full leaderboard.

If the host leaves, the room closes and players are notified. If a player leaves, they are removed and the count updates.

## Project structure

```
Python_Quiz_Arena/
├── package.json
├── server.js
├── README.md
└── public/
    └── index.html
```
