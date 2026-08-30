# Weatherbot — a Grove Root

A **Root**: a Grove extension with no UI. It never renders a pane, window, or
tab — everything it does reaches you through capabilities.

It's the reference example for the capabilities added alongside it:

| Capability | What Weatherbot does with it |
|---|---|
| `commands.register` | One `/weather` command with six subcommands |
| *(command output)* | An interactive card above the composer, with buttons and native menus |
| `statusbar` | A live temperature badge per tracked city |
| `channel.read` | Watches for `!w <city>` in the channel |
| `channel.send` | Answers `!w`, and `/weather share` posts a lookup to the channel |
| `storage` | Tracked cities survive a reload |

Command output (the card) isn't a capability of its own — it comes with
`commands.register`, since a command needs somewhere to put its answer.

No build step — plain HTML + JS, dev-loadable as-is.

## Try it

1. Install this folder (or a `.grove` archive containing its three files at the
   archive root).
2. Installation only copies and validates the Root. Press **Start** beside
   Weatherbot, then approve its five capabilities and two network hosts. Once
   it appears under **Running**, `/weather` is available.
3. `/weather get London` → a card appears above the composer with **Refresh**,
   **Track**, and **Share to channel**. A loading card appears immediately while
   Weatherbot resolves the place and fetches conditions; the lookup stops with
   a visible error after 15 seconds instead of waiting indefinitely. The result
   carries conditions, humidity, and wind speed.
4. Press **Refresh** → the card replaces itself in place (same card `id`).
5. Press **Track** → a badge appears in the status bar. Switch channels and
   networks: it stays.
6. `/weather list` → choose a city from the compact **Stop tracking…** menu.
   `/weather remove <city>` does the same; `/weather remove all` explicitly
   clears everything.
7. Type `!w Prague` as a normal message → it answers in the channel with
   conditions, humidity, and wind.
8. Close the Root in the Grove manager → its badges vanish with it. Re-open it:
   the cities you tracked are still there, because of `storage`.

### Commands

Weatherbot registers one slash command and handles the rest as subcommands:

```text
/weather get <city>       Show current conditions in a card
/weather share <city>     Post current conditions to this channel
/weather track <city>     Add a live status-bar badge
/weather remove <city>    Stop tracking a city
/weather remove all       Stop tracking every city
/weather list             List tracked cities
/weather help             Show command help
```

A bare `/weather` also shows help. The location is the entire remainder of the
command, so `/weather get New York` works without quotes; matching outer quotes
are accepted too. The command palette also discovers these subcommands: after
typing `/weather `, choose one with the pointer or arrow keys and Return.

The manager is also the *only* place a Root is visible, since it has no surface
— it's listed as `Root · no window`, with Stop and Console controls. JavaScript
exceptions, failed page loads, and `console.*` output appear there. If a Root
requests command registration but finishes loading without registering any,
the manager calls that out explicitly instead of leaving only an “unknown
command” symptom.

### Naming

The geocoder canonicalises names — `Praha` comes back as `Prague, Czechia` —
so a badge is keyed by the *resolved* label, not what you typed. Card buttons
and menu items always pass that resolved label, so they match exactly.

Typing a name matches on an exact hit or a **prefix** of at least three
characters, so `/weather remove prag` finds `Prague, Czechia` but
`/weather remove praha` does not. Prefix rather than substring is deliberate:
untracking is destructive, and a substring match on a one-letter argument
silently removed every city with that letter anywhere in its name. When nothing
matches, the card lists what *is* tracked. Removal actions live in one native
**Stop tracking…** menu rather than expanding into a row of buttons.

### Answering in channel

`!w <city>` is watched for in ordinary channel traffic, which is why the
manifest asks for **`channel.read`** — a materially louder grant than the rest:
it sees every message in the bound channel, not just commands aimed at it. The
consent sheet says so ("Read messages in this channel").

Two things worth copying if you write a bot that talks in channel:

- **Its own output can't re-trigger it.** Grove delivers a Root the messages it
  sends as well as everyone else's — there is no self-filter — so the guard has
  to come from the message shape: every reply and every error string this bot
  emits starts with something other than `!w`, and the trigger is anchored
  (`/^!w\s+/`). That's a by-construction argument, not an enforced one; if you
  change the reply format, re-check it. A bot that answers its own output is the
  classic way to flood a channel.
- **It rate-limits itself** (one reply per 5s). Dropped requests are silent: a
  "slow down" reply would itself be the flood.
- **Failures don't leak upstream detail.** A lookup error goes to `grove.log`
  and the channel gets a fixed sentence — HTTP statuses and internals have no
  business in a public room.

Humidity and wind are appended only when the station reports them — Open-Meteo
omits fields rather than sending nulls, and `humidity undefined%` in a channel
is worse than saying nothing.

## Notes on the shape of a Root

- **`"surfaces": ["headless"]`** in the manifest is what makes it a Root. The
  `index.html` is never displayed; it exists only to load the script.
- **It keeps running** while you use the app, independent of which channel or
  network is on screen — that's what makes the 15-minute badge refresh and the
  always-visible badges meaningful.
- **It coexists with a channel's Sprig.** A Root doesn't own a pane, so it
  doesn't displace anything docked in the channel it was launched from.
- **Cards never write to the message field.** `/weather share` sends explicitly via
  `grove.send`, so posting to a channel is always something the extension asks
  for, never a side effect of showing output.
- **Buttons and menu items can only invoke this Root's own registered
  commands.** A control naming a built-in (`/join`) or another extension's
  command is dropped when the card is created.

## Network

Weather data is [Open-Meteo](https://open-meteo.com) — no API key, no account.

```json
"hostPermissions": [
  "https://api.open-meteo.com",
  "https://geocoding-api.open-meteo.com"
]
```

Grove's egress sandbox blocks every other host, so this extension cannot reach
anywhere it hasn't declared — including to exfiltrate what you type.
