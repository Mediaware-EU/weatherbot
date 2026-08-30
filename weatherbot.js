/*
 * Weatherbot — a Grove **Root** (headless extension).
 *
 * There is no UI in this extension. Everything the user sees comes from these
 * capabilities:
 *
 *   commands.register  →  /weather <get|track|remove|list|help|share>
 *   channel.read       →  answers `!w <city>` in the channel
 *   channel.send       →  posts those answers, and `/weather share …`
 *   (cards)            →  interactive output above the composer, with buttons
 *                         and menus that re-invoke this Root's own command
 *   statusbar          →  a live badge per tracked location
 *   storage            →  tracked locations survive a reload
 *
 * Weather data is Open-Meteo (no API key). The two hosts it uses are declared
 * in `hostPermissions`; Grove's egress sandbox blocks everything else, so this
 * file cannot exfiltrate anything to a third party even if it tried.
 */

const GEOCODE_URL = 'https://geocoding-api.open-meteo.com/v1/search'
const FORECAST_URL = 'https://api.open-meteo.com/v1/forecast'
const STORAGE_KEY = 'weatherbot.tracked'
/** Longest place name accepted from either a command or channel trigger. */
const MAX_QUERY_LENGTH = 64
/** One complete lookup may include geocoding followed by a forecast request.
 *  Bound the pair so a slow upstream never leaves Weatherbot looking inert. */
const LOOKUP_TIMEOUT_MS = 15 * 1000

/** Locations the user asked to keep an eye on → one status-bar badge each.
 *  Persisted, which is what the `storage` capability in the manifest buys: the
 *  grant switches this Sprig's WebView to a persistent data store, so
 *  `localStorage` survives a reload instead of dying with the instance. */
let tracked = loadTracked()

function loadTracked() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw)
    // Anything shaped wrong is discarded rather than trusted — this is our own
    // data, but it's on disk and a partial write shouldn't wedge startup.
    if (!Array.isArray(parsed)) return []
    return parsed.filter((entry) => entry && typeof entry.label === 'string' && Number.isFinite(entry.latitude) && Number.isFinite(entry.longitude))
  } catch (error) {
    grove.log(`could not read tracked locations: ${error}`)
    return []
  }
}

function saveTracked() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(tracked))
  } catch (error) {
    grove.log(`could not save tracked locations: ${error}`)
  }
}

/* -------------------------------------------------------------------------- */
/* Commands                                                                    */
/* -------------------------------------------------------------------------- */

grove.commands.register([
  {
    name: 'weather',
    summary: 'Weather lookup and tracked locations',
    usage: '<subcommand> [city]',
    subcommands: [
      { name: 'get', summary: 'Show current conditions', usage: '<city>' },
      { name: 'track', summary: 'Add a live status-bar badge', usage: '<city>' },
      { name: 'remove', summary: 'Stop tracking a city', usage: '<city|all>' },
      { name: 'list', summary: 'List tracked cities', usage: '' },
      { name: 'help', summary: 'Show Weatherbot help', usage: '' },
      { name: 'share', summary: 'Post conditions to this channel', usage: '<city>' }
    ]
  }
])
console.info('Weatherbot ready — registered /weather')

grove.on('command', async (invocation) => {
  if (invocation.command !== 'weather') return
  const request = parseWeatherCommand(invocation.argString)
  try {
    switch (request.subcommand) {
      case 'get':
        await showWeather(request.argument, invocation.target, false)
        break
      case 'share':
        await showWeather(request.argument, invocation.target, true)
        break
      case 'track':
        await trackLocation(request.argument)
        break
      case 'remove':
        await removeLocation(request.argument)
        break
      case 'list':
        showTrackedLocations()
        break
      case 'help':
        showHelp()
        break
      default:
        showHelp(`Unknown subcommand "${request.subcommand}".`)
        break
    }
  } catch (error) {
    // Never leave a command silently dead — the user typed something and is
    // waiting for a result.
    grove.card({
      id: 'weather',
      title: 'Weather unavailable',
      body: String((error && error.message) || error)
    })
  }
})

/** Split once: the first token is the subcommand and the untouched remainder
 *  is its argument, so `/weather get New York` naturally keeps "New York"
 *  together. Quoting is accepted too, but isn't required. */
function parseWeatherCommand(input) {
  const trimmed = (input || '').trim()
  if (!trimmed) return { subcommand: 'help', argument: '' }
  const match = /^(\S+)(?:\s+([\s\S]*))?$/.exec(trimmed)
  return {
    subcommand: match[1].toLowerCase(),
    argument: (match[2] || '').trim()
  }
}

/* -------------------------------------------------------------------------- */
/* Cards — interactive command output                                          */
/* -------------------------------------------------------------------------- */

const HELP_TEXT = [
  '/weather get <city> — show current conditions',
  '/weather share <city> — post conditions to this channel',
  '/weather track <city> — add a status-bar badge',
  '/weather remove <city> — stop tracking a city',
  '/weather remove all — stop tracking every city',
  '/weather list — list tracked cities',
  '/weather help — show this help'
].join('\n')

function showHelp(message) {
  grove.card({
    id: 'weather',
    title: 'Weatherbot',
    body: message ? `${message}\n\n${HELP_TEXT}` : HELP_TEXT
  })
}

async function showWeather(query, target, share) {
  if (!query) {
    grove.card({
      id: 'weather',
      title: share ? 'Share weather for which city?' : 'Weather for which city?',
      body: `Try /weather ${share ? 'share' : 'get'} London`
    })
    return
  }

  grove.card({
    id: 'weather',
    title: 'Looking up weather…',
    body: unquote(query.trim()).slice(0, MAX_QUERY_LENGTH)
  })

  const { place, now } = await lookupWeather(query)
  const summary = conditions(now, { detailed: true })
  const subject = place.label

  // Re-emitting the same card id REPLACES the card in place — that's what makes
  // the buttons below feel like they refresh the card rather than stacking new
  // ones. Buttons may only name commands this Root registered.
  grove.card({
    id: 'weather',
    title: place.label,
    body: summary,
    actions: [
      { label: 'Refresh', command: 'weather', args: `get ${subject}` },
      { label: 'Track', command: 'weather', args: `track ${subject}`, style: 'prominent' },
      // Sharing goes through a command too, so the button and the typed
      // command take exactly the same path.
      { label: 'Share to channel', command: 'weather', args: `share ${subject}` }
    ]
  })

  // `share` posts the result to the channel the command came from. Cards never
  // write to the message field, so sending is always explicit like this.
  if (!share) return
  if (target) {
    grove.send(`*${place.label}* — ${summary}`)
  } else {
    // Asked to share from somewhere with no channel to share *to* (the server
    // log). Say so rather than appearing to do nothing.
    grove.card({
      id: 'weather',
      title: place.label,
      body: `${summary}\n\nNothing to share to from here — run this in a channel.`
    })
  }
}

/* -------------------------------------------------------------------------- */
/* !w — answering in channel                                                   */
/* -------------------------------------------------------------------------- */

const BANG = /^!w\s+(.+)$/i
/** Minimum gap between channel replies, so a room full of !w can't make this
 *  bot flood. Dropped requests are silent by design — a "slow down" reply would
 *  itself be the flood. */
const REPLY_COOLDOWN_MS = 5000
let lastReplyAt = 0

grove.on('message', async (msg) => {
  const match = BANG.exec((msg.text || '').trim())
  if (!match) return
  // Grove delivers our own sends back to us — there's no self-filter — so the
  // echo guard is the message shape: every string this bot emits starts with
  // something other than `!w`, and the trigger is anchored. By construction,
  // not enforced: re-check it if you change the reply format.
  const elapsed = Date.now() - lastReplyAt
  if (elapsed < REPLY_COOLDOWN_MS) {
    grove.log(`!w ignored (cooldown, ${REPLY_COOLDOWN_MS - elapsed}ms left)`)
    return
  }
  lastReplyAt = Date.now()
  try {
    // Bounded: this string goes into a URL and the reply goes to a public
    // channel, so there's no reason to carry more than a place name's worth.
    const { place, now } = await lookupWeather(match[1].trim().slice(0, MAX_QUERY_LENGTH))
    grove.send(`*${place.label}* — ${conditions(now, { detailed: true })}`)
  } catch (error) {
    // Answer failures too: someone asked out loud and silence reads as broken.
    // But the detail goes to the log, not the channel — upstream error text can
    // carry HTTP status codes and internals, and a public room is the wrong
    // place to publish them.
    grove.log(`!w failed: ${error}`)
    grove.send(`Couldn't look that up right now.`)
  }
})

/** One line of conditions. Humidity and wind are only appended when the station
 *  actually reported them — Open-Meteo omits fields rather than sending nulls,
 *  and "humidity undefined%" in a channel is worse than saying nothing. */
function conditions(now, options) {
  let text = `${describe(now.weather_code)}, ${Math.round(now.temperature_2m)}°C (feels like ${Math.round(now.apparent_temperature)}°C)`
  if (!options || !options.detailed) return text
  if (Number.isFinite(now.relative_humidity_2m)) {
    text += ` · humidity ${Math.round(now.relative_humidity_2m)}%`
  }
  if (Number.isFinite(now.wind_speed_10m)) {
    text += ` · wind ${Math.round(now.wind_speed_10m)} km/h`
  }
  return text
}

/* -------------------------------------------------------------------------- */
/* Badges — always-visible status                                              */
/* -------------------------------------------------------------------------- */

async function trackLocation(query) {
  if (!query) {
    grove.card({ id: 'weather', title: 'Track what?', body: 'Try /weather track London' })
    return
  }
  const place = await resolvePlace(query)
  if (!tracked.some((entry) => entry.label === place.label)) {
    tracked.push(place)
    saveTracked()
  }
  await refreshBadges()
  grove.card({
    id: 'weather',
    title: 'Tracking ' + place.label,
    body: 'Its temperature now shows in the status bar, wherever you are in the app.',
    // Pass the RESOLVED label, not what the user typed: the geocoder
    // canonicalises names ("Praha" → "Prague, Czechia"), so keying the button
    // off the raw query would fail to match for every such city.
    actions: [{ label: 'Stop tracking', command: 'weather', args: `remove ${place.label}`, style: 'destructive', closes: true }]
  })
}

async function removeLocation(query) {
  const needle = query.trim().toLowerCase()
  if (!needle) {
    grove.card({
      id: 'weather',
      title: 'Remove which city?',
      body: tracked.length
        ? `Try /weather remove <city>, or /weather remove all.\n\nTracking: ${tracked.map((entry) => entry.label).join(', ')}.`
        : 'Nothing is being tracked.'
    })
    return
  }

  // Clearing every badge is deliberately explicit. A missing argument should
  // not turn a partially typed destructive command into "remove everything".
  const removed = needle === 'all'
    ? tracked.slice()
    : tracked.filter((entry) => matchesLocation(entry, needle))
  tracked = tracked.filter((entry) => removed.indexOf(entry) === -1)
  if (removed.length) saveTracked()
  await refreshBadges()
  grove.card({
    id: 'weather',
    title: removed.length ? 'Stopped tracking' : 'Not tracked',
    // Name what actually went, not what was typed: the geocoder canonicalises
    // ("Praha" → "Prague, Czechia"), so echoing the input tells the user
    // nothing about which entry disappeared. When nothing matched, list what
    // IS tracked — those canonical names are what they have to work with.
    body: removed.length
      ? removed.map((entry) => entry.label).join(', ')
      : (tracked.length ? `Nothing matching "${query}". Tracking: ${tracked.map((entry) => entry.label).join(', ')}.` : 'Nothing is being tracked.'),
    menus: removalMenus()
  })
}

function showTrackedLocations() {
  grove.card({
    id: 'weather',
    title: 'Tracked locations',
    body: tracked.length
      ? tracked.map((entry) => `• ${entry.label}`).join('\n')
      : 'Nothing is being tracked. Try /weather track London.',
    menus: removalMenus()
  })
}

function removalMenus() {
  if (!tracked.length) return []
  const items = tracked.map((entry) => ({
    label: entry.label,
    command: 'weather',
    args: `remove ${entry.label}`,
    style: 'destructive'
  }))
  if (tracked.length > 1) {
    items.push({
      label: 'All locations',
      command: 'weather',
      args: 'remove all',
      style: 'destructive'
    })
  }
  return [{ label: 'Stop tracking…', items }]
}

/** Tolerant match so a typed name works as well as the button's exact label:
 *  the canonical label, the short name, or a prefix of either.
 *
 *  Prefix rather than substring, and the length floor applies to both clauses.
 *  With a bare `indexOf` on the label, `/weather remove a` matched every city
 *  whose label contained an "a" and silently untracked the lot — a destructive
 *  action driven by a one-letter typo. A prefix also stops "or" matching
 *  "York" and "Norway". */
function matchesLocation(entry, needle) {
  const label = entry.label.toLowerCase()
  const name = (entry.name || '').toLowerCase()
  if (label === needle || name === needle) return true
  // An exact match always counts, however short. Fuzzier matching needs enough
  // to go on — "or" would otherwise take out York and Norway together.
  if (needle.length < MIN_PREFIX_MATCH_LENGTH) return false
  return label.startsWith(needle) || name.startsWith(needle)
}

/** Shortest needle allowed to match by prefix — see `matchesLocation`. */
const MIN_PREFIX_MATCH_LENGTH = 3

/** Publish the full badge list. `set` is an idempotent replace — passing the
 *  whole list each time is the API, and `[]` clears.
 *
 *  Guarded against overlap: a refresh awaits one HTTP round-trip per tracked
 *  place, so a 15-minute tick can still land on top of a slow one already in
 *  flight. Since `set` replaces wholesale, the loser would publish a list built
 *  from a `tracked` array that has since changed — an untracked city
 *  reappearing in the status bar. */
let refreshInFlight = null

function refreshBadges() {
  if (refreshInFlight) return refreshInFlight
  refreshInFlight = publishBadges().catch((error) => {
    grove.log(`badge refresh failed: ${error}`)
  }).then(() => {
    refreshInFlight = null
  })
  return refreshInFlight
}

async function publishBadges() {
  const badges = []
  for (const place of tracked) {
    try {
      const now = await conditionsForPlace(place)
      badges.push({
        id: place.label,
        icon: iconFor(now.weather_code),
        // Temperature plus the city's short name ("33°C Dubai"). Not
        // `place.label`: that's country-qualified ("Dubai, United Arab
        // Emirates") and would crowd the status bar for no benefit — the
        // tooltip subtitle already carries the full label. A place stored by
        // an older version may have no `name`, so fall back rather than
        // publishing "33°C undefined".
        text: place.name ? `${Math.round(now.temperature_2m)}°C ${place.name}` : `${Math.round(now.temperature_2m)}°C`,
        subtitle: place.label,
        color: now.temperature_2m >= 30 ? 'warning' : 'neutral'
      })
    } catch (error) {
      grove.log(`badge refresh failed for ${place.label}: ${error}`)
    }
  }
  grove.badges.set(badges)
}

// Publish persisted locations immediately — waiting for the first interval
// would leave the status bar empty for 15 minutes after Weatherbot starts.
// Then keep them current while the Root is running, regardless of which
// channel or network is visible.
const BADGE_REFRESH_INTERVAL_MS = 15 * 60 * 1000
refreshBadges()
setInterval(refreshBadges, BADGE_REFRESH_INTERVAL_MS)

/* -------------------------------------------------------------------------- */
/* Open-Meteo                                                                  */
/* -------------------------------------------------------------------------- */

async function withLookupTimeout(operation) {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), LOOKUP_TIMEOUT_MS)
  try {
    return await operation(controller.signal)
  } catch (error) {
    if (error && error.name === 'AbortError') {
      throw new Error('Weather lookup timed out. Please try again.')
    }
    throw error
  } finally {
    clearTimeout(timeout)
  }
}

function lookupWeather(query) {
  return withLookupTimeout(async (signal) => {
    const place = await geocode(query, signal)
    const now = await currentConditions(place, signal)
    return { place, now }
  })
}

function resolvePlace(query) {
  return withLookupTimeout((signal) => geocode(query, signal))
}

function conditionsForPlace(place) {
  return withLookupTimeout((signal) => currentConditions(place, signal))
}

async function geocode(query, signal) {
  const name = unquote(query.trim()).slice(0, MAX_QUERY_LENGTH)
  const response = await fetch(`${GEOCODE_URL}?name=${encodeURIComponent(name)}&count=1`, { signal })
  if (!response.ok) throw new Error(`geocoding failed (${response.status})`)
  const result = await response.json()
  const hit = result && result.results && result.results[0]
  if (!hit) throw new Error(`No place called "${name}".`)
  return {
    label: hit.country ? `${hit.name}, ${hit.country}` : hit.name,
    // The canonical short name, kept for matching — the geocoder often returns
    // something other than what was typed ("Praha" → "Prague").
    name: hit.name,
    latitude: hit.latitude,
    longitude: hit.longitude
  }
}

/** Multi-word places need no quotes because the command parser keeps the whole
 *  remainder, but accepting one matching outer pair is friendly to shell-like
 *  habits (`/weather get "New York"`). */
function unquote(value) {
  if (value.length < 2) return value
  const first = value[0]
  const last = value[value.length - 1]
  return (first === '"' && last === '"') || (first === "'" && last === "'")
    ? value.slice(1, -1).trim()
    : value
}

async function currentConditions(place, signal) {
  const url = `${FORECAST_URL}?latitude=${place.latitude}&longitude=${place.longitude}` +
    '&current=temperature_2m,apparent_temperature,weather_code,relative_humidity_2m,wind_speed_10m'
  const response = await fetch(url, { signal })
  if (!response.ok) throw new Error(`forecast failed (${response.status})`)
  const result = await response.json()
  if (!result || !result.current) throw new Error('forecast response had no current conditions')
  return result.current
}

/* -------------------------------------------------------------------------- */
/* WMO weather codes                                                           */
/* -------------------------------------------------------------------------- */

// Open-Meteo reports a sparse subset of WMO 4677: 0-3, 45/48, 51-57, 61-67,
// 71-77, 80-86, 95-99. The ranges below are written to that subset rather than
// to `<=` chains that would also swallow the unused codes in between (4-44 are
// not fog).
function describe(code) {
  if (code === 0) return 'Clear'
  if (code <= 3) return 'Partly cloudy'
  if (code === 45 || code === 48) return 'Fog'
  if (code >= 51 && code <= 57) return 'Drizzle'
  if (code >= 61 && code <= 67) return 'Rain'
  if (code >= 71 && code <= 77) return 'Snow'
  if (code >= 80 && code <= 82) return 'Showers'
  if (code >= 85 && code <= 86) return 'Snow showers'
  if (code >= 95) return 'Thunderstorm'
  return 'Unknown'
}

function iconFor(code) {
  if (code === 0) return 'sun.max'
  if (code <= 3) return 'cloud.sun'
  if (code === 45 || code === 48) return 'cloud.fog'
  if (code >= 51 && code <= 67) return 'cloud.rain'
  if (code >= 71 && code <= 86) return 'cloud.snow'
  if (code >= 95) return 'cloud.bolt'
  return 'cloud'
}
